import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordRequest,
  recordFailure,
  recordFailover,
  getEndpointStats,
  getRecentEvents,
  resetTelemetry,
  MAX_EVENT_BUFFER,
  setDebugLogging,
  recordTokenSample,
  recordTurnSuccess,
  poisonSuccessSpan,
  getInFlightRequests,
  forgetAgent,
  drainRecentEvents
} from '../src/telemetry.js';

/**
 * Adversarial accounting tests for src/telemetry.ts. These attack the INTERNAL
 * rules (span pairing, poisoning, aggregation, ring bounds, isolation) that the
 * higher-level suites only touch indirectly. Deterministic timestamps
 * throughout; every expectation mirrors the module's own documented contract.
 */
const P1 = { provider: 'p1', model: 'm1' };
const P2 = { provider: 'p2', model: 'm2' };
const stat = (key: string) => getEndpointStats().find((s) => s.key === key);
const successEvents = () => getRecentEvents().filter((e) => e.type === 'success');

beforeEach(() => {
  resetTelemetry();
  delete process.env['DSH_ORCHESTRATOR_DEBUG'];
});

describe('Round 1: span pairing across interleaved agents', () => {
  it('keeps two alternating agents on their own spans and endpoints', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordRequest('a2', P2, 1500, { turn: 0, step: 0 });
    // a1 advances a step: closes a1's span on p1 only.
    recordRequest('a1', P1, 2000, { turn: 0, step: 1 });
    // a2 advances a step: closes a2's span on p2 only.
    recordRequest('a2', P2, 3000, { turn: 0, step: 1 });
    recordTurnSuccess('a1', undefined, 5000);
    recordTurnSuccess('a2', undefined, 6000);

    expect(stat('p1::m1')).toMatchObject({ successes: 2, successLatencySamples: 2, successLatencyTotalMs: 4000 });
    expect(stat('p2::m2')).toMatchObject({ successes: 2, successLatencySamples: 2, successLatencyTotalMs: 4500 });
  });

  it('does not cross spans when two agents share the same (turn, step)', () => {
    recordRequest('a1', P1, 1000, { turn: 3, step: 2 });
    recordRequest('a2', P2, 1000, { turn: 3, step: 2 });
    recordTurnSuccess('a2', undefined, 2000); // closes a2 only
    expect(stat('p1::m1')?.successes).toBe(0); // a1 still open
    expect(stat('p2::m2')?.successes).toBe(1);
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')?.successes).toBe(1);
  });
});

describe('Round 2: a span cannot be closed twice', () => {
  it('a repeated turn close is a no-op and adds no phantom success', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(true);
    expect(recordTurnSuccess('a1', undefined, 3000)).toBe(false);
    expect(stat('p1::m1')).toMatchObject({ successes: 1, successLatencySamples: 1, successLatencyTotalMs: 1000 });
    expect(successEvents()).toHaveLength(1);
  });

  it('a second close after a fresh request closes only the fresh span', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000); // closes step 0
    recordRequest('a1', P1, 2500, { turn: 0, step: 1 });
    expect(recordTurnSuccess('a1', undefined, 4000)).toBe(true); // closes step 1 only
    expect(recordTurnSuccess('a1', undefined, 5000)).toBe(false);
    expect(stat('p1::m1')).toMatchObject({ successes: 2, successLatencyTotalMs: 2500 });
  });
});

describe('Round 3: poisonSuccessSpan targeting', () => {
  it('poisoning with no open span is a pure no-op', () => {
    poisonSuccessSpan('ghost', 0, 0);
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.successes).toBe(1);
  });

  it('a mismatched (turn, step) never poisons a different open span', () => {
    recordRequest('a1', P1, 1000, { turn: 4, step: 1 });
    poisonSuccessSpan('a1', 4, 2);
    poisonSuccessSpan('a1', 5, 1);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.successes).toBe(1);
  });

  it('an unqualified poison (no turn/step) suppresses the open span', () => {
    recordRequest('a1', P1, 1000, { turn: 4, step: 1 });
    poisonSuccessSpan('a1');
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(true);
    expect(stat('p1::m1')?.successes).toBe(0);
    expect(successEvents()).toHaveLength(0);
  });
});

