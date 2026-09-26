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

  // Every weight is reduced to a usable finite number >= 1 (the documented
  // minimum, see the docstring above). Two separate hazards meet on this line:
  //
  //  - Non-finite: an Infinity weight made scale Infinity, every scaled weight
  //    NaN or 0, totalWeight NaN, the loop guard unreachable, and every pick
  //    fell through to the last bucket. Not config-reachable (schemastery
  //    coerces Infinity to null) but pickWeighted is exported, so reduce it
  //    here anyway.
  //  - Sub-1 positive: 0.5 or 1e-300 is finite and > 0, so a bare "is it
  //    positive" test let it through and a tiny weight starved its endpoint to
  //    exactly 0 traffic — the precise outcome the min-1 clamp exists to
  //    prevent, and config-reachable (config.ts accepts any finite weight > 0).
  //
  // So: reject non-finite first, THEN apply the floor.
  const weights = endpoints.map((e) => {
    const w = e.weight;
    return typeof w === 'number' && Number.isFinite(w) ? Math.max(1, w) : 1;
  });

  // Scale-normalize before summing. Selection probabilities are ratios, so
  // dividing every weight by the largest one is behavior-preserving — but it
  // bounds the sum by the endpoint count, so it can never overflow. Summing
  // raw weights did: two finite 1e308 values add to Infinity, which made
  // randomVal Infinity, the loop guard never true, and every pick fall through
  // to the last endpoint (total starvation of the others). Such weights are
  // accepted by the config schema, so this was reachable in practice.
  // reduce, not spread: Math.max(...weights) hits V8's argument-count ceiling
  // (RangeError) at roughly 125k entries, which the value clamp cannot bound.
  const scale = weights.reduce((max, w) => (w > max ? w : max), 0);
  const scaled = weights.map((w) => w / scale);
  const totalWeight = scaled.reduce((sum, w) => sum + w, 0);
  let randomVal = Math.random() * totalWeight;

  for (let i = 0; i < endpoints.length; i++) {
    randomVal -= scaled[i];
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
      // NaN or Infinity cursors (bad caller math) must degrade to the start
      // of the pool, not resolve to `undefined` through NaN modulo.
      const safeCursor = Number.isFinite(cursor) ? Math.abs(Math.trunc(cursor)) : 0;
      const index = safeCursor % pool.length;
      return pool[index];
    }
  }
}
