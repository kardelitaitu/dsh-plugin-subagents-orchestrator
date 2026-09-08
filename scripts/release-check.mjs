#!/usr/bin/env node
/**
 * Publish-readiness gate for the npm release (Phase 5).
 *
 * 'npm pack --dry-run' (the CI package-sanity step) only prints the file
 * manifest - it never checks that the manifest is *complete* for what the
 * manifest itself promises. Every gap below has bitten plugin packages at
 * publish time: an 'exports' subpath pointing at a file the 'files' allowlist
 * drops, a lifecycle script that breaks 'dsh plugin add github:...', or
 * publishing a version the registry already holds.
 *
 * So this script verifies the artifact the way a consumer will:
 *
 *   1. manifest  - publish metadata, engines, no git-hostile lifecycle scripts,
 *                  no local-only dependency specs, every 'exports' target is a
 *                  real file that the 'files' allowlist will actually ship.
 *   2. docs      - LICENSE / README / CHANGELOG ship, and CHANGELOG carries a
 *                  section for the exact version being published.
 *   3. pack      - real 'npm pack' into a temp dir, then the tarball file list
 *                  is checked (no src/, tests/, .github/ leakage).
 *   4. install   - 'npm install <tarball>' into a throwaway project and import
 *                  every Node-resolvable subpath: the host-plane entries must
 *                  load and answer, the offline report script must run from its
 *                  installed location, and the client bundle must keep its
 *                  Cordis module-loader wrapper.
 *   5. registry  - the version must still be free on registry.npmjs.org
 *                  (and must be newer than what is already published).
 *
 * Stages 1-3 are pure and unit-tested; 4-5 shell out to npm and are the CLI's
 * job. Exits non-zero on any FAIL so CI and the pre-publish checklist can gate
 * on it.
 *
 * Usage:
 *   node scripts/release-check.mjs [--skip-install] [--offline] [--json]
 *                                  [--build-parity] [--keep]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loose semver check - good enough to catch a 1.2 style version typo. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Lifecycle npm runs on the *consumer's* install. Any of these makes a
 * git-hosted 'dsh plugin add github:owner/repo' install fail (or execute
 * arbitrary code), which is why 'prepare' was removed in 64c00b0.
 */
export const GIT_HOSTILE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];

/** Dependency spec prefixes that only resolve inside this checkout. */
export const LOCAL_ONLY_SPEC_RE = /^(file:|link:|workspace:|portal:|git\+ssh:)/;

/** Docs every published package should carry. */
export const REQUIRED_PACKAGED_DOCS = ['README.md', 'LICENSE', 'CHANGELOG.md'];

/** Repo paths that must never reach the tarball. */
export const FORBIDDEN_PACKAGED_PATHS = [/^src\//, /^tests\//, /^\.github\//, /^\.githooks\//, /^node_modules\//];

/**
 * Flatten an exports map into the concrete './file' targets it points at.
 *
 * Keys starting with '.' name subpaths; every other key is a condition
 * (`types`, `default`, `import`, `require`, ...) and therefore inherits the
 * subpath it sits under. Condition objects and fallback arrays are both
 * supported, and the result is deduplicated by subpath + target.
 */
export function collectExportTargets(exportsMap, baseSubpath = '.') {
  const out = [];
  const seen = new Set();
  if (!exportsMap || typeof exportsMap !== 'object') return out;
  const push = (subpath, value) => {
    if (typeof value !== 'string' || !value.startsWith('./')) return;
    const target = value.slice(2);
    const key = subpath + '\u0000' + target;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ subpath, target });
  };
  const walk = (node, subpath) => {
    for (const [key, value] of Object.entries(node)) {
      const nextSubpath = key.startsWith('.') ? key : subpath;
      if (typeof value === 'string') push(nextSubpath, value);
      else if (Array.isArray(value)) for (const item of value) push(nextSubpath, item);
      else if (value && typeof value === 'object') walk(value, nextSubpath);
    }
  };
  walk(exportsMap, baseSubpath);
  return out;
}

