import React, { useState, useCallback, useSyncExternalStore, useEffect } from 'react';
import { bindEndpointTest } from './testConnection.js';
import type { TestConnectionOutcome } from './testConnection.js';

export const NS = 'subagents-orchestrator';
export const PLUGIN_ID = 'dsh-plugin-subagents-orchestrator';
export const CSS_TAG = PLUGIN_ID + '/client.css';

export interface EndpointRow {
  provider: string;
  model: string;
  weight?: number;
  enabled?: boolean;
}

export interface ClientConfig {
  enabled?: boolean;
  strategy?: 'round-robin' | 'random' | 'weighted';
  failover?: boolean;
  mode?: 'pool' | 'fallback';
  endpoints?: EndpointRow[];
  fallback?: EndpointRow[];
  cooldownMs?: number;
  maxFailures?: number;
  intervalMinMs?: number;
  intervalMaxMs?: number;
  debug?: boolean;
  persistTelemetry?: boolean;
}

const DEFAULTS: ClientConfig = {
  enabled: true,
  strategy: 'round-robin',
  failover: true,
  mode: 'pool',
  endpoints: [],
  fallback: [],
  cooldownMs: 60000,
  maxFailures: 3,
  intervalMinMs: 3000,
  intervalMaxMs: 5000,
  debug: false,
  persistTelemetry: false
};

