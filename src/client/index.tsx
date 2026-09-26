import React, { useState, useCallback, useSyncExternalStore, useEffect, useRef } from 'react';
import { bindEndpointTest } from './testConnection.js';

export const NS = 'subagents-orchestrator';
export const PLUGIN_ID = 'dsh-plugin-subagents-orchestrator';
export const CSS_TAG = PLUGIN_ID + '/client.css';

export interface EndpointRow {
  provider: string;
  model: string;
  reasoningEffort?: string;
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
  alignHourly?: boolean;
  quarantines?: Record<string, number>;
  debug?: boolean;
  persistTelemetry?: boolean;
}

const STRATEGIES = ['round-robin', 'random', 'weighted'] as const;
const MODES = ['pool', 'fallback'] as const;

const DEFAULTS: ClientConfig = {
  enabled: true,
  strategy: 'round-robin',
  failover: true,
  mode: 'pool',
  endpoints: [],
  fallback: [],
  cooldownMs: 3600000,
  maxFailures: 3,
  intervalMinMs: 3000,
  intervalMaxMs: 5000,
  alignHourly: true,
  quarantines: {},
  debug: false,
  persistTelemetry: false
};

/**
 * Format tripping duration into human-readable text.
 * When <= 60 minutes: e.g. "45m", "60m"
 * When > 60 minutes: parsed to 'xh xm' (e.g. "1h 15m", "21h 40m", or "2h" if mins === 0).
 */
