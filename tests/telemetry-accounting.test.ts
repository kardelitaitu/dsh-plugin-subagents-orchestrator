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

describe('Round 16: tokenMarks across a dispose/re-apply cycle', () => {
  it('a fresh lifecycle re-baselines the cumulative mark', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 1000, 1100)).toBe(1000);
    recordTurnSuccess('a1', undefined, 2000);
    // index.ts disposes via resetTelemetry(); a later apply() must not inherit
    // the previous lifecycle's session-cumulative mark.
    resetTelemetry();
    recordRequest('a1', P1, 3000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 500, 3100)).toBe(500);
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')?.tokensTotal).toBe(500);
  });
});

describe('Round 17: forgetAgent mid-turn and the token mark', () => {
  it('clears the mark, and a sample with no open span is ignored', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    forgetAgent('a1');
    expect(recordTokenSample('a1', 1200, 1200)).toBeNull();
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(false);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
  });

  it('a disposed id that opens a NEW span re-baselines from the fresh mark', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    forgetAgent('a1');
    recordRequest('a1', P1, 2000, { turn: 0, step: 0 });
    // Dispose ends the lifecycle, so the next sample is the new session total.
    expect(recordTokenSample('a1', 400, 2100)).toBe(400);
    recordTurnSuccess('a1', undefined, 3000);
    expect(stat('p1::m1')?.tokensTotal).toBe(400);
  });
});

describe('Round 18: ring boundary, drain and re-read consistency', () => {
  it('stays capped after a drain and a refill', () => {
    for (let i = 0; i < MAX_EVENT_BUFFER; i++) recordRequest(`a-${i}`, P1, i);
    expect(getRecentEvents()).toHaveLength(MAX_EVENT_BUFFER);
    expect(drainRecentEvents()).toHaveLength(MAX_EVENT_BUFFER);
    expect(getRecentEvents()).toEqual([]);
    expect(drainRecentEvents()).toEqual([]);
    for (let i = 0; i < MAX_EVENT_BUFFER + 10; i++) recordRequest(`b-${i}`, P1, i);
    const all = getRecentEvents();
    expect(all).toHaveLength(MAX_EVENT_BUFFER);
    expect(all[0].agentId).toBe('b-10');
  });
});

describe('Round 19: repeated same (turn, step) requests', () => {
  it('a repeat replaces the span without sampling and only the last is closed', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordRequest('a1', P2, 1200, { turn: 0, step: 0 });
    recordRequest('a1', P2, 1500, { turn: 0, step: 0 });
    expect(stat('p1::m1')?.successes).toBe(0);
    expect(stat('p2::m2')?.successes).toBe(0);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p2::m2')).toMatchObject({ successes: 1, successLatencyTotalMs: 500 });
    expect(stat('p1::m1')?.successes).toBe(0);
  });
});

describe('Round 20: poisonSuccessSpan after the span closed', () => {
  it('does not poison a later span', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000);
    poisonSuccessSpan('a1', 0, 0); // late: the (0,0) span is already gone
    recordRequest('a1', P1, 3000, { turn: 0, step: 1 });
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')).toMatchObject({ successes: 2, successLatencyTotalMs: 2000 });
  });
});

describe('Round 21: running success average after a backwards sample', () => {
  it('keeps total/avg/max sane when one sample clamps to zero', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordRequest('a1', P1, 3000, { turn: 0, step: 1 }); // closes step0 at 2000ms
    recordTurnSuccess('a1', undefined, 2500); // step1: 2500-3000 < 0 -> 0
    const s = stat('p1::m1')!;
    expect(s).toMatchObject({
      successes: 2,
      successLatencySamples: 2,
      successLatencyTotalMs: 2000,
      successLatencyMaxMs: 2000,
      lastSuccessLatencyMs: 0
    });
    expect(s.successLatencyTotalMs / s.successLatencySamples).toBe(1000);
  });
});

