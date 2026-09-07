import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 5: credential failures must switch accounts immediately.
 *
 * Contract (from the feature's own rationale): a dead key on one account
 * does not implicate the others, and retrying a dead key is futile - so
 * INVALID_CREDENTIAL / MISSING_CREDENTIAL must bypass the same-endpoint
 * retry budget (up to 20 retries x 3-5s pacing) and fail over at once,
 * exactly like a provider cooldown hint does.
 */
describe('TDD round 5: credential failures switch accounts immediately', () => {
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

  it('PROBE 1: the first INVALID_CREDENTIAL fails over instead of pacing retries on a dead key', async () => {
    // maxRetries deliberately NOT set: default budget of 20 must not apply.
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

    const subagent = createMockAgent('tdd5-cred', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'INVALID_CREDENTIAL' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });

    // CONTRACT: the account switch was planned immediately.
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'p2' } });

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });

  it('PROBE 2: MISSING_CREDENTIAL behaves the same way', async () => {
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

    const subagent = createMockAgent('tdd5-missing', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'MISSING_CREDENTIAL' }, turn: 1, step: 1 },
      () => 'host'
    );

    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);
  });

  it('PROBE 3: dead keys on every endpoint still defer to the host after the walk', async () => {
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

    const subagent = createMockAgent('tdd5-alldead', 'subagent');
    const fail = (code: string) => ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code }, turn: 1, step: 1 },
      () => 'host'
    );

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await fail('INVALID_CREDENTIAL'); // p1 -> p2 immediately
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await fail('INVALID_CREDENTIAL'); // p2 -> budget spent -> defer

    const result = await fail('INVALID_CREDENTIAL');
    expect(result).toBe('host');
  });

  it('PROBE 4: transient failures still respect the same-endpoint retry budget', async () => {
    // Guards the fix from over-correcting: a plain SERVER error on turn 1
    // must NOT instantly fail over when the budget allows retries.
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 3,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('tdd5-transient', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );

    expect(getRecentEvents().filter((e) => e.type === 'failover')).toEqual([]);
  });

  it('PROBE 5: an omitted failover field defaults to enabled (README contract)', async () => {
    setConfigForTest({
      enabled: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('tdd5-default', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });
    expect(getRecentEvents().filter((e) => e.type === 'failover')).toHaveLength(1);
  });
});
