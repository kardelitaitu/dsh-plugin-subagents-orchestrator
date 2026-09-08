interface EndpointStats {
    key: string;
    provider: string;
    model: string;
    /** Requests seen routed through this endpoint. */
    requests: number;
    /** Failure events attributed to this endpoint. */
    failures: number;
    /** Times this endpoint was chosen as a failover target. */
    failovers: number;
    /** Provider cooldown hints (Retry-After / x-ratelimit-reset) applied. */
    cooldownHints: number;
    lastFailureAt: number | null;
    lastFailureCode: string | null;
    /** Failure-latency samples recorded for this endpoint. */
    latencySamples: number;
    /** Sum of failure-latency samples (ms); divide by latencySamples for the mean. */
    latencyTotalMs: number;
    /** Longest observed failure latency (ms). */
    latencyMaxMs: number;
    /** Most recent failure latency (ms), or null before the first sample. */
    lastLatencyMs: number | null;
}

/**
 * Read-only diagnostics snapshot over the plugin's live state: the effective
 * routing pool, per-endpoint circuit-breaker health and telemetry counters.
 *
 * Strictly non-mutating by design — in particular it derives endpoint health
 * from the breaker's stored status instead of calling `isHealthy()`, which
 * transitions tripped endpoints to probation (a state write) as a side
 * effect. Probing diagnostics must never change routing behavior.
 */
interface BreakerDiagnostics {
    /** Whether the endpoint may serve traffic at snapshot time (derived, no mutation). */
    healthy: boolean;
    /** Wall-clock ms until which the endpoint is tripped, or null when eligible. */
    trippedUntil: number | null;
    consecutiveFailures: number;
    lastFailureAt: number | null;
}
interface EndpointDiagnostics {
    /** `provider::model` identity, matching telemetry keys. */
    key: string;
    provider: string;
    model: string;
    /** `false` when parked via `enabled: false` (in config, out of the pool). */
    inPool: boolean;
    breaker: BreakerDiagnostics;
    telemetry: Pick<EndpointStats, 'requests' | 'failures' | 'failovers' | 'cooldownHints' | 'latencySamples' | 'latencyTotalMs' | 'latencyMaxMs' | 'lastLatencyMs'>;
}
interface DiagnosticsSnapshot {
    generatedAt: number;
    /** Whether a settings snapshot is loaded (a missing file counts as loaded). */
    configPresent: boolean;
    /** Effective runtime switches, exactly as the plugin treats them. */
    orchestration: {
        /** Routing is active (`enabled` unset or true). */
        active: boolean;
        strategy: string;
        /** Auto-failover on error is engaged (`failover: true`). */
        failover: boolean;
        cooldownMs: number;
        maxFailures: number;
        retryIntervalMinMs: number;
        retryIntervalMaxMs: number;
    };
    /** Opt-in UI gates, exactly as configured (both false when unset). */
    ui: {
        toasts: boolean;
        panel: boolean;
    };
    /** Number of endpoints in the effective pool (parked endpoints excluded). */
    effectivePoolSize: number;
    /** Full configured endpoint list, including parked entries. */
    endpoints: EndpointDiagnostics[];
}
/**
 * Capture the current plugin state as a plain JSON-serializable snapshot.
 *
 * Safe to call at any point in the plugin lifecycle — including before
 * `apply()` and after dispose — because every source is read-only. Does not
 * touch the disk and does not mutate the breaker, telemetry or config state.
 */
declare function getDiagnosticsSnapshot(now?: number): DiagnosticsSnapshot;
/**
 * Render a snapshot as a compact multi-line report, suitable for pasting
 * into an issue or a support channel. Deterministic for a given snapshot.
 */
declare function formatDiagnostics(snapshot: DiagnosticsSnapshot): string;

export { type BreakerDiagnostics, type DiagnosticsSnapshot, type EndpointDiagnostics, formatDiagnostics, getDiagnosticsSnapshot };