describe('Round 22: recordFailover from === to', () => {
  it('counts the self-transition once and emits both sides', () => {
    recordFailover('a1', P1, P1, 1000);
    expect(stat('p1::m1')?.failovers).toBe(1);
    const ev = getRecentEvents().find((e) => e.type === 'failover')!;
    expect(ev.from).toEqual(P1);
    expect(ev.to).toEqual(P1);
  });
});

describe('Round 23: provider/model key ambiguity', () => {
  it('collapses two distinct endpoints whose provider::model strings collide', () => {
    recordRequest('a1', { provider: 'a::b', model: 'c' }, 1000);
    recordRequest('a2', { provider: 'a', model: 'b::c' }, 1001);
    const stats = getEndpointStats();
    // Known ambiguity: the key is `${provider}::${model}` with no escaping, so
    // two distinct endpoints share one entry. Reported, not fixed here: the
    // same encoding is built by health.ts and diagnostics.ts.
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ key: 'a::b::c', requests: 2 });
  });
});

describe('Round 24: fractional token totals', () => {
  it('accumulates fractional deltas without NaN', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 0.1, 1100)).toBeCloseTo(0.1);
    expect(recordTokenSample('a1', 0.2, 1200)).toBeCloseTo(0.1);
    expect(recordTokenSample('a1', 0.3, 1300)).toBeCloseTo(0.1);
    recordTurnSuccess('a1', undefined, 1400);
    const total = stat('p1::m1')!.tokensTotal;
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(0.3);
    expect(successEvents()[0]?.tokens).toBeCloseTo(0.3);
  });
});

describe('Round 25: getRecentEvents limit edge values', () => {
  it('Infinity yields an empty list while a large finite limit yields the buffer', () => {
    for (let i = 0; i < 5; i++) recordRequest(`a-${i}`, P1, i);
    expect(getRecentEvents(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(getRecentEvents(1e9)).toHaveLength(5);
  });
});

describe('Round 26: recorders never mutate their endpoint argument', () => {
  it('leaves the caller endpoint object untouched across every recorder', () => {
    const ep = { provider: 'p1', model: 'm1' };
    const snapshot = JSON.stringify(ep);
    recordRequest('a1', ep, 1000, { turn: 0, step: 0 });
    recordFailure('a1', ep, 'SERVER', 5000, 1500, { turn: 0, step: 0 });
    recordFailover('a1', ep, ep, 1600);
    recordFailover('a1', undefined, ep, 1700);
    expect(JSON.stringify(ep)).toBe(snapshot);
    expect(ep).toEqual({ provider: 'p1', model: 'm1' });
  });
});

describe('Round 27: ring ordering under interleaved agents', () => {
  it('appends events in call order across agents', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordRequest('a2', P2, 1001, { turn: 0, step: 0 });
    recordFailure('a1', P1, 'SERVER', undefined, 1002);
    recordFailover('a1', P1, P2, 1003);
    recordTurnSuccess('a2', undefined, 1004);
    expect(getRecentEvents().map((e) => `${e.agentId}:${e.type}`)).toEqual([
      'a1:request',
      'a2:request',
      'a1:failure',
      'a1:failover',
      'a2:success'
    ]);
  });
});

describe('Round 28: non-finite explicit token overrides', () => {
  it('does not corrupt tokensTotal with NaN', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', Number.NaN, 2000);
    const s = stat('p1::m1')!;
    expect(Number.isFinite(s.tokensTotal)).toBe(true);
    expect(s.tokensTotal).toBe(0);
    expect(successEvents()[0]?.tokens).toBeUndefined();
  });

  it('does not corrupt tokensTotal with Infinity', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', Number.POSITIVE_INFINITY, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
  });
});

