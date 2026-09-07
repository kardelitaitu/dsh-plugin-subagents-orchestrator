import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../src/index.js';
import { setConfigForTest, initWatcher, disposeWatcher, getConfig, resetConfigForTest } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 4: retryIncident scoping and config retention/recovery.
 */
describe('TDD round 4: incident scoping and config recovery', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 1,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

  it('PROBE 1: the same-endpoint retry budget resets when the turn changes', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd4-turns', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Turn 1: first failure retries the same endpoint (budget 1)
    const r1 = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(r1).toEqual({ kind: 'retry' });

    // Turn 2: a fresh turn must start a fresh incident, not accumulate
    const r2 = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 2, step: 1 },
      () => 'host'
    );
    expect(r2).toEqual({ kind: 'retry' });

    // Neither decision planned a cross-endpoint failover
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);
  });

  it('PROBE 2: repeated failures within one turn exhaust the budget, then fail over', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd4-accum', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Two same-turn failures: budget 1, so the second must cross over
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    const second = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(second).toEqual({ kind: 'retry' });

    // The failover was planned to p2
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'p2' } });

    // And the retried request carries the fallback endpoint
    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });

  it('PROBE 3: after walking every endpoint budget the plugin defers to the host', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd4-giveup', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const fail = () => ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );

    // Documented give-up chain (budget is per endpoint, failover target
    // starts a fresh budget): p1 retry -> p1 exhausted -> failover p1->p2
    // -> p2 retry (fresh budget) -> p2 exhausted -> defer.
    expect(await fail()).toEqual({ kind: 'retry' }); // p1, same-endpoint retry
    expect(await fail()).toEqual({ kind: 'retry' }); // p1, budget out -> failover
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(await fail()).toEqual({ kind: 'retry' }); // p2, fresh same-endpoint budget
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));

    const result = await fail(); // p2 budget out, failover budget spent
    expect(result).toBe('host');
  });

  it('PROBE 4: retention does not poison recovery - re-arming the watcher restores routing', async () => {
    const dir = path.join(os.tmpdir(), `dsh-tdd4-${Date.now()}-${process.pid}`);
    const file = path.join(dir, 'settings.yaml');
    try {
      // Clear the injection-authority flag left by the previous afterEach
      // before asking initWatcher to actually read and watch this file.
      resetConfigForTest(file);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        'subagents-orchestrator:\n  enabled: true\n  endpoints:\n    - provider: old-1\n      model: m1\n',
        'utf8'
      );
      initWatcher(file);
      expect(getConfig()?.endpoints?.[0]?.provider).toBe('old-1');

      // The settings directory disappears entirely (watcher dies, snapshot retained)
      fs.rmSync(dir, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(getConfig()?.endpoints?.[0]?.provider).toBe('old-1'); // retained by design

      // The directory (and settings) come back with a NEW endpoint pool
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        'subagents-orchestrator:\n  enabled: true\n  endpoints:\n    - provider: new-1\n      model: m1\n',
        'utf8'
      );

      // Re-arming (what the host does on restart or plugin reload) must see
      // the fresh pool - retention must never pin the cache forever.
      initWatcher(file);
      expect(getConfig()?.endpoints?.[0]?.provider).toBe('new-1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
