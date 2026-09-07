import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 14: cross-agent state isolation under interleaved cycles.
 *
 * Every plugin map is keyed by agent id; these probes interleave two
 * agents' request/error cycles and verify neither plan, budget, nor
 * exhaustion ever bleeds across the boundary.
 */
describe('TDD round 14: cross-agent state isolation', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 2,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' }
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

  it('PROBE A: interleaved agents get independent failover plans', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const a = createMockAgent('agent-a', 'subagent');
    const b = createMockAgent('agent-b', 'subagent');

    // Alternating attribution: A lands on p1, B lands on p2
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request', { agent: b }, () => ({ provider: 'p2', model: 'm2' }));

    // Alternating failures: with maxRetries=2 the third failure exhausts
    // the same-endpoint budget and plans the failover. A lands on p2, B on p3.
    await fail(ctx, a); // a retries=1
    await fail(ctx, b); // b retries=1
    await fail(ctx, a); // a retries=2
    await fail(ctx, b); // b retries=2
    await fail(ctx, a); // a exhausts -> plan p1->p2
    await fail(ctx, b); // b exhausts -> plan p2->p3

    const retriedA: any = await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p1', model: 'm1' }));
    const retriedB: any = await ctx.emit('agent/request', { agent: b }, () => ({ provider: 'p2', model: 'm2' }));

    expect(retriedA.provider).toBe('p2');
    expect(retriedB.provider).toBe('p3');

    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(2);
    expect(failovers[0]).toMatchObject({ agentId: 'agent-a', from: { provider: 'p1' }, to: { provider: 'p2' } });
    expect(failovers[1]).toMatchObject({ agentId: 'agent-b', from: { provider: 'p2' }, to: { provider: 'p3' } });
  });

  it('PROBE B: per-agent retry budgets never bleed across agents', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const a = createMockAgent('budget-a', 'subagent');
    const b = createMockAgent('budget-b', 'subagent');
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request', { agent: b }, () => ({ provider: 'p2', model: 'm2' }));

    await fail(ctx, a); // A retries=1
    await fail(ctx, a); // A retries=2
    await fail(ctx, b); // B retries=1 (independent)

    // A's third failure exhausts its own budget -> failover
    const aDecision = await fail(ctx, a);
    expect(aDecision).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);

    // B still inside its own budget -> same-endpoint retry, no failover
    const bDecision = await fail(ctx, b);
    expect(bDecision).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);
  });

  it('PROBE C: disposal clears only the disposed agent; the survivor keeps its state', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const a = createMockAgent('gone-a', 'subagent');
    const b = createMockAgent('kept-b', 'subagent');
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request', { agent: b }, () => ({ provider: 'p2', model: 'm2' }));

    await fail(ctx, a); // A incident: retries=1
    await fail(ctx, b); // B incident: retries=1

    ctx.emit('agent/disposed', { agent: a });

    // A is gone: a late failure has no attribution and defers untouched
    const late = await fail(ctx, a);
    expect(late).toBe('host');
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);

    // B continues from its own incident: retries 2 <= 2 -> same-endpoint retry
    const bDecision = await fail(ctx, b);
    expect(bDecision).toEqual({ kind: 'retry' });
  });

  it('PROBE D: exhaustion of one agent defers while the other keeps retrying', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 1 });
    apply(ctx);

    const a = createMockAgent('exhaust-a', 'subagent');
    const b = createMockAgent('exhaust-b', 'subagent');

    // A walks the whole pool and gives up (marker set)
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(ctx, a);
    await fail(ctx, a); // plan p1->p2
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(ctx, a);
    await ctx.emit('agent/request', { agent: a }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(ctx, a); // give up -> defer
    expect(await fail(ctx, a)).toBe('host');

    // B, interleaved the whole time, still has its own budget: retries=2
    // is within maxRetries=1 only if B's counter never absorbed A's failures
    await ctx.emit('agent/request', { agent: b }, () => ({ provider: 'p3', model: 'm3' }));
    const b1 = await fail(ctx, b);
    const b2 = await fail(ctx, b);
    expect(b1).toEqual({ kind: 'retry' });
    expect(b2).toEqual({ kind: 'retry' });

    // B's budget finally plans its own failover p3 -> p1
    const b3 = await fail(ctx, b);
    expect(b3).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover').some(
      (e) => e.agentId === 'exhaust-b' && e.from?.provider === 'p3'
    )).toBe(true);
  });

  function fail(ctx: MockCordisContext, agent: ReturnType<typeof createMockAgent>, turn = 1) {
    return ctx.emit(
      'agent/request-error',
      { agent, failure: { code: 'SERVER' }, turn, step: 1 },
      () => 'host'
    );
  }
});