describe('Round 29: failure-latency max/last ordering', () => {
  it('max never decreases and last is the most recent failure', () => {
    recordRequest('a1', P1, 0);
    recordFailure('a1', P1, 'SERVER', undefined, 5000); // 5000
    recordRequest('a1', P1, 6000);
    recordFailure('a1', P1, 'TIMEOUT', undefined, 6100); // 100
    expect(stat('p1::m1')).toMatchObject({
      latencySamples: 2,
      latencyTotalMs: 5100,
      latencyMaxMs: 5000,
      lastLatencyMs: 100
    });
  });
});

describe('Round 30: a zero cooldown hint still counts', () => {
  it('counts hintMs=0 and keeps the newest failure code', () => {
    recordFailure('a1', P1, 'RATE_LIMIT', 0, 1000);
    recordFailure('a1', P1, 'SERVER', undefined, 2000);
    expect(stat('p1::m1')).toMatchObject({
      failures: 2,
      cooldownHints: 1,
      lastFailureCode: 'SERVER',
      lastFailureAt: 2000
    });
    expect(getRecentEvents().find((e) => e.type === 'failure')?.hintMs).toBe(0);
  });
});

describe('Round 31: the token mark survives a turn boundary', () => {
  it('attributes only the delta to the next turn', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordTurnSuccess('a1', undefined, 2000);
    recordRequest('a1', P1, 3000, { turn: 1, step: 0 });
    expect(recordTokenSample('a1', 1500, 3100)).toBe(500);
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')?.tokensTotal).toBe(1500);
  });
});

describe('Round 32: a replaced span does not leak its pending tokens', () => {
  it('attributes only the surviving attempt on a same-step retry', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordRequest('a1', P2, 1200, { turn: 0, step: 0 }); // replaced: pending dropped
    recordTokenSample('a1', 1500, 1300);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
    expect(stat('p2::m2')?.tokensTotal).toBe(500);
  });
});

describe('Round 33: a poisoned span never leaks tokens into the next step', () => {
  it('drops the failed attempt tokens and attributes the next step only', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordFailure('a1', P1, 'RATE_LIMIT', undefined, 1200, { turn: 0, step: 0 });
    recordRequest('a1', P1, 2000, { turn: 0, step: 1 });
    recordTokenSample('a1', 1600, 2100);
    recordTurnSuccess('a1', undefined, 3000);
    expect(stat('p1::m1')).toMatchObject({ successes: 1, tokensTotal: 600, failures: 1 });
  });
});

describe('Round 34: nested endpoint copies on every event type', () => {
  it('mutating a returned failure/failover event never reaches internal state', () => {
    recordFailure('a1', P1, 'SERVER', undefined, 1000);
    recordFailover('a1', P1, P2, 1100);
    const events = getRecentEvents();
    events.find((e) => e.type === 'failure')!.from!.provider = 'tampered';
    events.find((e) => e.type === 'failover')!.to!.model = 'tampered';
    const again = getRecentEvents();
    expect(again.find((e) => e.type === 'failure')!.from).toEqual(P1);
    expect(again.find((e) => e.type === 'failover')!.to).toEqual(P2);
  });
});

describe('Round 35: resetTelemetry resets the debug mode', () => {
  it('returns to auto so a later env flag is honoured', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      setDebugLogging(true);
      resetTelemetry();
      recordRequest('a1', P1, 1000);
      expect(spy).not.toHaveBeenCalled();
      process.env['DSH_ORCHESTRATOR_DEBUG'] = '1';
      recordRequest('a2', P1, 1001);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      delete process.env['DSH_ORCHESTRATOR_DEBUG'];
    }
  });
});

describe('Round 36: multi-step turn token attribution', () => {
  it('sums per-step deltas to the final cumulative total across three steps', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 500, 1100)).toBe(500);
    recordRequest('a1', P1, 2000, { turn: 0, step: 1 }); // closes step0: +500
    expect(recordTokenSample('a1', 900, 2100)).toBe(400);
    recordRequest('a1', P1, 3000, { turn: 0, step: 2 }); // closes step1: +400
    expect(recordTokenSample('a1', 1200, 3100)).toBe(300);
    recordTurnSuccess('a1', undefined, 4000); // closes step2: +300

    expect(stat('p1::m1')).toMatchObject({ successes: 3, tokensTotal: 1200 });
    expect(successEvents().map((e) => e.tokens)).toEqual([500, 400, 300]);
  });
});

