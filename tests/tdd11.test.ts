import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, FAILOVER_TRIGGER_CODES } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 11: the failover trigger gate.
 *
 * FAILOVER_TRIGGER_CODES is the exported contract deciding which failure
 * codes the orchestrator handles at all. These probes pin both directions:
 * unlisted codes are untouched host business, and every listed code is
 * actually handled (so the array can never silently drift from behavior).
 */
describe('TDD round 11: failover trigger gate', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  it('PROBE 1: an unlisted failure code defers with zero side effects', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 0 });
    apply(ctx);

    const subagent = createMockAgent('tdd11-gate', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'CANCELLED_BY_HOST' }, turn: 1, step: 1 },
      () => 'host'
    );

    expect(decision).toBe('host');
    expect(getRecentEvents().filter((e) => e.type === 'failure')).toEqual([]);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(0);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.failures ?? 0).toBe(0);
  });

  it('PROBE 2: every exported trigger code is actually handled by the runtime', async () => {
    // One apply: the plugin's closure state is keyed by unique agent ids, so
    // codes cannot interfere; only telemetry and the breaker are reset.
    setConfigForTest({ ...baseConfig, maxRetries: 0 });
    apply(ctx);

    for (const code of FAILOVER_TRIGGER_CODES) {
      resetTelemetry();
      defaultCircuitBreaker.clear();

      const subagent = createMockAgent(`tdd11-${code}`, 'subagent');
      await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      const decision = await ctx.emit(
        'agent/request-error',
        { agent: subagent, failure: { code }, turn: 1, step: 1 },
        () => 'host'
      );

      // Handled means: the plugin made a decision (retry command) and
      // recorded the failure - never a silent pass-through.
      expect(decision, `${code} must produce a retry decision`).toEqual({ kind: 'retry' });
      const failureEvents = getRecentEvents().filter((e) => e.type === 'failure');
      expect(failureEvents, `${code} must be recorded in telemetry`).toHaveLength(1);
    }
  });

  it('PROBE 3: RATE_LIMIT without any hint info degrades to transient semantics', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 3 });
    apply(ctx);

    const subagent = createMockAgent('tdd11-plain-rl', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host'
    );

    // No hint -> same-endpoint retry budget applies; no failover planned
    expect(decision).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(true);
  });

  it('PROBE 4: hygiene - the exported list is unique, uppercase, and non-empty', () => {
    expect(FAILOVER_TRIGGER_CODES.length).toBeGreaterThan(0);
    expect(new Set(FAILOVER_TRIGGER_CODES).size).toBe(FAILOVER_TRIGGER_CODES.length);
    for (const code of FAILOVER_TRIGGER_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
