import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

export const name = 'dsh-plugin-subagents-orchestrator';

// Failure codes that trigger failover to another model/provider
const FAILOVER_TRIGGER_CODES = ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'];
const WRAPPED = Symbol.for('dsh-plugin-subagents-orchestrator.wrapped');

function readConfig() {
  try {
    const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml');
    if (!fs.existsSync(settingsPath)) return null;
    const content = fs.readFileSync(settingsPath, 'utf8');
    const doc = yaml.load(content) || {};
    return doc['subagents-orchestrator'] || null;
  } catch {
    return null;
  }
}

function getEndpoints(config) {
  if (config && Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    return config.endpoints.filter((e) => e && e.provider && e.model);
  }
  return [];
}

function pickNextEndpoint(endpoints, strategy, cursor) {
  if (endpoints.length === 0) return null;
  if (strategy === 'random') {
    return endpoints[Math.floor(Math.random() * endpoints.length)];
  }
  return endpoints[cursor % endpoints.length];
}

function isSubagent(agent) {
  return agent !== void 0 && agent !== null && agent.session?.header?.origin === 'subagent';
}

export function apply(ctx) {
  let rrCursor = 0;
  const pendingFailovers = new Map();

  // 1. Intercept subagent delegations
  ctx.inject(['subagents'], (subagentCtx) => {
    const raw = subagentCtx.subagents?.[Symbol.for('cordis.original')] ?? subagentCtx.subagents;
    if (!raw || raw[WRAPPED]) return;

    const originalStart = raw.start;
    const originalStartContinuable = raw.startContinuable;

    function wrapRequest(request) {
      if (!request) return request;
      // Respect explicit model if already requested by caller
      if (request.agentOptions !== void 0) return request;

      const config = readConfig();
      if (!config || config.enabled === false) return request;

      const endpoints = getEndpoints(config);
      if (endpoints.length === 0) return request;

      const strategy = config.strategy || 'round-robin';
      const picked = pickNextEndpoint(endpoints, strategy, rrCursor++);
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

    if (typeof originalStart === 'function') {
      raw.start = async function (name, request) {
        return originalStart.call(raw, name, wrapRequest(request));
      };
    }

    if (typeof originalStartContinuable === 'function') {
      raw.startContinuable = async function (spec) {
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
  const disposeRequestError = ctx.on('agent/request-error', (payload, next) => {
    const config = readConfig();
    if (!config || config.failover !== true) return next();

    const endpoints = getEndpoints(config);
    if (endpoints.length < 2) return next();

    const { agent, failure, signal } = payload;
    if (signal?.aborted) return next();
    if (!isSubagent(agent)) return next();
    if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();

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
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();

    const current = pendingFailovers.get(agent.id);
    if (!current) return next();

    const config = readConfig();
    const endpoints = getEndpoints(config);
    const target = endpoints[current.index];
    if (!target) return next();

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

  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) pendingFailovers.delete(agent.id);
  });

  ctx.effect(() => () => {
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
    pendingFailovers.clear();
  });
}