describe('Round 37: token marks are per agent', () => {
  it('keeps two agents cumulative meters independent', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordRequest('a2', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 1000, 1100)).toBe(1000);
    expect(recordTokenSample('a2', 700, 1100)).toBe(700);
    recordTurnSuccess('a1', undefined, 2000);
    recordTurnSuccess('a2', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(1700);
  });
});

describe('Round 38: overlapping same-agent request starts', () => {
  it('measures failure latency from the most recent start', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a1', P1, 4000); // overwrites the single per-agent start slot
    recordFailure('a1', P1, 'SERVER', undefined, 4500);
    expect(stat('p1::m1')).toMatchObject({ latencySamples: 1, latencyTotalMs: 500 });
    expect(getInFlightRequests()).toBe(0);
  });
});

describe('Round 39: a poisoned span close reports true but samples nothing', () => {
  it('returns true, emits no success, and leaves the counter untouched', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    poisonSuccessSpan('a1', 0, 0);
    expect(recordTurnSuccess('a1', undefined, 2000)).toBe(true);
    expect(stat('p1::m1')).toMatchObject({ successes: 0, successLatencySamples: 0 });
    expect(successEvents()).toHaveLength(0);
  });
});

describe('Round 40: the ring never exceeds the cap', () => {
  it('caps at MAX_EVENT_BUFFER after an off-by-one overflow push', () => {
    for (let i = 0; i < MAX_EVENT_BUFFER; i++) recordRequest(`a-${i}`, P1, i);
    expect(getRecentEvents(MAX_EVENT_BUFFER)).toHaveLength(MAX_EVENT_BUFFER);
    // One past the boundary: length must stay at the cap, not grow.
    recordRequest('overflow', P1, 999);
    const all = getRecentEvents(MAX_EVENT_BUFFER);
    expect(all).toHaveLength(MAX_EVENT_BUFFER);
    expect(all.some((e) => e.agentId === 'overflow')).toBe(true);
    expect(all.some((e) => e.agentId === 'a-0')).toBe(false);
  });
});

describe('Round 41: a first sample creates the endpoint entry', () => {
  it('attributes a success span for an endpoint never seen by recordRequest', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    // Same agent, later step on a different endpoint: the step-0 span closes
    // against the endpoint that served it even if only recordRequest saw it.
    recordRequest('a1', P2, 2000, { turn: 0, step: 1 });
    expect(stat('p1::m1')).toMatchObject({ requests: 1, successes: 1 });
    expect(stat('p2::m2')).toMatchObject({ requests: 1, successes: 0 });
  });
});

describe('Round 42: non-finite failure timestamps', () => {
  it('does not let a NaN clock poison the failure-latency total', () => {
    recordRequest('a1', P1, 1000);
    recordFailure('a1', P1, 'SERVER', undefined, Number.NaN);
    const s = stat('p1::m1')!;
    // The failure itself is still counted; only the non-finite latency sample
    // is refused, so the running aggregate can never become NaN.
    expect(s.failures).toBe(1);
    expect(Number.isFinite(s.latencyTotalMs)).toBe(true);
    expect(s.latencyTotalMs).toBe(0);
    expect(s.latencyMaxMs).toBe(0);
    expect(s.lastLatencyMs).toBeNull();
  });
});

