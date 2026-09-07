// src/config.ts
import fs from "fs";
import path from "path";
import os from "os";
import { load } from "js-yaml";
var DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".dsh", "settings.yaml");
var WATCH_DEBOUNCE_MS = 100;
var VALID_STRATEGIES = ["round-robin", "random", "weighted"];
var cachedConfig = null;
var cachedEndpoints = [];
var watcher = null;
var debounceTimer = null;
var activeFilePath = DEFAULT_SETTINGS_PATH;
var hasLoadedFromDisk = false;
var isCustomTestConfig = false;
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function parseEndpoint(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = raw["provider"];
  if (typeof provider !== "string" || provider.length === 0) return null;
  const model = raw["model"];
  if (typeof model !== "string" || model.length === 0) return null;
  const endpoint = { provider, model };
  const reasoningEffort = raw["reasoningEffort"];
  if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) {
    endpoint.reasoningEffort = reasoningEffort;
  }
  const weight = raw["weight"];
  if (isFiniteNumber(weight) && weight > 0) {
    endpoint.weight = weight;
  }
  if (typeof raw["enabled"] === "boolean") {
    endpoint.enabled = raw["enabled"];
  }
  return endpoint;
}
function parseConfigDocument(doc) {
  if (!isPlainObject(doc)) return null;
  const section = doc["subagents-orchestrator"];
  if (!isPlainObject(section)) return null;
  const config = {};
  if (typeof section["enabled"] === "boolean") config.enabled = section["enabled"];
  if (typeof section["failover"] === "boolean") config.failover = section["failover"];
  const strategy = section["strategy"];
  if (typeof strategy === "string" && VALID_STRATEGIES.includes(strategy)) {
    config.strategy = strategy;
  }
  if (isFiniteNumber(section["cooldownMs"])) config.cooldownMs = section["cooldownMs"];
  if (isFiniteNumber(section["maxFailures"])) config.maxFailures = section["maxFailures"];
  if (typeof section["debug"] === "boolean") config.debug = section["debug"];
  if (Array.isArray(section["endpoints"])) {
    const endpoints = section["endpoints"].map(parseEndpoint).filter((endpoint) => endpoint !== null);
    if (endpoints.length > 0) config.endpoints = endpoints;
  }
  return config;
}
function parseConfigFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    return parseConfigDocument(load(content));
  } catch {
    return null;
  }
}
function extractEndpoints(config) {
  if (config && Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    return config.endpoints.filter((e) => Boolean(e && e.provider && e.model && e.enabled !== false));
  }
  return [];
}
function reloadConfig() {
  if (isCustomTestConfig) return;
  cachedConfig = parseConfigFile(activeFilePath);
  cachedEndpoints = extractEndpoints(cachedConfig);
  hasLoadedFromDisk = true;
}
function ensureLoaded() {
  if (!hasLoadedFromDisk && !watcher) reloadConfig();
}
function getConfig() {
  ensureLoaded();
  return cachedConfig;
}
function getCachedEndpoints() {
  ensureLoaded();
  return cachedEndpoints;
}
function scheduleReload() {
  if (isCustomTestConfig) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reloadConfig();
  }, WATCH_DEBOUNCE_MS);
  debounceTimer.unref();
}
function initWatcher(filePath = DEFAULT_SETTINGS_PATH) {
  disposeWatcher();
  activeFilePath = filePath;
  reloadConfig();
  const targetDir = path.dirname(filePath);
  const targetBase = path.basename(filePath);
  try {
    if (!fs.existsSync(targetDir)) return;
    const dirWatcher = fs.watch(targetDir, (eventType, filename) => {
      if (!filename || filename === targetBase) scheduleReload();
    });
    dirWatcher.on("error", () => {
      if (watcher === dirWatcher) watcher = null;
    });
    watcher = dirWatcher;
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

// src/ratelimit.ts
var MAX_HINT_COOLDOWN_MS = 15 * 60 * 1e3;
var RETRY_AFTER_HEADERS = ["retry-after"];
var RATE_LIMIT_RESET_HEADERS = ["x-ratelimit-reset", "ratelimit-reset"];
function pickHeader(headers, names) {
  if (!headers) return null;
  for (const name2 of names) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== name2) continue;
      const value = headers[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}
function toEpochMs(value) {
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1e3;
  return null;
}
function extractCooldownHintMs(failure, now = Date.now()) {
  if (!failure) return null;
  const response = failure.response;
  const sources = [failure.headers, response?.headers];
  let hintMs = null;
  const retryAfter = sources.map((h) => pickHeader(h, RETRY_AFTER_HEADERS)).find((v) => v !== null);
  if (retryAfter != null) {
    const asSeconds = Number(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      hintMs = asSeconds * 1e3;
    } else {
      const when = Date.parse(retryAfter);
      if (!Number.isNaN(when)) hintMs = Math.max(0, when - now);
    }
  }
  if (hintMs === null) {
    const reset = sources.map((h) => pickHeader(h, RATE_LIMIT_RESET_HEADERS)).find((v) => v !== null);
    if (reset != null) {
      const value = Number(reset);
      if (Number.isFinite(value) && value >= 0) {
        const epochMs = toEpochMs(value);
        hintMs = epochMs !== null ? Math.max(0, epochMs - now) : value * 1e3;
      }
    }
  }
  if (hintMs === null) return null;
  return Math.min(Math.max(0, hintMs), MAX_HINT_COOLDOWN_MS);
}

// src/telemetry.ts
var MAX_EVENT_BUFFER = 100;
var statsByKey = /* @__PURE__ */ new Map();
var eventBuffer = [];
var debugMode = "auto";
function setDebugLogging(enabled) {
  debugMode = enabled === true ? "on" : enabled === false ? "off" : "auto";
}
function isDebugEnabled() {
  if (debugMode === "on") return true;
  if (debugMode === "off") return false;
  const flag = process.env["DSH_ORCHESTRATOR_DEBUG"];
  return flag === "1" || flag === "true";
}
function emit(event) {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_EVENT_BUFFER) eventBuffer.shift();
  if (isDebugEnabled()) {
    console.debug("[subagents-orchestrator]", JSON.stringify(event));
  }
}
function ensureStats(endpoint) {
  const key = `${endpoint.provider}::${endpoint.model}`;
  let entry = statsByKey.get(key);
  if (!entry) {
    entry = {
      key,
      provider: endpoint.provider,
      model: endpoint.model,
      requests: 0,
      failures: 0,
      failovers: 0,
      cooldownHints: 0,
      lastFailureAt: null,
      lastFailureCode: null
    };
    statsByKey.set(key, entry);
  }
  return entry;
}
function recordRequest(agentId, endpoint, now = Date.now()) {
  ensureStats(endpoint).requests += 1;
  emit({ at: now, type: "request", agentId, to: { ...endpoint } });
}
function recordFailure(agentId, endpoint, code, hintMs, now = Date.now()) {
  const entry = ensureStats(endpoint);
  entry.failures += 1;
  if (hintMs !== void 0) entry.cooldownHints += 1;
  entry.lastFailureAt = now;
  entry.lastFailureCode = code;
  emit({ at: now, type: "failure", agentId, from: { ...endpoint }, code, ...hintMs !== void 0 ? { hintMs } : {} });
}
function recordFailover(agentId, from, to, now = Date.now()) {
  if (from) ensureStats(from);
  ensureStats(to).failovers += 1;
  emit({
    at: now,
    type: "failover",
    agentId,
    ...from ? { from: { ...from } } : {},
    to: { ...to }
  });
}
function resetTelemetry() {
  statsByKey.clear();
  eventBuffer.length = 0;
  debugMode = "auto";
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
  function refreshTelemetryDebug() {
    setDebugLogging(getConfig()?.debug);
  }
  refreshTelemetryDebug();
  function wrapRequest(request) {
    const config = getConfig();
    if (!config || config.enabled === false) return request;
    refreshTelemetryDebug();
    const endpoints = getCachedEndpoints();
    if (endpoints.length === 0) return request;
    if (request && request.agentOptions !== void 0) return request;
    const picked = pickNextEndpoint(
      endpoints,
      config.strategy || "round-robin",
      rrCursor++,
      defaultCircuitBreaker
    );
    if (!picked) return request;
    return {
      ...request ?? {},
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
        if (!spec) {
          const routed = wrapRequest(void 0);
          return originalStartContinuable.call(raw, routed ? { request: routed } : void 0);
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
  const disposeRequestError = ctx.on("agent/request-error", (payload, next) => {
    const config = getConfig();
    if (!config || config.failover !== true) return next();
    refreshTelemetryDebug();
    const endpoints = getCachedEndpoints();
    if (endpoints.length < 2) return next();
    const { agent, failure, signal } = payload;
    if (signal?.aborted) return next();
    if (!isSubagent(agent)) return next();
    if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();
    const currentEndpoint = activeEndpoints.get(agent.id);
    if (currentEndpoint) {
      const hintMs = extractCooldownHintMs(failure);
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        hintMs !== null ? 1 : config.maxFailures || 3,
        hintMs ?? config.cooldownMs ?? 6e4
      );
      recordFailure(agent.id, currentEndpoint, failure.code, hintMs !== null ? hintMs : void 0);
    }
    const current = pendingFailovers.get(agent.id) || { count: 0, index: 0 };
    if (current.count >= endpoints.length - 1) return next();
    let nextIndex = -1;
    for (let step = 1; step <= endpoints.length - 1; step++) {
      const candidateIndex = (current.index + step) % endpoints.length;
      const candidate = endpoints[candidateIndex];
      const isCurrent = currentEndpoint !== void 0 && defaultCircuitBreaker.getEndpointKey(candidate) === defaultCircuitBreaker.getEndpointKey(currentEndpoint);
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
    recordFailover(agent.id, currentEndpoint ?? void 0, endpoints[nextIndex]);
    return { kind: "retry" };
  });
  const disposeRequest = ctx.on("agent/request", async (payload, next) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();
    const current = pendingFailovers.get(agent.id);
    if (!current) {
      const seed2 = await next();
      if (seed2 && typeof seed2.provider === "string" && typeof seed2.model === "string") {
        const assigned = {
          provider: seed2.provider,
          model: seed2.model,
          ...typeof seed2.reasoningEffort === "string" ? { reasoningEffort: seed2.reasoningEffort } : {}
        };
        activeEndpoints.set(agent.id, assigned);
        recordRequest(agent.id, assigned);
      }
      return seed2;
    }
    const endpoints = getCachedEndpoints();
    const target = endpoints[current.index];
    if (!target) return next();
    activeEndpoints.set(agent.id, target);
    recordRequest(agent.id, target);
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
    resetTelemetry();
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