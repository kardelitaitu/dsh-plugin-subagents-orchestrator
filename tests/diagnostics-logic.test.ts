import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDiagnosticsSnapshot, formatDiagnostics } from '../src/diagnostics.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher, reloadConfig, parseConfigDocument } from '../src/config.js';
import { armSettingsPanel, disposeSettings, resetSettingsForTest } from '../src/settings.js';
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
// ---------------------------------------------------------------------------
// Round 2 (this session): deeper adversarial passes over the same module.
// ---------------------------------------------------------------------------

/** A deep, order-insensitive signature of one breaker status, including the
 *  optional trippedSince/recentTrips fields added by the v2 health code. */
function statusSignature(provider: string, model: string): string {
  const s = defaultCircuitBreaker.getStatus(ep(provider, model)) as Record<string, unknown>;
  return JSON.stringify({
    consecutiveFailures: s['consecutiveFailures'],
    trippedUntil: s['trippedUntil'],
    lastFailureAt: s['lastFailureAt'],
    trippedSince: s['trippedSince'] ?? null,
    recentTrips: [...((s['recentTrips'] as number[] | undefined) ?? [])].sort()
  });
}

describe('Round 14: non-mutation still holds under the v2 health fields', () => {
  it('never writes trippedSince or recentTrips while reading a tripped endpoint', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    // Trip three times within the flap window: recentTrips is populated and the
    // extended (flap) penalty is in play — the richest status to disturb.
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 2000);
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 3000);
    const before = statusSignature('p1', 'm1');
    expect(before).toContain('recentTrips');

    // Read at a moment where the naive isHealthy() would clear both tripped
    // fields, and several times over.
    getDiagnosticsSnapshot(10_000_000);
    getDiagnosticsSnapshot(10_000_001);
    getDiagnosticsSnapshot(0);

    expect(statusSignature('p1', 'm1')).toBe(before);
  });

  it('leaves the flap history and the extension ceiling untouched after probation elapses', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 1000, 100);
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 1000, 200);
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 1000, 300);
    const before = statusSignature('p1', 'm1');

    const s = getDiagnosticsSnapshot(999_999);
    expect(s.endpoints[0]!.breaker.healthy).toBe(true);
    expect(statusSignature('p1', 'm1')).toBe(before);

    // Control: isHealthy() at the same instant DOES write (trippedUntil cleared).
    defaultCircuitBreaker.isHealthy(ep('p1', 'm1'), 999_999);
    expect(statusSignature('p1', 'm1')).not.toBe(before);
  });
});

describe('Round 15: effectivePoolSize vs the inPool row count', () => {
  it('agrees for a mix of pooled, parked and duplicated identities', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [
        ep('p1', 'm1'),
        { ...ep('p2', 'm2'), enabled: false },
        ep('p1', 'm1'), // exact duplicate, enabled
        { ...ep('p1', 'm1'), enabled: false }, // duplicate, parked
        ep('p3', 'm3')
      ]
    });
    const s = getDiagnosticsSnapshot(1);
    // extractEndpoints keeps every enabled usable entry: p1::m1 twice, p3::m3.
    expect(s.effectivePoolSize).toBe(3);
    expect(s.endpoints.filter((e) => e.inPool).length).toBe(s.effectivePoolSize);
    expect(s.endpoints.map((e) => e.inPool)).toEqual([true, false, true, false, true]);
    expect(s.endpoints).toHaveLength(5); // every configured row is reported
  });

  it('reports one parked row and one pooled row for a duplicated identity', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [{ ...ep('p1', 'm1'), enabled: false }, ep('p1', 'm1')]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.endpoints.map((e) => [e.key, e.inPool])).toEqual([
      ['p1::m1', false],
      ['p1::m1', true]
    ]);
    expect(s.effectivePoolSize).toBe(1);
    expect(s.endpoints.filter((e) => e.inPool).length).toBe(1);
  });

  it('reports inPool=false for every row when the whole pool is parked', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [{ ...ep('p1', 'm1'), enabled: false }, { ...ep('p2', 'm2'), enabled: false }]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.effectivePoolSize).toBe(0);
    expect(s.endpoints.filter((e) => e.inPool)).toHaveLength(0);
  });
});

describe('Round 16: null config with a stale cached endpoint list', () => {
  it('reports an empty snapshot and does not consult the stale pool', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    expect(getDiagnosticsSnapshot(1).effectivePoolSize).toBe(2);

    // Config now reads as absent (e.g. the file was deleted) while any stale
    // module-level endpoint cache still holds the previous pool.
    setConfigForTest(null);
    const s = getDiagnosticsSnapshot(1);

    expect(s.configPresent).toBe(false);
    expect(s.orchestration.active).toBe(false);
    expect(s.orchestration.failover).toBe(false); // inert without a config
    expect(s.effectivePoolSize).toBe(0);
    expect(s.endpoints).toEqual([]);
    // No row may be resurrected from the stale cache.
    expect(JSON.stringify(s)).not.toContain('p1::m1');
  });
});

