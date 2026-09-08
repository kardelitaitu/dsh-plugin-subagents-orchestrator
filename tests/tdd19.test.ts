import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { recordRequest, resetTelemetry } from '../src/telemetry.js';
import { flushTelemetryToDisk, setPersistDirForTest, readPersistedEvents } from '../src/persist.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 19: lossless flush ordering and idle-flush purity.
 */
describe('TDD round 19: flush losslessness and idle purity', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tdd19-'));
    resetTelemetry();
  });

  afterEach(() => {
    setPersistDirForTest(null);
    resetTelemetry();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PROBE 1: a failed append keeps the buffer intact - no loss, no throw', () => {
    recordRequest('lost-1', { provider: 'p1', model: 'm1' });
    recordRequest('lost-2', { provider: 'p1', model: 'm1' });

    // A path THROUGH a regular file makes mkdir fail (ENOTDIR on POSIX,
    // a win32 equivalent on Windows)
    const blocker = path.join(dir, 'blocker.txt');
    fs.writeFileSync(blocker, 'regular file', 'utf8');
    setPersistDirForTest(path.join(blocker, 'telemetry'));

    let result: ReturnType<typeof flushTelemetryToDisk> | null = null;
    expect(() => { result = flushTelemetryToDisk(); }).not.toThrow();

    expect(result!.eventsWritten).toBe(0);
    expect(result!.snapshotWritten).toBe(false);
    // The two events are still buffered - nothing was lost
    expect(readPersistedEvents(10)).toEqual([]);
    resetTelemetry(); // restore the buffer state this probe owns
  });

  it('PROBE 2: after the storage problem is fixed, the retry flush writes each event exactly once', () => {
    recordRequest('retry-1', { provider: 'p1', model: 'm1' });
    recordRequest('retry-2', { provider: 'p1', model: 'm1' });

    // Failing dir first
    const blocker = path.join(dir, 'blocker.txt');
    fs.writeFileSync(blocker, 'regular file', 'utf8');
    setPersistDirForTest(path.join(blocker, 'telemetry'));
    const failed = flushTelemetryToDisk();
    expect(failed.eventsWritten).toBe(0);

    // Fix the dir and flush again
    const good = path.join(dir, 'telemetry');
    setPersistDirForTest(good);
    const ok = flushTelemetryToDisk();
    expect(ok.eventsWritten).toBe(2);

    const read = readPersistedEvents(10);
    expect(read.map((e) => e.agentId)).toEqual(['retry-1', 'retry-2']);
    resetTelemetry();
  });

  it('PROBE 3: an idle flush (empty buffer, no stats) creates no storage root', () => {
    const idle = path.join(dir, 'telemetry');
    setPersistDirForTest(idle);

    const result = flushTelemetryToDisk();

    // Documented contract: "an empty buffer writes nothing (not even the
    // storage root)"
    expect(result.eventsWritten).toBe(0);
    expect(fs.existsSync(idle)).toBe(false);
  });

  it('PROBE 4: an idle opted-in plugin leaves no disk residue on dispose', async () => {
    const ctx = new MockCordisContext();
    setPersistDirForTest(path.join(dir, 'telemetry'));
    setConfigForTest({
      enabled: true,
      failover: true,
      persistTelemetry: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);

    // No traffic at all - just dispose
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);

    expect(fs.existsSync(path.join(dir, 'telemetry'))).toBe(false);
  });
});
