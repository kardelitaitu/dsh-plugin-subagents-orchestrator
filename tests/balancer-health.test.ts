/**
 * Adversarial tests for the routing core: `src/balancer.ts` and the
 * `filterHealthy` / `isHealthy` interaction in `src/health.ts`.
 *
 * TEST-ONLY file. No production file is modified. Each `describe` is one
 * attack round; tests assert the *correct* contract, so a RED run is a bug
 * report (see the `// BUG:` markers for the confirmed one).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { pickNextEndpoint, pickWeighted } from '../src/balancer.js';
import { CircuitBreaker, defaultCircuitBreaker } from '../src/health.js';
import { parseConfigDocument, extractEndpoints } from '../src/config.js';
import type { Endpoint, RoutingStrategy } from '../src/types.js';

const A: Endpoint = { provider: 'p1', model: 'm1' };
const B: Endpoint = { provider: 'p2', model: 'm2' };
const C: Endpoint = { provider: 'p3', model: 'm3' };
const POOL: Endpoint[] = [A, B, C];

/** Trip `ep` so it stays out of rotation for the whole test (1h cooldown). */
function trip(breaker: CircuitBreaker, ep: Endpoint, cooldownMs = 3_600_000): void {
  breaker.recordFailure(ep, 1, cooldownMs, Date.now());
}

const ALL_STRATEGIES: (RoutingStrategy | undefined)[] = [
  'round-robin',
  'random',
  'weighted',
  undefined,
  'not-a-strategy' as RoutingStrategy
];

// ---------------------------------------------------------------------------
// Round 1 — round-robin cursor vs the HEALTH-FILTERED pool.
// ---------------------------------------------------------------------------
describe('Round 1 - round-robin cursor over the health-filtered pool', () => {
  it('visits each healthy member exactly once per cycle when one member is tripped', () => {
    const breaker = new CircuitBreaker();
    trip(breaker, A); // healthy pool = [B, C]
    const picks: Endpoint[] = [];
    for (let cursor = 0; cursor < 6; cursor++) {
      picks.push(pickNextEndpoint(POOL, 'round-robin', cursor, breaker)!);
    }
    // cursor % 2 over [B, C]
    expect(picks).toEqual([B, C, B, C, B, C]);
  });

  it('never double-hits inside a cycle and never starves over 300 rotations', () => {
    const breaker = new CircuitBreaker();
    trip(breaker, A);
    const counts = new Map<string, number>();
    for (let cursor = 0; cursor < 300; cursor++) {
      const picked = pickNextEndpoint(POOL, 'round-robin', cursor, breaker)!;
      counts.set(picked.provider, (counts.get(picked.provider) ?? 0) + 1);
    }
    expect(counts.get('p1')).toBeUndefined(); // tripped: never routed
    expect(counts.get('p2')).toBe(150); // perfectly even over 300/2
    expect(counts.get('p3')).toBe(150);
  });

  it('keeps rotation even when the pool shrinks then regrows', () => {
    const breaker = new CircuitBreaker();
    trip(breaker, B); // pool [A, C]
    expect(pickNextEndpoint(POOL, 'round-robin', 0, breaker)).toBe(A);
    expect(pickNextEndpoint(POOL, 'round-robin', 1, breaker)).toBe(C);
    breaker.recordSuccess(B); // pool back to [A, B, C]
    expect(pickNextEndpoint(POOL, 'round-robin', 2, breaker)).toBe(C);
    expect(pickNextEndpoint(POOL, 'round-robin', 3, breaker)).toBe(A);
  });
});

