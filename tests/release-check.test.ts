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
      expect(runs).toMatch(/git diff --quiet -- lib/);
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

    it('declares the preflight as a package script', () => {
      expect(realPkg.scripts['release:check']).toContain('scripts/release-check.mjs');
      expect(realPkg.scripts['ci:local']).toContain('release-check.mjs');
    });
  });
});
