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
  if (isFiniteNumber(section["intervalMinMs"])) config.intervalMinMs = section["intervalMinMs"];
  if (isFiniteNumber(section["intervalMaxMs"])) config.intervalMaxMs = section["intervalMaxMs"];
  if (isFiniteNumber(section["maxRetries"])) config.maxRetries = section["maxRetries"];
  if (typeof section["debug"] === "boolean") config.debug = section["debug"];
  if (typeof section["persistTelemetry"] === "boolean") config.persistTelemetry = section["persistTelemetry"];
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
  const parsed = parseConfigFile(activeFilePath);
  if (parsed === null && cachedConfig !== null && !fs.existsSync(path.dirname(activeFilePath))) {
    hasLoadedFromDisk = true;
    return;
  }
  cachedConfig = parsed;
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
  if (isCustomTestConfig) {
    return;
  }
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
      status.trippedUntil = Math.max(status.trippedUntil, now + cooldown);
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
      const safeCursor = Number.isFinite(cursor) ? Math.abs(Math.trunc(cursor)) : 0;
      const index = safeCursor % pool.length;
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
  const hostHint = failure.providerRetryAfterMs;
  if (typeof hostHint === "number" && Number.isFinite(hostHint) && hostHint > 0) {
    if (hostHint <= MAX_HINT_COOLDOWN_MS) return hostHint;
    return MAX_HINT_COOLDOWN_MS;
  }
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
var requestStarts = /* @__PURE__ */ new Map();
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
      lastFailureCode: null,
      latencySamples: 0,
      latencyTotalMs: 0,
      latencyMaxMs: 0,
      lastLatencyMs: null
    };
    statsByKey.set(key, entry);
  }
  return entry;
}
function recordRequest(agentId, endpoint, now = Date.now()) {
  ensureStats(endpoint).requests += 1;
  requestStarts.set(agentId, { endpoint: { ...endpoint }, at: now });
  emit({ at: now, type: "request", agentId, to: { ...endpoint } });
}
function forgetAgent(agentId) {
  requestStarts.delete(agentId);
}
function recordFailure(agentId, endpoint, code, hintMs, now = Date.now()) {
  const entry = ensureStats(endpoint);
  entry.failures += 1;
  if (hintMs !== void 0) entry.cooldownHints += 1;
  entry.lastFailureAt = now;
  entry.lastFailureCode = code;
  const start = requestStarts.get(agentId);
  let latencyMs;
  if (start) {
    requestStarts.delete(agentId);
    latencyMs = Math.max(0, now - start.at);
    entry.latencySamples += 1;
    entry.latencyTotalMs += latencyMs;
    entry.latencyMaxMs = Math.max(entry.latencyMaxMs, latencyMs);
    entry.lastLatencyMs = latencyMs;
  }
  emit({
    at: now,
    type: "failure",
    agentId,
    from: { ...endpoint },
    code,
    ...hintMs !== void 0 ? { hintMs } : {},
    ...latencyMs !== void 0 ? { latencyMs } : {}
  });
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
function getEndpointStats() {
  return Array.from(statsByKey.values()).map((entry) => ({ ...entry }));
}
function getRecentEvents(limit = MAX_EVENT_BUFFER) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return eventBuffer.slice(-limit).map((event) => ({ ...event }));
}
function resetTelemetry() {
  statsByKey.clear();
  eventBuffer.length = 0;
  requestStarts.clear();
  debugMode = "auto";
}
function drainRecentEvents() {
  return eventBuffer.splice(0, eventBuffer.length).map((event) => ({ ...event }));
}

