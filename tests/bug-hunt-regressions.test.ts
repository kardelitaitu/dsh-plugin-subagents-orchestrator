import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import {
  setConfigForTest,
  resetConfigForTest,
  disposeWatcher,
  getConfig,
  getCachedFallbackChain,
  hydrateQuarantinesFromConfig,
  parseConfigDocument,
  extractEndpoints,
  extractFallbackChain
} from '../src/config.js';
import { CircuitBreaker, defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { resetSettingsForTest, getActiveSettingsService, disposeSettings } from '../src/settings.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Bug-hunt regression suite.
 *
 * Ten adversarial rounds over the failover/orchestration surface; six defects
 * were confirmed and fixed. Each test below pins the exact broken behavior, so
 * a regression fails loudly instead of silently mis-routing subagents.
 *
 * Fixed here:
 *  R1  syncQuarantines() mutated the live config object -> a later hydrate
 *      resurrected a quarantine the user had reset.
 *  R2  applyQuarantines() used Math.max(), making a cooldown a one-way
 *      ratchet: a shorter authoritative window was silently discarded.
 *  R5  failover stored a positional index, so editing the rescue chain
 *      relocated an in-flight retry onto a different endpoint.
 *  R6  root chat sessions consumed totalSubagents cap slots, pushing real
 *      subagents into unrouted pass-through.
 *  R9  the panel's sync effect / Refresh Health merged a lagging snapshot
 *      back into the draft, so Save re-persisted a cleared quarantine.
 *  R10 module-level settings handles survived dispose, so persistence wrote
 *      through a dead registration after a host reload.
 *
 * A second 50-round sweep over the same subsystems added:
 *  R04  whitespace-only provider/model passed the non-empty check and became
 *       an unroutable endpoint (fixed at BOTH config trust boundaries).
 *  R12b an in-cooldown failure re-anchored the window on `now`, so a
 *       degraded-but-probed endpoint never reached probation (capped).
 *
 * Probed and found correct: account-failure blast radius (parked endpoints
 * stay out), balancer fairness under a shrunken healthy pool, retry-budget
 * scoping across turns, and ratelimit hint parsing/classification.
 */

const baseConfig = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  failover: true,
  maxFailures: 3,
  maxRetries: 0,
  intervalMinMs: 0,
  intervalMaxMs: 0,
  ui: { panel: true },
  endpoints: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' }
  ],
  ...over
});

function ctxWithSettings() {
  const ctx = new MockCordisContext();
  ctx.settings = {
    register: () => ({ get: () => undefined, watch: () => undefined }),
    mutate: async () => undefined
  };
  return ctx;
}

describe('Bug hunt R1: config object is never used as a quarantine cache', () => {
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
  });

  it('a trip does not leak into getConfig().quarantines', async () => {
    const cfg = baseConfig();
    setConfigForTest(cfg as never);
    const ctx = ctxWithSettings();
    apply(ctx);

    const sub = createMockAgent('r1', 'subagent');
    await ctx.emit('agent/request', { agent: sub }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'QUOTA' }, turn: 1, step: 1 }, () => 'host');

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    // The live config object must stay pristine.
    expect(getConfig()?.quarantines).toBeUndefined();
  });

  it('re-hydrating after a reset does not resurrect the trip', async () => {
    setConfigForTest(baseConfig() as never);
    const ctx = ctxWithSettings();
    apply(ctx);

    const sub = createMockAgent('r1b', 'subagent');
    await ctx.emit('agent/request', { agent: sub }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'QUOTA' }, turn: 1, step: 1 }, () => 'host');

    defaultCircuitBreaker.applyQuarantines({});
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    hydrateQuarantinesFromConfig();
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
  });
});

describe('Bug hunt R2: applyQuarantines adopts the given window verbatim', () => {
  it('a shorter authoritative cooldown replaces a longer existing one', () => {
    const now = Date.now();
    const b = new CircuitBreaker();
    b.applyQuarantines({ 'p1::m1': now + 3600_000 }, now);
    b.applyQuarantines({ 'p1::m1': now + 60_000 }, now);

    expect(b.getStatus({ provider: 'p1', model: 'm1' }).trippedUntil).toBe(now + 60_000);
  });

  it('an expired window still clears the trip on the next snapshot', () => {
    const now = Date.now();
    const b = new CircuitBreaker();
    b.applyQuarantines({ 'p1::m1': now + 3600_000 }, now);
    b.applyQuarantines({ 'p1::m1': now - 1 }, now);
    expect(b.isHealthy({ provider: 'p1', model: 'm1' }, now)).toBe(true);
  });
});

describe('Bug hunt R5: failover target follows endpoint identity, not position', () => {
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
  });

  it('reordering the rescue chain does not relocate an in-flight retry', async () => {
    setConfigForTest(
      baseConfig({
        mode: 'fallback',
        endpoints: [{ provider: 'prim', model: 'm' }],
        fallback: [
          { provider: 'r1', model: 'm' },
          { provider: 'r2', model: 'm' }
        ]
      }) as never
    );
    const ctx = ctxWithSettings();
    apply(ctx);

    const now = Date.now();
    defaultCircuitBreaker.applyQuarantines({ 'prim::m': now + 3600_000 }, now);

    const sub = createMockAgent('r5', 'subagent');
    await ctx.emit('agent/request', { agent: sub }, () => ({ provider: 'prim', model: 'm' }));
    await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'QUOTA' }, turn: 1, step: 1 }, () => 'host');
    const s1 = await ctx.emit('agent/request', { agent: sub, turn: 1, step: 1 }, () => ({ provider: 'prim', model: 'm' }));
    expect(s1.provider).toBe('r1');

    // The chain is reordered under us (a live settings edit).
    getCachedFallbackChain().reverse();

    // The committed endpoint (r1) is now tripped; the walk must move by
    // identity to the sibling r2, never blindly reuse index 0 (now r2 by luck)
    // nor resurrect r1.
    defaultCircuitBreaker.applyQuarantines({ 'prim::m': now + 3600_000, 'r1::m': now + 3600_000 }, now);
    await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'QUOTA' }, turn: 2, step: 1 }, () => 'host');
    const s2 = await ctx.emit('agent/request', { agent: sub, turn: 2, step: 1 }, () => ({ provider: 'prim', model: 'm' }));
    expect(s2.provider).toBe('r2');
  });
});

