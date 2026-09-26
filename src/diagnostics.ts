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
    | 'successes'
    | 'successLatencySamples'
    | 'successLatencyTotalMs'
    | 'successLatencyMaxMs'
    | 'lastSuccessLatencyMs'
    | 'tokensTotal'
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
    /**
     * Auto-failover on error is engaged. Mirrors the runtime gate in
     * index.ts: failover defaults to on, and only an explicit
     * `failover: false` (on an enabled config) disables the walk.
     */
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
  lastLatencyMs: null,
  successes: 0,
  successLatencySamples: 0,
  successLatencyTotalMs: 0,
  successLatencyMaxMs: 0,
  lastSuccessLatencyMs: null,
  tokensTotal: 0
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
      lastLatencyMs: stats.lastLatencyMs,
      successes: stats.successes,
      successLatencySamples: stats.successLatencySamples,
      successLatencyTotalMs: stats.successLatencyTotalMs,
      successLatencyMaxMs: stats.successLatencyMaxMs,
      lastSuccessLatencyMs: stats.lastSuccessLatencyMs,
      tokensTotal: stats.tokensTotal
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
    toEndpointDiagnostics(
      endpoint,
      // Pool membership is per-entry, not per-key: a parked entry stays out of
      // the pool even when an enabled twin shares its provider::model key
      // (otherwise `inPool` would contradict both the documented contract and
      // `effectivePoolSize`, which excludes parked entries).
      endpoint.enabled !== false && poolKeys.has(`${endpoint.provider}::${endpoint.model}`),
      statsByKey,
      now
    )
  );

  return {
    generatedAt: now,
    configPresent: config !== null,
    orchestration: {
      active: config !== null && config.enabled !== false,
      strategy: config?.strategy ?? 'round-robin',
      failover: config !== null && config.enabled !== false && config.failover !== false,
      cooldownMs: config?.cooldownMs ?? 3600000,
      maxFailures: config?.maxFailures ?? 3,
      retryIntervalMinMs: config?.intervalMinMs ?? 3000,
      retryIntervalMaxMs: config?.intervalMaxMs ?? 5000
    },
    // UI surfaces are opt-in; an absent ui block reads as all-off so the
    // plugin stays invisible until the user asks for a face.
    ui: {
      toasts: config?.ui?.toasts === true,
      panel: config?.ui?.panel === true
    },
    effectivePoolSize: effectivePool.length,
    endpoints
  };
}

/**
 * ISO-8601 rendering that cannot throw.
 *
 * `new Date(x).toISOString()` raises RangeError for a finite but out-of-range
 * timestamp (|x| > 8.64e15), and a persisted quarantine is adopted verbatim
 * from the settings file, so such a value can reach a snapshot. Out-of-range
 * inputs fall back to the raw epoch value instead of aborting the report.
 */
function toIsoOrRaw(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Collapse control characters so one endpoint always renders as one line.
 *
 * The identity is interpolated verbatim from config (the parser keeps any
 * non-blank provider/model), so an embedded newline or tab would otherwise
 * forge extra lines in the report — breaking the documented one-line-per-
 * endpoint contract and allowing report/log injection.
 */
function singleLine(value: string): string {
  // C0 controls, DEL + C1 controls (incl. NEL U+0085), and the Unicode line /
  // paragraph separators U+2028 / U+2029 - all of which are line terminators to
  // log viewers and to JS itself, so a raw one would still forge report lines.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** One human-readable line per endpoint for logs and support requests. */
function formatEndpointLine(endpoint: EndpointDiagnostics): string {
  const parts: string[] = [];
  parts.push(endpoint.inPool ? 'pool' : 'parked');
  parts.push(endpoint.breaker.healthy ? 'healthy' : `tripped-until=${toIsoOrRaw(endpoint.breaker.trippedUntil ?? 0)}`);
  if (endpoint.breaker.consecutiveFailures > 0) parts.push(`streak=${endpoint.breaker.consecutiveFailures}`);
  parts.push(`req=${endpoint.telemetry.requests} fail=${endpoint.telemetry.failures} failover=${endpoint.telemetry.failovers}`);
  if (endpoint.telemetry.latencySamples > 0) {
    const avg = Math.round(endpoint.telemetry.latencyTotalMs / endpoint.telemetry.latencySamples);
    parts.push(`fail-latency n=${endpoint.telemetry.latencySamples} avg=${avg}ms max=${endpoint.telemetry.latencyMaxMs}ms`);
  }
  return `- ${singleLine(endpoint.key)} [${parts.join(' ')}]`;
}

/**
 * Render a snapshot as a compact multi-line report, suitable for pasting
 * into an issue or a support channel. Deterministic for a given snapshot.
 */
export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const lines: string[] = [];
  lines.push(`subagents-orchestrator diagnostics @ ${toIsoOrRaw(snapshot.generatedAt)}`);
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
