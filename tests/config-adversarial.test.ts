import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseConfigDocument,
  extractEndpoints,
  extractFallbackChain,
  parseConfigFile,
  initWatcher,
  disposeWatcher,
  reloadConfig,
  getConfig,
  getCachedEndpoints,
  getCachedFallbackChain,
  getCachedMode,
  setConfigForTest,
  resetConfigForTest,
  hydrateQuarantinesFromConfig,
  WATCH_DEBOUNCE_MS
} from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import type { OrchestratorConfig } from '../src/types.js';

/**
 * Adversarial round: src/config.ts (settings cache / schema / watcher).
 * Temp-directory only - the developer's real ~/.dsh/settings.yaml is never read.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds; immune to fixed-sleep timing flakes. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await sleep(25);
  }
}

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-adv-'));
  testFile = path.join(testDir, 'settings.yaml');
  resetConfigForTest(testFile);
});

afterEach(() => {
  disposeWatcher();
  vi.restoreAllMocks();
  resetConfigForTest();
  defaultCircuitBreaker.clear();
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

function yamlDoc(fields: string): string {
  return `subagents-orchestrator:\n${fields}`;
}

const poolYaml = (strategy: string, n: number): string =>
  yamlDoc(
    `  enabled: true\n  strategy: ${strategy}\n  endpoints:\n` +
      Array.from({ length: n }, (_, i) => `    - provider: p${i + 1}\n      model: m${i + 1}`).join('\n') +
      '\n'
  );

describe('R1: watcher recovery after the settings file is deleted', () => {
  it('picks up a recreated settings file (living directory keeps the watch handle)', async () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    fs.unlinkSync(testFile);
    await waitFor(() => getConfig() === null, 'deletion clears the cache');

    // The settings service rewrites the file into the same living directory.
    fs.writeFileSync(testFile, poolYaml('weighted', 2), 'utf8');
    await waitFor(() => getConfig()?.strategy === 'weighted', 'recreated file re-applies');
    expect(getCachedEndpoints()).toHaveLength(2);
  });
});

describe('R2: explicit reloadConfig recovery after deletion', () => {
  it('reads a recreated file back through an explicit reload', () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);

    fs.unlinkSync(testFile);
    reloadConfig();
    expect(getConfig()).toBeNull();

    fs.writeFileSync(testFile, poolYaml('weighted', 2), 'utf8');
    reloadConfig();
    expect(getConfig()?.strategy).toBe('weighted');
  });
});

/** A settings.yaml carrying a persisted quarantine snapshot, as the plugin writes it. */
function yamlWithQuarantines(q: Record<string, number>): string {
  const lines = Object.entries(q)
    .map(([k, v]) => '    ' + k + ': ' + v)
    .join('\n');
  return [
    'subagents-orchestrator:',
    '  enabled: true',
    '  endpoints:',
    '    - provider: p1',
    '      model: m1',
    '    - provider: p2',
    '      model: m2',
    '  quarantines:',
    lines,
    ''
  ].join('\n');
}

function linesOf(...ls: string[]): string {
  return ls.join('\n') + '\n';
}

describe('R3: settings-file encoding', () => {
  it('parses a UTF-8 BOM-prefixed settings file', () => {
    fs.writeFileSync(testFile, '\uFEFF' + poolYaml('weighted', 2), 'utf8');
    expect(parseConfigFile(testFile)?.strategy).toBe('weighted');
  });

  it('parses a CRLF settings file', () => {
    fs.writeFileSync(testFile, poolYaml('random', 1).split('\n').join('\r\n'), 'utf8');
    expect(parseConfigFile(testFile)?.strategy).toBe('random');
  });
});

