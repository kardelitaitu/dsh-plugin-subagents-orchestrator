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
  /**
   * When the CURRENT trip began. Anchors the in-cooldown extension ceiling so
   * repeated probing cannot push recovery out indefinitely.
   */
  trippedSince?: number | null;
  /**
   * Timestamps of recent trips (v2 flapping guard). Pruned against
   * FLAP_WINDOW_MS on every trip; an endpoint exceeding
   * FLAP_TRIP_THRESHOLD within the window draws the extended penalty.
   */
  recentTrips?: number[];
}

/** Consecutive failures tolerated before an endpoint is tripped. */
export const DEFAULT_MAX_FAILURES = 3;
/** How long a tripped endpoint stays out of rotation (ms) - 60 minutes default. */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;
/** Flapping guard: trips within FLAP_WINDOW_MS that trigger the penalty. */
export const FLAP_TRIP_THRESHOLD = 3;
/** Flapping guard: how far back trips are counted (ms). */
export const FLAP_WINDOW_MS = 10 * 60_000;
/** Flapping guard: penalty cooldown multiplier once flapping is detected. */
export const FLAP_COOLDOWN_MULTIPLIER = 3;

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
        lastFailureAt: null,
        trippedSince: null
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
      // Cooldown window elapsed: probationary recovery. Clearing trippedSince
      // gives any subsequent trip a fresh extension ceiling.
      status.trippedUntil = null;
      status.trippedSince = null;
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
      // Failed again during cooldown. The window may extend from this failure
      // but can never shrink below the current promise (a provider hint's
      // remaining tail wins over a shorter default cooldown).
      //
      // It is CAPPED, though: anchoring unconditionally on `now + cooldown`
      // let our own probe traffic (filterHealthy's degraded fallback keeps
      // trying a fully-tripped pool) push the window out by one cooldown per
      // failure, so the endpoint never reached probation. The ceiling is one
      // cooldown past the *original* trip, which still honours a longer
      // provider hint while guaranteeing eventual recovery.
      // Two invariants, both required:
      //   1. Never shrink below the current promise - a shorter cooldown
      //      arriving late must not cut a longer committed window short.
      //   2. Never extend past a bounded horizon from THIS trip's start, or
      //      our own degraded-pool probe traffic re-anchors the window on
      //      every failure and the endpoint never reaches probation.
      // Capping the extension (not the promise) satisfies both: an existing
      // promise stands, but nothing can push it further once the ceiling is
      // reached, so it expires and the endpoint is probed again.
      const tripStart = status.trippedSince ?? status.trippedUntil;
      const ceiling = tripStart + cooldown * 2;
      status.trippedUntil = Math.max(status.trippedUntil, Math.min(now + cooldown, ceiling));
      return true;
    }

    if (status.consecutiveFailures >= threshold) {
      // Flapping guard (v2): prune the trip history, record this trip, and
      // when the endpoint trips too often within the window, apply the
      // extended penalty — a rapidly cycling endpoint needs a longer rest
      // than a clean single cooldown, or it hogs the probation slots.
      const trips = (status.recentTrips ?? []).filter((t) => now - t < FLAP_WINDOW_MS);
      trips.push(now);
      status.recentTrips = trips;
      const multiplier = trips.length >= FLAP_TRIP_THRESHOLD ? FLAP_COOLDOWN_MULTIPLIER : 1;
      status.trippedUntil = now + cooldown * multiplier;
      status.trippedSince = now;
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
      status.trippedSince = null;
      status.recentTrips = []; // a clean probationary success ends any flapping episode
    }
  }

  /**
   * Account-level trip: when a provider hits an account-wide limit (QUOTA, 429,
   * INVALID_CREDENTIAL), trip all endpoints belonging to that provider simultaneously.
   *
   * @returns array of endpoints that were tripped.
   */
  public recordAccountFailure(
    provider: string,
    allEndpoints: Endpoint[],
    cooldownMs: number = DEFAULT_COOLDOWN_MS,
    now: number = Date.now()
  ): Endpoint[] {
    const matching = allEndpoints.filter((e) => e.provider === provider);
    for (const ep of matching) {
      this.recordFailure(ep, 1, cooldownMs, now);
    }
    return matching;
  }

  /**
   * Manually reset an endpoint or an entire provider from quarantine.
   * Restores health immediately, clearing failure streaks and flapping records.
   */
  public resetEndpoint(provider: string, model?: string): void {
    if (model) {
      this.recordSuccess({ provider, model });
    } else {
      const prefix = `${provider}::`;
      for (const [key, status] of this.healthMap.entries()) {
        if (key.startsWith(prefix)) {
          status.consecutiveFailures = 0;
          status.trippedUntil = null;
          status.trippedSince = null;
          status.recentTrips = [];
        }
      }
    }
  }

  /** Get a snapshot of all currently quarantined endpoint keys and their expiry timestamps. */
  public getQuarantines(now: number = Date.now()): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, status] of this.healthMap.entries()) {
      if (status.trippedUntil !== null && now < status.trippedUntil) {
        result[key] = status.trippedUntil;
      }
    }
    return result;
  }

  /** Hydrate quarantines from persisted config (e.g. across process restarts). */
  public applyQuarantines(quarantines: Record<string, number> | undefined, now: number = Date.now()): void {
    if (!quarantines || typeof quarantines !== 'object') return;
    for (const [key, status] of this.healthMap.entries()) {
      if (status.trippedUntil !== null && (!quarantines[key] || quarantines[key] <= now)) {
        status.trippedUntil = null;
        status.trippedSince = null;
        status.consecutiveFailures = 0;
      }
    }
    for (const [key, trippedUntil] of Object.entries(quarantines)) {
      if (typeof trippedUntil === 'number' && trippedUntil > now) {
        let status = this.healthMap.get(key);
        if (!status) {
          status = {
            consecutiveFailures: DEFAULT_MAX_FAILURES,
            trippedUntil,
            lastFailureAt: now,
            trippedSince: now
          };
          this.healthMap.set(key, status);
        } else {
          // Adopt the snapshot verbatim: applyQuarantines is the authoritative
          // "here is the current state" call, so a shorter window must win.
          // (Extend-only semantics live in recordFailure, where a failing probe
          // during cooldown may lengthen but never shrink the promise.)
          status.trippedUntil = trippedUntil;
          status.consecutiveFailures = Math.max(status.consecutiveFailures, DEFAULT_MAX_FAILURES);
        }
      }
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

/**
 * Compute cooldown duration (ms) aligned to the top of the next clock hour (:00)
 * plus a grace period (default 60s), ensuring a minimum cooldown window (default 5m).
 */
export function computeHourlyAlignedCooldown(
  now: number = Date.now(),
  graceMs: number = 60_000,
  minMs: number = 5 * 60_000
): number {
  const hourMs = 60 * 60_000;
  const currentHourStart = Math.floor(now / hourMs) * hourMs;
  let target = currentHourStart + hourMs + graceMs;
  if (target - now < minMs) {
    target += hourMs;
  }
  return Math.max(minMs, target - now);
}

/** Shared breaker instance used by the plugin runtime. */
export const defaultCircuitBreaker = new CircuitBreaker();
