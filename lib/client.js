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
  apply: () => apply,
  bindSnapshotSelector: () => bindSnapshotSelector,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
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
          ] }, `${ep.provider}-${ep.model}-${idx}`)) })
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
  ctx.slots.inject("settings.section", () => {
    ctx.slots.register(
      {
        name: "settings.section",
        id: "subagents-orchestrator",
        order: 22,
        label: () => "Subagents Orchestrator",
        inject: () => ({ useScope, scope })
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