describe('Round 4: success latency aggregation', () => {
  it('a single sample sets count, total, max and last together', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 3400);
    expect(stat('p1::m1')).toMatchObject({
      successLatencySamples: 1,
      successLatencyTotalMs: 2400,
      successLatencyMaxMs: 2400,
      lastSuccessLatencyMs: 2400
    });
  });

  it('max never decreases and last tracks the newest sample', () => {
    recordRequest('a1', P1, 0, { turn: 0, step: 0 });
    recordRequest('a1', P1, 5000, { turn: 0, step: 1 }); // step-0 span = 5000
    recordTurnSuccess('a1', undefined, 5010); // step-1 span = 10
    expect(stat('p1::m1')).toMatchObject({
      successLatencySamples: 2,
      successLatencyTotalMs: 5010,
      successLatencyMaxMs: 5000,
      lastSuccessLatencyMs: 10
    });
  });

  it('a backwards clock clamps to zero without corrupting the totals', () => {
    recordRequest('a1', P1, 5000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')).toMatchObject({
      successLatencySamples: 1,
      successLatencyTotalMs: 0,
      successLatencyMaxMs: 0,
      lastSuccessLatencyMs: 0
    });
    expect(successEvents()[0]?.successLatencyMs).toBe(0);
  });
});

describe('Round 5: token deltas', () => {
  it('a decreasing total never yields a negative delta and re-baselines the mark', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 2400, 1100)).toBe(2400);
    expect(recordTokenSample('a1', 2000, 1200)).toBe(0); // regression clamps
    expect(recordTokenSample('a1', 2100, 1300)).toBe(100); // mark re-baselined at 2000
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(2500);
  });

  it('a negative first mark is not returned or emitted as a negative token count', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    const delta = recordTokenSample('a1', -5, 1100);
    expect(delta).toBe(0);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
    expect(successEvents()[0]?.tokens).toBe(0);
  });

  it('a cumulative mark carried across an endpoint switch is not double counted', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordRequest('a1', P2, 1200, { turn: 0, step: 0 }); // same-step failover rewrite
    recordTokenSample('a1', 1800, 1300);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p2::m2')?.tokensTotal).toBe(800);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
  });

  it('non-finite totals are ignored without touching the mark', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 500, 1100);
    expect(recordTokenSample('a1', Number.NaN, 1200)).toBeNull();
    expect(recordTokenSample('a1', Number.POSITIVE_INFINITY, 1300)).toBeNull();
    expect(recordTokenSample('a1', 700, 1400)).toBe(200);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(700);
  });
});

describe('Round 6: forgetAgent releases every map entry', () => {
  it('releases both the request start and the open span', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(getInFlightRequests()).toBe(1);
    forgetAgent('a1');
    expect(getInFlightRequests()).toBe(0);
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(false);
    expect(stat('p1::m1')?.successes).toBe(0);
  });

  it('repeated open/forget cycles leak nothing', () => {
    for (let i = 0; i < 25; i++) {
      recordRequest(`a-${i}`, P1, 1000 + i, { turn: 0, step: 0 });
      recordTokenSample(`a-${i}`, 100, 1100 + i);
      forgetAgent(`a-${i}`);
    }
    expect(getInFlightRequests()).toBe(0);
    expect(stat('p1::m1')?.successes).toBe(0);
    expect(recordTurnSuccess('a-3', undefined, 9000)).toBe(false);
  });

  it('is idempotent and safe for unknown ids', () => {
    expect(() => {
      forgetAgent('never-seen');
      forgetAgent('never-seen');
    }).not.toThrow();
    expect(getInFlightRequests()).toBe(0);
  });
});

