import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import {
  resetTelemetry,
  getRecentEvents,
  getEndpointStats,
  getInFlightRequests
} from '../src/telemetry.js';
import { resetSettingsForTest } from '../src/settings.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Adversarial bug hunt round 4: the RUNTIME LOOP around the failover walk.
 *
 * Rounds 1-3 attacked 'agent/request-error' candidate selection. This file
 * attacks the parts around it: the 'agent/request' rewrite path and its
 * interaction with activeEndpoints/activeSubagents, 'agent/disposed' teardown,
 * 'agent/turn-stopping' telemetry + breaker success, 'agent/error' span
 * poisoning, start routing (cap, cursor, explicit override), dispose and
 * re-apply, and the ordering of all of them over a realistic multi-turn life.
 */

type Ep = { provider: string; model: string };
const ep = (provider: string, model = 'm1'): Ep => ({ provider, model });

/** Pool mode: one flat list; maxFailures 1 so a single failure trips + walks. */
const poolCfg = (endpoints: Ep[], over: Record<string, unknown> = {}) => ({
  enabled: true,
  failover: true,
  mode: 'pool' as const,
  maxFailures: 1,
  maxRetries: 0,
  intervalMinMs: 0,
  intervalMaxMs: 0,
  endpoints,
  ...over
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('index runtime loop: adversarial bug hunt', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    resetSettingsForTest();
    defaultCircuitBreaker.clear();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused-index-runtime.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  const failoverCount = () => getRecentEvents().filter((e) => e.type === 'failover').length;

  // ---------------------------------------------------------------------------
  // ROUND 1 - dispose during the failover pacing wait. The commit comment
  // (src/index.ts:605) says the failover is committed "only once the retry wait
  // survives without an abort or dispose" - but the guard only tests
  // lifetimeDisposed (plugin dispose), never per-agent disposal.
  // ---------------------------------------------------------------------------
  it('ROUND 1: a dispose during the failover wait must not resurrect the plan', async () => {
    setConfigForTest(
      poolCfg([ep('p1'), ep('p2', 'm2')], { intervalMinMs: 100, intervalMaxMs: 100 }) as never
    );
    apply(ctx);

    const sub = createMockAgent('r1-dispose-midwait', 'subagent');
    await request(sub, ep('p1'));

    // Park the handler in the 100ms pacing wait before it commits.
    const pending = fail(sub, { code: 'SERVER' });
    await sleep(20);

    // The agent dies mid-wait: every trace of it must be forgotten.
    await ctx.emit('agent/disposed', { agent: sub }, () => undefined);
    expect(await pending).toEqual({ kind: 'retry' });

    // The host may restart the SAME id (plugin.test.ts documents this). The
    // request must be a clean pass-through, never a rewrite onto a target the
    // dead agent never reached.
    const after = (await request(sub, ep('p1'))) as Ep;
    expect(after.provider).toBe('p1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 2 - control for round 1: the retry-BUDGET path writes its state
  // BEFORE the wait, so a dispose during the wait cannot resurrect it.
  // ---------------------------------------------------------------------------
  it('ROUND 2 (verified correct): a dispose during the retry-budget wait leaves no budget', async () => {
    setConfigForTest(
      poolCfg([ep('p1'), ep('p2', 'm2')], {
        maxRetries: 1,
        intervalMinMs: 100,
        intervalMaxMs: 100
      }) as never
    );
    apply(ctx);

    const sub = createMockAgent('r2-budget-midwait', 'subagent');
    await request(sub, ep('p1'));

    const pending = fail(sub, { code: 'SERVER' });
    await sleep(20);
    await ctx.emit('agent/disposed', { agent: sub }, () => undefined);
    expect(await pending).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);

    // Restart the same id and re-attribute (the dispose also dropped the
    // endpoint attribution, so a fresh request is needed before failing).
    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
  });
});

/**
 * Rounds 3-10: start routing, boundaries, long-lived state, dispose/re-apply.
 */
describe('index runtime loop: routing, boundaries, lifecycle', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    resetSettingsForTest();
    defaultCircuitBreaker.clear();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused-index-runtime-2.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  // ROUND 3 - the cap boundary: size === cap-1 routes, size === cap passes.
  it('ROUND 3 (verified correct): the cap boundary is exact', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { totalSubagents: 2 }) as never);
    apply(ctx);

    // 0 live -> routes
    const a: any = await ctx.subagents.start('cap-a', {});
    expect(a.request?.agentOptions).toBeDefined();
    await request(createMockAgent('cap-a', 'subagent'), ep('p1'));

    // 1 live (cap-1) -> still routes
    const b: any = await ctx.subagents.start('cap-b', {});
    expect(b.request?.agentOptions).toBeDefined();
    await request(createMockAgent('cap-b', 'subagent'), ep('p2', 'm2'));

    // 2 live (=== cap) -> passes through unrouted
    const c: any = await ctx.subagents.start('cap-c', {});
    expect(c.request?.agentOptions).toBeUndefined();

    // Free exactly one -> routes again
    await ctx.emit('agent/disposed', { agent: createMockAgent('cap-a', 'subagent') }, () => undefined);
    const d: any = await ctx.subagents.start('cap-d', {});
    expect(d.request?.agentOptions).toBeDefined();
  });

  // ROUND 4 - an explicit-override start must not consume a round-robin slot.
  it('ROUND 4 (verified correct): an explicit override leaves the cursor untouched', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const explicit: any = await ctx.subagents.start('ovr-1', {
      agentOptions: { provider: 'custom', model: 'cm' }
    });
    expect(explicit.request.agentOptions).toEqual({ provider: 'custom', model: 'cm' });

    // The override made no routing decision, so the first ROUTED start is p1.
    const r1: any = await ctx.subagents.start('ovr-2', {});
    expect(r1.request.agentOptions.provider).toBe('p1');
  });

  // ROUND 5 - empty primary pool with a 2-entry rescue chain.
  it('ROUND 5: an empty primary pool must still reach a multi-entry chain', async () => {
    setConfigForTest(
      poolCfg([], { fallback: [ep('r1'), ep('r2', 'm2')] }) as never
    );
    apply(ctx);

    const res: any = await ctx.subagents.start('empty-prim', {});
    expect(res.request?.agentOptions?.provider).toBe('r1');
  });

  // ROUND 6 - one agent over 25 turns: nothing accumulates.
  it('ROUND 6 (verified correct): 25 turns on one agent leave no residue', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')], { maxFailures: 3 }) as never);
    apply(ctx);

    const sub = createMockAgent('long-lived', 'subagent');
    for (let turn = 1; turn <= 25; turn++) {
      defaultCircuitBreaker.clear();
      await request(sub, ep('p1'));
      await fail(sub, { code: 'SERVER' }, turn, 1);
      await ctx.emit('agent/turn-stopping', { agent: sub }, () => null);
    }
    // One in-flight entry per live agent at most; one live agent here.
    expect(getInFlightRequests()).toBeLessThanOrEqual(1);
    expect(getEndpointStats().length).toBeLessThanOrEqual(3);
    expect(getRecentEvents().length).toBeLessThanOrEqual(100);
  });

  // ROUND 7 - 50 agents disposed in sequence.
  it('ROUND 7 (verified correct): 50 disposed agents leave zero residue', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    for (let i = 0; i < 50; i++) {
      const agent = createMockAgent('sweep-' + i, 'subagent');
      await request(agent, ep('p1'));
      await fail(agent, { code: 'SERVER' }, 1, 1);
      await ctx.emit('agent/disposed', { agent }, () => undefined);
    }
    expect(getInFlightRequests()).toBe(0);
    expect(getEndpointStats().length).toBeLessThanOrEqual(2);
  });

  // ROUND 8 - turn-stopping records a breaker success for the attributed endpoint.
  it('ROUND 8 (verified correct): turn-stopping closes the breaker for the active endpoint', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxFailures: 3, maxRetries: 5 }) as never);
    apply(ctx);

    const sub = createMockAgent('turn-ok', 'subagent');
    await request(sub, ep('p1'));
    await fail(sub, { code: 'SERVER' }, 1, 1);
    await fail(sub, { code: 'SERVER' }, 1, 1);
    expect(defaultCircuitBreaker.getStatus(ep('p1')).consecutiveFailures).toBe(2);

    await ctx.emit('agent/turn-stopping', { agent: sub }, () => null);
    expect(defaultCircuitBreaker.getStatus(ep('p1')).consecutiveFailures).toBe(0);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBeGreaterThanOrEqual(1);
  });

  // ROUND 9 - agent/error poisons the open span for the matching step only.
  it('ROUND 9 (verified correct): agent/error poisons only the matching step span', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('err-poison', 'subagent');
    await ctx.emit('agent/request', { agent: sub, turn: 1, step: 0 }, () => ({ ...ep('p1') }));
    // A DIFFERENT incident must not poison the open span.
    await ctx.emit('agent/error', { agent: sub, turn: 9, step: 9 }, () => null);
    await ctx.emit('agent/turn-stopping', { agent: sub, turn: 1 }, () => null);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(1);

    // The MATCHING incident does poison it.
    await ctx.emit('agent/request', { agent: sub, turn: 2, step: 0 }, () => ({ ...ep('p1') }));
    await ctx.emit('agent/error', { agent: sub, turn: 2, step: 0 }, () => null);
    await ctx.emit('agent/turn-stopping', { agent: sub, turn: 2 }, () => null);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(1);
  });

  // ROUND 10 - dispose then re-apply on the SAME context.
  it('ROUND 10 (verified correct): dispose then re-apply on the same ctx re-arms routing', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const first: any = await ctx.subagents.start('reapply-a', {});
    expect(first.request?.agentOptions).toBeDefined();

    // Tear the plugin down but keep the context alive.
    for (const d of [...ctx.disposables].reverse()) d();
    ctx.disposables = [];
    ctx.listeners.clear();

    apply(ctx);
    const second: any = await ctx.subagents.start('reapply-b', {});
    expect(second.request?.agentOptions).toBeDefined();
    // The failover listener was re-registered and still works.
    const sub = createMockAgent('reapply-c', 'subagent');
    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
  });
});
/**
 * Rounds 11-20: rewrite-path honesty, config gates, interleaving, ordering.
 */
