import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, recordFailure, recordRequest, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 8: failure-latency metrics contracts.
 */
describe('TDD round 8: failure-latency metrics', () => {
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

  it('PROBE 1: failure latency is the request-to-failure span with injected clocks', async () => {
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

    const subagent = createMockAgent('tdd8-lat', 'subagent');

    // Host assigns p1 at t=1000 (pass-through listener uses Date.now()
    // internally, so latency probes go through the unit-level API instead).
    recordRequest('lat-agent', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('lat-agent', { provider: 'p1', model: 'm1' }, 'TIMEOUT', undefined, 4500);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.latencySamples).toBe(1);
    expect(stat?.latencyTotalMs).toBe(3500);
    expect(stat?.latencyMaxMs).toBe(3500);
    expect(stat?.lastLatencyMs).toBe(3500);

    const events = getRecentEvents();
    const failureEvent = events.find((e) => e.type === 'failure');
    expect(failureEvent?.latencyMs).toBe(3500);
  });

  it('PROBE 2: a second request start overwrites the first - latency tracks the latest attempt', () => {
    recordRequest('ow-agent', { provider: 'p1', model: 'm1' }, 1000);
    recordRequest('ow-agent', { provider: 'p1', model: 'm1' }, 3000); // retry attempt
    recordFailure('ow-agent', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 3500);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    // 500ms since the retry start, not 2500ms since the original
    expect(stat?.lastLatencyMs).toBe(500);
  });

  it('PROBE 3: a failure with no prior request start records no latency sample', () => {
    recordFailure('orphan-agent', { provider: 'p9', model: 'm9' }, 'SERVER', undefined, 5000);

    const stat = getEndpointStats().find((s) => s.key === 'p9::m9');
    expect(stat?.failures).toBe(1);
    expect(stat?.latencySamples).toBe(0);
    expect(stat?.lastLatencyMs).toBeNull();

    const events = getRecentEvents();
    expect(events.find((e) => e.type === 'failure')?.latencyMs).toBeUndefined();
  });

  it('PROBE 4: latency stats accumulate across failures (count, total, max, last)', () => {
    recordRequest('acc-1', { provider: 'p1', model: 'm1' }, 0);
    recordFailure('acc-1', { provider: 'p1', model: 'm1' }, 'TIMEOUT', undefined, 100);
    recordRequest('acc-2', { provider: 'p1', model: 'm1' }, 200);
    recordFailure('acc-2', { provider: 'p1', model: 'm1' }, 'TIMEOUT', undefined, 900);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.latencySamples).toBe(2);
    expect(stat?.latencyTotalMs).toBe(800);
    expect(stat?.latencyMaxMs).toBe(700);
    expect(stat?.lastLatencyMs).toBe(700);
  });

  it('PROBE 5: plugin flow - a failover retry failure attributes latency to the new endpoint only', async () => {
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

    const subagent = createMockAgent('tdd8-failover', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' }, turn: 1, step: 1 }, () => 'host');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p2', model: 'm2' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'TIMEOUT' }, turn: 1, step: 1 }, () => 'host');

    const p2 = getEndpointStats().find((s) => s.key === 'p2::m2');
    const p1 = getEndpointStats().find((s) => s.key === 'p1::m1');

    // The retry failure belongs to p2 (attribution follows activeEndpoints)
    expect(p2?.failures).toBe(1);
    expect(p1?.failures).toBe(1);
  });
});