describe('Round 17: identity collisions on the provider::model key', () => {
  // KNOWN LIMITATION (reported, not fixed here): the identity scheme is
  // `provider::model` with an unescaped separator, so two distinct endpoints
  // can share a key. The same scheme is used by health.ts and telemetry.ts, so
  // changing it is a repo-wide change, not a diagnostics.ts one. This round
  // pins the observable consequence so the limitation is explicit.
  it('merges two distinct endpoints whose provider/model pair collides on "::"', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [
        { provider: 'a::b', model: 'c' },
        { provider: 'a', model: 'b::c' }
      ]
    });
    // Telemetry attributed to the FIRST endpoint.
    recordRequest('ag1', { provider: 'a::b', model: 'c' }, 1000);

    const s = getDiagnosticsSnapshot(2000);
    expect(s.endpoints.map((e) => e.key)).toEqual(['a::b::c', 'a::b::c']);
    // Both rows observe the same stats: the join cannot tell them apart.
    expect(s.endpoints[0]!.telemetry.requests).toBe(1);
    expect(s.endpoints[1]!.telemetry.requests).toBe(1);
    expect(s.endpoints[0]!.telemetry).toEqual(s.endpoints[1]!.telemetry);
  });

  it('does not merge identities that differ only by case', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('P1', 'm1'), ep('p1', 'm1')] });
    recordRequest('ag1', ep('p1', 'm1'), 1000);
    const s = getDiagnosticsSnapshot(2000);
    const upper = s.endpoints.find((e) => e.key === 'P1::m1')!;
    const lower = s.endpoints.find((e) => e.key === 'p1::m1')!;
    expect(upper.telemetry.requests).toBe(0);
    expect(lower.telemetry.requests).toBe(1);
  });
});

describe('Round 18: a very large endpoint list stays correct and roughly linear', () => {
  it('handles 5000 endpoints correctly without quadratic blow-up', () => {
    const N = 5000;
    const endpoints = Array.from({ length: N }, (_, i) => ep('prov', 'model-' + i));
    setConfigForTest({ enabled: true, endpoints });

    const started = performance.now();
    const s = getDiagnosticsSnapshot(1_000_000);
    const elapsed = performance.now() - started;

    expect(s.endpoints).toHaveLength(N);
    expect(s.effectivePoolSize).toBe(N);
    expect(s.endpoints.every((e) => e.inPool)).toBe(true);
    // Every row joined its own stats bucket: none share an object reference.
    const seen = new Set(s.endpoints.map((e) => e.telemetry));
    expect(seen.size).toBe(N);
    // Generous ceiling: a quadratic pass over 5000 rows would be ~25M ops and
    // this budget would still pass, so pair it with the structural check above.
    expect(elapsed).toBeLessThan(3000);
  });

  it('keeps per-row telemetry distinct at scale (no shared stats object)', () => {
    const N = 500;
    const endpoints = Array.from({ length: N }, (_, i) => ep('prov', 'model-' + i));
    setConfigForTest({ enabled: true, endpoints });
    recordRequest('ag1', ep('prov', 'model-7'), 1000);

    const s = getDiagnosticsSnapshot(2000);
    expect(s.endpoints[7]!.telemetry.requests).toBe(1);
    expect(s.endpoints[8]!.telemetry.requests).toBe(0);
    expect(s.endpoints[7]!.telemetry).not.toBe(s.endpoints[8]!.telemetry);
  });
});

describe('Round 19: formatDiagnostics determinism with duplicate keys', () => {
  it('emits one line per configured row, duplicates included', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [ep('p1', 'm1'), { ...ep('p1', 'm1'), enabled: false }, ep('p1', 'm1')]
    });
    const snap = getDiagnosticsSnapshot(2000);
    const a = formatDiagnostics(snap);
    const b = formatDiagnostics(snap);
    expect(a).toBe(b);
    expect(a.split('\n')).toHaveLength(3 + 3);
    expect(a.match(/^- p1::m1 /gm)).toHaveLength(3);
  });

  it('is deterministic across two independently captured snapshots of the same state', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p1', 'm1')] });
    const a = formatDiagnostics(getDiagnosticsSnapshot(1234));
    const b = formatDiagnostics(getDiagnosticsSnapshot(1234));
    expect(a).toBe(b);
  });
});
describe('Round 20: ISO rendering across the trippedUntil range', () => {
  it('does not throw when a persisted quarantine carries an out-of-range timestamp', () => {
    // A finite but astronomically large quarantine timestamp can reach the
    // breaker from the settings file: config.parseConfigDocument accepts any
    // finite number, and applyQuarantines adopts it verbatim. formatDiagnostics
    // then renders it through new Date(...).toISOString().
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 1e16 }, 0);

    const snap = getDiagnosticsSnapshot(0);
    expect(snap.endpoints[0]!.breaker.healthy).toBe(false);
    expect(snap.endpoints[0]!.breaker.trippedUntil).toBe(1e16);

    const report = formatDiagnostics(snap);
    // The raw epoch value is rendered instead of aborting the whole report.
    expect(report).toContain('tripped-until=10000000000000000');
    expect(report).not.toContain('Invalid Date');
  });

  it('renders a trippedUntil of exactly 0 as the epoch instant', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 0 }, -1000);
    const line = formatDiagnostics(getDiagnosticsSnapshot(-1000)).split('\n').find((l) => l.includes('p1::m1'))!;
    expect(line).toContain('tripped-until=1970-01-01T00:00:00.000Z');
  });

  it('renders a negative trippedUntil without a range error', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': -1 }, -5_000_000_000_000);
    const line = formatDiagnostics(getDiagnosticsSnapshot(-5_000_000_000_000)).split('\n').find((l) => l.includes('p1::m1'))!;
    expect(line).toContain('tripped-until=1969-12-31T23:59:59.999Z');
  });
});

