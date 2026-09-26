import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDiagnosticsSnapshot, formatDiagnostics } from '../src/diagnostics.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_FAILURES } from '../src/health.js';
import { resetTelemetry, recordRequest, recordFailure, recordFailover } from '../src/telemetry.js';
import { DEFAULT_RETRY_INTERVAL_MIN_MS, DEFAULT_RETRY_INTERVAL_MAX_MS } from '../src/index.js';

const TMP = path.join(os.tmpdir(), `dsh-diag-logic-${process.pid}-${Date.now()}`);
const TMP_FILE = path.join(TMP, 'settings.yaml');

const ep = (provider: string, model: string) => ({ provider, model });

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  resetConfigForTest(TMP_FILE);
  resetTelemetry();
  defaultCircuitBreaker.clear();
});

afterEach(() => {
  disposeWatcher();
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Round 1: the snapshot is strictly non-mutating (tripped-then-elapsed)', () => {
  it('does not transition a tripped endpoint to probation, even when the cooldown has exactly elapsed', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    // Trip at t=1000 for 60s -> trippedUntil = 61000.
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    expect(defaultCircuitBreaker.getStatus(ep('p1', 'm1')).trippedUntil).toBe(61_000);

    // now === trippedUntil: a naive isHealthy() call would clear the trip.
    const snapshot = getDiagnosticsSnapshot(61_000);

    expect(snapshot.endpoints[0]!.breaker.healthy).toBe(true);
    expect(snapshot.endpoints[0]!.breaker.trippedUntil).toBe(61_000);
    // The live status must be untouched: not cleared, streak not reset.
    const after = defaultCircuitBreaker.getStatus(ep('p1', 'm1'));
    expect(after.trippedUntil).toBe(61_000);
    expect(after.consecutiveFailures).toBe(1);

    // Control: the real isHealthy() DOES perform the probation write.
    expect(defaultCircuitBreaker.isHealthy(ep('p1', 'm1'), 61_000)).toBe(true);
    expect(defaultCircuitBreaker.getStatus(ep('p1', 'm1')).trippedUntil).toBeNull();
  });

  it('leaves state untouched when the cooldown has not elapsed either', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);

    const snapshot = getDiagnosticsSnapshot(60_999);
    expect(snapshot.endpoints[0]!.breaker.healthy).toBe(false);
    expect(defaultCircuitBreaker.getStatus(ep('p1', 'm1')).trippedUntil).toBe(61_000);
  });

  it('is idempotent: repeated reads never change breaker state', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);

    for (let i = 0; i < 5; i++) getDiagnosticsSnapshot(999_999);
    const after = defaultCircuitBreaker.getStatus(ep('p1', 'm1'));
    expect(after.trippedUntil).toBe(61_000);
    expect(after.consecutiveFailures).toBe(1);
  });
});

describe('Round 2: deriveBreakerDiagnostics boundary', () => {
  it('now === trippedUntil is healthy', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    expect(getDiagnosticsSnapshot(61_000).endpoints[0]!.breaker.healthy).toBe(true);
  });

  it('now === trippedUntil - 1 is not healthy', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    expect(getDiagnosticsSnapshot(60_999).endpoints[0]!.breaker.healthy).toBe(false);
  });

  it('trippedUntil === null is healthy and reports null', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const b = getDiagnosticsSnapshot(1000).endpoints[0]!.breaker;
    expect(b.healthy).toBe(true);
    expect(b.trippedUntil).toBeNull();
    expect(b.consecutiveFailures).toBe(0);
    expect(b.lastFailureAt).toBeNull();
  });
});
describe('Round 3: empty/missing/malformed config never throws', () => {
  it('is safe before any config load (pristine pre-apply state)', () => {
    expect(fs.existsSync(TMP_FILE)).toBe(false);
    let snapshot!: ReturnType<typeof getDiagnosticsSnapshot>;
    expect(() => { snapshot = getDiagnosticsSnapshot(1000); }).not.toThrow();
    expect(snapshot.configPresent).toBe(false);
    expect(snapshot.orchestration.active).toBe(false);
    expect(snapshot.effectivePoolSize).toBe(0);
    expect(snapshot.endpoints).toEqual([]);
  });

  it('is safe when the settings file exists but is malformed YAML', () => {
    fs.writeFileSync(TMP_FILE, 'subagents-orchestrator: [unclosed\n  : : :\n\t- bad', 'utf8');
    let snapshot!: ReturnType<typeof getDiagnosticsSnapshot>;
    expect(() => { snapshot = getDiagnosticsSnapshot(1000); }).not.toThrow();
    expect(snapshot.configPresent).toBe(false);
    expect(snapshot.endpoints).toEqual([]);
  });

  it('is safe when the settings file is valid YAML without the section', () => {
    fs.writeFileSync(TMP_FILE, 'other-plugin:\n  foo: 1\n', 'utf8');
    const snapshot = getDiagnosticsSnapshot(1000);
    expect(snapshot.configPresent).toBe(false);
    expect(snapshot.effectivePoolSize).toBe(0);
  });

  it('is safe when the settings file is empty', () => {
    fs.writeFileSync(TMP_FILE, '', 'utf8');
    expect(() => getDiagnosticsSnapshot(1000)).not.toThrow();
  });
});

