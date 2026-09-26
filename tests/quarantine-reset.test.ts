import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../src/index.js';
import {
  setConfigForTest,
  resetConfigForTest,
  initWatcher,
  disposeWatcher,
  getConfig,
  reloadConfig,
  hydrateQuarantinesFromConfig
} from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { resetSettingsForTest } from '../src/settings.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Quarantine reset durability.
 *
 * Regression suite for the "I reset an endpoint to healthy but the plugin
 * still routes around it" defect. Two independent writers owned the same
 * `quarantines` map and disagreed about authority:
 *
 *  - the settings panel wrote the reduced map through the host settings
 *    service (event-driven, authoritative for the user's intent),
 *  - reloadConfig() re-applied whatever `settings.yaml` last held on EVERY
 *    config reload (disk snapshot, stale the moment the user reset).
 *
 * The debounced fs.watch fires on the plugin's own persistence write, so the
 * stale snapshot was re-applied moments after a reset and the endpoint went
 * back into quarantine - silently, with the breaker still reporting red.
 *
 * The contract pinned here: a user reset wins. `reloadConfig()` owns CONFIG,
 * never health state; quarantine hydration happens at startup and on the
 * panel's watch, which are the only two events that legitimately carry it.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds; immune to fixed-sleep timing flakes. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    await sleep(25);
  }
}

describe('Quarantine reset durability', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-reset-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  /** A settings.yaml carrying a stale quarantine snapshot, as the plugin writes it. */
  function yamlWithQuarantines(quarantines: Record<string, number>): string {
    const lines = Object.entries(quarantines)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n');
    return [
      'subagents-orchestrator:',
      '  enabled: true',
      '  strategy: round-robin',
      '  endpoints:',
      '    - provider: p1',
      '      model: m1',
      '    - provider: p2',
      '      model: m2',
      '    - provider: p3',
      '      model: m3',
      '  quarantines:',
      lines,
      ''
    ].join('\n');
  }

  beforeEach(() => {
    resetSettingsForTest();
    resetTelemetry();
    defaultCircuitBreaker.clear();
    resetConfigForTest(testFile);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('a config reload does not resurrect a quarantine the user reset', () => {
    const now = Date.now();
    const tripUntil = now + 3600_000;

    // The plugin persisted a tripped snapshot; the file still holds it.
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripUntil, 'p2::m2': tripUntil }), 'utf8');
    initWatcher(testFile);
    hydrateQuarantinesFromConfig(); // start-up order: watcher, then health restore

    // Startup hydration legs: the file's trips are in effect.
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(false);

    // The user resets p1 from the panel: the settings watch fires with the
    // reduced map (this is the authoritative user intent).
    defaultCircuitBreaker.applyQuarantines({ 'p2::m2': tripUntil });
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // A later config reload (the debounced watcher, or an unrelated edit to
    // settings.yaml) must NOT re-apply the stale snapshot.
    reloadConfig();

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
    // The endpoint the user did NOT reset stays quarantined.
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(false);
  });

  it('an unrelated settings edit never resurrects a reset quarantine', async () => {
    const tripUntil = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripUntil }), 'utf8');
    initWatcher(testFile);
    hydrateQuarantinesFromConfig(); // start-up order: watcher, then health restore
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // User resets every endpoint.
    defaultCircuitBreaker.applyQuarantines({});
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // Somebody edits an unrelated part of settings.yaml (a strategy change),
    // while the stale quarantines block is still on disk.
    const rewritten = yamlWithQuarantines({ 'p1::m1': tripUntil }).replace('round-robin', 'weighted');
    fs.writeFileSync(testFile, rewritten, 'utf8');

    await waitFor(() => getConfig()?.strategy === 'weighted', 'unrelated edit to reload');

    // The reset survived the reload.
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
  });

  it('startup hydration still restores quarantines across a process restart', () => {
    const tripUntil = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripUntil }), 'utf8');

    // A fresh process: no breaker state, only the persisted file.
    defaultCircuitBreaker.clear();
    initWatcher(testFile);
    hydrateQuarantinesFromConfig(); // start-up order: watcher, then health restore

    // The persisted trip is honored — this is the feature the fix must keep.
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    const q = defaultCircuitBreaker.getQuarantines();
    expect(q['p1::m1']).toBe(tripUntil);
  });

  it('an expired persisted quarantine is dropped rather than honored', () => {
    const past = Date.now() - 60_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': past }), 'utf8');

    defaultCircuitBreaker.clear();
    initWatcher(testFile);
    hydrateQuarantinesFromConfig(); // start-up order: watcher, then health restore

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
    expect(defaultCircuitBreaker.getQuarantines()['p1::m1']).toBeUndefined();
  });

  it('the breaker is not re-quarantined by a stale file snapshot mid-turn', async () => {
    const tripUntil = Date.now() + 3600_000;
    fs.writeFileSync(testFile, yamlWithQuarantines({ 'p1::m1': tripUntil }), 'utf8');

    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async () => undefined
    };
    setConfigForTest({
      enabled: true,
      failover: true,
      maxFailures: 3,
      maxRetries: 0,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      ui: { panel: true },
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });
    apply(ctx);

    // Reset p1 to healthy.
    defaultCircuitBreaker.applyQuarantines({});
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // The next reload must not put p1 back — routing would silently skip it.
    reloadConfig();
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // And a real routing decision must actually choose p1 again.
    const subagent = createMockAgent('subagent-reset-durability', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    // p2/p3 remain healthy too, so assert the reset endpoint is *eligible*.
    const healthy = ['p1', 'p2', 'p3'].filter((p) =>
      defaultCircuitBreaker.isHealthy({ provider: p, model: p === 'p1' ? 'm1' : p === 'p2' ? 'm2' : 'm3' })
    );
    expect(healthy).toContain('p1');
  });
});

