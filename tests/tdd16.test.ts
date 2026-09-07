import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, resolveRetryDelayMs } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TDD round 16: mid-wait windows under REAL pacing delays.
 *
 * Earlier suites pinned abort/dispose semantics at interval 0, where the
 * wait resolves instantly and no mid-wait window exists. These probes run
 * real 1.5-3s waits so an abort or dispose lands DURING the sleep.
 */
describe('TDD round 16: mid-wait abort and dispose under real pacing', () => {
  let ctx: MockCordisContext;

  const pacedConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 1500,
    intervalMaxMs: 1500,
    maxRetries: 0,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

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

  it('PROBE 1: an abort DURING the failover wait commits no plan and emits nothing', async () => {
    setConfigForTest(pacedConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd16-abort', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const controller = new AbortController();
    const decisionPromise = ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1, signal: controller.signal },
      () => 'host'
    );

    await sleep(200); // mid-wait (the wait is 1500ms)
    controller.abort();
    const decision = await decisionPromise;

    // Prompt return, but the plan was never committed
    expect(decision).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);

    // The next request passes through unchanged: no pending rewrite
    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p1');
  }, 10000);

  it('PROBE 2: dispose drains in-flight paced waits instead of hanging the host', async () => {
    setConfigForTest(pacedConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd16-drain', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decisionPromise = ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    await sleep(200); // wait is active

    const t0 = Date.now();
    ctx.dispose();
    const decision = await decisionPromise;
    const elapsed = Date.now() - t0;

    expect(decision).toEqual({ kind: 'retry' });
    expect(elapsed).toBeLessThan(1000); // did not sit out the full 1500ms
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);
  }, 10000);

  it('PROBE 3: resolveRetryDelayMs boundaries with an injected random', () => {
    const cfg = { intervalMinMs: 300, intervalMaxMs: 700 } as any;
    expect(resolveRetryDelayMs(cfg, () => 0)).toBe(300);
    expect(resolveRetryDelayMs(cfg, () => 0.999999)).toBeLessThan(700);
    expect(resolveRetryDelayMs(cfg, () => 0.5)).toBe(500);

    // Zero-width window degenerates to a fixed delay
    expect(resolveRetryDelayMs({ intervalMinMs: 400, intervalMaxMs: 400 } as any, () => 0.9)).toBe(400);
    // Inverted window degenerates to a fixed delay at min
    expect(resolveRetryDelayMs({ intervalMinMs: 900, intervalMaxMs: 100 } as any, () => 0.9)).toBe(900);
  });

  it('PROBE 4: a mid-wait abort of a same-endpoint retry keeps state coherent', async () => {
    setConfigForTest({ ...pacedConfig, maxRetries: 3 });
    apply(ctx);

    const subagent = createMockAgent('tdd16-cohere', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const controller = new AbortController();
    const decisionPromise = ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1, signal: controller.signal },
      () => 'host'
    );
    await sleep(200);
    controller.abort();
    const decision = await decisionPromise;
    expect(decision).toEqual({ kind: 'retry' });

    // The next turn is unaffected: fresh incident, normal budget behavior
    const nextTurn = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 2, step: 1 },
      () => 'host'
    );
    expect(nextTurn).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);
  }, 10000);
});
