import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { CircuitBreaker, defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 10: provider hints x circuit-breaker re-trip semantics.
 *
 * The provider's Retry-After instruction is a promise about WHEN the
 * endpoint returns. Re-trips during an open window must never make the
 * endpoint available EARLIER than that promise, while longer windows from
 * newer failures still extend it.
 */
describe('TDD round 10: hint windows and re-trip semantics', () => {
  let ctx: MockCordisContext;

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

  it('PROBE A: a providerRetryAfterMs hint trips and fails over through the plugin', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('tdd10-hint', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });

    const breaker = new CircuitBreaker();
    void breaker; // runtime uses defaultCircuitBreaker
    const status = defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' });
    const until = status.trippedUntil ?? 0;
    expect(until).toBeGreaterThanOrEqual(Date.now() + 59_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 61_000);

    expect(getRecentEvents().some((e) => e.type === 'failover' && e.to?.provider === 'p2')).toBe(true);
  });

  it('PROBE B: a longer hint from a newer failure extends the window', () => {
    const breaker = new CircuitBreaker();
    const ep = { provider: 'p1', model: 'm1' };
    const t0 = 1000;

    breaker.recordFailure(ep, 1, 60_000, t0);
    breaker.recordFailure(ep, 1, 120_000, t0 + 10_000);

    expect(breaker.isHealthy(ep, t0 + 129_999)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 130_000)).toBe(true);
  });

  it('PROBE C: a shorter plain-failure cooldown can never shrink a hint window', () => {
    const breaker = new CircuitBreaker();
    const ep = { provider: 'p1', model: 'm1' };
    const t0 = 1000;

    // The provider demands a 120s backoff
    breaker.recordFailure(ep, 1, 120_000, t0);

    // A degraded plain failure re-trips with only the 30s default cooldown:
    // the endpoint must NOT become available before the provider's window.
    breaker.recordFailure(ep, 3, 30_000, t0 + 10_000);

    expect(breaker.isHealthy(ep, t0 + 100_000)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 120_000)).toBe(true);
  });

  it('PROBE D: probation retains the streak and re-trips on the first failure', () => {
    const breaker = new CircuitBreaker();
    const ep = { provider: 'p1', model: 'm1' };
    const t0 = 1000;

    breaker.recordFailure(ep, 3, 1000, t0);
    breaker.recordFailure(ep, 3, 1000, t0 + 100);
    breaker.recordFailure(ep, 3, 1000, t0 + 200); // tripped until t0 + 1200

    // Cooldown elapses: probation, streak retained (3)
    expect(breaker.isHealthy(ep, t0 + 1200)).toBe(true);
    expect(breaker.getStatus(ep).consecutiveFailures).toBe(3);

    // A single probation failure re-trips on the spot
    const retripped = breaker.recordFailure(ep, 3, 1000, t0 + 1300);
    expect(retripped).toBe(true);
    expect(breaker.isHealthy(ep, t0 + 2299)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 2300)).toBe(true);
  });

  it('PROBE E: a success during or after cooldown fully resets the breaker', () => {
    const breaker = new CircuitBreaker();
    const ep = { provider: 'p1', model: 'm1' };
    const t0 = 1000;

    breaker.recordFailure(ep, 1, 5000, t0); // hint-style trip
    breaker.recordSuccess(ep, t0 + 1000);

    expect(breaker.isHealthy(ep, t0 + 1000)).toBe(true);
    expect(breaker.getStatus(ep).consecutiveFailures).toBe(0);

    // Back to a full streak budget: one failure must NOT trip
    const tripped = breaker.recordFailure(ep, 3, 1000, t0 + 2000);
    expect(tripped).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 2000)).toBe(true);
  });
});