const CSS = `
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
  if (typeof document === 'undefined') return;
  if (!document.getElementById(CSS_TAG)) {
    const el = document.createElement('style');
    el.id = CSS_TAG;
    el.textContent = CSS;
    document.head.appendChild(el);
  }
}

export function bindSnapshotSelector(scope: any) {
  const subscribe = (fn: () => void) => scope.subscribe(fn);
  const getSnapshot = () => scope.getSnapshot();
  return function useSelector<T>(sel: (s: any) => T): T {
    return sel(useSyncExternalStore(subscribe, getSnapshot));
  };
}

function projectConfig(value: any): ClientConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULTS };
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
    strategy: value.strategy || DEFAULTS.strategy,
    failover: typeof value.failover === 'boolean' ? value.failover : DEFAULTS.failover,
    mode: value.mode || DEFAULTS.mode,
    endpoints: Array.isArray(value.endpoints) ? value.endpoints : [],
    fallback: Array.isArray(value.fallback) ? value.fallback : [],
    cooldownMs: typeof value.cooldownMs === 'number' ? value.cooldownMs : DEFAULTS.cooldownMs,
    maxFailures: typeof value.maxFailures === 'number' ? value.maxFailures : DEFAULTS.maxFailures,
    intervalMinMs: typeof value.intervalMinMs === 'number' ? value.intervalMinMs : DEFAULTS.intervalMinMs,
    intervalMaxMs: typeof value.intervalMaxMs === 'number' ? value.intervalMaxMs : DEFAULTS.intervalMaxMs,
    debug: typeof value.debug === 'boolean' ? value.debug : DEFAULTS.debug,
    persistTelemetry: typeof value.persistTelemetry === 'boolean' ? value.persistTelemetry : DEFAULTS.persistTelemetry
  };
}

export function SubagentsOrchestratorSection(props: any) {
  ensureCss();

  const scope = props?.scope ?? props?.inject?.scope;
  const useScope = props?.useScope ?? props?.inject?.useScope;
  const snap = useScope ? useScope((s: any) => s) : scope?.getSnapshot?.();

  const ready = Boolean(snap && snap.status === 'ready');
  const current = projectConfig(ready ? snap.value : (snap?.value ?? null));
  const writable = snap ? snap.writable !== false : true;

  const currentKey = JSON.stringify(current);
  const [prevKey, setPrevKey] = useState(currentKey);
  const [draft, setDraft] = useState<ClientConfig>(current);

  if (currentKey !== prevKey) {
    setPrevKey(currentKey);
    if (JSON.stringify(draft) === prevKey) {
      setDraft(current);
    }
  }

  const [saveState, setSaveState] = useState<'saving' | 'ok' | 'fail' | null>(null);
  const [newProv, setNewProv] = useState('');
  const [newModel, setNewModel] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Test Connection drawer state (one row at a time).
  const endpointTest = props?.endpointTest ?? props?.inject?.endpointTest;
  const [testRow, setTestRow] = useState<number | null>(null);
  const [testURL, setTestURL] = useState('');
  const [testKey, setTestKey] = useState('');
  const [testState, setTestState] = useState<TestConnectionOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const testAbortRef = React.useRef<AbortController | null>(null);
  const testPrefillSeqRef = React.useRef(0);

  const openTest = (index: number) => {
    const ep = (draft.endpoints || [])[index];
    if (!ep || !endpointTest) return;
    setTestRow(index);
    setTestURL('');
    setTestKey('');
    setTestState(null);
    setTesting(false);
    // Best-effort prefill of the draft baseURL from the provider's stored
    // profile (llm-pi-ai section), guarded against a stale async reply.
    const seq = ++testPrefillSeqRef.current;
    Promise.resolve(endpointTest.storedBaseURL?.(ep.provider))
      .then((url: unknown) => {
        if (seq !== testPrefillSeqRef.current) return;
        if (typeof url === 'string' && url.length > 0) setTestURL((prev) => (prev.length === 0 ? url : prev));
      })
      .catch(() => {});
  };

  const closeTest = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTestRow(null);
    setTestState(null);
    setTesting(false);
  };

  const runTest = useCallback(async () => {
    const ep = testRow === null ? undefined : (draft.endpoints || [])[testRow];
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
          baseURL: testURL.trim() || undefined,
          apiKey: testKey.trim() || undefined
        },
        controller.signal
      );
      setTestState(outcome);
    } catch (error) {
      setTestState({ status: 'fail', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
      testAbortRef.current = null;
    }
  }, [draft, endpointTest, testRow, testURL, testKey, testing]);

  const renderTestResult = () => {
    if (testing) return <span className="dso-test-result idle">Probing endpoint…</span>;
    if (!testState) {
      return <span className="dso-test-result idle">Run the probe to verify the endpoint answers and serves this model. The draft is never saved.</span>;
    }
    if (testState.status === 'unavailable') {
      return <span className="dso-test-result warn">{testState.message}</span>;
    }
    if (testState.status === 'fail') {
      return (
        <span className="dso-test-result fail">
          Probe failed{typeof testState.latencyMs === 'number' ? ` (${testState.latencyMs} ms)` : ''}: {testState.message}
        </span>
      );
    }
    const modelName = testRow === null ? '' : (draft.endpoints || [])[testRow]?.model ?? '';
    const warn = testState.modelFound === false || testState.models.length === 0;
    const modelLine = testState.modelFound === null
      ? ''
      : testState.modelFound
        ? ` Model ${modelName} is served${testState.modelContextWindow !== undefined ? ` (context window ${testState.modelContextWindow} tokens)` : ''}.`
        : ` Model ${modelName} was NOT in the listing — check the spelling or the endpoint's exposure.`;
    return (
      <span className={`dso-test-result ${warn ? 'warn' : 'ok'}`}>
        Reachable in {testState.latencyMs} ms · {testState.models.length} model(s) advertised.{modelLine}
      </span>
    );
  };

  // Sync draft when snap first arrives
  useEffect(() => {
    if (snap?.value) {
      setDraft((prev) => ({
        ...prev,
        ...projectConfig(snap.value),
        endpoints: snap.value.endpoints ?? prev.endpoints ?? []
      }));
    }
  }, [snap?.revision, ready]);

  const dirty = JSON.stringify(draft) !== currentKey;

  const update = (field: keyof ClientConfig, value: any) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const toggleEndpoint = (index: number) => {
    setDraft((d) => {
      const endpoints = [...(d.endpoints || [])];
      if (endpoints[index]) {
        endpoints[index] = {
          ...endpoints[index],
          enabled: endpoints[index].enabled === false ? true : false
        };
      }
      return { ...d, endpoints };
    });
  };

  const removeEndpoint = (index: number) => {
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
        ...(d.endpoints || []),
        { provider: newProv.trim(), model: newModel.trim(), weight: Number(newWeight) || 1, enabled: true }
      ]
    }));
    setNewProv('');
    setNewModel('');
    setNewWeight(1);
  };

  const save = useCallback(async () => {
    if (!scope) return;
    setSaveState('saving');
    try {
      for (const [key, value] of Object.entries(draft)) {
        if (JSON.stringify(current[key as keyof ClientConfig]) !== JSON.stringify(value)) {
          await scope.set(key, value);
        }
      }
      setSaveState('ok');
      setTimeout(() => setSaveState(null), 3000);
    } catch {
      setSaveState('fail');
    }
  }, [draft, current, scope]);

  const revert = () => {
    setDraft(current);
    setSaveState(null);
  };

  const activeEndpoints = (draft.endpoints || []).filter((e) => e.enabled !== false);

  return (
    <div className="dso-section">
      <div className="dso-head">
        <div>
          <div className="dso-title-row">
            <h3 className="dso-title">Subagents Orchestrator</h3>
            <span className={`dso-badge ${draft.enabled ? 'on' : 'off'}`}>
              <i />
              {draft.enabled ? `Active (${activeEndpoints.length} endpoints)` : 'Disabled'}
            </span>
          </div>
          <p className="dso-desc">
            Multi-endpoint load distributor and automated connection error failover for DeepSeek Harness subagents.
          </p>
        </div>
      </div>

      <div className="dso-toggles">
        <div className="dso-toggle-card">
          <div>
            <div className="dso-toggle-label">Enable Orchestration</div>
            <div className="dso-toggle-hint">Distribute subagents across configured endpoint pool</div>
          </div>
          <button
            type="button"
            className="dso-switch"
            role="switch"
            aria-checked={draft.enabled}
            disabled={!writable}
            onClick={() => update('enabled', !draft.enabled)}
          >
            <span className="dso-switch-handle" />
          </button>
        </div>

        <div className="dso-toggle-card">
          <div>
            <div className="dso-toggle-label">Auto-Failover</div>
            <div className="dso-toggle-hint">Switch endpoint on rate limits (429), timeouts, or server errors</div>
          </div>
          <button
            type="button"
            className="dso-switch"
            role="switch"
            aria-checked={draft.failover}
            disabled={!writable}
            onClick={() => update('failover', !draft.failover)}
          >
            <span className="dso-switch-handle" />
          </button>
        </div>
      </div>

      <div className="dso-group">
        <span className="dso-group-title">Routing Strategy</span>
        <div className="dso-segmented">
          {(['round-robin', 'random', 'weighted'] as const).map((strat) => (
            <button
              key={strat}
              type="button"
              className={draft.strategy === strat ? 'active' : ''}
              disabled={!writable}
              onClick={() => update('strategy', strat)}
            >
              {strat === 'round-robin' ? 'Round-Robin' : strat === 'random' ? 'Random' : 'Weighted'}
            </button>
          ))}
        </div>
      </div>

      <div className="dso-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="dso-group-title">Configured Endpoints Pool</span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)' }}>
            {activeEndpoints.length} in rotation / {(draft.endpoints || []).length} total
          </span>
        </div>

        <div className="dso-table-wrap">
          <table className="dso-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>Active</th>
                <th>Provider ID</th>
                <th>Model</th>
                {draft.strategy === 'weighted' && <th style={{ width: 70 }}>Weight</th>}
                <th style={{ width: 60 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {(draft.endpoints || []).length === 0 ? (
                <tr>
                  <td colSpan={draft.strategy === 'weighted' ? 5 : 4} style={{ textAlign: 'center', color: '#999', padding: '16px 0' }}>
                    No endpoints configured. Subagents will use default parent session model.
                  </td>
                </tr>
              ) : (
                (draft.endpoints || []).map((ep, idx) => (
                  <tr key={`${ep.provider}-${ep.model}-${idx}`} style={{ opacity: ep.enabled === false ? 0.5 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={ep.enabled !== false}
                        disabled={!writable}
                        onChange={() => toggleEndpoint(idx)}
                      />
                    </td>
                    <td><strong>{ep.provider}</strong></td>
                    <td><code>{ep.model}</code></td>
                    {draft.strategy === 'weighted' && (
                      <td>
                        <input
                          type="number"
                          className="dso-input"
                          style={{ width: 50 }}
                          min={1}
                          max={100}
                          value={ep.weight || 1}
                          disabled={!writable}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 1;
                            setDraft((d) => {
                              const endpoints = [...(d.endpoints || [])];
                              if (endpoints[idx]) endpoints[idx] = { ...endpoints[idx], weight: val };
                              return { ...d, endpoints };
                            });
                          }}
                        />
                      </td>
                    )}
                    <td>
                      {endpointTest && (
                        <button
                          type="button"
                          className="dso-test-btn"
                          disabled={testing && testRow !== idx}
                          onClick={() => (testRow === idx ? closeTest() : openTest(idx))}
                        >
                          {testRow === idx ? 'Close' : 'Test'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="dso-btn-danger"
                        disabled={!writable}
                        onClick={() => removeEndpoint(idx)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {testRow !== null && endpointTest && (
            <div className="dso-test-panel">
              <div className="dso-test-line">
                <span className="dso-test-label">Base URL</span>
                <input
                  type="text"
                  className="dso-test-input"
                  placeholder="https://…/v1  (prefilled from the provider's stored profile when present)"
                  value={testURL}
                  disabled={testing}
                  onChange={(e) => setTestURL(e.target.value)}
                />
              </div>
              <div className="dso-test-line">
                <span className="dso-test-label">API key</span>
                <input
                  type="password"
                  className="dso-test-input"
                  placeholder="leave empty to use the stored key for this provider"
                  value={testKey}
                  disabled={testing}
                  onChange={(e) => setTestKey(e.target.value)}
                />
                <button
                  type="button"
                  className="dso-btn dso-btn-primary"
                  style={{ padding: '3px 12px', fontSize: 12 }}
                  disabled={testing}
                  onClick={runTest}
                >
                  {testing ? 'Probing…' : 'Run Probe'}
                </button>
              </div>
              <div>{renderTestResult()}</div>
            </div>
          )}

          {writable && (
            <div className="dso-add-row">
              <input
                type="text"
                className="dso-input"
                placeholder="Provider ID (e.g. b-ai-1)"
                style={{ flex: 1 }}
                value={newProv}
                onChange={(e) => setNewProv(e.target.value)}
              />
              <input
                type="text"
                className="dso-input"
                placeholder="Model (e.g. glm-5.3-flash)"
                style={{ flex: 1 }}
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
              />
              {draft.strategy === 'weighted' && (
                <input
                  type="number"
                  className="dso-input"
                  placeholder="Weight"
                  style={{ width: 60 }}
                  min={1}
                  max={100}
                  value={newWeight}
                  onChange={(e) => setNewWeight(Number(e.target.value) || 1)}
                />
              )}
              <button
                type="button"
                className="dso-btn dso-btn-secondary"
                disabled={!newProv.trim() || !newModel.trim()}
                onClick={addEndpoint}
              >
                + Add
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 4 }}>
        <button
          type="button"
          style={{ background: 'none', border: 'none', color: 'var(--dsw-alias-brand-primary, #0969da)', cursor: 'pointer', fontSize: 12, padding: 0 }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? '▲ Hide Advanced Circuit Breaker Settings' : '▼ Show Advanced Circuit Breaker Settings'}
        </button>

        {showAdvanced && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Trip Threshold (Failures)</label>
              <input
                type="number"
                className="dso-input"
                style={{ width: '100%' }}
                min={1}
                max={20}
                value={draft.maxFailures || 3}
                disabled={!writable}
                onChange={(e) => update('maxFailures', Number(e.target.value) || 3)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Cooldown Duration (ms)</label>
              <input
                type="number"
                className="dso-input"
                style={{ width: '100%' }}
                min={1000}
                step={5000}
                value={draft.cooldownMs || 60000}
                disabled={!writable}
                onChange={(e) => update('cooldownMs', Number(e.target.value) || 60000)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Retry Pacing Min (ms)</label>
              <input
                type="number"
                className="dso-input"
                style={{ width: '100%' }}
                min={500}
                step={500}
                value={draft.intervalMinMs || 3000}
                disabled={!writable}
                onChange={(e) => update('intervalMinMs', Number(e.target.value) || 3000)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Retry Pacing Max (ms)</label>
              <input
                type="number"
                className="dso-input"
                style={{ width: '100%' }}
                min={1000}
                step={500}
                value={draft.intervalMaxMs || 5000}
                disabled={!writable}
                onChange={(e) => update('intervalMaxMs', Number(e.target.value) || 5000)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="dso-actions">
        {dirty && <span className="dso-dirty-tag">● Unsaved Changes</span>}
        {saveState === 'ok' && <span className="dso-status-tag dso-status-ok">Saved Successfully ✓</span>}
        {saveState === 'fail' && <span className="dso-status-tag dso-status-fail">Save Failed ✗</span>}

        {dirty && saveState !== 'saving' && (
          <button type="button" className="dso-btn dso-btn-secondary" onClick={revert}>
            Discard
          </button>
        )}

        <button
          type="button"
          className="dso-btn dso-btn-primary"
          disabled={!writable || !dirty || saveState === 'saving'}
          onClick={save}
        >
          {saveState === 'saving' ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

export function apply(ctx: any) {
  ensureCss();
  const scope = ctx.settingsScope.bind({ namespace: NS });
  const useScope = bindSnapshotSelector(scope);
  const endpointTest = bindEndpointTest(ctx);
  ctx.slots.inject('settings.section', () => {
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'subagents-orchestrator',
        order: 22,
        label: () => 'Subagents Orchestrator',
        inject: () => ({ useScope, scope, endpointTest })
      },
      SubagentsOrchestratorSection
    );
  }, PLUGIN_ID + ': settings section');
}

export const inject = ['slots', 'settingsScope'];