describe('R4: watcher handle lifecycle', () => {
  it('a second initWatcher closes the first handle (no leaked watcher)', async () => {
    initWatcher(testFile);
    initWatcher(testFile);
    disposeWatcher();

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      fs.writeFileSync(testFile, poolYaml('random', 3), 'utf8');
      await sleep(WATCH_DEBOUNCE_MS + 250);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('re-arms after disposeWatcher and picks up the file changed while unwatched', () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    disposeWatcher();
    fs.writeFileSync(testFile, poolYaml('weighted', 2), 'utf8');
    expect(getConfig()?.strategy).toBe('round-robin'); // no watcher, stale snapshot

    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('weighted');
    expect(getCachedEndpoints()).toHaveLength(2);
  });

  it('handles an atomic save (temp file renamed over the target)', async () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    const tmp = path.join(testDir, 'settings.yaml.tmp');
    fs.writeFileSync(tmp, poolYaml('weighted', 2), 'utf8');
    fs.renameSync(tmp, testFile);

    await waitFor(() => getConfig()?.strategy === 'weighted', 'atomic-save rename to reload');
    expect(getCachedEndpoints()).toHaveLength(2);
  });

  it('initialises cleanly against a directory that does not exist yet', () => {
    const missingDir = path.join(testDir, 'not-yet');
    resetConfigForTest(path.join(missingDir, 'settings.yaml'));
    expect(() => initWatcher(path.join(missingDir, 'settings.yaml'))).not.toThrow();
    expect(getConfig()).toBeNull();
    expect(getCachedEndpoints()).toEqual([]);
    expect(getCachedMode()).toBe('pool');
  });
});

describe('R5: quarantine hydration is start-up only', () => {
  it('a later reloadConfig does not apply a quarantine that appeared on disk', () => {
    const tripA = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripA }), 'utf8');
    initWatcher(testFile);
    hydrateQuarantinesFromConfig();
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // A new trip appears in the file (another process, or our own persistence
    // write) and a reload runs. The reload owns CONFIG, never health state.
    const tripB = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripA, 'p2::m2': tripB }), 'utf8');
    reloadConfig();

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(true);
    expect(defaultCircuitBreaker.getQuarantines()['p2::m2']).toBeUndefined();
  });
});

describe('R6: mode/chain through the disk path', () => {
  it('mode: fallback with an all-parked chain degrades to pool on reload', () => {
    fs.writeFileSync(
      testFile,
      linesOf(
        'subagents-orchestrator:',
        '  enabled: true',
        '  mode: fallback',
        '  endpoints:',
        '    - provider: p1',
        '      model: m1',
        '  fallback:',
        '    - provider: r1',
        '      model: m1',
        '      enabled: false'
      ),
      'utf8'
    );
    initWatcher(testFile);
    expect(getCachedMode()).toBe('pool');
    expect(getCachedFallbackChain()).toEqual([]);
    expect(getCachedEndpoints()).toHaveLength(1);
  });

  it('a chain-only fallback config stays in fallback mode with an empty primary', () => {
    fs.writeFileSync(
      testFile,
      linesOf(
        'subagents-orchestrator:',
        '  enabled: true',
        '  mode: fallback',
        '  fallback:',
        '    - provider: r1',
        '      model: m1'
      ),
      'utf8'
    );
    initWatcher(testFile);
    expect(getCachedMode()).toBe('fallback');
    expect(getCachedEndpoints()).toEqual([]);
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1']);
  });

  it('rejects a wrongly-cased mode instead of coercing it', () => {
    expect(parseConfigDocument({ 'subagents-orchestrator': { mode: 'Fallback' } })?.mode).toBeUndefined();
    expect(parseConfigDocument({ 'subagents-orchestrator': { mode: 'pool' } })?.mode).toBe('pool');
  });
});

