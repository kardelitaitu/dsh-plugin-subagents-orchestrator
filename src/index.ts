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
import { recordRequest, recordFailure, recordFailover, resetTelemetry, setDebugLogging, forgetAgent } from './telemetry.js';
import { flushTelemetryToDisk } from './persist.js';

export const name = 'dsh-plugin-subagents-orchestrator';

export const FAILOVER_TRIGGER_CODES = [
  'RATE_LIMIT',
  'QUOTA',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  // Per-provider credential failures (dsh-llm throws these with the provider
  // route in the message): a dead key on one account does not implicate the
  // other pool entries, so switching accounts is exactly the remedy.
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL'
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

/** Same-endpoint retry budget before failing over to the next pool entry. */
export const DEFAULT_MAX_RETRIES = 20;

/**
 * Resolve the per-endpoint same-endpoint retry budget.
 *
 * Defaults to 20 retries. Non-finite or negative values fall back to the
 * default; a valid value is floored to a whole retry count.
 */
export function resolveMaxRetries(config: OrchestratorConfig | null | undefined): number {
  const valid = typeof config?.maxRetries === 'number' && Number.isFinite(config.maxRetries) && config.maxRetries >= 0;
  return Math.floor(valid ? config!.maxRetries! : DEFAULT_MAX_RETRIES);
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
  /** Same-endpoint retry accounting for one agent's failed (turn, step). */
  interface RetryIncident {
    endpointKey: string;
    turn: unknown;
    step: unknown;
    retries: number;
  }
  const retryIncidents = new Map<string, RetryIncident>();
  /**
   * Agents whose failover walk is spent for the current incident, keyed by
   * agent id with the incident's turn/step. Same incident -> keep deferring;
   * a different turn/step re-arms the walk.
   */
  const exhaustedAgents = new Map<string, { turn: unknown; step: unknown }>();

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

  // 2. Same-endpoint retry budget, then multi-endpoint automatic failover on
  //    connection/rate-limit failure.
  const disposeRequestError = ctx.on('agent/request-error', async (payload: RequestErrorPayload, next: () => any): Promise<RequestErrorAction> => {
    try {
      const config = getConfig();
      // A disabled plugin is fully inert: `failover: true` alone must not
      // resurrect failover handling for agents attributed before the disable.
      // Failover defaults to on (README contract): only an explicit
      // `failover: false` disables it.
      if (!config || config.enabled === false || config.failover === false) return next();
      refreshTelemetryDebug();

      const endpoints = getCachedEndpoints();
      if (endpoints.length < 2) return next();

      const { agent, failure, signal } = payload;
      if (signal?.aborted) return next();
      if (!isSubagent(agent)) return next();
      if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();

      // Attribution: the host always dispatches `agent/request` (recorded by
      // the pass-through listener above) before any request can fail, so an
      // unattributed error leaves us unable to count the endpoint's retries
      // or pick a sensible next fallback — defer to the host instead.
      const currentEndpoint = activeEndpoints.get(agent.id);
      if (!currentEndpoint) return next();
      const endpointKey = defaultCircuitBreaker.getEndpointKey(currentEndpoint);

      // A provider cooldown hint re-arms the walk BEFORE the exhaustion check:
      // the endpoint was tripped for the provider's exact window, so a prior
      // give-up of THIS incident is stale info. Other incidents are untouched.
      const hintMs = extractCooldownHintMs(failure);
      if (hintMs !== null) {
        const marker = exhaustedAgents.get(agent.id);
        if (marker && marker.turn === payload.turn && marker.step === payload.step) {
          exhaustedAgents.delete(agent.id);
        }
      }

      // Trip circuit breaker on failure. A provider cooldown hint
      // (Retry-After / x-ratelimit-reset, host-parsed when available) trips
      // the endpoint immediately for exactly that window; otherwise the
      // consecutive-failure threshold and the configured cooldown apply.
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        hintMs !== null ? 1 : config.maxFailures || 3,
        hintMs ?? config.cooldownMs ?? 60000
      );
      recordFailure(agent.id, currentEndpoint, failure.code, hintMs !== null ? hintMs : undefined);

      // The walk is spent for this incident: keep accounting the failure
      // (breaker + telemetry above) but defer the decision - never re-plan a
      // failover the plugin already declined.
      const exhaustedMarker = exhaustedAgents.get(agent.id);
      if (
        exhaustedMarker &&
        exhaustedMarker.turn === payload.turn &&
        exhaustedMarker.step === payload.step
      ) {
        pendingFailovers.delete(agent.id);
        return next();
      }

      // Terminal failures point at the account, not at transient load: an
      // exhausted quota/balance and a broken credential cannot heal on the
      // same endpoint, so pacing more retries against it is pure waste. They
      // skip the same-endpoint budget and switch accounts at once (same
      // exception as provider cooldown hints).
      const isTerminalFailure =
        failure.code === 'INVALID_CREDENTIAL' ||
        failure.code === 'MISSING_CREDENTIAL' ||
        failure.code === 'QUOTA';

      // Same-endpoint retry budget: retry the CURRENT endpoint up to
      // `maxRetries` times (default 20) with the configured 3-5s pacing
      // before considering a failover. The count is scoped to the failed
      // (turn, step) — a later successful step resets it — and to the
      // endpoint key, so every failover target starts with a fresh budget.
      //
      // A provider cooldown hint is the exception: the endpoint is tripped
      // for exactly the window the provider asked for, so pacing 3-5s
      // retries against it is futile — fail over immediately instead.
      if (hintMs === null && !isTerminalFailure) {
        const incident = retryIncidents.get(agent.id);
        const sameIncident = incident !== undefined
          && incident.endpointKey === endpointKey
          && incident.turn === payload.turn
          && incident.step === payload.step;
        const retries = sameIncident ? incident.retries + 1 : 1;
        retryIncidents.set(agent.id, {
          endpointKey,
          turn: payload.turn,
          step: payload.step,
          retries
        });

        if (retries <= resolveMaxRetries(config)) {
          // Pacing: hold the retry decision for the configured interval
          // window so the provider's rate-limit window can drain before the
          // next attempt on this endpoint.
          await delayRetryWait(signal, resolveRetryDelayMs(config));
          if (lifetimeDisposed) retryIncidents.delete(agent.id);
          return { kind: 'retry' };
        }
      }

      // Retry budget exhausted (or provider-hinted trip): advance to the
      // next fallback endpoint, skipping endpoints the breaker has tripped
      // (unless every remaining candidate is tripped — degraded attempts
      // still beat a hard stall).
      const currentIndex = endpoints.findIndex((e) => defaultCircuitBreaker.getEndpointKey(e) === endpointKey);
      const current = pendingFailovers.get(agent.id) || { count: 0, index: currentIndex >= 0 ? currentIndex : 0 };
      if (current.count >= endpoints.length - 1) {
        // Give up on this agent for this incident. Without clearing the state,
        // a later host-driven retry would still be rewritten onto the stale
        // failover target even though the plugin declined to fail over again.
        // The exhaustion marker sticks until the incident state resets (a new
        // turn/step or disposal), otherwise the next failure would restart the
        // walk and ping-pong a fully dead pool forever.
        pendingFailovers.delete(agent.id);
        retryIncidents.delete(agent.id);
        exhaustedAgents.set(agent.id, { turn: payload.turn, step: payload.step });
        return next();
      }

      // Advance to the next candidate, skipping endpoints the breaker has tripped
      // (unless every remaining candidate is tripped — degraded attempts still
      // beat a hard stall).
      let nextIndex = -1;
      for (let step = 1; step <= endpoints.length - 1; step++) {
        const candidateIndex = (current.index + step) % endpoints.length;
        const candidate = endpoints[candidateIndex];
        const isCurrent = defaultCircuitBreaker.getEndpointKey(candidate) === endpointKey;
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

      recordFailover(agent.id, currentEndpoint, endpoints[nextIndex]);

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

    // Orchestration turned off (or failover explicitly disabled) while a
    // retry was pending: drop the pending rewrite instead of applying it
    // behind the user's back. Requests pass through untouched from here on.
    const liveConfig = getConfig();
    if (!liveConfig || liveConfig.enabled === false || liveConfig.failover === false) {
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
      retryIncidents.delete(agent.id);
      exhaustedAgents.delete(agent.id);
      // Success-path latency bookkeeping has no other consumer: without
      // this release every successful subagent leaks its request-start
      // entry for the host's whole lifetime.
      forgetAgent(agent.id);
    }
  });

  ctx.effect(() => async () => {
    lifetimeDisposed = true;
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
    // Durable diagnostics (opt-in via persistTelemetry): drain the event ring
    // and snapshot endpoint counters BEFORE the telemetry state is reset.
    if (getConfig()?.persistTelemetry === true) {
      flushTelemetryToDisk();
    }
    pendingFailovers.clear();
    activeEndpoints.clear();
    retryIncidents.clear();
    exhaustedAgents.clear();
    defaultCircuitBreaker.clear();
    resetTelemetry();
    disposeWatcher();
    // Cancel in-flight retry waits so no late continuation mutates the
    // cleared state, then let them settle (all resolve promptly once cancelled).
    for (const wait of [...activeRetryWaits]) wait.cancel();
    await Promise.allSettled([...activeRetryWaits].map((w) => w.done));
  });
}
