import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  collectExportTargets,
  compareSemver,
  changelogHasVersion,
  validateManifest,
  validatePackList,
  nodeResolvableSubpaths,
  probeSource,
  changelogSection,
  classifyLicense,
  parseRepoSlug,
  checkRepositoryRemote,
  validateBundlePatch,
  dirtyPackagedPaths,
  checkReleaseTag,
  auditLicenses,
  GIT_HOSTILE_SCRIPTS,
} from '../scripts/release-check.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const realChangelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

/** The published shape this repo must keep; every test below mutates one field. */
function basePkg(overrides: Record<string, unknown> = {}): any {
  return {
    name: 'demo-plugin',
    version: '1.2.3',
    description: 'A demo plugin',
    license: 'MIT',
    author: 'someone',
    type: 'module',
    engines: { node: '>=20' },
    sideEffects: false,
    repository: { type: 'git', url: 'git+https://github.com/acme/demo-plugin.git' },
    bugs: { url: 'https://github.com/acme/demo-plugin/issues' },
    homepage: 'https://github.com/acme/demo-plugin#readme',
    keywords: ['demo'],
    main: 'lib/index.js',
    types: 'lib/index.d.ts',
    files: ['lib', 'README.md', 'LICENSE', 'CHANGELOG.md'],
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './demo.patch': './demo.patch.yml',
    },
    dsh: { bundle: { patch: './demo.patch.yml' } },
    ...overrides,
  };
}

const alwaysExists = () => true;
const fullPack = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'demo.patch.yml', 'lib/index.js', 'lib/index.d.ts'];

