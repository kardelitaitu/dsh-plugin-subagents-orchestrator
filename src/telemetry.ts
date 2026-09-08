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

export type TelemetryEventType = 'request' | 'failure' | 'failover' | 'success';

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
  /** Success-side step span in ms (request build -> next boundary). */
  successLatencyMs?: number;
  /** Provider-reported/measured tokens attributed to a closed success span. */
  tokens?: number;
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
  /** Completed (successful) attempts attributed to this endpoint. */
  successes: number;
  /** Success-span samples: request build -> next same-agent boundary. */
  successLatencySamples: number;
  /** Sum of success-span samples (ms); divide by successLatencySamples for the mean. */
  successLatencyTotalMs: number;
  /** Longest observed success span (ms). */
  successLatencyMaxMs: number;
  /** Most recent success span (ms), or null before the first sample. */
  lastSuccessLatencyMs: number | null;
  /** Sum of measured token deltas attributed to this endpoint's closed spans. */
  tokensTotal: number;
}

/** Recent-event ring buffer size. Small on purpose: diagnostics, not an audit log. */
export const MAX_EVENT_BUFFER = 100;

const statsByKey = new Map<string, EndpointStats>();
const eventBuffer: TelemetryEvent[] = [];

/**
 * Open success spans per agent. The host dispatch layer exposes no
 * request-completion event, so a span is opened at `agent/request` (same
 * attribution point as the failure-latency start entry) and closed at the
 * NEXT same-agent boundary — another `agent/request` for a later step or the
 * turn close (`agent/turn-stopping`). The span therefore covers request
 * build through the whole step's model call, including same-endpoint retry
 * waits we imposed; it is an upper bound on raw provider latency by design.
 */
interface SuccessSpan {
  endpoint: TelemetryEndpointRef;
  at: number;
  turn: unknown;
  step: unknown;
  /** Token accounting for the span: last provider-reported/measured total seen. */
  tokenMark: number | null;
  /** Token deltas sampled into this span, awaiting the close that attributes them. */
  pendingTokens?: number;
  /**
   * Set when the span's own (turn, step) request failed. A poisoned span is
   * never sampled as a success — it is silently dropped at the next
   * boundary, so a turn that closed on an error cannot inflate successes.
   */
  failed?: boolean;
}
const successSpans = new Map<string, SuccessSpan>();

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
      lastLatencyMs: null,
      successes: 0,
      successLatencySamples: 0,
      successLatencyTotalMs: 0,
      successLatencyMaxMs: 0,
      lastSuccessLatencyMs: null,
      tokensTotal: 0
    };
    statsByKey.set(key, entry);
  }
  return entry;
}

/** Record a request observed routed to `endpoint` for `agentId`. */
export function recordRequest(
  agentId: string,
  endpoint: TelemetryEndpointRef,
  now: number = Date.now(),
  meta?: { turn?: unknown; step?: unknown }
): void {
  ensureStats(endpoint).requests += 1;
  requestStarts.set(agentId, { endpoint: { ...endpoint }, at: now });
  emit({ at: now, type: 'request', agentId, to: { ...endpoint } });
  openSuccessSpan(agentId, endpoint, now, meta);
}

/** Numeric guard for host turn/step values. */
function isStepNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Open a success span, closing any older span of the same agent first. */
function openSuccessSpan(
  agentId: string,
  endpoint: TelemetryEndpointRef,
  now: number,
  meta?: { turn?: unknown; step?: unknown }
): void {
  const previous = successSpans.get(agentId);
  if (previous) {
    const advanced =
      isStepNumber(meta?.turn) &&
      isStepNumber(previous.turn) &&
      (meta!.turn as number) > (previous.turn as number)
        ? true
        : isStepNumber(meta?.turn) &&
          isStepNumber(previous.turn) &&
          isStepNumber(meta?.step) &&
          isStepNumber(previous.step) &&
          (meta!.turn as number) === (previous.turn as number) &&
          (meta!.step as number) > (previous.step as number);
    if (advanced) {
      // The previous step finished its model call without surfacing a
      // failure to us: close its span as a success, attributed to the
      // endpoint the span was actually served on. A poisoned span (its
      // request failed) is dropped instead — the step never succeeded.
      successSpans.delete(agentId);
      if (!previous.failed) {
        sampleSuccess(agentId, previous.endpoint, previous, now, previous.pendingTokens);
      }
    }
    // A same-step re-dispatch (host-driven retry, possibly rewritten onto a
    // failover target by the orchestrator) is NOT a success: the old span is
    // simply replaced below, and failures already consumed the failure-side
    // entry via recordFailure.
  }
  successSpans.set(agentId, {
    endpoint: { ...endpoint },
    at: now,
    turn: meta?.turn,
    step: meta?.step,
    // The cumulative mark carries across spans of one agent so mid-turn
    // endpoint switches never double-count tokens; the pending delta does
    // NOT carry — a replaced span's tokens were its own attempt's.
    tokenMark: previous?.tokenMark ?? null
  });
}

