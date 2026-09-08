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
 *   2. docs      - LICENSE / README / CHANGELOG ship, CHANGELOG carries a section
 *                  for the exact version being published, and the DSH bundle
 *                  patch registers the name that is about to be published.
 *   3. tree      - nothing the package ships differs from HEAD. A warning here
 *                  is normal in this multi-session clone; --require-clean turns
 *                  it into a failure for anyone publishing by hand.
 *   4. pack      - real 'npm pack' into a temp dir, then the tarball file list
 *                  is checked (no src/, tests/, .github/ leakage).
 *   5. install   - 'npm install <tarball>' into a throwaway project and import
 *                  every Node-resolvable subpath: the host-plane entries must
 *                  load and answer, the offline report script must run from its
 *                  installed location, and the client bundle must keep its
 *                  Cordis module-loader wrapper. The resolved runtime closure
 *                  is license-audited on the way (one copyleft transitive dep
 *                  would change the terms of an MIT release). The probe also
 *                  installs the published artifact into a Cordis-shaped context:
 *                  apply() must inject and wrap the host subagents service,
 *                  register every agent/* event the plugin claims to handle,
 *                  pass an unconfigured start() through to the host, and hand the
 *                  original service back on dispose. An artifact that merely
 *                  resolves but never wires up would pass everything else here.
 *                  The same probe is
 *                  then run against a pnpm install, because pnpm's isolated
 *                  store - what a DSH profile uses - exposes a dependency that
 *                  package.json forgot to declare, which npm's hoisting hides.
 *                  It is skipped with a note when pnpm is not on PATH.
 *   6. registry  - the version must still be free on registry.npmjs.org
 *                  (and must be newer than what is already published).
 *
 * It also doubles as the release-notes source for the publish workflow:
 * '--print-changelog <version>' prints that version's CHANGELOG section.
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
 * Extract the release notes for one version: everything under its
 * '## [x.y.z]' heading up to the next '##' heading. The publish workflow
 * feeds this straight into the GitHub Release body, so the changelog stays
 * the single source of truth for what a release claims to contain.
 *
 * @param {string} markdown full CHANGELOG.md text
 * @param {string} version bare version (no leading 'v')
 * @returns {string} the section body, or '' when there is no such section
 */
