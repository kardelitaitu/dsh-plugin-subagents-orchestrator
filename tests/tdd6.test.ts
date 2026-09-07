import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 6: exhaustion-marker lifecycle, hint re-arms, weighted degeneracies.
 */
describe('TDD round 6: exhaustion lifecycle and routing degeneracies', () => {
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

  /** Drive one agent through the full give-up walk; returns nothing. */
  async function exhaustToGiveUp(agentId: string, turn = 1) {
    const subagent = createMockAgent(agentId, 'subagent');
    const fail = (t: number) => ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: t, step: 1 },
      () => 'host'
    );
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(turn); // p1 same-endpoint retry
    await fail(turn); // p1 budget out -> failover plan p2
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(turn); // p2 fresh budget -> retry
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(turn); // p2 budget out -> failover budget spent -> give up
    return { subagent, fail };
  }

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

  it('PROBE 1: exhaustion sticks within the same incident - repeated failures keep deferring', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);
    const { fail } = await exhaustToGiveUp('tdd6-stick');

    // Two more failures in the SAME incident: still defer, never ping-pong
    expect(await fail(1)).toBe('host');
    expect(await fail(1)).toBe('host');
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);
  });

  it('PROBE 2: a new turn re-arms the walk - the agent can fail over again later', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);
    const { subagent, fail } = await exhaustToGiveUp('tdd6-rearm');

    // Turn 2: fresh incident, budget re-armed
    expect(await fail(2)).toEqual({ kind: 'retry' }); // p2 same-endpoint retry
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));

    // Turn 2 budget exhausted -> walk -> p1 is healthy again (streak 2 < 3)
    const decision = await fail(2);
    expect(decision).toEqual({ kind: 'retry' });

    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(2);
    expect(failovers[1]).toMatchObject({ from: { provider: 'p2' }, to: { provider: 'p1' } });
  });

  it('PROBE 3: a provider cooldown hint re-arms a previously exhausted walk', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);
    const { subagent } = await exhaustToGiveUp('tdd6-hint');

    // Same incident, but now the provider itself says when to come back
    const decision = await ctx.emit(
      'agent/request-error',
      {
        agent: subagent,
        failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '5' } },
        turn: 1,
        step: 1
      },
      () => 'host'
    );

    // The hint tripped p1 for its exact window; the walk re-armed and planned
    // the switch to the healthy endpoint despite the earlier exhaustion.
    expect(decision).toEqual({ kind: 'retry' });
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers.some((e) => e.to?.provider === 'p2')).toBe(true);
  });

  it('PROBE 4: weighted routing never picks a tripped heavy endpoint', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      strategy: 'weighted',
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'heavy', model: 'm1', weight: 100 },
        { provider: 'light', model: 'm2', weight: 1 }
      ]
    });
    apply(ctx);

    // The heavy endpoint is down before any delegation
    defaultCircuitBreaker.recordFailure({ provider: 'heavy', model: 'm1' }, 1, 60000);

    for (let i = 0; i < 5; i++) {
      const res: any = await ctx.subagents.start!(`w-${i}`, {});
      expect(res.request.agentOptions.provider).toBe('light');
    }
  });

  it('PROBE 5: a second provider trip degrades to the remaining candidate on a 2-endpoint pool', async () => {
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

    const subagent = createMockAgent('tdd6-degrade', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // First provider trip: p1 tripped, failover planned to p2
    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '60' } }, turn: 1, step: 1 },
      () => 'host'
    );
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));

    // Second provider trip, now on p2: both endpoints are mid-cooldown AND
    // the one-failover budget is spent (count contract, see tdd4 round) -
    // the plugin defers instead of planning a second rewrite.
    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '60' } }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toBe('host');
  });
});