/**
 * Record a token sample for the agent's open success span.
 *
 * `cumulativeTokens` is the provider-reported total from the durable session
 * meter (e.g. `ctx.tokenMeter.measure(session).totalTokens`). The delta since
 * the span's previous mark is attributed to the span's endpoint; the mark
 * persists across span replacement within one agent so mid-turn retries do
 * not double-count tokens.
 */
export function recordTokenSample(agentId: string, cumulativeTokens: number, now: number = Date.now()): number | null {
  const span = successSpans.get(agentId);
  if (!span || !Number.isFinite(cumulativeTokens)) return null;
  const delta = span.tokenMark === null ? cumulativeTokens : Math.max(0, cumulativeTokens - span.tokenMark);
  span.tokenMark = cumulativeTokens;
  span.pendingTokens = (span.pendingTokens ?? 0) + delta;
  return delta;
}

/**
 * Close the agent's open success span: the turn stopped cleanly (`agent/
 * turn-stopping`), so the span's request completed. `tokens` is the delta
 * computed by recordTokenSample (undefined when no meter is composed).
 * A poisoned span is dropped without sampling — the turn stopped but the
 * span's own request failed, so there is no success to record.
 */
export function recordTurnSuccess(agentId: string, tokens: number | undefined, now: number = Date.now()): boolean {
  const span = successSpans.get(agentId);
  if (!span) return false;
  successSpans.delete(agentId);
  if (!span.failed) {
    // Explicit tokens win; otherwise the span's own sampled deltas attribute.
    const effective = tokens !== undefined ? tokens : span.pendingTokens;
    sampleSuccess(agentId, span.endpoint, span, now, effective);
  }
  return true;
}

/**
 * Mark the agent's open success span as failed so no later boundary samples
 * it as a success. Called for request-level failures whose (turn, step)
 * match the open span, and for step/turn errors (`agent/error`).
 */
export function poisonSuccessSpan(agentId: string, turn?: unknown, step?: unknown): void {
  const span = successSpans.get(agentId);
  if (!span) return;
  if (turn === undefined && step === undefined) {
    span.failed = true;
    return;
  }
  if (span.turn === turn && span.step === step) span.failed = true;
}

/** Sample one closed success span into the endpoint stats + event ring. */
function sampleSuccess(
  agentId: string,
  endpoint: TelemetryEndpointRef,
  span: { at: number },
  now: number,
  tokens: number | undefined
): void {
  const entry = ensureStats(endpoint);
  const latencyMs = Math.max(0, now - span.at);
  entry.successes += 1;
  entry.successLatencySamples += 1;
  entry.successLatencyTotalMs += latencyMs;
  entry.successLatencyMaxMs = Math.max(entry.successLatencyMaxMs, latencyMs);
  entry.lastSuccessLatencyMs = latencyMs;
  if (tokens !== undefined) entry.tokensTotal += Math.max(0, tokens);
  emit({
    at: now,
    type: 'success',
    agentId,
    to: { ...endpoint },
    successLatencyMs: latencyMs,
    ...(tokens !== undefined ? { tokens } : {})
  });
}

/**
 * Number of agents with an unresolved request-start entry.
 *
 * Entries are consumed by recordFailure; agents whose requests succeed
 * rely on forgetAgent (agent/disposed) to release theirs - otherwise every
 * successful subagent leaks an entry for the host's whole lifetime.
 */
export function getInFlightRequests(): number {
  return requestStarts.size;
}

/**
 * Release all of an agent's in-flight entries (idempotent, safe for unknown
 * ids). Called from `agent/disposed`: without this release every successful
 * subagent would leak both its failure-latency start entry and its open
 * success span for the host's whole lifetime. A span open at dispose time is
 * deliberately NOT sampled — an aborted/disposed agent completed nothing we
 * can honestly call a success.
 */
export function forgetAgent(agentId: string): void {
  requestStarts.delete(agentId);
  successSpans.delete(agentId);
}

/** Record a failure attributed to `endpoint`, including any cooldown hint that was applied. */
export function recordFailure(
  agentId: string,
  endpoint: TelemetryEndpointRef,
  code: string,
  hintMs?: number,
  now: number = Date.now(),
  meta?: { turn?: unknown; step?: unknown }
): void {
  const entry = ensureStats(endpoint);
  entry.failures += 1;
  if (hintMs !== undefined) entry.cooldownHints += 1;
  entry.lastFailureAt = now;
  entry.lastFailureCode = code;
  // The span for the failed (turn, step) must never be sampled as a success
  // later — poison it up front (a retry re-opens a fresh span).
  poisonSuccessSpan(agentId, meta?.turn, meta?.step);

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
  successSpans.clear();
  debugMode = 'auto';
}

/**
 * Atomically hand over the buffered events and clear the ring buffer — the
 * durable-flushing primitive for persist.ts. Returned events are copies.
 */
export function drainRecentEvents(): TelemetryEvent[] {
  return eventBuffer.splice(0, eventBuffer.length).map((event) => ({ ...event }));
}