// src/persist.ts
import fs2 from "fs";
import path2 from "path";
import os2 from "os";
var DEFAULT_PERSIST_DIR = path2.join(os2.homedir(), ".dsh", "telemetry", "subagents-orchestrator");
var MAX_PERSIST_DAYS = 7;
var persistDir = DEFAULT_PERSIST_DIR;
function eventFileName(now) {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `events-${d.getFullYear()}-${mm}-${dd}.jsonl`;
}
function ensureDir() {
  try {
    fs2.mkdirSync(persistDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
function appendEvents(events, now = Date.now()) {
  if (!events || events.length === 0) return 0;
  if (!ensureDir()) return 0;
  const file = path2.join(persistDir, eventFileName(now));
  try {
    const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs2.appendFileSync(file, payload, "utf8");
    return events.length;
  } catch {
    return 0;
  }
}
function writeEndpointStatsSnapshot(stats, now = Date.now()) {
  if (!ensureDir()) return false;
  const target = path2.join(persistDir, "endpoints.json");
  const tmp = path2.join(persistDir, `.endpoints.${process.pid}.${now}.tmp`);
  try {
    fs2.writeFileSync(tmp, JSON.stringify({ at: now, endpoints: stats }, null, 2), "utf8");
    fs2.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs2.rmSync(tmp, { force: true });
    } catch {
    }
    return false;
  }
}
function pruneOldBuckets(now = Date.now()) {
  try {
    if (!fs2.existsSync(persistDir)) return [];
    const files = fs2.readdirSync(persistDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    const removed = [];
    for (const file of files.slice(MAX_PERSIST_DAYS)) {
      try {
        fs2.rmSync(path2.join(persistDir, file), { force: true });
        removed.push(file);
      } catch {
      }
    }
    return removed;
  } catch {
    return [];
  }
}
function flushTelemetryToDisk(now = Date.now()) {
  const pending = getRecentEvents();
  const eventsWritten = pending.length > 0 ? appendEvents(pending, now) : 0;
  if (pending.length > 0 && eventsWritten === pending.length) {
    drainRecentEvents();
  }
  const snapshotWritten = writeEndpointStatsSnapshot(getEndpointStats(), now);
  const bucketsPruned = pruneOldBuckets(now);
  return { eventsWritten, snapshotWritten, bucketsPruned };
}

// src/index.ts
var name = "dsh-plugin-subagents-orchestrator";
var FAILOVER_TRIGGER_CODES = [
  "RATE_LIMIT",
  "QUOTA",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  // Per-provider credential failures (dsh-llm throws these with the provider
  // route in the message): a dead key on one account does not implicate the
  // other pool entries, so switching accounts is exactly the remedy.
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL"
];
var WRAPPED = /* @__PURE__ */ Symbol.for("dsh-plugin-subagents-orchestrator.wrapped");
var DEFAULT_RETRY_INTERVAL_MIN_MS = 3e3;
var DEFAULT_RETRY_INTERVAL_MAX_MS = 5e3;
function resolveRetryDelayMs(config, random = Math.random) {
  const minValid = typeof config?.intervalMinMs === "number" && Number.isFinite(config.intervalMinMs) && config.intervalMinMs >= 0;
  const maxValid = typeof config?.intervalMaxMs === "number" && Number.isFinite(config.intervalMaxMs) && config.intervalMaxMs >= 0;
  const min = minValid ? config.intervalMinMs : DEFAULT_RETRY_INTERVAL_MIN_MS;
  const max = maxValid ? config.intervalMaxMs : DEFAULT_RETRY_INTERVAL_MAX_MS;
  const cappedMax = Math.max(min, max);
  return min + random() * (cappedMax - min);
}
var DEFAULT_MAX_RETRIES = 20;
function resolveMaxRetries(config) {
  const valid = typeof config?.maxRetries === "number" && Number.isFinite(config.maxRetries) && config.maxRetries >= 0;
  return Math.floor(valid ? config.maxRetries : DEFAULT_MAX_RETRIES);
}
function isSubagent(agent) {
  return Boolean(agent && agent.session?.header?.origin === "subagent");
}
function apply(ctx) {
  let rrCursor = 0;
  const pendingFailovers = /* @__PURE__ */ new Map();
  const activeEndpoints = /* @__PURE__ */ new Map();
  const activeRetryWaits = /* @__PURE__ */ new Set();
  let lifetimeDisposed = false;
  const retryIncidents = /* @__PURE__ */ new Map();
  const exhaustedAgents = /* @__PURE__ */ new Map();
  initWatcher();
  function delayRetryWait(signal, delayMs) {
    if (lifetimeDisposed || signal?.aborted || !(delayMs > 0)) {
      return Promise.resolve();
    }
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const entry = {
      done,
      cancel: () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        activeRetryWaits.delete(entry);
        resolveDone();
      }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      activeRetryWaits.delete(entry);
      resolveDone();
    }, delayMs);
    const onAbort = () => entry.cancel();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    activeRetryWaits.add(entry);
    return done;
  }
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
  const disposeRequestError = ctx.on("agent/request-error", async (payload, next) => {
    try {
      const config = getConfig();
      if (!config || config.enabled === false || config.failover === false) return next();
      refreshTelemetryDebug();
      const endpoints = getCachedEndpoints();
      if (endpoints.length < 2) return next();
      const { agent, failure, signal } = payload;
      if (signal?.aborted) return next();
      if (!isSubagent(agent)) return next();
      if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();
      const currentEndpoint = activeEndpoints.get(agent.id);
      if (!currentEndpoint) return next();
      const endpointKey = defaultCircuitBreaker.getEndpointKey(currentEndpoint);
      const hintMs = extractCooldownHintMs(failure);
      if (hintMs !== null) {
        const marker = exhaustedAgents.get(agent.id);
        if (marker && marker.turn === payload.turn && marker.step === payload.step) {
          exhaustedAgents.delete(agent.id);
        }
      }
      defaultCircuitBreaker.recordFailure(
        currentEndpoint,
        hintMs !== null ? 1 : config.maxFailures || 3,
        hintMs ?? config.cooldownMs ?? 6e4
      );
      recordFailure(agent.id, currentEndpoint, failure.code, hintMs !== null ? hintMs : void 0);
      const exhaustedMarker = exhaustedAgents.get(agent.id);
      if (exhaustedMarker && exhaustedMarker.turn === payload.turn && exhaustedMarker.step === payload.step) {
        pendingFailovers.delete(agent.id);
        return next();
      }
      const isTerminalFailure = failure.code === "INVALID_CREDENTIAL" || failure.code === "MISSING_CREDENTIAL" || failure.code === "QUOTA";
      if (hintMs === null && !isTerminalFailure) {
        const incident = retryIncidents.get(agent.id);
        const sameIncident = incident !== void 0 && incident.endpointKey === endpointKey && incident.turn === payload.turn && incident.step === payload.step;
        const retries = sameIncident ? incident.retries + 1 : 1;
        retryIncidents.set(agent.id, {
          endpointKey,
          turn: payload.turn,
          step: payload.step,
          retries
        });
        if (retries <= resolveMaxRetries(config)) {
          await delayRetryWait(signal, resolveRetryDelayMs(config));
          if (lifetimeDisposed) retryIncidents.delete(agent.id);
          return { kind: "retry" };
        }
      }
      const currentIndex = endpoints.findIndex((e) => defaultCircuitBreaker.getEndpointKey(e) === endpointKey);
      const current = pendingFailovers.get(agent.id) || { count: 0, index: currentIndex >= 0 ? currentIndex : 0 };
      if (current.count >= endpoints.length - 1) {
        pendingFailovers.delete(agent.id);
        retryIncidents.delete(agent.id);
        exhaustedAgents.set(agent.id, { turn: payload.turn, step: payload.step });
        return next();
      }
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
      await delayRetryWait(signal, resolveRetryDelayMs(config));
      if (lifetimeDisposed || signal?.aborted) {
        return { kind: "retry" };
      }
      pendingFailovers.set(agent.id, {
        count: current.count + 1,
        index: nextIndex
      });
      recordFailover(agent.id, currentEndpoint, endpoints[nextIndex]);
      return { kind: "retry" };
    } catch (error) {
      try {
        const logger = ctx.logger;
        logger?.warn?.("subagents-orchestrator: failover handling failed, delegating:", error);
      } catch {
      }
      return next();
    }
  });
  const disposeRequest = ctx.on("agent/request", async (payload, next) => {
    const { agent } = payload;
    if (!isSubagent(agent)) return next();
    const current = pendingFailovers.get(agent.id);
    if (!current) {
      const config = getConfig();
      const orchestrationActive = Boolean(config && config.enabled !== false);
      const seed2 = await next();
      if (orchestrationActive && seed2 && typeof seed2.provider === "string" && typeof seed2.model === "string") {
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
      retryIncidents.delete(agent.id);
      exhaustedAgents.delete(agent.id);
      forgetAgent(agent.id);
    }
  });
  ctx.effect(() => async () => {
    lifetimeDisposed = true;
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
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
    for (const wait of [...activeRetryWaits]) wait.cancel();
    await Promise.allSettled([...activeRetryWaits].map((w) => w.done));
  });
}
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_INTERVAL_MAX_MS,
  DEFAULT_RETRY_INTERVAL_MIN_MS,
  FAILOVER_TRIGGER_CODES,
  WRAPPED,
  apply,
  isSubagent,
  name,
  resolveMaxRetries,
  resolveRetryDelayMs
};
//# sourceMappingURL=index.js.map