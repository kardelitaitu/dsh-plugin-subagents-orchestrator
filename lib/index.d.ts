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
declare function isSubagent(agent: Agent | null | undefined): boolean;
declare function apply(ctx: CordisContext): void;

export { FAILOVER_TRIGGER_CODES, WRAPPED, apply, isSubagent, name };
