import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Terminal failures (QUOTA / INVALID_CREDENTIAL / MISSING_CREDENTIAL) cannot
 * heal on the same endpoint: they must bypass the same-endpoint retry budget
 * and switch accounts on the first failure.
 */
describe('Terminal failures bypass the same-endpoint retry budget', () => {
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

  it('QUOTA switches accounts on the first failure without pacing retries', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      // maxRetries deliberately NOT set: the default 20-retry budget must
      // not apply to a quota exhaustion that cannot heal on this endpoint.
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    const subagent = createMockAgent('quota-bypass-1', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const decision = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'QUOTA' }, turn: 1, step: 1 },
      () => 'host'
    );
    expect(decision).toEqual({ kind: 'retry' });

    // The account switch was planned immediately — no 20-retry burn.
    const failovers = getRecentEvents().filter((e) => e.type === 'failover');
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'p2' } });

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });
});
