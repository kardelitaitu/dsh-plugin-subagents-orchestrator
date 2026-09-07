// src/config.ts
import fs from "fs";
import path from "path";
import os from "os";
import { load } from "js-yaml";
var DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".dsh", "settings.yaml");
var VALID_STRATEGIES = ["round-robin", "random", "weighted"];
var cachedConfig = null;
var cachedEndpoints = [];
var watcher = null;
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

// src/telemetry.ts
var statsByKey = /* @__PURE__ */ new Map();
function getEndpointStats() {
  return Array.from(statsByKey.values()).map((entry) => ({ ...entry }));
}

// src/diagnostics.ts
function deriveBreakerDiagnostics(status, now) {
  return {
    healthy: status.trippedUntil === null || now >= status.trippedUntil,
    trippedUntil: status.trippedUntil,
    consecutiveFailures: status.consecutiveFailures,
    lastFailureAt: status.lastFailureAt
  };
}
var EMPTY_STATS = {
  requests: 0,
  failures: 0,
  failovers: 0,
  cooldownHints: 0,
  latencySamples: 0,
  latencyTotalMs: 0,
  latencyMaxMs: 0,
  lastLatencyMs: null
};
function toEndpointDiagnostics(endpoint, inPool, statsByKey2, now) {
  const key = `${endpoint.provider}::${endpoint.model}`;
  const stats = statsByKey2.get(key) ?? { ...EMPTY_STATS };
  return {
    key,
    provider: endpoint.provider,
    model: endpoint.model,
    inPool,
    breaker: deriveBreakerDiagnostics(defaultCircuitBreaker.getStatus(endpoint), now),
    telemetry: {
      requests: stats.requests,
      failures: stats.failures,
      failovers: stats.failovers,
      cooldownHints: stats.cooldownHints,
      latencySamples: stats.latencySamples,
      latencyTotalMs: stats.latencyTotalMs,
      latencyMaxMs: stats.latencyMaxMs,
      lastLatencyMs: stats.lastLatencyMs
    }
  };
}
function getDiagnosticsSnapshot(now = Date.now()) {
  const config = getConfig();
  const effectivePool = getCachedEndpoints();
  const poolKeys = new Set(effectivePool.map((e) => `${e.provider}::${e.model}`));
  const statsByKey2 = new Map(getEndpointStats().map((s) => [s.key, s]));
  const configured = config?.endpoints ?? [];
  const endpoints = configured.map(
    (endpoint) => toEndpointDiagnostics(endpoint, poolKeys.has(`${endpoint.provider}::${endpoint.model}`), statsByKey2, now)
  );
  return {
    generatedAt: now,
    configPresent: config !== null,
    orchestration: {
      active: config !== null && config.enabled !== false,
      strategy: config?.strategy ?? "round-robin",
      failover: config?.failover === true,
      cooldownMs: config?.cooldownMs ?? 6e4,
      maxFailures: config?.maxFailures ?? 3,
      retryIntervalMinMs: config?.intervalMinMs ?? 3e3,
      retryIntervalMaxMs: config?.intervalMaxMs ?? 5e3
    },
    effectivePoolSize: effectivePool.length,
    endpoints
  };
}
function formatEndpointLine(endpoint) {
  const parts = [];
  parts.push(endpoint.inPool ? "pool" : "parked");
  parts.push(endpoint.breaker.healthy ? "healthy" : `tripped-until=${new Date(endpoint.breaker.trippedUntil ?? 0).toISOString()}`);
  if (endpoint.breaker.consecutiveFailures > 0) parts.push(`streak=${endpoint.breaker.consecutiveFailures}`);
  parts.push(`req=${endpoint.telemetry.requests} fail=${endpoint.telemetry.failures} failover=${endpoint.telemetry.failovers}`);
  if (endpoint.telemetry.latencySamples > 0) {
    const avg = Math.round(endpoint.telemetry.latencyTotalMs / endpoint.telemetry.latencySamples);
    parts.push(`fail-latency n=${endpoint.telemetry.latencySamples} avg=${avg}ms max=${endpoint.telemetry.latencyMaxMs}ms`);
  }
  return `- ${endpoint.key} [${parts.join(" ")}]`;
}
function formatDiagnostics(snapshot) {
  const lines = [];
  lines.push(`subagents-orchestrator diagnostics @ ${new Date(snapshot.generatedAt).toISOString()}`);
  const o = snapshot.orchestration;
  lines.push(
    `config: ${snapshot.configPresent ? "present" : "missing"} | active=${o.active} strategy=${o.strategy} failover=${o.failover} | cooldown=${o.cooldownMs}ms maxFailures=${o.maxFailures} pacing=${o.retryIntervalMinMs}-${o.retryIntervalMaxMs}ms`
  );
  lines.push(`effective pool: ${snapshot.effectivePoolSize} endpoint(s)`);
  for (const endpoint of snapshot.endpoints) {
    lines.push(formatEndpointLine(endpoint));
  }
  return lines.join("\n");
}
export {
  formatDiagnostics,
  getDiagnosticsSnapshot
};
//# sourceMappingURL=diagnostics.js.map