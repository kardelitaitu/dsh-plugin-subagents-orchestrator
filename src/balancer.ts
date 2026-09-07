import type { Endpoint, RoutingStrategy } from './types.js';
import { CircuitBreaker, defaultCircuitBreaker } from './health.js';

/**
 * Weighted random selection.
 *
 * Each endpoint participates with `weight` (clamped to a minimum of 1, so a
 * zero/NaN weight can never zero an endpoint out of the pool). An endpoint
 * carrying weight W is picked with probability W / totalWeight.
 *
 * @returns the picked endpoint, or `null` for an empty pool.
 */
export function pickWeighted(endpoints: Endpoint[]): Endpoint | null {
  if (!endpoints || endpoints.length === 0) return null;

  const weights = endpoints.map((e) => Math.max(1, e.weight || 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let randomVal = Math.random() * totalWeight;

  for (let i = 0; i < endpoints.length; i++) {
    randomVal -= weights[i];
    if (randomVal <= 0) {
      return endpoints[i];
    }
  }
  // Float-safety: the last bucket always absorbs the remainder.
  return endpoints[endpoints.length - 1];
}

/**
 * Pick the next endpoint from the pool using the configured strategy.
 *
 * Selection order:
 * 1. Circuit-breaker health filter — tripped endpoints are bypassed while any
 *    healthy endpoint remains; if all are tripped the breaker's degradation
 *    fallback keeps the whole pool available.
 * 2. Strategy over the healthy pool:
 *    - `round-robin`: `cursor` positions into the pool and wraps around.
 *    - `random`: uniform pick.
 *    - `weighted`: weight-proportional random pick (`cursor` unused).
 *    Unknown strategy names degrade to round-robin rather than failing.
 *
 * @returns the picked endpoint, or `null` when the pool is empty.
 */
export function pickNextEndpoint(
  endpoints: Endpoint[],
  strategy: RoutingStrategy = 'round-robin',
  cursor: number = 0,
  breaker: CircuitBreaker = defaultCircuitBreaker
): Endpoint | null {
  if (!endpoints || endpoints.length === 0) return null;

  // Filter for healthy endpoints using circuit breaker
  const pool = breaker.filterHealthy(endpoints);
  if (pool.length === 0) return null;

  switch (strategy) {
    case 'random':
      return pool[Math.floor(Math.random() * pool.length)];

    case 'weighted':
      return pickWeighted(pool);

    case 'round-robin':
    default: {
      const index = Math.abs(Math.trunc(cursor)) % pool.length;
      return pool[index];
    }
  }
}