export function formatTrippingDuration(remainingMin: number): string {
  if (remainingMin <= 0) return '0m';
  if (remainingMin <= 60) return `${remainingMin}m`;
  const hours = Math.floor(remainingMin / 60);
  const mins = remainingMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

const CSS = `
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

export function projectConfig(value: any): ClientConfig {
  // Fresh containers: a shallow spread of DEFAULTS would hand every caller the
  // same mutable `quarantines`/`endpoints` objects, so one panel's edit leaked
  // into the next projection.
  if (!value || typeof value !== 'object') {
    return { ...DEFAULTS, endpoints: [], fallback: [], quarantines: {} };
  }
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
    // Whitelisted, not merely truthy: an unknown strategy/mode would otherwise
    // project straight into the typed config (no segmented button active, and
    // re-persisted on the next Save). config.ts already rejects these values.
    strategy: (STRATEGIES as readonly string[]).includes(value.strategy) ? value.strategy : DEFAULTS.strategy,
    failover: typeof value.failover === 'boolean' ? value.failover : DEFAULTS.failover,
    mode: (MODES as readonly string[]).includes(value.mode) ? value.mode : DEFAULTS.mode,
    // Fresh arrays AND fresh row objects: the projection must not alias the raw
    // snapshot, or a later in-place edit would write through to the host state.
    endpoints: Array.isArray(value.endpoints) ? value.endpoints.map((row: any) => ({ ...row })) : [],
    fallback: Array.isArray(value.fallback) ? value.fallback.map((row: any) => ({ ...row })) : [],
    cooldownMs: typeof value.cooldownMs === 'number' ? value.cooldownMs : DEFAULTS.cooldownMs,
    maxFailures: typeof value.maxFailures === 'number' ? value.maxFailures : DEFAULTS.maxFailures,
    intervalMinMs: typeof value.intervalMinMs === 'number' ? value.intervalMinMs : DEFAULTS.intervalMinMs,
    intervalMaxMs: typeof value.intervalMaxMs === 'number' ? value.intervalMaxMs : DEFAULTS.intervalMaxMs,
    alignHourly: typeof value.alignHourly === 'boolean' ? value.alignHourly : DEFAULTS.alignHourly,
    quarantines: value.quarantines && typeof value.quarantines === 'object' ? { ...value.quarantines } : {},
    debug: typeof value.debug === 'boolean' ? value.debug : DEFAULTS.debug,
    persistTelemetry: typeof value.persistTelemetry === 'boolean' ? value.persistTelemetry : DEFAULTS.persistTelemetry
  };
}

/**
 * The ordered [key, value] writes `save()` would submit: every draft field whose
 * JSON projection differs from `current`. Extracted so the panel's write set is
 * testable without a DOM.
 */
export function planConfigWrites(
  draft: ClientConfig,
  current: ClientConfig
): Array<[keyof ClientConfig, any]> {
  const writes: Array<[keyof ClientConfig, any]> = [];
  for (const [key, value] of Object.entries(draft)) {
    // `quarantines` is written exclusively by the immediate Reset path
    // (scope.set), never through draft+Save. The sync effect deliberately does
    // not hydrate it into the draft, so including it here would write the
    // draft's empty/partial map over the host's live quarantine set and wipe
    // every endpoint's cooldown on the next Save.
    if (key === 'quarantines') continue;
    if (JSON.stringify(current[key as keyof ClientConfig]) !== JSON.stringify(value)) {
      writes.push([key as keyof ClientConfig, value]);
    }
  }
  return writes;
}

/** The draft fields the Save flow owns (everything except host-owned quarantines). */
function configForDirtyCheck(config: ClientConfig): Omit<ClientConfig, 'quarantines'> {
  const { quarantines: _ignored, ...rest } = config;
  return rest;
}

/** True when the draft diverges from the snapshot projection on a Save-owned field. */
export function isConfigDirty(draft: ClientConfig, current: ClientConfig): boolean {
  return JSON.stringify(configForDirtyCheck(draft)) !== JSON.stringify(configForDirtyCheck(current));
}

/**
 * The quarantine expiry timestamp applying to `endpoint`, if any.
 *
 * Lookup order per source: `provider::model` (the runtime's key shape), then
 * `provider:model`, then bare `provider`; the draft's map wins over the
 * snapshot's.
 */
export function endpointQuarantineUntil(
  endpoint: EndpointRow,
  draftQuarantines: Record<string, number> | undefined,
  currentQuarantines: Record<string, number> | undefined,
  suppressedKeys?: ReadonlySet<string>
): number | undefined {
  const draft = draftQuarantines || {};
  const current = currentQuarantines || {};
  const keys = [
    `${endpoint.provider}::${endpoint.model}`,
    `${endpoint.provider}:${endpoint.model}`,
    endpoint.provider
  ];
  // A key the user just cleared is skipped in BOTH maps: the draft already
  // dropped it, and the snapshot still carries it until the write lands, so the
  // fall-through would otherwise re-show Tripped and the Reset would look
  // broken for the whole RPC (and forever if the write is rejected).
  for (const key of keys) {
    if (suppressedKeys?.has(key)) continue;
    const at = draft[key];
    if (at !== undefined && at !== null) return typeof at === 'number' ? at : undefined;
  }
  for (const key of keys) {
    if (suppressedKeys?.has(key)) continue;
    const at = current[key];
    if (at !== undefined && at !== null) return typeof at === 'number' ? at : undefined;
  }
  return undefined;
}

/** Whether `endpoint` is currently in cooldown. */
export function isEndpointTripped(
  endpoint: EndpointRow,
  draftQuarantines: Record<string, number> | undefined,
  currentQuarantines: Record<string, number> | undefined,
  now: number,
  suppressedKeys?: ReadonlySet<string>
): boolean {
  const at = endpointQuarantineUntil(endpoint, draftQuarantines, currentQuarantines, suppressedKeys);
  return typeof at === 'number' && at > now;
}

/**
 * The subset of locally-cleared keys that are still pending.
 *
 * A clear is remembered WITH the snapshot value it cleared. It stays suppressed
 * only while the snapshot still carries that exact value: once the write lands
 * (key gone) or the host re-trips the endpoint with a newer timestamp, the key
 * is live again and must not be hidden by a later, unrelated reset.
 */
export function activeClearedQuarantineKeys(
  cleared: Map<string, number | undefined>,
  currentQuarantines: Record<string, number> | undefined
): Set<string> {
  const current = currentQuarantines || {};
  const active = new Set<string>();
  for (const [key, clearedValue] of cleared) {
    if (clearedValue !== undefined && current[key] === clearedValue) active.add(key);
  }
  return active;
}

/**
 * The quarantine map to persist after resetting one endpoint: the snapshot's
 * entries (freshest expiry wins), minus the target's every key shape, minus the
 * keys this session already cleared.
 */
/**
 * Drop clear-memory entries whose intent is already fulfilled.
 *
 * An entry is pending only while the snapshot still carries the exact value the
 * clear removed. Once the snapshot no longer matches - the write landed, or the
 * host re-tripped the endpoint with a different expiry - the entry MUST be
 * removed, not merely filtered: a stale entry re-arms itself the moment the
 * host re-trips the endpoint with a value equal to the cleared one (which
 * alignHourly makes likely inside the same hour), and an unrelated reset would
 * then silently clear that live quarantine.
 */
export function pruneClearedQuarantineKeys(
  cleared: Map<string, number | undefined>,
  currentQuarantines: Record<string, number> | undefined
): Map<string, number | undefined> {
  const current = currentQuarantines || {};
  const next = new Map<string, number | undefined>();
  for (const [key, clearedValue] of cleared) {
    if (clearedValue !== undefined && current[key] === clearedValue) next.set(key, clearedValue);
  }
  return next;
}

/**
 * Drop draft quarantine entries the snapshot no longer carries.
 *
 * The draft is never hydrated with quarantines, so a key it holds from an
 * earlier reset would otherwise outlive a HOST-side clear (another surface, or
 * a host API): the draft-first display lookup keeps showing Tripped forever.
 * Only removals are reconciled - a snapshot entry is never added back, or a
 * pending clear would be resurrected.
 */
export function reconcileDraftQuarantines(
  draftQuarantines: Record<string, number> | undefined,
  currentQuarantines: Record<string, number> | undefined
): Record<string, number> {
  const current = currentQuarantines || {};
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(draftQuarantines || {})) {
    if (key in current) next[key] = value;
  }
  return next;
}

export function quarantinesAfterReset(
  draftQuarantines: Record<string, number> | undefined,
  currentQuarantines: Record<string, number> | undefined,
  provider: string,
  model: string,
  locallyClearedKeys: readonly string[] = []
): Record<string, number> {
  // The draft is NOT hydrated with quarantines (the sync effect excludes the
  // field), so the snapshot's entries are merged in first - writing the draft
  // map alone dropped every OTHER endpoint's quarantine. The snapshot is
  // authoritative for those entries (it carries the freshest expiry), except
  // for keys the user already reset in this session: a lagging snapshot would
  // otherwise re-add the trip the user just cleared.
  const cleared = new Set<string>(locallyClearedKeys);
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(draftQuarantines || {})) {
    if (!cleared.has(key)) next[key] = value;
  }
  // The snapshot wins for keys both sides carry: the draft is only ever edited
  // by removals, so the host's timestamp is the fresher one.
  for (const [key, value] of Object.entries(currentQuarantines || {})) {
    if (!cleared.has(key)) next[key] = value;
  }
  for (const key of [`${provider}::${model}`, `${provider}:${model}`, provider]) {
    delete next[key];
  }
  return next;
}

/**
 * Set one endpoint row's weight from a raw input value.
 *
 * Shares `normalizeWeight` with the add row so both editors enforce the same
 * floor; the inline `Number(raw) || 1` it replaced let a typed negative or a
 * non-finite value through.
 */
export function updateEndpointWeightAt(
  endpoints: EndpointRow[],
  index: number,
  rawWeight: unknown
): EndpointRow[] {
  const next = [...endpoints];
  if (next[index]) next[index] = { ...next[index], weight: normalizeWeight(rawWeight) };
  return next;
}

/** Flip one endpoint's enabled flag; out-of-range indexes are left untouched. */
export function toggleEndpointAt(endpoints: EndpointRow[], index: number): EndpointRow[] {
  const next = [...endpoints];
  if (next[index]) {
    next[index] = { ...next[index], enabled: next[index].enabled === false ? true : false };
  }
  return next;
}

/** Remove one endpoint by index. */
export function removeEndpointAt(endpoints: EndpointRow[], index: number): EndpointRow[] {
  return endpoints.filter((_, i) => i !== index);
}

/** Coerce a raw weight input to a finite number >= 1 (the UI's declared floor). */
export function normalizeWeight(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Build a new endpoint row, or null when provider/model are blank. */
export function buildEndpointRow(
  provider: string,
  model: string,
  reasoningEffort: string,
  weight: number
): EndpointRow | null {
  if (!provider.trim() || !model.trim()) return null;
  return {
    provider: provider.trim(),
    model: model.trim(),
    ...(reasoningEffort.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
    // The panel's weight inputs declare min=1; `Number(x) || 1` only catches
    // 0/NaN, so a typed negative or a non-finite value would be stored as-is.
    weight: normalizeWeight(weight),
    enabled: true
  };
}

/**
 * Adopt snapshot fields into the draft without discarding unsaved edits.
 *
 * `prevSnap` is the projection the draft was last reconciled against. A field
 * whose draft value diverges from it is a pending user edit and is kept; every
 * other field takes the incoming snapshot value. `quarantines` is never
 * adopted (Reset owns that field through the immediate side-effecting path).
 */
export function mergeSnapshotIntoDraft(
  prev: ClientConfig,
  prevSnap: ClientConfig | undefined,
  next: ClientConfig
): ClientConfig {
  const merged: ClientConfig = { ...prev };
  for (const key of Object.keys(next) as Array<keyof ClientConfig>) {
    if (key === 'quarantines') continue;
    const draftJSON = JSON.stringify(prev[key]);
    const pendingEdit = prevSnap !== undefined && draftJSON !== JSON.stringify(prevSnap[key]);
    if (pendingEdit) continue;
    (merged as any)[key] = next[key];
  }
  return merged;
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
  const [newReasoningEffort, setNewReasoningEffort] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The projection the draft was last reconciled against, so the sync effect
  // can tell a pending user edit from a snapshot change.
  const lastSnapValue = useRef<any>(undefined);
  // Quarantine keys this session has reset, remembered with the snapshot value
  // they cleared. The draft is never hydrated with quarantines, so a reset has
  // to rebuild the map from the snapshot; without this memory a LAGGING
  // snapshot would re-add the trip the user just cleared.
  const clearedQuarantineKeys = useRef<Map<string, number | undefined>>(new Map());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  const refreshHealth = () => {
    setRefreshing(true);
    // Display-only refresh: the health badges derive from `current` and
    // `draft` for the current render, and bumping `now` re-evaluates them.
    // Writing the snapshot's quarantines into the draft here would resurrect a
    // trip the user had just reset (the snapshot lags the Reset write).
    setNow(Date.now());
    setTimeout(() => setRefreshing(false), 500);
  };

  const resetAllHealth = async () => {
    // Everything the snapshot currently carries is being cleared, so it must
    // stay suppressed until the write lands.
    for (const [key, value] of Object.entries(current.quarantines || {})) clearedQuarantineKeys.current.set(key, value);
    update('quarantines', {});
    if (scope?.set) {
      try {
        await scope.set('quarantines', {});
      } catch {}
    }
  };

  // Sync draft when snap first arrives.
  //
  // `quarantines` is deliberately excluded: it is the one field the panel
  // mutates through an immediate side-effecting Reset rather than through the
  // draft+Save flow. Spread-inducing it here let a snapshot that still carried
  // the pre-reset trip be merged back into the draft, so the next Save
  // re-persisted the trip the user had just cleared. Display reads it from
  // `current`/`draft` directly, and Reset writes it explicitly.
  useEffect(() => {
    if (snap?.value) {
      const nextSnap = projectConfig(snap.value);
      // A revision bump is exactly when a Reset write lands, so this is where
      // fulfilled clear-memory entries are forgotten.
      clearedQuarantineKeys.current = pruneClearedQuarantineKeys(
        clearedQuarantineKeys.current,
        nextSnap.quarantines
      );
      const prevSnap = lastSnapValue.current;
      lastSnapValue.current = nextSnap;
      setDraft((prev) => {
        const merged = mergeSnapshotIntoDraft(prev, prevSnap, nextSnap);
        // Host-side clears must reach the draft: the draft-first display lookup
        // would otherwise show a quarantined row forever after another surface
        // cleared it. Removals only - never add a snapshot entry back.
        return { ...merged, quarantines: reconcileDraftQuarantines(prev.quarantines, nextSnap.quarantines) };
      });
    }
  }, [snap?.revision, ready]);

  const dirty = isConfigDirty(draft, current);

  const update = (field: keyof ClientConfig, value: any) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const toggleEndpoint = (index: number) => {
    setDraft((d) => ({ ...d, endpoints: toggleEndpointAt(d.endpoints || [], index) }));
  };

  const removeEndpoint = (index: number) => {
    setDraft((d) => ({ ...d, endpoints: removeEndpointAt(d.endpoints || [], index) }));
  };

  const resetEndpointHealth = async (provider: string, model: string) => {
    const cleared = pruneClearedQuarantineKeys(clearedQuarantineKeys.current, current.quarantines);
    clearedQuarantineKeys.current = cleared;
    const pending = activeClearedQuarantineKeys(cleared, current.quarantines);
    const nextQ = quarantinesAfterReset(draft.quarantines, current.quarantines, provider, model, [...pending]);
    // Remember what the snapshot held for this target so a LAGGING snapshot
    // does not re-add it before the write lands.
    for (const key of [`${provider}::${model}`, `${provider}:${model}`, provider]) {
      cleared.set(key, (current.quarantines || {})[key]);
    }
    update('quarantines', nextQ);
    if (scope?.set) {
      try {
        await scope.set('quarantines', nextQ);
      } catch {}
    }
  };

  const addEndpoint = () => {
    const item = buildEndpointRow(newProv, newModel, newReasoningEffort, newWeight);
    if (!item) return;
    setDraft((d) => ({
      ...d,
      endpoints: [
        ...(d.endpoints || []),
        item
      ]
    }));
    setNewProv('');
    setNewModel('');
    setNewReasoningEffort('');
    setNewWeight(1);
  };

  const save = useCallback(async () => {
    if (!scope) return;
    setSaveState('saving');
    try {
      for (const [key, value] of planConfigWrites(draft, current)) {
        await scope.set(key, value);
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

  // Keys the user just cleared whose write has not landed yet: the display
  // must treat them as healthy even though the snapshot still carries them.
  const suppressedQuarantineKeys = activeClearedQuarantineKeys(
    clearedQuarantineKeys.current,
    current.quarantines
  );

  const trippedCount = (draft.endpoints || []).filter((ep) =>
    isEndpointTripped(ep, draft.quarantines, current.quarantines, now, suppressedQuarantineKeys)
  ).length;

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="dso-group-title">Configured Endpoints Pool</span>
            <button
              type="button"
              className={`dso-refresh-health-btn ${refreshing ? 'spinning' : ''}`}
              title="Refresh health status from host"
              disabled={refreshing}
              onClick={refreshHealth}
            >
              <i>↻</i>
              {refreshing ? 'Refreshing…' : 'Refresh Health'}
            </button>
            {trippedCount > 0 && (
              <button
                type="button"
                className="dso-btn-danger"
                style={{ fontSize: 11, padding: '2px 8px', border: '1px solid currentColor', borderRadius: 4, textDecoration: 'none' }}
                title="Reset all tripped endpoints back to healthy immediately"
                disabled={!writable}
                onClick={resetAllHealth}
              >
                Reset All ({trippedCount})
              </button>
            )}
          </div>
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
                <th style={{ width: 85 }}>Reasoning</th>
                <th style={{ width: 125 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Health</span>
                    <button
                      type="button"
                      className={`dso-refresh-health-btn ${refreshing ? 'spinning' : ''}`}
                      style={{ padding: '1px 5px', fontSize: 11 }}
                      title="Refresh health status"
                      disabled={refreshing}
                      onClick={refreshHealth}
                    >
                      <i>↻</i>
                    </button>
                  </div>
                </th>
                {draft.strategy === 'weighted' && <th style={{ width: 70 }}>Weight</th>}
                <th style={{ width: 60 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {(draft.endpoints || []).length === 0 ? (
                <tr>
                  <td colSpan={draft.strategy === 'weighted' ? 7 : 6} style={{ textAlign: 'center', color: '#999', padding: '16px 0' }}>
                    No endpoints configured. Subagents will use default parent session model.
                  </td>
                </tr>
              ) : (
                (draft.endpoints || []).map((ep, idx) => {
                  const unquarantineAt = endpointQuarantineUntil(ep, draft.quarantines, current.quarantines, suppressedQuarantineKeys);
                  const isTripped = isEndpointTripped(ep, draft.quarantines, current.quarantines, now, suppressedQuarantineKeys);
                  const remainingMin =
                    isTripped && typeof unquarantineAt === 'number'
                      ? Math.max(1, Math.ceil((unquarantineAt - now) / 60000))
                      : 0;

                  return (
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
                      <td>
                        <select
                          className="dso-input"
                          style={{ width: 75, fontSize: 11, padding: '2px 4px' }}
                          value={ep.reasoningEffort === 'medium' ? 'med' : ep.reasoningEffort || ''}
                          disabled={!writable}
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            setDraft((d) => {
                              const endpoints = [...(d.endpoints || [])];
                              if (endpoints[idx]) {
                                const updated = { ...endpoints[idx] };
                                if (val) {
                                  updated.reasoningEffort = val === 'med' ? 'medium' : val;
                                } else {
                                  delete updated.reasoningEffort;
                                }
                                endpoints[idx] = updated;
                              }
                              return { ...d, endpoints };
                            });
                          }}
                        >
                          <option value="">default</option>
                          <option value="off">off</option>
                          <option value="low">low</option>
                          <option value="med">med</option>
                          <option value="high">high</option>
                          <option value="max">max</option>
                        </select>
                      </td>
                      <td>
                        {ep.enabled === false ? (
                          <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 }}>Disabled</span>
                        ) : isTripped ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span
                              className="dso-health-badge tripped"
                              title={`Cooling down until ${new Date(unquarantineAt!).toLocaleDateString() === new Date(now).toLocaleDateString() ? new Date(unquarantineAt!).toLocaleTimeString() : new Date(unquarantineAt!).toLocaleString()}`}
                            >
                              🔴 Tripped ({formatTrippingDuration(remainingMin)})
                            </span>
                            <button
                              type="button"
                              className="dso-reset-btn"
                              disabled={!writable}
                              title="Clear quarantine immediately"
                              onClick={() => resetEndpointHealth(ep.provider, ep.model)}
                            >
                              Reset
                            </button>
                          </span>
                        ) : (
                          <span className="dso-health-badge ok">🟢 Healthy</span>
                        )}
                      </td>
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
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              endpoints: updateEndpointWeightAt(d.endpoints || [], idx, e.target.value)
                            }))
                          }
                        />
                      </td>
                    )}
                    <td>
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
                );
              }))}
            </tbody>
          </table>

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
              <select
                className="dso-input"
                style={{ width: 85 }}
                value={newReasoningEffort === 'medium' ? 'med' : newReasoningEffort}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  setNewReasoningEffort(val === 'med' ? 'medium' : val);
                }}
                title="Reasoning Effort"
              >
                <option value="">default</option>
                <option value="off">off</option>
                <option value="low">low</option>
                <option value="med">med</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
              {draft.strategy === 'weighted' && (
                <input
                  type="number"
                  className="dso-input"
                  placeholder="Weight"
                  style={{ width: 60 }}
                  min={1}
                  max={100}
                  value={newWeight}
                  onChange={(e) => setNewWeight(normalizeWeight(e.target.value))}
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
                step={60000}
                value={draft.cooldownMs || 3600000}
                disabled={!writable}
                onChange={(e) => update('cooldownMs', Number(e.target.value) || 3600000)}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, gridColumn: '1 / -1', marginTop: 4 }}>
              <input
                type="checkbox"
                id="dso-align-hourly"
                checked={draft.alignHourly !== false}
                disabled={!writable}
                onChange={(e) => update('alignHourly', e.target.checked)}
              />
              <label htmlFor="dso-align-hourly" style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Align Cooldown to Next Clock Hour (:00 + 1m grace)
              </label>
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #777)' }}>
                Syncs cooldowns with upstream quota reset schedules (e.g. CodeBuddy hourly resets)
              </span>
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
