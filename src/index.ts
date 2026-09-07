import type {
  CordisContext,
  SubagentRequest,
  ContinuableSpec,
  RequestErrorPayload,
  Agent,
  FailoverState,
  Endpoint
} from './types.js';
import {
  getConfig,
  getCachedEndpoints,
  initWatcher,
  disposeWatcher
} from './config.js';
import { pickNextEndpoint } from './balancer.js';
import { defaultCircuitBreaker } from './health.js';

export const name = 'dsh-plugin-subagents-orchestrator';

export const FAILOVER_TRIGGER_CODES = [
  'RATE_LIMIT',
  'QUOTA',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE'
];

export const WRAPPED = Symbol.for('dsh-plugin-subagents-orchestrator.wrapped');

export function isSubagent(agent: Agent | null | undefined): boolean {
  return Boolean(agent && agent.session?.header?.origin === 'subagent');
}

export function apply(ctx: CordisContext): void {
  let rrCursor = 0;
  const pendingFailovers = new Map<string, FailoverState>();
  const activeEndpoints = new Map<string, Endpoint>();

  // Start zero-latency in-memory config cache & file watcher
  initWatcher();

  function wrapRequest(request?: SubagentRequest): SubagentRequest | undefined {
    if (!request) return request;
    // Respect explicit model if already requested by caller
    if (request.agentOptions !== void 0) return request;

    const config = getConfig();
    if (!config || config.enabled === false) return request;

    const endpoints = getCachedEndpoints();
    if (endpoints.length === 0) return request;

    const picked = pickNextEndpoint(
      endpoints,
      config.strategy || 'round-robin',
      rrCursor++,
      defaultCircuitBreaker
    );
    if (!picked) return request;

    return {
      ...request,
      agentOptions: {
        provider: picked.provider,
        model: picked.model,
        ...(picked.reasoningEffort ? { reasoningEffort: picked.reasoningEffort } : {})
      }
    };
  }

  // 1. Intercept subagent delegations
  ctx.inject(['subagents'], (subagentCtx) => {
    const raw = (subagentCtx.subagents as any)?.[Symbol.for('cordis.original')] ?? subagentCtx.subagents;
    if (!raw || raw[WRAPPED]) return;

    const originalStart = raw.start;
    const originalStartContinuable = raw.startContinuable;

    if (typeof originalStart === 'function') {
      raw.start = async function (subagentName: string, request?: SubagentRequest) {
        return originalStart.call(raw, subagentName, wrapRequest(request));
      };
    }

    if (typeof originalStartContinuable === 'function') {
      raw.startContinuable = async function (spec?: ContinuableSpec) {
        if (!spec) return originalStartContinuable.call(raw, spec);
        return originalStartContinuable.call(raw, {
          ...spec,
          request: wrapRequest(spec.request)
        });
      };
    }

    raw[WRAPPED] = true;

    ctx.effect(() => () => {
      if (raw.start && originalStart) raw.start = originalStart;
      if (raw.startContinuable && originalStartContinuable) raw.startContinuable = originalStartContinuable;
      delete raw[WRAPPED];
    });
  });

  // 2. Multi-endpoint automatic failover on connection/rate-limit failure
  const disposeRequestError = ctx.on('agent/request-error', (payload: RequestErrorPayload, next: () => any) => {
    const config = getConfig();
    if (!config || config.failover !== true) return next();

    const endpoints = getCachedEndpoints();
    if (endpoints.length < 2) return next();

    const { agent, failure, signal } = payload;
    if (signal?.aborted) return next();
    if (!isSubagent(agent)) return next();
    if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();

    // Trip circuit breaker on failure
    const currentEndpoint = activeEndpoints.get(agent.id);
    if (currentEndpoint) {
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        config.maxFailures || 3,
        config.cooldownMs || 60000
      );
    }

    const current = pendingFailovers.get(agent.id) || { count: 0, index: 0 };
    if (current.count >= endpoints.length - 1) return next();

    const nextIndex = (current.index + 1) % endpoints.length;
    pendingFailovers.set(agent.id, {
      count: current.count + 1,
      index: nextIndex
    });

    return { kind: 'retry' };
  });

  // 3. Apply the fallback endpoint onto the retried request
  const disposeRequest = ctx.on('agent/request', async (payload: { agent: Agent; [key: string]: any }, next: () => any) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();

    const current = pendingFailovers.get(agent.id);
    if (!current) return next();

    const config = getConfig();
    const endpoints = getCachedEndpoints();
    const target = endpoints[current.index];
    if (!target) return next();

    activeEndpoints.set(agent.id, target);

    const seed = await next();
    if (!seed) return seed;

    const { reasoningEffort: _effort, ...rest } = seed;
    return {
      ...rest,
      provider: target.provider,
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {})
    };
  });

  const disposeDisposed = ctx.on('agent/disposed', ({ agent }: { agent?: Agent }) => {
    if (agent?.id) {
      pendingFailovers.delete(agent.id);
      activeEndpoints.delete(agent.id);
    }
  });

  ctx.effect(() => () => {
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
    pendingFailovers.clear();
    activeEndpoints.clear();
    defaultCircuitBreaker.clear();
    disposeWatcher();
  });
}
