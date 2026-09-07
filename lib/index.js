// src/config.ts
import fs from "fs";
import path from "path";
import os from "os";
import { load } from "js-yaml";
var DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".dsh", "settings.yaml");
var cachedConfig = null;
var cachedEndpoints = [];
var watcher = null;
var debounceTimer = null;
var activeFilePath = DEFAULT_SETTINGS_PATH;
var isCustomTestConfig = false;
function parseConfigFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    const doc = load(content) || {};
    return doc["subagents-orchestrator"] || null;
  } catch {
    return null;
  }
}
function extractEndpoints(config) {
  if (config && Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    return config.endpoints.filter((e) => Boolean(e && e.provider && e.model));
  }
  return [];
}
function reloadConfig() {
  if (isCustomTestConfig) return;
  cachedConfig = parseConfigFile(activeFilePath);
  cachedEndpoints = extractEndpoints(cachedConfig);
}
function getConfig() {
  if (cachedConfig === null && !watcher) {
    reloadConfig();
  }
  return cachedConfig;
}
function getCachedEndpoints() {
  if (cachedConfig === null && !watcher) {
    reloadConfig();
  }
  return cachedEndpoints;
}
function initWatcher(filePath = DEFAULT_SETTINGS_PATH) {
  disposeWatcher();
  activeFilePath = filePath;
  reloadConfig();
  const targetDir = path.dirname(filePath);
  const targetBase = path.basename(filePath);
  try {
    if (fs.existsSync(targetDir)) {
      watcher = fs.watch(targetDir, (eventType, filename) => {
        if (!filename || filename === targetBase) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            reloadConfig();
          }, 100);
        }
      });
    }
  } catch {
    watcher = null;
  }
}
function disposeWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// src/health.ts
var DEFAULT_MAX_FAILURES = 3;
var DEFAULT_COOLDOWN_MS = 6e4;
var CircuitBreaker = class {
  healthMap = /* @__PURE__ */ new Map();
  /** Stable identity for an endpoint: its provider::model pair. */
  getEndpointKey(endpoint) {
    return `${endpoint.provider}::${endpoint.model}`;
  }
  /** Get (creating if absent) the health record for an endpoint. */
  getStatus(endpoint) {
    const key = this.getEndpointKey(endpoint);
    let status = this.healthMap.get(key);
    if (!status) {
      status = {
        consecutiveFailures: 0,
        trippedUntil: null,
        lastFailureAt: null
      };
      this.healthMap.set(key, status);
    }
    return status;
  }
  /**
   * Whether the endpoint may serve traffic at instant `now`.
   *
   * An elapsed cooldown transitions the endpoint back into rotation
   * (probation): `trippedUntil` is cleared, while `consecutiveFailures` is
   * deliberately retained so the very next failure re-trips the endpoint.
   */
  isHealthy(endpoint, now = Date.now()) {
    const status = this.getStatus(endpoint);
    if (status.trippedUntil === null) return true;
    if (now >= status.trippedUntil) {
      status.trippedUntil = null;
      return true;
    }
    return false;
  }
  /**
   * Record a failed request against the endpoint.
   *
   * A failure arriving while the endpoint is already tripped (only possible
   * through the all-tripped degradation fallback) re-arms the cooldown window
   * from the newest failure, so the remaining window can never shrink.
   *
   * @returns `true` when this failure (re)tripped the endpoint.
   */
  recordFailure(endpoint, maxFailures = DEFAULT_MAX_FAILURES, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now()) {
    const status = this.getStatus(endpoint);
    status.consecutiveFailures += 1;
    status.lastFailureAt = now;
    const threshold = Math.max(1, maxFailures);
    const cooldown = Math.max(0, cooldownMs);
    if (status.trippedUntil !== null && now < status.trippedUntil) {
      status.trippedUntil = now + cooldown;
      return true;
    }
    if (status.consecutiveFailures >= threshold) {
      status.trippedUntil = now + cooldown;
      return true;
    }
    return false;
  }
  /** Record a successful request: closes the circuit and clears the streak. */
  recordSuccess(endpoint) {
    const key = this.getEndpointKey(endpoint);
    const status = this.healthMap.get(key);
    if (status) {
      status.consecutiveFailures = 0;
      status.trippedUntil = null;
    }
  }
  /**
   * The healthy subset of `endpoints`, preserving input order.
   *
   * Fallback protection: if *every* endpoint is currently tripped, the full
   * list is returned instead of an empty pool — a degraded attempt beats a
   * hard stall, and the outcome still feeds the breaker.
   */
  filterHealthy(endpoints, now = Date.now()) {
    if (endpoints.length === 0) return [];
    const healthy = endpoints.filter((e) => this.isHealthy(e, now));
    return healthy.length > 0 ? healthy : endpoints;
  }
  /** Forget all recorded health state. */
  clear() {
    this.healthMap.clear();
  }
};
var defaultCircuitBreaker = new CircuitBreaker();

