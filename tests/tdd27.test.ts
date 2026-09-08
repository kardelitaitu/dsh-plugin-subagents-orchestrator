import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 27: concurrency cap x tier-walk composite.
 *
 * The cap gates ROUTING (new starts) only. An in-flight incident -
 * including one descending into the rescue tier - must complete its walk
 * untouched by the cap, and a failed-then-disposed agent frees its slot
 * for new starts even mid-incident.
 */
describe('TDD round 27: cap x tier composite', () => {
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

  const cfg = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 0,
    mode: 'fallback' as const,
    endpoints: [{ provider: 'p1', model: 'm1' }],
    fallback: [{ provider: 'r1', model: 'm1' }],
    totalSubagents: 2
  };

  /** Start, attribute the routed seed, and return the routed provider. */
  async function startAndAttribute(name: string): Promise<string | undefined> {
    const res: any = await ctx.subagents.start!(name, {});
    const provider = res.request?.agentOptions?.provider;
    if (provider === undefined) return undefined;
    await ctx.emit('agent/request', { agent: createMockAgent(name, 'subagent') }, () => ({ provider, model: res.request.agentOptions.model }));
    return provider;
  }

  it('PROBE 1: an in-flight rescue completes while other starts are over cap', async () => {
    setConfigForTest(cfg);
    apply(ctx);

    // Fill both slots
    expect(await startAndAttribute('fill-1')).toBe('p1');
    expect(await startAndAttribute('fill-2')).toBe('p1');

    // One of them fails into the rescue tier (the walk is the error
    // handler's job - the cap never gates it)
    const failing = createMockAgent('fill-1', 'subagent');
    await ctx.emit('agent/request-error', { agent: failing, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    const rescued: any = await ctx.emit('agent/request', { agent: failing }, () => ({ provider: 'p1', model: 'm1' }));
    expect(rescued.provider).toBe('r1');

    // Meanwhile a third start is over cap and unrouted
    expect(await startAndAttribute('overflow')).toBeUndefined();
  });

  it('PROBE 2: an agent whose failure path frees its slot lets a new start route mid-incident', async () => {
    setConfigForTest(cfg);
    apply(ctx);

    expect(await startAndAttribute('mid-1')).toBe('p1');
    expect(await startAndAttribute('mid-2')).toBe('p1');

    // mid-1 fails into the rescue tier, then the host gives up on it
    const failing = createMockAgent('mid-1', 'subagent');
    await ctx.emit('agent/request-error', { agent: failing, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    ctx.emit('agent/disposed', { agent: failing });

    // Slot freed (1/2 live): a new start routes even though the OTHER
    // agent is still mid-incident on its rescue
    const resumed = await startAndAttribute('mid-3');
    expect(resumed).toBe('p1');
  });

  it('PROBE 3: the cap counts attributed rescue agents, not routed starts', async () => {
    setConfigForTest(cfg);
    apply(ctx);

    // Single routed start; its failure lands it on the rescuer (r1) -
    // still ONE live agent, so one more start routes.
    expect(await startAndAttribute('count-1')).toBe('p1');
    const failing = createMockAgent('count-1', 'subagent');
    await ctx.emit('agent/request-error', { agent: failing, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    const onR1: any = await ctx.emit('agent/request', { agent: failing }, () => ({ provider: 'p1', model: 'm1' }));
    expect(onR1.provider).toBe('r1');

    // 1 live agent (the rescued one) + 1 more start = 2/2 - routes
    expect(await startAndAttribute('count-2')).toBeDefined();

    // 2/2 live - a third start is over cap
    expect(await startAndAttribute('count-3')).toBeUndefined();
  });
});
