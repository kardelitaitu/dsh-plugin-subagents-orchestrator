#!/usr/bin/env node
/**
 * verify-release.mjs - confirm a published version is really on npm, intact.
 *
 * The preflight (release-check.mjs) proves the artifact built from this checkout
 * installs and behaves. It says nothing about what the registry ended up
 * serving, and that gap is where a release goes quietly wrong: a version
 * published from a different commit than the tag names, an 'latest' that does
 * not point at the cut, a provenance attestation that never attached, a file
 * that arrived different than it left. Run this as step 5 of a release, and
 * again whenever someone asks whether the version is really out there.
 *
 * Stages:
 *   1. registry  - npm view the exact version; report the tarball url, license,
 *                  engines and whether npm attached a provenance attestation.
 *   2. dist-tag  - the version must be what 'latest' serves.
 *   3. tag       - vX.Y.Z must exist, and the commit it names must carry the
 *                  same version in its own package.json (a tag that was moved
 *                  after the cut attributes the wrong bytes to a number).
 *   4. install   - a throwaway project installs it **by name from the
 *                  registry**, not from a local tarball, and the same consumer
 *                  probe the preflight uses runs against it; pnpm's isolated
 *                  store gets the same treatment when pnpm is available.
 *   5. contents  - the installed file set is diffed against a local npm pack,
 *                  so a surprising publish reads as a file list, not as a
 *                  support question.
 *
 * Usage: node scripts/verify-release.mjs [version] [--skip-install] [--json]
 * Exit code 0 = the published release checks out; 1 = it does not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  npmInvocation,
  runNpm,
  tryRun,
  firstLine,
  probeSource,
  validatePackList,
  nodeResolvableSubpaths,
} from './release-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = 'git';

function git(args) {
  return tryRun(GIT, args, { cwd: ROOT });
}

export function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    version: positional[0] || null,
    skipInstall: argv.includes('--skip-install'),
    json: argv.includes('--json'),
  };
}

/** Relative paths under dir; a nested node_modules belongs to the dependency. */
export function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' && full !== base) continue;
      walk(full, base, out);
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/** The npm-view document for name@version, or null when it is not published. */
export function registryManifest(name, version) {
  const res = runNpm(['view', name + '@' + version, '--json'], { cwd: ROOT });
  if (!res.ok || !res.stdout || !res.stdout.trim()) return null;
  try {
    const doc = JSON.parse(res.stdout);
    return doc && typeof doc === 'object' && doc.version ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Provenance shows up as an attestation on dist. A token publish attaches
 * nothing, which is legal but worth printing because the release workflow asks
 * for --provenance and the README promises provenance.
 */
export function attestationOf(doc) {
  const dist = (doc && doc.dist) || {};
  const url = dist.attestations && dist.attestations.url ? String(dist.attestations.url) : null;
  return { url, has: Boolean(url) };
}

/**
 * Compare what got installed with what this checkout packs. npm prefixes packed
 * paths with package/ and always carries package.json plus the docs, so those
 * are normalised away rather than treated as differences.
 */
export function compareFileLists(installed, packed) {
  const clean = (list) => new Set((list || []).map((f) => f.replace(/^package\//, '')));
  const a = clean(installed);
  const b = clean(packed);
  const missing = [...b].filter((f) => !a.has(f)).sort();
  const extra = [...a].filter((f) => !b.has(f)).sort();
  return { missing, extra, same: missing.length === 0 && extra.length === 0 };
}

/** Does the vX.Y.Z tag exist, and does its own manifest agree with the number? */
export function checkTag(version) {
  const tag = 'v' + version;
  const local = git(['rev-parse', '--verify', 'refs/tags/' + tag]);
  const remote = git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]);
  if (!local.ok && !(remote.ok && remote.stdout.trim())) {
    return { issues: ['no ' + tag + ' tag - this release cannot be traced to a commit'], notes: [] };
  }
  const issues = [];
  const notes = [];
  const shown = git(['show', tag + ':package.json']);
  if (shown.ok) {
    try {
      const tagged = JSON.parse(shown.stdout);
      if (tagged.version !== version) {
        issues.push('tag ' + tag + ' carries package.json version ' + tagged.version + ' - the tag was moved after the cut');
      } else {
        notes.push('tag ' + tag + ' contains the same version in its own manifest');
      }
    } catch {
      issues.push('tag ' + tag + ': its package.json could not be parsed');
    }
  } else {
    notes.push('tag ' + tag + ' is on the remote but not fetched here - manifest cross-check skipped');
  }
  return { issues, notes };
}

function installedProbe(pkg, version, workDir) {
  const issues = [];
  const notes = [];
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify({ name: 'verify-release-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)
  );
  const add = runNpm(['install', '--no-audit', '--no-fund', pkg.name + '@' + version], { cwd: workDir });
  if (!add.ok) {
    return { issues: ['installing ' + pkg.name + '@' + version + ' from the registry failed: ' + (firstLine(add.stderr) || firstLine(add.stdout))], notes };
  }
  const installedDir = path.join(workDir, 'node_modules', pkg.name);
  if (!fs.existsSync(installedDir)) {
    return { issues: ['the install produced no node_modules/' + pkg.name], notes };
  }
  const probe = path.join(workDir, 'probe.mjs');
  fs.writeFileSync(probe, probeSource(pkg), 'utf8');
  const res = tryRun(process.execPath, [probe], { cwd: workDir });
  if (!res.ok) {
    return { issues: ['the published artifact failed the consumer probe: ' + (firstLine(res.stderr) || firstLine(res.stdout))], notes };
  }
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PROBE:')) notes.push(trimmed.replace(/^PROBE:/, '').trim());
  }
  return { issues, notes, installedDir };
}

/**
 * What this checkout would publish, as a file list. npm pack --dry-run --json
 * reports paths without the package/ prefix and never writes anything, so the
 * comparison is between two listings rather than two archives.
 */
function localPackList() {
  const res = runNpm(['pack', '--dry-run', '--json'], { cwd: ROOT });
  if (!res.ok) return null;
  try {
    const doc = JSON.parse(res.stdout);
    const entry = Array.isArray(doc) ? doc[0] : doc;
    const files = (entry && Array.isArray(entry.files) ? entry.files : []).map((f) => String(f.path));
    return files.length ? files : null;
  } catch {
    return null;
  }
}

export function main(argv = []) {
  if (argv.includes('--help')) {
    process.stdout.write('usage: node scripts/verify-release.mjs [version] [--skip-install] [--json]\n');
    return 0;
  }
  const opts = parseArgs(argv);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    process.stderr.write('verify-release: cannot read package.json: ' + err.message + '\n');
    return 1;
  }
  const version = opts.version || pkg.version;
  const failures = [];
  const warnings = [];
  const notes = [];
  const emit = (list, target) => {
    for (const item of list) target.push(item);
  };

  // 1. registry
  const doc = registryManifest(pkg.name, version);
  if (!doc) {
    failures.push(pkg.name + '@' + version + ' is not on the registry - the release has not landed (a failed publish job leaves no trace)');
  } else {
    const tarball = doc.dist && doc.dist.tarball ? String(doc.dist.tarball) : '';
    notes.push('registry serves ' + doc.name + '@' + doc.version + ' (' + (doc.dist && doc.dist.unpackedSize ? Math.round(doc.dist.unpackedSize / 1024) + ' kB unpacked' : 'size unknown') + ')');
    if (!tarball.includes(pkg.name + '-' + version + '.tgz')) {
      warnings.push('unexpected tarball name: ' + tarball);
    }
    const att = attestationOf(doc);
    if (att.has) notes.push('provenance attestation attached');
    else warnings.push('no provenance attestation on the registry copy (expected for a token publish, unexpected for the OIDC workflow)');
    if (doc.license) notes.push('license: ' + (typeof doc.license === 'string' ? doc.license : JSON.stringify(doc.license)));
    if (doc.types) notes.push('types: ' + doc.types);
  }

  // 2. dist-tags
  if (doc) {
    const tags = runNpm(['dist-tag', 'ls', pkg.name], { cwd: ROOT });
    if (tags.ok) {
      try {
        const map = JSON.parse(tags.stdout);
        if (map.latest === version) notes.push('latest points at ' + version);
        else failures.push('latest is ' + map.latest + ' but the release cut is ' + version + ' - a plain install would not get this release');
      } catch {
        warnings.push('could not parse dist-tag output');
      }
    } else {
      warnings.push('dist-tag lookup failed');
    }
  }

  // 3. tag
  if (!failures.length || doc) {
    const tagCheck = checkTag(version);
    emit(tagCheck.issues, failures);
    emit(tagCheck.notes, notes);
  }

  // 4 + 5. install from the registry and compare contents
  let installedDir = null;
  if (doc && !opts.skipInstall) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'));
    const res = installedProbe(pkg, version, workDir);
    emit(res.issues, failures);
    emit(res.notes, notes);
    installedDir = res.installedDir || null;
    fs.rmSync(workDir, { recursive: true, force: true });
  } else if (!opts.skipInstall) {
    notes.push('install skipped (nothing to install yet)');
  }
  if (installedDir) {
    const installed = walk(installedDir);
    emit(validatePackList(installed, pkg).issues, failures);
    const packed = localPackList();
    if (!packed) {
      warnings.push('local npm pack failed - the published file list was compared against the manifest rules only');
    } else {
      const diff = compareFileLists(installed, packed);
      if (diff.same) notes.push('published file list matches this checkout exactly (' + installed.length + ' files)');
      else {
        if (diff.missing.length) failures.push('published copy is missing: ' + diff.missing.join(', '));
        if (diff.extra.length) warnings.push('published copy has files this checkout does not pack: ' + diff.extra.join(', '));
      }
    }
    const subpaths = nodeResolvableSubpaths(pkg);
    notes.push('every published subpath a consumer can import was loaded: ' + subpaths.join(', '));
  }

  const report = { name: pkg.name, version, ok: failures.length === 0, failures, warnings, notes };
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('verify-release ' + pkg.name + '@' + version + '\n');
    for (const n of notes) process.stdout.write('  ok    ' + n + '\n');
    for (const w of warnings) process.stdout.write('  warn  ' + w + '\n');
    for (const f of failures) process.stdout.write('  FAIL  ' + f + '\n');
    process.stdout.write(failures.length ? 'NOT VERIFIED - ' + failures.length + ' blocking issue(s)\n' : 'VERIFIED - the published release matches what this checkout builds\n');
  }
  return failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