// src/balancer.ts
function pickWeighted(endpoints) {
  if (!endpoints || endpoints.length === 0) return null;
  const weights = endpoints.map((e) => Math.max(1, e.weight || 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let randomVal = Math.random() * totalWeight;
  for (let i = 0; i < endpoints.length; i++) {
    randomVal -= weights[i];
    if (randomVal <= 0) {
      return endpoints[i];
    }
  }
  return endpoints[endpoints.length - 1];
}
function pickNextEndpoint(endpoints, strategy = "round-robin", cursor = 0, breaker = defaultCircuitBreaker) {
  if (!endpoints || endpoints.length === 0) return null;
  const pool = breaker.filterHealthy(endpoints);
  if (pool.length === 0) return null;
  switch (strategy) {
    case "random":
      return pool[Math.floor(Math.random() * pool.length)];
    case "weighted":
      return pickWeighted(pool);
    case "round-robin":
    default: {
      const index = Math.abs(Math.trunc(cursor)) % pool.length;
      return pool[index];
    }
  }
}

// src/index.ts
var name = "dsh-plugin-subagents-orchestrator";
var FAILOVER_TRIGGER_CODES = [
  "RATE_LIMIT",
  "QUOTA",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE"
];
var WRAPPED = /* @__PURE__ */ Symbol.for("dsh-plugin-subagents-orchestrator.wrapped");
function isSubagent(agent) {
  return Boolean(agent && agent.session?.header?.origin === "subagent");
}
function apply(ctx) {
  let rrCursor = 0;
  const pendingFailovers = /* @__PURE__ */ new Map();
  const activeEndpoints = /* @__PURE__ */ new Map();
  initWatcher();
  function wrapRequest(request) {
    if (!request) return request;
    if (request.agentOptions !== void 0) return request;
    const config = getConfig();
    if (!config || config.enabled === false) return request;
    const endpoints = getCachedEndpoints();
    if (endpoints.length === 0) return request;
    const picked = pickNextEndpoint(
      endpoints,
      config.strategy || "round-robin",
      rrCursor++,
      defaultCircuitBreaker
    );
    if (!picked) return request;
    return {
      ...request,
      agentOptions: {
        provider: picked.provider,
        model: picked.model,
        ...picked.reasoningEffort ? { reasoningEffort: picked.reasoningEffort } : {}
      }
    };
  }
  ctx.inject(["subagents"], (subagentCtx) => {
    const raw = subagentCtx.subagents?.[/* @__PURE__ */ Symbol.for("cordis.original")] ?? subagentCtx.subagents;
    if (!raw || raw[WRAPPED]) return;
    const originalStart = raw.start;
    const originalStartContinuable = raw.startContinuable;
    if (typeof originalStart === "function") {
      raw.start = async function(subagentName, request) {
        return originalStart.call(raw, subagentName, wrapRequest(request));
      };
    }
    if (typeof originalStartContinuable === "function") {
      raw.startContinuable = async function(spec) {
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
  const disposeRequestError = ctx.on("agent/request-error", (payload, next) => {
    const config = getConfig();
    if (!config || config.failover !== true) return next();
    const endpoints = getCachedEndpoints();
    if (endpoints.length < 2) return next();
    const { agent, failure, signal } = payload;
    if (signal?.aborted) return next();
    if (!isSubagent(agent)) return next();
    if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();
    const currentEndpoint = activeEndpoints.get(agent.id);
    if (currentEndpoint) {
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        config.maxFailures || 3,
        config.cooldownMs || 6e4
      );
    }
    const current = pendingFailovers.get(agent.id) || { count: 0, index: 0 };
    if (current.count >= endpoints.length - 1) return next();
    const nextIndex = (current.index + 1) % endpoints.length;
    pendingFailovers.set(agent.id, {
      count: current.count + 1,
      index: nextIndex
    });
    return { kind: "retry" };
  });
  const disposeRequest = ctx.on("agent/request", async (payload, next) => {
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
      ...target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}
    };
  });
  const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
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
export {
  FAILOVER_TRIGGER_CODES,
  WRAPPED,
  apply,
  isSubagent,
  name
};
//# sourceMappingURL=index.js.map