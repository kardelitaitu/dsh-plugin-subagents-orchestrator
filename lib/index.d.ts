interface Endpoint {
    provider: string;
    model: string;
    reasoningEffort?: string;
    weight?: number;
    /** Disabled endpoints stay in config but are excluded from routing. */
    enabled?: boolean;
}
type RoutingStrategy = 'round-robin' | 'random' | 'weighted';
interface OrchestratorConfig {
    enabled?: boolean;
    strategy?: RoutingStrategy;
    failover?: boolean;
    cooldownMs?: number;
    maxFailures?: number;
    /** Lower bound (ms) of the randomized wait before a retried subagent request. */
    intervalMinMs?: number;
    /** Upper bound (ms) of the randomized wait before a retried subagent request. */
    intervalMaxMs?: number;
    /** Same-endpoint retry budget: retries spent on the current endpoint before failing over to the next pool entry. */
    maxRetries?: number;
    /** Emit structured telemetry debug lines for every routing event. */
    debug?: boolean;
    endpoints?: Endpoint[];
}
interface AgentSessionHeader {
    origin?: string;
    [key: string]: unknown;
}
interface AgentSession {
    header?: AgentSessionHeader;
    [key: string]: unknown;
}
interface Agent {
    id: string;
    session?: AgentSession;
    [key: string]: unknown;
}
interface AgentRequestOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    [key: string]: unknown;
}
interface SubagentRequest {
    agentOptions?: AgentRequestOptions;
    [key: string]: unknown;
}
interface ContinuableSpec {
    request?: SubagentRequest;
    [key: string]: unknown;
}
interface SubagentsService {
    start?: (name: string, request?: SubagentRequest) => Promise<unknown>;
    startContinuable?: (spec?: ContinuableSpec) => Promise<unknown>;
    [key: string | symbol]: unknown;
}
interface CordisContext {
    inject: (deps: string[], callback: (ctx: CordisContext) => void) => void;
    on: (event: string, handler: (payload: any, next: () => any) => any) => () => void;
    effect: (callback: () => void | (() => void)) => void;
    subagents?: SubagentsService;
    [key: string]: unknown;
}

declare const name = "dsh-plugin-subagents-orchestrator";
declare const FAILOVER_TRIGGER_CODES: string[];
declare const WRAPPED: unique symbol;
/** Defaults for the randomized wait before a retried subagent request (ms). */
declare const DEFAULT_RETRY_INTERVAL_MIN_MS = 3000;
declare const DEFAULT_RETRY_INTERVAL_MAX_MS = 5000;
/**
 * Sample the randomized subagent retry interval (ms).
 *
 * Defaults to 3000-5000ms. Non-finite or negative values fall back to the
 * defaults, and an inverted window is normalized so the sample always lands
 * within [min, max].
 */
declare function resolveRetryDelayMs(config: OrchestratorConfig | null | undefined, random?: () => number): number;
/** Same-endpoint retry budget before failing over to the next pool entry. */
declare const DEFAULT_MAX_RETRIES = 20;
/**
 * Resolve the per-endpoint same-endpoint retry budget.
 *
 * Defaults to 20 retries. Non-finite or negative values fall back to the
 * default; a valid value is floored to a whole retry count.
 */
declare function resolveMaxRetries(config: OrchestratorConfig | null | undefined): number;
declare function isSubagent(agent: Agent | null | undefined): boolean;
declare function apply(ctx: CordisContext): void;

export { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_INTERVAL_MAX_MS, DEFAULT_RETRY_INTERVAL_MIN_MS, FAILOVER_TRIGGER_CODES, WRAPPED, apply, isSubagent, name, resolveMaxRetries, resolveRetryDelayMs };
