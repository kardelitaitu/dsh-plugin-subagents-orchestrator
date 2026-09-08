import { describe, it, expect } from 'vitest';
import { CircuitBreaker, DEFAULT_COOLDOWN_MS, FLAP_TRIP_THRESHOLD, FLAP_WINDOW_MS, FLAP_COOLDOWN_MULTIPLIER } from '../src/health.js';
import type { Endpoint } from '../src/types.js';

const ep: Endpoint = { provider: 'p', model: 'm' };
const other: Endpoint = { provider: 'p', model: 'other' };

/**
 * Flapping guard (v2): an endpoint that trips FLAP_TRIP_THRESHOLD times
 * within FLAP_WINDOW_MS draws FLAP_COOLDOWN_MULTIPLIER x the cooldown, and a
 * clean probationary success ends the episode.
 */
describe('CircuitBreaker flapping guard', () => {
  it('applies the extended penalty on the Nth trip within the window', () => {
    const breaker = new CircuitBreaker();
    let t = 0;
    // trips 1..FLAP_TRIP_THRESHOLD - 1 stay on the plain cooldown
    for (let n = 1; n < FLAP_TRIP_THRESHOLD; n++) {
      breaker.recordFailure(ep, 1, 1000, t);
      const until = breaker.getStatus(ep).trippedUntil!;
      expect(until).toBe(t + 1000);
      t += 1001; // cooldown elapses, endpoint re-enters (probation), fails again
    }
    // the Nth trip inside the window draws the multiplier
    breaker.recordFailure(ep, 1, 1000, t);
    expect(breaker.getStatus(ep).trippedUntil).toBe(t + 1000 * FLAP_COOLDOWN_MULTIPLIER);
  });

  it('prunes trip history older than the window (no permanent penalty)', () => {
    const breaker = new CircuitBreaker();
    // FLAP_TRIP_THRESHOLD trips, each spaced beyond FLAP_WINDOW_MS
    let t = 0;
    let lastTripAt = 0;
    for (let n = 1; n <= FLAP_TRIP_THRESHOLD; n++) {
      breaker.recordFailure(ep, 1, 1000, t);
      lastTripAt = t;
      t += FLAP_WINDOW_MS + 1;
    }
    // every earlier trip was pruned; the last trip stands alone
    expect(breaker.getStatus(ep).recentTrips).toHaveLength(1);
    expect(breaker.getStatus(ep).trippedUntil).toBe(lastTripAt + 1000); // plain cooldown
  });

  it('does not leak trip history into other endpoints', () => {
    const breaker = new CircuitBreaker();
    for (let n = 1; n <= FLAP_TRIP_THRESHOLD; n++) {
      breaker.recordFailure(ep, 1, 1000, n * 10);
    }
    expect(breaker.getStatus(other).recentTrips ?? []).toHaveLength(0);
    breaker.recordFailure(other, 1, 1000, 999);
    expect(breaker.getStatus(other).trippedUntil).toBe(999 + 1000); // no multiplier
  });

  it('a clean probationary success ends the flapping episode', () => {
    const breaker = new CircuitBreaker();
    let t = 0;
    for (let n = 1; n < FLAP_TRIP_THRESHOLD; n++) {
      breaker.recordFailure(ep, 1, 1000, t);
      t += 1001;
    }
    breaker.recordSuccess(ep); // probation success
    expect(breaker.getStatus(ep).recentTrips).toHaveLength(0);

    // a fresh episode starts counting from zero
    breaker.recordFailure(ep, 1, 1000, t + 10);
    expect(breaker.getStatus(ep).trippedUntil).toBe(t + 10 + 1000);
  });

  it('keeps the default constants documented by the contract', () => {
    expect(FLAP_TRIP_THRESHOLD).toBe(3);
    expect(FLAP_COOLDOWN_MULTIPLIER).toBe(3);
    expect(FLAP_WINDOW_MS).toBe(10 * 60_000);
    void DEFAULT_COOLDOWN_MS;
  });
});
