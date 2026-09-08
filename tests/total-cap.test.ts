import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { resetTelemetry, getRecentEvents } from '../src/telemetry.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * totalSubagents soft cap (v2, Phase C): over-cap starts pass through
 * unrouted — never rejected, queued or stalled — and freed slots resume
 * routing. cap 0 means "never route".
 */
describe('totalSubagents soft concurrency cap', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    resetTelemetry();
    defaultCircuitBreaker.clear();
  });

  function configure(cap: number | undefined): void {
    setConfigForTest({
      enabled: true,
      failover: false,
      totalSubagents: cap,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);
  }

  const start = async (name: string): Promise<unknown> =>
    ctx.subagents?.start?.(name);

  it('routes starts below the cap', async () => {
    configure(1);
    const result: any = await start('agent-a');
    expect(result.request).toMatchObject({ agentOptions: { provider: 'p1', model: 'm1' } });
  });

  it('passes over-cap starts through unrouted, without stalling', async () => {
    configure(1);
    const first: any = await start('agent-a');
    expect(first.request).toMatchObject({ agentOptions: { provider: 'p1' } });

    // Simulate the agent going live (the pass-through listener attributes it).
    const agent = createMockAgent('agent-a', 'subagent');
    await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));

    // Cap is now saturated: the next start passes through untouched.
    const second: any = await start('agent-b');
    expect(second.request).toBeUndefined();
    expect(second.started).toBe('agent-b');
  });

  it('resumes routing once a slot is freed by agent/disposed', async () => {
    configure(1);
    await start('agent-a');
    const agent = createMockAgent('agent-a', 'subagent');
    await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));

    await start('agent-b'); // over cap, passes through

    await ctx.emit('agent/disposed', { agent }, () => undefined);

    const third: any = await start('agent-c');
    expect(third.request).toMatchObject({ agentOptions: { provider: 'p2' } }); // routed again
  });

  it('cap 0 means never route', async () => {
    configure(0);
    const result: any = await start('agent-a');
    expect(result.request).toBeUndefined();
    expect(getRecentEvents().filter((e) => e.type === 'request')).toHaveLength(0);
  });

  it('absent cap stays unbounded', async () => {
    configure(undefined);
    for (let i = 0; i < 5; i++) {
      const result: any = await start(`agent-${i}`);
      // round-robin alternates providers; what matters is that every start
      // is ROUTED (agentOptions injected), never suppressed.
      expect(result.request?.agentOptions).toBeDefined();
    }
  });
});
