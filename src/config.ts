import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load } from 'js-yaml';
import type { OrchestratorConfig, Endpoint, RoutingStrategy } from './types.js';

export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.dsh', 'settings.yaml');

/**
 * fs.watch emits a burst of events per user save (change + rename, editor
 * temp files, ...). Events hitting the watcher are coalesced and a single
 * reload is scheduled once the window of quiet time has elapsed.
 */
export const WATCH_DEBOUNCE_MS = 100;

/** Routing strategy values accepted by the schema; anything else is dropped. */
const VALID_STRATEGIES: readonly string[] = ['round-robin', 'random', 'weighted'];

let cachedConfig: OrchestratorConfig | null = null;
let cachedEndpoints: Endpoint[] = [];
let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let activeFilePath: string = DEFAULT_SETTINGS_PATH;

/**
 * Zero-disk-I/O guard. Once true, getConfig()/getCachedEndpoints() are pure
 * memory reads — the disk is only ever touched by reloadConfig(), i.e. by the
 * debounced fs.watch callback or an explicit initWatcher()/reloadConfig().
 * The flag is set even when the file is missing, so an absent settings file
 * never turns every config read into a repeated disk probe.
 */
let hasLoadedFromDisk = false;

let isCustomTestConfig = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Schema-parse a single endpoint entry. Entries without a non-empty
 * string provider/model pair are rejected; unknown keys are dropped.
 */
function parseEndpoint(raw: unknown): Endpoint | null {
  if (!isPlainObject(raw)) return null;

  const provider = raw['provider'];
  if (typeof provider !== 'string' || provider.length === 0) return null;
  const model = raw['model'];
  if (typeof model !== 'string' || model.length === 0) return null;

  const endpoint: Endpoint = { provider, model };

  const reasoningEffort = raw['reasoningEffort'];
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
    endpoint.reasoningEffort = reasoningEffort;
  }

  const weight = raw['weight'];
  if (isFiniteNumber(weight) && weight > 0) {
    endpoint.weight = weight;
  }

  if (typeof raw['enabled'] === 'boolean') {
    endpoint.enabled = raw['enabled'];
  }

  return endpoint;
}

/**
 * Schema-parse a raw YAML document into an {@link OrchestratorConfig}.
 *
 * Whatever comes back is guaranteed to be runtime-safe:
 * - only the documented `subagents-orchestrator` fields survive,
 * - every field has the documented type (wrong-typed fields are dropped,
 *   never coerced),
 * - `strategy` is one of the known enum values,
 * - endpoint entries without a non-empty provider/model pair are filtered out.
 *
 * Returns `null` when the document carries no usable
 * `subagents-orchestrator` section.
 */
export function parseConfigDocument(doc: unknown): OrchestratorConfig | null {
  if (!isPlainObject(doc)) return null;

  const section = doc['subagents-orchestrator'];
  if (!isPlainObject(section)) return null;

  const config: OrchestratorConfig = {};

  if (typeof section['enabled'] === 'boolean') config.enabled = section['enabled'];
  if (typeof section['failover'] === 'boolean') config.failover = section['failover'];

  const strategy = section['strategy'];
  if (typeof strategy === 'string' && VALID_STRATEGIES.includes(strategy)) {
    config.strategy = strategy as RoutingStrategy;
  }

  // Range clamping (max(1, ...), max(0, ...)) stays the runtime's job
  // (health.ts); the schema only enforces types.
  if (isFiniteNumber(section['cooldownMs'])) config.cooldownMs = section['cooldownMs'];
  if (isFiniteNumber(section['maxFailures'])) config.maxFailures = section['maxFailures'];
  if (isFiniteNumber(section['intervalMinMs'])) config.intervalMinMs = section['intervalMinMs'];
  if (isFiniteNumber(section['intervalMaxMs'])) config.intervalMaxMs = section['intervalMaxMs'];
  if (isFiniteNumber(section['maxRetries'])) config.maxRetries = section['maxRetries'];
  if (typeof section['debug'] === 'boolean') config.debug = section['debug'];

  if (Array.isArray(section['endpoints'])) {
    const endpoints = (section['endpoints'] as unknown[])
      .map(parseEndpoint)
      .filter((endpoint): endpoint is Endpoint => endpoint !== null);
    if (endpoints.length > 0) config.endpoints = endpoints;
  }

  return config;
}