describe('Round 4: configPresent semantics (missing file still counts as loaded)', () => {
  it('reads a missing file as config-missing and does not re-probe the disk', () => {
    const first = getDiagnosticsSnapshot(1000);
    expect(first.configPresent).toBe(false);

    // The cache is now "loaded" (with null), so later snapshots are pure memory reads.
    const spy = vi.spyOn(fs, 'existsSync');
    try {
      getDiagnosticsSnapshot(2000);
      getDiagnosticsSnapshot(3000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports config-present for a file carrying an empty section', () => {
    fs.writeFileSync(TMP_FILE, 'subagents-orchestrator: {}\n', 'utf8');
    const snapshot = getDiagnosticsSnapshot(1000);
    expect(snapshot.configPresent).toBe(true);
    expect(snapshot.orchestration.active).toBe(true); // enabled unset -> active
  });
});

describe('Round 5: orchestration.active (enabled unset vs true vs false)', () => {
  it('unset -> active', () => {
    setConfigForTest({ endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.active).toBe(true);
  });

  it('true -> active', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.active).toBe(true);
  });

  it('false -> inactive', () => {
    setConfigForTest({ enabled: false, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.active).toBe(false);
  });

  it('null config -> inactive', () => {
    setConfigForTest(null);
    expect(getDiagnosticsSnapshot(1).orchestration.active).toBe(false);
  });
});

describe('Round 6: documented defaults when config is null', () => {
  it('fills every numeric/enum switch with its documented default', () => {
    setConfigForTest(null);
    const o = getDiagnosticsSnapshot(1).orchestration;
    expect(o.strategy).toBe('round-robin');
    expect(o.cooldownMs).toBe(3_600_000);
    expect(o.maxFailures).toBe(3);
    expect(o.retryIntervalMinMs).toBe(3000);
    expect(o.retryIntervalMaxMs).toBe(5000);
    // No field may be undefined/null: the format pass would print "undefined".
    for (const [k, v] of Object.entries(o)) expect(v, k + ' must be defined').toBeDefined();
  });

  it('applies the same defaults for an empty (present) config', () => {
    setConfigForTest({});
    const o = getDiagnosticsSnapshot(1).orchestration;
    expect(o.strategy).toBe('round-robin');
    expect(o.cooldownMs).toBe(3_600_000);
    expect(o.maxFailures).toBe(3);
    expect(o.retryIntervalMinMs).toBe(3000);
    expect(o.retryIntervalMaxMs).toBe(5000);
  });
});

describe('Round 5b: failover is an EFFECTIVE switch (runtime default is ON)', () => {
  // index.ts: only an explicit `failover: false` disables the failover walk
  // (failover defaults to on, README line 81). The snapshot field is documented
  // as an "effective runtime switch, exactly as the plugin treats them".
  it('reports failover engaged when the key is unset (runtime default)', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.failover).toBe(true);
  });

  it('reports failover engaged when explicitly true', () => {
    setConfigForTest({ enabled: true, failover: true, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.failover).toBe(true);
  });

  it('reports failover disengaged only for explicit false', () => {
    setConfigForTest({ enabled: true, failover: false, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).orchestration.failover).toBe(false);
  });
});
describe('Round 7: parked endpoints are in config but out of the pool', () => {
  it('marks parked entries inPool=false and excludes them from the pool count', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [ep('p1', 'm1'), { ...ep('p2', 'm2'), enabled: false }, ep('p3', 'm3')]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.effectivePoolSize).toBe(2);
    expect(s.endpoints.map((e) => [e.key, e.inPool])).toEqual([
      ['p1::m1', true],
      ['p2::m2', false],
      ['p3::m3', true]
    ]);
    expect(s.endpoints.filter((e) => e.inPool).length).toBe(s.effectivePoolSize);
  });

  it('keeps a parked entry out of the pool even when a duplicate key is pooled', () => {
    // Same identity twice: the parked twin must not be reported as in-pool.
    setConfigForTest({
      enabled: true,
      endpoints: [ep('p1', 'm1'), { ...ep('p1', 'm1'), enabled: false }]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.effectivePoolSize).toBe(1);
    expect(s.endpoints.map((e) => e.inPool)).toEqual([true, false]);
    expect(s.endpoints.filter((e) => e.inPool).length).toBe(s.effectivePoolSize);
  });
});

