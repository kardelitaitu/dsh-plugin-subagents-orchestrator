import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setPersistDirForTest,
  appendEvents,
  readPersistedEvents,
  readLatestSnapshot,
  writeEndpointStatsSnapshot,
  pruneOldBuckets,
  eventFileName,
  MAX_PERSIST_DAYS
} from '../src/persist.js';
import type { TelemetryEvent } from '../src/telemetry.js';

/**
 * TDD round 9: persistence-layer boundary contracts.
 *
 * Their suite covers the happy paths; these probes pin the truncation,
 * corruption, and retention-boundary edges.
 */
describe('TDD round 9: persist boundary contracts', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tdd9-'));
    setPersistDirForTest(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    setPersistDirForTest(null);
  });

  const ev = (at: number, type: TelemetryEvent['type'], id: string): TelemetryEvent =>
    ({ at, type, agentId: id } as TelemetryEvent);

  it('PROBE 1: truncation keeps the NEWEST events across buckets, oldest-first', () => {
    const day1 = Date.UTC(2025, 0, 1, 12);
    const day2 = Date.UTC(2025, 0, 2, 12);
    appendEvents([ev(day1, 'request', 'd1-a'), ev(day1, 'failure', 'd1-b'), ev(day1, 'failover', 'd1-c')], day1);
    appendEvents([ev(day2, 'request', 'd2-a'), ev(day2, 'failure', 'd2-b'), ev(day2, 'failover', 'd2-c')], day2);

    const read = readPersistedEvents(4);
    expect(read.map((e) => (e as { agentId: string }).agentId)).toEqual(['d1-c', 'd2-a', 'd2-b', 'd2-c']);
  });

  it('PROBE 2: degenerate limits return empty results without throwing', () => {
    const now = Date.UTC(2025, 0, 1, 12);
    appendEvents([ev(now, 'request', 'x')], now);

    expect(readPersistedEvents(0)).toEqual([]);
    expect(readPersistedEvents(-5)).toEqual([]);
    expect(readPersistedEvents(Number.NaN)).toEqual([]);
    expect(readPersistedEvents(10).map((e) => (e as { agentId: string }).agentId)).toEqual(['x']);
  });

  it('PROBE 3: corrupt or malformed snapshots read as null', () => {
    expect(readLatestSnapshot()).toBeNull(); // nothing written yet

    fs.writeFileSync(path.join(dir, 'endpoints.json'), 'not json at all', 'utf8');
    expect(readLatestSnapshot()).toBeNull();

    fs.writeFileSync(path.join(dir, 'endpoints.json'), JSON.stringify({ wrong: 'shape' }), 'utf8');
    expect(readLatestSnapshot()).toBeNull();

    writeEndpointStatsSnapshot(
      [{ key: 'k', provider: 'p', model: 'm', requests: 1, failures: 0, failovers: 0, cooldownHints: 0, lastFailureAt: null, lastFailureCode: null }],
      1234
    );
    expect(readLatestSnapshot()?.at).toBe(1234);
  });

  it('PROBE 4: retention keeps exactly the newest MAX_PERSIST_DAYS buckets', () => {
    // 9 buckets, oldest 2 days beyond the window
    for (let d = 0; d < 9; d++) {
      const at = Date.UTC(2025, 0, 1 + d, 12);
      appendEvents([ev(at, 'request', `day-${d}`)], at);
    }

    const removed = pruneOldBuckets(Date.UTC(2025, 0, 9, 12));
    expect(removed).toHaveLength(9 - MAX_PERSIST_DAYS);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(remaining).toHaveLength(MAX_PERSIST_DAYS);
    expect(remaining.some((f) => f.includes('2025-01-01'))).toBe(false);
    expect(remaining.some((f) => f.includes('2025-01-08'))).toBe(true);

    // A second prune at the boundary removes nothing more
    expect(pruneOldBuckets(Date.UTC(2025, 0, 9, 12))).toEqual([]);
  });

  it('PROBE 5: bucket names are zero-padded and appends are side-effect free for empty input', () => {
    expect(eventFileName(Date.UTC(2025, 0, 5, 8))).toBe('events-2025-01-05.jsonl');
    expect(eventFileName(Date.UTC(2025, 10, 23, 8))).toBe('events-2025-11-23.jsonl');

    // An empty append must not even create the storage root: point at a
    // path that genuinely does not exist yet.
    const absent = path.join(dir, 'never-created');
    setPersistDirForTest(absent);
    expect(appendEvents([], Date.now())).toBe(0);
    expect(fs.existsSync(absent)).toBe(false);
    expect(readPersistedEvents(10)).toEqual([]);
  });
});
