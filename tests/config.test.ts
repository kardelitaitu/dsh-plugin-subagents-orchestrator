import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseConfigFile,
  parseConfigDocument,
  extractEndpoints,
  initWatcher,
  disposeWatcher,
  getConfig,
  getCachedEndpoints,
  setConfigForTest,
  resetConfigForTest,
  WATCH_DEBOUNCE_MS
} from '../src/config.js';
import type { OrchestratorConfig } from '../src/types.js';

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

function makeYaml(strategy: string, endpointCount: number): string {
  const endpoints = Array.from(
    { length: endpointCount },
    (_, i) => `    - provider: p${i + 1}\n      model: m${i + 1}`
  ).join('\n');
  return `subagents-orchestrator:\n  enabled: true\n  strategy: ${strategy}\n  endpoints:\n${endpoints}\n`;
}

describe('Config Schema Parsing', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-schema-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    resetConfigForTest(testFile);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return null if file does not exist', () => {
    const config = parseConfigFile(path.join(testDir, 'nonexistent.yaml'));
    expect(config).toBeNull();
  });

  it('should parse valid yaml configuration', () => {
    fs.writeFileSync(
      testFile,
      `subagents-orchestrator:
  enabled: true
  strategy: round-robin
  failover: true
  endpoints:
    - provider: p1
      model: m1
    - provider: p2
      model: m2
`,
      'utf8'
    );
    const config = parseConfigFile(testFile);
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.strategy).toBe('round-robin');
    expect(config?.failover).toBe(true);
    expect(config?.endpoints).toHaveLength(2);
  });

  it('should return null for a file without a subagents-orchestrator section', () => {
    fs.writeFileSync(testFile, 'other-plugin:\n  enabled: true\n', 'utf8');
    expect(parseConfigFile(testFile)).toBeNull();
  });

  it('should return null for malformed yaml instead of throwing', () => {
    fs.writeFileSync(testFile, 'subagents-orchestrator: [unclosed\n  bad indent ::: {', 'utf8');
    expect(() => parseConfigFile(testFile)).not.toThrow();
    expect(parseConfigFile(testFile)).toBeNull();
  });

  it('should reject unknown strategy values but keep valid ones', () => {
    expect(parseConfigDocument({ 'subagents-orchestrator': { strategy: 'chaos' } })).toEqual({});
    expect(
      parseConfigDocument({ 'subagents-orchestrator': { strategy: 'weighted' } })?.strategy
    ).toBe('weighted');
  });

  it('should drop wrongly-typed scalar fields instead of coercing them', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        enabled: 'yes',
        failover: 1,
        strategy: 42,
        cooldownMs: '60000',
        maxFailures: true
      }
    });
    expect(parsed).toEqual({});
  });

  it('should keep correctly-typed scalar fields', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        enabled: false,
        failover: true,
        strategy: 'random',
        cooldownMs: 5000,
        maxFailures: 2
      }
    });
    expect(parsed).toEqual({
      enabled: false,
      failover: true,
      strategy: 'random',
      cooldownMs: 5000,
      maxFailures: 2
    });
  });

  it('should drop non-finite numeric fields (NaN/Infinity)', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        cooldownMs: Number.NaN,
        maxFailures: Number.POSITIVE_INFINITY
      }
    });
    expect(parsed).toEqual({});
  });

  it('should filter malformed endpoint entries but keep valid ones', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          { provider: 'p1', model: 'm1' },
          { provider: 'p2', model: '' },
          { provider: '', model: 'm3' },
          { provider: 42, model: 'm4' },
          { model: 'm5' },
          { provider: 'p6' },
          'not-an-object',
          7,
          null
        ]
      }
    });
    expect(parsed?.endpoints).toEqual([{ provider: 'p1', model: 'm1' }]);
  });

  it('should keep optional endpoint fields and drop unknown/wrongly-typed ones', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          {
            provider: 'p1',
            model: 'm1',
            reasoningEffort: 'high',
            weight: 3,
            bogus: 'x',
            weight2: 'nope'
          }
        ]
      }
    });
    expect(parsed?.endpoints).toEqual([
      { provider: 'p1', model: 'm1', reasoningEffort: 'high', weight: 3 }
    ]);
  });

  it('should omit endpoints entirely when no entry survives filtering', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: '', model: '' }] }
    });
    expect(parsed).toEqual({});
  });

  it('should parse the ui block and drop unknown/wrongly-typed ui fields', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        ui: { toasts: true, panel: false, popups: 'yes', modal: 1 }
      }
    });
    expect(parsed?.ui).toEqual({ toasts: true, panel: false });

    // An empty ui block is a recognized opt-in anchor, kept as an object.
    expect(parseConfigDocument({ 'subagents-orchestrator': { ui: {} } })?.ui).toEqual({});

    // Wrongly-typed ui blocks are dropped, never coerced.
    expect(parseConfigDocument({ 'subagents-orchestrator': { ui: 'toasts' } })?.ui).toBeUndefined();
    expect(parseConfigDocument({ 'subagents-orchestrator': { ui: ['toasts'] } })?.ui).toBeUndefined();
    expect(parseConfigDocument({ 'subagents-orchestrator': { ui: null } })?.ui).toBeUndefined();
  });

  it('should return null for non-object yaml documents', () => {
    expect(parseConfigDocument(null)).toBeNull();
    expect(parseConfigDocument('a string')).toBeNull();
    expect(parseConfigDocument(42)).toBeNull();
    expect(parseConfigDocument(['a', 'list'])).toBeNull();
  });

  it('should extract only valid endpoints', () => {
    const endpoints = extractEndpoints({
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: '' } as any,
        { provider: '', model: 'm3' } as any,
        null as any
      ]
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({ provider: 'p1', model: 'm1' });
  });
});

