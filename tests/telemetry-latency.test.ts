import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRequest,
  recordFailure,
  getEndpointStats,
  getRecentEvents,
  resetTelemetry
} from '../src/telemetry.js';

/**
 * Failure-latency metrics: the request-to-failure span per endpoint, sampled
 * from the request start recorded by recordRequest and consumed by the first
 * recordFailure for the same agent. Deterministic via explicit timestamps.
 */
describe('Telemetry: failure latency metrics', () => {
  beforeEach(() => {
    resetTelemetry();
  });

  it('samples the request-to-failure span for the routed endpoint', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 3400);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({
      latencySamples: 1,
      latencyTotalMs: 2400,
      latencyMaxMs: 2400,
      lastLatencyMs: 2400
    });
  });

  it('exposes the span on the failure debug event', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'TIMEOUT', undefined, 9000);

    const failure = getRecentEvents().find((e) => e.type === 'failure');
    expect(failure?.latencyMs).toBe(8000);
  });

  it('records no latency when the failure has no matching request start', () => {
    // The host failed the agent before any agent/request pass-through was
    // observed: no start entry, no fabricated sample.
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 5000);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.failures).toBe(1);
    expect(stat?.latencySamples).toBe(0);
    expect(stat?.latencyTotalMs).toBe(0);
    expect(stat?.latencyMaxMs).toBe(0);
    expect(stat?.lastLatencyMs).toBeNull();

    const failure = getRecentEvents().find((e) => e.type === 'failure');
    expect(failure).not.toHaveProperty('latencyMs');
  });

  it('consumes the start once: a retried request on another endpoint starts fresh', () => {
    // Request on p1, fails fast, failover to p2, fails slower.
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 1500);
    recordRequest('a1', { provider: 'p2', model: 'm2' }, 1600);
    recordFailure('a1', { provider: 'p2', model: 'm2' }, 'TIMEOUT', undefined, 9600);

    const p1 = getEndpointStats().find((s) => s.key === 'p1::m1');
    const p2 = getEndpointStats().find((s) => s.key === 'p2::m2');
    expect(p1).toMatchObject({ latencySamples: 1, latencyTotalMs: 500 });
    expect(p2).toMatchObject({ latencySamples: 1, latencyTotalMs: 8000, lastLatencyMs: 8000 });
  });

  it('accumulates count, total, max and last across several samples', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 2000); // 1000ms
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 3000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'TIMEOUT', undefined, 7500); // 4500ms
    recordRequest('a2', { provider: 'p1', model: 'm1' }, 8000);
    recordFailure('a2', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 8300); // 300ms

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({
      latencySamples: 3,
      latencyTotalMs: 5800,
      latencyMaxMs: 4500,
      lastLatencyMs: 300
    });
  });

  it('keeps concurrent agents isolated', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordRequest('a2', { provider: 'p1', model: 'm1' }, 5000);
    // a2's failure lands first, at a different endpoint state.
    recordFailure('a2', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 5200);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 7000);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.latencySamples).toBe(2);
    // a2: 200ms, a1: 6000ms — order must not swap the agents' spans.
    expect(stat?.latencyTotalMs).toBe(6200);
    expect(stat?.latencyMaxMs).toBe(6000);
    expect(stat?.lastLatencyMs).toBe(6000);
  });

  it('resetTelemetry drops in-flight request starts', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    resetTelemetry();
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 5000);

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.latencySamples).toBe(0);
    expect(stat?.lastLatencyMs).toBeNull();
  });
});
