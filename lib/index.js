// src/config.ts
import fs from "fs";
import path from "path";
import os from "os";
import { load } from "js-yaml";

// src/health.ts
var DEFAULT_MAX_FAILURES = 3;
var DEFAULT_COOLDOWN_MS = 60 * 6e4;
var FLAP_TRIP_THRESHOLD = 3;
var FLAP_WINDOW_MS = 10 * 6e4;
var FLAP_COOLDOWN_MULTIPLIER = 3;
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
        lastFailureAt: null,
        trippedSince: null
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
      status.trippedSince = null;
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
      const tripStart = status.trippedSince ?? status.trippedUntil;
      const ceiling = tripStart + cooldown * 2;
      status.trippedUntil = Math.max(status.trippedUntil, Math.min(now + cooldown, ceiling));
      return true;
    }
    if (status.consecutiveFailures >= threshold) {
      const trips = (status.recentTrips ?? []).filter((t) => now - t < FLAP_WINDOW_MS);
      trips.push(now);
      status.recentTrips = trips;
      const multiplier = trips.length >= FLAP_TRIP_THRESHOLD ? FLAP_COOLDOWN_MULTIPLIER : 1;
      status.trippedUntil = now + cooldown * multiplier;
      status.trippedSince = now;
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
      status.trippedSince = null;
      status.recentTrips = [];
    }
  }
  /**
   * Account-level trip: when a provider hits an account-wide limit (QUOTA, 429,
   * INVALID_CREDENTIAL), trip all endpoints belonging to that provider simultaneously.
   *
   * @returns array of endpoints that were tripped.
   */
  recordAccountFailure(provider, allEndpoints, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now()) {
    const matching = allEndpoints.filter((e) => e.provider === provider);
    for (const ep of matching) {
      this.recordFailure(ep, 1, cooldownMs, now);
    }
    return matching;
  }
  /**
   * Manually reset an endpoint or an entire provider from quarantine.
   * Restores health immediately, clearing failure streaks and flapping records.
   */
  resetEndpoint(provider, model) {
    if (model) {
      this.recordSuccess({ provider, model });
    } else {
      const prefix = `${provider}::`;
      for (const [key, status] of this.healthMap.entries()) {
        if (key.startsWith(prefix)) {
          status.consecutiveFailures = 0;
          status.trippedUntil = null;
          status.trippedSince = null;
          status.recentTrips = [];
        }
      }
    }
  }
  /** Get a snapshot of all currently quarantined endpoint keys and their expiry timestamps. */
  getQuarantines(now = Date.now()) {
    const result = {};
    for (const [key, status] of this.healthMap.entries()) {
      if (status.trippedUntil !== null && now < status.trippedUntil) {
        result[key] = status.trippedUntil;
      }
    }
    return result;
  }
  /** Hydrate quarantines from persisted config (e.g. across process restarts). */
  applyQuarantines(quarantines, now = Date.now()) {
    if (!quarantines || typeof quarantines !== "object") return;
    for (const [key, status] of this.healthMap.entries()) {
      if (status.trippedUntil !== null && (!quarantines[key] || quarantines[key] <= now)) {
        status.trippedUntil = null;
        status.trippedSince = null;
        status.consecutiveFailures = 0;
      }
    }
    for (const [key, trippedUntil] of Object.entries(quarantines)) {
      if (typeof trippedUntil === "number" && trippedUntil > now) {
        let status = this.healthMap.get(key);
        if (!status) {
          status = {
            consecutiveFailures: DEFAULT_MAX_FAILURES,
            trippedUntil,
            lastFailureAt: now,
            trippedSince: now
          };
          this.healthMap.set(key, status);
        } else {
          status.trippedUntil = trippedUntil;
          status.consecutiveFailures = Math.max(status.consecutiveFailures, DEFAULT_MAX_FAILURES);
        }
      }
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
function computeHourlyAlignedCooldown(now = Date.now(), graceMs = 6e4, minMs = 5 * 6e4) {
  const hourMs = 60 * 6e4;
  const currentHourStart = Math.floor(now / hourMs) * hourMs;
  let target = currentHourStart + hourMs + graceMs;
  if (target - now < minMs) {
    target += hourMs;
  }
  return Math.max(minMs, target - now);
}
var defaultCircuitBreaker = new CircuitBreaker();

// src/config.ts
var DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".dsh", "settings.yaml");
var WATCH_DEBOUNCE_MS = 100;
var VALID_STRATEGIES = ["round-robin", "random", "weighted"];
var cachedConfig = null;
var cachedEndpoints = [];
var cachedMode = "pool";
var cachedFallbackChain = [];
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
function isUsableEndpoint(endpoint) {
  return Boolean(
    endpoint && typeof endpoint.provider === "string" && endpoint.provider.trim().length > 0 && typeof endpoint.model === "string" && endpoint.model.trim().length > 0
  );
}
function parseEndpoint(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = raw["provider"];
  if (typeof provider !== "string" || provider.trim().length === 0) return null;
  const model = raw["model"];
  if (typeof model !== "string" || model.trim().length === 0) return null;
  const endpoint = { provider, model };
  const reasoningEffort = raw["reasoningEffort"];
  if (typeof reasoningEffort === "string" && reasoningEffort.trim().length > 0) {
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
  const mode = section["mode"];
  if (mode === "pool" || mode === "fallback") {
    config.mode = mode;
  }
  if (Array.isArray(section["fallback"])) {
    const fallback = section["fallback"].map(parseEndpoint).filter((endpoint) => endpoint !== null);
    if (fallback.length > 0) config.fallback = fallback;
  }
  if (isFiniteNumber(section["cooldownMs"])) config.cooldownMs = section["cooldownMs"];
  if (isFiniteNumber(section["maxFailures"])) config.maxFailures = section["maxFailures"];
  if (isFiniteNumber(section["intervalMinMs"])) config.intervalMinMs = section["intervalMinMs"];
  if (isFiniteNumber(section["intervalMaxMs"])) config.intervalMaxMs = section["intervalMaxMs"];
  if (isFiniteNumber(section["maxRetries"])) config.maxRetries = section["maxRetries"];
  if (isFiniteNumber(section["totalSubagents"])) config.totalSubagents = section["totalSubagents"];
  if (typeof section["debug"] === "boolean") config.debug = section["debug"];
  if (typeof section["persistTelemetry"] === "boolean") config.persistTelemetry = section["persistTelemetry"];
  if (typeof section["alignHourly"] === "boolean") config.alignHourly = section["alignHourly"];
  if (isPlainObject(section["quarantines"])) {
    const q = {};
    for (const [k, v] of Object.entries(section["quarantines"])) {
      if (typeof v === "number" && Number.isFinite(v)) q[k] = v;
    }
    config.quarantines = q;
  }
  const ui = section["ui"];
  if (isPlainObject(ui)) {
    const uiConfig = {};
    if (typeof ui["toasts"] === "boolean") uiConfig.toasts = ui["toasts"];
    if (typeof ui["panel"] === "boolean") uiConfig.panel = ui["panel"];
    config.ui = uiConfig;
  }
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
    return config.endpoints.filter((e) => isUsableEndpoint(e) && e.enabled !== false);
  }
  return [];
}
function extractFallbackChain(config) {
  if (config && Array.isArray(config.fallback) && config.fallback.length > 0) {
    return config.fallback.filter((e) => isUsableEndpoint(e) && e.enabled !== false);
  }
  return [];
}
function resolveMode(config, fallbackChain) {
  if (config?.mode === "fallback" && fallbackChain.length > 0) return "fallback";
  return "pool";
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
  cachedFallbackChain = extractFallbackChain(cachedConfig);
  cachedMode = resolveMode(cachedConfig, cachedFallbackChain);
  hasLoadedFromDisk = true;
}
function ensureLoaded() {
  if (!hasLoadedFromDisk && !watcher) reloadConfig();
}
function hydrateQuarantinesFromConfig() {
  const config = getConfig();
  if (config?.quarantines) {
    defaultCircuitBreaker.applyQuarantines(config.quarantines);
  }
}
function getConfig() {
  ensureLoaded();
  return cachedConfig;
}
function getCachedEndpoints() {
  ensureLoaded();
  return cachedEndpoints;
}
function getCachedFallbackChain() {
  ensureLoaded();
  return cachedFallbackChain;
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

// src/settings.ts
import z from "@deepseek-ai/schemastery";
var ORCHESTRATOR_SETTINGS_NAMESPACE = "subagents-orchestrator";
var endpointSettingsSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  weight: z.number(),
  enabled: z.boolean()
});
var orchestratorSettingsSchema = z.object({
  enabled: z.boolean(),
  strategy: z.string(),
  failover: z.boolean(),
  cooldownMs: z.number(),
  maxFailures: z.number(),
  maxRetries: z.number(),
  intervalMinMs: z.number(),
  intervalMaxMs: z.number(),
  debug: z.boolean(),
  persistTelemetry: z.boolean(),
  ui: z.object({
    toasts: z.boolean(),
    panel: z.boolean()
  }),
  endpoints: z.array(endpointSettingsSchema),
  fallback: z.array(endpointSettingsSchema),
  alignHourly: z.boolean(),
  quarantines: z.dict(z.number())
});
var activeSettingsService = null;
var activeRegistrationScope = null;
var activeWatchDispose = null;
function releaseActiveWatch() {
  const stop = activeWatchDispose;
  activeWatchDispose = null;
  if (stop) {
    try {
      stop();
    } catch {
    }
  }
}
function disposeSettings() {
  releaseActiveWatch();
  activeSettingsService = null;
  activeRegistrationScope = null;
}
function isQuarantineMap(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function armSettingsPanel(ctx) {
  const config = getConfig();
  if (config?.ui?.panel !== true) return false;
  try {
    ctx.inject(["settings"], (sctx) => {
      const settings = sctx?.settings;
      if (!settings) return;
      activeSettingsService = settings;
      try {
        const scope = settings.register(ORCHESTRATOR_SETTINGS_NAMESPACE, orchestratorSettingsSchema, { base: {} });
        activeRegistrationScope = scope;
        try {
          const snap = scope?.get?.();
          if (isQuarantineMap(snap?.quarantines)) {
            defaultCircuitBreaker.applyQuarantines(snap.quarantines);
          }
        } catch {
        }
        try {
          releaseActiveWatch();
          const stopWatch = scope?.watch?.((next) => {
            try {
              if (next && typeof next === "object" && !Array.isArray(next) && "quarantines" in next) {
                const incoming = next.quarantines;
                if (isQuarantineMap(incoming)) {
                  defaultCircuitBreaker.applyQuarantines(incoming);
                } else if (incoming === null || incoming === void 0) {
                  defaultCircuitBreaker.applyQuarantines({});
                }
              }
            } catch {
            }
          });
          activeWatchDispose = typeof stopWatch === "function" ? stopWatch : null;
        } catch {
        }
      } catch {
        activeRegistrationScope = null;
        releaseActiveWatch();
      }
    });
  } catch {
  }
  return true;
}
async function persistQuarantines(quarantines) {
  try {
    if (activeSettingsService?.mutate) {
      await activeSettingsService.mutate(ORCHESTRATOR_SETTINGS_NAMESPACE, [
        { op: "set", path: ["quarantines"], value: quarantines }
      ]);
    } else if (activeRegistrationScope?.update) {
      await activeRegistrationScope.update({ quarantines });
    } else if (activeSettingsService?.update) {
      await activeSettingsService.update(ORCHESTRATOR_SETTINGS_NAMESPACE, { quarantines });
    }
  } catch {
  }
}

// src/balancer.ts
function pickWeighted(endpoints) {
  if (!endpoints || endpoints.length === 0) return null;
  const weights = endpoints.map((e) => {
    const w = e.weight;
    return typeof w === "number" && Number.isFinite(w) ? Math.max(1, w) : 1;
  });
  const scale = weights.reduce((max, w) => w > max ? w : max, 0);
  const scaled = weights.map((w) => w / scale);
  const totalWeight = scaled.reduce((sum, w) => sum + w, 0);
  let randomVal = Math.random() * totalWeight;
  for (let i = 0; i < endpoints.length; i++) {
    randomVal -= scaled[i];
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
var MAX_HINT_COOLDOWN_MS = 24 * 60 * 60 * 1e3;
var RETRY_AFTER_HEADERS = ["retry-after"];
var RATE_LIMIT_RESET_HEADERS = ["x-ratelimit-reset", "ratelimit-reset"];
function parseResetTimestampMs(text, now = Date.now()) {
  if (!text || typeof text !== "string") return null;
  const atMatch = text.match(/resets?\s+at\s+(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s*(?:(?:[([\[])?(UTC[+-]\d{1,2}:?\d{0,2}|GMT[+-]\d{1,2}:?\d{0,2}|[+-]\d{1,2}:?\d{0,2}|Z)(?:[)\]])?)?/i);
  if (atMatch) {
    const datePart = atMatch[1];
    const timePart = atMatch[2].length === 5 ? `${atMatch[2]}:00` : atMatch[2];
    const fracPart = atMatch[3] || "";
    const tzPart = atMatch[4];
    let iso = `${datePart}T${timePart}${fracPart}`;
    if (tzPart) {
      const tzMatch = tzPart.match(/^(?:UTC|GMT)?([+-])(\d{1,2}):?(\d{2})?$/i);
      if (tzMatch) {
        const sign = tzMatch[1];
        const hours = tzMatch[2].padStart(2, "0");
        const mins = (tzMatch[3] || "00").padStart(2, "0");
        iso += `${sign}${hours}:${mins}`;
      } else if (tzPart.toUpperCase() === "Z") {
        iso += "Z";
      }
    }
    const when = Date.parse(iso);
    if (!Number.isNaN(when) && when > now) {
      return when - now;
    }
  }
  const inMatch = text.match(/resets?\s+in\s+(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i);
  if (inMatch) {
    const amount = parseFloat(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    let mult = 1e3;
    if (unit.startsWith("m")) mult = 60 * 1e3;
    else if (unit.startsWith("h")) mult = 3600 * 1e3;
    return Math.round(amount * mult);
  }
  return null;
}
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
function asLower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}
function asUpper(value) {
  return typeof value === "string" ? value.toUpperCase() : "";
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
  if (hintMs === null) {
    const rawMsg = failure.message || failure.error?.message || (typeof response?.data === "string" ? response.data : response?.data?.msg || response?.data?.message);
    if (typeof rawMsg === "string") {
      hintMs = parseResetTimestampMs(rawMsg, now);
    }
  }
  if (hintMs === null) return null;
  return Math.min(Math.max(0, hintMs), MAX_HINT_COOLDOWN_MS);
}
function isHardRateLimitError(failure) {
  if (!failure) return false;
  const msg = asLower(failure.message);
  const code = asUpper(failure.code);
  const status = failure.status ?? failure.response?.status;
  if (code === "QUOTA" || code === "RATE_LIMIT" || code === "INSUFFICIENT_QUOTA" || status === 429) {
    if (msg.includes("frequency limit") || msg.includes("6004") || msg.includes("rate limit exceeded") || msg.includes("exceeds frequency") || msg.includes("insufficient_quota") || msg.includes("insufficient quota") || msg.includes("daily request limit") || msg.includes("out of credits") || msg.includes("reset at") || msg.includes("resets at")) {
      return true;
    }
  }
  return false;
}
function isAccountLevelRateLimit(failure) {
  if (!failure) return false;
  const msg = asLower(failure.message);
  if (msg.includes("switch to the other models") || msg.includes("switch to other models") || msg.includes("6004")) {
    return false;
  }
  if (msg.includes("codebuddy api rate limit exceeded") || msg.includes("account rate limit") || msg.includes("daily request limit")) {
    return true;
  }
  return false;
}
function isClientSideError(failure) {
  if (!failure) return false;
  const status = failure.status ?? failure.response?.status;
  if (status === 400 || status === 422) return true;
  const code = asUpper(failure.code);
  if (code === "BAD_REQUEST" || code === "INVALID_REQUEST" || code === "CONTEXT_LENGTH") return true;
  const msg = asLower(failure.message);
  if (msg.includes("context_length_exceeded") || msg.includes("maximum context length") || msg.includes("prompt is too long") || msg.includes("token count exceeds") || msg.includes("invalid parameter") || msg.includes("unsupported parameter")) {
    return true;
  }
  return false;
}

// src/telemetry.ts
var MAX_EVENT_BUFFER = 100;
var statsByKey = /* @__PURE__ */ new Map();
var eventBuffer = [];
var successSpans = /* @__PURE__ */ new Map();
var tokenMarks = /* @__PURE__ */ new Map();
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
function cloneEvent(event) {
  return {
    ...event,
    ...event.from ? { from: { ...event.from } } : {},
    ...event.to ? { to: { ...event.to } } : {}
  };
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
      lastLatencyMs: null,
      successes: 0,
      successLatencySamples: 0,
      successLatencyTotalMs: 0,
      successLatencyMaxMs: 0,
      lastSuccessLatencyMs: null,
      tokensTotal: 0
    };
    statsByKey.set(key, entry);
  }
  return entry;
}
function recordRequest(agentId, endpoint, now = Date.now(), meta) {
  ensureStats(endpoint).requests += 1;
  requestStarts.set(agentId, { endpoint: { ...endpoint }, at: now });
  emit({ at: now, type: "request", agentId, to: { ...endpoint } });
  openSuccessSpan(agentId, endpoint, now, meta);
}
function isStepNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function openSuccessSpan(agentId, endpoint, now, meta) {
  const previous = successSpans.get(agentId);
  if (previous) {
    const advanced = isStepNumber(meta?.turn) && isStepNumber(previous.turn) && meta.turn > previous.turn ? true : isStepNumber(meta?.turn) && isStepNumber(previous.turn) && isStepNumber(meta?.step) && isStepNumber(previous.step) && meta.turn === previous.turn && meta.step > previous.step;
    if (advanced) {
      successSpans.delete(agentId);
      if (!previous.failed) {
        sampleSuccess(agentId, previous.endpoint, previous, now, previous.pendingTokens);
      }
    }
  }
  successSpans.set(agentId, {
    endpoint: { ...endpoint },
    at: now,
    turn: meta?.turn,
    step: meta?.step
    // The cumulative token mark is agent-scoped (see tokenMarks), so it
    // survives this replacement and every later turn boundary; the pending
    // delta does NOT carry — a replaced span's tokens were its own attempt's.
  });
}
function recordTokenSample(agentId, cumulativeTokens, now = Date.now()) {
  const span = successSpans.get(agentId);
  if (!span || !Number.isFinite(cumulativeTokens)) return null;
  const current = Math.max(0, cumulativeTokens);
  const mark = tokenMarks.get(agentId);
  const delta = mark === void 0 ? current : Math.max(0, current - mark);
  tokenMarks.set(agentId, current);
  span.pendingTokens = (span.pendingTokens ?? 0) + delta;
  return delta;
}
function recordTurnSuccess(agentId, tokens, now = Date.now()) {
  const span = successSpans.get(agentId);
  if (!span) return false;
  successSpans.delete(agentId);
  if (!span.failed) {
    const effective = tokens !== void 0 && Number.isFinite(tokens) ? tokens : span.pendingTokens;
    sampleSuccess(agentId, span.endpoint, span, now, effective);
  }
  return true;
}
function poisonSuccessSpan(agentId, turn, step) {
  const span = successSpans.get(agentId);
  if (!span) return;
  if (turn === void 0 && step === void 0) {
    span.failed = true;
    return;
  }
  if (span.turn === turn && span.step === step) span.failed = true;
}
function sampleSuccess(agentId, endpoint, span, now, tokens) {
  const entry = ensureStats(endpoint);
  const rawLatency = now - span.at;
  const latencyMs = Number.isFinite(rawLatency) ? Math.max(0, rawLatency) : void 0;
  entry.successes += 1;
  if (latencyMs !== void 0) {
    entry.successLatencySamples += 1;
    entry.successLatencyTotalMs += latencyMs;
    entry.successLatencyMaxMs = Math.max(entry.successLatencyMaxMs, latencyMs);
    entry.lastSuccessLatencyMs = latencyMs;
  }
  const attributed = tokens === void 0 || !Number.isFinite(tokens) ? void 0 : Math.max(0, tokens);
  if (attributed !== void 0) entry.tokensTotal += attributed;
  emit({
    at: now,
    type: "success",
    agentId,
    to: { ...endpoint },
    ...latencyMs !== void 0 ? { successLatencyMs: latencyMs } : {},
    ...attributed !== void 0 ? { tokens: attributed } : {}
  });
}
function forgetAgent(agentId) {
  requestStarts.delete(agentId);
  successSpans.delete(agentId);
  tokenMarks.delete(agentId);
}
function recordFailure(agentId, endpoint, code, hintMs, now = Date.now(), meta) {
  const entry = ensureStats(endpoint);
  entry.failures += 1;
  if (hintMs !== void 0) entry.cooldownHints += 1;
  if (Number.isFinite(now)) entry.lastFailureAt = now;
  entry.lastFailureCode = code;
  poisonSuccessSpan(agentId, meta?.turn, meta?.step);
  const start = requestStarts.get(agentId);
  let latencyMs;
  if (start) {
    requestStarts.delete(agentId);
    const rawLatency = now - start.at;
    if (Number.isFinite(rawLatency)) {
      latencyMs = Math.max(0, rawLatency);
      entry.latencySamples += 1;
      entry.latencyTotalMs += latencyMs;
      entry.latencyMaxMs = Math.max(entry.latencyMaxMs, latencyMs);
      entry.lastLatencyMs = latencyMs;
    }
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
  return eventBuffer.slice(-limit).map(cloneEvent);
}
function resetTelemetry() {
  statsByKey.clear();
  eventBuffer.length = 0;
  requestStarts.clear();
  successSpans.clear();
  tokenMarks.clear();
  debugMode = "auto";
}
function drainRecentEvents() {
  return eventBuffer.splice(0, eventBuffer.length).map(cloneEvent);
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
    const prefix = endsWithNewline(file) ? "" : "\n";
    fs2.appendFileSync(file, prefix + payload, "utf8");
    return events.length;
  } catch {
    return 0;
  }
}
function endsWithNewline(file) {
  try {
    const size = fs2.statSync(file).size;
    if (size === 0) return true;
    const fd = fs2.openSync(file, "r");
    try {
      const last = Buffer.alloc(1);
      fs2.readSync(fd, last, 0, 1, size - 1);
      return last[0] === 10;
    } finally {
      fs2.closeSync(fd);
    }
  } catch {
    return true;
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
    const keep = new Set(files.slice(0, MAX_PERSIST_DAYS));
    keep.add(eventFileName(now));
    const removed = [];
    for (const file of files) {
      if (keep.has(file)) continue;
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
  const stats = getEndpointStats();
  let eventsWritten = 0;
  let snapshotWritten = false;
  if (pending.length > 0 || stats.length > 0) {
    eventsWritten = pending.length > 0 ? appendEvents(pending, now) : 0;
    if (pending.length > 0 && eventsWritten === pending.length) {
      drainRecentEvents();
    }
    snapshotWritten = writeEndpointStatsSnapshot(stats, now);
  }
  const bucketsPruned = pruneOldBuckets(now);
  return { eventsWritten, snapshotWritten, bucketsPruned };
}

// src/notices.ts
var NOTICE_SUMMARY_MAX_CHARS = 120;
var NOTICE_PLUGIN_ID = "dsh-plugin-subagents-orchestrator";
var cachedModule;
var overrideModule;
async function getNoticeModule() {
  if (overrideModule !== void 0) return overrideModule;
  if (cachedModule === void 0) {
    try {
      const specifier = "@deepseek-ai/dsh-llm";
      cachedModule = await import(
        /* @vite-ignore */
        specifier
      );
      if (typeof cachedModule?.createUserMessage !== "function") cachedModule = null;
    } catch {
      cachedModule = null;
    }
  }
  return cachedModule;
}
function boundSummary(summary) {
  if (summary.length <= NOTICE_SUMMARY_MAX_CHARS) return summary;
  let cut = Math.max(0, NOTICE_SUMMARY_MAX_CHARS - 1);
  const lastIncluded = summary.charCodeAt(cut - 1);
  if (lastIncluded >= 55296 && lastIncluded <= 56319) cut -= 1;
  return summary.slice(0, cut) + "\u2026";
}
function endpointLabel(ref) {
  const provider = ref?.provider;
  const model = ref?.model;
  if (typeof provider !== "string" || provider.trim().length === 0 || typeof model !== "string" || model.trim().length === 0) {
    throw new TypeError("failover notice requires a provider and model on both endpoints");
  }
  return `${provider}/${model}`;
}
function formatHint(hintMs) {
  return typeof hintMs === "number" && Number.isFinite(hintMs) ? `cooldown hint ${hintMs}ms` : null;
}
function buildFailoverNotice(info) {
  const from = endpointLabel(info.from);
  const to = endpointLabel(info.to);
  const hint = formatHint(info.hintMs);
  const code = typeof info.code === "string" ? info.code : void 0;
  const reason = code !== void 0 && hint !== null ? `${code}, ${hint}` : code ?? hint ?? "connection failure";
  const summary = boundSummary(`Failover: ${from} -> ${to} (${reason})`);
  const text = `[subagents-orchestrator] The endpoint ${from} failed with ${reason}; your requests are now routed to ${to}. No user action is needed \u2014 continue the task; this note is only routing context.`;
  return { summary, text };
}
async function deliverFailoverNotice(agent, info, getModule = getNoticeModule) {
  try {
    const injectable = agent;
    if (!injectable || typeof injectable.inject !== "function") return "no-agent-inject";
    const mod = await getModule();
    if (!mod) return "module-unavailable";
    const { summary, text } = buildFailoverNotice(info);
    const message = mod.createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: NOTICE_PLUGIN_ID,
        form: "notice",
        summary: typeof mod.boundContextSummary === "function" ? mod.boundContextSummary(summary) : summary
      }
    });
    injectable.inject(message);
    return "delivered";
  } catch {
    return "failed";
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
  const activeSubagents = /* @__PURE__ */ new Set();
  const activeRetryWaits = /* @__PURE__ */ new Set();
  let lifetimeDisposed = false;
  const retryIncidents = /* @__PURE__ */ new Map();
  const exhaustedAgents = /* @__PURE__ */ new Map();
  function sameIncidentMarker(a, b) {
    if (a === b) return true;
    if (a === null || a === void 0 || b === null || b === void 0) return false;
    const prim = (v) => {
      const t = typeof v;
      if (t === "number" || t === "string" || t === "boolean") return v;
      try {
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
      } catch {
      }
      try {
        return String(v);
      } catch {
        return "__unprojectable__";
      }
    };
    const pa = prim(a);
    const pb = prim(b);
    if (typeof pa === "number" && typeof pb === "number") return pa === pb;
    return String(pa) === String(pb);
  }
  initWatcher();
  hydrateQuarantinesFromConfig();
  armSettingsPanel(ctx);
  function syncQuarantines() {
    const q = defaultCircuitBreaker.getQuarantines();
    persistQuarantines(q).catch(() => {
    });
  }
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
    const fallbackChain = getCachedFallbackChain();
    if (endpoints.length === 0 && fallbackChain.length === 0) return request;
    if (request && request.agentOptions !== void 0) return request;
    const cap = config.totalSubagents;
    if (typeof cap === "number" && cap >= 0 && activeSubagents.size >= cap) {
      if (config.debug) {
        console.debug(`subagents-orchestrator: start over cap (${activeSubagents.size}/${cap}) passes through unrouted`);
      }
      return request;
    }
    const anyPrimaryHealthy = endpoints.some(
      (e) => defaultCircuitBreaker.getStatus(e).trippedUntil === null || Date.now() >= defaultCircuitBreaker.getStatus(e).trippedUntil
    );
    const chain = anyPrimaryHealthy ? [] : fallbackChain;
    const candidates = chain.length > 0 ? [...endpoints, ...chain] : endpoints;
    const picked = pickNextEndpoint(
      candidates,
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
      if (!config || config.enabled === false) return next();
      refreshTelemetryDebug();
      if (payload.agent?.id) poisonSuccessSpan(payload.agent.id, payload.turn, payload.step);
      if (config.failover === false) return next();
      const primaryEndpoints = getCachedEndpoints();
      const fallbackChain = getCachedFallbackChain();
      const endpoints = fallbackChain.length > 0 ? [...primaryEndpoints, ...fallbackChain] : primaryEndpoints;
      if (endpoints.length < 2) return next();
      const { agent, failure, signal } = payload;
      if (signal?.aborted) return next();
      if (!failure || !FAILOVER_TRIGGER_CODES.includes(failure.code)) return next();
      if (isClientSideError(failure)) return next();
      let currentEndpoint = agent?.id ? activeEndpoints.get(agent.id) : void 0;
      const failedProvider = currentEndpoint?.provider || (typeof payload.provider === "string" ? payload.provider : void 0);
      const failedModel = currentEndpoint?.model || (typeof payload.model === "string" ? payload.model : void 0);
      if (!currentEndpoint && failedProvider && failedModel) {
        currentEndpoint = { provider: failedProvider, model: failedModel };
      }
      const inPool = endpoints.some((e) => e.provider === failedProvider);
      if (!inPool && !currentEndpoint) return next();
      const hintMs = extractCooldownHintMs(failure);
      if (hintMs !== null && agent?.id) {
        const marker = exhaustedAgents.get(agent.id);
        if (marker && sameIncidentMarker(marker.turn, payload.turn) && sameIncidentMarker(marker.step, payload.step)) {
          exhaustedAgents.delete(agent.id);
        }
      }
      let effectiveCooldown = hintMs ?? config.cooldownMs ?? 36e5;
      if (hintMs === null && config.alignHourly !== false) {
        effectiveCooldown = computeHourlyAlignedCooldown(Date.now());
      }
      const isAccountLevelError = failure.code === "QUOTA" || failure.code === "INVALID_CREDENTIAL" || failure.code === "MISSING_CREDENTIAL" || isAccountLevelRateLimit(failure);
      if (isAccountLevelError && failedProvider) {
        defaultCircuitBreaker.recordAccountFailure(
          failedProvider,
          endpoints,
          effectiveCooldown
        );
      } else if (currentEndpoint) {
        const threshold = hintMs !== null || isHardRateLimitError(failure) ? 1 : config.maxFailures || 3;
        defaultCircuitBreaker.recordFailure(
          currentEndpoint,
          threshold,
          effectiveCooldown
        );
      }
      syncQuarantines();
      if (agent?.id && currentEndpoint) {
        recordFailure(agent.id, currentEndpoint, failure.code, hintMs !== null ? hintMs : void 0, Date.now(), { turn: payload.turn, step: payload.step });
      }
      if (!isSubagent(agent)) {
        return next();
      }
      if (!currentEndpoint) return next();
      const endpointKey = defaultCircuitBreaker.getEndpointKey(currentEndpoint);
      const exhaustedMarker = exhaustedAgents.get(agent.id);
      if (exhaustedMarker && sameIncidentMarker(exhaustedMarker.turn, payload.turn) && sameIncidentMarker(exhaustedMarker.step, payload.step)) {
        pendingFailovers.delete(agent.id);
        return next();
      }
      const isTerminalFailure = failure.code === "INVALID_CREDENTIAL" || failure.code === "MISSING_CREDENTIAL" || failure.code === "QUOTA" || isAccountLevelError || isHardRateLimitError(failure);
      if (hintMs === null && !isTerminalFailure) {
        const incident = retryIncidents.get(agent.id);
        const sameIncident = incident !== void 0 && incident.endpointKey === endpointKey && sameIncidentMarker(incident.turn, payload.turn) && sameIncidentMarker(incident.step, payload.step);
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
      const primaryCount = endpoints.length - fallbackChain.length;
      const currentIndex = endpoints.findIndex((e) => defaultCircuitBreaker.getEndpointKey(e) === endpointKey);
      const storedPlan = pendingFailovers.get(agent.id);
      const planIsThisIncident = storedPlan !== void 0 && sameIncidentMarker(storedPlan.turn, payload.turn) && sameIncidentMarker(storedPlan.step, payload.step);
      const current = planIsThisIncident ? storedPlan : { count: 0, index: currentIndex >= 0 ? currentIndex : 0 };
      if (planIsThisIncident && current.count >= endpoints.length - 1) {
        pendingFailovers.delete(agent.id);
        retryIncidents.delete(agent.id);
        exhaustedAgents.set(agent.id, { turn: payload.turn, step: payload.step });
        return next();
      }
      let nextIndex = -1;
      let nextTier = "primary";
      let degradedIndex = -1;
      let degradedTier = "primary";
      const isCurrentKey = (candidate) => defaultCircuitBreaker.getEndpointKey(candidate) === endpointKey;
      const noteDegraded = (index, tier) => {
        if (degradedIndex === -1) {
          degradedIndex = index;
          degradedTier = tier;
        }
      };
      const currentChainIndex = fallbackChain.findIndex(isCurrentKey);
      const currentIsRescuer = currentChainIndex >= 0;
      const primaryStart = currentIsRescuer ? 0 : (currentIndex % primaryCount + primaryCount) % primaryCount;
      for (let step = 1; step <= primaryCount; step++) {
        const candidateIndex = (primaryStart + step) % primaryCount;
        const candidate = endpoints[candidateIndex];
        if (isCurrentKey(candidate)) continue;
        if (defaultCircuitBreaker.isHealthy(candidate)) {
          nextIndex = candidateIndex;
          nextTier = "primary";
          break;
        }
        noteDegraded(candidateIndex, "primary");
      }
      if (nextIndex === -1 && fallbackChain.length > 0) {
        const chainStart = currentIsRescuer ? currentChainIndex : -1;
        for (let fi = 0; fi < fallbackChain.length; fi++) {
          const idx = (chainStart + 1 + fi) % fallbackChain.length;
          const candidate = fallbackChain[idx];
          if (isCurrentKey(candidate)) continue;
          if (defaultCircuitBreaker.isHealthy(candidate)) {
            nextIndex = idx;
            nextTier = "fallback";
            break;
          }
          noteDegraded(idx, "fallback");
        }
      }
      if (nextIndex === -1 && degradedIndex !== -1) {
        nextIndex = degradedIndex;
        nextTier = degradedTier;
      }
      if (nextIndex === -1) return next();
      const target = nextTier === "fallback" ? fallbackChain[nextIndex] : endpoints[nextIndex];
      pendingFailovers.set(agent.id, {
        count: current.count + 1,
        index: nextIndex,
        tier: nextTier,
        // Identity travels with the commit so a list edit cannot relocate it.
        targetKey: defaultCircuitBreaker.getEndpointKey(target),
        // The incident this walk belongs to, so the next turn starts fresh.
        turn: payload.turn,
        step: payload.step
      });
      await delayRetryWait(signal, resolveRetryDelayMs(config));
      if (lifetimeDisposed || signal?.aborted || !pendingFailovers.has(agent.id)) {
        pendingFailovers.delete(agent.id);
        return { kind: "retry" };
      }
      recordFailover(agent.id, currentEndpoint, target);
      if (config.ui?.toasts === true) {
        const delivery = await deliverFailoverNotice(agent, {
          from: currentEndpoint,
          to: target,
          ...failure.code ? { code: failure.code } : {},
          ...hintMs !== null ? { hintMs } : {}
        });
        if (config.debug && delivery !== "delivered") {
          console.debug(`subagents-orchestrator: failover notice skipped (${delivery})`);
        }
      }
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
    if (!isSubagent(agent)) {
      const seed2 = await next();
      if (agent?.id && seed2 && typeof seed2.provider === "string" && typeof seed2.model === "string") {
        const assigned = {
          provider: seed2.provider,
          model: seed2.model,
          ...typeof seed2.reasoningEffort === "string" ? { reasoningEffort: seed2.reasoningEffort } : {}
        };
        activeEndpoints.set(agent.id, assigned);
      }
      return seed2;
    }
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
        activeSubagents.add(agent.id);
        recordRequest(agent.id, assigned, Date.now(), { turn: payload.turn, step: payload.step });
      }
      return seed2;
    }
    const liveConfig = getConfig();
    if (!liveConfig || liveConfig.enabled === false || liveConfig.failover === false) {
      pendingFailovers.delete(agent.id);
      return next();
    }
    const endpoints = getCachedEndpoints();
    const chain = current.tier === "fallback" ? getCachedFallbackChain() : [];
    const tierList = current.tier === "fallback" ? chain : endpoints;
    const target = current.targetKey ? [...endpoints, ...getCachedFallbackChain()].find(
      (e) => defaultCircuitBreaker.getEndpointKey(e) === current.targetKey
    ) : tierList[current.index];
    if (!target) return next();
    const seed = await next();
    if (!seed) return seed;
    activeEndpoints.set(agent.id, target);
    activeSubagents.add(agent.id);
    recordRequest(agent.id, target, Date.now(), { turn: payload.turn, step: payload.step });
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
      activeSubagents.delete(agent.id);
      retryIncidents.delete(agent.id);
      exhaustedAgents.delete(agent.id);
      forgetAgent(agent.id);
    }
  });
  const disposeTurnStopping = ctx.on(
    "agent/turn-stopping",
    async (payload) => {
      const agent = payload?.agent;
      if (!agent?.id) return;
      const config = getConfig();
      if (!config || config.enabled === false) return;
      refreshTelemetryDebug();
      let tokens;
      try {
        const meter = ctx.tokenMeter;
        if (meter && typeof meter.measure === "function" && agent.session) {
          const snapshot = await meter.measure(agent.session);
          const total = snapshot?.totalTokens;
          if (typeof total === "number" && Number.isFinite(total)) {
            tokens = recordTokenSample(agent.id, total) ?? void 0;
          }
        }
      } catch {
        tokens = void 0;
      }
      recordTurnSuccess(agent.id, tokens);
      const activeEp = activeEndpoints.get(agent.id);
      if (activeEp) {
        defaultCircuitBreaker.recordSuccess(activeEp);
        syncQuarantines();
      }
    }
  );
  const disposeError = ctx.on("agent/error", (payload) => {
    const agent = payload?.agent;
    if (agent?.id) poisonSuccessSpan(agent.id, payload?.turn, payload?.step);
  });
  ctx.effect(() => async () => {
    lifetimeDisposed = true;
    disposeRequestError();
    disposeRequest();
    disposeDisposed();
    disposeTurnStopping();
    disposeError();
    if (getConfig()?.persistTelemetry === true) {
      flushTelemetryToDisk();
    }
    pendingFailovers.clear();
    activeEndpoints.clear();
    activeSubagents.clear();
    retryIncidents.clear();
    exhaustedAgents.clear();
    defaultCircuitBreaker.clear();
    resetTelemetry();
    disposeWatcher();
    disposeSettings();
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