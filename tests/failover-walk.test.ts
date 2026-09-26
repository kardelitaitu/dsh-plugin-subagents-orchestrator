import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher, getCachedFallbackChain } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { pickWeighted } from '../src/balancer.js';
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
 * failing tests carry a '// BUG:' comment describing the defect and are
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

    // The retry must pass through untouched: a vanished target never relocates
    // onto whatever now holds its index.
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

    // The vanished r1::m1 must not resolve through tierList[0] to r2.
    expect(after).toBe(seed);
  });

  it('ROUND 12: a new turn re-arms a walk that gave up on the previous turn', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r12', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1); // p1 -> p2
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // walk spent at (1,1)
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // still deferring

    // New turn: the incident is over, so the walk must re-arm.
    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

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

/**
 * ROUND 2: deeper adversarial probes on the marker helper, the identity-only
 * target resolution, and the pool/fallback tier composition.
 */
describe('failover walk: round-2 marker + tier composition', () => {
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
    resetConfigForTest('unused-failover-walk-r2.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  const failoverCount = () => getRecentEvents().filter((e) => e.type === 'failover').length;

  it('R2-01 (verified correct): pool mode + chain leaves the chain untouched while a healthy primary exists', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1']);

    const sub = createMockAgent('r2-01', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
  });

  it('R2-02 (verified correct): pool mode + chain uses the chain as the documented degradation tier', async () => {
    setConfigForTest(poolCfg([ep('p1')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-02', 'subagent');
    await request(sub);
    const decision = await fail(sub, { code: 'SERVER' });
    expect(decision).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('r1');
  });

  it("R2-03 (verified correct): a string '1' marker matches a number 1 marker", async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-03', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1);
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host');

    expect(await fail(sub, { code: 'SERVER' }, '1', 1)).toBe('host');
    expect(failoverCount()).toBe(1);
  });

  it('R2-04 (verified correct): boolean true matches string true but not the number 1', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-04', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, true);
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' }, 1, true)).toBe('host');

    expect(await fail(sub, { code: 'SERVER' }, 1, 'true')).toBe('host');
    expect(failoverCount()).toBe(1);

    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toEqual({ kind: 'retry' });
  });

  it('R2-05 (verified correct): two distinct value-equal wrappers are the same incident', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-05', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, { valueOf: () => 7 }, 1);
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' }, { valueOf: () => 7 }, 1)).toBe('host');

    expect(await fail(sub, { code: 'SERVER' }, { valueOf: () => 7 }, 1)).toBe('host');
    expect(failoverCount()).toBe(1);
  });

  it('R2-06 (verified correct): the retry budget survives a re-wrapped value-equal turn', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 2 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-06', 'subagent');
    await request(sub);

    const wrapped = () => ({ valueOf: () => 1 });
    expect(await fail(sub, { code: 'SERVER' }, wrapped(), 1)).toEqual({ kind: 'retry' });
    expect(await fail(sub, { code: 'SERVER' }, wrapped(), 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
    expect(await fail(sub, { code: 'SERVER' }, wrapped(), 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
  });

  it('R2-07 (verified correct): the retry budget survives a string-vs-number turn', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 1 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-07', 'subagent');
    await request(sub);

    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
    expect(await fail(sub, { code: 'SERVER' }, '1', 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
  });

  it('R2-08 (verified correct): give-up clears the budget and a new turn starts fresh', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 1 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-08', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1);
    await fail(sub, { code: 'SERVER' }, 1, 1);
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1);
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host');
    expect(failoverCount()).toBe(1);

    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
  });

  it('R2-09 (verified correct): a hint re-arms the same incident through a re-wrapped turn', async () => {
    setConfigForTest(fallbackCfg([ep('p1')], [ep('r1')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-09', 'subagent');
    const wrapped = () => ({ valueOf: () => 3 });
    await request(sub);
    await fail(sub, { code: 'SERVER' }, wrapped(), 1);
    await request(sub);
    await fail(sub, { code: 'SERVER' }, wrapped(), 1);
    expect(await fail(sub, { code: 'SERVER' }, wrapped(), 1)).toBe('host');

    const decision = await fail(sub, { code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 }, wrapped(), 1);
    expect(decision).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

  it('R2-10 (verified correct): a parked committed target must not relocate the retry', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-10', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' });
    await request(sub);
    await fail(sub, { code: 'SERVER' });

    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p4', 'm4')]) as never);
    defaultCircuitBreaker.recordFailure(ep('p4', 'm4'), 1, 3_600_000);

    const seed = { ...ep('p1') };
    const after = await ctx.emit('agent/request', { agent: sub }, () => seed);
    expect(after).toBe(seed);
  });

  it('R2-11 (verified correct): a committed target resolves by identity', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-11', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
  });

  it('R2-12 (verified correct): a second commit overwrites the first cleanly', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const sub = createMockAgent('r2-12', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' });
    await request(sub);
    await fail(sub, { code: 'SERVER' });

    expect(((await request(sub)) as Ep).provider).toBe('p3');
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
  });

  it('R2-13 (verified correct): maxRetries 0 fails over on the first failure', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 0 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-13', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
    expect(((await request(sub)) as Ep).provider).toBe('p2');
  });

  it('R2-14 (verified correct): undefined maxRetries uses the default budget', async () => {
    const cfg = poolCfg([ep('p1'), ep('p2', 'm2')]);
    delete (cfg as Record<string, unknown>).maxRetries;
    setConfigForTest(cfg as never);
    apply(ctx);

    const sub = createMockAgent('r2-14', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
  });

  it('R2-15 (verified correct): a negative maxRetries falls back to the default budget', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: -5 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-15', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
  });

  it('R2-16 (verified correct): a hint on a different endpoint does not derail the walk', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 5 }) as never);
    apply(ctx);

    const sub = createMockAgent('r2-16', 'subagent');
    await request(sub);

    const decision = await ctx.emit(
      'agent/request-error',
      {
        agent: sub,
        provider: 'p9',
        model: 'm9',
        failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 },
        turn: 1,
        step: 1
      },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
  });

  it('R2-17 (verified correct): the degraded walk wraps from the last endpoint', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long);

    const sub = createMockAgent('r2-17', 'subagent');
    await request(sub, ep('p2', 'm2'));
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

  it('R2-18 (verified correct): root failures do not pollute the marker/budget maps', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxRetries: 1 }) as never);
    apply(ctx);

    const id = 'shared-id-r2-18';
    const root = createMockAgent(id, 'user');
    await request(root);
    expect(await fail(root, { code: 'SERVER' })).toBe('host');
    expect(await fail(root, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(0);

    const sub = createMockAgent(id, 'subagent');
    defaultCircuitBreaker.clear();
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(0);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(failoverCount()).toBe(1);
  });

  it('R2-19 (verified correct): pool mode + chain degrades to the chain when every primary is tripped', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, 3_600_000);

    const sub = createMockAgent('r2-19', 'subagent');
    await request(sub);
    const decision = await fail(sub, { code: 'SERVER' });
    expect(decision).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('r1');
  });

  it('R2-20 (verified correct): pool-mode start routing reaches a healthy chain endpoint', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, long);
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long);

    const res: any = await ctx.subagents.start('r2-20', {});
    expect(res.request?.agentOptions?.provider).toBe('r1');
  });
});


