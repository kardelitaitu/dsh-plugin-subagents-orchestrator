import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker, computeHourlyAlignedCooldown } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { persistQuarantines, resetSettingsForTest } from '../src/settings.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 29: Prone-area stress testing & boundary verification.
 *
 * Covers:
 * - Failover routing skipping quarantined endpoints.
 * - Consecutive failure thresholds for RATE_LIMIT vs instant account tripping.
 * - Turn success streak clearing.
 * - Root session non-interference while maintaining health observability.
 * - Settings persistence failure resilience.
 * - Degraded fallback when the entire pool is quarantined.
 * - Hourly alignment boundary conditions.
 */
describe('TDD round 29: Prone-area stress testing & boundary verification', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    maxFailures: 3,
    maxRetries: 0, // trip failover immediately on exhaustion for testing
    intervalMinMs: 0,
    intervalMaxMs: 0,
    ui: { panel: true },
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' }
    ]
  };

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    resetSettingsForTest();
  });

  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
    vi.restoreAllMocks();
  });

  it('PROBE 1: failover bypasses quarantined endpoints and chooses the next healthy candidate', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    // Quarantine p2::m2 manually
    const future = Date.now() + 3600000;
    defaultCircuitBreaker.applyQuarantines({ 'p2::m2': future });
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(false);

    const subagent = createMockAgent('subagent-probe1', 'subagent');

    // Initial request routes to p1::m1
    await ctx.emit('agent/request', { agent: subagent }, () => ({
      provider: 'p1',
      model: 'm1'
    }));

    // p1::m1 fails with SERVER error (failover trigger)
    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );

    // The plugin tells the host to retry the request
    expect(decision).toEqual({ kind: 'retry' });

    // The retried request must be rewritten to p3::m3, completely bypassing the quarantined p2::m2!
    const retriedSeed = await ctx.emit(
      'agent/request',
      { agent: subagent, turn: 1, step: 1 },
      () => ({ provider: 'p1', model: 'm1' })
    );

    expect(retriedSeed.provider).toBe('p3');
    expect(retriedSeed.model).toBe('m3');
  });

  it('PROBE 2: consecutive RATE_LIMIT failures accumulate and trip circuit breaker at maxFailures', async () => {
    // maxRetries: 5 so same-endpoint retry applies before failover
    setConfigForTest({ ...baseConfig, maxFailures: 3, maxRetries: 5 });
    apply(ctx);

    const subagent = createMockAgent('subagent-probe2', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({
      provider: 'p1',
      model: 'm1'
    }));

    // Failure 1: transient, breaker healthy
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // Failure 2: breaker still healthy
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);

    // Failure 3: reaches maxFailures (3) -> breaker trips!
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // Quarantines contains p1::m1
    const quarantines = defaultCircuitBreaker.getQuarantines();
    expect(quarantines['p1::m1']).toBeGreaterThan(Date.now());
  });

  it('PROBE 3: turn success clears failure count preventing false tripping on intermittent errors', async () => {
    setConfigForTest({ ...baseConfig, maxFailures: 3, maxRetries: 5 });
    apply(ctx);

    const subagent = createMockAgent('subagent-probe3', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({
      provider: 'p1',
      model: 'm1'
    }));

    // 2 consecutive failures
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 }, () => 'host');
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 }, () => 'host');
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(2);

    // Turn succeeds!
    await ctx.emit('agent/turn-stopping', { agent: subagent }, () => null);

    // Streak must be reset to 0
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(0);

    // Another failure afterwards is only failure #1, breaker stays healthy
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 2, step: 1 }, () => 'host');
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(1);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
  });

  it('PROBE 4: root non-subagent errors record health and persist quarantines without hijacking host routing', async () => {
    let persistedQuarantines: any = null;
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async (ns: string, ops: any[]) => {
        persistedQuarantines = ops[0].value;
      }
    };
    setConfigForTest(baseConfig);
    apply(ctx);

    const rootAgent = createMockAgent('root-session-4', 'user');

    // Root request seed
    await ctx.emit('agent/request', { agent: rootAgent }, () => ({
      provider: 'p1',
      model: 'm1'
    }));

    // Account failure (QUOTA) on root agent
    const action = await ctx.emit(
      'agent/request-error',
      { agent: rootAgent, failure: { code: 'QUOTA' }, turn: 1, step: 1 },
      () => 'host-unhandled'
    );

    // Must return next() result verbatim, never hijacking root execution
    expect(action).toBe('host-unhandled');

    // But breaker recorded the failure and quarantined p1
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // And persisted quarantines to host settings
    expect(persistedQuarantines).toBeDefined();
    expect(persistedQuarantines['p1::m1']).toBeGreaterThan(Date.now());
  });

  it('PROBE 5: resilient settings persistence survives thrown errors and missing settings service', async () => {
    // Case A: mutate throws
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async () => {
        throw new Error('DISK_WRITE_LOCK');
      }
    };
    setConfigForTest(baseConfig);
    apply(ctx);

    // Calling persistQuarantines must catch and swallow, never throwing
    await expect(persistQuarantines({ 'p1::m1': Date.now() + 1000 })).resolves.toBeUndefined();

    // Case B: settings service absent completely
    resetSettingsForTest();
    await expect(persistQuarantines({ 'p1::m1': Date.now() + 1000 })).resolves.toBeUndefined();
  });

  it('PROBE 6: degraded pool fallback when all endpoints are tripped', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    // Trip all 3 endpoints
    const now = Date.now();
    defaultCircuitBreaker.applyQuarantines({
      'p1::m1': now + 3600000,
      'p2::m2': now + 3600000,
      'p3::m3': now + 3600000
    });

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p2', model: 'm2' })).toBe(false);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p3', model: 'm3' })).toBe(false);

    // Subagent request delegation must still receive a routed endpoint (degraded attempt) rather than undefined
    const res: any = await ctx.subagents.start('degraded-subagent', {});
    expect(res.request.agentOptions).toBeDefined();
    expect(['p1', 'p2', 'p3']).toContain(res.request.agentOptions.provider);
  });

  it('PROBE 7: computeHourlyAlignedCooldown boundary calculations', () => {
    // Case 1: At 14:05:00 UTC (now) -> target is 15:01:00 UTC (56 mins)
    const t1 = new Date('2026-09-23T14:05:00.000Z').getTime();
    const cd1 = computeHourlyAlignedCooldown(t1);
    const target1 = new Date(t1 + cd1);
    expect(target1.getUTCMinutes()).toBe(1);
    expect(target1.getUTCSeconds()).toBe(0);
    expect(cd1).toBe(56 * 60 * 1000);

    // Case 2: At 14:59:00 UTC (only 2 mins before 15:01:00) -> violates minMs (5m)
    // so it rolls over to the next hour: 16:01:00 UTC!
    const t2 = new Date('2026-09-23T14:59:00.000Z').getTime();
    const cd2 = computeHourlyAlignedCooldown(t2);
    const target2 = new Date(t2 + cd2);
    expect(target2.getUTCMinutes()).toBe(1);
    expect(target2.getUTCSeconds()).toBe(0);
    expect(target2.getUTCHours()).toBe(16);
    expect(cd2).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('PROBE 8: CodeBuddy 6004 frequency limit parses exact reset timestamp and trips immediately (model-specific)', async () => {
    const fixedNow = new Date('2026-09-23T10:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    setConfigForTest({
      ...baseConfig,
      maxFailures: 5,
      endpoints: [
        { provider: 'buddy-1', model: 'deepseek-v4.1-flash' },
        { provider: 'buddy-1', model: 'hy4-preview' },
        { provider: 'buddy-2', model: 'deepseek-v4.1-flash' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('subagent-probe8', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({
      provider: 'buddy-1',
      model: 'deepseek-v4.1-flash'
    }));

    const rawError =
      'CodeBuddy API error: 429 - {"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-09-24 05:17:08 UTC+8, alternatively, you can switch to the other models to continue using it.","requestId":"f56dba950dc64f88a126cb3d7bdb6039"}';

    // Failure #1 with 6004 frequency limit
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT', message: rawError }, turn: 1, step: 1 },
      () => 'host'
    );

    // Breaker MUST trip immediately on failure 1 (not waiting for maxFailures: 5)
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-1', model: 'deepseek-v4.1-flash' })).toBe(false);

    // Exact reset timestamp: 2026-09-24 05:17:08 UTC+8 -> 2026-09-23 21:17:08 UTC
    const expectedResetMs = new Date('2026-09-24T05:17:08+08:00').getTime();
    const quarantines = defaultCircuitBreaker.getQuarantines();
    expect(quarantines['buddy-1::deepseek-v4.1-flash']).toBe(expectedResetMs);

    // Crucially: model-specific, NOT account-wide.
    // The other model on buddy-1 (hy4-preview) MUST remain healthy!
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-1', model: 'hy4-preview' })).toBe(true);
  });

  it('PROBE 9: Account-level rate limit trips all models for that provider account immediately', async () => {
    setConfigForTest({
      ...baseConfig,
      maxFailures: 5,
      endpoints: [
        { provider: 'buddy-1', model: 'deepseek-v4.1-flash' },
        { provider: 'buddy-1', model: 'hy4-preview' },
        { provider: 'buddy-2', model: 'deepseek-v4.1-flash' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('subagent-probe9', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({
      provider: 'buddy-1',
      model: 'deepseek-v4.1-flash'
    }));

    const rawError = 'CodeBuddy API error: 429 - {"detail":"CodeBuddy API rate limit exceeded"}';

    // Failure #1 with account-level rate limit
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT', message: rawError }, turn: 1, step: 1 },
      () => 'host'
    );

    // BOTH models on buddy-1 must be tripped immediately!
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-1', model: 'deepseek-v4.1-flash' })).toBe(false);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-1', model: 'hy4-preview' })).toBe(false);

    // buddy-2 should remain healthy
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-2', model: 'deepseek-v4.1-flash' })).toBe(true);
  });
});

