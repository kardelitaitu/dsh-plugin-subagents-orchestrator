import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load } from 'js-yaml';
import type { OrchestratorConfig, Endpoint } from './types.js';

export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.dsh', 'settings.yaml');

let cachedConfig: OrchestratorConfig | null = null;
let cachedEndpoints: Endpoint[] = [];
let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let activeFilePath: string = DEFAULT_SETTINGS_PATH;

let isCustomTestConfig = false;

export function parseConfigFile(filePath: string): OrchestratorConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const doc = (load(content) || {}) as Record<string, unknown>;
    return (doc['subagents-orchestrator'] as OrchestratorConfig) || null;
  } catch {
    return null;
  }
}

export function extractEndpoints(config: OrchestratorConfig | null): Endpoint[] {
  if (config && Array.isArray(config.endpoints) && config.endpoints.length > 0) {
    return config.endpoints.filter((e): e is Endpoint => Boolean(e && e.provider && e.model));
  }
  return [];
}

export function reloadConfig(): void {
  if (isCustomTestConfig) return;
  cachedConfig = parseConfigFile(activeFilePath);
  cachedEndpoints = extractEndpoints(cachedConfig);
}

export function getConfig(): OrchestratorConfig | null {
  if (cachedConfig === null && !watcher) {
    reloadConfig();
  }
  return cachedConfig;
}

export function getCachedEndpoints(): Endpoint[] {
  if (cachedConfig === null && !watcher) {
    reloadConfig();
  }
  return cachedEndpoints;
}

export function initWatcher(filePath: string = DEFAULT_SETTINGS_PATH): void {
  disposeWatcher();
  activeFilePath = filePath;
  reloadConfig();

  const targetDir = path.dirname(filePath);
  const targetBase = path.basename(filePath);

  try {
    if (fs.existsSync(targetDir)) {
      watcher = fs.watch(targetDir, (eventType, filename) => {
        if (!filename || filename === targetBase) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            reloadConfig();
          }, 100);
        }
      });
    }
  } catch {
    // Watch failure shouldn't crash the plugin, fallback to initial cached read
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
  isCustomTestConfig = config !== null;
  cachedConfig = config;
  cachedEndpoints = extractEndpoints(config);
}