describe('Round 21: configPresent after a reload that transitioned to null', () => {
  it('flips to false when the settings file is deleted out from under a live directory', () => {
    fs.writeFileSync(TMP_FILE, 'subagents-orchestrator:\n  enabled: true\n  endpoints:\n    - provider: p1\n      model: m1\n', 'utf8');
    reloadConfig();
    expect(getDiagnosticsSnapshot(1).configPresent).toBe(true);
    expect(getDiagnosticsSnapshot(1).effectivePoolSize).toBe(1);

    // Delete the FILE but keep the directory: the snapshot-retention branch
    // must not fire, so the cache clears to null.
    fs.rmSync(TMP_FILE);
    reloadConfig();
    const s = getDiagnosticsSnapshot(1);
    expect(s.configPresent).toBe(false);
    expect(s.orchestration.active).toBe(false);
    expect(s.effectivePoolSize).toBe(0);
    expect(s.endpoints).toEqual([]);
  });

  it('reports config-present again once the file returns', () => {
    reloadConfig();
    expect(getDiagnosticsSnapshot(1).configPresent).toBe(false);

    fs.writeFileSync(TMP_FILE, 'subagents-orchestrator:\n  endpoints:\n    - provider: p1\n      model: m1\n', 'utf8');
    reloadConfig();
    const s = getDiagnosticsSnapshot(1);
    expect(s.configPresent).toBe(true);
    expect(s.effectivePoolSize).toBe(1);
  });
});

describe('Round 22: generatedAt is exactly the caller-supplied clock', () => {
  it('echoes an explicitly older now rather than clamping to wall-clock time', () => {
    setConfigForTest(null);
    const older = 1; // 1970-01-01T00:00:00.001Z
    const s = getDiagnosticsSnapshot(older);
    expect(s.generatedAt).toBe(older);
    expect(formatDiagnostics(s)).toContain(new Date(older).toISOString());
  });

  it('is monotonic with respect to the supplied clock across reads', () => {
    setConfigForTest(null);
    const a = getDiagnosticsSnapshot(1000).generatedAt;
    const b = getDiagnosticsSnapshot(2000).generatedAt;
    expect(b).toBeGreaterThan(a);
  });
});

describe('Round 23: telemetry rows are freshly allocated, never live stats', () => {
  it('does not share an object with the telemetry module between reads', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    recordRequest('ag1', ep('p1', 'm1'), 1000);

    const first = getDiagnosticsSnapshot(2000);
    first.endpoints[0]!.telemetry.requests = 999;
    first.endpoints[0]!.telemetry.tokensTotal = 123456;

    const second = getDiagnosticsSnapshot(2000);
    expect(second.endpoints[0]!.telemetry.requests).toBe(1);
    expect(second.endpoints[0]!.telemetry.tokensTotal).toBe(0);
  });

  it('gives every row its own telemetry object even for duplicate keys', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p1', 'm1')] });
    const s = getDiagnosticsSnapshot(1);
    expect(s.endpoints[0]!.telemetry).not.toBe(s.endpoints[1]!.telemetry);
  });
});

describe('Round 24: reading during an in-flight failover walk stays consistent', () => {
  it('never observes a torn snapshot and never perturbs the walk', () => {
    const pool = [ep('p1', 'm1'), ep('p2', 'm2')];
    setConfigForTest({ enabled: true, endpoints: pool });

    // Walk the pool the way the failover machinery does: trip an endpoint,
    // read diagnostics mid-walk, fail over, read again.
    defaultCircuitBreaker.recordFailure(pool[0]!, 1, 60_000, 1000);
    const midWalk = getDiagnosticsSnapshot(2000);
    expect(midWalk.endpoints[0]!.breaker.healthy).toBe(false);
    expect(midWalk.endpoints[1]!.breaker.healthy).toBe(true);

    recordFailover('ag1', pool[0], pool[1]);
    defaultCircuitBreaker.recordSuccess(pool[1]!);
    const afterWalk = getDiagnosticsSnapshot(2000);

    // The source keeps its streak; the target accrued the failover.
    expect(afterWalk.endpoints[0]!.breaker.consecutiveFailures).toBe(1);
    expect(afterWalk.endpoints[0]!.breaker.healthy).toBe(false);
    expect(afterWalk.endpoints[1]!.breaker.healthy).toBe(true);
    expect(afterWalk.endpoints[1]!.telemetry.failovers).toBe(1);

    // The two reads did not disturb the breaker's stored status.
    expect(defaultCircuitBreaker.getStatus(pool[0]!).trippedUntil).toBe(61_000);
    expect(defaultCircuitBreaker.getStatus(pool[0]!).consecutiveFailures).toBe(1);
  });
});

