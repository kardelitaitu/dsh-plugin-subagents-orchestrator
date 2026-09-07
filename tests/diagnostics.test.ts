import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getDiagnosticsSnapshot,
  formatDiagnostics
} from '../src/diagnostics.js';
import {
  setConfigForTest,
  resetConfigForTest,
  initWatcher,
  disposeWatcher
} from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import {
  recordRequest,
  recordFailure,
  recordFailover,
  resetTelemetry
} from '../src/telemetry.js';
import { apply } from '../src/index.js';
import { MockCordisContext } from './mocks/cordis.js';

describe('Diagnostics Snapshot', () => {
  const testDir = path.join(os.tmpdir(), `dsh-orchestrator-diag-${Date.now()}`);
  const testFile = path.join(testDir, 'settings.yaml');

  beforeEach(() => {
    resetConfigForTest(testFile);
    resetTelemetry();
    defaultCircuitBreaker.clear();
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    disposeWatcher();
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('is safe before apply() and with no config at all', () => {
    const snapshot = getDiagnosticsSnapshot(1000);

    expect(snapshot.configPresent).toBe(false);
    expect(snapshot.orchestration.active).toBe(false);
    expect(snapshot.effectivePoolSize).toBe(0);
    expect(snapshot.endpoints).toEqual([]);
    expect(snapshot.generatedAt).toBe(1000);
  });

  it('reflects the effective pool, parked endpoints and orchestration switches', () => {
    setConfigForTest({
      enabled: true,
      strategy: 'weighted',
      failover: true,
      cooldownMs: 45000,
      maxFailures: 5,
      intervalMinMs: 250,
      intervalMaxMs: 750,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2', enabled: false },
        { provider: 'p3', model: 'm3' }
      ]
    });

    const snapshot = getDiagnosticsSnapshot(2000);

    expect(snapshot.configPresent).toBe(true);
    expect(snapshot.orchestration).toEqual({
      active: true,
      strategy: 'weighted',
      failover: true,
      cooldownMs: 45000,
      maxFailures: 5,
      retryIntervalMinMs: 250,
      retryIntervalMaxMs: 750
    });
    expect(snapshot.effectivePoolSize).toBe(2); // p2 is parked
    expect(snapshot.endpoints.map((e) => [e.key, e.inPool])).toEqual([
      ['p1::m1', true],
      ['p2::m2', false],
      ['p3::m3', true]
    ]);
  });

  it('derives breaker health without mutating the breaker', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [{ provider: 'p1', model: 'm1' }]
    });

    // Trip p1 for a window that is still running at snapshot time.
    defaultCircuitBreaker.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60_000, 1000);

    const snapshot = getDiagnosticsSnapshot(2000);
    const endpoint = snapshot.endpoints[0]!;

    expect(endpoint.breaker.healthy).toBe(false);
    expect(endpoint.breaker.trippedUntil).toBe(61_000);
    expect(endpoint.breaker.consecutiveFailures).toBe(1);

    // The read must not have transitioned the endpoint to probation.
    const after = defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' });
    expect(after.trippedUntil).toBe(61_000); // not cleared
    expect(after.consecutiveFailures).toBe(1); // not reset
  });

  it('reports an elapsed cooldown as healthy while leaving the streak intact', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [{ provider: 'p1', model: 'm1' }]
    });
    defaultCircuitBreaker.recordFailure({ provider: 'p1', model: 'm1' }, 1, 5_000, 1000);

    const snapshot = getDiagnosticsSnapshot(9000); // cooldown elapsed
    const endpoint = snapshot.endpoints[0]!;

    expect(endpoint.breaker.healthy).toBe(true); // probation, derived only
    expect(endpoint.breaker.trippedUntil).toBe(6_000); // status untouched
    expect(endpoint.breaker.consecutiveFailures).toBe(1); // probationary memory kept
  });

  it('aggregates telemetry counters per endpoint key', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordRequest('a2', { provider: 'p1', model: 'm1' }, 1100);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 2000);
    recordFailover('a1', { provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' });

    const snapshot = getDiagnosticsSnapshot(3000);
    const p1 = snapshot.endpoints.find((e) => e.key === 'p1::m1')!;
    const p2 = snapshot.endpoints.find((e) => e.key === 'p2::m2')!;

    expect(p1.telemetry).toMatchObject({ requests: 2, failures: 1, failovers: 0, latencySamples: 1 });
    expect(p2.telemetry).toMatchObject({ requests: 0, failures: 0, failovers: 1 });
  });

  it('returns plain serializable data with no live references', () => {
    setConfigForTest({
      enabled: true,
      endpoints: [{ provider: 'p1', model: 'm1' }]
    });
    defaultCircuitBreaker.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60_000, 1000);

    const snapshot = getDiagnosticsSnapshot(2000);
    expect(() => JSON.parse(JSON.stringify(snapshot))).not.toThrow();

    // Tampering with the snapshot must not reach live state.
    snapshot.endpoints[0]!.breaker.consecutiveFailures = 999;
    snapshot.endpoints[0]!.telemetry.requests = 999;
    const fresh = getDiagnosticsSnapshot(2000);
    expect(fresh.endpoints[0]!.breaker.consecutiveFailures).toBe(1);
    expect(fresh.endpoints[0]!.telemetry.requests).toBe(0);
  });

  it('survives an injected-null config right after apply() without disk reads', () => {
    setConfigForTest(null);
    apply(new MockCordisContext());

    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const snapshot = getDiagnosticsSnapshot(3000);
      expect(snapshot.configPresent).toBe(false);
      expect(snapshot.orchestration.active).toBe(false);
      expect(existsSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('picks up hot-reloaded state without extra disk I/O', async () => {
    const content = `
subagents-orchestrator:
  enabled: true
  strategy: random
  endpoints:
    - provider: p1
      model: m1
`;
    fs.writeFileSync(testFile, content, 'utf8');
    initWatcher(testFile);

    const before = getDiagnosticsSnapshot();
    expect(before.orchestration.strategy).toBe('random');
    expect(before.effectivePoolSize).toBe(1);

    fs.writeFileSync(
      testFile,
      `
subagents-orchestrator:
  enabled: true
  strategy: weighted
  endpoints:
    - provider: p1
      model: m1
    - provider: p2
      model: m2
`,
      'utf8'
    );

    // The watcher's debounced reload is the only disk I/O; snapshots stay pure.
    // Async wait: a busy-wait would block the event loop and starve the
    // very debounce timer this test is waiting on.
    const deadline = Date.now() + 3000;
    while (getDiagnosticsSnapshot().effectivePoolSize !== 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const after = getDiagnosticsSnapshot();
    expect(after.orchestration.strategy).toBe('weighted');
    expect(after.effectivePoolSize).toBe(2);
  });
});

describe('formatDiagnostics', () => {
  beforeEach(() => {
    // The snapshot describe block pins config state via setConfigForTest.
    // Pin null here: it counts as loaded, so the snapshot never falls back
    // to reading the developer's real ~/.dsh/settings.yaml.
    setConfigForTest(null);
    resetTelemetry();
    defaultCircuitBreaker.clear();
  });

  afterEach(() => {
    resetTelemetry();
    defaultCircuitBreaker.clear();
  });

  it('renders a compact deterministic report', () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      failover: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2', enabled: false }
      ]
    });
    defaultCircuitBreaker.recordFailure({ provider: 'p1', model: 'm1' }, 1, 60_000, 1000);
    recordRequest('a1', { provider: 'p1', model: 'm1' }, 1000);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', undefined, 1800);

    const report = formatDiagnostics(getDiagnosticsSnapshot(2000));

    expect(report).toContain('subagents-orchestrator diagnostics @');
    expect(report).toContain('config: present');
    expect(report).toContain('active=true strategy=round-robin failover=true');
    expect(report).toContain('effective pool: 1 endpoint(s)');
    expect(report).toContain('- p1::m1 [pool tripped-until=');
    expect(report).toContain('req=1 fail=1 failover=0');
    expect(report).toContain('fail-latency n=1 avg=800ms max=800ms');
    expect(report).toContain('- p2::m2 [parked healthy req=0 fail=0 failover=0]');
  });

  it('omits the latency segment when no samples exist and handles a missing config', () => {
    const report = formatDiagnostics(getDiagnosticsSnapshot(5000));
    expect(report).toContain('config: missing');
    expect(report).toContain('effective pool: 0 endpoint(s)');
    expect(report).not.toContain('fail-latency');
  });
});
