import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/health.js';

const ep = { provider: 'p1', model: 'm1' };

/**
 * TDD round 24: flapping-guard contracts.
 *
 * A rapidly cycling endpoint (trip -> probation -> trip ...) needs a
 * longer rest than a clean single cooldown. Trips inside the window
 * accumulate; a clean success ends the episode; trips outside the window
 * never accumulate.
 */
describe('TDD round 24: flapping guard', () => {
  it('PROBE 1: the third trip inside the window draws the extended penalty', () => {
    const breaker = new CircuitBreaker();
    const t0 = 1000;

    breaker.recordFailure(ep, 1, 1000, t0); // trip 1: until t0+1000
    expect(breaker.isHealthy(ep, t0 + 1000)).toBe(true); // probation
    breaker.recordFailure(ep, 1, 1000, t0 + 1100); // trip 2: until t0+2100
    expect(breaker.isHealthy(ep, t0 + 2100)).toBe(true);
    breaker.recordFailure(ep, 1, 1000, t0 + 2200); // trip 3: penalty!

    // 3x cooldown: until t0+2200+3000 = t0+5200
    expect(breaker.isHealthy(ep, t0 + 5199)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 5200)).toBe(true);
  });

  it('PROBE 2: trips older than the window are pruned - no eternal penalty', () => {
    const breaker = new CircuitBreaker();
    const base = 1_000_000;
    const window = 10 * 60_000;

    breaker.recordFailure(ep, 1, 1000, base);
    breaker.recordFailure(ep, 1, 1000, base + 1000); // trip 2

    // Way beyond the window: those two trips are stale now. Exactly TWO
    // fresh trips follow - had the stale ones accumulated, the second of
    // these would be trip 4 and draw the penalty.
    breaker.recordFailure(ep, 1, 1000, base + window + 5_000); // fresh trip 1
    breaker.recordFailure(ep, 1, 1000, base + window + 6_000); // fresh trip 2

    // Normal cooldown: until +6000+1000; healthy at the inclusive deadline
    expect(breaker.isHealthy(ep, base + window + 6_999)).toBe(false);
    expect(breaker.isHealthy(ep, base + window + 7_000)).toBe(true);
  });

  it('PROBE 3: a clean success ends the flapping episode', () => {
    const breaker = new CircuitBreaker();
    const t0 = 1000;

    breaker.recordFailure(ep, 1, 1000, t0);
    breaker.recordFailure(ep, 1, 1000, t0 + 100);
    breaker.recordSuccess(ep, t0 + 200); // episode over

    // Two fresh trips later: still only trip 2 of the new episode
    breaker.recordFailure(ep, 1, 1000, t0 + 300);
    breaker.recordFailure(ep, 1, 1000, t0 + 1400);
    breaker.isHealthy(ep, t0 + 2400);
    breaker.recordFailure(ep, 1, 1000, t0 + 2400); // trip 3 of the NEW episode -> penalty
    expect(breaker.isHealthy(ep, t0 + 5400 - 1)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 5400)).toBe(true);
  });

  it('PROBE 4: re-arms inside a cooldown do not inflate the flap count', () => {
    const breaker = new CircuitBreaker();
    const t0 = 1000;

    breaker.recordFailure(ep, 1, 5000, t0); // trip 1
    breaker.recordFailure(ep, 1, 5000, t0 + 100); // re-arm (same episode)
    breaker.recordFailure(ep, 1, 5000, t0 + 200); // re-arm again

    // Cooldown elapses, probation failure -> trip 2 of the episode
    breaker.isHealthy(ep, t0 + 5000);
    breaker.recordFailure(ep, 1, 5000, t0 + 5000);

    // Only 2 in-window trips: normal 5s cooldown, not the 3x penalty
    expect(breaker.isHealthy(ep, t0 + 9_999)).toBe(false);
    expect(breaker.isHealthy(ep, t0 + 10_000)).toBe(true);
  });
});