describe('Round 25: endpoints key shape is tolerated', () => {
  it('reports config-present with zero rows for a missing endpoints key', () => {
    setConfigForTest({ enabled: true });
    const s = getDiagnosticsSnapshot(1);
    expect(s.configPresent).toBe(true);
    expect(s.endpoints).toEqual([]);
    expect(s.effectivePoolSize).toBe(0);
  });

  it('reports zero rows for an empty endpoints array', () => {
    setConfigForTest({ enabled: true, endpoints: [] });
    const s = getDiagnosticsSnapshot(1);
    expect(s.endpoints).toEqual([]);
    expect(s.effectivePoolSize).toBe(0);
  });

  it('keeps a single-endpoint array intact', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const s = getDiagnosticsSnapshot(1);
    expect(s.endpoints).toHaveLength(1);
    expect(s.effectivePoolSize).toBe(1);
  });
});

describe('Round 26: a failover source with no prior stats still joins', () => {
  it('creates a zeroed row for the source and counts the failover on the target', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    recordFailover('ag1', ep('p1', 'm1'), ep('p2', 'm2'));

    const s = getDiagnosticsSnapshot(1);
    const src = s.endpoints.find((e) => e.key === 'p1::m1')!;
    const dst = s.endpoints.find((e) => e.key === 'p2::m2')!;
    expect(src.telemetry.requests).toBe(0);
    expect(src.telemetry.failovers).toBe(0);
    expect(dst.telemetry.failovers).toBe(1);
    expect(src.telemetry.lastLatencyMs).toBeNull();
  });
});
describe('Round 27: strategy comes from the validated config', () => {
  it('falls back to round-robin when the file carries an unknown strategy', () => {
    fs.writeFileSync(
      TMP_FILE,
      'subagents-orchestrator:\n  enabled: true\n  strategy: bogus-strategy\n  endpoints:\n    - provider: p1\n      model: m1\n',
      'utf8'
    );
    reloadConfig();
    const s = getDiagnosticsSnapshot(1);
    expect(s.configPresent).toBe(true);
    expect(s.orchestration.strategy).toBe('round-robin');
  });

  it('passes a validated non-default strategy through verbatim', () => {
    fs.writeFileSync(
      TMP_FILE,
      'subagents-orchestrator:\n  enabled: true\n  strategy: weighted\n  endpoints:\n    - provider: p1\n      model: m1\n',
      'utf8'
    );
    reloadConfig();
    expect(getDiagnosticsSnapshot(1).orchestration.strategy).toBe('weighted');
  });
});

describe('Round 28: falsy-but-valid switches are not replaced by defaults', () => {
  it('keeps explicit zeros instead of falling back to the documented defaults', () => {
    setConfigForTest({
      enabled: true,
      cooldownMs: 0,
      maxFailures: 0,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [ep('p1', 'm1')]
    });
    const o = getDiagnosticsSnapshot(1).orchestration;
    expect(o.cooldownMs).toBe(0);
    expect(o.maxFailures).toBe(0);
    expect(o.retryIntervalMinMs).toBe(0);
    expect(o.retryIntervalMaxMs).toBe(0);
  });

  it('keeps explicit negative values verbatim (no silent clamping)', () => {
    setConfigForTest({ enabled: true, cooldownMs: -5, maxFailures: -2, endpoints: [ep('p1', 'm1')] });
    const o = getDiagnosticsSnapshot(1).orchestration;
    expect(o.cooldownMs).toBe(-5);
    expect(o.maxFailures).toBe(-2);
  });
});

