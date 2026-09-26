import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetSettingsForTest } from '../src/settings.js';
import { resetTelemetry, getRecentEvents } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * The failover WALK BUDGET must be scoped to the incident, like the retry
 * budget (`retryIncidents`) and the exhaustion marker (`exhaustedAgents`).
 *
 * It was not: `pendingFailovers` was keyed by agent id alone and carried only
 * { count, index, tier, targetKey }. Its count therefore survived the turn
 * boundary, and a long-lived subagent that spent PART of its walk in one turn
 * had that spend counted against the next turn. Measured on a fully healthy
 * 3-endpoint pool (breaker cleared between turns):
 *
 *   t1 retry->p2   t2 retry->p3   t3 GIVEUP   t4 retry->p2
 *
 * Every third turn dead-ended on a pool with no tripped endpoint. The give-up
 * path cleared the map, which is why a FULLY spent turn re-armed correctly and
 * hid the defect: only a PARTIAL walk leaked.
 *
 * Probes here clear the breaker each turn and assert every endpoint healthy,
 * so breaker exhaustion cannot explain a give-up - only the stale budget can.
 */
describe('failover walk budget is per-incident, not per-agent', () => {
  let ctx: MockCordisContext;

  const pool = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' }
  ];

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    resetSettingsForTest();
    defaultCircuitBreaker.clear();
    (ctx as unknown as { settings: unknown }).settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async () => undefined
    };
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    resetConfigForTest('unused-walk-budget.yaml');
    defaultCircuitBreaker.clear();
    resetTelemetry();
    resetSettingsForTest();
  });

  /** Run one turn: request on the host seed, then fail it. Returns the decision. */
  async function runTurn(sub: unknown, turn: number) {
    await ctx.emit('agent/request', { agent: sub, turn }, () => ({ provider: 'p1', model: 'm1' }));
    const decision = await ctx.emit(
      'agent/request-error',
      { agent: sub, failure: { code: 'SERVER' }, turn, step: 1 },
      () => 'host'
    );
    const seed = (await ctx.emit('agent/request', { agent: sub, turn }, () => ({ provider: 'p1', model: 'm1' }))) as { provider?: string };
    return { decision, target: seed?.provider };
  }

  it('REGRESSION: a PARTIAL walk must not be charged against the next turn', async () => {
    // maxFailures 3 so a single failure trips nothing: only the budget can
    // cause a give-up here.
    setConfigForTest({
      enabled: true, failover: true, mode: 'pool', maxFailures: 3, maxRetries: 0,
      intervalMinMs: 0, intervalMaxMs: 0, ui: { panel: true }, endpoints: pool
    } as never);
    apply(ctx);
    const sub = createMockAgent('walk-budget', 'subagent');

    const decisions: string[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      // Fully healthy pool every turn, so a give-up cannot be exhaustion.
      defaultCircuitBreaker.clear();
      for (const e of pool) expect(defaultCircuitBreaker.isHealthy(e), 'pool healthy at turn ' + turn).toBe(true);
      const { decision } = await runTurn(sub, turn);
      decisions.push(JSON.stringify(decision) === JSON.stringify({ kind: 'retry' }) ? 'retry' : 'giveup');
    }

    console.log('decisions over 6 turns:', decisions.join(','));
    // Every turn starts fully healthy, so every turn must fail over.
    expect(decisions).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'retry']);
  });

  it('a fully spent turn still re-arms the next one (the give-up path)', async () => {
    setConfigForTest({
      enabled: true, failover: true, mode: 'pool', maxFailures: 3, maxRetries: 0,
      intervalMinMs: 0, intervalMaxMs: 0, ui: { panel: true }, endpoints: pool
    } as never);
    apply(ctx);
    const sub = createMockAgent('walk-spent', 'subagent');

    defaultCircuitBreaker.clear();
    await ctx.emit('agent/request', { agent: sub, turn: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    // Spend the whole N-1 budget (N=3 -> 2 failovers) then give up.
    expect(await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host')).toEqual({ kind: 'retry' });
    await ctx.emit('agent/request', { agent: sub, turn: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    expect(await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host')).toEqual({ kind: 'retry' });
    await ctx.emit('agent/request', { agent: sub, turn: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    expect(await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host')).toBe('host');

    // Turn 2 is a fresh incident and must walk again.
    defaultCircuitBreaker.clear();
    const { decision, target } = await runTurn(sub, 2);
    console.log('turn 2 after a fully spent turn 1:', JSON.stringify(decision), '->', target);
    expect(decision).toEqual({ kind: 'retry' });
  });

  it('the walk still gives up within ONE incident when the budget is truly spent', async () => {
    setConfigForTest({
      enabled: true, failover: true, mode: 'pool', maxFailures: 3, maxRetries: 0,
      intervalMinMs: 0, intervalMaxMs: 0, ui: { panel: true }, endpoints: pool
    } as never);
    apply(ctx);
    const sub = createMockAgent('same-incident', 'subagent');
    defaultCircuitBreaker.clear();

    const seen: string[] = [];
    await ctx.emit('agent/request', { agent: sub, turn: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    for (let i = 0; i < 4; i++) {
      const d = await ctx.emit('agent/request-error', { agent: sub, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
      seen.push(JSON.stringify(d) === JSON.stringify({ kind: 'retry' }) ? 'retry' : 'giveup');
      await ctx.emit('agent/request', { agent: sub, turn: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    }
    console.log('same-incident decisions:', seen.join(','));
    // N-1 = 2 failovers, then give up and KEEP deferring within the incident.
    expect(seen.slice(0, 2)).toEqual(['retry', 'retry']);
    expect(seen.slice(2)).toEqual(['giveup', 'giveup']);
  });
});
