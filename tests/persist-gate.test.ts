import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { recordRequest, resetTelemetry } from '../src/telemetry.js';
import { flushTelemetryToDisk, setPersistDirForTest, eventFileName } from '../src/persist.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * persistTelemetry opt-in gate: dispose flushes durable diagnostics ONLY
 * when the flag is explicitly set; default is off (no disk side effects).
 */
describe('persistTelemetry opt-in lifecycle wiring', () => {
  let ctx: MockCordisContext;
  let dir: string;

  beforeEach(() => {
    ctx = new MockCordisContext();
    dir = path.join(os.tmpdir(), `dsh-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setPersistDirForTest(dir);
    resetTelemetry();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    resetTelemetry();
    setPersistDirForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flushes buffered events and endpoint stats on dispose when enabled', async () => {
    setConfigForTest({
      enabled: true,
      persistTelemetry: true,
      failover: false, // keep the routing machinery quiet; only telemetry matters here
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('persist-on-1', 'subagent');
    // Seed one recorded request via the pass-through listener, then add one
    // buffer event directly (the plugin resets telemetry at dispose, so the
    // direct call stands in for any routed event).
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    recordRequest('persist-on-1', { provider: 'p1', model: 'm1' });

    await ctx.dispose();

    const bucket = path.join(dir, eventFileName(Date.now()));
    expect(fs.existsSync(bucket)).toBe(true);
    const lines = fs.readFileSync(bucket, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((e: any) => e.type === 'request' && e.agentId === 'persist-on-1')).toBe(true);

    // The endpoint snapshot was written too.
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'endpoints.json'), 'utf8'));
    expect(Array.isArray(snapshot.endpoints)).toBe(true);
    expect(snapshot.endpoints.length).toBeGreaterThan(0);
  });

  it('performs no disk writes by default (flag omitted)', async () => {
    setConfigForTest({
      enabled: true,
      failover: false,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    recordRequest('persist-off-1', { provider: 'p1', model: 'm1' });
    await ctx.dispose();

    expect(fs.existsSync(dir)).toBe(false);
  });
});