describe('Round 29: ui gates reflect config even when routing is inactive', () => {
  it('reports opted-in surfaces alongside active=false', () => {
    setConfigForTest({ enabled: false, ui: { toasts: true, panel: true }, endpoints: [ep('p1', 'm1')] });
    const s = getDiagnosticsSnapshot(1);
    expect(s.orchestration.active).toBe(false);
    expect(s.orchestration.failover).toBe(false);
    expect(s.ui).toEqual({ toasts: true, panel: true });
    // The master `enabled` switch is NOT a parking mechanism: it is reported
    // separately as active=false, while the pool still describes the configured
    // endpoints. Parking is strictly per-entry (`enabled: false` on an entry).
    expect(s.endpoints).toHaveLength(1);
    expect(s.endpoints[0]!.inPool).toBe(true);
    expect(s.effectivePoolSize).toBe(1);
    // Cross-check the distinct signals: master switch off, entry not parked.
    expect(s.orchestration.active).toBe(false);
  });

  it('parks an entry independently of the master switch', () => {
    setConfigForTest({
      enabled: false,
      ui: { toasts: true, panel: true },
      endpoints: [{ ...ep('p1', 'm1'), enabled: false }, ep('p2', 'm2')]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.orchestration.active).toBe(false);
    expect(s.ui).toEqual({ toasts: true, panel: true });
    expect(s.endpoints.map((e) => [e.key, e.inPool])).toEqual([
      ['p1::m1', false],
      ['p2::m2', true]
    ]);
    expect(s.effectivePoolSize).toBe(1);
  });
});

describe('Round 30: report envelope shape', () => {
  it('has exactly one header line and no trailing newline', () => {
    setConfigForTest(null);
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report.endsWith('\n')).toBe(false);
    expect(report.split('\n')[0]).toBe('subagents-orchestrator diagnostics @ 1970-01-01T00:00:00.000Z');
    expect(report.split('\n')).toHaveLength(3);
  });

  it('reports the parked count in the header even with an empty pool', () => {
    setConfigForTest({ enabled: true, endpoints: [{ ...ep('p1', 'm1'), enabled: false }] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).toContain('effective pool: 0 endpoint(s)');
    expect(report).toContain('- p1::m1 [parked healthy');
  });
});

describe('Round 31: healthy boundary at the extremes of the Date range', () => {
  it('derives health correctly for a timestamp near the Date maximum', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const max = 8_640_000_000_000_000; // exactly Date's upper bound
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': max }, 0);

    expect(getDiagnosticsSnapshot(0).endpoints[0]!.breaker.healthy).toBe(false);
    expect(getDiagnosticsSnapshot(max - 1).endpoints[0]!.breaker.healthy).toBe(false);
    expect(getDiagnosticsSnapshot(max).endpoints[0]!.breaker.healthy).toBe(true);
    // And the boundary timestamp renders.
    expect(formatDiagnostics(getDiagnosticsSnapshot(0))).toContain('tripped-until=+275760-09-13T00:00:00.000Z');
  });

  it('treats a trippedUntil in the deep past as healthy', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 1 }, 0);
    expect(getDiagnosticsSnapshot(1_000_000).endpoints[0]!.breaker.healthy).toBe(true);
  });
});

describe('Round 32: generatedAt defaults to a live wall-clock reading', () => {
  it('is a positive finite number when called with no argument', () => {
    setConfigForTest(null);
    const before = Date.now();
    const s = getDiagnosticsSnapshot();
    const after = Date.now();
    expect(Number.isFinite(s.generatedAt)).toBe(true);
    expect(s.generatedAt).toBeGreaterThanOrEqual(before);
    expect(s.generatedAt).toBeLessThanOrEqual(after);
  });
});

describe('Round 33: the pool is the primary endpoint list, not the fallback chain', () => {
  it('reports only primary endpoints and excludes the fallback rescue chain', () => {
    // Documents the current contract: diagnostics.endpoints and
    // effectivePoolSize describe config.endpoints (the primary pool). The
    // fallback chain is a separate tier and is not enumerated here.
    setConfigForTest({
      enabled: true,
      mode: 'fallback',
      endpoints: [ep('p1', 'm1')],
      fallback: [ep('f1', 'm1'), ep('f2', 'm2')]
    });
    const s = getDiagnosticsSnapshot(1);
    expect(s.effectivePoolSize).toBe(1);
    expect(s.endpoints.map((e) => e.key)).toEqual(['p1::m1']);
    expect(JSON.stringify(s)).not.toContain('f1::m1');
  });
});
// ---------------------------------------------------------------------------
// Round 3 of the hunt: the diagnostics <-> settings seam and hard boundaries.
// ---------------------------------------------------------------------------

describe('Round 41: the report keeps one line per endpoint for hostile keys', () => {
  it('does not let a newline in a model forge extra report lines', () => {
    // Reachability through the REAL config trust boundary: parseConfigDocument
    // keeps provider/model verbatim as long as they are non-blank.
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm1\nINJECTED: fake line' }] }
    });
    expect(parsed).not.toBeNull();
    setConfigForTest(parsed);

    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    const lines = report.split('\n');
    // header + config + pool + exactly one endpoint line.
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('INJECTED'))).toHaveLength(0);
  });

  it('does not let a carriage return or tab corrupt the line', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm\rTAB\tEND' }] }
    });
    setConfigForTest(parsed);
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report.split('\n')).toHaveLength(4);
    expect(report).not.toContain('\r');
    expect(report).not.toContain('\t');
  });
});