describe('Zero-Disk-I/O In-Memory Cache', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-cache-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    resetConfigForTest(testFile);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should read the disk exactly once for repeated getConfig calls', () => {
    fs.writeFileSync(testFile, makeYaml('random', 1), 'utf8');

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const existsSpy = vi.spyOn(fs, 'existsSync');
    try {
      const first = getConfig(); // the one and only lazy load
      expect(first?.strategy).toBe('random');
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(existsSpy).toHaveBeenCalledTimes(1);

      // Every subsequent call is a pure memory read (same object identity).
      expect(getConfig()).toBe(first);
      expect(getConfig()).toBe(first);
      expect(getCachedEndpoints()).toBe(getCachedEndpoints()); // stable reference
      expect(getCachedEndpoints()).toHaveLength(1);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(existsSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
      existsSpy.mockRestore();
    }
  });

  it('should probe a missing settings file exactly once, never per call', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      // First call performs the single lazy probe (file absent -> null).
      expect(getConfig()).toBeNull();
      expect(existsSpy).toHaveBeenCalledTimes(1);
      expect(readSpy).not.toHaveBeenCalled();

      // Zero-disk-I/O: the null result is cached, no further probes ever.
      expect(getConfig()).toBeNull();
      expect(getCachedEndpoints()).toEqual([]);
      expect(existsSpy).toHaveBeenCalledTimes(1);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('should serve an injected config with zero disk I/O', () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const existsSpy = vi.spyOn(fs, 'existsSync');
    try {
      const injected: OrchestratorConfig = {
        enabled: true,
        strategy: 'weighted',
        endpoints: [{ provider: 'p1', model: 'm1', weight: 5 }]
      };
      setConfigForTest(injected);

      expect(getConfig()).toBe(injected);
      expect(getCachedEndpoints()).toEqual([{ provider: 'p1', model: 'm1', weight: 5 }]);
      expect(readSpy).not.toHaveBeenCalled();
      expect(existsSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      existsSpy.mockRestore();
    }
  });

  it('should hot-reload from the watcher without polling the disk on reads', async () => {
    fs.writeFileSync(testFile, makeYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);

    expect(getConfig()?.strategy).toBe('round-robin');
    expect(getCachedEndpoints()).toHaveLength(1);

    fs.writeFileSync(testFile, makeYaml('random', 2), 'utf8');

    // The only disk I/O after init is the debounced watcher reload itself.
    await waitFor(() => getConfig()?.strategy === 'random', 'debounced reload to apply');
    expect(getCachedEndpoints()).toHaveLength(2);
  });

  it('should degrade to a null config when the watched file becomes unparseable', async () => {
    fs.writeFileSync(testFile, makeYaml('weighted', 1), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('weighted');

    fs.writeFileSync(testFile, 'subagents-orchestrator: [broken', 'utf8');

    await waitFor(() => getConfig() === null, 'malformed config to clear the cache');
    expect(getCachedEndpoints()).toEqual([]);
  });

  it('should clear the cache when the watched file is deleted', async () => {
    fs.writeFileSync(testFile, makeYaml('round-robin', 1), 'utf8');
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    fs.unlinkSync(testFile);

    await waitFor(() => getConfig() === null, 'deletion to clear the cache');
    expect(getCachedEndpoints()).toEqual([]);
  });
});