describe('index runtime loop: rewrite path and ordering', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    resetSettingsForTest();
    defaultCircuitBreaker.clear();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused-index-runtime-3.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  // ROUND 11 - a retried request the host ABANDONS (null seed) must not be
  // recorded as a real request: the rewrite branch records before next() runs.
  it('ROUND 11: a null-seed retry must not record a phantom request or success', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('null-seed', 'subagent');
    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    // The host aborts the rebuild: nothing was dispatched.
    const abandoned = await ctx.emit('agent/request', { agent: sub }, () => null);
    expect(abandoned).toBeNull();

    await ctx.emit('agent/turn-stopping', { agent: sub }, () => null);

    const p2 = getEndpointStats().find((s) => s.key === 'p2::m2');
    // No request was built, so p2 saw no request and no success.
    expect(p2?.requests ?? 0).toBe(0);
    expect(p2?.successes ?? 0).toBe(0);
  });

  // ROUND 12 - failover switched OFF between commit and retry.
  it('ROUND 12 (verified correct): disabling failover between commit and retry drops the rewrite', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('late-disable', 'subagent');
    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    // The user turns failover off before the host rebuilds.
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { failover: false }) as never);

    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: sub }, () => seed);
    expect(after).toBe(seed);
    expect((after as Ep).provider).toBe('p1');
  });

  // ROUND 13 - a negative cap is not a cap: the cap >= 0 guard keeps routing.
  it('ROUND 13 (verified correct): a negative cap leaves routing unbounded', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { totalSubagents: -1 }) as never);
    apply(ctx);

    for (let i = 0; i < 4; i++) {
      const res: any = await ctx.subagents.start('neg-cap-' + i, {});
      expect(res.request?.agentOptions).toBeDefined();
    }
  });

  // ROUND 14 - a non-numeric cap is ignored (typeof number guard).
  it('ROUND 14 (verified correct): a NaN cap leaves routing unbounded', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { totalSubagents: Number.NaN }) as never);
    apply(ctx);

    const res: any = await ctx.subagents.start('nan-cap', {});
    expect(res.request?.agentOptions).toBeDefined();
  });

  // ROUND 15 - two agents interleaved over several turns: no cross-talk.
  // Both start from the same endpoint, so their per-agent walks must stay in
  // lockstep; a shared/global budget would desynchronize them.
  it('ROUND 15 (verified correct): interleaved multi-turn agents keep independent state', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')], { maxFailures: 3 }) as never);
    apply(ctx);

    const a = createMockAgent('inter-a', 'subagent');
    const b = createMockAgent('inter-b', 'subagent');
    const seenA: (string | undefined)[] = [];
    const seenB: (string | undefined)[] = [];

    for (let turn = 1; turn <= 4; turn++) {
      defaultCircuitBreaker.clear();
      await request(a, ep('p1'));
      await request(b, ep('p1'));
      expect(await fail(a, { code: 'SERVER' }, turn, 1)).toEqual({ kind: 'retry' });
      expect(await fail(b, { code: 'SERVER' }, turn, 1)).toEqual({ kind: 'retry' });
      const ra = (await request(a, ep('p1'))) as Ep;
      const rb = (await request(b, ep('p1'))) as Ep;
      seenA.push(ra.provider);
      seenB.push(rb.provider);
      await ctx.emit('agent/turn-stopping', { agent: a }, () => null);
      await ctx.emit('agent/turn-stopping', { agent: b }, () => null);
    }

    // Identical histories -> identical walks. A shared budget or a leaked plan
    // would make one agent's turn advance the other's.
    expect(seenA).toEqual(seenB);
    // And each turn's target is a real move off the current endpoint.
    expect(new Set(seenA).size).toBeGreaterThan(1);
    expect(seenA).not.toContain(undefined);
    expect(getEndpointStats().length).toBeLessThanOrEqual(3);
  });

  // ROUND 16 - agent/error with NO turn/step poisons the open span outright.
  it('ROUND 16 (verified correct): a bare agent/error poisons the open span unconditionally', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('bare-error', 'subagent');
    await ctx.emit('agent/request', { agent: sub, turn: 5, step: 5 }, () => ({ ...ep('p1') }));
    await ctx.emit('agent/error', { agent: sub }, () => null);
    await ctx.emit('agent/turn-stopping', { agent: sub, turn: 5 }, () => null);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(0);
  });

  // ROUND 17 - turn-stopping while the plugin is disabled records nothing.
  it('ROUND 17 (verified correct): a disabled plugin ignores turn-stopping entirely', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('disabled-turn', 'subagent');
    await request(sub, ep('p1'));
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { enabled: false }) as never);

    await ctx.emit('agent/turn-stopping', { agent: sub }, () => null);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes ?? 0).toBe(0);
  });

  // ROUND 18 - a cap-blocked start must not consume a round-robin slot.
  it('ROUND 18 (verified correct): an over-cap start leaves the cursor untouched', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { totalSubagents: 1 }) as never);
    apply(ctx);

    const first: any = await ctx.subagents.start('cur-a', {});
    expect(first.request.agentOptions.provider).toBe('p1');
    await request(createMockAgent('cur-a', 'subagent'), ep('p1'));

    // Over cap: passes through and must not advance the cursor.
    const blocked: any = await ctx.subagents.start('cur-b', {});
    expect(blocked.request?.agentOptions).toBeUndefined();

    // Free the slot: the next routed start must be p2 (one step, not two).
    await ctx.emit('agent/disposed', { agent: createMockAgent('cur-a', 'subagent') }, () => undefined);
    const next: any = await ctx.subagents.start('cur-c', {});
    expect(next.request.agentOptions.provider).toBe('p2');
  });

  // ROUND 19 - disposing an agent with a COMMITTED (already applied) plan.
  it('ROUND 19 (verified correct): dispose after the commit clears the applied plan', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('dispose-after', 'subagent');
    await request(sub, ep('p1'));
    await fail(sub, { code: 'SERVER' });
    expect(((await request(sub, ep('p1'))) as Ep).provider).toBe('p2');

    // The plan is now committed (count 1). Dispose the agent.
    await ctx.emit('agent/disposed', { agent: sub }, () => undefined);

    // A restarted same-id request must pass through, not jump to p3.
    const after = (await request(sub, ep('p1'))) as Ep;
    expect(after.provider).toBe('p1');
  });

  // ROUND 20 - a root session's dispose clears its activeEndpoints attribution.
  it('ROUND 20 (verified correct): disposing a root session clears its endpoint attribution', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const root = createMockAgent('root-attrib', 'user');
    await request(root, ep('p1'));
    await ctx.emit('agent/disposed', { agent: root }, () => undefined);

    // With the attribution gone, a failure must derive the endpoint from the
    // payload (and still record health) rather than reusing a stale mapping.
    const decision = await ctx.emit(
      'agent/request-error',
      { agent: root, provider: 'p2', model: 'm2', failure: { code: 'QUOTA' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toBe('host');
    expect(defaultCircuitBreaker.isHealthy(ep('p2', 'm2'))).toBe(false);
  });
});