describe('Bug hunt R6: root sessions do not consume subagent cap slots', () => {
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
  });

  it('two open root sessions do not starve subagent routing', async () => {
    setConfigForTest(baseConfig({ totalSubagents: 2 }) as never);
    const ctx = ctxWithSettings();
    apply(ctx);

    for (let i = 0; i < 2; i++) {
      const root = createMockAgent('root-' + i, 'user');
      await ctx.emit('agent/request', { agent: root }, () => ({ provider: 'p1', model: 'm1' }));
    }

    // Cap is 2; if root sessions counted, both starts below would pass through
    // unrouted (agentOptions undefined).
    const first = await ctx.subagents.start('r6-a', {});
    expect(first.request?.agentOptions).toBeDefined();
  });

  it('the cap still applies to real subagents', async () => {
    setConfigForTest(baseConfig({ totalSubagents: 2 }) as never);
    const ctx = ctxWithSettings();
    apply(ctx);

    // Two live subagents fill the cap (recorded at agent/request).
    for (let i = 0; i < 2; i++) {
      const sub = createMockAgent('caplive-' + i, 'subagent');
      await ctx.emit('agent/request', { agent: sub }, () => ({ provider: 'p1', model: 'm1' }));
    }

    const over = await ctx.subagents.start('r6-over', {});
    expect(over.request?.agentOptions).toBeUndefined();
  });
});

describe('Bug hunt R10: teardown releases module-level settings handles', () => {
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
  });

  it('dispose drops the active settings service', () => {
    setConfigForTest(baseConfig() as never);
    const ctx = ctxWithSettings();
    apply(ctx);
    expect(getActiveSettingsService()).not.toBeNull();

    ctx.dispose();
    expect(getActiveSettingsService()).toBeNull();
  });

  it('disposeSettings is idempotent', () => {
    expect(() => {
      disposeSettings();
      disposeSettings();
    }).not.toThrow();
  });

  it('the plugin still routes after a dispose/apply cycle', async () => {
    setConfigForTest(baseConfig() as never);

    const first = ctxWithSettings();
    apply(first);
    first.dispose();

    const second = ctxWithSettings();
    apply(second);
    const routed = await second.subagents.start('reapply', {});
    expect(routed.request?.agentOptions).toBeDefined();
  });
});

describe('Bug hunt R04: endpoint identity must be non-blank', () => {
  it('rejects whitespace-only provider or model at the schema boundary', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': {
        endpoints: [
          { provider: '   ', model: 'm' },
          { provider: 'p', model: '  ' },
          { provider: '\t', model: 'm' },
          { provider: 'ok', model: 'ok' }
        ]
      }
    });
    // Only the genuinely usable entry survives.
    expect(parsed?.endpoints).toEqual([{ provider: 'ok', model: 'ok' }]);
  });

  it('rejects whitespace-only entries at the pool-extraction boundary too', () => {
    const eps = extractEndpoints({
      endpoints: [
        { provider: '   ', model: 'm' },
        { provider: 'p', model: '  ' },
        { provider: 'ok', model: 'ok' }
      ]
    } as never);
    expect(eps).toEqual([{ provider: 'ok', model: 'ok' }]);
  });

  it('applies the same guard to the rescue chain', () => {
    const chain = extractFallbackChain({
      fallback: [
        { provider: ' ', model: 'm' },
        { provider: 'r', model: 'r' }
      ]
    } as never);
    expect(chain).toEqual([{ provider: 'r', model: 'r' }]);
  });
});

describe('Bug hunt R12b: probe traffic cannot postpone recovery forever', () => {
  it('caps the extension at twice the cooldown from the trip start', () => {
    const b = new CircuitBreaker();
    const start = 1000;
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, start);

    // Hammer with probes across what would be the whole unbounded window.
    for (let t = start; t <= start + 110000; t += 500) {
      b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, t);
    }
    const s = b.getStatus({ provider: 'p1', model: 'm1' });

    // Pre-fix the window tracked now+cooldown and never bound; now it is
    // capped, so it holds still and the endpoint's cooldown can elapse.
    expect(s.trippedUntil!).toBeLessThanOrEqual(start + 120000);
  });

  it('still never shrinks a longer committed window (extend-never-shrink holds)', () => {
    const b = new CircuitBreaker();
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, 1000); // until 61000
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 1000, 1010);  // shorter
    expect(b.getStatus({ provider: 'p1', model: 'm1' }).trippedUntil).toBe(61000);
  });

  it('a longer cooldown still extends within the ceiling', () => {
    const b = new CircuitBreaker();
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, 1000);
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, 50000);
    expect(b.getStatus({ provider: 'p1', model: 'm1' }).trippedUntil).toBe(110000);
  });

  it('clears the trip anchor on success so the next trip gets a fresh ceiling', () => {
    const b = new CircuitBreaker();
    b.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60000, 1000);
    b.recordSuccess({ provider: 'p1', model: 'm1' });
    expect(b.getStatus({ provider: 'p1', model: 'm1' }).trippedSince).toBeNull();
  });
});
