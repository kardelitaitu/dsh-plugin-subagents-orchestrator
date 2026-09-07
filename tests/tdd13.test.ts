import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 13: the enabled-flip boundary and stale incident state.
 *
 * A disable must not burn budget (failures while disabled are the host's),
 * must not inflate the retry count, and must not void decisions the plugin
 * already made (exhaustion sticks within the incident). A NEW turn after
 * re-enable starts fresh.
 */
describe('TDD round 13: enabled-flip state hygiene', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 2,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
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

  const fail = (subagent: ReturnType<typeof createMockAgent>, turn = 1) => ctx.emit(
    'agent/request-error',
    { agent: subagent, failure: { code: 'SERVER' }, turn, step: 1 },
    () => 'host'
  );

  it('PROBE A: failures while disabled never burn the retry budget', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const subagent = createMockAgent('tdd13-freeze', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(subagent); // retries = 1

    // Disabled window: two failures the host handles itself
    setConfigForTest({ ...baseConfig, enabled: false });
    expect(await fail(subagent)).toBe('host');
    expect(await fail(subagent)).toBe('host');

    // Re-enabled: the incident resumes at retries = 2 (1 frozen + 1),
    // NOT inflated by the disabled-window failures
    setConfigForTest(baseConfig);
    expect(await fail(subagent)).toEqual({ kind: 'retry' }); // retries = 2 <= 2
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);

    // One more failure exhausts the budget and plans the failover
    expect(await fail(subagent)).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);
  });

  it('PROBE B: an exhaustion marker outlives a disable blip within the same incident', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 1 });
    apply(ctx);

    const subagent = createMockAgent('tdd13-stick', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(subagent); // p1 retry
    await fail(subagent); // p1 out -> failover plan p2
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(subagent); // p2 retry
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(subagent); // give up: marker set

    // Disable blip: the host keeps managing the same incident
    setConfigForTest({ ...baseConfig, maxRetries: 1, enabled: false });
    expect(await fail(subagent)).toBe('host');

    // Re-enable, same turn/step: the walk is still spent
    setConfigForTest({ ...baseConfig, maxRetries: 1 });
    expect(await fail(subagent)).toBe('host');
  });

  it('PROBE C: a new turn after re-enable starts a fresh walk', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 1 });
    apply(ctx);

    const subagent = createMockAgent('tdd13-newturn', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail(subagent, 1);
    await fail(subagent, 1); // failover plan
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(subagent, 1);
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail(subagent, 1); // give up

    setConfigForTest({ ...baseConfig, maxRetries: 1, enabled: false });
    await fail(subagent, 1);
    setConfigForTest({ ...baseConfig, maxRetries: 1 });

    // Turn 2: fresh incident, budget re-armed -> same-endpoint retry
    const decision = await fail(subagent, 2);
    expect(decision).toEqual({ kind: 'retry' });
  });

  it('PROBE D: a request during the disabled window drops the pending rewrite and passes through', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 0 });
    apply(ctx);

    const subagent = createMockAgent('tdd13-drop', 'subagent');
    const request = () => ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await request();
    await fail(subagent); // failover planned p1 -> p2

    // Disabled: the request passes through UNREWRITTEN and drops the plan
    setConfigForTest({ ...baseConfig, maxRetries: 0, enabled: false });
    const during: any = await request();
    expect(during.provider).toBe('p1');

    // Re-enabled: a fresh plan may be issued for a new failure
    setConfigForTest({ ...baseConfig, maxRetries: 0 });
    const decision = await fail(subagent);
    expect(decision).toEqual({ kind: 'retry' });
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(2);
    expect(failovers[1]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'p2' } });
  });
});