/**
 * ROUND 3: cross-turn walk state + verification of the landed pool-mode tier fix.
 *
 * The reviewer's reproduction (R3-01) fully spends turn 1's walk, so the last
 * failure reaches the give-up path, which deletes pendingFailovers -- and turn 2
 * re-arms correctly. That path is VERIFIED CORRECT.
 *
 * R3-02/03/04 probe the SAME cross-turn question with turn 1 ending after only a
 * PARTIAL walk (no give-up). R3-05 clears the circuit breaker between turns so
 * only the walk budget can explain the outcome.
 */
describe('failover walk: round-3 cross-turn walk state', () => {
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
    resetConfigForTest('unused-failover-walk-r3.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  const request = (agent: any, seed: Ep = ep('p1')) =>
    ctx.emit('agent/request', { agent }, () => ({ ...seed }));

  const fail = (agent: any, failure: Record<string, unknown>, turn: unknown = 1, step: unknown = 1) =>
    ctx.emit('agent/request-error', { agent, failure, turn, step }, () => 'host');

  const failoverCount = () => getRecentEvents().filter((e) => e.type === 'failover').length;
  const turnStop = (agent: any) => ctx.emit('agent/turn-stopping', { agent }, () => null);

  it('R3-01 (verified correct): a FULLY spent walk re-arms on the next turn', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r3-01', 'subagent');
    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toEqual({ kind: 'retry' }); // p1 -> p2
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host');              // spent -> give up + delete
    await turnStop(sub);

    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
  });

  it('R3-02: a PARTIAL turn-1 walk must not block turn 2 (breaker cleared control)', async () => {
    // Control isolating the walk budget from breaker exhaustion:
    //   - maxFailures 3, so ONE failure does not trip either endpoint;
    //   - the breaker is wiped between turns, so BOTH endpoints are healthy
    //     going into turn 2.
    // Only the walk budget can therefore explain the outcome.
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { maxFailures: 3 }) as never);
    apply(ctx);

    const sub = createMockAgent('r3-02', 'subagent');

    await request(sub, ep('p1'));
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    await turnStop(sub);

    defaultCircuitBreaker.clear();
    expect(defaultCircuitBreaker.isHealthy(ep('p1'))).toBe(true);
    expect(defaultCircuitBreaker.isHealthy(ep('p2', 'm2'))).toBe(true);

    await request(sub, ep('p2', 'm2'));
    // Turn 2 is a fresh incident: turn differs, the retry budget is
    // incident-scoped and fresh, no exhaustion marker was ever set, and BOTH
    // endpoints are healthy. The walk must be able to move again.
    //
    // BUG: pendingFailovers (src/index.ts:93) is keyed by agent id ONLY and
    // carries no turn/step, unlike retryIncidents and exhaustedAgents which are
    // both incident-scoped. It is cleared only on give-up (src/index.ts:518) or
    // disposal, so a PARTIAL walk leaks its spent count into every later turn.
    // The exhaustion check 'current.count >= endpoints.length - 1'
    // (src/index.ts:502) then sees turn 1's count=1 against a 2-endpoint pool
    // and refuses the failover on turn 2 -- while a healthy endpoint (p1) sits
    // unused. Measured pattern over 6 turns with the breaker cleared each turn:
    //   t1 retry->p2, t2 GIVEUP, t3 retry->p2, t4 GIVEUP, t5 retry->p2, t6 GIVEUP
    // i.e. a long-lived subagent loses failover on half of its turns.
    //
    // Suggested fix: scope pendingFailovers to the incident like its siblings
    // (record turn/step on the commit at src/index.ts:602 and treat a different
    // turn/step as a fresh walk), or clear it at the turn boundary.
    expect(await fail(sub, { code: 'SERVER' }, 2, 1)).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p1');
  });

  // -------------------------------------------------------------------------
  // Verifying the landed pool-mode chain fix (candidate list + start routing).
  // -------------------------------------------------------------------------

  it('R3-03 (verified correct): pool+chain with healthy primaries never routes a start to the chain', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const res: any = await ctx.subagents.start('r3-03-' + i, {});
      seen.push(res.request?.agentOptions?.provider);
    }
    expect(seen).not.toContain('r1');
    expect(new Set(seen)).toEqual(new Set(['p1', 'p2']));
  });

  it('R3-04 (verified correct): with no chain configured behavior is unchanged', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2'), ep('p3', 'm3')]) as never);
    apply(ctx);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res: any = await ctx.subagents.start('r3-04-' + i, {});
      seen.push(res.request?.agentOptions?.provider);
    }
    expect(seen).toEqual(['p1', 'p2', 'p3']);

    const sub = createMockAgent('r3-04-walk', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(2);
  });

  it('R3-05 (verified correct): the anyPrimaryHealthy probe leaves an un-lapsed trip intact', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    // p1 lapses immediately (zero-length cooldown); p2 is tripped for an hour.
    defaultCircuitBreaker.recordFailure(ep('p1'), 1, 0);
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, 3_600_000);

    const res: any = await ctx.subagents.start('r3-05', {});
    expect(res.request?.agentOptions?.provider).toBe('p1');
    // The un-lapsed trip on p2 survived the probe untouched.
    expect(defaultCircuitBreaker.getStatus(ep('p2', 'm2')).trippedUntil).toBeGreaterThan(Date.now());
  });

  it('R3-06 (verified correct): a key duplicated across primary+chain does not self-failover', async () => {
    setConfigForTest(poolCfg([ep('dup')], { fallback: [ep('dup')] }) as never);
    apply(ctx);

    const sub = createMockAgent('r3-06', 'subagent');
    await request(sub, ep('dup'));
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(0);
  });

  it('R3-07 (verified correct): healthy rescue outranks a degraded primary; degraded primary outranks degraded rescue', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const long = 3_600_000;
    defaultCircuitBreaker.recordFailure(ep('p2', 'm2'), 1, long); // p2 degraded

    const sub = createMockAgent('r3-07', 'subagent');
    await request(sub, ep('p1'));
    // p1 trips; p2 is degraded but r1 is HEALTHY -> healthy rescue wins.
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('r1');

    // Now degrade the rescuer too: the degraded-primary walk must come first.
    defaultCircuitBreaker.recordFailure(ep('r1'), 1, long);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' });
    expect(((await request(sub)) as Ep).provider).toBe('p2');
  });

  it('R3-08 (verified correct): round-robin still distributes evenly with a chain configured', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res: any = await ctx.subagents.start('r3-08-' + i, {});
      seen.push(res.request?.agentOptions?.provider);
    }
    expect(seen).toEqual(['p1', 'p2', 'p1', 'p2']);
  });

  it('R3-09 (verified correct): a single healthy primary keeps the chain untouched', async () => {
    setConfigForTest(poolCfg([ep('p1')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    for (let i = 0; i < 3; i++) {
      const res: any = await ctx.subagents.start('r3-09-' + i, {});
      expect(res.request?.agentOptions?.provider).toBe('p1');
    }
  });

  it('R3-10 (verified correct): pool+chain affords N-1 failovers over the COMBINED list', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [ep('r1')] }) as never);
    apply(ctx);

    const sub = createMockAgent('r3-10', 'subagent');
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' }); // -> p2
    expect(((await request(sub)) as Ep).provider).toBe('p2');
    expect(await fail(sub, { code: 'SERVER' })).toEqual({ kind: 'retry' }); // -> r1
    expect(((await request(sub)) as Ep).provider).toBe('r1');
    expect(await fail(sub, { code: 'SERVER' })).toBe('host');
    expect(failoverCount()).toBe(2);
  });

  it('R3-11 (verified correct): the cap still passes an over-cap start through unrouted with a chain present', async () => {
    setConfigForTest(poolCfg([ep('p1')], { fallback: [ep('r1')], totalSubagents: 1 }) as never);
    apply(ctx);

    const live = createMockAgent('r3-11-live', 'subagent');
    await request(live, ep('p1'));

    const over: any = await ctx.subagents.start('r3-11-over', {});
    expect(over.request?.agentOptions).toBeUndefined();
  });

  it('R3-12 (verified correct): dispose clears walk state so a re-apply starts fresh', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const id = 'r3-12';
    const sub = createMockAgent(id, 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }); // p1 -> p2, count 1
    await request(sub);

    ctx.dispose();
    const ctx2 = new MockCordisContext();
    apply(ctx2);
    try {
      // Bind the emitters to ctx2: the helpers above close over ctx.
      const sub2 = createMockAgent(id, 'subagent');
      await ctx2.emit('agent/request', { agent: sub2 }, () => ({ ...ep('p1') }));
      const decision = await ctx2.emit('agent/request-error', { agent: sub2, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
      expect(decision).toEqual({ kind: 'retry' });
      const after = (await ctx2.emit('agent/request', { agent: sub2 }, () => ({ ...ep('p1') }))) as Ep;
      expect(after.provider).toBe('p2');
    } finally {
      ctx2.dispose();
    }
  });

  it('R3-13 (verified correct): the exhaustion marker does not swallow a different step', async () => {
    setConfigForTest(poolCfg([ep('p1'), ep('p2', 'm2')]) as never);
    apply(ctx);

    const sub = createMockAgent('r3-13', 'subagent');
    await request(sub);
    await fail(sub, { code: 'SERVER' }, 1, 1); // p1 -> p2
    await request(sub);
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // (1,1) spent
    expect(await fail(sub, { code: 'SERVER' }, 1, 1)).toBe('host'); // still (1,1)
    // A DIFFERENT step is a different incident: the walk must re-arm.
    expect(await fail(sub, { code: 'SERVER' }, 1, 2)).toEqual({ kind: 'retry' });
  });

  it('R3-14 (verified correct): a fully parked chain behaves exactly like no chain', async () => {
    setConfigForTest(
      poolCfg([ep('p1'), ep('p2', 'm2')], { fallback: [{ provider: 'r1', model: 'm1', enabled: false }] }) as never
    );
    apply(ctx);
    expect(getCachedFallbackChain()).toEqual([]);

    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res: any = await ctx.subagents.start('r3-14-' + i, {});
      seen.push(res.request?.agentOptions?.provider);
    }
    expect(seen).toEqual(['p1', 'p2']);
  });
});


