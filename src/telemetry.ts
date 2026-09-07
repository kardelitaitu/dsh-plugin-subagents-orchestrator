/**
 * Per-endpoint telemetry + structured debug events.
 *
 * Deliberately standalone: it observes the orchestrator through explicit
 * record calls and never reaches into config or the circuit breaker, so it
 * stays useful (and testable) regardless of how those modules evolve.
 *
 * Debug output is opt-in via the `DSH_ORCHESTRATOR_DEBUG=1` environment
 * variable; when enabled every recorded event is emitted through
 * `console.debug` as a single JSON line suitable for log aggregation.
 */

export type TelemetryEventType = 'request' | 'failure' | 'failover';

export interface TelemetryEndpointRef {
  provider: string;
  model: string;
}

export interface TelemetryEvent {
  at: number;
  type: TelemetryEventType;
  agentId: string;
  /** Endpoint the event moved away from (failures / failovers). */
  from?: TelemetryEndpointRef;
  /** Endpoint the event is about or moved to. */
  to?: TelemetryEndpointRef;
  /** Failure code, when the event originates from `agent/request-error`. */
  code?: string;
  /** Provider-derived cooldown hint in ms, when one was present. */
  hintMs?: number;
  /** Request-to-failure span in ms, when a matching request start was seen. */
  latencyMs?: number;
}

export interface EndpointStats {
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

/** Recent-event ring buffer size. Small on purpose: diagnostics, not an audit log. */
export const MAX_EVENT_BUFFER = 100;

const statsByKey = new Map<string, EndpointStats>();
const eventBuffer: TelemetryEvent[] = [];

/**
 * In-flight request starts per agent, for failure-latency attribution: the
 * agent's endpoint at `agent/request` time and the timestamp. Failure latency
 * is the request-to-failure span — instant refusals (rate limit, auth) vs.
 * long hangs (timeout) — since the host dispatch layer exposes no
 * request-completion event for success-side latency.
 */
const requestStarts = new Map<string, { endpoint: TelemetryEndpointRef; at: number }>();

/**
 * Debug switch, driven by the host (config `debug: true/false`). `auto`
 * defers to the `DSH_ORCHESTRATOR_DEBUG` environment variable; an explicit
 * config value always wins over the environment.
 */
let debugMode: 'on' | 'off' | 'auto' = 'auto';

/** Set the debug logging mode from the validated config. */
export function setDebugLogging(enabled: boolean | undefined): void {
  debugMode = enabled === true ? 'on' : enabled === false ? 'off' : 'auto';
}

function isDebugEnabled(): boolean {
  if (debugMode === 'on') return true;
  if (debugMode === 'off') return false;
  const flag = process.env['DSH_ORCHESTRATOR_DEBUG'];
  return flag === '1' || flag === 'true';
}

function emit(event: TelemetryEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_EVENT_BUFFER) eventBuffer.shift();
  if (isDebugEnabled()) {
    console.debug('[subagents-orchestrator]', JSON.stringify(event));
  }
}

function ensureStats(endpoint: TelemetryEndpointRef): EndpointStats {
  const key = `${endpoint.provider}::${endpoint.model}`;
  let entry = statsByKey.get(key);
  if (!entry) {
    entry = {
      key,
      provider: endpoint.provider,
      model: endpoint.model,
      requests: 0,
      failures: 0,
      failovers: 0,
      cooldownHints: 0,
      lastFailureAt: null,
      lastFailureCode: null,
      latencySamples: 0,
      latencyTotalMs: 0,
      latencyMaxMs: 0,
      lastLatencyMs: null
    };
    statsByKey.set(key, entry);
  }
  return entry;
}

/** Record a request observed routed to `endpoint` for `agentId`. */
export function recordRequest(agentId: string, endpoint: TelemetryEndpointRef, now: number = Date.now()): void {
  ensureStats(endpoint).requests += 1;
  requestStarts.set(agentId, { endpoint: { ...endpoint }, at: now });
  emit({ at: now, type: 'request', agentId, to: { ...endpoint } });
}

/** Record a failure attributed to `endpoint`, including any cooldown hint that was applied. */
export function recordFailure(
  agentId: string,
  endpoint: TelemetryEndpointRef,
  code: string,
  hintMs?: number,
  now: number = Date.now()
): void {
  const entry = ensureStats(endpoint);
  entry.failures += 1;
  if (hintMs !== undefined) entry.cooldownHints += 1;
  entry.lastFailureAt = now;
  entry.lastFailureCode = code;

  // Failure latency: the span from the request build (recordRequest) to this
  // failure. One sample per request — the start entry is consumed here, so a
  // failure without a preceding request simply records no latency.
  const start = requestStarts.get(agentId);
  let latencyMs: number | undefined;
  if (start) {
    requestStarts.delete(agentId);
    latencyMs = Math.max(0, now - start.at);
    entry.latencySamples += 1;
    entry.latencyTotalMs += latencyMs;
    entry.latencyMaxMs = Math.max(entry.latencyMaxMs, latencyMs);
    entry.lastLatencyMs = latencyMs;
  }

  emit({
    at: now,
    type: 'failure',
    agentId,
    from: { ...endpoint },
    code,
    ...(hintMs !== undefined ? { hintMs } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {})
  });
}

/** Record a failover transition `from -> to` for `agentId`. */
export function recordFailover(
  agentId: string,
  from: TelemetryEndpointRef | undefined,
  to: TelemetryEndpointRef,
  now: number = Date.now()
): void {
  // Both sides of the transition appear in stats: the target accrues the
  // failover, the source gets an entry so consumers see the full picture.
  if (from) ensureStats(from);
  ensureStats(to).failovers += 1;
  emit({
    at: now,
    type: 'failover',
    agentId,
    ...(from ? { from: { ...from } } : {}),
    to: { ...to }
  });
}

/** Snapshot of all endpoint stats, in first-seen order. */
export function getEndpointStats(): EndpointStats[] {
  return Array.from(statsByKey.values()).map((entry) => ({ ...entry }));
}

/** The most recent `limit` events (oldest first). A limit of 0, negative or
 *  non-finite yields an empty list rather than the whole buffer. */
export function getRecentEvents(limit: number = MAX_EVENT_BUFFER): TelemetryEvent[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return eventBuffer.slice(-limit).map((event) => ({ ...event }));
}

/** Forget all telemetry state (used between tests and on plugin dispose). */
export function resetTelemetry(): void {
  statsByKey.clear();
  eventBuffer.length = 0;
  requestStarts.clear();
  debugMode = 'auto';
}

/**
 * Atomically hand over the buffered events and clear the ring buffer — the
 * durable-flushing primitive for persist.ts. Returned events are copies.
 */
export function drainRecentEvents(): TelemetryEvent[] {
  return eventBuffer.splice(0, eventBuffer.length).map((event) => ({ ...event }));
}
