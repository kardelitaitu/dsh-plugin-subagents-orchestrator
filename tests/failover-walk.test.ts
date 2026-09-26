import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher, getCachedFallbackChain } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { resetSettingsForTest } from '../src/settings.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Adversarial bug hunt: the FAILOVER WALK in src/index.ts.
 *
 * Scope (deliberately narrow): the 'agent/request-error' candidate-selection
 * logic (tier ordering, exhaustion, the exhaustedAgents marker, the retry
 * budget, terminal-failure bypass, the provider-hint re-arm, root-agent
 * non-interference) and its interaction with the 'agent/request' rewrite
 * (tier/identity resolution of the committed target).
 *
 * CONFIRMED BUGS ARE NOT FIXED HERE (concurrent work owns src/index.ts): the
 * failing tests below carry a '// BUG:' comment describing the defect and are
 * intentionally RED. Everything else is a regression pin for verified-correct
 * behavior.
 *
 * Deterministic: intervalMinMs/intervalMaxMs are 0 (no pacing wait); only the
 * return-home probe sleeps, because it needs a real cooldown to elapse.
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

/** Fallback mode: primaries plus an ordered rescue chain. */
const fallbackCfg = (endpoints: Ep[], fallback: Ep[], over: Record<string, unknown> = {}) => ({
  ...poolCfg(endpoints, over),
  mode: 'fallback' as const,
  fallback
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('failover walk: adversarial bug hunt', () => {
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
    resetConfigForTest('unused-failover-walk.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  /** Emit a subagent request; the host seed is returned by next(). */
  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  /** Emit a failure; next() returns a sentinel so a give-up is visible. */
  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  const failoverCount = () => getRecentEvents().filter((e) => e.type === 'failover').length;

  // ---------------------------------------------------------------------------
  // ROUND 1 - tier ordering: healthy primary -> healthy rescue -> degraded
  // primary -> degraded rescue, and the ACTUAL endpoint chosen at each tier.
  // ---------------------------------------------------------------------------

  it('ROUND 1a: a healthy primary outranks a healthy rescue entry', async () => {
    setConfigForTest(fallbackCfg([ep('p1'), ep('p2', 'm2')], [ep('r1')]) as never);
    apply(ctx);

    const sub = createMockAgent('r1a', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('p2');
  });

  it('ROUND 1b: a healthy rescue entry is used only once no healthy primary remains', async () => {
    setConfigForTest(fallbackCfg([ep('p1'), ep('p2', 'm2')], [ep('r1')]) as never);
    apply(ctx);

    // p2 is out before any traffic, so tripping p1 leaves no healthy primary.
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, 3_600_000);

    const sub = createMockAgent('r1b', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('r1');
  });

  it('ROUND 1c: with every entry tripped the degraded walk still leaves the current rescuer for a degraded primary', async () => {
    setConfigForTest(fallbackCfg([ep('p1'), ep('p2', 'm2')], [ep('r1')]) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, long);

    const sub = createMockAgent('r1c', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1/p2 tripped -> healthy rescue r1
    const onR1 = (await request(sub)) as Ep;
    expect(onR1.provider).toBe('r1');

    // Trip the rescuer too: everything is degraded. The walk must still move
    // (degraded primaries precede degraded rescuers) and never stay put.
    defaultCircuitBreaker.recordFailure(ep('r1'), 1, long);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('p2');
    expect(after.provider).not.toBe('r1');
  });

  it('ROUND 1d: a degraded rescue entry is the last resort, after degraded primaries', async () => {
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r1'), ep('r2', 'm2')]) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('r1'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('r2', 'm2'), 1, long);

    const sub = createMockAgent('r1d', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('r1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 2 - tier-relative search: an agent sitting on a RESCUE entry must be
  // able to come home to a recovered primary, without ping-ponging.
  // ---------------------------------------------------------------------------

  it('ROUND 2: an agent on a rescue entry returns home to a recovered primary', async () => {
    // Short, non-hour-aligned cooldowns so a primary can recover mid-test.
    setConfigForTest(
      fallbackCfg([ep('p1'), ep('p2', 'm2')], [ep('r1')], { cooldownMs: 200, alignHourly: false }) as never
    );
    apply(ctx);

    const sub = createMockAgent('r2', 'subagent');
    // p2 is parked out for the whole test; p1 recovers quickly.
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, 3_600_000);

    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 tripped (200ms), p2 parked -> rescue
    const onR1 = (await request(sub)) as Ep;
    expect(onR1.provider).toBe('r1');

    await sleep(300); // p1's window elapses -> probationary healthy

    // Failing on the rescue entry: the tier-relative primary sweep must come
    // home to the recovered primary, not stay in the rescue tier.
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    const home = (await request(sub)) as Ep;
    expect(home.provider).toBe('p1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 3 - exhaustion budget: N endpoints afford exactly N-1 failovers.
  // ---------------------------------------------------------------------------

  it('ROUND 3: the walk spends exactly N-1 failovers and then gives up (no early give-up, no infinite loop)', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r3', 'subagent');
    await request(sub);

    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' }); // p1 -> p2
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' }); // p2 -> p3
    expect(((await request(sub)) as Ep).provider).toBe('p3');

    // N-1 = 2 failovers spent: the third failure must give up, not loop.
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(2);

    // And it stays given-up for the same incident.
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // ROUND 4 - the exhaustedAgents marker is scoped by (turn, step).
  // ---------------------------------------------------------------------------

  it('ROUND 4: the exhaustion marker keeps deferring a value-equal (turn, step), not just an identical one', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r4', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 -> p2
    expect(await fail(sub, { code: 'SERVER' })).toBe('host'); // walk spent -> give up + marker
    const spent = failoverCount();

    expect(await fail(sub, { code: 'SERVER' })).toBe('host'); // same incident -> deferring
    expect(failoverCount()).toBe(spent);

    // The SAME incident identified by a value-equal (turn, step) must keep
    // deferring. Here the host hands the incident identifier over as a fresh
    // wrapper object rather than the identical primitive.
    // BUG: exhaustedAgents stores turn/step as `unknown` and compares them with
    // === (src/index.ts:326 and :382), so an incident whose turn/step arrives as
    // a fresh value-equal object is misread as a NEW incident: the spent walk
    // restarts and the retry is rewritten onto the next endpoint, re-entering
    // the "ping-pong a fully dead pool forever" loop the marker exists to stop.
    // (A fresh PRIMITIVE with the same value is fine - === matches it.)
    const decision = await fail(sub, { code: 'SERVER' }, { valueOf: () => 1 }, { valueOf: () => 1 });
    expect(decision).toBe('host');
    expect(failoverCount()).toBe(spent);
  });

  // ---------------------------------------------------------------------------
  // ROUND 5 - all candidates degraded: pick a non-current candidate, never
  // stall and never return the current endpoint.
  // ---------------------------------------------------------------------------

  it('ROUND 5: a fully tripped pool still advances to a non-current candidate', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long);

    const sub = createMockAgent('r5', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('p2');
  });

  // ---------------------------------------------------------------------------
  // ROUND 6 - pool mode: the walk must ignore chain indices entirely.
  // ---------------------------------------------------------------------------

  it('ROUND 6: pool mode never lands on the rescue chain even when a chain is configured', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);
    // The chain is cached but the effective mode is pool.
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1']);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('r1'), 1, long);

    const sub = createMockAgent('r6', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });

    const after = (await request(sub)) as Ep;
    expect(after.provider).toBe('p2');
    expect(after.provider).not.toBe('r1');
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect((failovers[failovers.length - 1] as any).to).toMatchObject({ provider: 'p2' });
  });

  // ---------------------------------------------------------------------------
  // ROUND 7 - maxRetries budget scoping: fresh per (agent, endpointKey, turn,
  // step), so a failover target and a new turn both restart it.
  // ---------------------------------------------------------------------------

  it('ROUND 7: the retry budget resets across targets and across turns', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 2 }) as never);
    apply(ctx);

    const sub = createMockAgent('r7', 'subagent');
    await request(sub);

    // Budget 2 on p1: two retries, the third failure fails over.
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);

    const onP2 = (await request(sub)) as Ep;
    expect(onP2.provider).toBe('p2');

    // The failover target starts with a FRESH budget: the first failure on p2
    // is a same-endpoint retry, not another failover.
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);

    // A new turn restarts the budget as well.
    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // ROUND 8 - terminal failures skip the same-endpoint retry budget; a plain
  // SERVER failure does not.
  // ---------------------------------------------------------------------------

  it('ROUND 8: terminal codes fail over immediately while SERVER stays on the retry budget', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 5 }) as never);
    apply(ctx);

    const terminal: Array<[string, Record<string, unknown>]> = [
      ['QUOTA', { code: 'QUOTA' }],
      ['INVALID_CREDENTIAL', { code: 'INVALID_CREDENTIAL' }],
      ['MISSING_CREDENTIAL', { code: 'MISSING_CREDENTIAL' }],
      ['account-level RATE_LIMIT', { code: 'RATE_LIMIT', message: 'CodeBuddy API rate limit exceeded' }],
      ['hard RATE_LIMIT', { code: 'RATE_LIMIT', message: 'usage exceeds frequency limit' }]
    ];

    for (const [label, failure] of terminal) {
      defaultCircuitBreaker.clear();
      const sub = createMockAgent('r8-' + label, 'subagent');
      await request(sub);
      const before = failoverCount();
      expect(await fail(sub, failure), label + ' must skip the retry budget').toEqual({ kind: 'retry' });
      expect(failoverCount(), label + ' must fail over at once').toBe(before + 1);
      expect(((await request(sub)) as Ep).provider, label).toBe('p2');
    }

    // Control: a normal SERVER failure burns the budget instead of failing over.
    defaultCircuitBreaker.clear();
    const sub = createMockAgent('r8-server', 'subagent');
    await request(sub);
    const before = failoverCount();
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(before);
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 9 - a provider cooldown hint re-arms the walk before the exhaustion
  // check.
  // ---------------------------------------------------------------------------

  it('ROUND 9: a cooldown hint revives a walk that already gave up', async () => {
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r1')]) as never);
    apply(ctx);

    const sub = createMockAgent('r9', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 -> r1
    expect(((await request(sub)) as Ep).provider).toBe('r1');
    await fail(sub, { code: 'SERVER' }); // r1 spent -> give up
    expect(await fail(sub, { code: 'SERVER' })).toBe('host'); // marker sticks

    // Same incident, but now with a provider hint: re-arm and return home.
    const decision = await fail(sub, { code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 });
    expect(decision).toEqual({ kind: 'retry' });

    const back = (await request(sub)) as Ep;
    expect(back.provider).toBe('p1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 10 - root (non-subagent) agents: health is recorded, routing is not.
  // ---------------------------------------------------------------------------

  it('ROUND 10: a root agent gets next() verbatim and is never rewritten', async () => {
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r1')]) as never);
    apply(ctx);

    const root = createMockAgent('root-10', 'user');
    await request(root);

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: root, failure: { code: 'QUOTA' }, turn: 1, step: 1 },
      () => 'host-unhandled'
    );
    expect(decision).toBe('host-unhandled');
    // Health was still recorded...
    expect(defaultCircuitBreaker.isHealthy(ep('p1'))).toBe(false);
    // ...but no failover was planned or applied for the root session.
    expect(failoverCount()).toBe(0);
    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: root }, () => seed);
    expect(after).toBe(seed);

    // Sanity: the very same config DOES fail a subagent over, so the root
    // pass-through is the non-interference guard, not an inert config.
    const sub = createMockAgent('root-10-sub', 'subagent');
    defaultCircuitBreaker.clear();
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('r1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 11 - the committed target is resolved by identity; a list edit
  // between the commit and the retry must not relocate the retry.
  // ---------------------------------------------------------------------------

  it('ROUND 11a: a removed target must not silently relocate onto whatever now holds its index', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r11a', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 -> p2 (index 1)
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    await fail(sub, { code: 'SERVER' }); // p2 -> p3 (index 2), targetKey p3::m3

    // The user edits the pool: index 2 is now a DIFFERENT account (p4), and p4
    // is tripped. The committed target p3::m3 no longer exists.
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p4', 'm4')]) as never);
    defaultCircuitBreaker.recordFailure(ep('p4', 'm4'), 1, 3_600_000);

    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: sub }, () => seed);

    // BUG: the identity lookup is guarded by '?? tierList[current.index]'
    // (src/index.ts:654-659), so a vanished target whose index still exists
    // silently relocates the retry
    // onto a different (here: tripped) endpoint, contradicting the in-code
    // contract "a vanished target passes through untouched rather than
    // silently relocating onto a neighbour". The index fallback must only be
    // used while the list still matches the committed plan.
    expect(after).toBe(seed);
    expect((after as Ep).provider).toBe('p1');
  });

  it('ROUND 11b: the same index-fallback relocation happens for a rescue-tier target', async () => {
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r1')]) as never);
    apply(ctx);

    const sub = createMockAgent('r11b', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 -> r1 (chain index 0)
    expect(((await request(sub)) as Ep).provider).toBe('r1');

    // The chain is edited: index 0 is now a different rescuer.
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r2', 'm2')]) as never);

    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: sub }, () => seed);

    // BUG (same root cause as ROUND 11a, rescue tier): the vanished r1::m1
    // resolves through tierList[0] (src/index.ts:659) to the new chain entry r2.
    expect(after).toBe(seed);
  });

  // ---------------------------------------------------------------------------
  // ROUND 12 - the exhaustion marker re-arms on a NEW turn/step (the
  // complement of ROUND 4): the walk restarts instead of deferring forever.
  // ---------------------------------------------------------------------------

  it('ROUND 12: a new turn re-arms a walk that gave up on the previous turn', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r12', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1); // p1 -> p2
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // walk spent at (1,1)
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // still deferring

    // New turn: the incident is over, so the walk must re-arm and move on
    // from the committed endpoint rather than stay permanently exhausted.
    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

  // ---------------------------------------------------------------------------
  // ROUND 13 - the payload-derived current endpoint path (a subagent failure
  // whose request was never attributed to activeEndpoints).
  // ---------------------------------------------------------------------------

  it('ROUND 13: a failure carrying provider/model on the payload still walks the pool', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    // No prior 'agent/request': the handler must derive the failed endpoint
    // from the payload's provider/model instead of giving up.
    const sub = createMockAgent('r13', 'subagent');
    const decision = await ctx.emit(
      'agent/request-error',
      { agent: sub, provider: 'p1', model: 'm1', failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });

    const after = (await ctx.emit('agent/request', { agent: sub }, () => ({ ...ep('p1') }))) as Ep;
    expect(after.provider).toBe('p2');
  });

  it('ROUND 11c (verified correct): a target whose index is gone passes through untouched', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r11c', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    await fail(sub, { code: 'SERVER' }); // commits p3 at index 2

    // Shrink to a single endpoint: the index no longer exists, so the retry
    // must pass through untouched rather than becoming undefined-and-wrong.
    setConfigForTest(poolCfg([ep('p1')]) as never);

    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: sub }, () => seed);
    expect(after).toBe(seed);
  });
});
