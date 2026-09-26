import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendEvents,
  readPersistedEvents,
  writeEndpointStatsSnapshot,
  readLatestSnapshot,
  pruneOldBuckets,
  eventFileName,
  setPersistDirForTest,
  flushTelemetryToDisk,
  MAX_PERSIST_DAYS
} from '../src/persist.js';
import { recordRequest, resetTelemetry, getRecentEvents } from '../src/telemetry.js';
import type { TelemetryEvent, EndpointStats } from '../src/telemetry.js';

/**
 * Adversarial logic probes for src/persist.ts (durable diagnostics).
 *
 * Every test writes under os.tmpdir() via setPersistDirForTest - the
 * developer's real ~/.dsh is never touched.
 */

// Local noon so the day-bucket assertions are independent of the machine TZ.
const NOW = new Date(2026, 8, 8, 12, 0, 0).getTime();

function ev(at: number, agentId = 'a1'): TelemetryEvent {
  return { at, type: 'request', agentId, to: { provider: 'p1', model: 'm1' } };
}

function stat(key: string, provider = 'p', model = 'm'): EndpointStats {
  return {
    key, provider, model,
    requests: 0, failures: 0, failovers: 0, cooldownHints: 0,
    lastFailureAt: null, lastFailureCode: null,
    latencySamples: 0, latencyTotalMs: 0, latencyMaxMs: 0, lastLatencyMs: null,
    successes: 0, successLatencySamples: 0, successLatencyTotalMs: 0,
    successLatencyMaxMs: 0, lastSuccessLatencyMs: null, tokensTotal: 0
  };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

describe('persist.ts logic probes', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `dsh-plogic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setPersistDirForTest(dir);
    resetTelemetry(); // clean ring buffer AND stats - unlike persist.test.ts's drain-only helper
  });

  afterEach(() => {
    setPersistDirForTest(null);
    resetTelemetry();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('Round 1: day-bucket rollover', () => {
    // Hypothesis: instants either side of LOCAL midnight land in different buckets,
    // and each event lands in the bucket the writer named for it.
    it('splits at local midnight and reads the two buckets chronologically', () => {
      const before = new Date(2026, 8, 8, 23, 59, 59).getTime();
      const after = new Date(2026, 8, 9, 0, 0, 0).getTime();

      expect(eventFileName(before)).toBe('events-2026-09-08.jsonl');
      expect(eventFileName(after)).toBe('events-2026-09-09.jsonl');

      expect(appendEvents([ev(before, 'day8')], before)).toBe(1);
      expect(appendEvents([ev(after, 'day9')], after)).toBe(1);

      expect(fs.existsSync(path.join(dir, 'events-2026-09-08.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'events-2026-09-09.jsonl'))).toBe(true);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['day8', 'day9']);
    });

    it('keeps two instants of the same local day in one bucket', () => {
      const early = new Date(2026, 8, 8, 0, 0, 1).getTime();
      const late = new Date(2026, 8, 8, 23, 59, 59).getTime();
      expect(eventFileName(early)).toBe(eventFileName(late));

      appendEvents([ev(early)], early);
      appendEvents([ev(late)], late);
      expect(lines(path.join(dir, eventFileName(late)))).toHaveLength(2);
    });
  });

  describe('Round 2: peek -> append -> consume ordering', () => {
    // Hypothesis: the buffer is consumed only after a successful append, so a
    // failed append leaves every event buffered for the next flush.
    it('leaves the buffer intact on a failed append and delivers it on retry', () => {
      recordRequest('agent-r2', { provider: 'p1', model: 'm1' }, NOW);
      const blocker = path.join(os.tmpdir(), `dsh-plogic-block-${Date.now()}`);
      fs.writeFileSync(blocker, 'not a dir', 'utf8');
      setPersistDirForTest(path.join(blocker, 'nested'));
      try {
        const result = flushTelemetryToDisk(NOW);
        expect(result.eventsWritten).toBe(0);
        expect(result.snapshotWritten).toBe(false);
        expect(result.bucketsPruned).toEqual([]);
        expect(getRecentEvents()).toHaveLength(1); // NOT consumed
      } finally {
        fs.rmSync(blocker, { force: true });
        setPersistDirForTest(dir);
      }

      const retry = flushTelemetryToDisk(NOW + 1);
      expect(retry.eventsWritten).toBe(1);
      expect(getRecentEvents()).toHaveLength(0);
      expect(lines(path.join(dir, eventFileName(NOW + 1)))).toHaveLength(1);
    });

    it('consumes exactly once when the append succeeds', () => {
      recordRequest('agent-r2b', { provider: 'p1', model: 'm1' }, NOW);
      expect(flushTelemetryToDisk(NOW).eventsWritten).toBe(1);
      expect(getRecentEvents()).toHaveLength(0);
      expect(lines(path.join(dir, eventFileName(NOW)))).toHaveLength(1);
    });
  });

  describe('Round 3: atomic endpoint snapshot replace', () => {
    // Hypothesis: tmp+rename leaves no tmp file on success, and a failed
    // replace never damages the snapshot a reader can already see.
    it('leaves no tmp file after a successful replace', () => {
      expect(writeEndpointStatsSnapshot([stat('a::m')], NOW)).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
      expect(readLatestSnapshot()).toMatchObject({ at: NOW });
      expect(readLatestSnapshot()?.endpoints[0].key).toBe('a::m');
    });

    it('keeps the previous snapshot readable when the replace fails', () => {
      expect(writeEndpointStatsSnapshot([stat('old::m')], NOW)).toBe(true);

      // Occupy the exact tmp path with a directory so the tmp write fails.
      const tmp = path.join(dir, `.endpoints.${process.pid}.${NOW + 5}.tmp`);
      fs.mkdirSync(tmp);
      try {
        expect(writeEndpointStatsSnapshot([stat('new::m')], NOW + 5)).toBe(false);
        const snap = readLatestSnapshot();
        expect(snap?.at).toBe(NOW); // old snapshot untouched, never partial
        expect(snap?.endpoints[0].key).toBe('old::m');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('leaves no tmp file behind when the replace fails', () => {
      expect(writeEndpointStatsSnapshot([stat('a::m')], NOW)).toBe(true);
      // A directory squatting on the tmp path makes writeFileSync fail; the
      // catch path must not leave a half-written tmp file around.
      const tmp = path.join(dir, `.endpoints.${process.pid}.${NOW}.tmp`);
      fs.mkdirSync(tmp);
      try {
        expect(writeEndpointStatsSnapshot([stat('b::m')], NOW)).toBe(false);
        const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
        expect(strays).toEqual([path.basename(tmp)]); // only the squatting dir
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('Round 4: retention pruning', () => {
    // Hypothesis: pruning keeps the newest MAX_PERSIST_DAYS buckets and never
    // deletes the bucket the current flush just wrote.
    it('keeps the newest N buckets and removes the older ones', () => {
      for (let d = MAX_PERSIST_DAYS + 1; d >= 0; d--) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      const removed = pruneOldBuckets(NOW);
      expect(removed).toHaveLength(2);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('events-'))).toHaveLength(MAX_PERSIST_DAYS);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(true);
    });

    it('pruning a nonexistent root is a soft no-op', () => {
      setPersistDirForTest(path.join(dir, 'absent'));
      try {
        expect(pruneOldBuckets(NOW)).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'absent'))).toBe(false);
      } finally {
        setPersistDirForTest(dir);
      }
    });

    it('never prunes the bucket the flush just wrote', () => {
      recordRequest('agent-r4', { provider: 'p1', model: 'm1' }, NOW);
      const result = flushTelemetryToDisk(NOW);
      expect(result.eventsWritten).toBe(1);
      const file = path.join(dir, eventFileName(NOW));
      expect(fs.existsSync(file)).toBe(true);
      expect(lines(file)).toHaveLength(1);
    });

    it('PROBE: future-dated buckets (clock skew) must not evict the bucket being written', () => {
      // A skewed clock or a restored backup can leave buckets dated after NOW.
      // The flush reports eventsWritten:1, so the just-written bucket must survive.
      for (let d = 1; d <= MAX_PERSIST_DAYS; d++) {
        const t = new Date(2026, 8, 8 + d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      recordRequest('agent-skew', { provider: 'p1', model: 'm1' }, NOW);
      const result = flushTelemetryToDisk(NOW);

      expect(result.eventsWritten).toBe(1);
      const file = path.join(dir, eventFileName(NOW));
      expect(fs.existsSync(file)).toBe(true);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toContain('agent-skew');
    });
  });

  describe('Round 5: failure modes are soft', () => {
    // Hypothesis: an unusable storage root yields zeroed counters, an intact
    // buffer and no throw - diagnostics never take the host down.
    it('an unwritable root yields zeroed counters, an intact buffer and no throw', () => {
      recordRequest('agent-r5', { provider: 'p1', model: 'm1' }, NOW);
      const blocker = path.join(os.tmpdir(), `dsh-plogic-block5-${Date.now()}`);
      fs.writeFileSync(blocker, 'not a dir', 'utf8');
      setPersistDirForTest(path.join(blocker, 'nested'));
      try {
        let result!: ReturnType<typeof flushTelemetryToDisk>;
        expect(() => { result = flushTelemetryToDisk(NOW); }).not.toThrow();
        expect(result).toEqual({ eventsWritten: 0, snapshotWritten: false, bucketsPruned: [] });
        expect(getRecentEvents()).toHaveLength(1);
        expect(readPersistedEvents(10)).toEqual([]);
        expect(readLatestSnapshot()).toBeNull();
      } finally {
        fs.rmSync(blocker, { force: true });
        setPersistDirForTest(dir);
      }
    });
  });

  describe('Round 6: idle purity', () => {
    // Hypothesis: with no buffered events and no stats, a flush writes nothing
    // at all - not even the storage root directory.
    it('writes nothing, not even the root, when idle', () => {
      const absent = path.join(dir, 'never-created');
      setPersistDirForTest(absent);
      try {
        const result = flushTelemetryToDisk(NOW);
        expect(result).toEqual({ eventsWritten: 0, snapshotWritten: false, bucketsPruned: [] });
        expect(fs.existsSync(absent)).toBe(false);
      } finally {
        setPersistDirForTest(dir);
      }
    });

    it('stats alone write the snapshot but no event bucket', () => {
      recordRequest('agent-r6', { provider: 'p1', model: 'm1' }, NOW);
      expect(flushTelemetryToDisk(NOW).eventsWritten).toBe(1);
      const before = lines(path.join(dir, eventFileName(NOW))).length;
      const second = flushTelemetryToDisk(NOW + 1);
      expect(second.eventsWritten).toBe(0);
      expect(second.snapshotWritten).toBe(true);
      // NOW and NOW+1 share a calendar day, so that bucket legitimately exists;
      // a stats-only flush must not have appended a second event to it.
      expect(lines(path.join(dir, eventFileName(NOW)))).toHaveLength(before);
    });
  });

  describe('Round 7: corrupt pre-existing lines', () => {
    // Hypothesis: garbage already on disk never breaks a subsequent append.
    it('appends cleanly after newline-terminated garbage lines', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, eventFileName(NOW)), '{broken\nnot json at all\n', 'utf8');
      expect(appendEvents([ev(NOW, 'after-garbage')], NOW)).toBe(1);
      const read = readPersistedEvents(10);
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ agentId: 'after-garbage' });
    });

    it('PROBE: a partial trailing line (crash mid-append) must not swallow the next batch', () => {
      fs.mkdirSync(dir, { recursive: true });
      // Exactly what a crash mid-append can leave: a line with no terminator.
      fs.writeFileSync(path.join(dir, eventFileName(NOW)), '{"at":1,"type":"request"', 'utf8');

      expect(appendEvents([ev(NOW, 'survivor')], NOW)).toBe(1);
      const read = readPersistedEvents(10);
      expect(read.map((e) => e.agentId)).toContain('survivor');
    });

    it('recovers through the full flush path, not just appendEvents', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, eventFileName(NOW)), '{"at":1,"type":"req', 'utf8');
      recordRequest('agent-flush-recover', { provider: 'p1', model: 'm1' }, NOW);
      expect(flushTelemetryToDisk(NOW).eventsWritten).toBe(1);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['agent-flush-recover']);
    });
  });

  describe('Round 8: repeated flushes', () => {
    // Hypothesis: back-to-back flushes neither duplicate nor lose events.
    it('two flushes write the event exactly once', () => {
      recordRequest('agent-r8', { provider: 'p1', model: 'm1' }, NOW);
      const first = flushTelemetryToDisk(NOW);
      const second = flushTelemetryToDisk(NOW);
      expect(first.eventsWritten).toBe(1);
      expect(second.eventsWritten).toBe(0);
      expect(lines(path.join(dir, eventFileName(NOW)))).toHaveLength(1);
      expect(readPersistedEvents(10)).toHaveLength(1);
    });
  });

  describe('Round 9: bucket date timezone dependence', () => {
    // Hypothesis: bucketing uses the LOCAL calendar day (not UTC) and uses it
    // consistently between the name helper and the write path. Observation,
    // not a defect: the reader sorts by name, never reconstructs the date.
    it('names buckets by the local calendar day, consistently', () => {
      const a = new Date(2026, 8, 8, 12, 0, 0).getTime();
      const b = new Date(2026, 8, 8, 13, 0, 0).getTime();
      expect(eventFileName(a)).toBe('events-2026-09-08.jsonl');
      expect(eventFileName(a)).toBe(eventFileName(b));
      appendEvents([ev(a)], a);
      expect(fs.existsSync(path.join(dir, eventFileName(b)))).toBe(true);
    });
  });

  describe('Round 10: before any event and after resetTelemetry', () => {
    // Hypothesis: flushing with no history and after a reset is a safe no-op.
    it('is safe before any event was ever recorded', () => {
      const result = flushTelemetryToDisk(NOW);
      expect(result.eventsWritten).toBe(0);
      expect(result.snapshotWritten).toBe(false);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('is safe after resetTelemetry and leaves the disk log alone', () => {
      recordRequest('agent-r10', { provider: 'p1', model: 'm1' }, NOW);
      expect(flushTelemetryToDisk(NOW).eventsWritten).toBe(1);

      resetTelemetry();
      const after = flushTelemetryToDisk(NOW + 1);
      expect(after.eventsWritten).toBe(0);
      expect(after.snapshotWritten).toBe(false);
      // The already-persisted event survives the in-memory reset.
      expect(readPersistedEvents(10)).toHaveLength(1);
    });
  });
});
