import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, computeHourlyAlignedCooldown } from '../src/health.js';
import type { Endpoint } from '../src/types.js';

describe('Circuit Breaker & Endpoint Health', () => {
  let breaker: CircuitBreaker;
  const ep1: Endpoint = { provider: 'p1', model: 'm1' };
  const ep2: Endpoint = { provider: 'p2', model: 'm2' };

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it('should initially consider all endpoints healthy', () => {
    expect(breaker.isHealthy(ep1)).toBe(true);
    expect(breaker.isHealthy(ep2)).toBe(true);
    expect(breaker.filterHealthy([ep1, ep2])).toEqual([ep1, ep2]);
  });

  it('should trip endpoint after reaching maxFailures', () => {
    const maxFailures = 3;
    const cooldownMs = 1000;
    const t0 = 10000;

    breaker.recordFailure(ep1, maxFailures, cooldownMs, t0);
    expect(breaker.isHealthy(ep1, t0)).toBe(true);

    breaker.recordFailure(ep1, maxFailures, cooldownMs, t0 + 100);
    expect(breaker.isHealthy(ep1, t0 + 100)).toBe(true);

    const tripped = breaker.recordFailure(ep1, maxFailures, cooldownMs, t0 + 200);
    expect(tripped).toBe(true);
    expect(breaker.isHealthy(ep1, t0 + 200)).toBe(false);

    // Only ep2 should be in healthy pool
    expect(breaker.filterHealthy([ep1, ep2], t0 + 200)).toEqual([ep2]);
  });

  it('should automatically recover endpoint when cooldown expires', () => {
    const t0 = 10000;
    breaker.recordFailure(ep1, 1, 500, t0);
    expect(breaker.isHealthy(ep1, t0)).toBe(false);

    // During cooldown
    expect(breaker.isHealthy(ep1, t0 + 499)).toBe(false);

    // After cooldown
    expect(breaker.isHealthy(ep1, t0 + 500)).toBe(true);
  });

  it('should reset failure counter on successful request', () => {
    breaker.recordFailure(ep1, 3, 1000);
    breaker.recordFailure(ep1, 3, 1000);
    breaker.recordSuccess(ep1);

    expect(breaker.getStatus(ep1).consecutiveFailures).toBe(0);
    expect(breaker.isHealthy(ep1)).toBe(true);
  });

  it('should fallback to all endpoints if all are tripped to prevent stall', () => {
    const t0 = 1000;
    breaker.recordFailure(ep1, 1, 10000, t0);
    breaker.recordFailure(ep2, 1, 10000, t0);

    expect(breaker.isHealthy(ep1, t0)).toBe(false);
    expect(breaker.isHealthy(ep2, t0)).toBe(false);

    // Degradation fallback
    const pool = breaker.filterHealthy([ep1, ep2], t0);
    expect(pool).toHaveLength(2);
  });

  it('should re-trip a recovered endpoint on its first probation failure', () => {
    const maxFailures = 3;
    const cooldownMs = 500;
    const t0 = 10000;

    for (let i = 0; i < maxFailures; i++) {
      breaker.recordFailure(ep1, maxFailures, cooldownMs, t0);
    }
    expect(breaker.isHealthy(ep1, t0)).toBe(false);

    // Cooldown elapses: endpoint returns to rotation on probation
    expect(breaker.isHealthy(ep1, t0 + cooldownMs)).toBe(true);

    // First failure while on probation re-trips immediately
    const retripped = breaker.recordFailure(ep1, maxFailures, cooldownMs, t0 + cooldownMs + 100);
    expect(retripped).toBe(true);
    expect(breaker.isHealthy(ep1, t0 + cooldownMs + 100)).toBe(false);
  });

  it('should re-arm the cooldown window on failures during an open circuit', () => {
    const t0 = 1000;
    breaker.recordFailure(ep1, 1, 1000, t0); // tripped until 2000

    // Failure arrives mid-cooldown via the degradation fallback
    const rearmed = breaker.recordFailure(ep1, 1, 1000, t0 + 500);
    expect(rearmed).toBe(true);

    // Original window no longer applies; new window ends at t0 + 1500
    expect(breaker.isHealthy(ep1, t0 + 999)).toBe(false);
    expect(breaker.isHealthy(ep1, t0 + 1000)).toBe(false);
    expect(breaker.isHealthy(ep1, t0 + 1500)).toBe(true);
  });

  it('should track health independently per endpoint', () => {
    breaker.recordFailure(ep1, 1, 60000);
    expect(breaker.isHealthy(ep1)).toBe(false);
    expect(breaker.isHealthy(ep2)).toBe(true);
    expect(breaker.getStatus(ep2).consecutiveFailures).toBe(0);
  });

  it('should trip all endpoints belonging to a provider on recordAccountFailure', () => {
    const ep1b: Endpoint = { provider: 'p1', model: 'm1-alt' };
    const all = [ep1, ep1b, ep2];
    const t0 = 10000;

    const tripped = breaker.recordAccountFailure('p1', all, 60000, t0);
    expect(tripped).toEqual([ep1, ep1b]);

    // Both p1 endpoints should be tripped immediately
    expect(breaker.isHealthy(ep1, t0)).toBe(false);
    expect(breaker.isHealthy(ep1b, t0)).toBe(false);

    // p2 is untouched
    expect(breaker.isHealthy(ep2, t0)).toBe(true);
  });

  it('should reset health immediately via resetEndpoint', () => {
    const ep1b: Endpoint = { provider: 'p1', model: 'm1-alt' };
    const t0 = 10000;
    breaker.recordFailure(ep1, 1, 60000, t0);
    breaker.recordFailure(ep1b, 1, 60000, t0);

    expect(breaker.isHealthy(ep1, t0)).toBe(false);
    expect(breaker.isHealthy(ep1b, t0)).toBe(false);

    // Reset single model
    breaker.resetEndpoint('p1', 'm1');
    expect(breaker.isHealthy(ep1, t0)).toBe(true);
    expect(breaker.isHealthy(ep1b, t0)).toBe(false);

    // Reset entire provider
    breaker.resetEndpoint('p1');
    expect(breaker.isHealthy(ep1b, t0)).toBe(true);
  });

  it('should snapshot and hydrate quarantines correctly', () => {
    const t0 = 10000;
    breaker.recordFailure(ep1, 1, 5000, t0); // tripped until 15000
    breaker.recordFailure(ep2, 1, 8000, t0); // tripped until 18000

    const snapshot = breaker.getQuarantines(t0);
    expect(snapshot).toEqual({
      'p1::m1': 15000,
      'p2::m2': 18000
    });

    // Hydrate into fresh breaker
    const fresh = new CircuitBreaker();
    expect(fresh.isHealthy(ep1, t0)).toBe(true);
    fresh.applyQuarantines(snapshot, t0);
    expect(fresh.isHealthy(ep1, t0)).toBe(false);
    expect(fresh.isHealthy(ep2, t0)).toBe(false);

    // Removing a key in applyQuarantines clears the trip
    fresh.applyQuarantines({ 'p1::m1': 15000 }, t0);
    expect(fresh.isHealthy(ep1, t0)).toBe(false);
    expect(fresh.isHealthy(ep2, t0)).toBe(true);
  });

  it('computes top-of-hour aligned cooldown with grace period', () => {
    // 10:15:00.000 -> next hour 11:00:00 + 1m grace = 11:01:00 (46 minutes = 2,760,000 ms)
    const t10_15 = new Date('2026-09-22T10:15:00.000Z').getTime();
    const cd1 = computeHourlyAlignedCooldown(t10_15, 60_000, 5 * 60_000);
    expect(cd1).toBe(46 * 60_000);

    // 10:58:00.000 -> top of hour is in 2m, which is less than minMs (5m).
    // Target advances to next hour 12:01:00 (63 minutes = 3,780,000 ms).
    const t10_58 = new Date('2026-09-22T10:58:00.000Z').getTime();
    const cd2 = computeHourlyAlignedCooldown(t10_58, 60_000, 5 * 60_000);
    expect(cd2).toBe(63 * 60_000);
  });
});