export function changelogSection(markdown, version) {
  if (typeof markdown !== 'string' || !version) return '';
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## [' + version + ']'));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
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

/** Licenses that are safe to ship inside an MIT-licensed package. */
export const PERMISSIVE_LICENSES = new Set([
  'mit', 'isc', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'bsd', '0bsd',
  'cc0-1.0', 'cc-by-4.0', 'unlicense', 'the unlicense', 'blueoak-1.0.0', 'python-2.0', 'zlib',
]);

/** Copyleft licenses: they change what downstream users must do with the package. */
export const COPYLEFT_LICENSE_RE = /^(g?lgpl|agpl|gpl|mpl|mozilla public|eupl|cpol)/i;

/**
 * Classify one SPDX-ish license string.
 *
 * @param {string} license the package.json license (or licenses[0].type) value
 * @returns {'permissive' | 'copyleft' | 'unknown'}
 */
export function classifyLicense(license) {
  const value = String(license || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (COPYLEFT_LICENSE_RE.test(value)) return 'copyleft';
  if (PERMISSIVE_LICENSES.has(value)) return 'permissive';
  // SPDX expressions: '(MIT OR Apache-2.0)', 'MIT AND ISC', ...
  const atoms = value.split(/[()/,;]+|\bor\b|\band\b/).map((s) => s.trim()).filter(Boolean);
  if (!atoms.length) return 'unknown';
  if (atoms.some((a) => COPYLEFT_LICENSE_RE.test(a))) return 'copyleft';
  return atoms.every((a) => PERMISSIVE_LICENSES.has(a)) ? 'permissive' : 'unknown';
}

/**
 * Audit the licenses of everything that lands in a consumer's tree: the
 * package's own runtime closure is what an npm install resolves, and one
 * copyleft transitive dependency would silently change the terms of an
 * MIT-licensed plugin release.
 *
 * @param {string[]} packages [{ name, license }] pairs
 * @param {string} selfName the audited package, excluded from its own closure
 * @returns {{ issues: string[], warnings: string[], permissive: number, total: number }}
 */
export function auditLicenses(packages, selfName) {
  const issues = [];
  const warnings = [];
  let permissive = 0;
  for (const entry of packages) {
    if (!entry || !entry.name || entry.name === selfName) continue;
    const kind = classifyLicense(entry.license);
    if (kind === 'permissive') permissive++;
    else if (kind === 'copyleft') {
      issues.push('license: ' + entry.name + ' ships as ' + (entry.license || 'unlicensed') + ' - copyleft in the dependency closure needs an explicit review');
    } else {
      warnings.push('license: ' + entry.name + ' has no recognizable license field (' + (entry.license || 'missing') + ')');
    }
  }
  return { issues, warnings, permissive, total: packages.filter((p) => p && p.name && p.name !== selfName).length };
}

/**
 * Which of the paths a release ships are not in the committed state.
 *
 * The publish workflow packs from the tag, so this never bites there. It exists
 * for the manual route: a maintainer who runs npm publish in a shared checkout
 * (lib/*.map files are ignored - see the note in the loop below)
 * would otherwise ship another session's half-finished src/ and lib/ rebuild as
 * an official release, with a version number nobody reviewed.
 *
 * @param {string[]} statusLines lines of 'git status --porcelain'
 * @param {string[]} packaged top-level entries of the package "files" allowlist
 * @returns {{ dirty: string[], clean: boolean }}
 */
export function dirtyPackagedPaths(statusLines, packaged) {
  const dirty = [];
  for (const line of statusLines) {
    // Porcelain v1 is 'XY <path>' (renames as 'old -> new'); the path always
    // starts at column 3, and only the second status char matters for us.
    let path = String(line).slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (!path) continue;
    // Sourcemaps are excluded for the same reason the lib/ parity check excludes
    // them: they embed sourcesContent byte-for-byte, so a Linux runner rebuilds
    // a byte-different map after pnpm build. Failing a release on that would
    // make the gate cry wolf on every tag.
    if (path.endsWith('.map')) continue;
    const covered = (packaged || []).some((entry) => {
      const e = String(entry).replace(/^\.\//, '');
      return path === e || path.startsWith(e + '/') || (e.endsWith('/') && path.startsWith(e));
    });
    if (covered && !dirty.includes(path)) dirty.push(path);
  }
  return { dirty, clean: dirty.length === 0 };
}

/** Read { name, license } for every package directory under node_modules. */
function readInstalledLicenses(nodeModulesDir) {
  const out = [];
  const readOne = (dir) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const license = typeof p.license === 'string' ? p.license
        : Array.isArray(p.licenses) && p.licenses[0] && p.licenses[0].type ? p.licenses[0].type : '';
      return { name: p.name, license };
    } catch {
      return null;
    }
  };
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const base = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(base, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        const info = readOne(path.join(base, scoped.name));
        if (info && info.name) out.push(info);
      }
      continue;
    }
    const info = readOne(base);
    if (info && info.name) out.push(info);
  }
  return out;
}

/**
 * Pull owner/repo out of any git URL form (https, git+https, ssh, scp-like,
 * with or without .git). Returns null when the string is not a repo URL.
 *
 * @param {string} url
 * @returns {string|null} 'owner/repo'
 */
export function parseRepoSlug(url) {
  const value = String(url || '').trim().replace(/\/+$/, '');
  if (!value) return null;
  const withoutSuffix = value.replace(/\.git$/i, '');
  const normalize = (rest) => {
    const parts = String(rest).split('/').filter(Boolean);
    // Keep the last two segments so GitLab groups also reduce to a slug.
    return parts.length < 2 ? null : parts.slice(-2).join('/');
  };
  const scp = withoutSuffix.match(/^[^@/\s]+@[^:\s]+:(.+)$/);
  if (scp) return normalize(scp[1]);
  const scheme = withoutSuffix.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i);
  if (scheme) return normalize(scheme[1]);
  return normalize(withoutSuffix);
}

/**
 * The Cordis patch is what makes DSH's profile bundle stack load the plugin:
 * 'dsh plugin add' registers the package in 'dsh.profile.bundles' through
 * 'dsh.bundle.patch'. If that patch names a different id than the published
 * package, the install succeeds and the plugin silently never applies - the
 * worst kind of packaging bug to discover after a release. The parse is
 * textual so this script stays dependency-free (no yaml import needed).
 *
 * @param {string} patchText contents of the file named by dsh.bundle.patch
 * @param {any} pkg parsed package.json
 * @returns {{ issues: string[], warnings: string[], notes: string[] }}
 */
