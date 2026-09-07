import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickWeighted, pickNextEndpoint } from '../src/balancer.js';
import type { Endpoint } from '../src/types.js';

const pool: Endpoint[] = [
  { provider: 'p1', model: 'm1' },
  { provider: 'p2', model: 'm2' }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TDD round 7: balancer invariants under degenerate inputs', () => {
  it('PROBE A: weighted picks honor bucket boundaries under mocked randomness', () => {
    const spy = vi.spyOn(Math, 'random');

    spy.mockReturnValue(0); // exactly the start of bucket 0
    expect(pickWeighted(pool)).toBe(pool[0]);

    spy.mockReturnValue(0.999999); // deep in the last bucket
    expect(pickWeighted(pool)).toBe(pool[1]);

    // Weights [1, 1]: total 2; randomVal 1.0 is the bucket boundary and the
    // `<= 0` comparison assigns it to the EARLIER bucket (p0).
    spy.mockReturnValue(0.5);
    expect(pickWeighted(pool)).toBe(pool[0]);

    spy.mockReturnValue(0.75); // 1.5 - 1 = 0.5 > 0 -> bucket 1
    expect(pickWeighted(pool)).toBe(pool[1]);
  });

  it('PROBE B: zero, NaN, negative and missing weights all degenerate to weight 1', () => {
    const degenerate: Endpoint[] = [
      { provider: 'a', model: 'm', weight: 0 },
      { provider: 'b', model: 'm', weight: Number.NaN },
      { provider: 'c', model: 'm', weight: -5 },
      { provider: 'd', model: 'm' }
    ];

    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValue(0.25); // total 4 -> 1.0 -> bucket 0 (a)
    expect(pickWeighted(degenerate)?.provider).toBe('a');

    spy.mockReturnValue(0.5); // 2.0 -> bucket 1 (b)
    expect(pickWeighted(degenerate)?.provider).toBe('b');

    spy.mockReturnValue(0.75); // 3.0 -> bucket 2 (c)
    expect(pickWeighted(degenerate)?.provider).toBe('c');

    spy.mockReturnValue(0.99); // -> bucket 3 (d)
    expect(pickWeighted(degenerate)?.provider).toBe('d');
  });

  it('PROBE C: a NaN cursor degrades to a valid pick instead of undefined', () => {
    const picked = pickNextEndpoint(pool, 'round-robin', Number.NaN, defaultBreaker());
    expect(picked).not.toBeUndefined();
    expect(pool).toContainEqual(picked);
  });

  it('PROBE D: an Infinity cursor degrades to a valid pick instead of undefined', () => {
    const picked = pickNextEndpoint(pool, 'round-robin', Number.POSITIVE_INFINITY, defaultBreaker());
    expect(picked).not.toBeUndefined();
    expect(pool).toContainEqual(picked);

    const negative = pickNextEndpoint(pool, 'round-robin', Number.NEGATIVE_INFINITY, defaultBreaker());
    expect(negative).not.toBeUndefined();
  });

  it('PROBE E: fuzzed round-robin cursors always resolve inside the pool', () => {
    const breaker = defaultBreaker();
    for (let cursor = -500; cursor <= 500; cursor += 7) {
      const picked = pickNextEndpoint(pool, 'round-robin', cursor, breaker);
      expect(pool).toContainEqual(picked);
    }
  });

  it('PROBE F: fuzzed weighted picks stay inside the pool and honor dominance', () => {
    const dominant: Endpoint[] = [
      { provider: 'heavy', model: 'm', weight: 100 },
      { provider: 'light', model: 'm', weight: 1 }
    ];

    let heavy = 0;
    let light = 0;
    for (let i = 0; i < 500; i++) {
      const picked = pickWeighted(dominant);
      expect(dominant).toContainEqual(picked);
      if (picked?.provider === 'heavy') heavy += 1;
      else light += 1;
    }
    // The light endpoint keeps its ~1% share (weight clamp is >= 1, not 0)
    expect(heavy).toBeGreaterThanOrEqual(450);
    expect(light).toBeLessThanOrEqual(50);
  });

  it('PROBE G: uniform random strategy eventually visits every endpoint', () => {
    const seen = new Set<string>();
    const breaker = defaultBreaker();
    for (let i = 0; i < 200; i++) {
      const picked = pickNextEndpoint(pool, 'random', 0, breaker);
      seen.add(picked!.provider);
    }
    expect(seen).toEqual(new Set(['p1', 'p2']));
  });

  it('PROBE H: a single-endpoint weighted pool always returns that endpoint', () => {
    const solo: Endpoint[] = [{ provider: 'only', model: 'm' }];
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValue(0.999999);
    expect(pickWeighted(solo)?.provider).toBe('only');
    spy.mockReturnValue(0);
    expect(pickWeighted(solo)?.provider).toBe('only');
  });
});

import { CircuitBreaker } from '../src/health.js';
function defaultBreaker(): CircuitBreaker {
  return new CircuitBreaker();
}