describe('Round 43: non-finite success timestamps', () => {
  it('does not let a NaN clock poison the success-latency total', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, Number.NaN);
    const s = stat('p1::m1')!;
    // A closed span is still a success; the non-finite latency is refused.
    expect(s.successes).toBe(1);
    expect(Number.isFinite(s.successLatencyTotalMs)).toBe(true);
    expect(s.successLatencyTotalMs).toBe(0);
    expect(s.successLatencyMaxMs).toBe(0);
    expect(s.lastSuccessLatencyMs).toBeNull();
    expect(successEvents()[0]?.successLatencyMs).toBeUndefined();
  });
});

describe('Round 44: a non-finite span OPEN timestamp poisons nothing', () => {
  it('refuses both latency aggregates when the request start is non-finite', () => {
    recordRequest('a1', P1, Number.NaN, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000);
    recordRequest('a2', P1, Number.NaN);
    recordFailure('a2', P1, 'SERVER', undefined, 3000);
    const s = stat('p1::m1')!;
    expect(Number.isFinite(s.successLatencyTotalMs)).toBe(true);
    expect(Number.isFinite(s.latencyTotalMs)).toBe(true);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(1);
    expect(s.successLatencySamples).toBe(0);
    expect(s.latencySamples).toBe(0);
  });
});

describe('Round 45: poisoning does not survive span replacement', () => {
  it('lets a retried step succeed after its first attempt was poisoned', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    poisonSuccessSpan('a1', 0, 0);
    // The retry opens a FRESH span for the same (turn, step) and is not poisoned.
    recordRequest('a1', P2, 1500, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.successes).toBe(0);
    expect(stat('p2::m2')).toMatchObject({ successes: 1, successLatencyTotalMs: 500 });
  });
});

describe('Round 46: a turn advance with no step numbers still closes the span', () => {
  it('closes a turn-only span as a success when the next turn starts', () => {
    recordRequest('a1', P1, 1000, { turn: 0 });
    recordRequest('a1', P1, 2500, { turn: 1 }); // turn advance -> close turn 0
    expect(stat('p1::m1')).toMatchObject({ successes: 1, successLatencyTotalMs: 1500 });
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')?.successes).toBe(2);
  });
});

describe('Round 47: a non-finite override must not swallow the sampled deltas', () => {
  it('falls back to the span pending tokens when the override is non-finite', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 500, 1100); // a real measured delta
    // The meter exploded: the override is not a measurement, so the span's
    // own sampled delta must still attribute (round-2 intent: 'treat as absent').
    recordTurnSuccess('a1', Number.NaN, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(500);
    expect(successEvents()[0]?.tokens).toBe(500);
  });
});

describe('Round 48: success events are deep-copied like the others', () => {
  it('mutating a returned success event never reaches internal state', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, 2000);
    const [ev] = successEvents();
    ev.to!.provider = 'tampered';
    expect(successEvents()[0].to).toEqual(P1);
  });
});

describe('Round 49: a drained ring and a later snapshot stay independent', () => {
  it('keeps drained events independent of the next event batch', () => {
    recordRequest('a1', P1, 1000);
    const drained = drainRecentEvents();
    drained[0].to!.model = 'tampered';
    recordRequest('a2', P2, 2000);
    const [next] = getRecentEvents();
    expect(next.agentId).toBe('a2');
    expect(next.to).toEqual(P2);
  });
});

describe('Round 50: a refused latency omits the event field entirely', () => {
  it('emits no successLatencyMs key rather than a null/NaN', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, Number.NaN);
    const ev = successEvents()[0];
    expect('successLatencyMs' in ev).toBe(false);
    expect(JSON.parse(JSON.stringify(ev))).not.toHaveProperty('successLatencyMs');
  });
});

describe('Round 51: a refused success sample is not sticky', () => {
  it('lets a later finite span set lastSuccessLatencyMs again', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, Number.NaN);
    expect(stat('p1::m1')?.lastSuccessLatencyMs).toBeNull();
    recordRequest('a1', P1, 5000, { turn: 0, step: 1 });
    recordTurnSuccess('a1', undefined, 5200);
    expect(stat('p1::m1')).toMatchObject({
      successes: 2,
      successLatencySamples: 1,
      successLatencyTotalMs: 200,
      lastSuccessLatencyMs: 200
    });
  });
});