export function validateBundlePatch(patchText, pkg) {
  const issues = [];
  const warnings = [];
  const notes = [];
  const name = pkg && typeof pkg.name === 'string' ? pkg.name : '';
  const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '');
  const collect = (key) => {
    const out = [];
    const re = new RegExp('^[ \\t]*(?:-[ \\t]*)?' + key + ':[ \\t]*(.+)$', 'gm');
    let m;
    while ((m = re.exec(patchText || '')) !== null) out.push(clean(m[1]));
    return out;
  };
  if (typeof patchText !== 'string' || !patchText.trim()) {
    issues.push('bundle patch is empty or unreadable - DSH cannot register the plugin');
    return { issues, warnings, notes };
  }
  if (!patchText.includes('insert:')) {
    warnings.push('bundle patch has no "insert:" block - is it still a Cordis patch?');
  }
  const ids = collect('id');
  const names = collect('name');
  if (!ids.length) {
    issues.push('bundle patch declares no id - the plugin will not be registered');
  } else if (name && !ids.includes(name)) {
    issues.push('bundle patch id is "' + ids.join('", "') + '" but the package is "' + name + '" (installs without loading)');
  }
  for (const n of names) {
    if (name && n !== name) warnings.push('bundle patch name "' + n + '" differs from the package name "' + name + '"');
  }
  if (!names.length && ids.length) warnings.push('bundle patch entries carry an id but no name');
  if (name && ids.includes(name) && names.includes(name)) {
    notes.push('bundle patch registers "' + name + '" (id and name match the package)');
  }
  return { issues, warnings, notes };
}

/**
 * The README installs this plugin with 'dsh plugin add github:owner/repo', and
 * npm renders repository.url on the package page. If the manifest and the
 * remote this checkout pushes to disagree, the published package advertises a
 * source the documented install route cannot resolve. A different repository
 * *name* is a hard failure; a different owner only warns, because that is what
 * a fork's pull-request job legitimately looks like.
 * @param {any} pkg parsed package.json
 * @param {string|null} remoteUrl output of 'git remote get-url origin'
 * @returns {{ issues: string[], warnings: string[], note: string|null }}
 */