describe('Round 7: recordFailover touches only failover counters', () => {
  it('increments the target and creates the source without latency side effects', () => {
    recordRequest('a1', P1, 1000);
    recordFailure('a1', P1, 'RATE_LIMIT', 30000, 1500); // p1 latency sample 500
    const before = stat('p1::m1');
    recordFailover('a1', P1, P2, 1600);
    expect(stat('p1::m1')).toEqual(before);
    expect(stat('p2::m2')).toMatchObject({
      failovers: 1,
      requests: 0,
      failures: 0,
      latencySamples: 0,
      latencyTotalMs: 0,
      lastLatencyMs: null,
      successes: 0
    });
  });

  it('a from-less failover counts the target once and emits no from', () => {
    recordFailover('a1', undefined, P2, 1000);
    expect(stat('p2::m2')?.failovers).toBe(1);
    const ev = getRecentEvents().find((e) => e.type === 'failover');
    expect(ev).not.toHaveProperty('from');
    expect(ev?.to).toEqual(P2);
  });
});

describe('Round 8: bounded event ring', () => {
  it('caps at exactly MAX_EVENT_BUFFER and drops the oldest, not the newest', () => {
    for (let i = 0; i < MAX_EVENT_BUFFER; i++) recordRequest(`a-${i}`, P1, i);
    let all = getRecentEvents(MAX_EVENT_BUFFER + 50);
    expect(all).toHaveLength(MAX_EVENT_BUFFER);
    expect(all[0].agentId).toBe('a-0');

    recordRequest('newest', P1, MAX_EVENT_BUFFER);
    all = getRecentEvents(MAX_EVENT_BUFFER + 50);
    expect(all).toHaveLength(MAX_EVENT_BUFFER);
    expect(all[0].agentId).toBe('a-1');
    expect(all[all.length - 1].agentId).toBe('newest');
  });

  it('getRecentEvents honours limit and rejects non-positive/non-finite limits', () => {
    for (let i = 0; i < 10; i++) recordRequest(`a-${i}`, P1, i);
    expect(getRecentEvents(3).map((e) => e.agentId)).toEqual(['a-7', 'a-8', 'a-9']);
    expect(getRecentEvents(0)).toEqual([]);
    expect(getRecentEvents(-1)).toEqual([]);
    expect(getRecentEvents(Number.NaN)).toEqual([]);
  });

  it('drainRecentEvents hands over the buffer and leaves the ring empty', () => {
    recordRequest('a1', P1, 1);
    recordFailure('a1', P1, 'SERVER', undefined, 2);
    const drained = drainRecentEvents();
    expect(drained.map((e) => e.type)).toEqual(['request', 'failure']);
    expect(getRecentEvents()).toEqual([]);
    recordRequest('a2', P1, 3);
    expect(getRecentEvents().map((e) => e.agentId)).toEqual(['a2']);
  });
});

describe('Round 9: setDebugLogging gates emission only', () => {
  it('accumulates ring events while logging is off and emits only when on', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      setDebugLogging(false);
      recordRequest('off-1', P1, 1);
      recordFailure('off-1', P1, 'SERVER', undefined, 2);
      expect(spy).not.toHaveBeenCalled();
      expect(getRecentEvents().map((e) => e.type)).toEqual(['request', 'failure']);

      setDebugLogging(true);
      recordRequest('on-1', P2, 3);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0];
      expect(JSON.parse(String(payload))).toMatchObject({ type: 'request', agentId: 'on-1' });
      expect(getRecentEvents().map((e) => e.agentId)).toEqual(['off-1', 'off-1', 'on-1']);
    } finally {
      spy.mockRestore();
      setDebugLogging(undefined);
    }
  });

  it('auto mode defers to the environment variable', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      setDebugLogging(undefined);
      delete process.env['DSH_ORCHESTRATOR_DEBUG'];
      recordRequest('auto-off', P1, 1);
      expect(spy).not.toHaveBeenCalled();

      process.env['DSH_ORCHESTRATOR_DEBUG'] = 'true';
      recordRequest('auto-on', P1, 2);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      setDebugLogging(undefined);
    }
  });
});

describe('Round 10: snapshots are fresh, isolated data', () => {
  it('mutating endpoint stats never mutates internal state', () => {
    recordRequest('a1', P1, 1000);
    const first = getEndpointStats();
    first[0].requests = 999;
    first[0].key = 'tampered';
    first.push({} as never);
    expect(getEndpointStats()).toHaveLength(1);
    expect(getEndpointStats()[0]).toMatchObject({ key: 'p1::m1', requests: 1 });
  });

  it('mutating a returned event never mutates the buffered event', () => {
    recordRequest('a1', P1, 1000);
    const [event] = getRecentEvents();
    event.agentId = 'tampered';
    event.to!.provider = 'tampered';
    const [again] = getRecentEvents();
    expect(again.agentId).toBe('a1');
    expect(again.to).toEqual(P1);
  });
});

