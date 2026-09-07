import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../src/health.js';
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
});