describe('fs.watch Debounce', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-debounce-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    resetConfigForTest(testFile);
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, makeYaml('round-robin', 1), 'utf8');
  });

  afterEach(() => {
    disposeWatcher();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should coalesce a burst of writes into a single reload', async () => {
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      // Editor-style save burst: several writes inside one debounce window.
      fs.writeFileSync(testFile, makeYaml('random', 1), 'utf8');
      fs.writeFileSync(testFile, makeYaml('weighted', 2), 'utf8');
      fs.writeFileSync(testFile, makeYaml('random', 3), 'utf8');

      // Node timer ordering: this 50ms sleep always resolves before the
      // 100ms debounce deadline, so nothing can have been reloaded yet.
      await sleep(WATCH_DEBOUNCE_MS / 2);
      const readsBeforeReload = readSpy.mock.calls.length;
      expect(readsBeforeReload).toBe(0);

      await waitFor(
        () => readSpy.mock.calls.length > readsBeforeReload,
        'debounced reload to run'
      );
      const reloadReads = readSpy.mock.calls.length - readsBeforeReload;

      // Coalesced: one reload (tolerate a platform double-tick, but any
      // uncoalesced implementation would read once per write: >= 3).
      expect(reloadReads).toBeGreaterThan(0);
      expect(reloadReads).toBeLessThanOrEqual(2);
      expect(getConfig()?.strategy).toBe('random'); // last write wins
      expect(getCachedEndpoints()).toHaveLength(3);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('should ignore watcher events for unrelated files in the directory', async () => {
    initWatcher(testFile);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      fs.writeFileSync(path.join(testDir, 'unrelated.txt'), 'noise', 'utf8');

      await sleep(WATCH_DEBOUNCE_MS + 200);
      expect(readSpy).not.toHaveBeenCalled();
      expect(getConfig()?.strategy).toBe('round-robin');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('should not fire a pending debounce timer after disposeWatcher', async () => {
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');
    disposeWatcher();

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      fs.writeFileSync(testFile, makeYaml('random', 2), 'utf8');

      await sleep(WATCH_DEBOUNCE_MS + 200);
      expect(readSpy).not.toHaveBeenCalled(); // no watcher, no reload
      // Stale snapshot retained; no lazy re-probe on read either.
      expect(getConfig()?.strategy).toBe('round-robin');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('should survive the watched directory being deleted mid-watch', async () => {
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    // On Windows deleting the watched directory can make fs.watch emit an
    // 'error' event; the watcher must never crash the host process.
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Some platforms refuse to remove a directory with an open watch
      // handle; the assertions below still hold.
    }

    // The settings file AND its directory are gone: with the directory dead
    // the fs.watch handle can never re-arm, so nothing would ever refresh
    // the cache again - retention beats a permanent silent shutdown.
    await sleep(WATCH_DEBOUNCE_MS + 200);
    expect(getConfig()?.strategy).toBe('round-robin'); // last snapshot retained
    expect(getCachedEndpoints()).toHaveLength(1);

    // The watcher lifecycle stays intact after the error path.
    expect(() => disposeWatcher()).not.toThrow();
  });

  it('should clear the cache when only the file is deleted but the directory survives', async () => {
    initWatcher(testFile);
    expect(getConfig()?.strategy).toBe('round-robin');

    fs.unlinkSync(testFile);

    // A living directory means a future file (or recreate) can be watched:
    // the reload honestly reflects the missing file.
    await waitFor(() => getConfig() === null, 'deleted file to clear the cache');
    expect(getCachedEndpoints()).toEqual([]);
  });
});

describe('Test State Isolation', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-iso-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    resetConfigForTest(testFile);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should not leak an injected config into a fresh reset', () => {
    const injected: OrchestratorConfig = {
      enabled: true,
      strategy: 'random',
      endpoints: [{ provider: 'x', model: 'y' }]
    };
    setConfigForTest(injected);
    expect(getConfig()).toBe(injected);

    resetConfigForTest(testFile);
    expect(getConfig()).toBeNull();
    expect(getCachedEndpoints()).toEqual([]);
  });

  it('should serve an injected null without falling back to a disk read', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      // Guards plugin.test.ts afterEach(setConfigForTest(null)): injecting
      // null must pin the cache to null, never re-read the developer's real
      // ~/.dsh/settings.yaml.
      setConfigForTest(null);
      expect(getConfig()).toBeNull();
      expect(getCachedEndpoints()).toEqual([]);
      expect(existsSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('should keep injected null authoritative when initWatcher runs afterwards', () => {
    // Reproduces the real-settings leak: apply() calls initWatcher(), which
    // used to reset the path and read the developer's ~/.dsh/settings.yaml
    // right after a test injected null.
    setConfigForTest(null);
    initWatcher(testFile); // target dir does not exist, and must not be read

    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      expect(getConfig()).toBeNull();
      expect(getCachedEndpoints()).toEqual([]);
      expect(existsSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('should not clobber an injected config via a scheduled watcher reload', async () => {
    const injected: OrchestratorConfig = {
      enabled: true,
      strategy: 'weighted',
      endpoints: [{ provider: 'p1', model: 'm1' }]
    };
    setConfigForTest(injected);
    initWatcher(testFile); // previously started watching + scheduled a reload

    await sleep(WATCH_DEBOUNCE_MS + 150);

    expect(getConfig()).toBe(injected); // reload must not override the injection
  });
});
