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
// ===========================================================================
// ROUND 2 - appended adversarial rounds (12+). Re-read against HEAD ea2cf80.
// ===========================================================================

// ---------------------------------------------------------------------------
// Round 12 - scale-normalization correctness (ratio, not just non-overflow).
// ---------------------------------------------------------------------------
describe('Round 12 - scale-normalization correctness', () => {
  it('keeps the 1:1:1e-308 ratio for [1e308, 1e308, 1] and never returns NaN/undefined', () => {
    const pool: Endpoint[] = [
      { provider: 'a', model: 'm', weight: 1e308 },
      { provider: 'b', model: 'm', weight: 1e308 },
      { provider: 'c', model: 'm', weight: 1 }
    ];
    const counts = new Map<string, number>([['a', 0], ['b', 0], ['c', 0]]);
    for (let i = 0; i < 20000; i++) {
      const picked = pickWeighted(pool);
      expect(picked).not.toBeNull();
      expect(pool).toContain(picked);
      counts.set(picked!.provider, counts.get(picked!.provider)! + 1);
    }
    expect(counts.get('c')).toBe(0);
    expect(counts.get('a')).toBeGreaterThanOrEqual(9000);
    expect(counts.get('b')).toBeGreaterThanOrEqual(9000);
  });

  it('keeps all-equal huge weights uniform (scale === every weight)', () => {
    const pool: Endpoint[] = [
      { provider: 'a', model: 'm', weight: 1e308 },
      { provider: 'b', model: 'm', weight: 1e308 },
      { provider: 'c', model: 'm', weight: 1e308 }
    ];
    const counts = new Map<string, number>([['a', 0], ['b', 0], ['c', 0]]);
    for (let i = 0; i < 3000; i++) {
      const picked = pickWeighted(pool)!;
      counts.set(picked.provider, counts.get(picked.provider)! + 1);
    }
    for (const p of ['a', 'b', 'c']) {
      expect(counts.get(p)!).toBeGreaterThanOrEqual(800);
      expect(counts.get(p)!).toBeLessThanOrEqual(1200);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 13 - the min-1 clamp must happen BEFORE normalization (order matters).
// ---------------------------------------------------------------------------
describe('Round 13 - clamp-before-normalization order', () => {
  it('a negative weight is clamped to 1 before the scale is taken', () => {
    const neg: Endpoint = { provider: 'neg', model: 'm', weight: -5 };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    let negCount = 0;
    for (let i = 0; i < 400; i++) {
      if (pickWeighted([neg, one]) === neg) negCount++;
    }
    expect(negCount).toBeGreaterThan(120);
    expect(negCount).toBeLessThan(280);
  });

  it('a zero weight next to a huge weight is clamped to 1 first, then scaled away', () => {
    const zero: Endpoint = { provider: 'zero', model: 'm', weight: 0 };
    const huge: Endpoint = { provider: 'huge', model: 'm', weight: 1e6 };
    let zeroCount = 0;
    for (let i = 0; i < 2000; i++) {
      if (pickWeighted([zero, huge]) === zero) zeroCount++;
    }
    expect(zeroCount).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Round 14 - non-finite weights are NOT sanitized by the clamp.
// ---------------------------------------------------------------------------
describe('Round 14 - non-finite weights', () => {
  // Pinned expected-failure: the body genuinely fails today (see // BUG below).
  // (Originally an `it.fails` pin while the defect was live; now a real guard.)
  // a HARD failure the moment the defect is fixed, so the pin cannot rot.
  it('REGRESSION: an Infinity weight must not starve every endpoint but the last', () => {
    const inf: Endpoint = { provider: 'inf', model: 'm', weight: Infinity };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };

    // Preconditions that make this a genuine contract break.
    expect(Number.isFinite(Infinity)).toBe(false);
    // Reachability: the exported pickWeighted API accepts Infinity directly.
    // The panel's Math.max(1, Number(x) || 1) (src/client/index.tsx:602) also
    // passes Number('1e999') = Infinity through into its draft. It does NOT
    // survive to routing, though: schemastery z.number() coerces Infinity to
    // null and config.ts's isFiniteNumber drops it, so this is an
    // exported-API / defensive-boundary defect, not a config-reachable one.
    expect(Number('1e999')).toBe(Infinity);

    const first = new Set<string>();
    for (let i = 0; i < 300; i++) first.add(pickWeighted([inf, one])!.provider);
    const second = new Set<string>();
    for (let i = 0; i < 300; i++) second.add(pickWeighted([one, inf])!.provider);

    // Before the fix: Math.max(1, Infinity) = Infinity, so scale = Infinity and
    // every scaled weight was NaN (Inf/Inf) or 0 (1/Inf). totalWeight became
    // NaN, 'randomVal <= 0' was never true, and the float-safety tail returned
    // endpoints[last] on EVERY call — starving the non-last endpoint to 0.
    // Now a non-finite weight is reduced to 1 before the max, so both buckets
    // are reachable.
    expect(first.has('inf')).toBe(true);
    expect(second.has('one')).toBe(true);
  });

  it('config.ts already rejects a non-finite weight at the trust boundary (contrast)', () => {
    const config = parseConfigDocument({
      'subagents-orchestrator': {
        strategy: 'weighted',
        endpoints: [
          { provider: 'a', model: 'm', weight: Infinity },
          { provider: 'b', model: 'm', weight: 1 }
        ]
      }
    });
    const endpoints = extractEndpoints(config);
    // isFiniteNumber drops the bad weight, so the endpoint keeps the default 1.
    expect(endpoints[0].weight).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round 15 - Math.max spread arity on a very large pool.
// ---------------------------------------------------------------------------
describe('Round 15 - spread arity on a large pool', () => {
  it('handles a 100k-endpoint pool without blowing the spread argument limit', () => {
    const pool: Endpoint[] = Array.from({ length: 100000 }, (_, i) => ({
      provider: 'e' + i,
      model: 'm',
      weight: 1
    }));
    let picked: Endpoint | null = null;
    expect(() => {
      picked = pickWeighted(pool);
    }).not.toThrow();
    expect(pool).toContain(picked);
  });
  // NOTE (reported, not pinned): Math.max(...weights) throws RangeError
  // 'Maximum call stack size exceeded' at ~130k elements, a cliff the old
  // reduce-based sum did not have. Only reachable with a ~130k-entry config.
});
// ---------------------------------------------------------------------------
// Round 16 - cooldown-extension cap exact boundary.
// ---------------------------------------------------------------------------
describe('Round 16 - cooldown-extension cap boundary', () => {
  it('never extends past tripStart + cooldown*2 and recovers exactly there', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'cap', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000); // trippedUntil 2000, trippedSince 1000, ceiling 3000
    const st = b.getStatus(ep);
    expect(st.trippedUntil).toBe(2000);
    expect(st.trippedSince).toBe(1000);

    for (const now of [1500, 1999, 2600, 2998, 2999]) {
      expect(b.recordFailure(ep, 1, 1000, now)).toBe(true);
      expect(st.trippedUntil).toBeLessThanOrEqual(3000); // ceiling holds
    }
    expect(st.trippedUntil).toBe(3000);
    // Exactly at the cap the endpoint is healthy; one ms earlier it is not.
    // Order matters: isHealthy() MUTATES on probation (clears trippedUntil), so
    // probe the still-tripped instant first.
    expect(b.isHealthy(ep, 2999)).toBe(false);
    expect(b.isHealthy(ep, 3000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 17 - a zero cooldown means immediate recovery (documented).
// ---------------------------------------------------------------------------
describe('Round 17 - zero cooldown', () => {
  it('reports the trip but leaves the endpoint healthy at the same instant', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'zero-cd', model: 'm' };
    const tripped = b.recordFailure(ep, 1, 0, 1000);
    expect(tripped).toBe(true);
    expect(b.getStatus(ep).trippedUntil).toBe(1000); // now + 0
    // cooldown 0 => now < trippedUntil is false, so probation is immediate.
    expect(b.isHealthy(ep, 1000)).toBe(true);
    expect(b.filterHealthy([ep], 1000)).toEqual([ep]);
  });
});

// ---------------------------------------------------------------------------
// Round 18 - trippedSince === null while trippedUntil is set.
// ---------------------------------------------------------------------------
describe('Round 18 - trippedSince null fallback', () => {
  it('anchors the ceiling on trippedUntil when trippedSince is missing, never shrinking', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'null-since', model: 'm' };
    const st = b.getStatus(ep);
    st.trippedUntil = 5000;
    st.trippedSince = null;
    expect(b.recordFailure(ep, 1, 1000, 2000)).toBe(true);
    // tripStart = trippedUntil = 5000; min(3000, 7000) = 3000; max(5000, 3000) = 5000.
    expect(st.trippedUntil).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Round 19 - applyQuarantines (shorter window) x the extension cap.
// ---------------------------------------------------------------------------
describe('Round 19 - applyQuarantines shorter window vs the cap', () => {
  it('adopts the shorter window, then a failing probe may extend but never shrink it', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'aq', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000); // trippedUntil 2000, trippedSince 1000
    b.applyQuarantines({ 'aq::m': 1500 }, 1000); // adopt SHORTER window
    expect(b.getStatus(ep).trippedUntil).toBe(1500);

    b.recordFailure(ep, 1, 1000, 1400); // failing probe during cooldown
    const after = b.getStatus(ep).trippedUntil!;
    expect(after).toBeGreaterThanOrEqual(1500); // never shrinks below the adopted promise
    expect(after).toBeLessThanOrEqual(3000); // ceiling (trippedSince 1000 + 2000) holds
    expect(after).toBe(2400); // min(1400+1000, 3000)
  });
});

// ---------------------------------------------------------------------------
// Round 20 - fractional trippedUntil boundary.
// ---------------------------------------------------------------------------
describe('Round 20 - fractional cooldown boundary', () => {
  it('treats a fractional trippedUntil as tripped before and healthy at/after it', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'frac', model: 'm' };
    b.recordFailure(ep, 1, 0.5, 1000);
    expect(b.getStatus(ep).trippedUntil).toBe(1000.5);
    expect(b.isHealthy(ep, 1000)).toBe(false);
    expect(b.isHealthy(ep, 1000.4)).toBe(false);
    expect(b.isHealthy(ep, 1000.5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 21 - filterHealthy with duplicate entries.
// ---------------------------------------------------------------------------
describe('Round 21 - filterHealthy with duplicates', () => {
  it('filters every copy of a tripped endpoint, preserving order', () => {
    const b = new CircuitBreaker();
    const x: Endpoint = { provider: 'dup', model: 'm' };
    const y: Endpoint = { provider: 'solo', model: 'm' };
    b.recordFailure(x, 1, 60000, Date.now());
    expect(b.filterHealthy([x, y, x])).toEqual([y]);
  });

  it('returns the full duplicate-bearing pool unchanged when every copy is tripped', () => {
    const b = new CircuitBreaker();
    const x: Endpoint = { provider: 'dup2', model: 'm' };
    b.recordFailure(x, 1, 60000, Date.now());
    const input = [x, x];
    const out = b.filterHealthy(input);
    expect(out).toEqual([x, x]);
    expect(out.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Round 22 - recordFailure with a fractional maxFailures.
// ---------------------------------------------------------------------------
describe('Round 22 - fractional maxFailures', () => {
  it('trips on the first failure count that reaches the fractional threshold', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'frac-max', model: 'm' };
    expect(b.recordFailure(ep, 2.5, 1000, 1000)).toBe(false); // 1 < 2.5
    expect(b.recordFailure(ep, 2.5, 1000, 1001)).toBe(false); // 2 < 2.5
    expect(b.recordFailure(ep, 2.5, 1000, 1002)).toBe(true); // 3 >= 2.5
    expect(b.getStatus(ep).trippedUntil).toBe(2002);
  });
});

// ---------------------------------------------------------------------------
// Round 23 - flap guard pruning / growth.
// ---------------------------------------------------------------------------
describe('Round 23 - flap guard recentTrips', () => {
  it('retains every trip inside the window and prunes the out-of-window ones', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'flap', model: 'm' };
    const st = b.getStatus(ep);
    let now = 1000;
    for (let i = 0; i < 5; i++) {
      b.recordFailure(ep, 1, 1, now);
      st.trippedUntil = null; // simulate probation between trips
      st.trippedSince = null;
      now += 1;
    }
    // All 5 trips are inside FLAP_WINDOW_MS, so all are retained (pruning is
    // time-based, not count-based).
    expect(st.recentTrips!.length).toBe(5);
    // A trip well outside the window prunes the stale entries.
    b.recordFailure(ep, 1, 1, now + 700000);
    expect(st.recentTrips!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round 24 - shared endpoint OBJECT across two breakers.
// ---------------------------------------------------------------------------
describe('Round 24 - shared endpoint object across breakers', () => {
  it('keys by provider::model, so a shared object does not leak state between instances', () => {
    const shared: Endpoint = { provider: 'shared', model: 'm' };
    const b1 = new CircuitBreaker();
    const b2 = new CircuitBreaker();
    b1.recordFailure(shared, 1, 60000, Date.now());
    expect(b1.isHealthy(shared)).toBe(false);
    expect(b2.isHealthy(shared)).toBe(true);
    expect(b2.filterHealthy([shared])).toEqual([shared]);
  });
});

// ---------------------------------------------------------------------------
// Round 25 - recordSuccess on an endpoint that was never recorded.
// ---------------------------------------------------------------------------
describe('Round 25 - recordSuccess on an unrecorded endpoint', () => {
  it('is a no-op that does not create a health entry', () => {
    const b = new CircuitBreaker();
    const ghost: Endpoint = { provider: 'ghost', model: 'm' };
    b.recordSuccess(ghost);
    // No entry created (recordSuccess uses healthMap.get, not getStatus).
    expect(Object.keys(b.getQuarantines())).toHaveLength(0);
    // Still routable and healthy.
    expect(b.filterHealthy([ghost])).toEqual([ghost]);
  });
});

// ---------------------------------------------------------------------------
// Round 26 - hostile weights never produce a non-member result.
// ---------------------------------------------------------------------------
describe('Round 26 - hostile weights never yield a non-member', () => {
  it('always returns a member of the pool for Infinity / NaN / mixed weights', () => {
    const pools: Endpoint[][] = [
      [{ provider: 'i', model: 'm', weight: Infinity }],
      [{ provider: 'i1', model: 'm', weight: Infinity }, { provider: 'i2', model: 'm', weight: Infinity }],
      [{ provider: 'n', model: 'm', weight: Number.NaN }, { provider: 'h', model: 'm', weight: 1e308 }]
    ];
    for (const pool of pools) {
      for (let i = 0; i < 50; i++) {
        const picked = pickWeighted(pool);
        expect(picked).not.toBeNull();
        expect(pool).toContain(picked);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round 27 - weighted strategy over a fully-tripped pool (degradation).
// ---------------------------------------------------------------------------
describe('Round 27 - weighted over an all-tripped pool', () => {
  it('still returns a pool member through the degradation fallback', () => {
    const b = new CircuitBreaker();
    const pool: Endpoint[] = [
      { provider: 'p1', model: 'm' },
      { provider: 'p2', model: 'm' },
      { provider: 'p3', model: 'm' }
    ];
    for (const ep of pool) b.recordFailure(ep, 1, 60000, Date.now());
    for (let i = 0; i < 100; i++) {
      const picked = pickNextEndpoint(pool, 'weighted', 0, b);
      expect(pool).toContain(picked);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 28 - flap multiplier trip vs the extension cap.
// ---------------------------------------------------------------------------
describe('Round 28 - flap multiplier trip vs the extension cap', () => {
  it('applies the 3x penalty and never lets a failing probe shrink it', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'flap-cap', model: 'm' };
    const st = b.getStatus(ep);
    let now = 1000;
    // Three trips inside the flap window => the third carries the 3x penalty.
    // Only clear the state between the first two: clearing after the third
    // would clobber the penalty this round is meant to observe.
    for (let i = 0; i < 3; i++) {
      b.recordFailure(ep, 1, 1000, now);
      if (i < 2) {
        st.trippedUntil = null;
        st.trippedSince = null;
      }
      now += 1;
    }
    // Final trip at now=1002, multiplier 3 => trippedUntil 1002 + 3000 = 4002.
    expect(st.trippedUntil).toBe(4002);
    expect(st.trippedSince).toBe(1002);

    // A failing probe during that long cooldown: ceiling = 1002 + 2000 = 3002,
    // which is BELOW the current promise, so the promise must stand.
    b.recordFailure(ep, 1, 1000, 2000);
    expect(st.trippedUntil).toBe(4002);
    // Probe the still-tripped instant FIRST: isHealthy mutates on probation.
    expect(b.isHealthy(ep, 4001)).toBe(false);
    expect(b.isHealthy(ep, 4002)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 29 - clear() wipes state and the next probe is healthy again.
// ---------------------------------------------------------------------------
describe('Round 29 - clear()', () => {
  it('drops all health state so a tripped endpoint is healthy again', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'clr', model: 'm' };
    b.recordFailure(ep, 1, 60000, Date.now());
    expect(b.isHealthy(ep)).toBe(false);
    b.clear();
    expect(b.isHealthy(ep)).toBe(true);
    expect(Object.keys(b.getQuarantines())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round 30 - getQuarantines reflects live trips and drops elapsed ones.
// ---------------------------------------------------------------------------
describe('Round 30 - getQuarantines', () => {
  it('lists a live quarantine and removes it once the window elapses', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'q', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000);
    expect(b.getQuarantines(1000)).toEqual({ 'q::m': 2000 });
    // At/after trippedUntil it is no longer quarantined.
    expect(b.getQuarantines(2000)).toEqual({});
    expect(b.getQuarantines(2500)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Round 31 - round-robin over the filtered pool with a leading trip.
// ---------------------------------------------------------------------------
describe('Round 31 - round-robin fairness with a leading trip', () => {
  it('splits 300 cursors evenly across the remaining healthy members', () => {
    const b = new CircuitBreaker();
    const pool: Endpoint[] = [
      { provider: 'first', model: 'm' },
      { provider: 'second', model: 'm' },
      { provider: 'third', model: 'm' }
    ];
    b.recordFailure(pool[0], 1, 60000, Date.now()); // healthy pool = [second, third]
    const counts = new Map<string, number>();
    for (let cursor = 0; cursor < 300; cursor++) {
      const picked = pickNextEndpoint(pool, 'round-robin', cursor, b)!;
      counts.set(picked.provider, (counts.get(picked.provider) ?? 0) + 1);
    }
    expect(counts.get('first')).toBeUndefined();
    expect(counts.get('second')).toBe(150);
    expect(counts.get('third')).toBe(150);
  });
});
// ===========================================================================
// ROUND 3 - appended adversarial rounds (32+). Re-read against current HEAD.
// ===========================================================================

// ---------------------------------------------------------------------------
// Round 32 - guard PRECISION: the documented min-1 clamp for fractional weights.
// ---------------------------------------------------------------------------
describe('Round 32 - fractional weight min-1 clamp (guard precision)', () => {
  // Pinned expected-failure: genuinely RED today (see // BUG below).
  // (Originally an `it.fails` pin while the defect was live; now a real guard.)
  it('REGRESSION: a 0.5 weight is clamped up to 1 (docstring: minimum of 1)', () => {
    const half: Endpoint = { provider: 'half', model: 'm', weight: 0.5 };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    let halfCount = 0;
    const N = 1200; // buggy ~400 (1/3), correct ~600 (1/2): ~6 sigma apart
    for (let i = 0; i < N; i++) {
      if (pickWeighted([half, one]) === half) halfCount++;
    }
    // BUG: src/balancer.ts:23-26. The round-2 guard is
    //   typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1
    // which KEEPS 0.5 as 0.5. The round-1 code (Math.max(1, e.weight || 1))
    // and the docstring at src/balancer.ts:7 ('clamped to a minimum of 1')
    // both require 0.5 -> 1, i.e. an even 50/50 split. Observed: ~1/3 (133/400).
    // Fix: reinstate the floor after the finiteness guard,
    //   typeof w === 'number' && Number.isFinite(w) ? Math.max(1, w) : 1.
    expect(halfCount).toBeGreaterThanOrEqual(500);
    expect(halfCount).toBeLessThanOrEqual(700);
  });

  // Pinned expected-failure: same root cause, genuinely RED today.
  it('REGRESSION: a tiny positive weight (1e-300) must not starve the endpoint to zero', () => {
    const tiny: Endpoint = { provider: 'tiny', model: 'm', weight: 1e-300 };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    let tinyCount = 0;
    for (let i = 0; i < 20000; i++) {
      if (pickWeighted([tiny, one]) === tiny) tinyCount++;
    }
    // BUG: same root cause. 1e-300 is finite and > 0 so it survives the guard
    // unclamped; scaled = [1e-300, 1] and the endpoint is starved to 0 traffic
    // - exactly the 'zeroed out of the pool' outcome the min-1 clamp exists to
    // prevent (src/balancer.ts:7-9). Config-reachable: config.ts:93 accepts any
    // finite weight > 0. With the floor restored, expected ~10000.
    expect(tinyCount).toBeGreaterThan(9000);
  });
});

// ---------------------------------------------------------------------------
// Round 33 - the guard must NOT swallow a legitimate large finite weight.
// ---------------------------------------------------------------------------
describe('Round 33 - guard precision: legit weights pass through', () => {
  it('keeps a legitimate 1e6 weight dominant (not reduced to 1)', () => {
    const big: Endpoint = { provider: 'big', model: 'm', weight: 1e6 };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    let bigCount = 0;
    for (let i = 0; i < 2000; i++) {
      if (pickWeighted([big, one]) === big) bigCount++;
    }
    expect(bigCount).toBe(2000); // 1/1000001 chance the other wins
  });

  it('keeps weight 1 as 1 and 2 as 2 (exact ratio 1:2)', () => {
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    const two: Endpoint = { provider: 'two', model: 'm', weight: 2 };
    let twoCount = 0;
    for (let i = 0; i < 3000; i++) {
      if (pickWeighted([one, two]) === two) twoCount++;
    }
    expect(twoCount).toBeGreaterThan(1800); // expect ~2000
    expect(twoCount).toBeLessThan(2200);
  });
});

// ---------------------------------------------------------------------------
// Round 34 - guard precision: non-number shapes reduce to 1, in both positions.
// ---------------------------------------------------------------------------
describe('Round 34 - guard precision: non-number weights', () => {
  it('reduces string / null / undefined / boolean weights to 1 in either position', () => {
    const shapes: unknown[] = ['5', null, undefined, true];
    for (const raw of shapes) {
      const odd = { provider: 'odd', model: 'm', weight: raw } as unknown as Endpoint;
      const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
      let oddCount = 0;
      for (let i = 0; i < 400; i++) {
        if (pickWeighted([odd, one]) === odd) oddCount++;
      }
      expect(oddCount).toBeGreaterThan(120);
      expect(oddCount).toBeLessThan(280);
    }
  });

  it('reduces negative zero to 1 (-0 > 0 is false)', () => {
    const negZero: Endpoint = { provider: 'negzero', model: 'm', weight: -0 };
    const one: Endpoint = { provider: 'one', model: 'm', weight: 1 };
    let c = 0;
    for (let i = 0; i < 400; i++) {
      if (pickWeighted([negZero, one]) === negZero) c++;
    }
    expect(c).toBeGreaterThan(120);
    expect(c).toBeLessThan(280);
  });
});

// ---------------------------------------------------------------------------
// Round 35 - all-Infinity weights reduce to a uniform pool.
// ---------------------------------------------------------------------------
describe('Round 35 - all-Infinity weights', () => {
  it('treats every Infinity weight as 1 and splits uniformly', () => {
    const pool: Endpoint[] = [
      { provider: 'a', model: 'm', weight: Infinity },
      { provider: 'b', model: 'm', weight: Infinity },
      { provider: 'c', model: 'm', weight: Infinity }
    ];
    const counts = new Map<string, number>([['a', 0], ['b', 0], ['c', 0]]);
    for (let i = 0; i < 3000; i++) {
      const picked = pickWeighted(pool)!;
      counts.set(picked.provider, counts.get(picked.provider)! + 1);
    }
    for (const p of ['a', 'b', 'c']) {
      expect(counts.get(p)!).toBeGreaterThan(800);
      expect(counts.get(p)!).toBeLessThan(1200);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 36 - the spread arity cliff survives the guard (guard bounds values,
// not array length).
// ---------------------------------------------------------------------------
describe('Round 36 - spread arity cliff', () => {
  // Pinned expected-failure: genuinely RED today (low severity, see // BUG).
  it('REGRESSION: a 150k-endpoint pool does not overflow the scale computation', () => {
    const pool: Endpoint[] = Array.from({ length: 150000 }, (_, i) => ({
      provider: 'e' + i,
      model: 'm',
      weight: 1
    }));
    // BUG: src/balancer.ts:35. Math.max(...weights) spreads every weight as an
    // argument; V8 caps arguments near ~125k and throws
    // RangeError: Maximum call stack size exceeded. The round-2 guard bounds
    // the VALUES (finite positive) but not the ARITY, so the cliff remains.
    // Fix: replace the spread with a reduce,
    //   const scale = weights.reduce((m, w) => (w > m ? w : m), 0);
    // Low severity: only reachable with a ~150k-entry endpoint config.
    expect(() => pickWeighted(pool)).not.toThrow();
  });

  it('handles a realistic 100k pool without throwing', () => {
    const pool: Endpoint[] = Array.from({ length: 100000 }, (_, i) => ({
      provider: 'e' + i,
      model: 'm',
      weight: 1
    }));
    let picked: Endpoint | null = null;
    expect(() => { picked = pickWeighted(pool); }).not.toThrow();
    expect(pool).toContain(picked);
  });
});
// ---------------------------------------------------------------------------
// Round 37 - cooldown 0 during an ACTIVE cooldown must not shrink the promise.
// ---------------------------------------------------------------------------
describe('Round 37 - cooldown 0 during an active cooldown', () => {
  it('extends by zero but never shrinks the current promise', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'cd0', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000); // trippedUntil 2000
    expect(b.getStatus(ep).trippedUntil).toBe(2000);
    // now + cooldown = 1500, ceiling = 1000 + 0 = 1000 => min(1500,1000)=1000,
    // max(2000,1000) = 2000: the existing promise stands.
    expect(b.recordFailure(ep, 1, 0, 1500)).toBe(true);
    expect(b.getStatus(ep).trippedUntil).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Round 38 - fractional cooldown cap boundary.
// ---------------------------------------------------------------------------
describe('Round 38 - fractional cooldown cap', () => {
  it('caps at trippedSince + cooldown*2 with fractional ms', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'cdf', model: 'm' };
    b.recordFailure(ep, 1, 0.5, 1000); // until 1000.5, since 1000, ceiling 1001
    expect(b.getStatus(ep).trippedUntil).toBe(1000.5);
    b.recordFailure(ep, 1, 0.5, 1000.2); // min(1000.7, 1001) = 1000.7
    expect(b.getStatus(ep).trippedUntil).toBeCloseTo(1000.7, 10);
  });
});

// ---------------------------------------------------------------------------
// Round 39 - trippedSince ABSENT (undefined, not null) while trippedUntil set.
// ---------------------------------------------------------------------------
describe('Round 39 - trippedSince absent', () => {
  it('falls back to trippedUntil and never shrinks the window', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'nosince', model: 'm' };
    const st = b.getStatus(ep);
    st.trippedUntil = 5000;
    delete st.trippedSince;
    expect(b.recordFailure(ep, 1, 1000, 2000)).toBe(true);
    // tripStart = trippedUntil = 5000; min(3000, 7000) = 3000; max(5000,3000)=5000.
    expect(st.trippedUntil).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Round 40 - recordAccountFailure degenerate inputs.
// ---------------------------------------------------------------------------
describe('Round 40 - recordAccountFailure degenerate inputs', () => {
  it('returns [] for an empty endpoint list and trips nothing', () => {
    const b = new CircuitBreaker();
    expect(b.recordAccountFailure('p', [], 1000, 1000)).toEqual([]);
    expect(Object.keys(b.getQuarantines(1000))).toHaveLength(0);
  });

  it('returns [] when no endpoint matches the provider', () => {
    const b = new CircuitBreaker();
    const other: Endpoint = { provider: 'other', model: 'm' };
    expect(b.recordAccountFailure('nope', [other], 1000, 1000)).toEqual([]);
    expect(b.isHealthy(other, 1000)).toBe(true);
  });

  it('trips every matching endpoint (threshold 1) and leaves others healthy', () => {
    const b = new CircuitBreaker();
    const a1: Endpoint = { provider: 'prov', model: 'm1' };
    const a2: Endpoint = { provider: 'prov', model: 'm2' };
    const other: Endpoint = { provider: 'other', model: 'm' };
    const tripped = b.recordAccountFailure('prov', [a1, a2, other], 1000, 1000);
    expect(tripped).toEqual([a1, a2]);
    expect(b.isHealthy(a1, 1000)).toBe(false);
    expect(b.isHealthy(a2, 1000)).toBe(false);
    expect(b.isHealthy(other, 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 41 - getQuarantines / applyQuarantines round-trip stability.
// ---------------------------------------------------------------------------
describe('Round 41 - quarantine round-trip stability', () => {
  it('is idempotent across 50 apply cycles (no drift, no time decay)', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'rt', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000);
    const snapshot = b.getQuarantines(1000);
    expect(snapshot).toEqual({ 'rt::m': 2000 });
    for (let i = 0; i < 50; i++) {
      b.applyQuarantines(JSON.parse(JSON.stringify(snapshot)), 1000);
    }
    expect(b.getStatus(ep).trippedUntil).toBe(2000);
    expect(b.getQuarantines(1000)).toEqual(snapshot);
  });

  it('excludes an endpoint whose trippedUntil equals now (strict inequality)', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'q', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000);
    expect(b.getQuarantines(2000)).toEqual({}); // now === trippedUntil
    expect(b.getQuarantines(1999)).toEqual({ 'q::m': 2000 });
  });
});

// ---------------------------------------------------------------------------
// Round 42 - long-lived accumulate-then-reset (100 trip/probation cycles).
// ---------------------------------------------------------------------------
describe('Round 42 - long-lived cycles', () => {
  it('keeps the endpoint reachable after 100 trip/probation cycles', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'cycle', model: 'm' };
    let now = 0;
    for (let i = 0; i < 100; i++) {
      now += 10;
      b.recordFailure(ep, 1, 1000, now);
      expect(b.isHealthy(ep, now)).toBe(false);
      // Wait past the FLAP 3x penalty (3000ms), not just one base cooldown:
      // after 3 in-window trips the cooldown is 1000 * FLAP_COOLDOWN_MULTIPLIER.
      now += 3000;
      expect(b.isHealthy(ep, now)).toBe(true); // probation clears the trip
    }
    expect(b.getStatus(ep).trippedUntil).toBeNull();
    expect(b.isHealthy(ep)).toBe(true);
  });

  it('a success mid-cycle fully resets the flapping history', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'reset', model: 'm' };
    let now = 1000;
    for (let i = 0; i < 3; i++) {
      b.recordFailure(ep, 1, 1, now);
      b.getStatus(ep).trippedUntil = null;
      b.getStatus(ep).trippedSince = null;
      now += 1;
    }
    expect(b.getStatus(ep).recentTrips!.length).toBe(3);
    b.recordSuccess(ep);
    expect(b.getStatus(ep).recentTrips).toEqual([]);
    expect(b.getStatus(ep).consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round 43 - flap window boundary is strict (<) not inclusive.
// ---------------------------------------------------------------------------
describe('Round 43 - flap window boundary', () => {
  it('prunes a trip exactly FLAP_WINDOW_MS old (strict <) but keeps newer ones', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'fwb', model: 'm' };
    const st = b.getStatus(ep);
    const base = 1000000;
    // Two old trips at base and base+1, then a new trip 600000 later.
    b.recordFailure(ep, 1, 1, base);
    st.trippedUntil = null; st.trippedSince = null;
    b.recordFailure(ep, 1, 1, base + 1);
    st.trippedUntil = null; st.trippedSince = null;
    const now = base + 600000; // exactly 600000 after the first trip
    b.recordFailure(ep, 1, 1, now);
    // base (now - t = 600000) is pruned (not < 600000); base+1 (599999) is kept.
    expect(st.recentTrips!.length).toBe(2);
    expect(st.recentTrips).toEqual([base + 1, now]);
  });
});

// ---------------------------------------------------------------------------
// Round 44 - isHealthy mutation precision: filterHealthy transitions exactly
// the lapsed entries and leaves un-tripped ones untouched.
// ---------------------------------------------------------------------------
describe('Round 44 - filterHealthy probation precision', () => {
  it('transitions only the lapsed trip and preserves a still-active trip', () => {
    const b = new CircuitBreaker();
    const lapsed: Endpoint = { provider: 'lapsed', model: 'm' };
    const active: Endpoint = { provider: 'active', model: 'm' };
    b.recordFailure(lapsed, 1, 1000, 1000); // until 2000
    b.recordFailure(active, 1, 100000, 1000); // until 101000
    const pool = [lapsed, active];
    // Only `lapsed` has recovered at now=2000; `active` is still tripped, so it
    // is excluded from the healthy subset.
    const out = b.filterHealthy(pool, 2000);
    expect(out).toEqual([lapsed]);
    // The lapsed trip was cleared (probation); the active trip was not.
    expect(b.getStatus(lapsed).trippedUntil).toBeNull();
    expect(b.getStatus(active).trippedUntil).toBe(101000);
    expect(b.isHealthy(active, 2000)).toBe(false);
  });

  it('does not transition a trip one ms before it lapses', () => {
    const b = new CircuitBreaker();
    const ep: Endpoint = { provider: 'almost', model: 'm' };
    b.recordFailure(ep, 1, 1000, 1000); // until 2000
    expect(b.filterHealthy([ep], 1999)).toEqual([ep]); // degraded full pool
    expect(b.getStatus(ep).trippedUntil).toBe(2000); // still tripped
    expect(b.isHealthy(ep, 2000)).toBe(true); // now lapses
  });
});

// ---------------------------------------------------------------------------
// Round 45 - pickNextEndpoint weighted path inherits the fractional regression.
// ---------------------------------------------------------------------------
describe('Round 45 - weighted routing with a fractional weight', () => {
  // Pinned expected-failure: same root cause via the routing entry point.
  it('REGRESSION: a 0.5-weight endpoint is not under-selected through pickNextEndpoint', () => {
    const b = new CircuitBreaker();
    const pool: Endpoint[] = [
      { provider: 'half', model: 'm', weight: 0.5 },
      { provider: 'one', model: 'm', weight: 1 }
    ];
    let halfCount = 0;
    const N = 1200;
    for (let i = 0; i < N; i++) {
      if (pickNextEndpoint(pool, 'weighted', 0, b) === pool[0]) halfCount++;
    }
    // BUG: same root cause as Round 32, reached through the real routing entry
    // point. The documented min-1 clamp should give ~600/1200; observed ~400.
    expect(halfCount).toBeGreaterThanOrEqual(500);
    expect(halfCount).toBeLessThanOrEqual(700);
  });
});




