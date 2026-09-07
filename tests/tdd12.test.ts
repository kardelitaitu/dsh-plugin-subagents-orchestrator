import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, initWatcher, disposeWatcher, getConfig } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { recordRequest, resetTelemetry } from '../src/telemetry.js';
import { setPersistDirForTest } from '../src/persist.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 12: persistTelemetry opt-in lifecycle gate.
 *
 * Disk side effects require explicit consent: the default must never write,
 * the flag must be honored LIVE at dispose time (a flip after apply wins),
 * and an explicit false behaves like the default.
 */
describe('TDD round 12: persistTelemetry opt-in gate', () => {
  let ctx: MockCordisContext;
  let dir: string;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

  beforeEach(() => {
    ctx = new MockCordisContext();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tdd12-'));
    setPersistDirForTest(path.join(dir, 'telemetry'));
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    setPersistDirForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function populateBuffer(): void {
    const subagent = createMockAgent('tdd12-evt', 'subagent');
    recordRequest('tdd12-evt', { provider: 'p1', model: 'm1' });
    void subagent;
  }

  it('PROBE 1: default (no flag) - dispose leaves the persist dir untouched', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);
    populateBuffer();

    ctx.dispose();

    const root = path.join(dir, 'telemetry');
    expect(fs.existsSync(root)).toBe(false);
  });

  it('PROBE 2: persistTelemetry true - dispose drains events and snapshots endpoints exactly once', async () => {
    setConfigForTest({ ...baseConfig, persistTelemetry: true });
    apply(ctx);
    populateBuffer();

    ctx.dispose();

    const root = path.join(dir, 'telemetry');
    const jsonl = fs.readdirSync(root).filter((f) => f.endsWith('.jsonl'));
    expect(jsonl).toHaveLength(1);
    const lines = fs.readFileSync(path.join(root, jsonl[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ agentId: 'tdd12-evt', type: 'request' });
    expect(fs.existsSync(path.join(root, 'endpoints.json'))).toBe(true);

    // The buffer was drained: a second flush writes nothing new
    const second = fs.readdirSync(root).filter((f) => f.endsWith('.jsonl'));
    expect(second).toHaveLength(1);
  });

  it('PROBE 3: the flag is honored LIVE - flipping it off on disk before dispose suppresses the flush', async () => {
    const settings = path.join(dir, 'settings.yaml');
    fs.writeFileSync(
      settings,
      [
        'subagents-orchestrator:',
        '  enabled: true',
        '  failover: true',
        '  persistTelemetry: true',
        '  endpoints:',
        '    - provider: p1',
        '      model: m1',
        '    - provider: p2',
        '      model: m2'
      ].join('\n'),
      'utf8'
    );
    // Established order: apply() re-inits the watcher at the DEFAULT path,
    // so an explicit initWatcher only wins when it comes AFTER apply.
    apply(ctx);
    resetConfigForTest(settings);
    initWatcher(settings);
    expect(getConfig()?.persistTelemetry).toBe(true);

    populateBuffer();

    // Flip the flag off on disk and wait for the debounced reload
    fs.writeFileSync(
      settings,
      [
        'subagents-orchestrator:',
        '  enabled: true',
        '  failover: true',
        '  persistTelemetry: false',
        '  endpoints:',
        '    - provider: p1',
        '      model: m1',
        '    - provider: p2',
        '      model: m2'
      ].join('\n'),
      'utf8'
    );
    const deadline = Date.now() + 3000;
    while (getConfig()?.persistTelemetry !== false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(getConfig()?.persistTelemetry).toBe(false);

    ctx.dispose();
    expect(fs.existsSync(path.join(dir, 'telemetry'))).toBe(false);
  }, 10000);

  it('PROBE 4: an explicit persistTelemetry false behaves like the default', async () => {
    setConfigForTest({ ...baseConfig, persistTelemetry: false });
    apply(ctx);
    populateBuffer();

    ctx.dispose();
    expect(fs.existsSync(path.join(dir, 'telemetry'))).toBe(false);
  });
});
