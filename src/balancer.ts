import type { Endpoint, RoutingStrategy } from './types.js';
import { CircuitBreaker, defaultCircuitBreaker } from './health.js';

export function pickWeighted(endpoints: Endpoint[]): Endpoint {
  const weights = endpoints.map((e) => Math.max(1, e.weight || 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let randomVal = Math.random() * totalWeight;

  for (let i = 0; i < endpoints.length; i++) {
    randomVal -= weights[i];
    if (randomVal <= 0) {
      return endpoints[i];
    }
  }
  return endpoints[0];
}

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

  if (strategy === 'random') {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (strategy === 'weighted') {
    return pickWeighted(pool);
  }

  // Default: round-robin
  const index = Math.abs(cursor) % pool.length;
  return pool[index];
}