describe('Round 11: resetTelemetry leaves no residue', () => {
  it('clears stats, ring, in-flight starts and open spans', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 500, 1100);
    poisonSuccessSpan('a1');
    recordFailover('a1', P1, P2, 1200);
    resetTelemetry();

    expect(getEndpointStats()).toEqual([]);
    expect(getRecentEvents()).toEqual([]);
    expect(getInFlightRequests()).toBe(0);
    expect(recordTurnSuccess('a1', undefined, 5000)).toBe(false);
    expect(stat('p1::m1')).toBeUndefined();

    recordRequest('a1', P1, 6000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 7000);
    expect(stat('p1::m1')).toMatchObject({ successes: 1, successLatencyTotalMs: 1000, tokensTotal: 0 });
  });
});

describe('Round 12: explicit token overrides are clamped on the event too', () => {
  it('an explicit negative token override is not emitted as a negative count', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', -100, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
    expect(successEvents()[0]?.tokens).toBe(0);
  });

  it('an explicit override wins over the span pending tokens', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 500, 1100);
    recordTurnSuccess('a1', 42, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(42);
    expect(successEvents()[0]?.tokens).toBe(42);
  });
});

describe('Round 13: meta-less failure poisons conservatively', () => {
  it('a failure with no turn/step suppresses the open span but keeps the latency sample', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordFailure('a1', P1, 'SERVER', undefined, 1500);
    expect(stat('p1::m1')).toMatchObject({ failures: 1, latencySamples: 1, latencyTotalMs: 500 });
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(true);
    expect(stat('p1::m1')?.successes).toBe(0);
    expect(successEvents()).toHaveLength(0);
  });

  it('a failure consumes the in-flight request start exactly once', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a2', P1, 1000);
    expect(getInFlightRequests()).toBe(2);
    recordFailure('a1', P1, 'SERVER', undefined, 1500);
    expect(getInFlightRequests()).toBe(1);
    recordFailure('a1', P1, 'SERVER', undefined, 1600); // no start left
    expect(getInFlightRequests()).toBe(1);
    expect(stat('p1::m1')?.latencySamples).toBe(1);
  });
});

describe('Round 14: drain returns deep copies too', () => {
  it('mutating a drained event never mutates a later snapshot', () => {
    recordRequest('a1', P1, 1000);
    const drained = drainRecentEvents();
    drained[0].to!.model = 'tampered';
    // The ring is empty, so a fresh event is the only way to observe residue.
    recordRequest('a2', P2, 2000);
    const [again] = getRecentEvents();
    expect(again.to).toEqual(P2);
  });
});

describe('Round 15: cross-boundary mark and per-endpoint isolation', () => {
  it('a session-cumulative mark keeps attributing across turns on different endpoints', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordTurnSuccess('a1', undefined, 2000); // p1 gets 1000
    // Turn 1 lands on p2; the meter is session-cumulative, so only the delta counts.
    recordRequest('a1', P2, 3000, { turn: 1, step: 0 });
    recordTokenSample('a1', 1800, 3100);
    recordTurnSuccess('a1', undefined, 4000); // p2 gets 800
    expect(stat('p1::m1')?.tokensTotal).toBe(1000);
    expect(stat('p2::m2')?.tokensTotal).toBe(800);
  });

  it('mixed failure and dispose paths drain the in-flight map to zero', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a2', P1, 1000);
    recordRequest('a3', P1, 1000);
    recordFailure('a1', P1, 'SERVER', undefined, 1500); // consumes a1's start
    forgetAgent('a2');
    recordTurnSuccess('a3', undefined, 2000); // success does NOT consume the start
    expect(getInFlightRequests()).toBe(1);
    forgetAgent('a3');
    expect(getInFlightRequests()).toBe(0);
  });
});
