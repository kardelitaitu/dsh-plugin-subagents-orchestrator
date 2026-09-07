export interface Endpoint {
  provider: string;
  model: string;
  reasoningEffort?: string;
  weight?: number;
  /** Disabled endpoints stay in config but are excluded from routing. */
  enabled?: boolean;
}

export type RoutingStrategy = 'round-robin' | 'random' | 'weighted';

export interface OrchestratorConfig {
  enabled?: boolean;
  strategy?: RoutingStrategy;
  failover?: boolean;
  cooldownMs?: number;
  maxFailures?: number;
  /** Emit structured telemetry debug lines for every routing event. */
  debug?: boolean;
  endpoints?: Endpoint[];
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
  [key: string]: unknown;
}

export interface FailureInfo {
  code: string;
  message?: string;
  /** Raw response headers from the failed provider call, when available. */
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface RequestErrorPayload {
  agent: Agent;
  failure?: FailureInfo;
  signal?: { aborted?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

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
}

/** Provider seed produced by the host for an agent request (`agent/request` event). */
export interface RequestSeed {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  [key: string]: unknown;
}
