import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  walk,
  compareFileLists,
  attestationOf,
  checkTag,
} from '../scripts/verify-release.mjs';

/**
 * verify-release.mjs is the step that answers "did the release actually land,
 * and is it the thing we built?" - so it has to be trusted without a network.
 * These cover the offline half: the listing comparison, the provenance read and
 * the tag cross-check against the real repository.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('verify-release.mjs (post-publish check)', () => {
  it('parses a version argument and its flags', () => {
    expect(parseArgs([])).toEqual({ version: null, skipInstall: false, json: false });
    expect(parseArgs(['1.2.0', '--json'])).toEqual({ version: '1.2.0', skipInstall: false, json: true });
    expect(parseArgs(['--skip-install']).version).toBeNull();
  });

  it('walks an installed package without crossing into its own node_modules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-walk-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'lib', 'index.js'), '');
      fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), '');
      expect(walk(dir)).toEqual(['lib/index.js', 'package.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalises the package/ prefix and reports both directions of drift', () => {
    expect(compareFileLists(['lib/index.js', 'package.json'], ['package/lib/index.js', 'package/package.json']).same).toBe(true);
    const drift = compareFileLists(['lib/index.js'], ['lib/index.js', 'lib/client.js', 'extra.js']);
    expect(drift.missing).toEqual(['extra.js', 'lib/client.js']);
    expect(drift.extra).toEqual([]);
    expect(compareFileLists(['lib/index.js', 'surprise.bin'], ['lib/index.js']).extra).toEqual(['surprise.bin']);
    expect(compareFileLists([], ['package/lib/index.js']).same, 'an install that came up empty is not a match').toBe(false);
  });

  it('reads a provenance attestation, and says so when there is none', () => {
    expect(attestationOf({ dist: { attestations: { url: 'https://attest/1' } } })).toEqual({ url: 'https://attest/1', has: true });
    expect(attestationOf({ dist: {} }).has).toBe(false);
    expect(attestationOf(null).has).toBe(false);
  });

  it('accepts the real v1.2.0 tag because the tag and the manifest agree', () => {
    const { issues, notes } = checkTag(realPkg.version);
    expect(issues).toEqual([]);
    expect(notes.join('|')).toMatch(new RegExp('v' + realPkg.version));
  });

  it('fails a version that was never tagged', () => {
    const { issues } = checkTag('0.0.77');
    expect(issues.join('|')).toMatch(/no v0\.0\.77 tag/);
  });

  it('keeps the verification tooling out of the published package', () => {
    // scripts/verify-release.mjs and release-check.mjs are dev tooling: the
    // allowlist names the report script explicitly, not the directory.
    expect(realPkg.files).not.toContain('scripts');
    expect(realPkg.files).toContain('scripts/telemetry-report.mjs');
    const scripts = fs.readdirSync(path.join(repoRoot, 'scripts'));
    for (const file of scripts) {
      const shipped = realPkg.files.some((entry) => file === entry.replace(/^.*\//, '') && entry.startsWith('scripts/'));
      if (file === 'telemetry-report.mjs') expect(shipped, file).toBe(true);
      else expect(shipped, file + ' must not ship').toBe(false);
    }
    expect(scripts).toContain('verify-release.mjs');
  });

  it('declares itself as a package script so a release is one command', () => {
    expect(realPkg.scripts['release:verify']).toContain('scripts/verify-release.mjs');
  });
});