export function checkRepositoryRemote(pkg, remoteUrl) {
  const declared = pkg && pkg.repository
    ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)
    : null;
  const fromManifest = parseRepoSlug(declared);
  const fromRemote = parseRepoSlug(remoteUrl);
  if (!fromManifest) return { issues: [], warnings: ['url is not a recognizable git URL'], note: null };
  if (!fromRemote) return { issues: [], warnings: [], note: 'no origin remote to compare against' };
  if (fromManifest === fromRemote) {
    return { issues: [], warnings: [], note: 'url matches the origin remote (' + fromRemote + ')' };
  }
  const [manifestOwner, manifestRepo] = fromManifest.split('/');
  const [remoteOwner, remoteRepo] = fromRemote.split('/');
  if (manifestRepo !== remoteRepo) {
    return { issues: ['url points at ' + fromManifest + ' but this checkout pushes to ' + fromRemote], warnings: [], note: null };
  }
  // Same repository under a different owner: that is a fork or a mirror, which is
  // what a pull-request job legitimately looks like. Warn, never block.
  return {
    issues: [],
    warnings: [
      'url is ' + manifestOwner + '/' + manifestRepo + ' but this checkout pushes to ' + remoteOwner + '/'
        + remoteRepo + ' (fork or mirror - the published github: install route would point elsewhere)',
    ],
    note: null,
  };
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
    '// Everything above proves the resolver is happy. This proves the plugin is',
    "// alive: install the published artifact into a Cordis-shaped context, check it",
    '// wired the host events it claims to handle, that an unconfigured install',
    "// still passes a start() through to the host (never vetoes), and that the",
    '// dispose path hands the original service back and settles the config watcher.',
    "// The plugin resolves ~/.dsh/settings.yaml through os.homedir(), so point",
    '// HOME at this throwaway project before the first import - the smoke test',
    "// must not read (or be changed by) the maintainer's real settings file.",
    'process.env.HOME = process.cwd();',
    'process.env.USERPROFILE = process.cwd();',
    '',
    "const EVENTS = ['agent/request', 'agent/request-error', 'agent/disposed', 'agent/turn-stopping', 'agent/error'];",
    'const listeners = new Map();',
    'const cleanups = [];',
    'const injected = [];',
    'const ctx = {',
    '  inject(deps, callback) {',
    '    for (const dep of deps) injected.push(dep);',
    '    callback(ctx);',
    '  },',
    '  on(event, handler) {',
    '    if (!listeners.has(event)) listeners.set(event, []);',
    '    listeners.get(event).push(handler);',
    '    return () => {',
    "      const list = listeners.get(event) || [];",
    '      const at = list.indexOf(handler);',
    '      if (at >= 0) list.splice(at, 1);',
    '    };',
    '  },',
    "  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); },",
    '  subagents: {',
    "    start: async (label, request) => ({ started: label, request }),",
    '    startContinuable: async (spec) => ({ continued: true, spec }),',
    '  },',
    '};',
    'const originalStart = ctx.subagents.start;',
    '',
    'host.apply(ctx);',
    '',
    "assert.ok(injected.includes('subagents'), 'apply() must inject the subagents service');",
    'assert.notEqual(ctx.subagents.start, originalStart, "apply() must wrap the host start()");',
    'for (const event of EVENTS) {',
    "  assert.ok((listeners.get(event) || []).length > 0, 'apply() registered no listener for ' + event);",
    '}',
    '// A request the plugin has no opinion about must arrive at the host intact.',
    "const direct = await ctx.subagents.start('probe', { prompt: 'hello' });",
    "assert.equal(direct.started, 'probe', 'a start() through the wrapped service must reach the host');",
    "assert.ok(direct.request && direct.request.prompt === 'hello', 'the request payload must survive wrapping');",
    "const continued = await ctx.subagents.startContinuable({ label: 'probe' });",
    "assert.equal(continued.continued, true, 'startContinuable() must reach the host');",
    '// DSH teardown runs these cleanups; a leaked fs.watch would hang shutdown.',
    'for (const cleanup of cleanups) await cleanup();',
    'assert.equal(ctx.subagents.start, originalStart, "dispose must hand back the original service");',
    "console.log('PROBE: apply() wires ' + EVENTS.length + ' host listeners, passes a start through, disposes clean');",
    'process.exit(0);',
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

  // Runtime closure license audit: one copyleft transitive dependency would
  // silently change the terms of an MIT release.
  const licenses = auditLicenses(readInstalledLicenses(path.join(workDir, 'node_modules')), pkg.name);
  issues.push(...licenses.issues);
  notes.push('license audit: ' + licenses.permissive + '/' + licenses.total + ' installed dependencies are permissively licensed');

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

  return { issues, warnings: licenses.warnings, notes };
}

function stageRepository(pkg) {
  let remote = null;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: ROOT }).trim() || null;
  } catch {
    remote = null;
  }
  return checkRepositoryRemote(pkg, remote);
}

/**
 * DSH installs plugins with pnpm under the hood, and pnpm defaults to an
 * isolated node_modules layout: a dependency that lib/ imports but package.json
 * does not declare resolves fine under npm's hoisting and fails hard under
 * pnpm. Same probe, stricter store.
 */
function stagePnpmInstall(pkg, tarball, workDir) {
  const probe = path.join(workDir, 'probe.mjs');
  const version = tryPnpm(['--version'], { cwd: ROOT });
  if (!version.ok) return { skipped: 'pnpm is not available on this shell - consumer check skipped' };
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify({ name: 'release-check-consumer-pnpm', version: '0.0.0', private: true, type: 'module' }, null, 2)
  );
  // pnpm has no --no-audit (npm-only flag); --ignore-scripts is its default in
  // v10 anyway, and stating it keeps the check meaningful on older pnpm.
  const add = tryPnpm(['add', '--ignore-scripts', '--reporter=append-only', tarball], { cwd: workDir });
  if (!add.ok) {
    return { issues: ['pnpm consumer install failed: ' + (firstLine(add.stderr) || firstLine(add.stdout))] };
  }
  if (!fs.existsSync(path.join(workDir, 'node_modules', pkg.name))) {
    return { issues: ['pnpm consumer install produced no node_modules/' + pkg.name] };
  }
  fs.writeFileSync(probe, probeSource(pkg), 'utf8');
  const res = tryRun(process.execPath, [probe], { cwd: workDir });
  if (!res.ok) {
    return { issues: ['pnpm (isolated store) could not load the published entries: ' + (firstLine(res.stderr) || firstLine(res.stdout))] };
  }
  return { notes: ['pnpm isolated-store install loads every published entry (' + version.stdout.trim() + ')'] };
}

