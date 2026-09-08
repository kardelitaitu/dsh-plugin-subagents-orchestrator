import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRequest,
  recordFailure,
  recordTurnSuccess,
  recordTokenSample,
  poisonSuccessSpan,
  forgetAgent,
  getEndpointStats,
  getRecentEvents,
  resetTelemetry,
  getInFlightRequests
} from '../src/telemetry.js';

/**
 * Success-side step spans: request build -> next same-agent boundary.
 * Deterministic via explicit timestamps; mirrors telemetry-latency.test.ts.
 */
describe('Telemetry: success latency & token metrics', () => {
  beforeEach(() => {
    resetTelemetry();
  });

  it('closes the open span as a success at turn stop', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    const closed = recordTurnSuccess('a1', undefined, 5200);

    expect(closed).toBe(true);
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({
      successes: 1,
      successLatencySamples: 1,
      successLatencyTotalMs: 4200,
      successLatencyMaxMs: 4200,
      lastSuccessLatencyMs: 4200,
      tokensTotal: 0
    });
    const success = getRecentEvents().find((e) => e.type === 'success');
    expect(success).toMatchObject({ agentId: 'a1', successLatencyMs: 4200 });
    expect(success).not.toHaveProperty('tokens');
  });

  it('advances the span at a later request and closes the prior step as a success', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    // Next step of the same turn: the prior step's request completed.
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 4000, { turn: 0, step: 1 });

    let stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({ successes: 1, successLatencyTotalMs: 3000 });

    // Turn close closes the (still open) step-1 span.
    recordTurnSuccess('a1', undefined, 9000);
    stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({ successes: 2, successLatencyTotalMs: 3000 + 5000 });
  });

  it('a same-step re-dispatch replaces the span without sampling a success', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    // Host-driven retry of the SAME step (e.g. the orchestrator rewrote it
    // onto a failover target): not a completed request, just a replacement.
    recordRequest('a1', { provider: 'p2', model: 'm2' }, 3000, { turn: 0, step: 0 });

    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(0);
    expect(getEndpointStats().find((s) => s.key === 'p2::m2')?.successes).toBe(0);

    recordTurnSuccess('a1', undefined, 6000);
    const p2 = getEndpointStats().find((s) => s.key === 'p2::m2');
    expect(p2).toMatchObject({ successes: 1, successLatencyTotalMs: 3000 });
    // The replaced p1 span is never sampled.
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successLatencySamples).toBe(0);
  });

  it('a failed step is poisoned: later boundaries never sample it as success', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 2 });
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 1400, { turn: 0, step: 2 });
    // A later request of the same turn supersedes the failed span...
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 5000, { turn: 0, step: 3 });
    // ...and the poisoned one is dropped, not counted.
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.successes).toBe(0);
    expect(stat?.successLatencySamples).toBe(0);
    expect(stat?.failures).toBe(1);
  });

  it('an unrelated turn/step failure does not poison a different open span', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    poisonSuccessSpan('a1', 7, 9); // different incident
    recordTurnSuccess('a1', undefined, 2100);
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.successes).toBe(1);
  });

  it('agent/error poisoning via explicit turn/step marks the exact span', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 1, step: 0 });
    poisonSuccessSpan('a1', 1, 0);
    recordTurnSuccess('a1', undefined, 4000);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(0);
  });

  it('attributes token deltas from cumulative meter samples', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 1500, 2000)).toBe(1500); // first mark: full total
    expect(recordTokenSample('a1', 2400, 3000)).toBe(900); // delta since mark
    expect(recordTokenSample('a1', 2000, 3500)).toBe(0); // regression clamps to 0

    recordTurnSuccess('a1', undefined, 5200);
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.tokensTotal).toBe(2400);
    const success = getRecentEvents().find((e) => e.type === 'success');
    expect(success?.tokens).toBe(2400);
  });

  it('keeps the token mark across a mid-turn endpoint switch (no double count)', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1500);
    // Failover rewrites the SAME step onto p2: mark survives.
    recordRequest('a1', { provider: 'p2', model: 'm2' }, 3000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1800, 4000);
    recordTurnSuccess('a1', undefined, 6000);

    const p2 = getEndpointStats().find((s) => s.key === 'p2::m2');
    expect(p2?.tokensTotal).toBe(800); // 1800 - 1000, not 1800
  });

  it('ignores token samples with no open span or non-finite totals', () => {
    expect(recordTokenSample('ghost', 500)).toBeNull();
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    expect(recordTokenSample('a1', Number.NaN)).toBeNull();
    expect(recordTokenSample('a1', Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('turn success with no open span is a no-op returning false', () => {
    expect(recordTurnSuccess('nobody', 100)).toBe(false);
  });

  it('forgetAgent releases both the failure-start entry and the open span', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    expect(getInFlightRequests()).toBe(1);
    forgetAgent('a1');
    expect(getInFlightRequests()).toBe(0);
    // The disposed agent's span is dropped, never sampled as a success.
    expect(recordTurnSuccess('a1', undefined, 9000)).toBe(false);
    expect(getEndpointStats().find((s) => s.key === 'p1::m1')?.successes).toBe(0);
  });

  it('keeps concurrent agents isolated across boundaries', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000, { turn: 0, step: 0 });
    recordRequest('a2', { provider: 'p1', model: 'm1' }, 2000, { turn: 0, step: 0 });
    recordTurnSuccess('a2', undefined, 4000); // 2000ms
    recordTurnSuccess('a1', undefined, 9000); // 8000ms

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({ successes: 2, successLatencyTotalMs: 10000, successLatencyMaxMs: 8000 });
  });

  it('accumulates max across mixed close paths', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 0, { turn: 0, step: 0 });
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 700, { turn: 0, step: 1 }); // step close 700ms
    recordTurnSuccess('a1', undefined, 5000); // turn close 4300ms
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat).toMatchObject({ successLatencySamples: 2, successLatencyMaxMs: 4300, lastSuccessLatencyMs: 4300 });
  });
});