describe('Round 52: a refused failure sample is not sticky', () => {
  it('lets a later finite failure set lastLatencyMs again', () => {
    recordRequest('a1', P1, 1000);
    recordFailure('a1', P1, 'SERVER', undefined, Number.NaN);
    expect(stat('p1::m1')?.lastLatencyMs).toBeNull();
    recordRequest('a1', P1, 3000);
    recordFailure('a1', P1, 'TIMEOUT', undefined, 3400);
    expect(stat('p1::m1')).toMatchObject({
      failures: 2,
      latencySamples: 1,
      latencyTotalMs: 400,
      lastLatencyMs: 400
    });
  });
});

describe('Round 53: an unqualified poison hits a meta-less span', () => {
  it('suppresses a span opened without turn/step', () => {
    recordRequest('a1', P1, 1000);
    poisonSuccessSpan('a1', undefined, undefined);
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.successes).toBe(0);
  });
});

describe('Round 54: a same-step replacement does not resurrect a stale mark', () => {
  it('attributes the retry delta from the pre-retry cumulative total', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 1000, 1100);
    recordRequest('a1', P2, 1200, { turn: 0, step: 0 }); // replaced
    expect(recordTokenSample('a1', 1400, 1300)).toBe(400); // not 1400
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p2::m2')?.tokensTotal).toBe(400);
  });
});

describe('Round 55: distinct providers sharing a model never merge', () => {
  it('keeps p1::m and p2::m as separate entries (control for the collision)', () => {
    recordRequest('a1', { provider: 'p1', model: 'm' }, 1000);
    recordRequest('a2', { provider: 'p2', model: 'm' }, 1001);
    const stats = getEndpointStats();
    expect(stats).toHaveLength(2);
    expect(stats.map((s) => s.key).sort()).toEqual(['p1::m', 'p2::m']);
  });
});

describe('Round 56: a non-finite failure clock must not poison lastFailureAt', () => {
  it('refuses the bad timestamp but still records the failure and its code', () => {
    recordFailure('a1', P1, 'SERVER', undefined, Number.NaN);
    let s = stat('p1::m1')!;
    expect(s.failures).toBe(1);
    expect(s.lastFailureCode).toBe('SERVER'); // the fact is known
    // NaN is not a timestamp: JSON.stringify turns it into null, which is
    // indistinguishable from 'never failed'. Refuse it (stay at the
    // documented pre-first-sample null) rather than store a lying value.
    expect(s.lastFailureAt).toBeNull();
    expect(JSON.parse(JSON.stringify(s)).lastFailureAt).toBeNull();
  });

  it('preserves a prior finite timestamp instead of overwriting it with NaN', () => {
    recordFailure('a1', P1, 'SERVER', undefined, 5000);
    recordFailure('a1', P1, 'TIMEOUT', undefined, Number.NaN);
    const s = stat('p1::m1')!;
    expect(s.failures).toBe(2);
    expect(s.lastFailureAt).toBe(5000); // untouched by the bad clock
    expect(s.lastFailureCode).toBe('TIMEOUT');
  });
});

describe('Round 57: a non-finite event timestamp is still recorded verbatim', () => {
  it('does not drop the event just because its clock is bad', () => {
    recordRequest('a1', P1, Number.NaN);
    const [ev] = getRecentEvents();
    expect(ev.type).toBe('request');
    expect(ev.agentId).toBe('a1');
  });
});

describe('Round 58: getEndpointStats order is first-seen and stable', () => {
  it('does not reorder on a later touch of an existing endpoint', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a2', P2, 1001);
    recordRequest('a3', P1, 1002); // existing key, must not move
    expect(getEndpointStats().map((s) => s.key)).toEqual(['p1::m1', 'p2::m2']);
  });
});