describe('Round 42: toIsoOrRaw across the whole Date domain', () => {
  function snapshotWithTrippedUntil(trippedUntil: number) {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': trippedUntil }, -1);
    return getDiagnosticsSnapshot(-1);
  }

  it('renders the exact upper bound 8.64e15 and falls back one past it', () => {
    const max = 8_640_000_000_000_000;
    expect(() => formatDiagnostics(snapshotWithTrippedUntil(max))).not.toThrow();
    expect(formatDiagnostics(snapshotWithTrippedUntil(max))).toContain('+275760-09-13T00:00:00.000Z');

    const over = max + 1;
    expect(() => formatDiagnostics(snapshotWithTrippedUntil(over))).not.toThrow();
    expect(formatDiagnostics(snapshotWithTrippedUntil(over))).toContain('tripped-until=8640000000000001');
  });

  it('never emits the literal "undefined" for any finite timestamp', () => {
    for (const v of [-1, 0, 1, max0(), 8_640_000_000_000_000, 1e16]) {
      expect(formatDiagnostics(snapshotWithTrippedUntil(v))).not.toContain('undefined');
    }
    function max0() { return -8_640_000_000_000_000; }
  });

  it('does not throw for an Infinity trippedUntil (reachable: Infinity > now passes the quarantine guard)', () => {
    const snap = snapshotWithTrippedUntil(Infinity);
    expect(snap.endpoints[0]!.breaker.healthy).toBe(false);
    expect(snap.endpoints[0]!.breaker.trippedUntil).toBe(Infinity);
    expect(() => formatDiagnostics(snap)).not.toThrow();
  });
});

describe('Round 43: diagnostics stays non-mutating across a settings dispose window', () => {
  it('does not change breaker state and reports a stable snapshot', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1')] });
    const watchCbs: ((next: unknown) => void)[] = [];
    const ctx = { inject: (_d: string[], cb: (sctx: unknown) => void) => cb({ settings: { register: () => ({ get: () => undefined, watch: (cb2: (n: unknown) => void) => { watchCbs.push(cb2); } }) } }) };
    armSettingsPanel(ctx);
    const future = Date.now() + 600_000;
    watchCbs[0]!({ quarantines: { 'p1::m1': future } });

    const before = getDiagnosticsSnapshot(Date.now());
    expect(before.endpoints[0]!.breaker.healthy).toBe(false);
    const beforeSig = JSON.stringify(defaultCircuitBreaker.getStatus(ep('p1', 'm1')));
    disposeSettings();
    const after = getDiagnosticsSnapshot(Date.now());

    expect(after.endpoints[0]!.breaker).toEqual(before.endpoints[0]!.breaker);
    expect(JSON.stringify(defaultCircuitBreaker.getStatus(ep('p1', 'm1')))).toBe(beforeSig);
  });
});

describe('Round 44: quarantines never change the pool size', () => {
  it('keeps effectivePoolSize stable while every endpoint is quarantined', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    expect(getDiagnosticsSnapshot(0).effectivePoolSize).toBe(2);

    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 50_000, 'p2::m2': 50_000 }, 0);
    const s = getDiagnosticsSnapshot(1000);
    expect(s.effectivePoolSize).toBe(2); // health is not pool membership
    expect(s.endpoints.every((e) => e.inPool)).toBe(true);
    expect(s.endpoints.every((e) => !e.breaker.healthy)).toBe(true);
  });
});

describe('Round 45: two armed scopes both drive the state diagnostics reports', () => {
  it('reflects the union effect of the surviving watch', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    const cbsA: ((n: unknown) => void)[] = [];
    const cbsB: ((n: unknown) => void)[] = [];
    const scope = (sink: ((n: unknown) => void)[]) => ({
      get: () => undefined,
      watch: (cb: (n: unknown) => void) => { sink.push(cb); }
    });
    const settings = { register: (_ns: string, _s: unknown, _o?: unknown) => scope(cbsA) };
    const ctx = { inject: (_d: string[], cb: (sctx: unknown) => void) => cb({ settings }) };
    armSettingsPanel(ctx); // first arm
    const settings2 = { register: () => scope(cbsB) };
    const ctx2 = { inject: (_d: string[], cb: (sctx: unknown) => void) => cb({ settings: settings2 }) };
    armSettingsPanel(ctx2); // second arm replaces the watch

    const future = Date.now() + 600_000;
    cbsB[0]!({ quarantines: { 'p2::m2': future } });
    const s = getDiagnosticsSnapshot(Date.now());
    const p2 = s.endpoints.find((e) => e.key === 'p2::m2')!;
    expect(p2.breaker.healthy).toBe(false);
    expect(s.endpoints.find((e) => e.key === 'p1::m1')!.breaker.healthy).toBe(true);
  });
});

describe('Round 46: a snapshot taken between register and watch', () => {
  it('is safe while the scope exists but its watch is not yet installed', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1')] });
    let snapInsideRegister: ReturnType<typeof getDiagnosticsSnapshot> | null = null;
    const settings = {
      register: () => {
        // Host calls back into us mid-registration.
        snapInsideRegister = getDiagnosticsSnapshot(1000);
        return { get: () => undefined, watch: () => () => {} };
      }
    };
    const ctx = { inject: (_d: string[], cb: (sctx: unknown) => void) => cb({ settings }) };
    expect(() => armSettingsPanel(ctx)).not.toThrow();
    expect(snapInsideRegister).not.toBeNull();
    expect(snapInsideRegister!.endpoints).toHaveLength(1);
    expect(snapInsideRegister!.configPresent).toBe(true);
  });
});