// ---------------------------------------------------------------------------
// Round 2 — distribution uniformity of the uniform strategies.
// ---------------------------------------------------------------------------
describe('Round 2 - distribution uniformity', () => {
  it('splits 300 random picks ~evenly across 3 healthy endpoints', () => {
    const breaker = new CircuitBreaker();
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const picked = pickNextEndpoint(POOL, 'random', 0, breaker)!;
      counts.set(picked.provider, (counts.get(picked.provider) ?? 0) + 1);
    }
    expect(counts.size).toBe(3);
    for (const provider of ['p1', 'p2', 'p3']) {
      // mean 100, sd ~8.2 => [70,130] is ~3.6 sd, <0.1% false-positive.
      expect(counts.get(provider)!).toBeGreaterThanOrEqual(70);
      expect(counts.get(provider)!).toBeLessThanOrEqual(130);
    }
  });

  it('splits 300 equal-weight weighted picks ~evenly', () => {
    const pool: Endpoint[] = [
      { provider: 'w1', model: 'm', weight: 1 },
      { provider: 'w2', model: 'm', weight: 1 },
      { provider: 'w3', model: 'm', weight: 1 }
    ];
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const picked = pickWeighted(pool)!;
      counts.set(picked.provider, (counts.get(picked.provider) ?? 0) + 1);
    }
    for (const provider of ['w1', 'w2', 'w3']) {
      expect(counts.get(provider)!).toBeGreaterThanOrEqual(70);
      expect(counts.get(provider)!).toBeLessThanOrEqual(130);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 3 — extreme but reachable weights.
// ---------------------------------------------------------------------------
describe('Round 3 - extreme weights', () => {
  it('honours a large-but-finite 1e6 : 1 ratio', () => {
    const heavy: Endpoint = { provider: 'heavy', model: 'm', weight: 1e6 };
    const light: Endpoint = { provider: 'light', model: 'm', weight: 1 };
    let heavyCount = 0;
    for (let i = 0; i < 300; i++) {
      if (pickWeighted([heavy, light]) === heavy) heavyCount++;
    }
    // P(light) = 1/1000001 per call; 300 calls => ~0.0003 expected light picks.
    expect(heavyCount).toBeGreaterThanOrEqual(299);
  });

  // Regression guard for the weight-overflow starvation, FIXED in
  // src/balancer.ts: weights are scale-normalized by their max before summing,
  // so the total is bounded by the endpoint count and cannot overflow.
  // (Originally written as an `it.fails` pin while the defect was live.)
  it('REGRESSION: two 1e308 weights must not overflow the sum and starve every bucket but the last', () => {
    const w1: Endpoint = { provider: 'w1', model: 'm', weight: 1e308 };
    const w2: Endpoint = { provider: 'w2', model: 'm', weight: 1e308 };
    // Precondition: the sum really does overflow a double.
    expect(1e308 + 1e308).toBe(Infinity);

    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(pickWeighted([w1, w2])!.provider);
    }

    // Before the fix this starved w1 to exactly 0 traffic: totalWeight was
    // Infinity, so `randomVal = Math.random() * Infinity` stayed Infinity and
    // `randomVal <= 0` never held, falling through to the last bucket on every
    // call. Both endpoints must now be reachable.
    expect(seen.has('w1')).toBe(true);
  });

  // Same guard through the real config trust boundary
  // (parseConfigDocument -> extractEndpoints), proving the path is reachable.
  it('REGRESSION (reachable from config): 1e308 weights survive parseConfigDocument and route both endpoints', () => {
    const config = parseConfigDocument({
      'subagents-orchestrator': {
        strategy: 'weighted',
        endpoints: [
          { provider: 'a', model: 'm', weight: 1e308 },
          { provider: 'b', model: 'm', weight: 1e308 }
        ]
      }
    });
    const endpoints = extractEndpoints(config);
    // Reachability precondition: the schema only rejects non-finite weights
    // (src/config.ts:93), and 1e308 is finite, so it is stored verbatim.
    expect(endpoints).toHaveLength(2);
    expect(endpoints.map((e) => e.weight)).toEqual([1e308, 1e308]);

    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickWeighted(endpoints)!.provider);
    }
    // BUG: same overflow as above; endpoint 'a' is never routed.
    expect(seen.has('a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 4 — odd weights clamp to >= 1 (no endpoint ever starved to zero).
// ---------------------------------------------------------------------------
describe('Round 4 - zero / negative / NaN / fractional weights clamp to >= 1', () => {
  const oddWeights: [string, number][] = [
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['fractional 0.5', 0.5],
    ['negative fractional', -0.5]
  ];

  for (const [label, weight] of oddWeights) {
    it(`keeps both endpoints in rotation for a ${label} weight`, () => {
      const odd: Endpoint = { provider: 'odd', model: 'm', weight };
      const normal: Endpoint = { provider: 'normal', model: 'm', weight: 1 };
      let oddCount = 0;
      for (let i = 0; i < 400; i++) {
        if (pickWeighted([odd, normal]) === odd) oddCount++;
      }
      // Both clamped to 1 => ~50/50; never 0 and never 400.
      expect(oddCount).toBeGreaterThan(120);
      expect(oddCount).toBeLessThan(280);
    });
  }

  it('treats a missing weight as 1', () => {
    const missing: Endpoint = { provider: 'missing', model: 'm' };
    const normal: Endpoint = { provider: 'normal', model: 'm', weight: 1 };
    let missingCount = 0;
    for (let i = 0; i < 400; i++) {
      if (pickWeighted([missing, normal]) === missing) missingCount++;
    }
    expect(missingCount).toBeGreaterThan(120);
    expect(missingCount).toBeLessThan(280);
  });

  it('never returns an endpoint with a clamped-to-1 weight zero times out of 400', () => {
    const pool: Endpoint[] = [
      { provider: 'a', model: 'm', weight: 0 },
      { provider: 'b', model: 'm', weight: -1 },
      { provider: 'c', model: 'm', weight: Number.NaN },
      { provider: 'd', model: 'm', weight: 0.25 }
    ];
    const counts = new Map<string, number>(pool.map((e) => [e.provider, 0]));
    for (let i = 0; i < 400; i++) {
      const picked = pickWeighted(pool)!;
      counts.set(picked.provider, counts.get(picked.provider)! + 1);
    }
    for (const provider of ['a', 'b', 'c', 'd']) {
      expect(counts.get(provider)!).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 5 — filterHealthy degradation.
// ---------------------------------------------------------------------------
describe('Round 5 - filterHealthy degradation and purity', () => {
  it('returns the FULL pool, in original order, when every endpoint is tripped', () => {
    const breaker = new CircuitBreaker();
    for (const ep of POOL) trip(breaker, ep);
    const result = breaker.filterHealthy(POOL);
    expect(result).toEqual(POOL);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(A);
    expect(result[1]).toBe(B);
    expect(result[2]).toBe(C);
  });

  it('does not mutate the input array', () => {
    const breaker = new CircuitBreaker();
    const input = [...POOL];
    const snapshot = [...input];
    for (const ep of POOL) trip(breaker, ep);
    const result = breaker.filterHealthy(input);
    expect(input).toEqual(snapshot);
    expect(input.length).toBe(3);
    expect(result).toEqual(snapshot);
  });

  it('returns only the healthy subset, order preserved, on a partial trip', () => {
    const breaker = new CircuitBreaker();
    trip(breaker, B);
    expect(breaker.filterHealthy(POOL)).toEqual([A, C]);
  });

  it('returns [] for an empty input', () => {
    expect(new CircuitBreaker().filterHealthy([])).toEqual([]);
  });

  it('reports the pool healthy again once the cooldown has elapsed', () => {
    const breaker = new CircuitBreaker();
    const base = 1_700_000_000_000;
    breaker.recordFailure(B, 1, 1000, base); // trippedUntil = base + 1000
    expect(breaker.filterHealthy(POOL, base + 999)).toEqual([A, C]);
    expect(breaker.filterHealthy(POOL, base + 1000)).toEqual([A, B, C]);
  });
});

// ---------------------------------------------------------------------------
// Round 6 — isHealthy at the trippedUntil boundary / probation transition.
// ---------------------------------------------------------------------------
describe('Round 6 - isHealthy boundary and probation transition', () => {
  const base = 1_700_000_000_000;

  it('is false just before, true exactly at, and true just after trippedUntil', () => {
    const before = new CircuitBreaker();
    before.recordFailure(A, 1, 1000, base);
    expect(before.getStatus(A).trippedUntil).toBe(base + 1000);
    expect(before.isHealthy(A, base + 999)).toBe(false);

    const exactly = new CircuitBreaker();
    exactly.recordFailure(A, 1, 1000, base);
    expect(exactly.isHealthy(A, base + 1000)).toBe(true); // now >= trippedUntil

    const after = new CircuitBreaker();
    after.recordFailure(A, 1, 1000, base);
    expect(after.isHealthy(A, base + 1001)).toBe(true);
  });

  it('probation transition is a stable state write: repeated calls never re-trip', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(A, 1, 1000, base);
    const before = breaker.getStatus(A);
    expect(before.consecutiveFailures).toBe(1);

    for (let i = 0; i < 5; i++) {
      expect(breaker.isHealthy(A, base + 1000)).toBe(true);
    }

    const after = breaker.getStatus(A);
    expect(after.trippedUntil).toBeNull();
    expect(after.trippedSince).toBeNull();
    expect(after.consecutiveFailures).toBe(1); // streak deliberately retained
    // Once probation cleared the window, even an earlier instant reports healthy.
    expect(breaker.isHealthy(A, base + 999)).toBe(true);
  });

  it('a failure at the probation instant re-trips immediately (retained streak)', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(A, 1, 1000, base);
    expect(breaker.isHealthy(A, base + 1000)).toBe(true); // clears trippedUntil
    const retripped = breaker.recordFailure(A, 1, 1000, base + 1000);
    expect(retripped).toBe(true);
    expect(breaker.getStatus(A).trippedUntil).toBe(base + 2000);
    expect(breaker.isHealthy(A, base + 1999)).toBe(false);
    expect(breaker.isHealthy(A, base + 2000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 7 — unknown / missing strategy degrades to round-robin.
// ---------------------------------------------------------------------------
describe('Round 7 - strategy fallback', () => {
  it('undefined, null, empty and unknown strategy names all round-robin', () => {
    const breaker = new CircuitBreaker();
    expect(pickNextEndpoint(POOL, undefined, 1, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, 'mystery-strategy' as RoutingStrategy, 1, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, null as unknown as RoutingStrategy, 1, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, '' as RoutingStrategy, 1, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, 'Round-Robin' as RoutingStrategy, 1, breaker)).toBe(B); // case-sensitive => default
  });
});

// ---------------------------------------------------------------------------
// Round 8 — hostile cursors never resolve to undefined.
// ---------------------------------------------------------------------------
describe('Round 8 - hostile cursors', () => {
  const breaker = new CircuitBreaker();
  const hostileCursors = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    -4,
    2.9,
    -2.9,
    0.5,
    -0,
    1e300,
    1.5e308,
    Number.MAX_VALUE
  ];

  it('degrades non-finite cursors to the pool start', () => {
    expect(pickNextEndpoint(POOL, 'round-robin', Number.NaN, breaker)).toBe(A);
    expect(pickNextEndpoint(POOL, 'round-robin', Number.POSITIVE_INFINITY, breaker)).toBe(A);
    expect(pickNextEndpoint(POOL, 'round-robin', Number.NEGATIVE_INFINITY, breaker)).toBe(A);
  });

  it('always returns a pool member (never undefined) for every hostile cursor', () => {
    for (const cursor of hostileCursors) {
      const picked = pickNextEndpoint(POOL, 'round-robin', cursor, breaker);
      expect(picked).not.toBeUndefined();
      expect(picked).not.toBeNull();
      expect(POOL).toContain(picked);
    }
  });

  it('abs-truncates negative and fractional cursors', () => {
    expect(pickNextEndpoint(POOL, 'round-robin', -1, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, 'round-robin', -4, breaker)).toBe(B);
    expect(pickNextEndpoint(POOL, 'round-robin', 2.9, breaker)).toBe(C);
    expect(pickNextEndpoint(POOL, 'round-robin', -2.9, breaker)).toBe(C);
    expect(pickNextEndpoint(POOL, 'round-robin', -0, breaker)).toBe(A);
  });
});

// ---------------------------------------------------------------------------
// Round 9 — single-endpoint pool.
// ---------------------------------------------------------------------------
describe('Round 9 - single-endpoint pool', () => {
  const solo = [A];

  for (const strategy of ALL_STRATEGIES) {
    it(`always returns the only endpoint (strategy=${String(strategy)})`, () => {
      const breaker = new CircuitBreaker();
      for (let cursor = 0; cursor < 20; cursor++) {
        expect(pickNextEndpoint(solo, strategy, cursor, breaker)).toBe(A);
      }
    });
  }

  it('still returns it when it is tripped (all-tripped degradation)', () => {
    const breaker = new CircuitBreaker();
    trip(breaker, A);
    for (const strategy of ALL_STRATEGIES) {
      expect(pickNextEndpoint(solo, strategy, 3, breaker)).toBe(A);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 10 — empty pool.
// ---------------------------------------------------------------------------
describe('Round 10 - empty pool', () => {
  for (const strategy of ALL_STRATEGIES) {
    it(`returns null, never throws (strategy=${String(strategy)})`, () => {
      const breaker = new CircuitBreaker();
      expect(() => pickNextEndpoint([], strategy, 0, breaker)).not.toThrow();
      expect(pickNextEndpoint([], strategy, 0, breaker)).toBeNull();
      expect(pickNextEndpoint([], strategy, 7, breaker)).toBeNull();
    });
  }

  it('degrades null / undefined pool inputs to null', () => {
    const breaker = new CircuitBreaker();
    expect(pickNextEndpoint(null as unknown as Endpoint[], 'round-robin', 0, breaker)).toBeNull();
    expect(pickNextEndpoint(undefined as unknown as Endpoint[], 'weighted', 0, breaker)).toBeNull();
    expect(pickNextEndpoint(null as unknown as Endpoint[], 'random', 0, breaker)).toBeNull();
    expect(pickWeighted(null as unknown as Endpoint[])).toBeNull();
    expect(pickWeighted(undefined as unknown as Endpoint[])).toBeNull();
    expect(pickWeighted([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round 11 — breaker instance isolation (no shared module state).
// ---------------------------------------------------------------------------
describe('Round 11 - CircuitBreaker instance isolation', () => {
  afterEach(() => {
    defaultCircuitBreaker.clear();
  });

  it('two fresh CircuitBreaker instances do not share health state', () => {
    const b1 = new CircuitBreaker();
    const b2 = new CircuitBreaker();
    const ep: Endpoint = { provider: 'iso-a', model: 'm' };
    trip(b1, ep);
    expect(b1.isHealthy(ep)).toBe(false);
    expect(b2.isHealthy(ep)).toBe(true);
    expect(b2.filterHealthy([ep])).toEqual([ep]);
  });

  it('a fresh breaker does not inherit defaultCircuitBreaker state', () => {
    const ep: Endpoint = { provider: 'iso-b', model: 'm' };
    trip(defaultCircuitBreaker, ep);
    expect(defaultCircuitBreaker.isHealthy(ep)).toBe(false);
    expect(new CircuitBreaker().isHealthy(ep)).toBe(true);
  });

  it('defaultCircuitBreaker does not inherit a fresh breaker state', () => {
    const ep: Endpoint = { provider: 'iso-c', model: 'm' };
    const fresh = new CircuitBreaker();
    trip(fresh, ep);
    expect(fresh.isHealthy(ep)).toBe(false);
    expect(defaultCircuitBreaker.isHealthy(ep)).toBe(true);
  });
});