describe('Round 59: a failure with an explicit finite clock after a refused one', () => {
  it('records the latency against the right start', () => {
    recordRequest('a1', P1, 1000);
    recordFailure('a1', P1, 'SERVER', undefined, Number.NaN); // refuses sample, consumes start
    expect(getInFlightRequests()).toBe(0);
    recordRequest('a1', P1, 5000);
    recordFailure('a1', P1, 'SERVER', undefined, 5500);
    expect(stat('p1::m1')).toMatchObject({ failures: 2, latencySamples: 1, latencyTotalMs: 500 });
  });
});

describe('Round 60: the non-finite-override fallback must not swallow a finite negative', () => {
  it('pins the documented asymmetry: a negative override clamps to 0', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTokenSample('a1', 500, 1100);
    // A finite negative override is still an explicit (if nonsensical) value:
    // the round-2 contract clamps it to 0 rather than falling back. Only a
    // NON-finite override falls back to the span's own deltas (Round 47).
    recordTurnSuccess('a1', -100, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
    expect(successEvents()[0]?.tokens).toBe(0);
  });
});

describe('Round 61: a refused sample keeps successes and latencySamples independent', () => {
  it('counts the success but no latency sample, and the mean stays defined', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', undefined, Number.NaN); // refused sample
    recordRequest('a1', P1, 4000, { turn: 0, step: 1 });
    recordTurnSuccess('a1', undefined, 4300); // finite: 300ms
    const s = stat('p1::m1')!;
    expect(s.successes).toBe(2);
    expect(s.successLatencySamples).toBe(1);
    expect(s.successLatencyTotalMs / s.successLatencySamples).toBe(300);
  });
});