describe('R7: extraction precision', () => {
  it('treats whitespace-only provider/model as unusable at extraction time', () => {
    expect(
      extractEndpoints({
        endpoints: [
          { provider: '   ', model: 'm' },
          { provider: 'p', model: '\t\n' },
          { provider: 'ok', model: 'm' }
        ]
      }).map((e) => e.provider)
    ).toEqual(['ok']);
    expect(extractFallbackChain({ fallback: [{ provider: ' ', model: ' ' }] })).toEqual([]);
  });

  it('returns empty for null/absent/empty lists without throwing', () => {
    expect(extractEndpoints(null)).toEqual([]);
    expect(extractFallbackChain(null)).toEqual([]);
    expect(extractEndpoints({ endpoints: [] })).toEqual([]);
    expect(extractFallbackChain({ fallback: [] })).toEqual([]);
  });

  it('preserves duplicates and order in the chain (no silent dedupe)', () => {
    expect(
      extractFallbackChain({
        fallback: [
          { provider: 'r2', model: 'm' },
          { provider: 'r1', model: 'm' },
          { provider: 'r2', model: 'm' }
        ]
      }).map((e) => e.provider)
    ).toEqual(['r2', 'r1', 'r2']);
  });

  it('keeps a parked endpoint in the parsed config but out of the pool', () => {
    const cfg = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          { provider: 'p1', model: 'm1' },
          { provider: 'p2', model: 'm2', enabled: false }
        ]
      }
    });
    expect(cfg?.endpoints).toHaveLength(2);
    expect(extractEndpoints(cfg).map((e) => e.provider)).toEqual(['p1']);
  });
});

describe('R8: field-level parse precision', () => {
  it('drops non-boolean endpoint.enabled rather than coercing (and therefore does not park)', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm', enabled: 'false' }] }
    });
    expect(parsed?.endpoints?.[0]).toEqual({ provider: 'p', model: 'm' });
  });

  it('drops a blank reasoningEffort (non-blank rule, same as identity)', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm', reasoningEffort: '   ' }] }
    });
    expect(parsed?.endpoints?.[0].reasoningEffort).toBeUndefined();
  });

  it('keeps only strictly-positive finite weights, dropping zero and negatives', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          { provider: 'a', model: 'm', weight: 0 },
          { provider: 'b', model: 'm', weight: -1 },
          { provider: 'c', model: 'm', weight: 0.5 }
        ]
      }
    });
    expect(parsed?.endpoints).toEqual([
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
      { provider: 'c', model: 'm', weight: 0.5 }
    ]);
  });

  it('keeps only finite numeric quarantine timestamps', () => {
    expect(
      parseConfigDocument({ 'subagents-orchestrator': { quarantines: { a: 1, b: 'x', c: 2 } } })?.quarantines
    ).toEqual({ a: 1, c: 2 });
  });

  it('drops a non-object quarantines block entirely (array/string/null)', () => {
    expect(parseConfigDocument({ 'subagents-orchestrator': { quarantines: [1, 2] } })?.quarantines).toBeUndefined();
    expect(parseConfigDocument({ 'subagents-orchestrator': { quarantines: 'x' } })?.quarantines).toBeUndefined();
    expect(parseConfigDocument({ 'subagents-orchestrator': { quarantines: null } })?.quarantines).toBeUndefined();
  });
});

describe('R9: test-injection isolation', () => {
  it('resetConfigForTest re-enables disk reads after an injection', () => {
    setConfigForTest({ enabled: true, strategy: 'weighted', endpoints: [{ provider: 'x', model: 'y' }] });
    expect(getConfig()?.strategy).toBe('weighted');

    fs.writeFileSync(testFile, poolYaml('random', 1), 'utf8');
    resetConfigForTest(testFile);
    initWatcher(testFile);

    expect(getConfig()?.strategy).toBe('random');
    expect(getCachedEndpoints()).toHaveLength(1);
  });

  it('a disk reload never overwrites an injected config, even after initWatcher', async () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    const injected: OrchestratorConfig = { enabled: true, strategy: 'weighted', endpoints: [{ provider: 'i', model: 'm' }] };
    setConfigForTest(injected);
    initWatcher(testFile);

    fs.writeFileSync(testFile, poolYaml('random', 4), 'utf8');
    await sleep(WATCH_DEBOUNCE_MS + 200);

    expect(getConfig()).toBe(injected);
    expect(getCachedEndpoints()).toEqual([{ provider: 'i', model: 'm' }]);
  });
});

describe('R10: unknown-key handling', () => {
  it('keeps only documented section fields and drops unknown ones', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        enabled: true,
        strategy: 'random',
        bogus: 'x',
        endpoint: 'singular',
        nested: { deep: true }
      },
      other: { ignored: true }
    });
    expect(parsed).toEqual({ enabled: true, strategy: 'random' });
  });

  it('ignores extra top-level sections entirely', () => {
    expect(parseConfigDocument({ 'subagents-orchestrator-extra': { enabled: true } })).toBeNull();
  });
});

