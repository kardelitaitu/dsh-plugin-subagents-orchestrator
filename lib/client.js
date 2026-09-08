window.__ModuleLoader__.load({id: "dsh-plugin-subagents-orchestrator",factory: (require) => {var module = { exports: {} };var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var client_exports = {};
__export(client_exports, {
  CSS_TAG: () => CSS_TAG,
  NS: () => NS,
  PLUGIN_ID: () => PLUGIN_ID,
  SubagentsOrchestratorSection: () => SubagentsOrchestratorSection,
  apply: () => apply,
  bindSnapshotSelector: () => bindSnapshotSelector,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);

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
  const namespace = (described.value?.namespaces ?? []).find((ns) => ns?.ns === DISCOVERY_SETTINGS_NS);
  const value = namespace?.value;
  const providers = value?.providers;
  if (!providers || typeof providers !== "object") return void 0;
  const record = providers[provider];
  if (!record || typeof record !== "object") return void 0;
  const baseURL = record.baseURL;
  return typeof baseURL === "string" && baseURL.trim().length > 0 ? baseURL : void 0;
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
  const llm = faces.llm;
  if (!llm || typeof llm.discoverModels !== "function") {
    return { status: "unavailable", message: "This DSH build does not expose the remote.llm probe channel to plugin panels." };
  }
  let baseURL = input.baseURL?.trim();
  if (!baseURL) baseURL = await storedBaseURL(faces.settings, input.provider);
  if (!baseURL) {
    return { status: "fail", message: "No baseURL to probe: enter one, or add this provider to the Models settings first." };
  }
  const composed = composeTimeout(signal, TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await llm.discoverModels(
      DISCOVERY_SETTINGS_NS,
      {
        provider: input.provider,
        baseURL,
        ...input.apiKey ? { apiKey: input.apiKey } : {}
      },
      composed.signal
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { status: "fail", message: response.error?.message || "The probe was refused without a message.", latencyMs };
    }
    const models = Array.isArray(response.value) ? response.value : [];
    if (!input.model) {
      return { status: "ok", models, modelFound: null, latencyMs };
    }
    const configured = models.find((model) => model?.id === input.model);
    return {
      status: "ok",
      models,
      modelFound: Boolean(configured),
      ...configured?.contextWindow !== void 0 ? { modelContextWindow: configured.contextWindow } : {},
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
var DEFAULTS = {
  enabled: true,
  strategy: "round-robin",
  failover: true,
  mode: "pool",
  endpoints: [],
  fallback: [],
  cooldownMs: 6e4,
  maxFailures: 3,
  intervalMinMs: 3e3,
  intervalMaxMs: 5e3,
  debug: false,
  persistTelemetry: false
};
var CSS = `
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
  border: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #111);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
.dso-input:focus {
  border-color: var(--dsw-alias-brand-primary, #0969da);
}
.dso-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.dso-btn {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.dso-btn-primary {
  background: var(--dsw-alias-brand-primary, #0969da);
  color: #fff;
}
.dso-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dso-btn-secondary {
  background: var(--dsw-alias-bg-layer-2, #eee);
  border-color: var(--dsw-alias-border-l2, #ddd);
  color: var(--dsw-alias-label-primary, #222);
}
.dso-btn-danger {
  background: transparent;
  border: none;
  color: var(--dsw-alias-state-error, #cf222e);
  cursor: pointer;
  padding: 2px 6px;
  font-size: 12px;
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
  color: var(--dsw-alias-state-warning, #9a6700);
  font-size: 12px;
  font-weight: 600;
  margin-right: auto;
}
.dso-status-tag {
  font-size: 12px;
  font-weight: 600;
}
.dso-status-ok { color: var(--dsw-alias-state-success, #2e9e5b); }
.dso-status-fail { color: var(--dsw-alias-state-error, #cf222e); }
.dso-test-btn {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, #ddd);
  color: var(--dsw-alias-label-primary, #222);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s;
}
.dso-test-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary, #0969da);
  color: var(--dsw-alias-brand-primary, #0969da);
}
.dso-test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dso-test-panel {
  border-top: 1px dashed var(--dsw-alias-border-l2, #ddd);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.015));
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.dso-test-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.dso-test-label {
  color: var(--dsw-alias-label-tertiary, #777);
  flex: none;
}
.dso-test-input {
  border: 1px solid var(--dsw-alias-border-l2, #e1e4e8);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #111);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  flex: 1;
  min-width: 160px;
}
.dso-test-input:focus {
  border-color: var(--dsw-alias-brand-primary, #0969da);
}
.dso-test-result {
  line-height: 1.5;
  word-break: break-word;
}
.dso-test-result.ok { color: var(--dsw-alias-state-success, #2e9e5b); }
.dso-test-result.fail { color: var(--dsw-alias-state-error, #cf222e); }
.dso-test-result.warn { color: var(--dsw-alias-state-warning, #9a6700); }
.dso-test-result.idle { color: var(--dsw-alias-label-tertiary, #777); }
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
function projectConfig(value) {
  if (!value || typeof value !== "object") return { ...DEFAULTS };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
    strategy: value.strategy || DEFAULTS.strategy,
    failover: typeof value.failover === "boolean" ? value.failover : DEFAULTS.failover,
    mode: value.mode || DEFAULTS.mode,
    endpoints: Array.isArray(value.endpoints) ? value.endpoints : [],
    fallback: Array.isArray(value.fallback) ? value.fallback : [],
    cooldownMs: typeof value.cooldownMs === "number" ? value.cooldownMs : DEFAULTS.cooldownMs,
    maxFailures: typeof value.maxFailures === "number" ? value.maxFailures : DEFAULTS.maxFailures,
    intervalMinMs: typeof value.intervalMinMs === "number" ? value.intervalMinMs : DEFAULTS.intervalMinMs,
    intervalMaxMs: typeof value.intervalMaxMs === "number" ? value.intervalMaxMs : DEFAULTS.intervalMaxMs,
    debug: typeof value.debug === "boolean" ? value.debug : DEFAULTS.debug,
    persistTelemetry: typeof value.persistTelemetry === "boolean" ? value.persistTelemetry : DEFAULTS.persistTelemetry
  };
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
  const [newWeight, setNewWeight] = (0, import_react.useState)(1);
  const [showAdvanced, setShowAdvanced] = (0, import_react.useState)(false);
  const endpointTest = props?.endpointTest ?? props?.inject?.endpointTest;
  const [testRow, setTestRow] = (0, import_react.useState)(null);
  const [testURL, setTestURL] = (0, import_react.useState)("");
  const [testKey, setTestKey] = (0, import_react.useState)("");
  const [testState, setTestState] = (0, import_react.useState)(null);
  const [testing, setTesting] = (0, import_react.useState)(false);
  const testAbortRef = import_react.default.useRef(null);
  const testPrefillSeqRef = import_react.default.useRef(0);
  const openTest = (index) => {
    const ep = (draft.endpoints || [])[index];
    if (!ep || !endpointTest) return;
    setTestRow(index);
    setTestURL("");
    setTestKey("");
    setTestState(null);
    setTesting(false);
    const seq = ++testPrefillSeqRef.current;
    Promise.resolve(endpointTest.storedBaseURL?.(ep.provider)).then((url) => {
      if (seq !== testPrefillSeqRef.current) return;
      if (typeof url === "string" && url.length > 0) setTestURL((prev) => prev.length === 0 ? url : prev);
    }).catch(() => {
    });
  };
  const closeTest = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTestRow(null);
    setTestState(null);
    setTesting(false);
  };
  const runTest = (0, import_react.useCallback)(async () => {
    const ep = testRow === null ? void 0 : (draft.endpoints || [])[testRow];
    if (!ep || !endpointTest || testing) return;
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTesting(true);
    setTestState(null);
    try {
      const outcome = await endpointTest.run(
        {
          provider: ep.provider,
          model: ep.model,
          baseURL: testURL.trim() || void 0,
          apiKey: testKey.trim() || void 0
        },
        controller.signal
      );
      setTestState(outcome);
    } catch (error) {
      setTestState({ status: "fail", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
      testAbortRef.current = null;
    }
  }, [draft, endpointTest, testRow, testURL, testKey, testing]);
  const renderTestResult = () => {
    if (testing) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-test-result idle", children: "Probing endpoint\u2026" });
    if (!testState) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-test-result idle", children: "Run the probe to verify the endpoint answers and serves this model. The draft is never saved." });
    }
    if (testState.status === "unavailable") {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-test-result warn", children: testState.message });
    }
    if (testState.status === "fail") {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dso-test-result fail", children: [
        "Probe failed",
        typeof testState.latencyMs === "number" ? ` (${testState.latencyMs} ms)` : "",
        ": ",
        testState.message
      ] });
    }
    const modelName = testRow === null ? "" : (draft.endpoints || [])[testRow]?.model ?? "";
    const warn = testState.modelFound === false || testState.models.length === 0;
    const modelLine = testState.modelFound === null ? "" : testState.modelFound ? ` Model ${modelName} is served${testState.modelContextWindow !== void 0 ? ` (context window ${testState.modelContextWindow} tokens)` : ""}.` : ` Model ${modelName} was NOT in the listing \u2014 check the spelling or the endpoint's exposure.`;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: `dso-test-result ${warn ? "warn" : "ok"}`, children: [
      "Reachable in ",
      testState.latencyMs,
      " ms \xB7 ",
      testState.models.length,
      " model(s) advertised.",
      modelLine
    ] });
  };
  (0, import_react.useEffect)(() => {
    if (snap?.value) {
      setDraft((prev) => ({
        ...prev,
        ...projectConfig(snap.value),
        endpoints: snap.value.endpoints ?? prev.endpoints ?? []
      }));
    }
  }, [snap?.revision, ready]);
  const dirty = JSON.stringify(draft) !== currentKey;
  const update = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };
  const toggleEndpoint = (index) => {
    setDraft((d) => {
      const endpoints = [...d.endpoints || []];
      if (endpoints[index]) {
        endpoints[index] = {
          ...endpoints[index],
          enabled: endpoints[index].enabled === false ? true : false
        };
      }
      return { ...d, endpoints };
    });
  };
  const removeEndpoint = (index) => {
    setDraft((d) => {
      const endpoints = (d.endpoints || []).filter((_, i) => i !== index);
      return { ...d, endpoints };
    });
  };
  const addEndpoint = () => {
    if (!newProv.trim() || !newModel.trim()) return;
    setDraft((d) => ({
      ...d,
      endpoints: [
        ...d.endpoints || [],
        { provider: newProv.trim(), model: newModel.trim(), weight: Number(newWeight) || 1, enabled: true }
      ]
    }));
    setNewProv("");
    setNewModel("");
    setNewWeight(1);
  };
  const save = (0, import_react.useCallback)(async () => {
    if (!scope) return;
    setSaveState("saving");
    try {
      for (const [key, value] of Object.entries(draft)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
          await scope.set(key, value);
        }
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-group-title", children: "Configured Endpoints Pool" }),
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
            draft.strategy === "weighted" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 70 }, children: "Weight" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { width: 60 }, children: "Action" })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: (draft.endpoints || []).length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: draft.strategy === "weighted" ? 5 : 4, style: { textAlign: "center", color: "#999", padding: "16px 0" }, children: "No endpoints configured. Subagents will use default parent session model." }) }) : (draft.endpoints || []).map((ep, idx) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { style: { opacity: ep.enabled === false ? 0.5 : 1 }, children: [
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
                onChange: (e) => {
                  const val = Number(e.target.value) || 1;
                  setDraft((d) => {
                    const endpoints = [...d.endpoints || []];
                    if (endpoints[idx]) endpoints[idx] = { ...endpoints[idx], weight: val };
                    return { ...d, endpoints };
                  });
                }
              }
            ) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { children: [
              endpointTest && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dso-test-btn",
                  disabled: testing && testRow !== idx,
                  onClick: () => testRow === idx ? closeTest() : openTest(idx),
                  children: testRow === idx ? "Close" : "Test"
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "dso-btn-danger",
                  disabled: !writable,
                  onClick: () => removeEndpoint(idx),
                  children: "Delete"
                }
              )
            ] })
          ] }, `${ep.provider}-${ep.model}-${idx}`)) })
        ] }),
        testRow !== null && endpointTest && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-test-panel", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-test-line", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-test-label", children: "Base URL" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "text",
                className: "dso-test-input",
                placeholder: "https://\u2026/v1  (prefilled from the provider's stored profile when present)",
                value: testURL,
                disabled: testing,
                onChange: (e) => setTestURL(e.target.value)
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dso-test-line", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dso-test-label", children: "API key" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "password",
                className: "dso-test-input",
                placeholder: "leave empty to use the stored key for this provider",
                value: testKey,
                disabled: testing,
                onChange: (e) => setTestKey(e.target.value)
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "dso-btn dso-btn-primary",
                style: { padding: "3px 12px", fontSize: 12 },
                disabled: testing,
                onClick: runTest,
                children: testing ? "Probing\u2026" : "Run Probe"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: renderTestResult() })
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
              onChange: (e) => setNewWeight(Number(e.target.value) || 1)
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
              step: 5e3,
              value: draft.cooldownMs || 6e4,
              disabled: !writable,
              onChange: (e) => update("cooldownMs", Number(e.target.value) || 6e4)
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
  const scope = ctx.settingsScope.bind({ namespace: NS });
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
var inject = ["slots", "settingsScope"];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CSS_TAG,
  NS,
  PLUGIN_ID,
  SubagentsOrchestratorSection,
  apply,
  bindSnapshotSelector,
  inject
});
return module.exports;} });
//# sourceMappingURL=client.js.map