describe('Round 47: formatting a quarantined endpoint whose key repeats', () => {
  it('renders each duplicate row with its own health', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), { ...ep('p1', 'm1'), enabled: false }] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 50_000 }, 0);
    const report = formatDiagnostics(getDiagnosticsSnapshot(1000));
    const rows = report.split('\n').filter((l) => l.startsWith('- p1::m1 '));
    expect(rows).toHaveLength(2);
    // Health is keyed by identity, so both rows show the same trip.
    expect(rows[0]).toContain('tripped-until=');
    expect(rows[1]).toContain('tripped-until=');
    expect(rows[0]).toContain('pool');
    expect(rows[1]).toContain('parked');
  });
});

describe('Round 48: repeated snapshot cycles do not accumulate state', () => {
  it('is byte-stable across 200 read cycles', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    recordRequest('a', ep('p1', 'm1'), 1000);
    defaultCircuitBreaker.recordFailure(ep('p1', 'm1'), 1, 60_000, 1000);

    const first = formatDiagnostics(getDiagnosticsSnapshot(2000));
    for (let i = 0; i < 200; i++) getDiagnosticsSnapshot(2000);
    const last = formatDiagnostics(getDiagnosticsSnapshot(2000));

    expect(last).toBe(first);
    expect(defaultCircuitBreaker.getStatus(ep('p1', 'm1')).trippedUntil).toBe(61_000);
  });
});
describe('Round 49: singleLine escaping stays precise', () => {
  it('leaves a normal identity byte-identical in the report', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).toContain('- p1::m1 [pool healthy req=0 fail=0 failover=0]');
  });

  it('preserves unicode and the :: separator untouched', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('provier-é', 'mödel-ü')] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).toContain('- provier-é::mödel-ü [');
  });

  it('escapes a control character as a visible \\xNN escape', () => {
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p', model: 'a\u0007b' }] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).toContain('a\\x07b');
    expect(report.split('\n')).toHaveLength(4);
  });
});

describe('Round 50: the report escapes the key but the snapshot keeps it raw', () => {
  it('does not truncate or mutate the configured identity in the data model', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm\nx' }] }
    });
    setConfigForTest(parsed);
    const snap = getDiagnosticsSnapshot(0);

    // The data model carries the identity verbatim...
    expect(snap.endpoints[0]!.key).toBe('p::m\nx');
    expect(snap.endpoints[0]!.model).toBe('m\nx');
    // ...while only the human report is made single-line.
    const report = formatDiagnostics(snap);
    expect(report.split('\n')).toHaveLength(4);
    expect(report).not.toContain('\nx [');
  });

  it('the escaped report is deterministic and JSON round-trips the raw snapshot', () => {
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p\u0009q', model: 'm' }] });
    const snap = getDiagnosticsSnapshot(0);
    expect(formatDiagnostics(snap)).toBe(formatDiagnostics(snap));
    expect(JSON.parse(JSON.stringify(snap)).endpoints[0].key).toBe('p\u0009q::m');
  });
});

describe('Round 51: diagnostics after settings dispose reflects breaker state', () => {
  it('still reports a quarantined endpoint and stays non-mutating', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': 50_000 }, 0);
    const sig = JSON.stringify(defaultCircuitBreaker.getStatus(ep('p1', 'm1')));

    disposeSettings();
    const s = getDiagnosticsSnapshot(1000);
    expect(s.endpoints[0]!.breaker.healthy).toBe(false);
    expect(s.endpoints[0]!.breaker.trippedUntil).toBe(50_000);
    expect(JSON.stringify(defaultCircuitBreaker.getStatus(ep('p1', 'm1')))).toBe(sig);
  });
});

// ---------------------------------------------------------------------------
// Round 3, part 2: the singleLine guard's stated purpose is "one endpoint =
// one line". Unicode line separators are line breaks too.
// ---------------------------------------------------------------------------

const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR
const NEL = String.fromCharCode(0x0085); // NEXT LINE
const LINE_BREAKS = new RegExp('\\r\\n|\\r|\\n|' + LS + '|' + PS);

describe('Round 52: Unicode line separators must not forge report lines', () => {
  it('escapes U+2028 (LINE SEPARATOR) in the endpoint identity', () => {
    const parsed = parseConfigDocument({
      'subagents-orchestrator': { endpoints: [{ provider: 'p', model: 'm' + LS + 'INJECTED' }] }
    });
    expect(parsed).not.toBeNull();
    setConfigForTest(parsed);
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    // A raw U+2028 is a line terminator to most log viewers and to JS source.
    expect(report).not.toContain(LS);
    expect(report.split(LINE_BREAKS)).toHaveLength(4);
  });

  it('escapes U+2029 (PARAGRAPH SEPARATOR) and U+0085 (NEL)', () => {
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p', model: 'a' + PS + 'b' + NEL + 'c' }] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).not.toContain(PS);
    expect(report).not.toContain(NEL);
    expect(report.split(LINE_BREAKS)).toHaveLength(4);
  });
});

