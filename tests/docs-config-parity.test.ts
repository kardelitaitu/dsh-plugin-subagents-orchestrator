import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { parseConfigDocument } from '../src/config.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_INTERVAL_MIN_MS,
  DEFAULT_RETRY_INTERVAL_MAX_MS,
} from '../src/index.js';
import { DEFAULT_COOLDOWN_MS, DEFAULT_MAX_FAILURES } from '../src/health.js';

const BT = String.fromCharCode(96);
const FENCE = BT.repeat(3);
/** Wrap a value the way the README table writes it. */
const code = (s: string) => BT + s + BT;

/**
 * README.md is the whole onboarding surface for an open-source release, and its
 * options table is what people paste into their settings.yaml. Two failures stay
 * invisible until a user hits them: a documented option the schema does not
 * parse (silently dropped), and a documented default that no longer matches the
 * code. So the table, the example block, the real parser and the exported
 * constants are cross-checked here. Adding a config key now requires adding its
 * table row - the contract a package published to npm needs.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const configSource = fs.readFileSync(path.join(repoRoot, 'src', 'config.ts'), 'utf8');

/** Rows of the options table: key, type, default, description. */
function documentedOptions(md: string) {
  return md
    .split(/\r?\n/)
    .filter((line) => /^\| `[^@]+` \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      return {
        key: cells[0].split(BT).join(''),
        type: cells[1] || '',
        defaultValue: cells[2] || '',
        description: cells[3] || '',
      };
    });
}

/** Keys the schema reads out of the settings section, an entry, or the ui map. */
function parsedKeys(source: string, accessor: string) {
  const re = new RegExp(accessor + "\\['([^']+)'\\]", 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

/** The first fenced yaml block under the Configuration heading. */
function exampleDocument(md: string): Record<string, any> {
  const tail = md.slice(md.indexOf('## Configuration'));
  const block = tail.match(new RegExp(FENCE + 'yaml([\\s\\S]*?)' + FENCE));
  if (!block) throw new Error('README has no yaml example block under ## Configuration');
  return load(block[1].replace(/^[^\n]*\n/, '')) as Record<string, any>;
}

const options = documentedOptions(readme);
const documented = options.map((o) => o.key).sort();
const tableByKey = new Map(options.map((o) => [o.key, o]));

describe('README <-> config parity (what an npm release documents)', () => {
  it('finds the options table at all', () => {
    expect(options.length).toBeGreaterThan(5);
  });

  it('documents every option the schema parses, and nothing the schema drops', () => {
    const parsed = parsedKeys(configSource, 'section').filter((k) => k !== 'subagents-orchestrator');
    expect(parsed.length).toBeGreaterThan(5);
    expect(documented).toEqual(parsed);
  });

  it('documents the endpoint and ui entry keys the parsers accept', () => {
    const endpointsRow = tableByKey.get('endpoints');
    expect(endpointsRow, 'the endpoints row must exist').toBeTruthy();
    for (const key of parsedKeys(configSource, 'raw')) {
      expect(endpointsRow!.description, key + ' must be documented').toContain(key);
    }
    const uiRow = tableByKey.get('ui');
    expect(uiRow, 'the ui row must exist').toBeTruthy();
    for (const key of parsedKeys(configSource, 'ui')) {
      expect(uiRow!.description, key + ' must be documented').toContain(key);
    }
  });

  it('keeps every documented numeric default equal to the code constant', () => {
    const num = (key: string) => Number(tableByKey.get(key)!.defaultValue.replace(/[^\d.]/g, ''));
    expect(num('maxRetries')).toBe(DEFAULT_MAX_RETRIES);
    expect(num('intervalMinMs')).toBe(DEFAULT_RETRY_INTERVAL_MIN_MS);
    expect(num('intervalMaxMs')).toBe(DEFAULT_RETRY_INTERVAL_MAX_MS);
    expect(num('cooldownMs')).toBe(DEFAULT_COOLDOWN_MS);
    expect(num('maxFailures')).toBe(DEFAULT_MAX_FAILURES);
  });

  it('keeps the documented non-numeric defaults honest', () => {
    expect(tableByKey.get('strategy')!.defaultValue).toContain('round-robin');
    expect(tableByKey.get('mode')!.defaultValue).toContain('pool');
    expect(tableByKey.get('failover')!.defaultValue).toBe(code('true'));
    expect(tableByKey.get('enabled')!.defaultValue).toBe(code('true'));
    expect(tableByKey.get('persistTelemetry')!.defaultValue).toBe(code('false'));
    expect(tableByKey.get('endpoints')!.defaultValue).toBe(code('[]'));
    expect(tableByKey.get('fallback')!.defaultValue).toBe(code('[]'));
  });


  // Teeth check: the guard is only worth having if dropping a row or a key from
  // either side actually breaks it. Done in memory so the README is never
  // rewritten, and README.md is a shared file in this checkout.
  it('detects an undocumented key and a dropped table row', () => {
    const withoutRow = readme
      .split(/\r?\n/)
      .filter((line) => !new RegExp('^\\| ' + BT + 'totalSubagents' + BT + ' \\|').test(line))
      .join('\n');
    const keysAfterDrop = documentedOptions(withoutRow).map((o) => o.key).sort();
    expect(keysAfterDrop).not.toEqual(documented);
    expect(keysAfterDrop).not.toContain('totalSubagents');

    // A key the schema starts reading without a table row must fail the parity
    // assertion above, so prove the parser-side extractor sees it too.
    const mutatedConfig = configSource.replace(
      /if \(isFiniteNumber\(section\['maxRetries'\]\)\)/,
      "if (isFiniteNumber(section['brandNewKey']))\n  if (isFiniteNumber(section['maxRetries']))"
    );
    expect(parsedKeys(mutatedConfig, 'section')).toContain('brandNewKey');
  });

  it('ships an example config that survives schema parsing untouched', () => {
    const doc = exampleDocument(readme);
    const section = doc['subagents-orchestrator'];
    expect(section, 'example must live under the real settings key').toBeTruthy();
    const parsed = parseConfigDocument(doc);
    expect(parsed, 'example must parse to a config').toBeTruthy();
    // Nothing in the example may be dropped by validation: a key that parses
    // away is documentation that lies to everyone who copy-pastes it.
    expect(Object.keys(parsed!).sort()).toEqual(Object.keys(section).sort());
    for (const [key, value] of Object.entries(parsed!)) {
      expect(JSON.stringify(value), key + ' must survive unchanged').toBe(JSON.stringify(section[key]));
    }
  });

  it('examples the switches that actually change behaviour', () => {
    const section = exampleDocument(readme)['subagents-orchestrator'];
    for (const key of ['enabled', 'strategy', 'failover', 'maxRetries', 'cooldownMs', 'maxFailures', 'debug', 'endpoints']) {
      expect(section, key + ' should appear in the example config').toHaveProperty(key);
    }
  });
});