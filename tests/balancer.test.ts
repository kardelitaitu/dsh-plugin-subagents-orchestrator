import { describe, it, expect } from 'vitest';
import { pickNextEndpoint, pickWeighted } from '../src/balancer.js';
import { CircuitBreaker } from '../src/health.js';
import type { Endpoint } from '../src/types.js';

describe('Balancer & Routing Strategies', () => {
  const endpoints: Endpoint[] = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' }
  ];

  it('should return null for empty endpoints', () => {
    expect(pickNextEndpoint([])).toBeNull();
  });

  it('should balance with round-robin strategy', () => {
    const breaker = new CircuitBreaker();
    const first = pickNextEndpoint(endpoints, 'round-robin', 0, breaker);
    const second = pickNextEndpoint(endpoints, 'round-robin', 1, breaker);
    const third = pickNextEndpoint(endpoints, 'round-robin', 2, breaker);
    const fourth = pickNextEndpoint(endpoints, 'round-robin', 3, breaker);

    expect(first).toEqual(endpoints[0]);
    expect(second).toEqual(endpoints[1]);
    expect(third).toEqual(endpoints[2]);
    expect(fourth).toEqual(endpoints[0]);
  });

  it('should pick from pool with random strategy', () => {
    const breaker = new CircuitBreaker();
    const picked = pickNextEndpoint(endpoints, 'random', 0, breaker);
    expect(endpoints).toContainEqual(picked);
  });

  it('should bypass tripped endpoints in round-robin rotation', () => {
    const breaker = new CircuitBreaker();
    // Trip endpoint 2
    breaker.recordFailure(endpoints[1], 1, 60000);

    const first = pickNextEndpoint(endpoints, 'round-robin', 0, breaker);
    const second = pickNextEndpoint(endpoints, 'round-robin', 1, breaker);

    expect(first).toEqual(endpoints[0]);
    expect(second).toEqual(endpoints[2]); // Skips p2
  });

  it('should support weighted endpoint selection', () => {
    const weightedEndpoints: Endpoint[] = [
      { provider: 'heavy', model: 'm1', weight: 100 },
      { provider: 'light', model: 'm2', weight: 1 }
    ];

    let heavyCount = 0;
    for (let i = 0; i < 50; i++) {
      const picked = pickWeighted(weightedEndpoints);
      if (picked.provider === 'heavy') heavyCount++;
    }

    expect(heavyCount).toBeGreaterThan(40);
  });

  it('pickWeighted should return null for an empty pool', () => {
    expect(pickWeighted([])).toBeNull();
  });

  it('pickWeighted should treat missing, zero and NaN weights as weight 1', () => {
    const odd: Endpoint[] = [
      { provider: 'zero', model: 'm1', weight: 0 },
      { provider: 'nan', model: 'm2', weight: Number.NaN },
      { provider: 'missing', model: 'm3' }
    ];
    for (let i = 0; i < 20; i++) {
      const picked = pickWeighted(odd);
      expect(odd).toContainEqual(picked);
    }
  });

  it('should keep round-robin cursor continuous when a pool member is tripped', () => {
    const breaker = new CircuitBreaker();
    // Trip p1 so the healthy pool becomes [p2, p3]
    breaker.recordFailure(endpoints[0], 1, 60000);

    expect(pickNextEndpoint(endpoints, 'round-robin', 0, breaker)).toEqual(endpoints[1]);
    expect(pickNextEndpoint(endpoints, 'round-robin', 1, breaker)).toEqual(endpoints[2]);
    // Cursor wraps over the *pool*, not the original list
    expect(pickNextEndpoint(endpoints, 'round-robin', 2, breaker)).toEqual(endpoints[1]);
  });

  it('should sanitize non-integer and negative round-robin cursors', () => {
    const breaker = new CircuitBreaker();
    expect(pickNextEndpoint(endpoints, 'round-robin', -1, breaker)).toEqual(endpoints[1]);
    expect(pickNextEndpoint(endpoints, 'round-robin', -4, breaker)).toEqual(endpoints[1]);
    expect(pickNextEndpoint(endpoints, 'round-robin', 2.9, breaker)).toEqual(endpoints[2]);
  });

  it('should degrade unknown strategies to round-robin', () => {
    const breaker = new CircuitBreaker();
    const picked = pickNextEndpoint(
      endpoints,
      'mystery-strategy' as any,
      1,
      breaker
    );
    expect(picked).toEqual(endpoints[1]);
  });
});
