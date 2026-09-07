import type { Endpoint } from './types.js';

/**
 * Health bookkeeping for a single endpoint (identified by its provider::model pair).
 *
 * - `consecutiveFailures`: failures recorded since the last success. The count is
 *   retained across a cooldown expiry (probationary recovery), so a recovered
 *   endpoint that fails again is re-tripped immediately instead of needing a
 *   fresh streak.
 * - `trippedUntil`: wall-clock timestamp (ms) until which the endpoint is kept
 *   out of rotation; `null` while it is eligible for traffic.
 * - `lastFailureAt`: timestamp of the most recent recorded failure.
 */
export interface EndpointHealthStatus {
  consecutiveFailures: number;
  trippedUntil: number | null;
  lastFailureAt: number | null;
}

/** Consecutive failures tolerated before an endpoint is tripped. */
export const DEFAULT_MAX_FAILURES = 3;
/** How long a tripped endpoint stays out of rotation (ms). */
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Per-endpoint circuit breaker.
 *
 * States (implicit, derived from `EndpointHealthStatus`):
 * - **closed** (healthy): `trippedUntil === null`. Failures accumulate in
 *   `consecutiveFailures`; reaching `maxFailures` opens the circuit.
 * - **open** (tripped): `now < trippedUntil`. The endpoint is excluded from
 *   rotation and every probe reports unhealthy.
 * - **half-open** (probation): the cooldown has elapsed. Probes report healthy
 *   again; the next real result decides — a success closes the circuit and
 *   resets the failure streak, a failure re-trips it on the spot.
 *
 * Fallback protection: `filterHealthy` never starves the caller — when every
 * endpoint is tripped it degrades gracefully and returns the full pool, so
 * live traffic can still reach a recovering endpoint (and its success/failure
 * result feeds the breaker again).
 */
export class CircuitBreaker {
  private healthMap = new Map<string, EndpointHealthStatus>();

  /** Stable identity for an endpoint: its provider::model pair. */
  public getEndpointKey(endpoint: Endpoint): string {
    return `${endpoint.provider}::${endpoint.model}`;
  }

  /** Get (creating if absent) the health record for an endpoint. */
  public getStatus(endpoint: Endpoint): EndpointHealthStatus {
    const key = this.getEndpointKey(endpoint);
    let status = this.healthMap.get(key);
    if (!status) {
      status = {
        consecutiveFailures: 0,
        trippedUntil: null,
        lastFailureAt: null
      };
      this.healthMap.set(key, status);
    }
    return status;
  }

  /**
   * Whether the endpoint may serve traffic at instant `now`.
   *
   * An elapsed cooldown transitions the endpoint back into rotation
   * (probation): `trippedUntil` is cleared, while `consecutiveFailures` is
   * deliberately retained so the very next failure re-trips the endpoint.
   */
  public isHealthy(endpoint: Endpoint, now: number = Date.now()): boolean {
    const status = this.getStatus(endpoint);
    if (status.trippedUntil === null) return true;
    if (now >= status.trippedUntil) {
      // Cooldown window elapsed: probationary recovery.
      status.trippedUntil = null;
      return true;
    }
    return false;
  }

  /**
   * Record a failed request against the endpoint.
   *
   * A failure arriving while the endpoint is already tripped (only possible
   * through the all-tripped degradation fallback) re-arms the cooldown window
   * from the newest failure, so the remaining window can never shrink.
   *
   * @returns `true` when this failure (re)tripped the endpoint.
   */
  public recordFailure(
    endpoint: Endpoint,
    maxFailures: number = DEFAULT_MAX_FAILURES,
    cooldownMs: number = DEFAULT_COOLDOWN_MS,
    now: number = Date.now()
  ): boolean {
    const status = this.getStatus(endpoint);
    status.consecutiveFailures += 1;
    status.lastFailureAt = now;

    const threshold = Math.max(1, maxFailures);
    const cooldown = Math.max(0, cooldownMs);

    if (status.trippedUntil !== null && now < status.trippedUntil) {
      // Failed again during cooldown: the window may extend from this
      // failure but can never shrink below the current promise (a provider
      // hint's remaining tail wins over a shorter default cooldown).
      status.trippedUntil = Math.max(status.trippedUntil, now + cooldown);
      return true;
    }

    if (status.consecutiveFailures >= threshold) {
      status.trippedUntil = now + cooldown;
      return true;
    }
    return false;
  }

  /** Record a successful request: closes the circuit and clears the streak. */
  public recordSuccess(endpoint: Endpoint): void {
    const key = this.getEndpointKey(endpoint);
    const status = this.healthMap.get(key);
    if (status) {
      status.consecutiveFailures = 0;
      status.trippedUntil = null;
    }
  }

  /**
   * The healthy subset of `endpoints`, preserving input order.
   *
   * Fallback protection: if *every* endpoint is currently tripped, the full
   * list is returned instead of an empty pool — a degraded attempt beats a
   * hard stall, and the outcome still feeds the breaker.
   */
  public filterHealthy(endpoints: Endpoint[], now: number = Date.now()): Endpoint[] {
    if (endpoints.length === 0) return [];
    const healthy = endpoints.filter((e) => this.isHealthy(e, now));
    return healthy.length > 0 ? healthy : endpoints;
  }

  /** Forget all recorded health state. */
  public clear(): void {
    this.healthMap.clear();
  }
}

/** Shared breaker instance used by the plugin runtime. */
export const defaultCircuitBreaker = new CircuitBreaker();