/** 1.2.3 vs 1.2.10: returns <0, 0 or >0. A pre-release sorts before its release. */
export function compareSemver(a, b) {
  const pa = String(a).split('-');
  const pb = String(b).split('-');
  const na = pa[0].split('.').map((n) => Number(n) || 0);
  const nb = pb[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0) return d;
  }
  if (pa[1] === pb[1]) return 0;
  if (!pa[1]) return 1;
  if (!pb[1]) return -1;
  return pa[1] < pb[1] ? -1 : 1;
}

/** Does the changelog carry a  ## [x.y.z]  heading for this exact version? */
export function changelogHasVersion(markdown, version) {
  if (typeof markdown !== 'string' || !version) return false;
  const needle = '## [' + version + ']';
  return markdown.split(/\r?\n/).some((line) => line.startsWith(needle));
}

/**
 * Stages 1+2: pure manifest validation against package.json + the repo.
 *
 * @param {any} pkg parsed package.json
 * @param {{ changelog?: string, exists?: (rel: string) => boolean }} [ctx]
 * @returns {{ issues: string[], warnings: string[] }}
 */
export function validateManifest(pkg, ctx = {}) {
  const issues = [];
  const warnings = [];
  const exists = ctx.exists || ((rel) => fs.existsSync(path.join(ROOT, rel)));
  if (!pkg || typeof pkg !== 'object') return { issues: ['package.json did not parse to an object'], warnings };

  const text = (field) => (typeof pkg[field] === 'string' && pkg[field].trim() ? pkg[field].trim() : null);

  // identity & registry metadata
  if (!text('name')) issues.push('package.json: "name" is required');
  const version = text('version');
  if (!version) issues.push('package.json: "version" is required');
  else if (!SEMVER_RE.test(version)) issues.push('package.json: "version" ' + version + ' is not a valid semver');
  if (pkg.private === true) issues.push('package.json: "private": true blocks publishing');
  if (!text('description')) issues.push('package.json: "description" is required (shown on the npm listing)');
  if (!text('license')) issues.push('package.json: "license" is required for an open-source release');
  if (!text('author')) warnings.push('package.json: "author" is missing (npm shows it on the package page)');
  if (!pkg.repository || typeof pkg.repository !== 'object' || !pkg.repository.url) {
    issues.push('package.json: "repository.url" is required (also the git-hosted install route)');
  }
  if (!pkg.bugs || !pkg.bugs.url) warnings.push('package.json: "bugs.url" is missing');
  if (!text('homepage')) warnings.push('package.json: "homepage" is missing');
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    warnings.push('package.json: "keywords" is empty (hurts npm discoverability)');
  }

  // runtime contract
  if (pkg.type !== 'module') issues.push('package.json: "type" must be "module" for the ESM host build (got ' + JSON.stringify(pkg.type) + ')');
  if (!pkg.engines || !pkg.engines.node) issues.push('package.json: "engines.node" is required (documents the supported host range)');
  if (pkg.sideEffects !== false) warnings.push('package.json: "sideEffects" is not false (bundler hint)');

  // git-hostile lifecycle scripts
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const hook of GIT_HOSTILE_SCRIPTS) {
    if (scripts[hook]) issues.push('package.json: scripts.' + hook + ' breaks git-hosted installs (dsh plugin add github:...)');
  }

  // dependency specs must resolve on the public registry
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, spec] of Object.entries(pkg[field] || {})) {
      if (typeof spec === 'string' && LOCAL_ONLY_SPEC_RE.test(spec)) {
        issues.push(field + '.' + dep + ' uses a local-only spec which cannot resolve for consumers');
      }
    }
  }

  // files allowlist
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    issues.push('package.json: "files" must be an explicit allowlist (keeps repo noise out of the tarball)');
  }

  // exports targets exist on disk (the build must have run)
  const targets = collectExportTargets(pkg.exports);
  if (!targets.length) issues.push('package.json: "exports" declares no ./ targets');
  for (const { subpath, target } of targets) {
    if (!exists(target)) issues.push('exports[' + subpath + '] -> ' + target + ' does not exist (run pnpm build before publishing)');
  }

  // DSH plugin wiring
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (!patch) warnings.push('package.json: dsh.bundle.patch is missing (dsh plugin add cannot register the bundle)');
  else if (!exists(String(patch).replace(/^\.\//, ''))) issues.push('dsh.bundle.patch -> ' + patch + ' does not exist');

  // the changelog must carry the version being released
  if (version && typeof ctx.changelog === 'string' && !changelogHasVersion(ctx.changelog, version)) {
    issues.push('CHANGELOG.md: no heading for [' + version + '] - document the release before publishing it');
  }

  return { issues, warnings };
}

/**
 * Stage 3: validate the tarball file list produced by 'npm pack --json'.
 *
 * @param {string[]} packFiles paths inside the tarball, as reported by npm
 * @param {any} pkg parsed package.json
 * @returns {{ issues: string[], warnings: string[] }}
 */
export function validatePackList(packFiles, pkg) {
  const issues = [];
  const warnings = [];
  const set = new Set(packFiles.map((f) => String(f).replace(/^\.\//, '')));
  const has = (p) => set.has(String(p).replace(/^\.\//, ''));

  for (const doc of REQUIRED_PACKAGED_DOCS) {
    if (!has(doc)) issues.push('tarball: ' + doc + ' is missing (the "files" allowlist must name it)');
  }
  for (const { subpath, target } of collectExportTargets(pkg.exports)) {
    if (!has(target)) issues.push('tarball: exports[' + subpath + '] -> ' + target + ' was not packed (consumers get ERR_MODULE_NOT_FOUND)');
  }
  if (pkg.main && !has(pkg.main)) issues.push('tarball: main -> ' + pkg.main + ' was not packed');
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (patch && !has(patch)) issues.push('tarball: dsh.bundle.patch -> ' + patch + ' was not packed');
  for (const file of set) {
    for (const re of FORBIDDEN_PACKAGED_PATHS) {
      if (re.test(file)) issues.push('tarball: ' + file + ' should not be published');
    }
  }
  if (![...set].some((f) => f.endsWith('.js'))) issues.push('tarball: no JavaScript payload at all');
  const maps = [...set].filter((f) => f.endsWith('.map')).length;
  if (maps > 0) warnings.push('tarball: ' + maps + ' sourcemap file(s) published (fine, but they carry the size)');
  if (!set.has('package.json')) warnings.push('tarball: package.json not listed (npm always adds it - odd npm version?)');
  return { issues, warnings };
}

/**
 * Subpaths a plain Node consumer can actually `import`:
 * - a JS target (data files like the Cordis patch are covered by the
 *   tarball/install checks instead),
 * - not the client bundle, which needs Cordis' browser module loader,
 * - no patterns (they need a concrete specifier to resolve).
 */
export function nodeResolvableSubpaths(pkg) {
  const targets = collectExportTargets(pkg.exports);
  const subpaths = new Set();
  for (const { subpath, target } of targets) {
    if (subpath === './client' || subpath.includes('*')) continue;
    if (!/\.[cm]?js$/.test(target)) continue;
    subpaths.add(subpath);
  }
  return [...subpaths];
}

/** The consumer-side probe: written into the temp install, then executed. */
export function probeSource(pkg) {
  return [
    "import assert from 'node:assert/strict';",
    "import { createRequire } from 'node:module';",
    '',
    'const require = createRequire(import.meta.url);',
    'const NAME = ' + JSON.stringify(pkg.name) + ';',
    '',
    '// The manifest re-export is the cheapest proof that the exports map, the',
    "// tarball layout and Node's resolver all agree.",
    "const manifest = require(NAME + '/package.json');",
    "assert.equal(manifest.name, NAME, 'installed package.json name mismatch');",
    "console.log('PROBE: ./package.json resolves (v' + manifest.version + ')');",
    '',
    'const host = await import(NAME);',
    "assert.equal(host.name, NAME, 'the plugin name export must equal the package name');",
    "assert.equal(typeof host.apply, 'function', 'apply(ctx) must be exported');",
    "assert.equal(typeof host.isSubagent, 'function', 'isSubagent() must be exported');",
    'assert.ok(Array.isArray(host.FAILOVER_TRIGGER_CODES) && host.FAILOVER_TRIGGER_CODES.length > 0);',
    "assert.equal(host.resolveMaxRetries({}), 20, 'the published maxRetries default drifted from the documented 20');",
    "assert.equal(host.DEFAULT_RETRY_INTERVAL_MIN_MS, 3000, 'the published retry pacing drifted');",
    "console.log('PROBE: host-plane entry imports and answers');",
    '',
    "const diag = await import(NAME + '/diagnostics');",
    "assert.equal(typeof diag.getDiagnosticsSnapshot, 'function');",
    "assert.equal(typeof diag.formatDiagnostics, 'function');",
    'const snap = diag.getDiagnosticsSnapshot();',
    'JSON.stringify(snap); // must be plain, serializable data',
    "assert.equal(typeof diag.formatDiagnostics(snap), 'string');",
    "console.log('PROBE: ./diagnostics snapshot works before apply()');",
    '',
    'const SUBPATHS = ' + JSON.stringify(nodeResolvableSubpaths(pkg)) + ';',
    "// '.' is the bare package name; './x' becomes NAME + '/x' for the resolver.",
    'const specifier = (s) => (s === \".\" ? NAME : NAME + s.slice(1));',
    'for (const sub of SUBPATHS) {',
    '  const spec = specifier(sub);',
    '  const mod = await import(spec);',
    "  assert.ok(mod && typeof mod === 'object', spec + ' resolved to nothing');",
    '}',
    "console.log('PROBE: all ' + SUBPATHS.length + ' Node-resolvable exports subpath(s) resolve');",
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI stages (these shell out to npm)
// ---------------------------------------------------------------------------

/**
 * Resolve npm as a Node entry point. Node refuses to spawn .cmd shims
 * directly (EINVAL since the CVE-2024-27980 hardening), so prefer npm's own
 * CLI script next to the running node and fall back to a shell invocation.
 */
function npmInvocation() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cli of candidates) {
    if (fs.existsSync(cli)) return { bin: process.execPath, prefix: [cli], shell: false };
  }
  return { bin: 'npm', prefix: [], shell: true };
}

function runNpm(args, opts = {}) {
  const inv = npmInvocation();
  return tryRun(inv.bin, [...inv.prefix, ...args], { ...opts, shell: inv.shell });
}

function tryRun(bin, args, opts = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(bin, args, {
        encoding: 'utf8',
        cwd: opts.cwd,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.shell ? { shell: true } : {}),
      }),
      stderr: '',
    };
  } catch (err) {
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String((err && err.message) || err),
    };
  }
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

function stagePack(packDir) {
  const res = runNpm(['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
  if (!res.ok) throw new Error('npm pack failed: ' + (firstLine(res.stderr) || firstLine(res.stdout)));
  const parsed = JSON.parse(res.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry.files || []).map((f) => f.path);
  const tarball = path.join(packDir, entry.filename);
  if (!fs.existsSync(tarball)) throw new Error('npm pack reported ' + entry.filename + ' but the file is absent');
  return { tarball, files };
}

function stageInstall(pkg, tarball, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify({ name: 'release-check-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)
  );
  const res = runNpm(['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: workDir });
  if (!res.ok) throw new Error('npm install of the tarball failed: ' + (firstLine(res.stderr) || firstLine(res.stdout)));
  const installed = path.join(workDir, 'node_modules', pkg.name);
  if (!fs.existsSync(installed)) throw new Error('installed tree missing node_modules/' + pkg.name);

  const issues = [];
  const notes = [];

  if (!fs.existsSync(path.join(installed, 'cordis.patch.yml'))) issues.push('installed: cordis.patch.yml is missing');

  // The client bundle is loaded through Cordis' window.__ModuleLoader__; the
  // banner is what makes that possible, so it must survive the build.
  const clientFile = path.join(installed, 'lib', 'client.js');
  if (fs.existsSync(clientFile)) {
    const head = fs.readFileSync(clientFile, 'utf8').slice(0, 200);
    if (!head.includes('id: "' + pkg.name + '"')) issues.push('installed: lib/client.js lost its Cordis module-loader banner');
    else notes.push('client bundle keeps the Cordis module-loader wrapper');
  } else {
    issues.push('installed: lib/client.js is missing (package.json declares dsh.client.platform)');
  }

  // Host-plane entries must import cleanly from a bare Node consumer project.
  const probe = path.join(workDir, 'probe.mjs');
  fs.writeFileSync(probe, probeSource(pkg), 'utf8');
  const probeRes = tryRun(process.execPath, [probe], { cwd: workDir });
  if (!probeRes.ok) throw new Error('consumer import probe failed: ' + (firstLine(probeRes.stderr) || firstLine(probeRes.stdout)));
  for (const line of probeRes.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PROBE:')) notes.push(trimmed.replace(/^PROBE:/, '').trim());
  }

  // The offline diagnostics reader has to work from its installed location.
  const report = path.join(installed, 'scripts', 'telemetry-report.mjs');
  if (fs.existsSync(report)) {
    const emptyDir = path.join(workDir, 'no-telemetry');
    const rep = tryRun(process.execPath, [report, '--json', '--dir', emptyDir], { cwd: workDir });
    if (!rep.ok) issues.push('installed: scripts/telemetry-report.mjs exited non-zero against an empty store');
    else notes.push('offline report script runs from the installed location');
  } else {
    issues.push('installed: scripts/telemetry-report.mjs is missing (the report alias would break)');
  }

  return { issues, notes };
}

function stageRegistry(pkg, offline) {
  if (offline) return { issues: [], notes: ['registry probe skipped (--offline)'] };
  const exact = runNpm(['view', pkg.name + '@' + pkg.version, 'version', '--json'], { cwd: ROOT });
  const exactOut = (exact.stdout || '').trim();
  if (exact.ok && exactOut && !/E404/.test(exactOut)) {
    return { issues: [pkg.name + '@' + pkg.version + ' is already published - bump the version'], notes: [] };
  }
  const all = runNpm(['view', pkg.name, 'version', '--json'], { cwd: ROOT });
  if (!all.ok) {
    const blob = String(all.stderr) + String(all.stdout);
    // E404 on the name means it has never been published: what a first release wants.
    if (/E404|404 Not Found/.test(blob)) {
      return { issues: [], notes: [pkg.name + ' is not on the registry yet - this would be the first release'] };
    }
    return { issues: [], notes: ['registry probe unavailable (network or registry error) - not treated as a failure'] };
  }
  let published = [];
  try {
    const parsed = JSON.parse((all.stdout || '').trim());
    published = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return { issues: [], notes: ['registry probe returned unparseable output - skipped'] };
  }
  const highest = published.reduce((acc, v) => (acc && compareSemver(acc, v) >= 0 ? acc : v), null);
  const issues = [];
  if (highest && compareSemver(pkg.version, highest) <= 0) {
    issues.push('registry: ' + pkg.version + ' is not newer than the published ' + highest);
  }
  return { issues, notes: ['registry: highest published version is ' + (highest || 'none')] };
}

function stageBuildParity() {
  const before = captureGitStatus();
  const build = runNpm(['run', 'build'], { cwd: ROOT });
  if (!build.ok) return { issues: ['build: the build script failed'], notes: [] };
  const touchedLib = captureGitStatus().filter((line) => line.includes('lib/'));
  if (touchedLib.length === 0) return { issues: [], notes: ['committed lib/ matches a fresh build'] };
  return { issues: ['build: committed lib/ is stale - rebuild and commit before publishing (git-hosted installs ship lib/)'], notes: [] };
}

function captureGitStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: ROOT }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const USAGE = 'Usage: node scripts/release-check.mjs [--skip-install] [--offline] [--json] [--build-parity] [--keep]\n';

export function main(argv = []) {
  if (argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = {
    skipInstall: argv.includes('--skip-install'),
    offline: argv.includes('--offline'),
    json: argv.includes('--json'),
    keep: argv.includes('--keep'),
    buildParity: argv.includes('--build-parity'),
  };

  const failures = [];
  const warnings = [];
  const notes = [];
  const emit = (stage, list, kind) => {
    for (const item of list) (kind === 'fail' ? failures : kind === 'warn' ? warnings : notes).push({ stage, item });
  };

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    process.stderr.write('release-check: cannot read package.json: ' + err.message + '\n');
    return 1;
  }

  const manifest = validateManifest(pkg, { changelog: safeRead(path.join(ROOT, 'CHANGELOG.md')) || '' });
  emit('manifest', manifest.issues, 'fail');
  emit('manifest', manifest.warnings, 'warn');

  const docIssues = [];
  if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) docIssues.push('LICENSE file is missing (an open-source release needs one)');
  if (!fs.existsSync(path.join(ROOT, 'README.md'))) docIssues.push('README.md is missing');
  emit('docs', docIssues, 'fail');

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-pack-'));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-'));
  const workDir = path.join(runRoot, 'consumer');
  try {
    if (opts.buildParity) {
      const parity = stageBuildParity();
      emit('build', parity.issues, 'fail');
      emit('build', parity.notes, 'note');
    }
    const packed = stagePack(packDir);
    emit('pack', [path.basename(packed.tarball) + ': ' + packed.files.length + ' file(s) in the tarball'], 'note');
    const packCheck = validatePackList(packed.files, pkg);
    emit('pack', packCheck.issues, 'fail');
    emit('pack', packCheck.warnings, 'warn');

    if (opts.skipInstall) {
      emit('install', ['install smoke skipped (--skip-install)'], 'note');
    } else {
      const smoke = stageInstall(pkg, packed.tarball, workDir);
      emit('install', smoke.issues, 'fail');
      emit('install', smoke.notes, 'note');
    }

    const registry = stageRegistry(pkg, opts.offline);
    emit('registry', registry.issues, 'fail');
    emit('registry', registry.notes, 'note');
  } catch (err) {
    emit('fatal', [String((err && err.message) || err)], 'fail');
  } finally {
    if (opts.keep) emit('keep', ['artifacts kept under ' + packDir + ' and ' + runRoot], 'note');
    else {
      fs.rmSync(packDir, { recursive: true, force: true });
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ package: pkg.name + '@' + pkg.version, ok: failures.length === 0, failures, warnings, notes }, null, 2) + '\n');
  } else {
    process.stdout.write('release-check ' + pkg.name + '@' + pkg.version + '\n');
    for (const n of notes) process.stdout.write('  ok    ' + n.stage + ': ' + n.item + '\n');
    for (const w of warnings) process.stdout.write('  warn  ' + w.stage + ': ' + w.item + '\n');
    for (const f of failures) process.stdout.write('  FAIL  ' + f.stage + ': ' + f.item + '\n');
    process.stdout.write(failures.length === 0 ? 'PASS - publish-ready (' + warnings.length + ' warning(s))\n' : 'BLOCKED - ' + failures.length + ' blocking issue(s)\n');
  }
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