function tryPnpm(args, opts = {}) {
  const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return tryRun(bin, args, { ...opts, shell: true });
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
  // *.map files are excluded: a sourcemap embeds sourcesContent verbatim, so a
  // stray CR in one source line makes a map byte-compare platform-dependent.
  const touchedLib = captureGitStatus().filter((line) => line.includes('lib/') && !line.endsWith('.map'));
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

const USAGE = [
  'Usage: node scripts/release-check.mjs [options]',
  '',
  '  --skip-install     pack and validate the manifest, but do not install it',
  '  --offline          skip the registry duplicate-version probe',
  '  --json             machine-readable result for tooling',
  '  --build-parity     rebuild and fail if the committed lib/ went stale',
  '  --require-clean    fail if any packaged file differs from HEAD (manual publish)',
  '  --keep             leave the temp tarball/consumer tree behind',
  '  --print-changelog [version]',
  '                     print the CHANGELOG section for a version (release notes)',
].join('\n') + '\n';

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
    requireClean: argv.includes('--require-clean'),
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

  const changelog = safeRead(path.join(ROOT, 'CHANGELOG.md')) || '';

  // --print-changelog [version]: the GitHub Release body comes from the
  // changelog, never from a hand-copied summary. Empty output means no section.
  if (argv.includes('--print-changelog')) {
    const wanted = argv[argv.indexOf('--print-changelog') + 1];
    const version = wanted && !wanted.startsWith('--') ? wanted : pkg.version;
    const section = changelogSection(changelog, version);
    if (!section) {
      process.stderr.write('release-check: CHANGELOG.md has no section for ' + version + '\n');
      return 1;
    }
    process.stdout.write(section + '\n');
    return 0;
  }

  const manifest = validateManifest(pkg, { changelog });
  emit('manifest', manifest.issues, 'fail');
  emit('manifest', manifest.warnings, 'warn');

  const docIssues = [];
  if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) docIssues.push('LICENSE file is missing (an open-source release needs one)');
  if (!fs.existsSync(path.join(ROOT, 'README.md'))) docIssues.push('README.md is missing');
  emit('docs', docIssues, 'fail');

  // The DSH bundle patch is the plugin-specific half of packaging: an id that
  // does not match the package name installs cleanly and then loads nothing.
  // Packing from a dirty shared checkout would ship another session's
  // half-finished work under an official version number. Warning by default (a
  // multi-session clone is normally dirty), hard failure with --require-clean:
  // that is the flag to use before a manual npm publish.
  const cleanliness = dirtyPackagedPaths(captureGitStatus(), pkg.files || []);
  if (!cleanliness.clean) {
    const message = cleanliness.dirty.length + ' packaged file(s) differ from HEAD: ' + cleanliness.dirty.slice(0, 6).join(', ') + (cleanliness.dirty.length > 6 ? ', ...' : '');
    if (opts.requireClean) emit('tree', [message + ' - commit or stash before publishing'], 'fail');
    else emit('tree', [message + ' - the workflow packs from the tag, a manual npm publish must not'], 'warn');
  } else {
    emit('tree', ['working tree matches HEAD for everything the package ships'], 'note');
  }

  const patchPath = pkg.dsh && pkg.dsh.bundle && String(pkg.dsh.bundle.patch || '').replace(/^\.\//, '');
  if (patchPath) {
    const patchCheck = validateBundlePatch(safeRead(path.join(ROOT, patchPath)) || '', pkg);
    emit('patch', patchCheck.issues, 'fail');
    emit('patch', patchCheck.warnings, 'warn');
    emit('patch', patchCheck.notes, 'note');
  }

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
      emit('install', smoke.warnings || [], 'warn');
      emit('install', smoke.notes, 'note');
    }

    const pnpmWork = path.join(runRoot, 'consumer-pnpm');
    const pnpmSmoke = stagePnpmInstall(pkg, packed.tarball, pnpmWork);
    emit('install', pnpmSmoke.issues || [], 'fail');
    emit('install', pnpmSmoke.notes || [], 'note');
    if (pnpmSmoke.skipped) emit('install', [pnpmSmoke.skipped], 'note');

    const remote = stageRepository(pkg);
  emit('repository', remote.issues, 'fail');
  emit('repository', remote.warnings, 'warn');
  emit('repository', remote.note ? [remote.note] : [], 'note');

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