describe('Round 8: telemetry join by exact key', () => {
  it('reports zeroed counters (not undefined/NaN) for an endpoint with no stats', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const t = getDiagnosticsSnapshot(1).endpoints[0]!.telemetry;
    const numeric = ['requests','failures','failovers','cooldownHints','latencySamples','latencyTotalMs','latencyMaxMs','successes','successLatencySamples','successLatencyTotalMs','successLatencyMaxMs','tokensTotal'] as const;
    for (const k of numeric) {
      expect(t[k], k).toBe(0);
      expect(Number.isNaN(t[k] as number), k + ' must not be NaN').toBe(false);
    }
    expect(t.lastLatencyMs).toBeNull();
    expect(t.lastSuccessLatencyMs).toBeNull();
  });

  it('does not merge stats across different keys', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p1', 'm2'), ep('p2', 'm1')] });
    recordRequest('a1', ep('p1', 'm1'), 1000);
    recordRequest('a1', ep('p1', 'm1'), 1100);
    recordFailure('a1', ep('p2', 'm1'), 'RATE_LIMIT', undefined, 2000);
    recordFailover('a1', ep('p1', 'm2'), ep('p2', 'm1'));

    const s = getDiagnosticsSnapshot(3000);
    const byKey = new Map(s.endpoints.map((e) => [e.key, e.telemetry]));
    expect(byKey.get('p1::m1')!.requests).toBe(2);
    expect(byKey.get('p1::m1')!.failures).toBe(0);
    expect(byKey.get('p1::m2')!.requests).toBe(0);
    expect(byKey.get('p1::m2')!.failures).toBe(0);
    expect(byKey.get('p2::m1')!.requests).toBe(0);
    expect(byKey.get('p2::m1')!.failures).toBe(1);
    expect(byKey.get('p2::m1')!.failovers).toBe(1);
  });

  it('ignores telemetry for keys absent from the config', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    recordRequest('ghost', ep('zz', 'zz'), 1000);
    const s = getDiagnosticsSnapshot(1);
    expect(s.endpoints).toHaveLength(1);
    expect(s.endpoints[0]!.telemetry.requests).toBe(0);
  });
});

describe('Round 9: formatDiagnostics is deterministic and undefined-free', () => {
  it('contains no undefined/NaN for a minimal snapshot', () => {
    setConfigForTest(null);
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).not.toContain('undefined');
    expect(report).not.toContain('NaN');
  });

  it('is byte-identical for the same snapshot, and one line per endpoint', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), { ...ep('p2', 'm2'), enabled: false }] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    const snap = getDiagnosticsSnapshot(2000);
    const a = formatDiagnostics(snap);
    const b = formatDiagnostics(snap);
    expect(a).toBe(b);
    // header + config line + pool line + one per endpoint
    expect(a.split('\n')).toHaveLength(3 + snap.endpoints.length);
  });

  it('renders the failure streak only when non-zero', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const clean = formatDiagnostics(getDiagnosticsSnapshot(1));
    expect(clean).not.toContain('streak=');

    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    const tripped = formatDiagnostics(getDiagnosticsSnapshot(2000));
    expect(tripped).toContain('streak=1');
    expect(tripped).toContain('tripped-until=');
  });
});

