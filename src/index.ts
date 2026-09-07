import type {
  CordisContext,
  SubagentRequest,
  ContinuableSpec,
  RequestErrorPayload,
  RequestErrorAction,
  Agent,
  FailoverState,
  Endpoint,
  OrchestratorConfig,
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
import { recordRequest, recordFailure, recordFailover, resetTelemetry, setDebugLogging } from './telemetry.js';

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

/** Defaults for the randomized wait before a retried subagent request (ms). */
export const DEFAULT_RETRY_INTERVAL_MIN_MS = 3000;
export const DEFAULT_RETRY_INTERVAL_MAX_MS = 5000;

/**
 * Sample the randomized subagent retry interval (ms).
 *
 * Defaults to 3000-5000ms. Non-finite or negative values fall back to the
 * defaults, and an inverted window is normalized so the sample always lands
 * within [min, max].
 */
export function resolveRetryDelayMs(
  config: OrchestratorConfig | null | undefined,
  random: () => number = Math.random
): number {
  // Each bound must be a non-negative finite number; otherwise the default
  // for that bound applies. A max below min degenerates to a fixed delay.
  const minValid = typeof config?.intervalMinMs === 'number' && Number.isFinite(config.intervalMinMs) && config.intervalMinMs >= 0;
  const maxValid = typeof config?.intervalMaxMs === 'number' && Number.isFinite(config.intervalMaxMs) && config.intervalMaxMs >= 0;
  const min = minValid ? config!.intervalMinMs! : DEFAULT_RETRY_INTERVAL_MIN_MS;
  const max = maxValid ? config!.intervalMaxMs! : DEFAULT_RETRY_INTERVAL_MAX_MS;
  const cappedMax = Math.max(min, max);
  return min + random() * (cappedMax - min);
}

export function isSubagent(agent: Agent | null | undefined): boolean {
  return Boolean(agent && agent.session?.header?.origin === 'subagent');
}

export function apply(ctx: CordisContext): void {
  let rrCursor = 0;
  const pendingFailovers = new Map<string, FailoverState>();
  const activeEndpoints = new Map<string, Endpoint>();
  /** One in-flight retry wait, cancellable so dispose can settle it promptly. */
  interface RetryWait {
    cancel(): void;
    done: Promise<void>;
  }
  const activeRetryWaits = new Set<RetryWait>();
  let lifetimeDisposed = false;

  // Start zero-latency in-memory config cache & file watcher
  initWatcher();

  /**
   * Wait out the configured retry interval before handing the host the retry
   * decision. The host loop applies no delay of its own, and dsh-llm-retry
   * forwards a downstream decision verbatim — so the decider owns the pacing.
   * Resolves early when the agent's abort signal fires or the plugin is
   * disposed (via the cancellable registry); the caller re-checks the signal
   * before acting.
   */
  function delayRetryWait(signal: RequestErrorPayload['signal'], delayMs: number): Promise<void> {
    // Pacing applies even without a signal — the wait is bounded and always
    // resolves; an abort signal only offers an early exit.
    if (lifetimeDisposed || signal?.aborted || !(delayMs > 0)) {
      return Promise.resolve();
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const entry: RetryWait = {
      done,
      cancel: () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        activeRetryWaits.delete(entry);
        resolveDone();
      }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      activeRetryWaits.delete(entry);
      resolveDone();
    }, delayMs);
    const onAbort = () => entry.cancel();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    activeRetryWaits.add(entry);
    return done;
  }

  /** Keep the telemetry debug switch aligned with the hot-reloaded `debug` flag. */
  function refreshTelemetryDebug(): void {
    setDebugLogging(getConfig()?.debug);
  }
  refreshTelemetryDebug();

  function wrapRequest(request?: SubagentRequest): SubagentRequest | undefined {
    const config = getConfig();
    if (!config || config.enabled === false) return request;
    refreshTelemetryDebug();

    const endpoints = getCachedEndpoints();
    if (endpoints.length === 0) return request;

    // Respect explicit model if already requested by caller
    if (request && request.agentOptions !== void 0) return request;

    const picked = pickNextEndpoint(
      endpoints,
      config.strategy || 'round-robin',
      rrCursor++,
      defaultCircuitBreaker
    );
    if (!picked) return request;

    // A missing request object must not bypass orchestration: bare
    // start(name) calls are routed exactly like start(name, {}).
    return {
      ...(request ?? {}),
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
        if (!spec) {
          // Spec-less continuable creation is routed like a bare start():
          // continuation afterwards happens via send_message, so injecting the
          // endpoint here cannot relocate a mid-flight conversation.
          const routed = wrapRequest(undefined);
          return originalStartContinuable.call(raw, routed ? { request: routed } : undefined);
        }
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
  const disposeRequestError = ctx.on('agent/request-error', async (payload: RequestErrorPayload, next: () => any): Promise<RequestErrorAction> => {
    try {
      const config = getConfig();
      if (!config || config.failover !== true) return next();
      refreshTelemetryDebug();

      const endpoints = getCachedEndpoints();
      if (endpoints.length < 2) return next();

      const { agent, failure, signal } = payload;
      if (signal?.aborted) return next();
      if (!isSubagent(agent)) return next();
      if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();

      // Trip circuit breaker on failure. A provider cooldown hint
      // (Retry-After / x-ratelimit-reset, host-parsed when available) trips
      // the endpoint immediately for exactly that window; otherwise the
      // consecutive-failure threshold and the configured cooldown apply.
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
      if (current.count >= endpoints.length - 1) {
        // Give up on this agent. Without clearing the state, a later host-driven
        // retry would still be rewritten onto the stale failover target even
        // though the plugin declined to fail over again.
        pendingFailovers.delete(agent.id);
        return next();
      }

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

      // Reserve nothing yet: the failover is committed only once the retry
      // wait survives without an abort or dispose. Writing state before the
      // wait recorded transitions (and telemetry) that could never happen.
      // Pacing: hold the retry decision for the configured interval window so
      // the provider's rate-limit window can drain before the next attempt.
      await delayRetryWait(signal, resolveRetryDelayMs(config));

      if (lifetimeDisposed || signal?.aborted) {
        // The wait was cut short (plugin dispose or agent abort): the planned
        // failover was never committed, so nothing may be recorded or rewritten
        // behind the host's back. The retry decision itself is still returned
        // promptly (the host checks the abort before acting on it).
        return { kind: 'retry' };
      }

      pendingFailovers.set(agent.id, {
        count: current.count + 1,
        index: nextIndex
      });

      recordFailover(agent.id, currentEndpoint ?? undefined, endpoints[nextIndex]);

      return { kind: 'retry' };
    } catch (error) {
      // A failure here must never veto the rest of the recovery chain:
      // cordis waterfall treats a listener that never calls next() as a
      // veto, which would silently disable dsh-llm-retry and other handlers.
      try {
        const logger = ctx.logger as { warn?: (...args: unknown[]) => void } | undefined;
        logger?.warn?.('subagents-orchestrator: failover handling failed, delegating:', error);
      } catch { /* logger must never throw */ }
      return next();
    }
  });

  // 3. Apply the fallback endpoint onto the retried request
  const disposeRequest = ctx.on('agent/request', async (payload: { agent: Agent; [key: string]: any }, next: () => any) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();

    const current = pendingFailovers.get(agent.id);

    if (!current) {
      // Pass-through request: remember the assigned endpoint so the breaker
      // can attribute this subagent's failures even before any failover.
      // Only tracked while orchestration is active — with the plugin disabled
      // (or absent config) neither the breaker nor telemetry may observe it.
      const config = getConfig();
      const orchestrationActive = Boolean(config && config.enabled !== false);
      const seed = (await next()) as RequestSeed | null | undefined;
      if (
        orchestrationActive &&
        seed &&
        typeof seed.provider === 'string' &&
        typeof seed.model === 'string'
      ) {
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

    // Orchestration turned off (or failover disabled) while a retry was
    // pending: drop the pending rewrite instead of applying it behind the
    // user's back. Requests pass through untouched from here on.
    const liveConfig = getConfig();
    if (!liveConfig || liveConfig.enabled === false || liveConfig.failover !== true) {
      pendingFailovers.delete(agent.id);
      return next();
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

  ctx.effect(() => async () => {
    lifetimeDisposed = true;
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
    pendingFailovers.clear();
    activeEndpoints.clear();
    defaultCircuitBreaker.clear();
    resetTelemetry();
    disposeWatcher();
    // Cancel in-flight retry waits so no late continuation mutates the
    // cleared state, then let them settle (all resolve promptly once cancelled).
    for (const wait of [...activeRetryWaits]) wait.cancel();
    await Promise.allSettled([...activeRetryWaits].map((w) => w.done));
  });
}
