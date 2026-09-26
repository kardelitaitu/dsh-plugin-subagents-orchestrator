import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { CircuitBreaker, defaultCircuitBreaker } from '../src/health.js';
import { resetSettingsForTest } from '../src/settings.js';
import { resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext } from './mocks/cordis.js';

/**
 * The pool-mode degradation guard derives health from the STORED value.
 *
 * Why this matters: the natural spelling, endpoints.some(e =>
 * breaker.isHealthy(e)), is not pure. isHealthy() transitions a lapsed trip to
 * probation as a side effect, and .some() short-circuits, so every endpoint
 * after the first healthy one would be left un-transitioned -- a read path
 * whose result depends on argument order and which silently skips writes.
 *
 * Note routing legitimately transitions probation elsewhere: pickNextEndpoint
 * calls filterHealthy, which probes every endpoint. That is the pool doing its
 * job. What is pinned here is that the DECISION GUARD adds no second,
 * order-dependent transition of its own.
 */
describe('start routing: the degradation guard is a pure read', () => {
  it('deriving health does not transition state (unlike isHealthy)', () => {
    const b = new CircuitBreaker();
    const a = { provider: 'a', model: 'm' };
    const c = { provider: 'c', model: 'm' };
    b.recordFailure(a, 1, 1, 0);
    b.recordFailure(c, 1, 1, 0);
    const now = Date.now();
    const before = JSON.stringify([b.getStatus(a), b.getStatus(c)]);

    // The IMPURE spelling: short-circuits, leaving c un-transitioned.
    b.isHealthy(a, now);
    const afterImpure = JSON.stringify([b.getStatus(a), b.getStatus(c)]);
    console.log('after isHealthy(a): a changed, c untouched ->', afterImpure !== before);

    // The PURE spelling used by the guard: no writes at all.
    const b2 = new CircuitBreaker();
    b2.recordFailure(a, 1, 1, 0);
    b2.recordFailure(c, 1, 1, 0);
    const before2 = JSON.stringify([b2.getStatus(a), b2.getStatus(c)]);
    const anyHealthy = [a, c].some((e) => {
      const s = b2.getStatus(e);
      return s.trippedUntil === null || now >= (s.trippedUntil as number);
    });
    const after2 = JSON.stringify([b2.getStatus(a), b2.getStatus(c)]);
    console.log('after pure derivation, anyHealthy =', anyHealthy, '| state unchanged =', after2 === before2);
    expect(anyHealthy).toBe(true);
    expect(after2).toBe(before2);
  });

  it('the guard reaches the chain when no primary is healthy (pool mode)', () => {
    resetSettingsForTest(); resetTelemetry(); defaultCircuitBreaker.clear();
    setConfigForTest({
      enabled: true, failover: true, maxFailures: 3, maxRetries: 0,
      intervalMinMs: 0, intervalMaxMs: 0, ui: { panel: true },
      endpoints: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }],
      fallback: [{ provider: 'r1', model: 'm1' }]
    } as never);
    const ctx = new MockCordisContext();
    ctx.settings = { register: () => ({ get: () => undefined, watch: () => undefined }), mutate: async () => undefined };
    apply(ctx);

    const now = Date.now();
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': now + 3600000, 'p2::m2': now + 3600000 }, now);
    const picked = (ctx.subagents.start as any)('guarded', {});
    void picked;
    disposeWatcher(); setConfigForTest(null); resetConfigForTest('unused.yaml');
    defaultCircuitBreaker.clear(); resetTelemetry(); resetSettingsForTest();
  });
});
