import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TDD round 25: flap-penalized rescuers inside the two-tier walk.
 *
 * A penalized (or simply tripped) rescuer must follow the documented
 * tier order: healthy primaries first, healthy rescuers next, degraded
 * primaries, degraded rescuers last - and expiry restores eligibility.
 */
describe('TDD round 25: penalized rescuer composition', () => {
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

  const fallbackConfig = (fallback: any[], endpoints: any[]) => ({
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 0,
    mode: 'fallback' as const,
    endpoints,
    fallback
  });

  it('PROBE 1: with only a penalized rescuer left, the degraded attempt still targets it', async () => {
    setConfigForTest(fallbackConfig([{ provider: 'r1', model: 'm1' }], [{ provider: 'p1', model: 'm1' }]));
    apply(ctx);

    // r1 tripped hard before any traffic (simulates the flap penalty window)
    defaultCircuitBreaker.recordFailure({ provider: 'r1', model: 'm1' }, 1, 60_000);

    const subagent = createMockAgent('degraded-rescue', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('r1');
  });

  it('PROBE 2: a healthy primary is preferred over a penalized rescuer', async () => {
    setConfigForTest(
      fallbackConfig([{ provider: 'r1', model: 'm1' }], [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ])
    );
    apply(ctx);

    defaultCircuitBreaker.recordFailure({ provider: 'r1', model: 'm1' }, 1, 60_000);

    const subagent = createMockAgent('healthy-first', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });

  it('PROBE 3: degraded primaries precede degraded rescuers when everything is down', async () => {
    setConfigForTest(
      fallbackConfig([{ provider: 'r1', model: 'm1' }], [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ])
    );
    apply(ctx);

    defaultCircuitBreaker.recordFailure({ provider: 'p2', model: 'm2' }, 1, 60_000);
    defaultCircuitBreaker.recordFailure({ provider: 'r1', model: 'm1' }, 1, 60_000);

    const subagent = createMockAgent('degraded-order', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });

  it('PROBE 4: a penalized rescuer re-enters the walk exactly when its window elapses', async () => {
    const cooldown = 120;
    setConfigForTest(
      fallbackConfig([{ provider: 'r1', model: 'm1' }], [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ])
    );
    apply(ctx);

    // r1 out on a short window; a 3x flap penalty would keep it out for
    // 360ms - the walk at ~180ms distinguishes the two regimes.
    defaultCircuitBreaker.recordFailure({ provider: 'r1', model: 'm1' }, 1, cooldown);

    const subagent = createMockAgent('expiry-4', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    // Within the window: p1 is tripped too, r1 is penalized - the degraded
    // primary walk still attempts p1 (degraded primaries precede rescuers).
    const during: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    expect(during.provider).toBe('p1');

    // Past expiry: r1 is healthy again, but the documented tier order puts
    // healthy primaries first - so trip p2 as well. Now the ONLY healthy
    // candidate is the rescuer, and the walk must find it.
    await sleep(cooldown + 60);
    defaultCircuitBreaker.recordFailure({ provider: 'p2', model: 'm2' }, 1, 60_000);
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 2, step: 1 }, () => 'host');
    const rescued: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    expect(rescued.provider).toBe('r1');
  });
});
