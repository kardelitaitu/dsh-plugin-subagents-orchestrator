import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseConfigFile,
  extractEndpoints,
  initWatcher,
  disposeWatcher,
  getConfig,
  getCachedEndpoints,
  setConfigForTest
} from '../src/config.js';

describe('Config & Watcher Engine', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-test-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return null if file does not exist', () => {
    const config = parseConfigFile(path.join(testDir, 'nonexistent.yaml'));
    expect(config).toBeNull();
  });

  it('should parse valid yaml configuration', () => {
    const content = `
subagents-orchestrator:
  enabled: true
  strategy: round-robin
  failover: true
  endpoints:
    - provider: p1
      model: m1
    - provider: p2
      model: m2
`;
    fs.writeFileSync(testFile, content, 'utf8');
    const config = parseConfigFile(testFile);
    expect(config).not.toBeNull();
    expect(config?.enabled).toBe(true);
    expect(config?.strategy).toBe('round-robin');
    expect(config?.endpoints).toHaveLength(2);
  });

  it('should extract only valid endpoints', () => {
    const endpoints = extractEndpoints({
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: '' } as any,
        { provider: '', model: 'm3' } as any,
        null as any
      ]
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('should provide zero-latency in-memory config and update on file change', async () => {
    const initialContent = `
subagents-orchestrator:
  enabled: true
  strategy: round-robin
  endpoints:
    - provider: p1
      model: m1
`;
    fs.writeFileSync(testFile, initialContent, 'utf8');
    initWatcher(testFile);

    expect(getConfig()?.strategy).toBe('round-robin');
    expect(getCachedEndpoints()).toHaveLength(1);

    // Update file
    const updatedContent = `
subagents-orchestrator:
  enabled: true
  strategy: random
  endpoints:
    - provider: p1
      model: m1
    - provider: p2
      model: m2
`;
    fs.writeFileSync(testFile, updatedContent, 'utf8');

    // Wait for debounced watcher (150ms)
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(getConfig()?.strategy).toBe('random');
    expect(getCachedEndpoints()).toHaveLength(2);
  });
});