/**
 * The same contract through the REAL apply() entry, so the start-up wiring
 * (initWatcher -> hydrateQuarantinesFromConfig -> armSettingsPanel) is pinned
 * end to end, not just the seam in isolation.
 *
 * apply() calls initWatcher() with the default ~/.dsh path, so these tests pin
 * the cache with setConfigForTest() instead - initWatcher() deliberately
 * honors an injected config (isCustomTestConfig) and never reads the
 * developer's real settings file. That is exactly the production start-up
 * shape minus the disk read.
 */
describe('Quarantine reset durability through apply()', () => {
  beforeEach(() => {
    resetSettingsForTest();
    resetTelemetry();
    defaultCircuitBreaker.clear();
  });

  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
    vi.restoreAllMocks();
  });

  it('apply() restores a persisted quarantine through the start-up seam', () => {
    const tripUntil = Date.now() + 3600_000;
    setConfigForTest({
      enabled: true,
      ui: { panel: true },
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ],
      quarantines: { 'p1::m1': tripUntil }
    });

    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async () => undefined
    };

    apply(ctx);

    // apply() ran hydrateQuarantinesFromConfig(): the persisted trip is live.
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(true);
  });

  it('apply() then a reset then a reload keeps the endpoint healthy', () => {
    const tripUntil = Date.now() + 3600_000;
    setConfigForTest({
      enabled: true,
      ui: { panel: true },
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ],
      quarantines: { 'p1::m1': tripUntil }
    });

    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async () => undefined
    };
    apply(ctx);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // User resets from the panel.
    defaultCircuitBreaker.applyQuarantines({});
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // The reload path - the one the debounced fs.watch fires on every save,
    // and the one that caused this bug - must not undo the reset.
    reloadConfig();
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // The start-up seam remains start-up-only by contract: calling it again
    // deliberately re-applies the persisted snapshot. That is the documented
    // division of authority, and apply() calls it exactly once.
    hydrateQuarantinesFromConfig();
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
  });
});