describe('Round 10: snapshot is plain, detached data', () => {
  it('JSON-serializes and structured-clones with no cycles', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    const s = getDiagnosticsSnapshot(2000);
    expect(() => JSON.parse(JSON.stringify(s))).not.toThrow();
    expect(() => structuredClone(s)).not.toThrow();
  });

  it('detaches breaker data from the live breaker status object', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    const s = getDiagnosticsSnapshot(2000);

    s.endpoints[0]!.breaker.healthy = false;
    s.endpoints[0]!.breaker.trippedUntil = 0;
    s.endpoints[0]!.breaker.consecutiveFailures = 999;
    s.endpoints[0]!.breaker.lastFailureAt = 0;

    const live = defaultCircuitBreaker.getStatus(ep('p1', 'm1'));
    expect(live.trippedUntil).toBe(61_000);
    expect(live.consecutiveFailures).toBe(1);
    expect(live.lastFailureAt).toBe(1000);
  });

  it('returns independent objects across calls (no shared references)', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const a = getDiagnosticsSnapshot(1);
    const b = getDiagnosticsSnapshot(1);
    expect(a).toEqual(b);
    expect(a.endpoints[0]).not.toBe(b.endpoints[0]);
    expect(a.orchestration).not.toBe(b.orchestration);
  });

  it('holds no reference into the live config (snapshot is detached)', () => {
    const liveEndpoints = [ep('p1', 'm1')];
    setConfigForTest({ enabled: true, endpoints: liveEndpoints });
    const s = getDiagnosticsSnapshot(1);

    // Every nested object is freshly allocated, not the config's.
    expect(s.endpoints).not.toBe(liveEndpoints);
    expect(s.endpoints[0]).not.toBe(liveEndpoints[0]);

    // Mutating the snapshot must not reach the live config entry.
    s.endpoints[0]!.provider = 'tampered';
    s.endpoints[0]!.model = 'tampered';
    expect(liveEndpoints[0]).toEqual({ provider: 'p1', model: 'm1' });
  });
});
describe('Round 11: snapshot defaults are the exported code constants', () => {
  it('matches DEFAULT_COOLDOWN_MS / DEFAULT_MAX_FAILURES / pacing constants', () => {
    setConfigForTest(null);
    const o = getDiagnosticsSnapshot(1).orchestration;
    expect(o.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(o.maxFailures).toBe(DEFAULT_MAX_FAILURES);
    expect(o.retryIntervalMinMs).toBe(DEFAULT_RETRY_INTERVAL_MIN_MS);
    expect(o.retryIntervalMaxMs).toBe(DEFAULT_RETRY_INTERVAL_MAX_MS);
  });
});

describe('Round 12: ui gates are exactly as configured', () => {
  it('absent ui block reads as both off', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).ui).toEqual({ toasts: false, panel: false });
  });

  it('an explicit empty ui block is still both off', () => {
    setConfigForTest({ enabled: true, ui: {}, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).ui).toEqual({ toasts: false, panel: false });
  });

  it('a partial ui block flips only the requested surface', () => {
    setConfigForTest({ enabled: true, ui: { toasts: true }, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).ui).toEqual({ toasts: true, panel: false });
  });

  it('a wrong-typed gate is not coerced to on', () => {
    setConfigForTest({ enabled: true, ui: { toasts: 'yes', panel: 1 } as never, endpoints: [ep('p1', 'm1')] });
    expect(getDiagnosticsSnapshot(1).ui).toEqual({ toasts: false, panel: false });
  });
});

describe('Round 13: a tripped endpoint formats a real ISO instant', () => {
  it('renders tripped-until as a parseable ISO timestamp and never uses 1970', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    const line = formatDiagnostics(getDiagnosticsSnapshot(2000)).split('\n').find((l) => l.includes('p1::m1'))!;
    const iso = line.match(/tripped-until=([^\s\]]+)/)![1]!;
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
    expect(iso).toBe(new Date(61_000).toISOString());
  });
});
