import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 26: totalSubagents soft concurrency cap.
 *
 * Over-cap starts are never rejected - they pass through UNROUTED. Slots
 * are live attributed agents (set at agent/request, cleared at disposal),
 * so unrouted agents occupy slots too, and disposal frees them.
 */
describe('TDD round 26: soft concurrency cap', () => {
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
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

  /** Start, and if routed, simulate the host dispatch so the slot is taken. */
  async function startAndAttribute(name: string): Promise<{ routed: boolean; provider?: string }> {
    const res: any = await ctx.subagents.start!(name, {});
    const provider = res.request?.agentOptions?.provider;
    if (provider !== undefined) {
      await ctx.emit('agent/request', { agent: createMockAgent(name, 'subagent') }, () => ({ provider, model: res.request.agentOptions.model }));
      return { routed: true, provider };
    }
    return { routed: false };
  }

  it('PROBE 1: starts route up to the cap, then pass through unrouted', async () => {
    setConfigForTest({ ...baseConfig, totalSubagents: 2 });
    apply(ctx);

    expect((await startAndAttribute('cap-1')).routed).toBe(true);
    expect((await startAndAttribute('cap-2')).routed).toBe(true);
    expect((await startAndAttribute('cap-3')).routed).toBe(false);
  });

  it('PROBE 2: disposal frees a slot and routing resumes', async () => {
    setConfigForTest({ ...baseConfig, totalSubagents: 1 });
    apply(ctx);

    expect((await startAndAttribute('slot-1')).provider).toBe('p1');
    expect((await startAndAttribute('slot-2')).routed).toBe(false);

    ctx.emit('agent/disposed', { agent: createMockAgent('slot-1', 'subagent') });
    expect((await startAndAttribute('slot-3')).provider).toBe('p2');
  });

  it('PROBE 3: a zero cap routes nothing', async () => {
    setConfigForTest({ ...baseConfig, totalSubagents: 0 });
    apply(ctx);

    expect((await startAndAttribute('zero-1')).routed).toBe(false);
  });

  it('PROBE 4: unrouted agents still occupy slots once attributed', async () => {
    setConfigForTest({ ...baseConfig, totalSubagents: 2 });
    apply(ctx);

    // Fill the cap with two routed starts
    expect((await startAndAttribute('occ-1')).routed).toBe(true);
    expect((await startAndAttribute('occ-2')).routed).toBe(true);

    // Over cap: unrouted, but the host still dispatches agent/request with
    // its own seed - that agent occupies a live slot too.
    expect((await startAndAttribute('occ-3')).routed).toBe(false);
    await ctx.emit('agent/request', { agent: createMockAgent('occ-3', 'subagent') }, () => ({ provider: 'p9', model: 'm9' }));

    // Releasing the unrouted agent alone does not re-open routing (2/2 live)
    ctx.emit('agent/disposed', { agent: createMockAgent('occ-3', 'subagent') });
    expect((await startAndAttribute('occ-4')).routed).toBe(false);

    // Freeing a routed one does
    ctx.emit('agent/disposed', { agent: createMockAgent('occ-1', 'subagent') });
    expect((await startAndAttribute('occ-5')).routed).toBe(true);
  });
});