describe('R11: enabled / mode / ui interaction', () => {
  it('parses mode, ui and endpoints even when the section is disabled', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        enabled: false,
        mode: 'fallback',
        ui: { toasts: true },
        endpoints: [{ provider: 'p', model: 'm' }],
        fallback: [{ provider: 'r', model: 'm' }]
      }
    });
    // Parsing is independent of the enabled gate; the runtime decides.
    expect(parsed?.enabled).toBe(false);
    expect(parsed?.mode).toBe('fallback');
    expect(parsed?.ui).toEqual({ toasts: true });
    expect(parsed?.endpoints).toHaveLength(1);
    expect(parsed?.fallback).toHaveLength(1);
  });

  it('still resolves the effective mode from a disabled fallback config', () => {
    setConfigForTest({
      enabled: false,
      mode: 'fallback',
      fallback: [{ provider: 'r', model: 'm' }]
    });
    // enabled is a runtime gate, not a cache-shape gate.
    expect(getCachedMode()).toBe('fallback');
    expect(getCachedFallbackChain()).toHaveLength(1);
  });
});

describe('R12: parked vs default endpoint extraction', () => {
  it('treats an absent enabled flag and enabled: true identically (both routed)', () => {
    expect(
      extractEndpoints({
        endpoints: [
          { provider: 'a', model: 'm' },
          { provider: 'b', model: 'm', enabled: true }
        ]
      }).map((e) => e.provider)
    ).toEqual(['a', 'b']);
  });

  it('excludes only enabled: false, never a truthy non-boolean at extraction time', () => {
    // Injection bypasses the schema, so extraction must not treat 'false' as parked.
    expect(
      extractEndpoints({
        endpoints: [{ provider: 'a', model: 'm', enabled: 'false' as unknown as boolean }]
      }).map((e) => e.provider)
    ).toEqual(['a']);
  });
});

describe('R13: reloadConfig snapshot-retention precision', () => {
  it('retains the snapshot only when the directory is gone, not merely the file', () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 2), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    // File gone, directory alive -> honest clear.
    fs.unlinkSync(testFile);
    reloadConfig();
    expect(getConfig()).toBeNull();
    expect(getCachedEndpoints()).toEqual([]);
  });

  it('does not invent retention when there is no cached snapshot', () => {
    // Directory never existed and no snapshot was ever loaded.
    const goneDir = path.join(testDir, 'never');
    resetConfigForTest(path.join(goneDir, 'settings.yaml'));
    reloadConfig();
    expect(getConfig()).toBeNull();
    expect(getCachedEndpoints()).toEqual([]);
    expect(getCachedMode()).toBe('pool');
  });

  it('retains the last snapshot when the whole directory disappears', () => {
    fs.writeFileSync(testFile, poolYaml('weighted', 3), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('weighted');

    fs.rmSync(testDir, { recursive: true, force: true });
    reloadConfig();

    expect(getConfig()?.strategy).toBe('weighted');
    expect(getCachedEndpoints()).toHaveLength(3);
  });
});

describe('R14: injection short-circuits every disk path', () => {
  it('reloadConfig and scheduleReload never touch the disk under injection', async () => {
    const injected: OrchestratorConfig = { enabled: true, strategy: 'weighted', endpoints: [{ provider: 'i', model: 'm' }] };
    setConfigForTest(injected);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const existsSpy = vi.spyOn(fs, 'existsSync');
    try {
      reloadConfig();
      // initWatcher on an existing file must still be a no-op for the cache.
      fs.writeFileSync(testFile, poolYaml('random', 5), 'utf8');
      initWatcher(testFile);
      await sleep(WATCH_DEBOUNCE_MS + 150);

      expect(getConfig()).toBe(injected);
      expect(readSpy).not.toHaveBeenCalled();
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      existsSpy.mockRestore();
    }
  });
});

