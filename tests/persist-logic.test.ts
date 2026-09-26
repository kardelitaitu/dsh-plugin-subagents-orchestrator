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
import {
  recordRequest,
  recordFailure,
  recordFailover,
  recordTurnSuccess,
  getEndpointStats,
  resetTelemetry,
  getRecentEvents
} from '../src/telemetry.js';
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

  // ---------------------------------------------------------------------------
  // Round 2 (continues the numbering): adversarial depth on the paths the first
  // ten rounds did not reach, and re-examination of my own prior conclusions.
  // ---------------------------------------------------------------------------

  describe('R2-Round 1: endsWithNewline on tiny / shrunk files', () => {
    // Hypothesis: the 1-byte probe is right for an empty file (no prefix) and a
    // 1-byte non-newline file (prefix), so the stat/read shrink race can only
    // ever add a harmless blank line - it can never glue events together.
    it('handles a zero-byte bucket and a one-byte fragment bucket', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, eventFileName(NOW));
      fs.writeFileSync(file, "", "utf8"); // size 0 -> treated as newline-terminated
      expect(appendEvents([ev(NOW, "from-empty")], NOW)).toBe(1);
      expect(lines(file)).toHaveLength(1);
      fs.writeFileSync(file, "x", "utf8"); // lone fragment byte, no terminator
      expect(appendEvents([ev(NOW, "from-fragment")], NOW)).toBe(1);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(["from-fragment"]);
      expect(fs.readFileSync(file, "utf8").startsWith("x\n")).toBe(true);
    });
  });

  describe('R2-Round 2: bucket whose last byte is CR (no LF)', () => {
    // Hypothesis: a CR-terminated file is NOT newline-terminated by the 0x0a
    // check, so the prefix is added and the reader (which trims) still recovers
    // both the CR line and the newly appended event.
    it('does not glue a CR-terminated event to the next append', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, eventFileName(NOW));
      fs.writeFileSync(file, '{"at":1,"type":"request","agentId":"cr"}\r', "utf8");
      expect(appendEvents([ev(NOW, "after-cr")], NOW)).toBe(1);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(["cr", "after-cr"]);
    });
  });

  describe('R2-Round 3: huge first event in a multi-event append', () => {
    // Hypothesis: the payload is one string written in a single appendFileSync,
    // so a multi-megabyte first event preserves order and integrity.
    it('keeps order and full content with a 2MB first event', () => {
      const huge = ev(NOW, "huge");
      (huge as any).blob = "x".repeat(2 * 1024 * 1024);
      expect(appendEvents([huge, ev(NOW, "small")], NOW)).toBe(2);
      const read = readPersistedEvents(10);
      expect(read.map((e) => e.agentId)).toEqual(["huge", "small"]);
      expect((read[0] as any).blob.length).toBe(2 * 1024 * 1024);
    });
  });

  describe('R2-Round 4: current bucket is also inside the newest-N window', () => {
    // Hypothesis: the Set-based keep list must dedupe, so exactly
    // MAX_PERSIST_DAYS buckets that include the current one prune nothing.
    it('prunes nothing when the current bucket is in the newest N', () => {
      for (let d = 0; d < MAX_PERSIST_DAYS; d++) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      expect(pruneOldBuckets(NOW)).toEqual([]);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith("events-"))).toHaveLength(MAX_PERSIST_DAYS);
    });
  });

  describe('R2-Round 5: full window + future-dated + malformed-named bucket', () => {
    // Hypothesis: the malformed name is outside the bucket regex so it is never
    // counted or deleted, the future bucket is retained, and the current bucket
    // survives; exactly one old bucket is removed.
    it('prunes only the oldest well-named bucket', () => {
      const malformed = "events-2026-9-8.jsonl"; // non-padded month: not a bucket
      for (let d = 0; d < MAX_PERSIST_DAYS; d++) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      const future = new Date(2026, 8, 9, 12, 0, 0).getTime();
      appendEvents([ev(future)], future);
      fs.writeFileSync(path.join(dir, malformed), "{}\n", "utf8");
      const oldest = new Date(2026, 8, 2, 12, 0, 0).getTime();
      expect(pruneOldBuckets(NOW)).toEqual([eventFileName(oldest)]);
      expect(fs.existsSync(path.join(dir, malformed))).toBe(true);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(true);
      expect(fs.existsSync(path.join(dir, eventFileName(future)))).toBe(true);
    });
  });

  describe('R2-Round 6: non-serializable event (circular reference)', () => {
    // Hypothesis: JSON.stringify throws inside the guarded append, so the call
    // returns 0 and writes no bucket file instead of taking the host down.
    it('returns 0 without throwing and writes no bucket', () => {
      const circular: any = { at: NOW, type: "request", agentId: "circ" };
      circular.self = circular;
      let n = -1;
      expect(() => { n = appendEvents([circular], NOW); }).not.toThrow();
      expect(n).toBe(0);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(false);
    });
  });

  describe('R2-Round 7: two snapshot writes in the same pid + same ms', () => {
    // Hypothesis: the tmp name collides only across separate invocations, and
    // because writeFileSync/renameSync are synchronous in-process the second
    // write simply supersedes the first with no leftover and no corruption.
    it('same-ms same-pid snapshot writes do not collide', () => {
      expect(writeEndpointStatsSnapshot([stat("a::m")], NOW)).toBe(true);
      expect(writeEndpointStatsSnapshot([stat("b::m")], NOW)).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
      expect(readLatestSnapshot()?.endpoints[0].key).toBe("b::m");

      recordRequest("agent-r7", { provider: "p1", model: "m1" }, NOW);
      expect(flushTelemetryToDisk(NOW).snapshotWritten).toBe(true);
      expect(flushTelemetryToDisk(NOW).snapshotWritten).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    });
  });

  describe('R2-Round 8: retention boundary (exactly 7 vs 8) and a future year', () => {
    // Hypothesis: 7 buckets prune nothing, the 8th evicts exactly the oldest,
    // and a far-future-year bucket is treated as the newest name and survives.
    it('holds the boundary and keeps a future-year bucket', () => {
      const mk = (d: number) => {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
        return eventFileName(t);
      };
      for (let d = 0; d < MAX_PERSIST_DAYS; d++) mk(d);
      expect(pruneOldBuckets(NOW)).toEqual([]);
      const oldest8 = mk(MAX_PERSIST_DAYS);
      expect(pruneOldBuckets(NOW)).toEqual([oldest8]);

      const fut = new Date(2099, 0, 1, 12, 0, 0).getTime();
      appendEvents([ev(fut)], fut);
      pruneOldBuckets(NOW);
      expect(fs.existsSync(path.join(dir, eventFileName(fut)))).toBe(true);
    });
  });

  describe('R2-Round 9: a bucket name occupied by a DIRECTORY', () => {
    // Hypothesis: one hostile entry must not poison the whole read - the reader
    // should skip it and keep returning the healthy buckets.
    it('skips the directory and still returns the healthy bucket', () => {
      fs.mkdirSync(dir, { recursive: true });
      const prev = new Date(2026, 8, 7, 12, 0, 0).getTime();
      appendEvents([ev(prev, "good")], prev);
      fs.mkdirSync(path.join(dir, eventFileName(NOW))); // dir squatting on a bucket name
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(["good"]);
    });
  });

  describe('R2-Round 10: readPersistedEvents limit semantics', () => {
    // Hypothesis: a limit above the total returns everything; a limit landing
    // exactly on a bucket boundary returns the newest N in chronological order;
    // zero/negative yields nothing.
    it('handles over-limit, exact-boundary and zero/negative limits', () => {
      const day1 = new Date(2026, 8, 7, 12, 0, 0).getTime();
      const day2 = new Date(2026, 8, 8, 12, 0, 0).getTime();
      appendEvents([ev(day1, "d1a"), ev(day1, "d1b")], day1);
      appendEvents([ev(day2, "d2a"), ev(day2, "d2b")], day2);
      expect(readPersistedEvents(100).map((e) => e.agentId)).toEqual(["d1a", "d1b", "d2a", "d2b"]);
      expect(readPersistedEvents(2).map((e) => e.agentId)).toEqual(["d2a", "d2b"]);
      expect(readPersistedEvents(3).map((e) => e.agentId)).toEqual(["d1b", "d2a", "d2b"]);
      expect(readPersistedEvents(0)).toEqual([]);
      expect(readPersistedEvents(-5)).toEqual([]);
    });
  });

  describe('R2-Round 11: DST transition days', () => {
    // Hypothesis: local-day bucketing yields one stable name per ambiguous or
    // shortened local day - no duplicate and no missing bucket - and still
    // splits at midnight.
    it('names DST days consistently and still splits at midnight', () => {
      expect(eventFileName(new Date(2026, 2, 8, 1, 30, 0).getTime())).toBe("events-2026-03-08.jsonl");
      expect(eventFileName(new Date(2026, 2, 8, 3, 30, 0).getTime())).toBe("events-2026-03-08.jsonl");
      expect(eventFileName(new Date(2026, 10, 1, 1, 30, 0).getTime())).toBe("events-2026-11-01.jsonl");
      expect(eventFileName(new Date(2026, 10, 1, 2, 30, 0).getTime())).toBe("events-2026-11-01.jsonl");
      expect(eventFileName(new Date(2026, 2, 8, 23, 59, 59).getTime())).not.toBe(
        eventFileName(new Date(2026, 2, 9, 0, 0, 0).getTime())
      );
    });
  });

  describe('R2-Round 12: valid JSON that is not an event object', () => {
    // Hypothesis: only object-shaped lines are events; null/number/string/array
    // lines are JSON-valid but must be skipped rather than returned as
    // TelemetryEvent (which would crash consumers reading .agentId).
    it('skips non-object JSON lines but keeps a wrong-shaped object', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, eventFileName(NOW)),
        '{"type":"request","agentId":"no-at"}\nnull\n42\n"str"\n[1,2]\n',
        "utf8"
      );
      const read = readPersistedEvents(10);
      expect(read.every((e) => e !== null && typeof e === "object" && !Array.isArray(e))).toBe(true);
      expect(read.map((e) => (e as any).agentId)).toEqual(["no-at"]);
    });
  });

  describe('R2-Round 13: empty bucket and a storage root that is a file', () => {
    // Hypothesis: a zero-byte bucket contributes nothing, and a persistDir that
    // is a file makes readdir throw - both degrade softly to an empty list.
    it('skips an empty bucket and survives a file-shaped root', () => {
      fs.mkdirSync(dir, { recursive: true });
      const prev = new Date(2026, 8, 7, 12, 0, 0).getTime();
      fs.writeFileSync(path.join(dir, eventFileName(prev)), "", "utf8");
      fs.writeFileSync(path.join(dir, eventFileName(NOW)), JSON.stringify(ev(NOW, "ok")) + "\n", "utf8");
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(["ok"]);

      const asFile = path.join(os.tmpdir(), "dsh-r2-file-" + Date.now());
      fs.writeFileSync(asFile, "not a dir", "utf8");
      setPersistDirForTest(asFile);
      try {
        expect(readPersistedEvents(10)).toEqual([]);
        expect(pruneOldBuckets(NOW)).toEqual([]);
      } finally {
        setPersistDirForTest(dir);
        fs.rmSync(asFile, { force: true });
      }
    });
  });

  describe('R2-Round 14: year rollover', () => {
    // Hypothesis: zero-padded names make Dec 31 sort before Jan 1 of the next
    // year, so a cross-year read stays chronological.
    it('orders Dec 31 before Jan 1 of the next year', () => {
      const dec = new Date(2026, 11, 31, 23, 59, 59).getTime();
      const jan = new Date(2027, 0, 1, 0, 0, 0).getTime();
      expect(eventFileName(dec)).toBe("events-2026-12-31.jsonl");
      expect(eventFileName(jan)).toBe("events-2027-01-01.jsonl");
      appendEvents([ev(dec, "dec")], dec);
      appendEvents([ev(jan, "jan")], jan);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(["dec", "jan"]);
    });
  });

  describe('R2-Round 15: bucket path occupied by a directory (append)', () => {
    // Hypothesis: appendFileSync on a directory fails, so appendEvents returns 0
    // and throws nothing.
    it('returns 0 without throwing', () => {
      fs.mkdirSync(path.join(dir, eventFileName(NOW)), { recursive: true });
      let n = -1;
      expect(() => { n = appendEvents([ev(NOW, "blocked")], NOW); }).not.toThrow();
      expect(n).toBe(0);
      expect(readPersistedEvents(10)).toEqual([]);
    });
  });

  describe('R2-Round 16: flush when the bucket path is a directory', () => {
    // Hypothesis: the event append fails (0) but the buffer stays intact for a
    // retry and the cumulative snapshot still lands; the dir is retained.
    it('keeps the buffer and writes only the snapshot', () => {
      recordRequest("agent-r16", { provider: "p1", model: "m1" }, NOW);
      fs.mkdirSync(path.join(dir, eventFileName(NOW)), { recursive: true });
      const result = flushTelemetryToDisk(NOW);
      expect(result.eventsWritten).toBe(0);
      expect(result.snapshotWritten).toBe(true);
      expect(result.bucketsPruned).toEqual([]);
      expect(getRecentEvents()).toHaveLength(1);
    });
  });

  describe('R2-Round 17: prune skips an unremovable bucket entry', () => {
    // Hypothesis: a non-empty directory squatting on an old bucket name cannot be
    // removed by rmSync(force, no recursive); the failure is swallowed and the
    // remaining old buckets are still pruned.
    it('leaves the directory and removes the rest', () => {
      fs.mkdirSync(dir, { recursive: true });
      const oldDay = new Date(2026, 8, 8 - (MAX_PERSIST_DAYS + 1), 12, 0, 0).getTime();
      const dirName = eventFileName(oldDay);
      fs.mkdirSync(path.join(dir, dirName), { recursive: true });
      fs.writeFileSync(path.join(dir, dirName, "inner.txt"), "x", "utf8");
      for (let d = 0; d <= MAX_PERSIST_DAYS; d++) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      const removed = pruneOldBuckets(NOW);
      expect(removed).not.toContain(dirName);
      expect(fs.existsSync(path.join(dir, dirName))).toBe(true);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(true);
    });
  });

  describe('R2-Round 18: endpoints.json occupied by a directory', () => {
    // Hypothesis: the tmp write succeeds but the rename onto a directory fails,
    // so the call returns false, cleans its tmp, and reads back null.
    it('returns false, leaves no tmp, and reads null', () => {
      fs.mkdirSync(path.join(dir, "endpoints.json"), { recursive: true });
      let ok = true;
      expect(() => { ok = writeEndpointStatsSnapshot([stat("a::m")], NOW); }).not.toThrow();
      expect(ok).toBe(false);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
      expect(readLatestSnapshot()).toBeNull();
    });
  });

  describe('R2-Round 19: prune touches only bucket-named files', () => {
    // Hypothesis: the snapshot, a stray tmp and unrelated files are never
    // deleted by retention pruning.
    it('preserves endpoints.json, tmp and unrelated files', () => {
      fs.mkdirSync(dir, { recursive: true });
      for (let d = 0; d <= MAX_PERSIST_DAYS + 2; d++) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      fs.writeFileSync(path.join(dir, "endpoints.json"), "{}", "utf8");
      fs.writeFileSync(path.join(dir, ".endpoints.1.2.tmp"), "x", "utf8");
      fs.writeFileSync(path.join(dir, "notes.txt"), "keep", "utf8");
      pruneOldBuckets(NOW);
      expect(fs.existsSync(path.join(dir, "endpoints.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".endpoints.1.2.tmp"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
    });
  });

  describe('R2-Round 20: a full buffer-sized batch and duplicates', () => {
    // Hypothesis: 100 events (the ring capacity) append in order exactly once,
    // and identical events are not deduplicated.
    it('preserves order for 100 events and keeps duplicates', () => {
      const batch: TelemetryEvent[] = [];
      for (let i = 0; i < 100; i++) batch.push(ev(NOW + i, "n" + i));
      expect(appendEvents(batch, NOW)).toBe(100);
      const read = readPersistedEvents(200);
      expect(read.map((e) => e.agentId)).toEqual(batch.map((e) => e.agentId));

      const dup = ev(NOW, "dup");
      expect(appendEvents([dup, dup], NOW)).toBe(2);
      expect(readPersistedEvents(200).filter((e) => e.agentId === "dup")).toHaveLength(2);
    });
  });

  describe('R3-Round 21: flush consumes the ring exactly once', () => {
    it('drains on success and writes nothing on a second idle flush', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      const first = flushTelemetryToDisk(NOW);
      expect(first.eventsWritten).toBe(1);
      expect(getRecentEvents()).toEqual([]);

      const second = flushTelemetryToDisk(NOW);
      expect(second.eventsWritten).toBe(0);
      expect(readPersistedEvents(10)).toHaveLength(1); // no duplicate
    });
  });

  describe('R3-Round 22: a FAILED append retains the ring (no loss, no duplicate)', () => {
    it('does not drain when the storage root cannot be created, then persists exactly once', () => {
      fs.mkdirSync(dir, { recursive: true });
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'x', 'utf8');
      setPersistDirForTest(blocker); // a FILE squats on the directory path

      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      const failed = flushTelemetryToDisk(NOW);
      expect(failed.eventsWritten).toBe(0);
      expect(failed.snapshotWritten).toBe(false);
      expect(getRecentEvents()).toHaveLength(1); // retained for a retry

      setPersistDirForTest(dir);
      const retry = flushTelemetryToDisk(NOW);
      expect(retry.eventsWritten).toBe(1);
      expect(getRecentEvents()).toEqual([]);
      expect(readPersistedEvents(10)).toHaveLength(1); // exactly once, not twice
    });
  });

  describe('R3-Round 23: an unserializable event is refused without a partial write', () => {
    it('appendEvents returns 0, throws nothing, and writes no file', () => {
      fs.mkdirSync(dir, { recursive: true });
      const bad = {
        at: NOW,
        type: 'request',
        agentId: 'bad',
        to: { provider: 'p', model: 'm' },
        hintMs: 10n
      } as unknown as TelemetryEvent;

      expect(() => appendEvents([bad], NOW)).not.toThrow();
      expect(appendEvents([bad], NOW)).toBe(0);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(false);

      // All-or-nothing: one bad member refuses the WHOLE batch.
      expect(appendEvents([ev(NOW, 'ok'), bad], NOW)).toBe(0);
      expect(fs.existsSync(path.join(dir, eventFileName(NOW)))).toBe(false);
    });
  });

  describe('R3-Round 24: the snapshot key scheme matches telemetry exactly', () => {
    it('persists the live keys, including a provider::model collision', () => {
      recordRequest('a1', { provider: 'a::b', model: 'c' }, NOW);
      recordRequest('a2', { provider: 'a', model: 'b::c' }, NOW + 1);
      const live = getEndpointStats();

      const res = flushTelemetryToDisk(NOW);
      expect(res.snapshotWritten).toBe(true);
      const snap = readLatestSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.endpoints.map((e) => e.key)).toEqual(live.map((e) => e.key));
      expect(snap!.endpoints).toHaveLength(1); // both collapse to 'a::b::c'
      expect(snap!.endpoints[0].requests).toBe(2);
    });
  });

  describe('R3-Round 25: prune boundary at exactly MAX_PERSIST_DAYS', () => {
    it('keeps exactly MAX_PERSIST_DAYS newest buckets and removes the rest', () => {
      fs.mkdirSync(dir, { recursive: true });
      const total = MAX_PERSIST_DAYS + 3;
      for (let d = 0; d < total; d++) {
        const t = new Date(2026, 8, 8 - d, 12, 0, 0).getTime();
        appendEvents([ev(t)], t);
      }
      const removed = pruneOldBuckets(NOW);
      const kept = fs.readdirSync(dir).filter((f) => f.startsWith('events-'));
      expect(kept).toHaveLength(MAX_PERSIST_DAYS);
      expect(removed).toHaveLength(total - MAX_PERSIST_DAYS);
    });
  });

  describe('R3-Round 26: 100 flush cycles accumulate nothing', () => {
    it('leaves no tmp files, one day bucket, and an empty ring', () => {
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 100; i++) {
        recordRequest('a' + i, { provider: 'p1', model: 'm1' }, NOW + i);
        flushTelemetryToDisk(NOW);
      }
      const files = fs.readdirSync(dir);
      expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
      expect(files.filter((f) => f.startsWith('events-'))).toHaveLength(1);
      expect(readPersistedEvents(1000)).toHaveLength(100);
      expect(getRecentEvents()).toEqual([]);
    });
  });

  describe('R3-Round 27: a trailing fragment is repaired, order preserved', () => {
    it('separates a partial line and keeps the batch order', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, eventFileName(NOW));
      fs.writeFileSync(file, '{"at":1,"type":"request","agentId":"frag"', 'utf8'); // no newline

      expect(appendEvents([ev(NOW, 'b1'), ev(NOW, 'b2')], NOW)).toBe(2);
      expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['b1', 'b2']);
    });
  });

  describe('R3-Round 28: readPersistedEvents limit boundary', () => {
    it('returns exactly the newest `limit` events across buckets', () => {
      fs.mkdirSync(dir, { recursive: true });
      const day2 = new Date(2026, 8, 7, 12, 0, 0).getTime();
      appendEvents([ev(day2, 'old1'), ev(day2, 'old2')], day2);
      appendEvents([ev(NOW, 'new1'), ev(NOW, 'new2')], NOW);

      expect(readPersistedEvents(3).map((e) => e.agentId)).toEqual(['old2', 'new1', 'new2']);
      expect(readPersistedEvents(4)).toHaveLength(4);
      expect(readPersistedEvents(0)).toEqual([]);
    });
  });

  describe('R3-Round 29: an empty ring still refreshes the snapshot', () => {
    it('reports zero events but writes the snapshot', () => {
      fs.mkdirSync(dir, { recursive: true });
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      flushTelemetryToDisk(NOW); // drains the ring, stats remain

      const res = flushTelemetryToDisk(NOW);
      expect(res.eventsWritten).toBe(0);
      expect(res.snapshotWritten).toBe(true);
    });
  });

  describe('R3-Round 30: readLatestSnapshot rejects malformed payloads', () => {
    it('returns null for non-array endpoints or a missing at', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'endpoints.json');

      fs.writeFileSync(file, JSON.stringify({ at: 1, endpoints: 'nope' }), 'utf8');
      expect(readLatestSnapshot()).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ endpoints: [] }), 'utf8');
      expect(readLatestSnapshot()).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ at: 1, endpoints: [] }), 'utf8');
      expect(readLatestSnapshot()).toEqual({ at: 1, endpoints: [] });
    });
  });

  describe('R3-Round 31: drained ring order equals persisted line order', () => {
    it('persists the exact ring order across mixed event types', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, NOW + 1);
      recordFailover('a1', { provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }, NOW + 2);
      const ring = getRecentEvents().map((e) => e.agentId + ':' + e.type);

      flushTelemetryToDisk(NOW);
      expect(readPersistedEvents(10).map((e) => e.agentId + ':' + e.type)).toEqual(ring);
    });
  });

  describe('R3-Round 32: an idle flush creates no storage root', () => {
    it('leaves the directory absent when there is nothing to persist', () => {
      expect(fs.existsSync(dir)).toBe(false);
      const res = flushTelemetryToDisk(NOW);
      expect(res).toEqual({ eventsWritten: 0, snapshotWritten: false, bucketsPruned: [] });
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  describe('R3-Round 33: a snapshot failure must not lose the drained events', () => {
    it('keeps the appended lines even when endpoints.json cannot be replaced', () => {
      fs.mkdirSync(dir, { recursive: true });
      // A directory squatting on endpoints.json makes the rename fail.
      fs.mkdirSync(path.join(dir, 'endpoints.json'));
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);

      const res = flushTelemetryToDisk(NOW);
      expect(res.snapshotWritten).toBe(false);
      expect(res.eventsWritten).toBe(1); // events still landed
      expect(readPersistedEvents(10)).toHaveLength(1);
      expect(getRecentEvents()).toEqual([]); // drained exactly once
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });
  });

  describe('R3-Round 34: flush is idempotent when called twice in the same ms', () => {
    it('writes one batch and one snapshot', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      recordRequest('a2', { provider: 'p1', model: 'm1' }, NOW + 1);
      const first = flushTelemetryToDisk(NOW);
      const second = flushTelemetryToDisk(NOW);
      expect(first.eventsWritten).toBe(2);
      expect(second.eventsWritten).toBe(0);
      expect(readPersistedEvents(10)).toHaveLength(2);
    });
  });

  describe('R3-Round 35: resetTelemetry between flushes drops unflushed events', () => {
    it('does not resurrect a reset ring on the next flush', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      resetTelemetry(); // dispose path: buffered diagnostics are dropped
      const res = flushTelemetryToDisk(NOW);
      expect(res.eventsWritten).toBe(0);
      expect(readPersistedEvents(10)).toEqual([]);
    });
  });

  describe('R3-Round 36: a 100-deep ring drains in oldest-first order', () => {
    it('persists exactly MAX_EVENT_BUFFER events in ring order', () => {
      for (let i = 0; i < 100; i++) {
        recordRequest('a' + i, { provider: 'p1', model: 'm1' }, NOW + i);
      }
      const res = flushTelemetryToDisk(NOW);
      expect(res.eventsWritten).toBe(100);
      const read = readPersistedEvents(200);
      expect(read.map((e) => e.agentId)).toEqual(Array.from({ length: 100 }, (_, i) => 'a' + i));
    });
  });

  // ---------------------------------------------------------------------------
  // Round 3 (R3B): the persist <-> telemetry seam, guard precision, long-run state.
  // A sibling agent concurrently appended R3-Round 21-32 to this file; these
  // blocks use the distinct R3B- prefix and complementary angles.
  // ---------------------------------------------------------------------------

  describe('R3B-Round 1: a refused non-finite clock serializes as explicit null', () => {
    // Hypothesis: a non-finite close/failure clock is refused by telemetry, so
    // the snapshot carries a PRESENT JSON null (not a dropped field, not NaN).
    it('writes lastSuccessLatencyMs and lastFailureAt as null', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW, { turn: 0, step: 0 });
      recordTurnSuccess('a1', undefined, Number.NaN);
      recordFailure('a2', { provider: 'p2', model: 'm2' }, 'SERVER', undefined, Number.NaN);
      expect(flushTelemetryToDisk(NOW + 1).snapshotWritten).toBe(true);
      const snap = readLatestSnapshot()!;
      const p1 = snap.endpoints.find((s) => s.key === 'p1::m1')!;
      const p2 = snap.endpoints.find((s) => s.key === 'p2::m2')!;
      expect(p1.successes).toBe(1);
      expect(p1.lastSuccessLatencyMs).toBeNull();
      expect(p2.failures).toBe(1);
      expect(p2.lastFailureAt).toBeNull();
      const raw = fs.readFileSync(path.join(dir, 'endpoints.json'), 'utf8');
      expect(raw).toContain('"lastSuccessLatencyMs": null');
      expect(raw).toContain('"lastFailureAt": null');
    });
  });

  describe('R3B-Round 2: the snapshot timestamp is the flush instant', () => {
    it('records the passed now exactly', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      flushTelemetryToDisk(NOW + 7);
      expect(readLatestSnapshot()?.at).toBe(NOW + 7);
    });
  });

  describe('R3B-Round 3: the per-file read guard is precise, not truncating', () => {
    // Hypothesis: a hostile MIDDLE bucket is skipped without truncating the
    // scan, so healthy buckets older AND newer than it are still returned.
    it('skips only the bad bucket and keeps its healthy neighbours', () => {
      fs.mkdirSync(dir, { recursive: true });
      const old = new Date(2026, 8, 6, 12, 0, 0).getTime();
      const mid = new Date(2026, 8, 7, 12, 0, 0).getTime();
      const nw = new Date(2026, 8, 8, 12, 0, 0).getTime();
      appendEvents([ev(old, 'old')], old);
      appendEvents([ev(nw, 'new')], nw);
      fs.mkdirSync(path.join(dir, eventFileName(mid)));
      expect(readPersistedEvents(50).map((e) => e.agentId)).toEqual(['old', 'new']);
    });
  });

  describe('R3B-Round 4: the newline guard never adds a spurious blank line', () => {
    it('adds no separator after a clean line and exactly one after a fragment', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, eventFileName(NOW));
      expect(appendEvents([ev(NOW, 'one'), ev(NOW, 'two')], NOW)).toBe(2);
      expect(lines(file)).toHaveLength(2);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('\n\n');
      fs.writeFileSync(file, 'FRAGMENT', 'utf8');
      expect(appendEvents([ev(NOW, 'three')], NOW)).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('FRAGMENT\n' + JSON.stringify(ev(NOW, 'three')) + '\n');
    });
  });

  describe('R3B-Round 5: a failed snapshot does not lose or duplicate events', () => {
    it('writes events once and retries only the snapshot', () => {
      fs.mkdirSync(path.join(dir, 'endpoints.json'), { recursive: true });
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      const first = flushTelemetryToDisk(NOW);
      expect(first.eventsWritten).toBe(1);
      expect(first.snapshotWritten).toBe(false);
      expect(getRecentEvents()).toHaveLength(0);

      fs.rmSync(path.join(dir, 'endpoints.json'), { recursive: true, force: true });
      const retry = flushTelemetryToDisk(NOW + 1);
      expect(retry.eventsWritten).toBe(0);
      expect(retry.snapshotWritten).toBe(true);
      expect(readPersistedEvents(10)).toHaveLength(1);
    });
  });

  describe('R3B-Round 6: from-only / to-only events round-trip exactly', () => {
    it('preserves the present side and omits the absent one', () => {
      const toOnly: TelemetryEvent = { at: NOW, type: 'request', agentId: 'to-only', to: { provider: 'p', model: 'm' } };
      const fromOnly: TelemetryEvent = { at: NOW + 1, type: 'failure', agentId: 'from-only', from: { provider: 'q', model: 'n' }, code: 'SERVER' };
      expect(appendEvents([toOnly, fromOnly], NOW)).toBe(2);
      const [a, b] = readPersistedEvents(10);
      expect(a).toEqual(toOnly);
      expect(a).not.toHaveProperty('from');
      expect(b).toEqual(fromOnly);
      expect(b).not.toHaveProperty('to');
    });
  });

  describe('R3B-Round 7: null latency fields survive the snapshot round-trip', () => {
    it('keeps every nullable field null', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      flushTelemetryToDisk(NOW + 1);
      const s = readLatestSnapshot()!.endpoints[0];
      expect(s.lastFailureAt).toBeNull();
      expect(s.lastFailureCode).toBeNull();
      expect(s.lastLatencyMs).toBeNull();
      expect(s.lastSuccessLatencyMs).toBeNull();
    });
  });

  describe('R3B-Round 8: limit exactly equal to the total event count', () => {
    it('returns all events at the exact boundary', () => {
      const day1 = new Date(2026, 8, 7, 12, 0, 0).getTime();
      appendEvents([ev(day1, 'a'), ev(day1, 'b')], day1);
      appendEvents([ev(NOW, 'c')], NOW);
      expect(readPersistedEvents(3).map((e) => e.agentId)).toEqual(['a', 'b', 'c']);
      expect(readPersistedEvents(4)).toHaveLength(3);
    });
  });

  describe('R3B-Round 9: same-day flushes append in call order', () => {
    it('appends the second flush after the first', () => {
      recordRequest('first', { provider: 'p1', model: 'm1' }, NOW);
      flushTelemetryToDisk(NOW);
      recordRequest('second', { provider: 'p1', model: 'm1' }, NOW + 1);
      flushTelemetryToDisk(NOW + 2);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['first', 'second']);
      expect(lines(path.join(dir, eventFileName(NOW)))).toHaveLength(2);
    });
  });

  describe('R3B-Round 10: a stats-only flush writes no event bucket', () => {
    it('reports zero events and no new bucket file', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      flushTelemetryToDisk(NOW);
      const before = fs.readdirSync(dir).filter((f) => f.startsWith('events-'));
      const res = flushTelemetryToDisk(NOW + 1);
      expect(res.eventsWritten).toBe(0);
      expect(res.snapshotWritten).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('events-'))).toEqual(before);
    });
  });

  describe('R3B-Round 11: two persist roots stay isolated', () => {
    it('keeps each root own artifacts', () => {
      const dir2 = path.join(os.tmpdir(), 'dsh-r3b-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      try {
        recordRequest('root-a', { provider: 'p1', model: 'm1' }, NOW);
        flushTelemetryToDisk(NOW);
        setPersistDirForTest(dir2);
        recordRequest('root-b', { provider: 'p2', model: 'm2' }, NOW);
        flushTelemetryToDisk(NOW);
        expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['root-b']);
        setPersistDirForTest(dir);
        expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['root-a']);
        expect(fs.existsSync(path.join(dir2, 'endpoints.json'))).toBe(true);
      } finally {
        setPersistDirForTest(dir);
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });
  });

  describe('R3B-Round 12: CRLF-terminated bucket lines', () => {
    it('trims CR and returns both events', () => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, eventFileName(NOW));
      fs.writeFileSync(file, JSON.stringify(ev(NOW, 'crlf-1')) + '\r\n', 'utf8');
      expect(appendEvents([ev(NOW, 'crlf-2')], NOW)).toBe(1);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['crlf-1', 'crlf-2']);
    });
  });

  describe('R3B-Round 13: appendEvents counts events, not lines', () => {
    it('returns the event count after a fragment', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, eventFileName(NOW)), 'FRAG', 'utf8');
      expect(appendEvents([ev(NOW, 'x'), ev(NOW, 'y')], NOW)).toBe(2);
      expect(readPersistedEvents(10).map((e) => e.agentId)).toEqual(['x', 'y']);
    });
  });

  describe('R3B-Round 14: mutating a ring snapshot cannot alter what flush writes', () => {
    it('persists the original event despite a tampered copy', () => {
      recordRequest('a1', { provider: 'p1', model: 'm1' }, NOW);
      const copy = getRecentEvents();
      copy[0].agentId = 'tampered';
      copy[0].to!.provider = 'tampered';
      flushTelemetryToDisk(NOW);
      const [persisted] = readPersistedEvents(10);
      expect(persisted.agentId).toBe('a1');
      expect(persisted.to).toEqual({ provider: 'p1', model: 'm1' });
    });
  });
});