export function parseConfigFile(filePath: string): OrchestratorConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return parseConfigDocument(load(content));
  } catch {
    // Missing file, unreadable file, or malformed YAML all degrade to "no config".
    return null;
  }
}

export function extractEndpoints(config: OrchestratorConfig | null): Endpoint[] {
  if (config && Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    // `enabled: false` marks an endpoint as parked: it stays in the config for
    // bookkeeping but is excluded from the effective pool everywhere (routing,
    // failover candidates, telemetry attribution).
    return config.endpoints.filter((e): e is Endpoint => Boolean(e && e.provider && e.model && e.enabled !== false));
  }
  return [];
}

export function reloadConfig(): void {
  if (isCustomTestConfig) return;
  const parsed = parseConfigFile(activeFilePath);

  // Snapshot retention: when the settings file cannot be read *and* its
  // directory is gone, the fs.watch handle is dead too — nothing would ever
  // re-arm the watcher or refresh this cache until the host restarts, so
  // degrading to "no config" would silently disable orchestration forever.
  // Keep serving the last known good snapshot in that case. A deleted file
  // in a living directory is handled normally (clears the cache).
  if (parsed === null && cachedConfig !== null && !fs.existsSync(path.dirname(activeFilePath))) {
    hasLoadedFromDisk = true;
    return;
  }

  cachedConfig = parsed;
  cachedEndpoints = extractEndpoints(cachedConfig);
  hasLoadedFromDisk = true;
}

/**
 * Lazy first read only. Once anything has been loaded from disk, every
 * getter below is a pure memory read; freshness is delivered exclusively
 * by the debounced fs.watch callback.
 */
function ensureLoaded(): void {
  if (!hasLoadedFromDisk && !watcher) reloadConfig();
}

export function getConfig(): OrchestratorConfig | null {
  ensureLoaded();
  return cachedConfig;
}

export function getCachedEndpoints(): Endpoint[] {
  ensureLoaded();
  return cachedEndpoints;
}

/** Coalesce watcher event bursts into a single reload per debounce window. */
function scheduleReload(): void {
  if (isCustomTestConfig) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reloadConfig();
  }, WATCH_DEBOUNCE_MS);
  // A pending debounce tick must never keep the host process alive on its own.
  debounceTimer.unref();
}

export function initWatcher(filePath: string = DEFAULT_SETTINGS_PATH): void {
  disposeWatcher();
  if (isCustomTestConfig) {
    // Test-injected state owns the cache: never read the settings file and
    // never watch the developer's real ~/.dsh directory from a test.
    return;
  }
  activeFilePath = filePath;
  reloadConfig();

  const targetDir = path.dirname(filePath);
  const targetBase = path.basename(filePath);

  try {
    if (!fs.existsSync(targetDir)) return;
    const dirWatcher = fs.watch(targetDir, (eventType, filename) => {
      // `filename` can be null on some platforms; treat that as a match and
      // let the cheap debounced reload decide. Unrelated files are ignored.
      if (!filename || filename === targetBase) scheduleReload();
    });
    dirWatcher.on('error', () => {
      // Watching can fail after the fact (e.g. the directory is removed on
      // Windows). Keep serving the last cached snapshot instead of crashing.
      if (watcher === dirWatcher) watcher = null;
    });
    watcher = dirWatcher;
  } catch {
    // Watch failure must not crash the plugin: fall back to the initial cached read.
    watcher = null;
  }
}

export function disposeWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

export function setConfigForTest(config: OrchestratorConfig | null): void {
  // Any injected state — including null — owns the cache until reset:
  // reloadConfig()/initWatcher() must never clobber it from disk (that would
  // silently read the developer's real ~/.dsh/settings.yaml into a test,
  // e.g. via apply() -> initWatcher() right after setConfigForTest(null)).
  isCustomTestConfig = true;
  cachedConfig = config;
  cachedEndpoints = extractEndpoints(config);
  hasLoadedFromDisk = true;
}

/**
 * Wipe all module state back to pristine pre-init condition, optionally
 * pointing the (not yet performed) first disk load at a specific file.
 * Call this between tests that exercise the cache so they stay isolated.
 */
export function resetConfigForTest(filePath: string = DEFAULT_SETTINGS_PATH): void {
  disposeWatcher();
  activeFilePath = filePath;
  cachedConfig = null;
  cachedEndpoints = [];
  hasLoadedFromDisk = false;
  isCustomTestConfig = false;
}
