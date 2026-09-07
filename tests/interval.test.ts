import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, resolveRetryDelayMs, DEFAULT_RETRY_INTERVAL_MIN_MS, DEFAULT_RETRY_INTERVAL_MAX_MS } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';
import type { OrchestratorConfig } from '../src/types.js';

describe('Retry Interval Sampling (resolveRetryDelayMs)', () => {
  it('uses 3000-5000ms defaults', () => {
    expect(DEFAULT_RETRY_INTERVAL_MIN_MS).toBe(3000);
    expect(DEFAULT_RETRY_INTERVAL_MAX_MS).toBe(5000);
    for (let i = 0; i < 50; i++) {
      const d = resolveRetryDelayMs(null);
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });

  it('honors configured bounds', () => {
    for (let i = 0; i < 50; i++) {
      const d = resolveRetryDelayMs({ intervalMinMs: 100, intervalMaxMs: 200 });
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(200);
    }
  });

  it('falls back to defaults for non-finite or negative values', () => {
    const cases: OrchestratorConfig[] = [
      { intervalMinMs: Number.NaN, intervalMaxMs: Number.NaN },
      { intervalMinMs: -5, intervalMaxMs: -1 },
      { intervalMinMs: Number.POSITIVE_INFINITY }
    ];
    for (const config of cases) {
      for (let i = 0; i < 20; i++) {
        const d = resolveRetryDelayMs(config);
        expect(d).toBeGreaterThanOrEqual(3000);
        expect(d).toBeLessThanOrEqual(5000);
      }
    }
  });

  it('normalizes an inverted window', () => {
    for (let i = 0; i < 50; i++) {
      const d = resolveRetryDelayMs({ intervalMinMs: 900, intervalMaxMs: 100 });
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(900 + Number.EPSILON + 0); // degenerate window: min == max
    }
  });

  it('supports deterministic sampling via injected random', () => {
    expect(resolveRetryDelayMs({ intervalMinMs: 1000, intervalMaxMs: 3000 }, () => 0.5)).toBe(2000);
    expect(resolveRetryDelayMs({ intervalMinMs: 1000, intervalMaxMs: 3000 }, () => 0)).toBe(1000);
    expect(resolveRetryDelayMs({ intervalMinMs: 1000, intervalMaxMs: 3000 }, () => 1)).toBe(3000);
  });
});

describe('Failover Retry Pacing (agent/request-error)', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    setConfigForTest({
      enabled: true,
      failover: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });
    apply(ctx);
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
  });

  it('delays the retry decision by roughly the configured interval', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 80,
      intervalMaxMs: 120,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    const subagent = createMockAgent('sub-pace-1', 'subagent');

    // Seed the attributed endpoint
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const started = Date.now();
    const action = await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' }
    });
    const elapsed = Date.now() - started;

    expect(action).toEqual({ kind: 'retry' });
    expect(elapsed).toBeGreaterThanOrEqual(70);   // lower bound (small tolerance)
    expect(elapsed).toBeLessThan(500);            // upper bound + generous slack
  });

  it('uses the 3000-5000ms default window when no interval is configured', async () => {
    const subagent = createMockAgent('sub-pace-2', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const action = ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' }
    });

    // The decision must not resolve while the default 3s wait is running.
    const quick = await Promise.race([
      action.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 400))
    ]);
    expect(quick).toBe('pending');
    // The pending wait is cancelled by the afterEach dispose — never await it
    // here, or the test would burn the whole 3-5s default window.
  });

  it('cuts the wait short when the agent abort signal fires mid-interval', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 5000,
      intervalMaxMs: 5000,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    const subagent = createMockAgent('sub-pace-abort', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const ctrl = new AbortController();
    const started = Date.now();
    const action = ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' },
      signal: ctrl.signal
    });
    // Abort shortly into the 5s wait; the decision must resolve promptly.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    const action2 = await action;
    const elapsed = Date.now() - started;

    expect(action2).toEqual({ kind: 'retry' });
    expect(elapsed).toBeLessThan(2000); // aborted early instead of waiting 5s
  });

  it('does not delay non-failover decisions', async () => {
    const subagent = createMockAgent('sub-pace-3', 'subagent');

    const started = Date.now();
    const action = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'UNKNOWN_CODE' } },
      () => 'delegated'
    );
    expect(Date.now() - started).toBeLessThan(100);
    expect(action).toBe('delegated');
  });

  it('delegates instead of vetoing when routing state is inconsistent', async () => {
    const brokenAgent = null; // violates the payload shape; handler must not throw
    const started = Date.now();
    const action = await ctx.emit(
      'agent/request-error',
      { agent: brokenAgent, failure: { code: 'RATE_LIMIT' } },
      () => 'delegated'
    );
    expect(Date.now() - started).toBeLessThan(100);
    expect(action).toBe('delegated');
  });
});
