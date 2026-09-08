import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 23: hot-reload across tier boundaries + rescue-tier exhaustion.
 */
describe('TDD round 23: tier boundaries under hot-reload', () => {
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

  const fallbackConfig = (fallback: any[], endpoints = [{ provider: 'p1', model: 'm1' }]) => ({
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 0,
    mode: 'fallback' as const,
    endpoints,
    fallback
  });

  it('PROBE 1: a committed rescue plan survives a chain shrink - request passes through untouched', async () => {
    setConfigForTest(fallbackConfig([{ provider: 'r1', model: 'm1' }]));
    apply(ctx);

    const subagent = createMockAgent('shrink-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    const onR1: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(onR1.provider).toBe('r1');

    // Hot-reload removes the chain entirely: mode degrades to pool and the
    // pending fallback-tier plan no longer resolves.
    setConfigForTest({ ...fallbackConfig([]) });
    const after: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(after.provider).toBe('p1');
  });

  it('PROBE 2: a mode flip pool -> fallback keeps in-flight primary plans valid', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('flip-2', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    // Flip to fallback mode (chain arrives) BEFORE the plan is applied
    setConfigForTest({
      ...fallbackConfig([{ provider: 'r1', model: 'm1' }], [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ])
    });

    // The pre-flip primary plan (index 1 -> p2) must still resolve to p2:
    // primary-space indices are unchanged by chain growth.
    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');

    // And a fresh agent gets rescue behavior once BOTH primaries are
    // unavailable (documented tier order: healthy primaries come first).
    const fresh = createMockAgent('flip-2-fresh', 'subagent');
    await ctx.emit('agent/request', { agent: fresh }, () => ({ provider: 'p1', model: 'm1' }));
    defaultCircuitBreaker.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60_000);
    defaultCircuitBreaker.recordFailure({ provider: 'p2', model: 'm2' }, 1, 60_000);
    await ctx.emit('agent/request-error', { agent: fresh, failure: { code: 'INVALID_CREDENTIAL' }, turn: 1, step: 1 }, () => 'host');
    const rescued: any = await ctx.emit('agent/request', { agent: fresh }, () => ({ provider: 'p1', model: 'm1' }));
    expect(rescued.provider).toBe('r1');
  });

  it('PROBE 3: exhaustion sticks across a degrade-to-pool hot-reload within the incident', async () => {
    setConfigForTest(fallbackConfig([{ provider: 'r1', model: 'm1' }]));
    apply(ctx);

    const subagent = createMockAgent('degrade-3', 'subagent');
    const fail = (turn = 1) => ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn, step: 1 }, () => 'host');
    const request = () => ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await request();
    await fail(); // p1 -> r1
    await request();
    await fail(); // r1 exhausted -> combined walk spent -> give up (marker)
    expect(await fail()).toBe('host'); // marker sticks

    // Degrade to pool (chain removed): same incident still defers
    setConfigForTest({ ...fallbackConfig([]) });
    expect(await fail()).toBe('host');

    // A new turn re-arms, but a single-endpoint pool has no walk: defer
    expect(await fail(2)).toBe('host');
  });

  it('PROBE 4: a hint after give-up re-arms and the walk returns to a healthy primary', async () => {
    setConfigForTest(fallbackConfig([{ provider: 'r1', model: 'm1' }]));
    apply(ctx);

    const subagent = createMockAgent('rearm-4', 'subagent');
    const request = () => ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    const fail = (code: string, extra: Record<string, unknown> = {}) =>
      ctx.emit('agent/request-error', { agent: subagent, failure: { code, ...extra }, turn: 1, step: 1 }, () => 'host');

    await request();
    await fail('SERVER'); // p1 -> r1
    await request();
    await fail('SERVER'); // r1 exhausted -> give up
    expect(await fail('SERVER')).toBe('host');

    // Provider hint on the same incident: re-arm; the hint trips r1 and the
    // healthy primary p1 becomes the walk target again.
    const decision = await fail('RATE_LIMIT', { providerRetryAfterMs: 60_000 });
    expect(decision).toEqual({ kind: 'retry' });

    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    const last = failovers[failovers.length - 1];
    expect(last).toMatchObject({ from: { provider: 'r1' }, to: { provider: 'p1' } });

    const back: any = await request();
    expect(back.provider).toBe('p1');
  });
});
