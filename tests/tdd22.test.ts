import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 22: two-tier failover walk (fallback mode rescue chain).
 *
 * A rescue pick must actually reach the rescuer: the plan stores its tier,
 * telemetry records the real target, the apply path rewrites to the chain
 * entry, and a subsequent failure on a rescuer walks back into primaries.
 * Pool mode never plans rescues (back-compat).
 */
describe('TDD round 22: two-tier rescue walk', () => {
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

  it('PROBE 1: a rescue pick rewrites the retried request to the rescuer, not a primary', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      mode: 'fallback',
      endpoints: [{ provider: 'p1', model: 'm1' }],
      fallback: [{ provider: 'r1', model: 'm1' }]
    });
    apply(ctx);

    const subagent = createMockAgent('rescue-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('r1');
  });

  it('PROBE 2: telemetry records the real rescue transition p1 -> r1', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      mode: 'fallback',
      endpoints: [{ provider: 'p1', model: 'm1' }],
      fallback: [{ provider: 'r1', model: 'm1' }]
    });
    apply(ctx);

    const subagent = createMockAgent('rescue-2', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'r1' } });
  });

  it('PROBE 3: a failing rescuer walks back into primaries, then the walk gives up', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      mode: 'fallback',
      endpoints: [{ provider: 'p1', model: 'm1' }],
      fallback: [{ provider: 'r1', model: 'm1' }]
    });
    apply(ctx);

    const subagent = createMockAgent('rescue-3', 'subagent');
    const fail = () => ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    const request = () => ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await request();
    await fail(); // p1 exhausted -> rescue r1
    const onR1: any = await request();
    expect(onR1.provider).toBe('r1');

    await fail(); // r1 exhausted -> walk back into primaries
    const onP1: any = await request();
    expect(onP1.provider).toBe('p1');

    await fail(); // combined walk spent -> give up
    expect(await fail()).toBe('host');
  });

  it('PROBE 4: pool mode never plans rescues even with a fallback list present', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ],
      fallback: [{ provider: 'r1', model: 'm1' }]
    });
    apply(ctx);

    const subagent = createMockAgent('pool-compat', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers[0]).toMatchObject({ to: { provider: 'p2' } });
  });
});
