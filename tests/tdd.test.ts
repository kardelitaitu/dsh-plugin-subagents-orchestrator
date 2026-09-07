import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getRecentEvents, recordRequest, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD bug probes: each test states the CORRECT contract. A failure here is a
 * bug in src/, not in the test.
 */
describe('TDD bug probes', () => {
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

  it('BUG 1: after the failover budget is exhausted, later requests pass through untouched', async () => {
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

    const subagent = createMockAgent('tdd-1', 'subagent');

    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // First failure consumes the only available failover slot (2 endpoints)
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p2');

    // Second failure: budget exhausted, the host takes over
    const exhausted = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' } },
      () => 'host-default'
    );
    expect(exhausted).toBe('host-default');

    // CONTRACT: with the plugin no longer retrying, a host-driven request
    // must pass through untouched - no rewriting onto the stale target.
    const after: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1', keep: true }));
    expect(after).toMatchObject({ provider: 'p1', model: 'm1', keep: true });
  });

  it('BUG 2: getRecentEvents(0), negative and NaN limits return an empty list', () => {
    recordRequest('a', { provider: 'p', model: 'm' });
    recordRequest('b', { provider: 'p', model: 'm' });

    expect(getRecentEvents(0)).toEqual([]);
    expect(getRecentEvents(-3)).toEqual([]);
    expect(getRecentEvents(Number.NaN)).toEqual([]);
    expect(getRecentEvents(1)).toHaveLength(1);
  });

  it('BUG 3: disabling orchestration mid-failover stops rewriting subsequent requests', async () => {
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

    const subagent = createMockAgent('tdd-3', 'subagent');

    // A failover is pending for this agent
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });

    // User switches the plugin off (hot config change)
    setConfigForTest({
      enabled: false,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    // CONTRACT: disabled orchestration must not rewrite requests behind
    // the user's back, even with a pending failover recorded.
    const result: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1', original: true }));
    expect(result).toMatchObject({ provider: 'p1', model: 'm1', original: true });
  });
});