describe('Round 53: escaping stays precise for printable Unicode', () => {
  it('leaves astral-plane and combining characters untouched', () => {
    const rocket = String.fromCodePoint(0x1f680);
    const combining = 'e' + String.fromCharCode(0x0301) + 'm';
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p' + rocket, model: combining }] });
    const report = formatDiagnostics(getDiagnosticsSnapshot(0));
    expect(report).toContain('p' + rocket + '::' + combining);
    expect(report.split('\n')).toHaveLength(4);
  });
});

describe('Round 54: a ghost quarantine key never invents a diagnostics row', () => {
  it('hydrating a key absent from the config leaves the row set unchanged', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1')] });
    defaultCircuitBreaker.applyQuarantines({ 'ghost::m': Date.now() + 600_000 });
    const s = getDiagnosticsSnapshot(Date.now());
    expect(s.endpoints).toHaveLength(1);
    expect(s.endpoints[0]!.key).toBe('p1::m1');
    expect(JSON.stringify(s)).not.toContain('ghost::m');
  });
});

describe('Round 55: hydration never changes pool membership', () => {
  it('effectivePoolSize and inPool are unaffected by an applied quarantine map', () => {
    setConfigForTest({ enabled: true, endpoints: [ep('p1', 'm1'), { ...ep('p2', 'm2'), enabled: false }] });
    const before = getDiagnosticsSnapshot(0);
    defaultCircuitBreaker.applyQuarantines({ 'p1::m1': Date.now() + 600_000 });
    const after = getDiagnosticsSnapshot(0);
    expect(after.effectivePoolSize).toBe(before.effectivePoolSize);
    expect(after.endpoints.map((e) => e.inPool)).toEqual(before.endpoints.map((e) => e.inPool));
  });
});

describe('Round 56: the settings watch is immediately visible to diagnostics', () => {
  it('a watch-applied quarantine renders as a tripped ISO instant in the report', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1')] });
    const watchCbs: ((next: unknown) => void)[] = [];
    const ctx = {
      inject: (_d: string[], cb: (sctx: unknown) => void) =>
        cb({ settings: { register: () => ({ get: () => undefined, watch: (c: (n: unknown) => void) => { watchCbs.push(c); } }) } })
    };
    armSettingsPanel(ctx);

    const future = Date.now() + 600_000;
    watchCbs[0]!({ quarantines: { 'p1::m1': future } });
    const line = formatDiagnostics(getDiagnosticsSnapshot(Date.now()))
      .split('\n')
      .find((l) => l.includes('p1::m1'))!;
    expect(line).toContain('tripped-until=' + new Date(future).toISOString());
    expect(line).toContain('streak=');
  });
});

describe('Round 57: a re-armed watch releases the superseded one', () => {
  it('invokes the previous watch disposer and leaves the newest watch live', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1'), ep('p2', 'm2')] });
    const cbsA: ((n: unknown) => void)[] = [];
    const cbsB: ((n: unknown) => void)[] = [];
    let stoppedA = 0;
    const mk = (sink: ((n: unknown) => void)[], stop?: () => void) => ({
      inject: (_d: string[], cb: (sctx: unknown) => void) =>
        cb({
          settings: {
            register: () => ({
              get: () => undefined,
              watch: (c: (n: unknown) => void) => {
                sink.push(c);
                return stop;
              }
            })
          }
        })
    });
    armSettingsPanel(mk(cbsA, () => { stoppedA += 1; }));
    armSettingsPanel(mk(cbsB));

    // Our owned guarantee: the superseded registration's watch was disposed.
    // (A host that still invokes a released callback is the host's bug, not
    // ours, so the test pins the disposal - not the callback's silence.)
    expect(stoppedA).toBe(1);
    expect(cbsB).toHaveLength(1);

    cbsB[0]!({ quarantines: { 'p2::m2': Date.now() + 600_000 } });
    const afterLive = getDiagnosticsSnapshot(Date.now());
    expect(afterLive.endpoints.find((e) => e.key === 'p2::m2')!.breaker.healthy).toBe(false);
  });
});

describe('Round 58: repeated dispose/re-arm cycles leave diagnostics byte-stable', () => {
  it('is stable across 20 cycles with no quarantine', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [ep('p1', 'm1')] });
    const first = formatDiagnostics(getDiagnosticsSnapshot(1234));
    for (let i = 0; i < 20; i++) {
      const ctx = {
        inject: (_d: string[], cb: (sctx: unknown) => void) =>
          cb({ settings: { register: () => ({ get: () => undefined, watch: () => () => {} }) } })
      };
      armSettingsPanel(ctx);
      disposeSettings();
    }
    expect(formatDiagnostics(getDiagnosticsSnapshot(1234))).toBe(first);
  });
});
