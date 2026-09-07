import type {
  CordisContext,
  SubagentRequest,
  ContinuableSpec,
  RequestErrorPayload,
  Agent,
  FailoverState,
  Endpoint,
  RequestSeed
} from './types.js';
import {
  getConfig,
  getCachedEndpoints,
  initWatcher,
  disposeWatcher
} from './config.js';
import { pickNextEndpoint } from './balancer.js';
import { defaultCircuitBreaker } from './health.js';
import { extractCooldownHintMs } from './ratelimit.js';
import { recordRequest, recordFailure, recordFailover, resetTelemetry } from './telemetry.js';

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

    // Trip circuit breaker on failure. A provider cooldown hint
    // (Retry-After / x-ratelimit-reset) trips the endpoint immediately for
    // exactly that window; otherwise the consecutive-failure threshold and
    // the configured cooldown apply.
    const currentEndpoint = activeEndpoints.get(agent.id);
    if (currentEndpoint) {
      const hintMs = extractCooldownHintMs(failure);
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        hintMs !== null ? 1 : config.maxFailures || 3,
        hintMs ?? config.cooldownMs ?? 60000
      );
      recordFailure(agent.id, currentEndpoint, failure.code, hintMs !== null ? hintMs : undefined);
    }

    const current = pendingFailovers.get(agent.id) || { count: 0, index: 0 };
    if (current.count >= endpoints.length - 1) return next();

    // Advance to the next candidate, skipping endpoints the breaker has tripped
    // (unless every remaining candidate is tripped — degraded attempts still
    // beat a hard stall).
    let nextIndex = -1;
    for (let step = 1; step <= endpoints.length - 1; step++) {
      const candidateIndex = (current.index + step) % endpoints.length;
      const candidate = endpoints[candidateIndex];
      const isCurrent = currentEndpoint !== undefined && defaultCircuitBreaker.getEndpointKey(candidate) === defaultCircuitBreaker.getEndpointKey(currentEndpoint);
      if (isCurrent) continue;
      if (defaultCircuitBreaker.isHealthy(candidate)) {
        nextIndex = candidateIndex;
        break;
      }
      if (nextIndex === -1) nextIndex = candidateIndex;
    }
    if (nextIndex === -1) return next();

    pendingFailovers.set(agent.id, {
      count: current.count + 1,
      index: nextIndex
    });

    recordFailover(agent.id, currentEndpoint ?? undefined, endpoints[nextIndex]);

    return { kind: 'retry' };
  });

  // 3. Apply the fallback endpoint onto the retried request
  const disposeRequest = ctx.on('agent/request', async (payload: { agent: Agent; [key: string]: any }, next: () => any) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();

    const current = pendingFailovers.get(agent.id);

    if (!current) {
      // Pass-through request: remember the assigned endpoint so the breaker
      // can attribute this subagent's failures even before any failover.
      const seed = (await next()) as RequestSeed | null | undefined;
      if (seed && typeof seed.provider === 'string' && typeof seed.model === 'string') {
        const assigned: Endpoint = {
          provider: seed.provider,
          model: seed.model,
          ...(typeof seed.reasoningEffort === 'string' ? { reasoningEffort: seed.reasoningEffort } : {})
        };
        activeEndpoints.set(agent.id, assigned);
        recordRequest(agent.id, assigned);
      }
      return seed;
    }

    const endpoints = getCachedEndpoints();
    const target = endpoints[current.index];
    if (!target) return next();

    activeEndpoints.set(agent.id, target);
    recordRequest(agent.id, target);

    const seed = (await next()) as RequestSeed | null | undefined;
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
    resetTelemetry();
    disposeWatcher();
  });
}
