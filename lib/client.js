window.__ModuleLoader__.load({id: "dsh-plugin-subagents-orchestrator",factory: (require) => {var module = { exports: {} };var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var client_exports = {};
__export(client_exports, {
  CSS_TAG: () => CSS_TAG,
  NS: () => NS,
  PLUGIN_ID: () => PLUGIN_ID,
  SubagentsOrchestratorSection: () => SubagentsOrchestratorSection,
  activeClearedQuarantineKeys: () => activeClearedQuarantineKeys,
  apply: () => apply,
  bindSnapshotSelector: () => bindSnapshotSelector,
  buildEndpointRow: () => buildEndpointRow,
  endpointQuarantineUntil: () => endpointQuarantineUntil,
  formatTrippingDuration: () => formatTrippingDuration,
  inject: () => inject,
  isConfigDirty: () => isConfigDirty,
  isEndpointTripped: () => isEndpointTripped,
  mergeSnapshotIntoDraft: () => mergeSnapshotIntoDraft,
  normalizeWeight: () => normalizeWeight,
  planConfigWrites: () => planConfigWrites,
  projectConfig: () => projectConfig,
  pruneClearedQuarantineKeys: () => pruneClearedQuarantineKeys,
  quarantinesAfterReset: () => quarantinesAfterReset,
  reconcileDraftQuarantines: () => reconcileDraftQuarantines,
  removeEndpointAt: () => removeEndpointAt,
  resolveSettingsScope: () => resolveSettingsScope,
  toggleEndpointAt: () => toggleEndpointAt,
  updateEndpointWeightAt: () => updateEndpointWeightAt
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/client/testConnection.ts
var DISCOVERY_SETTINGS_NS = "llm-pi-ai";
var TEST_TIMEOUT_MS = 15e3;
async function storedBaseURL(settings, provider) {
  if (!settings) return void 0;
  let described;
  try {
    described = await settings.describe();
  } catch {
    return void 0;
  }
  if (!described.ok) return void 0;
  const describedValue = described.value;
  if (!describedValue || typeof describedValue !== "object") return void 0;
  const namespaces = describedValue.namespaces;
  if (!Array.isArray(namespaces)) return void 0;
  const namespace = namespaces.find((ns) => ns?.ns === DISCOVERY_SETTINGS_NS);
  const value = namespace?.value;
  const providers = value?.providers;
  if (!providers || typeof providers !== "object") return void 0;
  const record = providers[provider];
  if (!record || typeof record !== "object") return void 0;
  const baseURL = record.baseURL;
  return typeof baseURL === "string" && baseURL.trim().length > 0 ? baseURL.trim() : void 0;
}
function remoteFace(ctx, name) {
  try {
    return ctx?.remote?.[name] ?? null;
  } catch {
    return null;
  }
}
function bindEndpointTest(ctx) {
  return {
    run: (input, signal) => runEndpointTest(
      { llm: remoteFace(ctx, "llm"), settings: remoteFace(ctx, "settings") },
      input,
      signal
    ),
    storedBaseURL: (provider) => storedBaseURL(remoteFace(ctx, "settings"), provider)
  };
}
function composeTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("test connection timed out")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  };
}
async function runEndpointTest(faces, input, signal) {
  const llm = faces?.llm;
  if (!llm || typeof llm.discoverModels !== "function") {
    return { status: "unavailable", message: "This DSH build does not expose the remote.llm probe channel to plugin panels." };
  }
  const request = input ?? {};
  let baseURL = typeof request.baseURL === "string" ? request.baseURL.trim() : void 0;
  if (!baseURL) baseURL = await storedBaseURL(faces?.settings, request.provider);
  if (!baseURL) {
    return { status: "fail", message: "No baseURL to probe: enter one, or add this provider to the Models settings first." };
  }
  const composed = composeTimeout(signal, TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await llm.discoverModels(
      DISCOVERY_SETTINGS_NS,
      {
        provider: request.provider,
        baseURL,
        ...request.apiKey ? { apiKey: request.apiKey } : {}
      },
      composed.signal
    );
    const latencyMs = Date.now() - startedAt;
    if (!response || typeof response !== "object") {
      return { status: "fail", message: "The probe channel returned no result. Try again, or check that the remote.llm channel is available.", latencyMs };
    }
    if (!response.ok) {
      return { status: "fail", message: response.error?.message || "The probe was refused without a message.", latencyMs };
    }
    const models = Array.isArray(response.value) ? response.value : [];
    if (!request.model) {
      return { status: "ok", models, modelFound: null, latencyMs };
    }
    const configured = models.find((model) => model?.id === request.model);
    return {
      status: "ok",
      models,
      modelFound: Boolean(configured),
      ...typeof configured?.contextWindow === "number" ? { modelContextWindow: configured.contextWindow } : {},
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      latencyMs
    };
  } finally {
    composed.dispose();
  }
}

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "subagents-orchestrator";
var PLUGIN_ID = "dsh-plugin-subagents-orchestrator";
var CSS_TAG = PLUGIN_ID + "/client.css";
var STRATEGIES = ["round-robin", "random", "weighted"];
var MODES = ["pool", "fallback"];
var DEFAULTS = {
  enabled: true,
  strategy: "round-robin",
  failover: true,
  mode: "pool",
  endpoints: [],
  fallback: [],
  cooldownMs: 36e5,
  maxFailures: 3,
  intervalMinMs: 3e3,
  intervalMaxMs: 5e3,
  alignHourly: true,
  quarantines: {},
  debug: false,
  persistTelemetry: false
};
function formatTrippingDuration(remainingMin) {
  if (remainingMin <= 0) return "0m";
  if (remainingMin <= 60) return `${remainingMin}m`;
  const hours = Math.floor(remainingMin / 60);
  const mins = remainingMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
var CSS = `
.dso-health-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
}
.dso-health-badge.ok {
  background: rgba(46, 158, 91, 0.15);
  color: var(--dsw-alias-state-success, #3fb950);
}
.dso-health-badge.tripped {
  background: rgba(207, 34, 46, 0.18);
  color: var(--dsw-alias-state-error, #f85149);
}
.dso-health-badge.probation {
  background: rgba(210, 153, 34, 0.18);
  color: var(--dsw-alias-state-warning, #e3b341);
}
.dso-reset-btn {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  color: var(--dsw-alias-brand-primary, #58a6ff);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s;
}
.dso-reset-btn:hover:not(:disabled) {
  background: rgba(88, 166, 255, 0.15);
  border-color: #58a6ff;
}
.dso-section {
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  padding: 20px 0 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: inherit;
}
.dso-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dso-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dso-title {
  color: var(--dsw-alias-label-primary, #111);
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
.dso-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
.dso-badge.on {
  background: rgba(46, 158, 91, 0.15);
  color: var(--dsw-alias-state-success, #2e9e5b);
}
.dso-badge.off {
  background: var(--dsw-alias-interactive-bg-hover, #eee);
  color: var(--dsw-alias-label-tertiary, #888);
}
.dso-badge i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dso-desc {
  color: var(--dsw-alias-label-secondary, #444);
  font-size: 13px;
  line-height: 1.5;
  margin: 4px 0 0;
}
.dso-toggles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.dso-toggle-card {
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02));
  border: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dso-toggle-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111);
}
.dso-toggle-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #777);
  margin-top: 2px;
}
.dso-switch {
  width: 40px;
  height: 22px;
  flex: none;
  background: var(--dsw-alias-interactive-bg-hover, #ccc);
  border: none;
  border-radius: 999px;
  position: relative;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s;
}
.dso-switch[aria-checked=true] {
  background: var(--dsw-alias-state-business-primary, #0969da);
}
.dso-switch-handle {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.15s;
}
.dso-switch[aria-checked=true] .dso-switch-handle {
  transform: translateX(18px);
}
.dso-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dso-group-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, #111);
}
.dso-segmented {
  display: inline-flex;
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.04));
  border: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
  width: fit-content;
}
.dso-segmented button {
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #555);
  cursor: pointer;
  transition: all 0.12s;
}
.dso-segmented button.active {
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #111);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  font-weight: 600;
}
.dso-table-wrap {
  border: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.dso-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.dso-table th {
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #555);
}
.dso-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f2f5);
  color: var(--dsw-alias-label-primary, #222);
}
.dso-table tr:last-child td {
  border-bottom: none;
}
.dso-input {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04));
  color: var(--dsw-alias-label-primary, inherit);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
.dso-input:focus {
  border-color: var(--dsw-alias-brand-primary, #1f6feb);
}
.dso-input option {
  background: var(--dsw-alias-bg-layer-1, #1e1e1e);
  color: var(--dsw-alias-label-primary, #e6edf3);
}
.dso-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 12px;
  padding-top: 8px;
}
.dso-btn {
  padding: 7px 18px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  line-height: 1.4;
  letter-spacing: 0.2px;
}
.dso-btn-primary {
  background: var(--dsw-alias-brand-primary, #ffffff);
  color: var(--dsw-alias-label-inverse, #121212) !important;
  font-weight: 700;
  border: 1px solid rgba(0, 0, 0, 0.15);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.dso-btn-primary:hover:not(:disabled) {
  opacity: 0.92;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
}
.dso-btn-primary:disabled {
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-tertiary, #8b949e) !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  box-shadow: none;
  cursor: not-allowed;
  opacity: 1;
}
.dso-btn-secondary {
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  color: var(--dsw-alias-label-primary, inherit);
}
.dso-btn-secondary:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.14));
}
.dso-btn-danger {
  background: transparent;
  border: none;
  color: var(--dsw-alias-state-error, #f85149);
  cursor: pointer;
  padding: 2px 6px;
  font-size: 12px;
}
.dso-btn-danger:hover:not(:disabled) {
  text-decoration: underline;
}
.dso-add-row {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.015));
  border-top: 1px dashed var(--dsw-alias-border-l2, #ddd);
  align-items: center;
}
.dso-dirty-tag {
  color: var(--dsw-alias-state-warning, #e3b341);
  font-size: 12px;
  font-weight: 600;
  margin-right: auto;
}
.dso-status-tag {
  font-size: 12px;
  font-weight: 600;
}
.dso-status-ok { color: var(--dsw-alias-state-success, #3fb950); }
.dso-status-fail { color: var(--dsw-alias-state-error, #f85149); }
.dso-refresh-health-btn {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  color: var(--dsw-alias-label-secondary, inherit);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  line-height: 14px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dso-refresh-health-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary, #0969da);
  color: var(--dsw-alias-brand-primary, #0969da);
  background: rgba(9, 105, 218, 0.08);
}
.dso-refresh-health-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.dso-refresh-health-btn.spinning i {
  display: inline-block;
  animation: dso-spin 0.6s linear infinite;
}
@keyframes dso-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.dso-health-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 14px;
  white-space: nowrap;
}
.dso-health-badge.ok {
  background: rgba(46, 158, 91, 0.15);
  color: var(--dsw-alias-state-success, #2e9e5b);
}
.dso-health-badge.tripped {
  background: rgba(207, 34, 46, 0.15);
  color: var(--dsw-alias-state-error, #cf222e);
}
.dso-health-badge.probation {
  background: rgba(227, 179, 65, 0.15);
  color: var(--dsw-alias-state-warning, #e3b341);
}
.dso-reset-btn {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  color: var(--dsw-alias-brand-primary, #0969da);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
  line-height: 14px;
}
.dso-reset-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary, #0969da);
  background: rgba(9, 105, 218, 0.08);
}
.dso-reset-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;
function ensureCss() {
  if (typeof document === "undefined") return;
  if (!document.getElementById(CSS_TAG)) {
    const el = document.createElement("style");
    el.id = CSS_TAG;
    el.textContent = CSS;
    document.head.appendChild(el);
  }
}
function bindSnapshotSelector(scope) {
  const subscribe = (fn) => scope.subscribe(fn);
  const getSnapshot = () => scope.getSnapshot();
  return function useSelector(sel) {
    return sel((0, import_react.useSyncExternalStore)(subscribe, getSnapshot));
  };
}
function resolveSettingsScope(ctx, namespace) {
  const forms = ctx?.configForms;
  if (forms && typeof forms.get === "function") {
    try {
      const form = forms.get(namespace);
      if (form && typeof form.getSnapshot === "function") return form;
    } catch {
    }
  }
  const legacy = ctx?.settingsScope;
  if (legacy && typeof legacy.bind === "function") {
    try {
      const scope = legacy.bind({ namespace });
      if (scope && typeof scope.getSnapshot === "function") return scope;
    } catch {
    }
  }
  return {
    subscribe: () => () => {
    },
    getSnapshot: () => void 0,
    set: async () => {
    }
  };
}
function projectConfig(value) {
  if (!value || typeof value !== "object") {
    return { ...DEFAULTS, endpoints: [], fallback: [], quarantines: {} };
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
    // Whitelisted, not merely truthy: an unknown strategy/mode would otherwise
    // project straight into the typed config (no segmented button active, and
    // re-persisted on the next Save). config.ts already rejects these values.
    strategy: STRATEGIES.includes(value.strategy) ? value.strategy : DEFAULTS.strategy,
    failover: typeof value.failover === "boolean" ? value.failover : DEFAULTS.failover,
    mode: MODES.includes(value.mode) ? value.mode : DEFAULTS.mode,
    // Fresh arrays AND fresh row objects: the projection must not alias the raw
    // snapshot, or a later in-place edit would write through to the host state.
    endpoints: Array.isArray(value.endpoints) ? value.endpoints.map((row) => ({ ...row })) : [],
    fallback: Array.isArray(value.fallback) ? value.fallback.map((row) => ({ ...row })) : [],
    cooldownMs: typeof value.cooldownMs === "number" ? value.cooldownMs : DEFAULTS.cooldownMs,
    maxFailures: typeof value.maxFailures === "number" ? value.maxFailures : DEFAULTS.maxFailures,
    intervalMinMs: typeof value.intervalMinMs === "number" ? value.intervalMinMs : DEFAULTS.intervalMinMs,
    intervalMaxMs: typeof value.intervalMaxMs === "number" ? value.intervalMaxMs : DEFAULTS.intervalMaxMs,
    alignHourly: typeof value.alignHourly === "boolean" ? value.alignHourly : DEFAULTS.alignHourly,
    quarantines: value.quarantines && typeof value.quarantines === "object" ? { ...value.quarantines } : {},
    debug: typeof value.debug === "boolean" ? value.debug : DEFAULTS.debug,
    persistTelemetry: typeof value.persistTelemetry === "boolean" ? value.persistTelemetry : DEFAULTS.persistTelemetry
  };
}
function planConfigWrites(draft, current) {
  const writes = [];
  for (const [key, value] of Object.entries(draft)) {
    if (key === "quarantines") continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
      writes.push([key, value]);
    }
  }
  return writes;
}
function configForDirtyCheck(config) {
  const { quarantines: _ignored, ...rest } = config;
  return rest;
}
function isConfigDirty(draft, current) {
  return JSON.stringify(configForDirtyCheck(draft)) !== JSON.stringify(configForDirtyCheck(current));
}
function endpointQuarantineUntil(endpoint, draftQuarantines, currentQuarantines, suppressedKeys) {
  const draft = draftQuarantines || {};
  const current = currentQuarantines || {};
  const keys = [
    `${endpoint.provider}::${endpoint.model}`,
    `${endpoint.provider}:${endpoint.model}`,
    endpoint.provider
  ];
  for (const key of keys) {
    if (suppressedKeys?.has(key)) continue;
    const at = draft[key];
    if (at !== void 0 && at !== null) return typeof at === "number" ? at : void 0;
  }
  for (const key of keys) {
    if (suppressedKeys?.has(key)) continue;
    const at = current[key];
    if (at !== void 0 && at !== null) return typeof at === "number" ? at : void 0;
  }
  return void 0;
}
function isEndpointTripped(endpoint, draftQuarantines, currentQuarantines, now, suppressedKeys) {
  const at = endpointQuarantineUntil(endpoint, draftQuarantines, currentQuarantines, suppressedKeys);
  return typeof at === "number" && at > now;
}
function activeClearedQuarantineKeys(cleared, currentQuarantines) {
  const current = currentQuarantines || {};
  const active = /* @__PURE__ */ new Set();
  for (const [key, clearedValue] of cleared) {
    if (clearedValue !== void 0 && current[key] === clearedValue) active.add(key);
  }
  return active;
}
function pruneClearedQuarantineKeys(cleared, currentQuarantines) {
  const current = currentQuarantines || {};
  const next = /* @__PURE__ */ new Map();
  for (const [key, clearedValue] of cleared) {
    if (clearedValue !== void 0 && current[key] === clearedValue) next.set(key, clearedValue);
  }
  return next;
}
function reconcileDraftQuarantines(draftQuarantines, currentQuarantines) {
  const current = currentQuarantines || {};
  const next = {};
  for (const [key, value] of Object.entries(draftQuarantines || {})) {
    if (key in current) next[key] = value;
  }
  return next;
}
function quarantinesAfterReset(draftQuarantines, currentQuarantines, provider, model, locallyClearedKeys = []) {
  const cleared = new Set(locallyClearedKeys);
  const next = {};
  for (const [key, value] of Object.entries(draftQuarantines || {})) {
    if (!cleared.has(key)) next[key] = value;
  }
  for (const [key, value] of Object.entries(currentQuarantines || {})) {
    if (!cleared.has(key)) next[key] = value;
  }
  for (const key of [`${provider}::${model}`, `${provider}:${model}`, provider]) {
    delete next[key];
  }
  return next;
}
function updateEndpointWeightAt(endpoints, index, rawWeight) {
  const next = [...endpoints];
  if (next[index]) next[index] = { ...next[index], weight: normalizeWeight(rawWeight) };
  return next;
}
function toggleEndpointAt(endpoints, index) {
  const next = [...endpoints];
  if (next[index]) {
    next[index] = { ...next[index], enabled: next[index].enabled === false ? true : false };
  }
  return next;
}
function removeEndpointAt(endpoints, index) {
  return endpoints.filter((_, i) => i !== index);
}
function normalizeWeight(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
function buildEndpointRow(provider, model, reasoningEffort, weight) {
  if (!provider.trim() || !model.trim()) return null;
  return {
    provider: provider.trim(),
    model: model.trim(),
    ...reasoningEffort.trim() ? { reasoningEffort: reasoningEffort.trim() } : {},
    // The panel's weight inputs declare min=1; `Number(x) || 1` only catches
    // 0/NaN, so a typed negative or a non-finite value would be stored as-is.
    weight: normalizeWeight(weight),
    enabled: true
  };
}
function mergeSnapshotIntoDraft(prev, prevSnap, next) {
  const merged = { ...prev };
  for (const key of Object.keys(next)) {
    if (key === "quarantines") continue;
    const draftJSON = JSON.stringify(prev[key]);
    const pendingEdit = prevSnap !== void 0 && draftJSON !== JSON.stringify(prevSnap[key]);
    if (pendingEdit) continue;
    merged[key] = next[key];
  }
  return merged;
}
function SubagentsOrchestratorSection(props) {
  ensureCss();
  const scope = props?.scope ?? props?.inject?.scope;
  const useScope = props?.useScope ?? props?.inject?.useScope;
  const snap = useScope ? useScope((s) => s) : scope?.getSnapshot?.();
  const ready = Boolean(snap && snap.status === "ready");
  const current = projectConfig(ready ? snap.value : snap?.value ?? null);
  const writable = snap ? snap.writable !== false : true;
  const currentKey = JSON.stringify(current);
  const [prevKey, setPrevKey] = (0, import_react.useState)(currentKey);
  const [draft, setDraft] = (0, import_react.useState)(current);
  if (currentKey !== prevKey) {
    setPrevKey(currentKey);
    if (JSON.stringify(draft) === prevKey) {
      setDraft(current);
    }
  }
  const [saveState, setSaveState] = (0, import_react.useState)(null);
  const [newProv, setNewProv] = (0, import_react.useState)("");
  const [newModel, setNewModel] = (0, import_react.useState)("");
  const [newReasoningEffort, setNewReasoningEffort] = (0, import_react.useState)("");
  const [newWeight, setNewWeight] = (0, import_react.useState)(1);
  const [showAdvanced, setShowAdvanced] = (0, import_react.useState)(false);
  const [now, setNow] = (0, import_react.useState)(() => Date.now());
  const lastSnapValue = (0, import_react.useRef)(void 0);
  const clearedQuarantineKeys = (0, import_react.useRef)(/* @__PURE__ */ new Map());
  (0, import_react.useEffect)(() => {
    const timer = setInterval(() => setNow(Date.now()), 15e3);
    return () => clearInterval(timer);
  }, []);
  const [refreshing, setRefreshing] = (0, import_react.useState)(false);
  const refreshHealth = () => {
    setRefreshing(true);
    setNow(Date.now());
    setTimeout(() => setRefreshing(false), 500);
  };
  const resetAllHealth = async () => {
    for (const [key, value] of Object.entries(current.quarantines || {})) clearedQuarantineKeys.current.set(key, value);
    update("quarantines", {});
    if (scope?.set) {
      try {
        await scope.set("quarantines", {});
      } catch {
      }
    }
  };
  (0, import_react.useEffect)(() => {
    if (snap?.value) {
      const nextSnap = projectConfig(snap.value);
      clearedQuarantineKeys.current = pruneClearedQuarantineKeys(
        clearedQuarantineKeys.current,
        nextSnap.quarantines
      );
      const prevSnap = lastSnapValue.current;
      lastSnapValue.current = nextSnap;
      setDraft((prev) => {
        const merged = mergeSnapshotIntoDraft(prev, prevSnap, nextSnap);
        return { ...merged, quarantines: reconcileDraftQuarantines(prev.quarantines, nextSnap.quarantines) };
      });
    }
  }, [snap?.revision, ready]);
  const dirty = isConfigDirty(draft, current);
  const update = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };
  const toggleEndpoint = (index) => {
    setDraft((d) => ({ ...d, endpoints: toggleEndpointAt(d.endpoints || [], index) }));
  };
  const removeEndpoint = (index) => {
    setDraft((d) => ({ ...d, endpoints: removeEndpointAt(d.endpoints || [], index) }));
  };
  const resetEndpointHealth = async (provider, model) => {
    const cleared = pruneClearedQuarantineKeys(clearedQuarantineKeys.current, current.quarantines);
    clearedQuarantineKeys.current = cleared;
    const pending = activeClearedQuarantineKeys(cleared, current.quarantines);
    const nextQ = quarantinesAfterReset(draft.quarantines, current.quarantines, provider, model, [...pending]);
    for (const key of [`${provider}::${model}`, `${provider}:${model}`, provider]) {
      cleared.set(key, (current.quarantines || {})[key]);
    }
    update("quarantines", nextQ);
    if (scope?.set) {
      try {
        await scope.set("quarantines", nextQ);
      } catch {
      }
    }
  };
  const addEndpoint = () => {
    const item = buildEndpointRow(newProv, newModel, newReasoningEffort, newWeight);
    if (!item) return;
    setDraft((d) => ({
      ...d,
      endpoints: [
        ...d.endpoints || [],
        item
      ]
    }));
    setNewProv("");
    setNewModel("");
    setNewReasoningEffort("");
    setNewWeight(1);
  };
  const save = (0, import_react.useCallback)(async () => {
    if (!scope) return;
    setSaveState("saving");
    try {
      for (const [key, value] of planConfigWrites(draft, current)) {
        await scope.set(key, value);
      }
      setSaveState("ok");
      setTimeout(() => setSaveState(null), 3e3);
    } catch {
      setSaveState("fail");
    }
  }, [draft, current, scope]);
  const revert = () => {
    setDraft(current);
    setSaveState(null);
  };
  const activeEndpoints = (draft.endpoints || []).filter((e) => e.enabled !== false);
  const suppressedQuarantineKeys = activeClearedQuarantineKeys(
    clearedQuarantineKeys.current,
    current.quarantines
  );
  const trippedCount = (draft.endpoints || []).filter(
    (ep) => isEndpointTripped(ep, draft.quarantines, current.quarantines, now, suppressedQuarantineKeys)
  ).length;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-title-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dso-title", children: "Subagents Orchestrator" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: `dso-badge ${draft.enabled ? "on" : "off"}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
          draft.enabled ? `Active (${activeEndpoints.length} endpoints)` : "Disabled"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dso-desc", children: "Multi-endpoint load distributor and automated connection error failover for DeepSeek Harness subagents." })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-toggles", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-toggle-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-toggle-label", children: "Enable Orchestration" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-toggle-hint", children: "Distribute subagents across configured endpoint pool" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "dso-switch",
            role: "switch",
            "aria-checked": draft.enabled,
            disabled: !writable,
            onClick: () => update("enabled", !draft.enabled),
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-switch-handle" })
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-toggle-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-toggle-label", children: "Auto-Failover" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-toggle-hint", children: "Switch endpoint on rate limits (429), timeouts, or server errors" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "dso-switch",
            role: "switch",
            "aria-checked": draft.failover,
            disabled: !writable,
            onClick: () => update("failover", !draft.failover),
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-switch-handle" })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-group", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-group-title", children: "Routing Strategy" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dso-segmented", children: ["round-robin", "random", "weighted"].map((strat) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: draft.strategy === strat ? "active" : "",
          disabled: !writable,
          onClick: () => update("strategy", strat),
          children: strat === "round-robin" ? "Round-Robin" : strat === "random" ? "Random" : "Weighted"
        },
        strat
      )) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-group", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-group-title", children: "Configured Endpoints Pool" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              type: "button",
              className: `dso-refresh-health-btn ${refreshing ? "spinning" : ""}`,
              title: "Refresh health status from host",
              disabled: refreshing,
              onClick: refreshHealth,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "\u21BB" }),
                refreshing ? "Refreshing\u2026" : "Refresh Health"
              ]
            }
          ),
          trippedCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              type: "button",
              className: "dso-btn-danger",
              style: { fontSize: 11, padding: "2px 8px", border: "1px solid currentColor", borderRadius: 4, textDecoration: "none" },
              title: "Reset all tripped endpoints back to healthy immediately",
              disabled: !writable,
              onClick: resetAllHealth,
              children: [
                "Reset All (",
                trippedCount,
                ")"
              ]
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" }, children: [
          activeEndpoints.length,
          " in rotation / ",
          (draft.endpoints || []).length,
          " total"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-table-wrap", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { className: "dso-table", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 40 }, children: "Active" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Provider ID" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "Model" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 85 }, children: "Reasoning" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 125 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Health" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: `dso-refresh-health-btn ${refreshing ? "spinning" : ""}`,
                  style: { padding: "1px 5px", fontSize: 11 },
                  title: "Refresh health status",
                  disabled: refreshing,
                  onClick: refreshHealth,
                  children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "\u21BB" })
                }
              )
            ] }) }),
            draft.strategy === "weighted" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 70 }, children: "Weight" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 60 }, children: "Action" })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: (draft.endpoints || []).length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: draft.strategy === "weighted" ? 7 : 6, style: { textAlign: "center", color: "#999", padding: "16px 0" }, children: "No endpoints configured. Subagents will use default parent session model." }) }) : (draft.endpoints || []).map((ep, idx) => {
            const unquarantineAt = endpointQuarantineUntil(ep, draft.quarantines, current.quarantines, suppressedQuarantineKeys);
            const isTripped = isEndpointTripped(ep, draft.quarantines, current.quarantines, now, suppressedQuarantineKeys);
            const remainingMin = isTripped && typeof unquarantineAt === "number" ? Math.max(1, Math.ceil((unquarantineAt - now) / 6e4)) : 0;
            return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { style: { opacity: ep.enabled === false ? 0.5 : 1 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: ep.enabled !== false,
                  disabled: !writable,
                  onChange: () => toggleEndpoint(idx)
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: ep.provider }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: ep.model }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "select",
                {
                  className: "dso-input",
                  style: { width: 75, fontSize: 11, padding: "2px 4px" },
                  value: ep.reasoningEffort === "medium" ? "med" : ep.reasoningEffort || "",
                  disabled: !writable,
                  onChange: (e) => {
                    const val = e.target.value.trim();
                    setDraft((d) => {
                      const endpoints = [...d.endpoints || []];
                      if (endpoints[idx]) {
                        const updated = { ...endpoints[idx] };
                        if (val) {
                          updated.reasoningEffort = val === "med" ? "medium" : val;
                        } else {
                          delete updated.reasoningEffort;
                        }
                        endpoints[idx] = updated;
                      }
                      return { ...d, endpoints };
                    });
                  },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "default" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "off", children: "off" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "low", children: "low" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "med", children: "med" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "high", children: "high" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "max", children: "max" })
                  ]
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: ep.enabled === false ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 11 }, children: "Disabled" }) : isTripped ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                  "span",
                  {
                    className: "dso-health-badge tripped",
                    title: `Cooling down until ${new Date(unquarantineAt).toLocaleDateString() === new Date(now).toLocaleDateString() ? new Date(unquarantineAt).toLocaleTimeString() : new Date(unquarantineAt).toLocaleString()}`,
                    children: [
                      "\u{1F534} Tripped (",
                      formatTrippingDuration(remainingMin),
                      ")"
                    ]
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    className: "dso-reset-btn",
                    disabled: !writable,
                    title: "Clear quarantine immediately",
                    onClick: () => resetEndpointHealth(ep.provider, ep.model),
                    children: "Reset"
                  }
                )
              ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-health-badge ok", children: "\u{1F7E2} Healthy" }) }),
              draft.strategy === "weighted" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "input",
                {
                  type: "number",
                  className: "dso-input",
                  style: { width: 50 },
                  min: 1,
                  max: 100,
                  value: ep.weight || 1,
                  disabled: !writable,
                  onChange: (e) => setDraft((d) => ({
                    ...d,
                    endpoints: updateEndpointWeightAt(d.endpoints || [], idx, e.target.value)
                  }))
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dso-btn-danger",
                  disabled: !writable,
                  onClick: () => removeEndpoint(idx),
                  children: "Delete"
                }
              ) })
            ] }, `${ep.provider}-${ep.model}-${idx}`);
          }) })
        ] }),
        writable && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-add-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "text",
              className: "dso-input",
              placeholder: "Provider ID (e.g. b-ai-1)",
              style: { flex: 1 },
              value: newProv,
              onChange: (e) => setNewProv(e.target.value)
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "text",
              className: "dso-input",
              placeholder: "Model (e.g. glm-5.3-flash)",
              style: { flex: 1 },
              value: newModel,
              onChange: (e) => setNewModel(e.target.value)
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              className: "dso-input",
              style: { width: 85 },
              value: newReasoningEffort === "medium" ? "med" : newReasoningEffort,
              onChange: (e) => {
                const val = e.target.value.trim();
                setNewReasoningEffort(val === "med" ? "medium" : val);
              },
              title: "Reasoning Effort",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "default" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "off", children: "off" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "low", children: "low" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "med", children: "med" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "high", children: "high" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "max", children: "max" })
              ]
            }
          ),
          draft.strategy === "weighted" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "number",
              className: "dso-input",
              placeholder: "Weight",
              style: { width: 60 },
              min: 1,
              max: 100,
              value: newWeight,
              onChange: (e) => setNewWeight(normalizeWeight(e.target.value))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dso-btn dso-btn-secondary",
              disabled: !newProv.trim() || !newModel.trim(),
              onClick: addEndpoint,
              children: "+ Add"
            }
          )
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: { background: "none", border: "none", color: "var(--dsw-alias-brand-primary, #0969da)", cursor: "pointer", fontSize: 12, padding: 0 },
          onClick: () => setShowAdvanced(!showAdvanced),
          children: showAdvanced ? "\u25B2 Hide Advanced Circuit Breaker Settings" : "\u25BC Show Advanced Circuit Breaker Settings"
        }
      ),
      showAdvanced && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 10 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }, children: "Trip Threshold (Failures)" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "number",
              className: "dso-input",
              style: { width: "100%" },
              min: 1,
              max: 20,
              value: draft.maxFailures || 3,
              disabled: !writable,
              onChange: (e) => update("maxFailures", Number(e.target.value) || 3)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }, children: "Cooldown Duration (ms)" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "number",
              className: "dso-input",
              style: { width: "100%" },
              min: 1e3,
              step: 6e4,
              value: draft.cooldownMs || 36e5,
              disabled: !writable,
              onChange: (e) => update("cooldownMs", Number(e.target.value) || 36e5)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }, children: "Retry Pacing Min (ms)" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "number",
              className: "dso-input",
              style: { width: "100%" },
              min: 500,
              step: 500,
              value: draft.intervalMinMs || 3e3,
              disabled: !writable,
              onChange: (e) => update("intervalMinMs", Number(e.target.value) || 3e3)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }, children: "Retry Pacing Max (ms)" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "number",
              className: "dso-input",
              style: { width: "100%" },
              min: 1e3,
              step: 500,
              value: draft.intervalMaxMs || 5e3,
              disabled: !writable,
              onChange: (e) => update("intervalMaxMs", Number(e.target.value) || 5e3)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, gridColumn: "1 / -1", marginTop: 4 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              id: "dso-align-hourly",
              checked: draft.alignHourly !== false,
              disabled: !writable,
              onChange: (e) => update("alignHourly", e.target.checked)
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "dso-align-hourly", style: { fontSize: 12, fontWeight: 600, cursor: "pointer" }, children: "Align Cooldown to Next Clock Hour (:00 + 1m grace)" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #777)" }, children: "Syncs cooldowns with upstream quota reset schedules (e.g. CodeBuddy hourly resets)" })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-actions", children: [
      dirty && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-dirty-tag", children: "\u25CF Unsaved Changes" }),
      saveState === "ok" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-status-tag dso-status-ok", children: "Saved Successfully \u2713" }),
      saveState === "fail" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-status-tag dso-status-fail", children: "Save Failed \u2717" }),
      dirty && saveState !== "saving" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dso-btn dso-btn-secondary", onClick: revert, children: "Discard" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "dso-btn dso-btn-primary",
          disabled: !writable || !dirty || saveState === "saving",
          onClick: save,
          children: saveState === "saving" ? "Saving\u2026" : "Save Changes"
        }
      )
    ] })
  ] });
}
function apply(ctx) {
  ensureCss();
  const scope = resolveSettingsScope(ctx, NS);
  const useScope = bindSnapshotSelector(scope);
  const endpointTest = bindEndpointTest(ctx);
  ctx.slots.inject("settings.section", () => {
    ctx.slots.register(
      {
        name: "settings.section",
        id: "subagents-orchestrator",
        order: 22,
        label: () => "Subagents Orchestrator",
        inject: () => ({ useScope, scope, endpointTest })
      },
      SubagentsOrchestratorSection
    );
  }, PLUGIN_ID + ": settings section");
}
var inject = ["slots"];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CSS_TAG,
  NS,
  PLUGIN_ID,
  SubagentsOrchestratorSection,
  activeClearedQuarantineKeys,
  apply,
  bindSnapshotSelector,
  buildEndpointRow,
  endpointQuarantineUntil,
  formatTrippingDuration,
  inject,
  isConfigDirty,
  isEndpointTripped,
  mergeSnapshotIntoDraft,
  normalizeWeight,
  planConfigWrites,
  projectConfig,
  pruneClearedQuarantineKeys,
  quarantinesAfterReset,
  reconcileDraftQuarantines,
  removeEndpointAt,
  resolveSettingsScope,
  toggleEndpointAt,
  updateEndpointWeightAt
});
return module.exports;} });
//# sourceMappingURL=client.js.map