describe('scripts/release-check.mjs (publish preflight)', () => {
  describe('collectExportTargets', () => {
    it('flattens condition objects without inventing subpaths', () => {
      expect(collectExportTargets({ '.': { types: './lib/index.d.ts', default: './lib/index.js' } })).toEqual([
        { subpath: '.', target: 'lib/index.d.ts' },
        { subpath: '.', target: 'lib/index.js' },
      ]);
    });

    it('keeps each named subpath with its own targets and dedupes', () => {
      const targets = collectExportTargets(
        {
          '.': { types: './a.d.ts', default: './a.js' },
          './sub': { types: './b.d.ts', default: './b.js' },
          './data': './data.json',
        },
        '.'
      );
      expect(targets.map((t: any) => t.subpath + '->' + t.target)).toEqual([
        '.->a.d.ts',
        '.->a.js',
        './sub->b.d.ts',
        './sub->b.js',
        './data->data.json',
      ]);
      // A second walk of the same map must not duplicate anything.
      expect(collectExportTargets({ '.': { default: './a.js' } })).toEqual([{ subpath: '.', target: 'a.js' }]);
    });

    it('supports fallback arrays and ignores non-relative or malformed values', () => {
      expect(collectExportTargets({ '.': [{ default: './x.js' }, './y.js'], bad: 'https://nope', './z': 42 })).toEqual([
        { subpath: '.', target: 'y.js' },
      ]);
      expect(collectExportTargets(undefined)).toEqual([]);
      expect(collectExportTargets('nope')).toEqual([]);
    });
  });

  describe('compareSemver', () => {
    it('orders numerically per component, not lexically', () => {
      expect(compareSemver('1.2.10', '1.2.3')).toBeGreaterThan(0);
      expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
      expect(compareSemver('2.0.0', '10.0.0')).toBeLessThan(0);
      expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    });

    it('sorts a pre-release below its release', () => {
      expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
      expect(compareSemver('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
    });
  });

  describe('changelogHasVersion', () => {
    it('matches an exact heading with its date suffix', () => {
      expect(changelogHasVersion('## [1.2.0] - 2026-09-08', '1.2.0')).toBe(true);
      expect(changelogHasVersion('## [1.2.0]', '1.2.0')).toBe(true);
    });

    it('does not match a longer version by prefix', () => {
      expect(changelogHasVersion('## [1.2.0] - 2026-09-08', '1.2')).toBe(false);
      expect(changelogHasVersion('## [1.2.0] - 2026-09-08', '1.2.1')).toBe(false);
      expect(changelogHasVersion('## [Unreleased]', '1.2.0')).toBe(false);
    });

    it('rejects empty inputs', () => {
      expect(changelogHasVersion('', '1.0.0')).toBe(false);
      expect(changelogHasVersion('## [1.0.0]', '')).toBe(false);
    });
  });

  describe('validateManifest', () => {
    it('accepts a complete manifest', () => {
      const { issues } = validateManifest(basePkg(), { exists: alwaysExists });
      expect(issues).toEqual([]);
    });

    it('rejects private packages and non-semver versions', () => {
      expect(validateManifest(basePkg({ private: true }), { exists: alwaysExists }).issues.join('|')).toMatch(/blocks publishing/);
      expect(validateManifest(basePkg({ version: '1.2' }), { exists: alwaysExists }).issues.join('|')).toMatch(/not a valid semver/);
    });

    it('requires the fields the npm listing and the DSH resolver depend on', () => {
      const missing = { description: '', license: '', repository: undefined, engines: undefined, type: 'commonjs' };
      const { issues } = validateManifest(basePkg(missing), { exists: alwaysExists });
      const joined = issues.join('|');
      expect(joined).toMatch(/"description" is required/);
      expect(joined).toMatch(/"license" is required/);
      expect(joined).toMatch(/repository\.url/);
      expect(joined).toMatch(/engines\.node/);
      expect(joined).toMatch(/"type" must be "module"/);
    });

    it('flags every lifecycle script that breaks a git-hosted install', () => {
      for (const hook of GIT_HOSTILE_SCRIPTS) {
        const scripts = { [hook]: 'git config core.hooksPath .githooks' };
        const { issues } = validateManifest(basePkg({ scripts }), { exists: alwaysExists });
        expect(issues.join('|'), hook).toMatch(/breaks git-hosted installs/);
      }
      // A plain script block is fine.
      expect(validateManifest(basePkg({ scripts: { build: 'tsup' } }), { exists: alwaysExists }).issues).toEqual([]);
    });

    it('flags local-only dependency specs that cannot resolve for consumers', () => {
      const { issues } = validateManifest(
        basePkg({ dependencies: { helper: 'link:../helper', other: 'file:./tgz/other.tgz' } }),
        { exists: alwaysExists }
      );
      expect(issues.filter((i: string) => /local-only spec/.test(i))).toHaveLength(2);
    });

    it('flags an exports target that was never built', () => {
      const { issues } = validateManifest(basePkg(), { exists: (rel: string) => rel !== 'lib/index.js' });
      expect(issues.join('|')).toMatch(/exports\[\.\] -> lib\/index\.js does not exist/);
    });

    it('flags a missing DSH bundle patch but only warns when the key is absent', () => {
      expect(validateManifest(basePkg(), { exists: () => false }).issues.join('|')).toMatch(/dsh\.bundle\.patch/);
      const pkg = basePkg();
      delete pkg.dsh;
      expect(validateManifest(pkg, { exists: alwaysExists }).warnings.join('|')).toMatch(/dsh\.bundle\.patch/);
    });

    it('demands a changelog section for the version being published', () => {
      const { issues } = validateManifest(basePkg(), { exists: alwaysExists, changelog: realChangelog });
      expect(issues.join('|')).toMatch(/no heading for \[1\.2\.3\]/);
      expect(validateManifest(basePkg({ version: '1.2.0' }), { exists: alwaysExists, changelog: realChangelog }).issues).toEqual([]);
    });
  });

  describe('validatePackList', () => {
    it('accepts a manifest that carries every export target', () => {
      expect(validatePackList(fullPack, basePkg()).issues).toEqual([]);
    });

    it('fails when a subpath the manifest promises was not packed', () => {
      const { issues } = validatePackList(fullPack.filter((f) => f !== 'lib/index.js'), basePkg());
      expect(issues.join('|')).toMatch(/exports\[\.\] -> lib\/index\.js was not packed/);
      expect(issues.join('|')).toMatch(/main -> lib\/index\.js was not packed/);
    });

    it('fails when a doc an open-source release must carry is missing', () => {
      for (const doc of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
        const { issues } = validatePackList(fullPack.filter((f) => f !== doc), basePkg());
        expect(issues.join('|'), doc).toContain(doc + ' is missing');
      }
    });

    it('rejects repo noise leaking into the tarball', () => {
      const { issues } = validatePackList([...fullPack, 'src/index.ts', 'tests/tdd1.test.ts', '.github/workflows/ci.yml'], basePkg());
      expect(issues.filter((i: string) => /should not be published/.test(i))).toHaveLength(3);
    });

    it('rejects an empty shell of a package', () => {
      expect(validatePackList(['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'], basePkg({ exports: undefined, main: undefined, dsh: undefined })).issues.join('|'))
        .toMatch(/no JavaScript payload/);
    });
  });

  describe('nodeResolvableSubpaths', () => {
    it('keeps JS-serving subpaths and drops the browser, data and manifest ones', () => {
      expect(nodeResolvableSubpaths(realPkg)).toEqual(['.', './diagnostics']);
    });
  });

  describe('probeSource', () => {
    it('asserts the documented defaults through the published artifact', () => {
      const src = probeSource(realPkg);
      expect(src).toMatch(/resolveMaxRetries\(\{\}\), 20/);
      expect(src).toMatch(/DEFAULT_RETRY_INTERVAL_MIN_MS, 3000/);
      expect(src).toMatch(/getDiagnosticsSnapshot/);
      expect(src).toContain('"."');
      expect(src).toContain('"./diagnostics"');
    });
  });

  it('demands a top-level types field when the package ships declarations', () => {
    // Classic moduleResolution "node" ignores the exports map entirely, so
    // without "types" those consumers get no types and no warning.
    const noTypes = basePkg();
    delete noTypes.types;
    const { issues } = validateManifest(noTypes, { exists: alwaysExists });
    expect(issues.join('|')).toMatch(/no top-level "types"/);

    // A JS-only package needs none, and must not be failed for lacking it.
    const jsOnly = basePkg({ exports: { '.': './lib/index.js' } });
    delete jsOnly.types;
    expect(validateManifest(jsOnly, { exists: alwaysExists }).issues).toEqual([]);

    // Naming a types file the build did not produce is its own error.
    const missing = validateManifest(basePkg({ types: 'lib/index.d.ts' }), {
      exists: (p: string) => p !== 'lib/index.d.ts',
    });
    expect(missing.issues.join('|')).toMatch(/"types" -> lib\/index\.d\.ts does not exist/);
  });

  it('blocks a tarball that leaves the type declarations behind', () => {
    expect(validatePackList(fullPack, basePkg()).issues).toEqual([]);
    const dropped = fullPack.filter((f) => f !== 'lib/index.d.ts');
    expect(validatePackList(dropped, basePkg()).issues.join('|')).toMatch(/types -> lib\/index\.d\.ts was not packed/);
  });

  // This is the actual gate, run as a test: whatever is committed today must
  // already be publish-ready, so Phase 5 cannot regress silently.
  describe('this repository', () => {
    it('ships a publish-ready manifest and changelog', () => {
      const { issues } = validateManifest(realPkg, { changelog: realChangelog });
      expect(issues).toEqual([]);
    });

    it('names only files that exist on disk in its exports map', () => {
      const targets = collectExportTargets(realPkg.exports);
      expect(targets.length).toBeGreaterThan(0);
      for (const { target } of targets) {
        expect(fs.existsSync(path.join(repoRoot, target)), target).toBe(true);
      }
    });
  });
});

describe('release notes and licensing (publish preflight, part 2)', () => {
  describe('changelogSection', () => {
    it('returns one version body without touching the next section', () => {
      const md = [
        '# Changelog',
        '',
        '## [2.0.0] - 2026-10-01',
        '',
        '### Added',
        '',
        '- newer thing',
        '',
        '## [1.2.0] - 2026-09-08',
        '',
        '### Added',
        '',
        '- the thing that shipped',
        '',
        '## [1.1.0] - 2026-09-08',
        '',
        '- older thing',
      ].join('\n');
      expect(changelogSection(md, '1.2.0')).toBe('### Added\n\n- the thing that shipped');
    });

    it('reads the real changelog section for the version being published', () => {
      const section = changelogSection(realChangelog, realPkg.version);
      expect(section.length).toBeGreaterThan(0);
      expect(section).toMatch(/### Added/);
      expect(section).not.toMatch(/## \[1\.1\.0\]/);
      // The preflight gate must be documented in its own release notes.
      expect(section).toMatch(/release-check\.mjs/);
    });

    it('returns an empty string for an undocumented version', () => {
      expect(changelogSection(realChangelog, '9.9.9')).toBe('');
      expect(changelogSection('', '1.2.0')).toBe('');
      expect(changelogSection(realChangelog, '')).toBe('');
    });
  });

  describe('classifyLicense', () => {
    it('accepts the permissive SPDX ids this stack actually uses', () => {
      for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', '0BSD', 'CC0-1.0', 'Unlicense', 'MIT AND ISC', '(MIT OR Apache-2.0)']) {
        expect(classifyLicense(id), id).toBe('permissive');
      }
    });

    it('flags copyleft before it can change the terms of an MIT release', () => {
      for (const id of ['GPL-3.0-only', 'AGPL-3.0', 'LGPL-2.1-or-later', 'MPL-2.0', 'EUPL-1.2', 'GPL-3.0 WITH Classpath-exception-2.0']) {
        expect(classifyLicense(id), id).toBe('copyleft');
      }
      expect(classifyLicense('MIT OR GPL-3.0-or-later')).toBe('copyleft');
    });

    it('reports anything unrecognized instead of guessing', () => {
      expect(classifyLicense(undefined)).toBe('unknown');
      expect(classifyLicense('')).toBe('unknown');
      expect(classifyLicense('SEE LICENSE IN LICENSE.txt')).toBe('unknown');
      expect(classifyLicense('CC-BY-NC-4.0')).toBe('unknown');
    });
  });

  describe('auditLicenses', () => {
    it('audits the resolved runtime closure and ignores the package itself', () => {
      const { issues, warnings, permissive, total } = auditLicenses(
        [
          { name: 'demo-plugin', license: 'MIT' },
          { name: 'js-yaml', license: 'MIT' },
          { name: 'schemastery', license: 'MIT' },
        ],
        'demo-plugin'
      );
      expect(issues).toEqual([]);
      expect(warnings).toEqual([]);
      expect(permissive).toBe(2);
      expect(total).toBe(2);
    });

    it('fails the release on a copyleft dependency and warns on a missing license', () => {
      const { issues, warnings } = auditLicenses(
        [
          { name: 'helper', license: 'GPL-3.0-or-later' },
          { name: 'mystery', license: '' },
          { name: 'fine', license: 'ISC' },
        ],
        'demo-plugin'
      );
      expect(issues.join('|')).toMatch(/helper ships as GPL-3\.0-or-later/);
      expect(warnings.join('|')).toMatch(/mystery has no recognizable license/);
    });

    it('tolerates malformed entries', () => {
      const { issues, warnings } = auditLicenses([null, { name: '' }, {}], 'demo-plugin');
      expect(issues).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  // A check nobody runs is not a gate: pin the wiring between the script and
  // the pipelines that are supposed to execute it.
  describe('pipeline wiring', () => {
    const load = (file: string) => loadYaml(fs.readFileSync(path.join(repoRoot, file), 'utf8')) as any;

    it('CI runs the publish preflight after the build', () => {
      const ci = load('.github/workflows/ci.yml');
      const runs = ci.jobs.verify.steps.map((s: any) => s.run || '').join('\n');
      expect(runs).toMatch(/pnpm run release:check/);
      // The lib/ parity guard must ignore *.map files, or a Linux runner fails
      // on a byte-different sourcesContent that no consumer ever loads.
      expect(runs).toMatch(/git diff --quiet -- lib ':\(exclude\)lib\/\*\.map'/);
      expect(runs).not.toMatch(/git diff --quiet -- lib(?! ')/);
    });

    it('the release workflow gates on the preflight before publishing', () => {
      const rel = load('.github/workflows/release.yml');
      expect(String(rel.on.push.tags.join(' '))).toMatch(/v\[0-9\]/);
      const gateSteps = rel.jobs.gate.steps.map((s: any) => s.run || '').join('\n');
      const publishSteps = rel.jobs.publish.steps.map((s: any) => s.run || '').join('\n');
      expect(gateSteps).toMatch(/pnpm run release:check/);
      // The gate job must run before anything reaches the registry.
      expect(rel.jobs.publish.needs).toBe('gate');
      expect(publishSteps).toMatch(/npm publish "[^"]*" --provenance/);
      expect(publishSteps).toMatch(/--print-changelog/);
      expect(rel.jobs.publish.permissions.contents).toBe('write');
    });

    it('CI exercises the artifact handoff the publish job depends on', () => {
      const ci = load('.github/workflows/ci.yml');
      const pack = ci.jobs['pack-release-artifact'];
      const unpack = ci.jobs['unpack-release-artifact'];
      expect(pack, 'a job that packs and uploads must exist').toBeTruthy();
      expect(unpack, 'a second job must read it back from the store').toBeTruthy();
      // Different jobs, or it is not a transport test.
      expect(unpack.needs).toBe('pack-release-artifact');
      const up = pack.steps.find((s: any) => String(s.uses || '').includes('upload-artifact'));
      const down = unpack.steps.find((s: any) => String(s.uses || '').includes('download-artifact'));
      expect(down.with.name, 'the download must name what was uploaded').toBe(up.with.name);
      expect(up.with['if-no-files-found'], 'an empty upload must fail, not ship nothing').toBe('error');
      const runs = unpack.steps.map((s: any) => s.run || '').join('\n');
      // A checksum catches a store that returns different bytes; the tar -xzf
      // plus the payload probes catch one that stops decompressing the upload.
      expect(runs).toMatch(/sha256sum --check/);
      expect(runs).toMatch(/tar -xzf/);
      expect(runs).toMatch(/package\/lib\/index\.js/);
      expect(runs).toMatch(/package\/cordis\.patch\.yml/);
    });

it('guards the release on the tag version through the tested script', () => {
      const rel = load('.github/workflows/release.yml');
      const steps = rel.jobs.gate.steps;
      const idx = steps.findIndex((s: any) => /must name the packaged version/.test(s.name || ''));
      expect(idx, 'the guard must exist').toBeGreaterThan(-1);
      // Runs on every event: the guard tolerates a non-tag ref, so the
      // rehearsal exercises the same command line a release uses.
      expect(steps[idx].if, 'the guard must not be push-only').toBeFalsy();
      expect(steps[idx].name).toMatch(/Ref must name the packaged version/);
      // As a preflight mode, not inline shell nobody ever runs - and before the
      // install, so a wrong tag costs seconds rather than a full pipeline.
      expect(steps[idx].run).toMatch(/node scripts\/release-check\.mjs --expect-tag/);
      expect(steps[idx].run).not.toMatch(/node -p/);
      const installIdx = steps.findIndex((s: any) => /Install dependencies/.test(s.name || ''));
      expect(idx).toBeLessThan(installIdx);
    });

    it('declares the preflight as a package script', () => {
      expect(realPkg.scripts['release:check']).toContain('scripts/release-check.mjs');
      expect(realPkg.scripts['ci:local']).toContain('release-check.mjs');
    });
  });
});

describe('repository cross-check (publish preflight, part 3)', () => {
  describe('parseRepoSlug', () => {
    it('reduces every git URL form to owner/repo', () => {
      expect(parseRepoSlug('git+https://github.com/acme/demo.git')).toBe('acme/demo');
      expect(parseRepoSlug('https://github.com/acme/demo')).toBe('acme/demo');
      expect(parseRepoSlug('https://github.com/acme/demo/')).toBe('acme/demo');
      expect(parseRepoSlug('git@github.com:acme/demo.git')).toBe('acme/demo');
      expect(parseRepoSlug('ssh://git@github.com/acme/demo')).toBe('acme/demo');
      expect(parseRepoSlug('https://user:***@github.com/acme/demo.git')).toBe('acme/demo');
      expect(parseRepoSlug('git+ssh://git@gitlab.example.com/group/sub/proj.git')).toBe('sub/proj');
    });

    it('returns null instead of guessing on non-URLs', () => {
      expect(parseRepoSlug('')).toBeNull();
      expect(parseRepoSlug(null)).toBeNull();
      expect(parseRepoSlug('not a repo url')).toBeNull();
      expect(parseRepoSlug('https://github.com/acme')).toBeNull();
    });
  });

  describe('checkRepositoryRemote', () => {
    const pkgWith = (url: string | undefined) => ({ repository: url ? { type: 'git', url } : undefined });

    it('passes when the manifest and the origin remote agree', () => {
      const res = checkRepositoryRemote(
        pkgWith('git+https://github.com/kardelitaitu/dsh-plugin-subagents-orchestrator.git'),
        'https://github.com/kardelitaitu/dsh-plugin-subagents-orchestrator.git'
      );
      expect(res.issues).toEqual([]);
      expect(res.note).toMatch(/matches the origin remote/);
    });

    it('fails when they disagree - the documented github: install would be wrong', () => {
      const res = checkRepositoryRemote(
        pkgWith('git+https://github.com/someone/else.git'),
        'https://github.com/kardelitaitu/dsh-plugin-subagents-orchestrator.git'
      );
      expect(res.issues.join('|')).toMatch(/points at someone\/else but this checkout pushes to kardelitaitu/);
      expect(res.note).toBeNull();
    });

    it('only warns on an owner difference, so a fork pull-request stays green', () => {
      const res = checkRepositoryRemote(
        pkgWith('git+https://github.com/kardelitaitu/dsh-plugin-subagents-orchestrator.git'),
        'https://github.com/contributor/dsh-plugin-subagents-orchestrator.git'
      );
      expect(res.issues).toEqual([]);
      expect(res.warnings.join('|')).toMatch(/fork or mirror/);
    });

    it('stays quiet when there is no remote to compare against', () => {
      const res = checkRepositoryRemote(pkgWith('https://github.com/a/b.git'), null);
      expect(res.issues).toEqual([]);
      expect(res.note).toMatch(/no origin remote/);
    });

    it('warns rather than inventing a comparison for a malformed url', () => {
      const res = checkRepositoryRemote(pkgWith('see README'), 'https://github.com/a/b.git');
      expect(res.warnings.join('|')).toMatch(/not a recognizable git URL/);
    });
  });
});

describe('Cordis bundle patch (publish preflight, part 4)', () => {
  const pkg = { name: 'dsh-demo' };
  const good = '# Subagents Orchestrator bundle patch\n- insert:\n    - id: dsh-demo\n      name: dsh-demo\n';

  it('accepts a patch that registers the published package', () => {
    const { issues, warnings, notes } = validateBundlePatch(good, pkg);
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
    expect(notes.join('|')).toMatch(/registers "dsh-demo"/);
  });

  it('blocks a patch whose id names another package - installs, then loads nothing', () => {
    const { issues } = validateBundlePatch('- insert:\n    - id: other-plugin\n      name: other-plugin\n', pkg);
    expect(issues.join('|')).toMatch(/id is "other-plugin" but the package is "dsh-demo"/);
  });

  it('blocks an empty or id-less patch', () => {
    expect(validateBundlePatch('', pkg).issues.join('|')).toMatch(/empty or unreadable/);
    expect(validateBundlePatch('- insert:\n    - name: dsh-demo\n', pkg).issues.join('|')).toMatch(/declares no id/);
  });

  it('warns about a shape that is probably not a Cordis patch, and accepts quoted ids', () => {
    expect(validateBundlePatch('- id: dsh-demo\n  name: dsh-demo\n', pkg).warnings.join('|')).toMatch(/no "insert:" block/);
    expect(validateBundlePatch('- insert:\n    - id: "dsh-demo"\n      name: "dsh-demo"\n', pkg).issues).toEqual([]);
  });

  it('warns when only one entry of a multi-entry patch matches', () => {
    const { issues, warnings } = validateBundlePatch(
      '- insert:\n    - id: dsh-demo\n      name: dsh-demo\n    - id: leftover\n      name: leftover\n',
      pkg
    );
    expect(issues).toEqual([]);
    expect(warnings.join('|')).toMatch(/leftover.*differs/);
  });

  it('passes on the real patch in this repo (what DSH actually loads)', () => {
    const text = fs.readFileSync(path.join(repoRoot, realPkg.dsh.bundle.patch.replace(/^\.\//, '')), 'utf8');
    const { issues, warnings } = validateBundlePatch(text, realPkg);
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('dirty-tree guard (publish preflight, part 5)', () => {
  const PACKAGED = ['lib', 'scripts/telemetry-report.mjs', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE'];

  it('reads porcelain v1 lines by column, not by first space', () => {
    expect(dirtyPackagedPaths([' M lib/index.js', '?? lib/index.d.ts'], PACKAGED)).toEqual({
      dirty: ['lib/index.js', 'lib/index.d.ts'],
      clean: false,
    });
  });

  it('ignores everything the package does not ship', () => {
    const status = [' M src/index.ts', '?? tests/notices.test.ts', ' M ROADMAP.md', ' M .github/workflows/ci.yml'];
    expect(dirtyPackagedPaths(status, PACKAGED).clean).toBe(true);
  });

  it('honours a files entry that names one script, not the whole directory', () => {
    const status = [' M scripts/telemetry-report.mjs', '?? scripts/release-check.mjs'];
    const { dirty } = dirtyPackagedPaths(status, PACKAGED);
    expect(dirty).toEqual(['scripts/telemetry-report.mjs']);
  });

  it('follows a rename to its new path and normalizes separators and quoting', () => {
    expect(dirtyPackagedPaths(['R  README.old.md -> README.md'], PACKAGED).dirty).toEqual(['README.md']);
    expect(dirtyPackagedPaths([' M "lib/a b.js"'], PACKAGED).dirty).toEqual(['lib/a b.js']);
    expect(dirtyPackagedPaths([' M lib\\nested\\index.js'], PACKAGED).dirty).toEqual(['lib/nested/index.js']);
  });

  it('ignores rebuilt sourcemaps, which a Linux runner always rewrites', () => {
    // The lib/ parity check has the same exclusion: maps embed sourcesContent
    // byte-for-byte, so pnpm build on another platform is not a dirty tree.
    const status = [' M lib/client.js.map', ' M lib/index.js.map'];
    expect(dirtyPackagedPaths(status, PACKAGED).clean).toBe(true);
    expect(dirtyPackagedPaths([' M lib/client.js.map', ' M lib/client.js'], PACKAGED).dirty).toEqual(['lib/client.js']);
  });

    it('treats a deleted packaged file as dirty (it would vanish from the tarball)', () => {
    expect(dirtyPackagedPaths([' D LICENSE'], PACKAGED).clean).toBe(false);
  });

  it('counts package.json as packaged even when the allowlist omits it', () => {
    // npm always ships the manifest (and README/LICENSE), so a dirty
    // package.json is a dirty artifact - the one file a release cut edits last.
    const PACKAGED_NO_MANIFEST = ['lib', 'README.md', 'LICENSE'];
    const status = [' M package.json', ' M scripts/release-check.mjs'];
    expect(dirtyPackagedPaths(status, PACKAGED_NO_MANIFEST).dirty).toEqual(['package.json']);
  });

  it('reports clean for an empty status', () => {
    expect(dirtyPackagedPaths([], PACKAGED)).toEqual({ dirty: [], clean: true });
  });
});

describe('consumer probe covers the real host contract', () => {
  const probe = probeSource(realPkg);

  it('asserts every host event that apply() actually registers', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
    const re = /ctx\.on\(\s*'([^']+)'/g;
    const registered: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (!registered.includes(m[1])) registered.push(m[1]);
    }
    expect(registered.length).toBeGreaterThanOrEqual(3);
    const listed = (probe.match(/const EVENTS = \[([^\]]*)\]/) || ['', ''])[1];
    const inProbe = listed.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    // Every event the published-artifact probe insists on must really be
    // registered - a stale name there would make the gate red at release time
    // (that is exactly how the first version of this check failed CI). New
    // handlers may exist beyond it: unreleased surfaces come and go, the gate
    // may only require what the committed artifact actually ships.
    expect(inProbe.length).toBeGreaterThanOrEqual(3);
    for (const event of inProbe) {
      expect(registered, event + ' is required by the probe but not registered by apply()').toContain(event);
    }
  });

  it('keeps the host-wiring assertions in the probe', () => {
    // The mutation check that proves these are live cannot run in the suite (it
    // needs a full install), so pin their presence: dropping one is how a
    // packaging gate quietly becomes decorative.
    expect(probe).toMatch(/host\.apply\(ctx\)/);
    expect(probe).toMatch(/must inject the subagents service/);
    expect(probe).toMatch(/must wrap the host start\(\)/);
    expect(probe).toMatch(/no listener for /);
    expect(probe).toMatch(/must reach the host/);
    expect(probe).toMatch(/the request payload must survive wrapping/);
    expect(probe).toMatch(/dispose must hand back the original service/);
    // HOME is redirected so the smoke test never reads the maintainer config.
    expect(probe).toMatch(/process\.env\.HOME = process\.cwd\(\)/);
    expect(probe).toMatch(/process\.env\.USERPROFILE = process\.cwd\(\)/);
    // And it must still terminate: apply() starts a config watcher.
    expect(probe).toMatch(/process\.exit\(0\)/);
  });
});

describe('release tag guard (publish preflight, part 6)', () => {
  const V = '1.2.0';

  it('passes only when the tag names the packaged version', () => {
    expect(checkReleaseTag('v' + V, V).issues).toEqual([]);
    expect(checkReleaseTag('v' + V, V).notes.join('|')).toMatch(/names the packaged version/);
  });

  it('blocks a tag that would publish the wrong number', () => {
    for (const tag of ['v0.0.0', 'v1.1.0', 'v1.2.1', 'v1.2.0-rc.1', 'v2.0.0']) {
      const { issues } = checkReleaseTag(tag, V);
      expect(issues.length, tag + ' must be blocked').toBe(1);
      expect(issues[0]).toMatch(/does not match package version v1\.2\.0/);
    }
  });

  it('steps aside for a non-tag ref, and rejects a v-tag that is not a version', () => {
    expect(checkReleaseTag('main', V).issues).toEqual([]);
    expect(checkReleaseTag('refs/heads/main', V).issues).toEqual([]);
    expect(checkReleaseTag('release-1.2', V).issues).toEqual([]);
    expect(checkReleaseTag('vv1.2.0', V).issues.join('|')).toMatch(/not a vX\.Y\.Z version tag/);
  });

  it('fails loudly when handed no ref at all', () => {
    expect(checkReleaseTag('', V).issues.join('|')).toMatch(/no ref name given/);
    expect(checkReleaseTag(undefined, V).issues.length).toBe(1);
  });

  it('agrees with the manifest in this repository', () => {
    expect(checkReleaseTag('v' + realPkg.version, realPkg.version).issues).toEqual([]);
  });
});