describe('Round 62: getInFlightRequests is a size, not a list', () => {
  it('returns a number that forgetAgent decrements exactly once', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a2', P1, 1001);
    expect(getInFlightRequests()).toBe(2);
    forgetAgent('a1');
    expect(getInFlightRequests()).toBe(1);
    forgetAgent('a1'); // idempotent
    expect(getInFlightRequests()).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Round 3 (R3B): telemetry-side state that outlives a single test: leak bounds,
// falsy boundaries, mark lifecycle, and ordering. Distinct R3B- prefix from the
// sibling agent's R3 blocks already in this file.
// ---------------------------------------------------------------------------

describe('R3B-Round 15: success does not release the in-flight start (documented)', () => {
  it('leaks one start per successful agent until forgetAgent runs', () => {
    for (let i = 0; i < 100; i++) {
      recordRequest('ok-' + i, P1, 1000 + i, { turn: 0, step: 0 });
      recordTurnSuccess('ok-' + i, undefined, 2000 + i);
    }
    // A turn close samples the span but never consumes requestStarts; only
    // recordFailure or forgetAgent release a start. This is the documented
    // contract that makes agent/disposed mandatory for leak-free operation.
    expect(getInFlightRequests()).toBe(100);
    for (let i = 0; i < 100; i++) forgetAgent('ok-' + i);
    expect(getInFlightRequests()).toBe(0);
  });
});

describe('R3B-Round 16: a token sample with no open span sets no mark', () => {
  it('returns null, then the first real sample is the full cumulative total', () => {
    expect(recordTokenSample('ghost', 500, 1000)).toBeNull();
    recordRequest('ghost', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('ghost', 500, 1100)).toBe(500);
    recordTurnSuccess('ghost', undefined, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(500);
  });
});

describe('R3B-Round 17: resetTelemetry re-baselines a reused agent id', () => {
  it('does not let a previous lifecycle mark survive the reset', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 1000, 1100)).toBe(1000);
    recordTurnSuccess('a1', undefined, 2000);
    resetTelemetry(); // index.ts dispose path
    recordRequest('a1', P1, 3000, { turn: 0, step: 0 });
    expect(recordTokenSample('a1', 400, 3100)).toBe(400);
    recordTurnSuccess('a1', undefined, 4000);
    expect(stat('p1::m1')?.tokensTotal).toBe(400);
  });
});

describe('R3B-Round 18: getRecentEvents(1) is the newest event only', () => {
  it('returns exactly the last event at the limit-1 boundary', () => {
    recordRequest('a1', P1, 1000);
    recordRequest('a2', P2, 1001);
    recordRequest('a3', P1, 1002);
    const one = getRecentEvents(1);
    expect(one).toHaveLength(1);
    expect(one[0].agentId).toBe('a3');
  });
});

describe('R3B-Round 19: poison targeting is precise on turn-only / step-only', () => {
  it('does not poison a span whose turn matches but step differs', () => {
    recordRequest('a1', P1, 1000, { turn: 4, step: 1 });
    poisonSuccessSpan('a1', 4, 2); // same turn, different step
    recordTurnSuccess('a1', undefined, 2000);
    expect(stat('p1::m1')?.successes).toBe(1);
  });
});

describe('R3B-Round 20: a turn advance with no step samples the previous span', () => {
  it('closes turn 0 on the p1 span and opens turn 1', () => {
    recordRequest('a1', P1, 1000, { turn: 0 });
    recordRequest('a1', P2, 2500, { turn: 1 });
    expect(stat('p1::m1')).toMatchObject({ successes: 1, successLatencyTotalMs: 1500 });
    recordTurnSuccess('a1', undefined, 3000);
    expect(stat('p2::m2')).toMatchObject({ successes: 1, successLatencyTotalMs: 500 });
  });
});

describe('R3B-Round 21: a zero timestamp is preserved, not defaulted', () => {
  it('keeps at === 0 on request and failure events', () => {
    recordRequest('a1', P1, 0);
    recordFailure('a1', P1, 'SERVER', undefined, 0);
    const events = getRecentEvents();
    expect(events[0].at).toBe(0);
    expect(events[1].at).toBe(0);
    expect(stat('p1::m1')).toMatchObject({ latencySamples: 1, latencyTotalMs: 0, lastLatencyMs: 0 });
    expect(events[1].latencyMs).toBe(0);
  });
});

describe('R3B-Round 22: an explicit zero-token close is a real measurement', () => {
  it('emits tokens: 0 and keeps tokensTotal at 0 (not undefined)', () => {
    recordRequest('a1', P1, 1000, { turn: 0, step: 0 });
    recordTurnSuccess('a1', 0, 2000);
    expect(stat('p1::m1')?.tokensTotal).toBe(0);
    expect(successEvents()[0]?.tokens).toBe(0);
  });
});

describe('R3B-Round 23: success latency max/last across three samples', () => {
  it('tracks a non-monotonic sequence correctly', () => {
    recordRequest('a1', P1, 0, { turn: 0, step: 0 });
    recordRequest('a1', P1, 1000, { turn: 0, step: 1 });
    recordRequest('a1', P1, 1200, { turn: 0, step: 2 });
    recordTurnSuccess('a1', undefined, 1700);
    expect(stat('p1::m1')).toMatchObject({
      successes: 3,
      successLatencySamples: 3,
      successLatencyTotalMs: 1700,
      successLatencyMaxMs: 1000,
      lastSuccessLatencyMs: 500
    });
  });
});

describe('R3B-Round 24: stat order is first-seen and stable', () => {
  it('appends a new endpoint at the end and keeps prior positions', () => {
    recordRequest('a1', P2, 1000);
    recordRequest('a2', P1, 1001);
    expect(getEndpointStats().map((s) => s.key)).toEqual(['p2::m2', 'p1::m1']);
    recordRequest('a3', P2, 1002);
    recordRequest('a4', { provider: 'p3', model: 'm3' }, 1003);
    expect(getEndpointStats().map((s) => s.key)).toEqual(['p2::m2', 'p1::m1', 'p3::m3']);
  });
});
