export interface Endpoint {
  provider: string;
  model: string;
  reasoningEffort?: string;
  weight?: number;
  /** Disabled endpoints stay in config but are excluded from routing. */
  enabled?: boolean;
}

export type RoutingStrategy = 'round-robin' | 'random' | 'weighted';

/**
 * Endpoint handling mode (v2):
 * - `pool` (default): distribute across `endpoints` with `strategy`; a
 *   configured `fallback` list is only a lower tier for failover.
 * - `fallback`: stick to the primary set (`endpoints` — one entry means
 *   sticky), descending the ordered `fallback` rescue chain only when the
 *   current endpoint is actually abandoned by the failover machinery.
 * A `fallback` mode with no usable rescue entries degrades to `pool`.
 */
export type RoutingMode = 'pool' | 'fallback';

export interface OrchestratorConfig {
  enabled?: boolean;
  strategy?: RoutingStrategy;
  mode?: RoutingMode;
  failover?: boolean;
  cooldownMs?: number;
  maxFailures?: number;
  /** Lower bound (ms) of the randomized wait before a retried subagent request. */
  intervalMinMs?: number;
  /** Upper bound (ms) of the randomized wait before a retried subagent request. */
  intervalMaxMs?: number;
  /** Same-endpoint retry budget: retries spent on the current endpoint before failing over to the next pool entry. */
  maxRetries?: number;
  /**
   * Soft concurrency cap on routed starts (v2). Starts over the cap are
   * NEVER rejected, queued or stalled (host-plane invariant) — they pass
   * through unrouted. Absent = unbounded.
   */
  totalSubagents?: number;
  /** Emit structured telemetry debug lines for every routing event. */
  debug?: boolean;
  /** Opt-in: flush telemetry events and endpoint stats to ~/.dsh/telemetry on dispose. */
  persistTelemetry?: boolean;
  /**
   * Opt-in UI surfaces, all off by default so the plugin stays invisible.
   * Gated client-plane features read these through the diagnostics snapshot.
   */
  ui?: OrchestratorUiConfig;
  endpoints?: Endpoint[];
  /** Ordered rescue chain (fallback mode); lower tier under pool mode. */
  fallback?: Endpoint[];
}

export interface OrchestratorUiConfig {
  /**
   * Opt-in failover notice: when a subagent fails over, inject a collapsed
   * plugin-notice row into its transcript (`agent.inject`, non-waking) so
   * the retried step — and the session view — show the endpoint switch.
   * The web-client push toast remains upstream-blocked (closed
   * API_REMOTE_FORWARDED_EVENTS allowlist in DSH 0.1.1/0.1.2).
   */
  toasts?: boolean;
  /** Register the orchestrator panel in the DSH settings surface. */
  panel?: boolean;
}

export interface AgentSessionHeader {
  origin?: string;
  [key: string]: unknown;
}

export interface AgentSession {
  header?: AgentSessionHeader;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  session?: AgentSession;
  /**
   * Queue model-facing context for the next pre-step WITHOUT waking the
   * driver (dsh-agent `Agent.inject`). Present on live host agents; absent
   * on mocks/older hosts, so every caller must feature-detect.
   */
  inject?: (message: unknown) => void;
  [key: string]: unknown;
}

export interface FailureInfo {
  code: string;
  message?: string;
  /**
   * Provider-derived retry delay in ms, already parsed and validated by the
   * host (dsh-llm normalizes the provider's `retry-after` response header).
   * Preferred over sniffing raw `headers`.
   */
  providerRetryAfterMs?: number;
  /** Raw response headers from the failed provider call, when available. */
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface RequestErrorPayload {
  agent: Agent;
  failure?: FailureInfo;
  /** Abort signal shape: a subset of AbortSignal, tolerating host variants. */
  signal?: {
    aborted?: boolean;
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Decision consumed by the host agent loop (dsh-agent-loop) from the
 * `agent/request-error` waterfall. `{ kind: 'retry' }` re-runs the request;
 * anything else (including `undefined`) surfaces the failure. The loop applies
 * no delay of its own — a decider that wants a delay must wait before returning.
 */
export type RequestErrorAction = { kind: 'retry' } | undefined;

export interface AgentRequestOptions {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  [key: string]: unknown;
}

export interface SubagentRequest {
  agentOptions?: AgentRequestOptions;
  [key: string]: unknown;
}

export interface ContinuableSpec {
  request?: SubagentRequest;
  [key: string]: unknown;
}

export interface SubagentsService {
  start?: (name: string, request?: SubagentRequest) => Promise<unknown>;
  startContinuable?: (spec?: ContinuableSpec) => Promise<unknown>;
  [key: string | symbol]: unknown;
}

export interface CordisContext {
  inject: (deps: string[], callback: (ctx: CordisContext) => void) => void;
  on: (event: string, handler: (payload: any, next: () => any) => any) => () => void;
  effect: (callback: () => void | (() => void)) => void;
  subagents?: SubagentsService;
  [key: string]: unknown;
}

export interface FailoverState {
  count: number;
  index: number;
  /** Which list `index` refers to. Absent = primary (back-compat). */
  tier?: 'primary' | 'fallback';
}

/** Provider seed produced by the host for an agent request (`agent/request` event). */
export interface RequestSeed {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  [key: string]: unknown;
}