describe('R16: reloadConfig never touches breaker health (direct pin)', () => {
  it('a reload over a quarantine-bearing file calls applyQuarantines zero times', () => {
    const trip = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': trip }), 'utf8');
    initWatcher(testFile);

    const spy = vi.spyOn(defaultCircuitBreaker, 'applyQuarantines');
    try {
      // The file's quarantine block changes and a reload runs.
      fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': trip, 'p2::m2': trip }), 'utf8');
      reloadConfig();
      reloadConfig();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('R17: list-shape parse strictness', () => {
  it('drops non-array endpoints/fallback values instead of coercing', () => {
    expect(parseConfigDocument({ 'subagents-orchestrator': { endpoints: { provider: 'p', model: 'm' } } })).toEqual({});
    expect(parseConfigDocument({ 'subagents-orchestrator': { endpoints: 'p:m' } })).toEqual({});
    expect(parseConfigDocument({ 'subagents-orchestrator': { fallback: { provider: 'r', model: 'm' } } })).toEqual({});
  });

  it('omits an empty fallback list, so mode: fallback degrades to pool', () => {
    const parsed = parseConfigDocument({ 'subagents-orchestrator': { mode: 'fallback', fallback: [] } });
    expect(parsed?.fallback).toBeUndefined();
    expect(parsed?.mode).toBe('fallback'); // the request is kept; the runtime degrades
  });

  it('omits a fallback list whose every entry is invalid', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { mode: 'fallback', fallback: [{ provider: '', model: '' }, 'x', 3] }
    });
    expect(parsed?.fallback).toBeUndefined();
  });
});

describe('R18: numeric fields are type-checked but not range-clamped by the schema', () => {
  it('keeps negative numbers (clamping is the runtime\'s job)', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { cooldownMs: -5, maxFailures: -1, maxRetries: -3, totalSubagents: -2 }
    });
    expect(parsed).toEqual({ cooldownMs: -5, maxFailures: -1, maxRetries: -3, totalSubagents: -2 });
  });

  it('drops a non-finite endpoint weight', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          { provider: 'a', model: 'm', weight: Number.POSITIVE_INFINITY },
          { provider: 'b', model: 'm', weight: Number.NaN }
        ]
      }
    });
    expect(parsed?.endpoints).toEqual([
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' }
    ]);
  });
});

describe('R19: parseConfigFile trust-boundary robustness', () => {
  it('degrades to null when the path is a directory instead of throwing', () => {
    expect(() => parseConfigFile(testDir)).not.toThrow();
    expect(parseConfigFile(testDir)).toBeNull();
  });

  it('degrades to null for an empty file and for a null section', () => {
    fs.writeFileSync(testFile, '', 'utf8');
    expect(parseConfigFile(testFile)).toBeNull();
    fs.writeFileSync(testFile, 'subagents-orchestrator:\n', 'utf8');
    expect(parseConfigFile(testFile)).toBeNull();
  });
});

describe('R20: blank reasoningEffort must not reach a routed request', () => {
  it('drops a whitespace-only effort at the file trust boundary', () => {
    fs.writeFileSync(
      testFile,
      linesOf(
        'subagents-orchestrator:',
        '  enabled: true',
        '  endpoints:',
        '    - provider: p1',
        '      model: m1',
        '      reasoningEffort: "   "'
      ),
      'utf8'
    );
    initWatcher(testFile);
    const [ep] = getCachedEndpoints();
    expect(ep).toEqual({ provider: 'p1', model: 'm1' });
    expect(ep.reasoningEffort).toBeUndefined();
  });
});

describe('R15: debounce filename-filter precision', () => {
  it('ignores a similarly-named sibling file', async () => {
    fs.writeFileSync(testFile, poolYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      fs.writeFileSync(path.join(testDir, 'settings.yaml.bak'), poolYaml('random', 2), 'utf8');
      await sleep(WATCH_DEBOUNCE_MS + 250);
      expect(readSpy).not.toHaveBeenCalled();
      expect(getConfig()?.strategy).toBe('round-robin');
    } finally {
      readSpy.mockRestore();
    }
  });
});
