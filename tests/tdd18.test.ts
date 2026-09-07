import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getInFlightRequests, getRecentEvents, MAX_EVENT_BUFFER, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 18: cumulative memory-hygiene locks.
 *
 * After round 17's requestStarts leak, this suite closes the never-deleted-
 * state sweep: churn waves through the FULL lifecycle must leave zero
 * residue, and per-agent telemetry must never multiply stats rows.
 */
describe('TDD round 18: bounded state under lifecycle churn', () => {
  let ctx: MockCordisContext;

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

  it('PROBE 1: churn waves leave zero in-flight residue after disposal', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    for (let wave = 0; wave < 3; wave++) {
      for (let i = 0; i < 5; i++) {
        const id = `churn-${wave}-${i}`;
        const agent = createMockAgent(id, 'subagent');

        await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));
        await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
        await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
        await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));

        ctx.emit('agent/disposed', { agent });
      }
      // Every agent of the wave was disposed: nothing may remain
      expect(getInFlightRequests(), `wave ${wave} residue`).toBe(0);
    }
  });

  it('PROBE 2: endpoint stats stay bounded by the pool, not by agent count', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    // 50 distinct agents hammer the 2-endpoint pool
    for (let i = 0; i < 50; i++) {
      const agent = createMockAgent(`many-${i}`, 'subagent');
      await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));
      await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    }

    // Stats rows are created lazily per endpoint SEEN (p2 never appears
    // here - no failovers), and the row count is bounded by the pool size,
    // never by the agent count.
    const stats = getEndpointStats();
    expect(stats.length).toBeLessThanOrEqual(2);
    const p1 = stats.find((s) => s.key === 'p1::m1');
    expect(p1?.requests).toBeGreaterThanOrEqual(50);
    expect(p1?.failures).toBe(50);
  });

  it('PROBE 3: a fully exhausted agent ends with zero residue and a capped ring', async () => {
    setConfigForTest({ ...baseConfig, maxRetries: 0 });
    apply(ctx);

    const agent = createMockAgent('full-cycle', 'subagent');
    await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));

    // Drive the complete journey: budget out -> failover -> budget out -> defer
    await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    await ctx.emit('agent/request', { agent }, () => ({ provider: 'p2', model: 'm2' }));
    await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    expect(await ctx.emit('agent/request-error', { agent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host')).toBe('host');

    ctx.emit('agent/disposed', { agent });

    expect(getInFlightRequests()).toBe(0);
    expect(getRecentEvents().length).toBeLessThanOrEqual(MAX_EVENT_BUFFER);
  });
});
