import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, DEFAULT_MAX_RETRIES, resolveMaxRetries } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Per-endpoint retry budget: an eligible failure first retries the CURRENT
 * endpoint up to maxRetries times (paced 3-5s by default), and only then
 * fails over to the next pool entry — which starts with a fresh budget.
 */
describe('Per-endpoint retry budget (same-endpoint retries before failover)', () => {
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
  });

  it('retries the same endpoint up to maxRetries times before failing over', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 2,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-budget-1', 'subagent');
    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Retries 1 and 2 stay on the failed endpoint.
    for (let i = 1; i <= 2; i++) {
      const action = await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
      expect(action, 'retry ' + i).toEqual({ kind: 'retry' });
      const same: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      expect(same.provider, 'retry ' + i).toBe('p1');
    }

    // Budget exhausted: fail over to the fallback endpoint.
    expect(await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } })).toEqual({ kind: 'retry' });
    const fallback: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(fallback.provider).toBe('p2');
  });

  it('gives each failover target a fresh budget (fallback, then fallback2)', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-chain-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const expectRetryStaysOn = async (expected: string) => {
      expect(
        await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } })
      ).toEqual({ kind: 'retry' });
      const r: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      expect(r.provider).toBe(expected);
    };

    // p1 (initial): 1 same-endpoint retry, then fail over to p2 (fallback)
    await expectRetryStaysOn('p1');
    await expectRetryStaysOn('p2');

    // p2 (fallback): fresh budget — 1 same-endpoint retry, then fail over to p3 (fallback2)
    await expectRetryStaysOn('p2');
    await expectRetryStaysOn('p3');

    // p3 (fallback2): fresh budget — 1 same-endpoint retry, then the host takes over
    await expectRetryStaysOn('p3');
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => null)
    ).toBeNull();
  });

  it('resets the retry budget when the failed turn or step changes', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-scope-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Failure in (turn 0, step 0): one same-endpoint retry.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 0, step: 0 })
    ).toEqual({ kind: 'retry' });

    // A successful step advanced the host to (turn 0, step 1): the budget
    // restarts instead of carrying the previous step's failures over.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 0, step: 1 })
    ).toEqual({ kind: 'retry' });
    const still: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(still.provider).toBe('p1');

    // Second failure within the SAME step: budget exhausted, fail over.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 0, step: 1 })
    ).toEqual({ kind: 'retry' });
    const failedOver: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(failedOver.provider).toBe('p2');
  });

  it('fails over immediately when a provider cooldown hint trips the endpoint', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 20,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-hint-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // The provider asked for a 30s backoff window: pacing 3-5s retries
    // against it is futile, so the endpoint is tripped and the request
    // fails over on the FIRST error.
    const action = await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '30' } }
    });
    expect(action).toEqual({ kind: 'retry' });

    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);
    const fallback: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(fallback.provider).toBe('p2');
  });

  it('defaults to 20 same-endpoint retries before failing over', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-default-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Retries 1..20 stay on the failed endpoint.
    for (let i = 1; i <= DEFAULT_MAX_RETRIES; i++) {
      const action = await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
      expect(action, 'retry ' + i).toEqual({ kind: 'retry' });
      const same: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      expect(same.provider, 'retry ' + i).toBe('p1');
    }

    // Retry 21 is refused: fail over to the fallback endpoint.
    expect(await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } })).toEqual({ kind: 'retry' });
    const fallback: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(fallback.provider).toBe('p2');
  });

  it('paces same-endpoint retries by the configured interval window', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 60,
      intervalMaxMs: 90,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-pace-budget-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const started = Date.now();
    const action = await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' }
    });
    const elapsed = Date.now() - started;

    expect(action).toEqual({ kind: 'retry' });
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);

    // The paced retry targets the SAME endpoint, not a fallback.
    const same: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(same.provider).toBe('p1');
  });

  it('cuts a pending same-endpoint retry short when the agent aborts', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 5000,
      intervalMaxMs: 5000,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-abort-budget-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const ctrl = new AbortController();
    const started = Date.now();
    const action = ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' },
      signal: ctrl.signal
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    const resolved = await action;
    const elapsed = Date.now() - started;

    expect(resolved).toEqual({ kind: 'retry' });
    expect(elapsed).toBeLessThan(2000);

    // No failover was committed behind the abort: the next request still
    // resolves to the failed endpoint's config.
    const same: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(same.provider).toBe('p1');
  });

  it('defers to the host when the failing endpoint cannot be attributed', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    // No agent/request ever fired for this agent: the orchestrator does not
    // know where the request ran, so it cannot count retries or pick a sane
    // fallback — the host (or dsh-llm-retry) owns the decision.
    const result = await ctx.emit(
      'agent/request-error',
      { agent: createMockAgent('sub-unattributed-1', 'subagent'), failure: { code: 'RATE_LIMIT' } },
      () => 'host-default'
    );
    expect(result).toBe('host-default');
  });

  it('resets the same-endpoint retry budget on agent/disposed', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-reset-budget-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Burn the budget on p1 and fail over to p2.
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });

    // The agent settles and is disposed; the host may restart the same id.
    await ctx.emit('agent/disposed', { agent: subagent });

    // Fresh lifecycle: the host assigns p1 again and the budget is clean.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    const action = await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
    expect(action).toEqual({ kind: 'retry' });
    const same: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(same.provider).toBe('p1');
  });

  it('resolveMaxRetries: defaults and clamping', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(20);
    expect(resolveMaxRetries(null)).toBe(20);
    expect(resolveMaxRetries(undefined)).toBe(20);
    expect(resolveMaxRetries({ maxRetries: Number.NaN })).toBe(20);
    expect(resolveMaxRetries({ maxRetries: Number.POSITIVE_INFINITY })).toBe(20);
    expect(resolveMaxRetries({ maxRetries: -2 })).toBe(20);
    expect(resolveMaxRetries({ maxRetries: 0 })).toBe(0);
    expect(resolveMaxRetries({ maxRetries: 5 })).toBe(5);
    expect(resolveMaxRetries({ maxRetries: 7.9 })).toBe(7);
  });

  it('still accounts post-give-up failures (breaker + telemetry) while deferring', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 1,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-giveup-acct-1', 'subagent');
    const fail = () => ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );

    // Walk to give-up: p1 retry -> p1 exhausted -> failover p2 -> p2 fresh
    // budget retry -> p2 exhausted -> defer (give-up marker set).
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail();
    await fail();
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail();
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail();
    const failuresAtGiveUp = getRecentEvents().filter((e) => e.type === 'failure').length;
    const p2StreakAtGiveUp = defaultCircuitBreaker.getStatus({ provider: 'p2', model: 'm2' }).consecutiveFailures;

    // Two MORE failures in the same incident: the decision defers to the
    // host, but the failure is still real — the breaker streak and the
    // telemetry ring must keep learning about it.
    expect(await fail()).toBe('host');
    expect(await fail()).toBe('host');

    expect(getRecentEvents().filter((e) => e.type === 'failure').length).toBe(failuresAtGiveUp + 2);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p2', model: 'm2' }).consecutiveFailures).toBe(p2StreakAtGiveUp + 2);
  });
});
