import type { Endpoint } from './types.js';
import { getConfig, getCachedEndpoints } from './config.js';
import { defaultCircuitBreaker } from './health.js';
import type { EndpointHealthStatus } from './health.js';
import { getEndpointStats, type EndpointStats } from './telemetry.js';

/**
 * Read-only diagnostics snapshot over the plugin's live state: the effective
 * routing pool, per-endpoint circuit-breaker health and telemetry counters.
 *
 * Strictly non-mutating by design — in particular it derives endpoint health
 * from the breaker's stored status instead of calling `isHealthy()`, which
 * transitions tripped endpoints to probation (a state write) as a side
 * effect. Probing diagnostics must never change routing behavior.
 */

export interface BreakerDiagnostics {
  /** Whether the endpoint may serve traffic at snapshot time (derived, no mutation). */
  healthy: boolean;
  /** Wall-clock ms until which the endpoint is tripped, or null when eligible. */
  trippedUntil: number | null;
  consecutiveFailures: number;
  lastFailureAt: number | null;
}

export interface EndpointDiagnostics {
  /** `provider::model` identity, matching telemetry keys. */
  key: string;
  provider: string;
  model: string;
  /** `false` when parked via `enabled: false` (in config, out of the pool). */
  inPool: boolean;
  breaker: BreakerDiagnostics;
  telemetry: Pick<
    EndpointStats,
    | 'requests'
    | 'failures'
    | 'failovers'
    | 'cooldownHints'
    | 'latencySamples'
    | 'latencyTotalMs'
    | 'latencyMaxMs'
    | 'lastLatencyMs'
  >;
}

export interface DiagnosticsSnapshot {
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
  /** Number of endpoints in the effective pool (parked endpoints excluded). */
  effectivePoolSize: number;
  /** Full configured endpoint list, including parked entries. */
  endpoints: EndpointDiagnostics[];
}

/** Health derived from the breaker's stored status without mutating it. */
function deriveBreakerDiagnostics(status: EndpointHealthStatus, now: number): BreakerDiagnostics {
  return {
    healthy: status.trippedUntil === null || now >= status.trippedUntil,
    trippedUntil: status.trippedUntil,
    consecutiveFailures: status.consecutiveFailures,
    lastFailureAt: status.lastFailureAt
  };
}

const EMPTY_STATS = {
  requests: 0,
  failures: 0,
  failovers: 0,
  cooldownHints: 0,
  latencySamples: 0,
  latencyTotalMs: 0,
  latencyMaxMs: 0,
  lastLatencyMs: null
} as const;

function toEndpointDiagnostics(endpoint: Endpoint, inPool: boolean, statsByKey: Map<string, EndpointStats>, now: number): EndpointDiagnostics {
  const key = `${endpoint.provider}::${endpoint.model}`;
  const stats = statsByKey.get(key) ?? { ...EMPTY_STATS };
  return {
    key,
    provider: endpoint.provider,
    model: endpoint.model,
    inPool,
    breaker: deriveBreakerDiagnostics(defaultCircuitBreaker.getStatus(endpoint), now),
    telemetry: {
      requests: stats.requests,
      failures: stats.failures,
      failovers: stats.failovers,
      cooldownHints: stats.cooldownHints,
      latencySamples: stats.latencySamples,
      latencyTotalMs: stats.latencyTotalMs,
      latencyMaxMs: stats.latencyMaxMs,
      lastLatencyMs: stats.lastLatencyMs
    }
  };
}

/**
 * Capture the current plugin state as a plain JSON-serializable snapshot.
 *
 * Safe to call at any point in the plugin lifecycle — including before
 * `apply()` and after dispose — because every source is read-only. Does not
 * touch the disk and does not mutate the breaker, telemetry or config state.
 */
export function getDiagnosticsSnapshot(now: number = Date.now()): DiagnosticsSnapshot {
  const config = getConfig();
  const effectivePool = getCachedEndpoints();
  const poolKeys = new Set(effectivePool.map((e) => `${e.provider}::${e.model}`));
  const statsByKey = new Map(getEndpointStats().map((s) => [s.key, s]));

  const configured = config?.endpoints ?? [];
  const endpoints = configured.map((endpoint) =>
    toEndpointDiagnostics(endpoint, poolKeys.has(`${endpoint.provider}::${endpoint.model}`), statsByKey, now)
  );

  return {
    generatedAt: now,
    configPresent: config !== null,
    orchestration: {
      active: config !== null && config.enabled !== false,
      strategy: config?.strategy ?? 'round-robin',
      failover: config?.failover === true,
      cooldownMs: config?.cooldownMs ?? 60000,
      maxFailures: config?.maxFailures ?? 3,
      retryIntervalMinMs: config?.intervalMinMs ?? 3000,
      retryIntervalMaxMs: config?.intervalMaxMs ?? 5000
    },
    effectivePoolSize: effectivePool.length,
    endpoints
  };
}

/** One human-readable line per endpoint for logs and support requests. */
function formatEndpointLine(endpoint: EndpointDiagnostics): string {
  const parts: string[] = [];
  parts.push(endpoint.inPool ? 'pool' : 'parked');
  parts.push(endpoint.breaker.healthy ? 'healthy' : `tripped-until=${new Date(endpoint.breaker.trippedUntil ?? 0).toISOString()}`);
  if (endpoint.breaker.consecutiveFailures > 0) parts.push(`streak=${endpoint.breaker.consecutiveFailures}`);
  parts.push(`req=${endpoint.telemetry.requests} fail=${endpoint.telemetry.failures} failover=${endpoint.telemetry.failovers}`);
  if (endpoint.telemetry.latencySamples > 0) {
    const avg = Math.round(endpoint.telemetry.latencyTotalMs / endpoint.telemetry.latencySamples);
    parts.push(`fail-latency n=${endpoint.telemetry.latencySamples} avg=${avg}ms max=${endpoint.telemetry.latencyMaxMs}ms`);
  }
  return `- ${endpoint.key} [${parts.join(' ')}]`;
}

/**
 * Render a snapshot as a compact multi-line report, suitable for pasting
 * into an issue or a support channel. Deterministic for a given snapshot.
 */
export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const lines: string[] = [];
  lines.push(`subagents-orchestrator diagnostics @ ${new Date(snapshot.generatedAt).toISOString()}`);
  const o = snapshot.orchestration;
  lines.push(
    `config: ${snapshot.configPresent ? 'present' : 'missing'} | active=${o.active} strategy=${o.strategy} failover=${o.failover} | cooldown=${o.cooldownMs}ms maxFailures=${o.maxFailures} pacing=${o.retryIntervalMinMs}-${o.retryIntervalMaxMs}ms`
  );
  lines.push(`effective pool: ${snapshot.effectivePoolSize} endpoint(s)`);
  for (const endpoint of snapshot.endpoints) {
    lines.push(formatEndpointLine(endpoint));
  }
  return lines.join('\n');
}
