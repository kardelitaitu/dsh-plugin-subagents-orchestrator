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
  getPersistDir,
  DEFAULT_PERSIST_DIR,
  MAX_PERSIST_DAYS
} from '../src/persist.js';
import { recordRequest, drainRecentEvents } from '../src/telemetry.js';
import type { TelemetryEvent } from '../src/telemetry.js';

const NOW = new Date('2026-09-08T12:00:00Z').getTime();

describe('Telemetry persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `dsh-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setPersistDirForTest(dir);
    resetTelemetryBuffer();
  });

  afterEach(() => {
    setPersistDirForTest(null);
    resetTelemetryBuffer();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function resetTelemetryBuffer(): void {
    // drain without a dir: clears the telemetry ring buffer between tests
    drainRecentEvents();
  }

  it('appends and reads back events, oldest first, skipping malformed lines', () => {
    const events: TelemetryEvent[] = [
      { at: NOW, type: 'request', agentId: 'a1', to: { provider: 'p1', model: 'm1' } },
      { at: NOW + 1, type: 'failure', agentId: 'a1', from: { provider: 'p1', model: 'm1' }, code: 'RATE_LIMIT' }
    ];
    expect(appendEvents(events, NOW)).toBe(2);
    // corrupt the file on purpose: prepend a broken line
    const file = path.join(dir, eventFileName(NOW));
    fs.writeFileSync(file, '{broken-json\n' + fs.readFileSync(file, 'utf8'), 'utf8');

    const read = readPersistedEvents(50);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({ type: 'request', agentId: 'a1' });
    expect(read[1]).toMatchObject({ type: 'failure', code: 'RATE_LIMIT' });
  });

  it('buckets by day and reads across buckets chronologically', () => {
    const day1 = new Date('2026-09-07T10:00:00Z').getTime();
    const day2 = NOW;
    appendEvents([{ at: day2, type: 'failover', agentId: 'a', to: { provider: 'p2', model: 'm' } }], day2);
    appendEvents([{ at: day1, type: 'request', agentId: 'a', to: { provider: 'p1', model: 'm' } }], day1);

    expect(fs.existsSync(path.join(dir, eventFileName(day1)))).toBe(true);
    expect(fs.existsSync(path.join(dir, eventFileName(day2)))).toBe(true);

    const read = readPersistedEvents(50);
    expect(read.map((e) => e.type)).toEqual(['request', 'failover']);
  });

  it('drains the telemetry buffer exactly once per flush', () => {
    recordRequest('agent-x', { provider: 'p1', model: 'm1' }, NOW);
    const drained = drainRecentEvents();
    expect(drained).toHaveLength(1);
    expect(drainRecentEvents()).toHaveLength(0); // buffer cleared

    expect(appendEvents(drained, NOW)).toBe(1);
    expect(readPersistedEvents(10)[0]).toMatchObject({ agentId: 'agent-x', type: 'request' });
  });

  it('writes an atomic endpoint snapshot with no tmp leftovers', () => {
    const ok = writeEndpointStatsSnapshot(
      [{ key: 'p1::m1', provider: 'p1', model: 'm1', requests: 3, failures: 1, failovers: 0, cooldownHints: 0, lastFailureAt: NOW, lastFailureCode: 'SERVER' }],
      NOW
    );
    expect(ok).toBe(true);

    const snapshot = readLatestSnapshot();
    expect(snapshot?.at).toBe(NOW);
    expect(snapshot?.endpoints[0]).toMatchObject({ key: 'p1::m1', failures: 1 });

    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('never throws when the storage root cannot be created', () => {
    // A FILE where the directory should be: mkdirSync must fail.
    const blocker = path.join(os.tmpdir(), `dsh-persist-block-${Date.now()}`);
    fs.writeFileSync(blocker, 'not a dir', 'utf8');
    setPersistDirForTest(path.join(blocker, 'nested'));

    try {
      expect(appendEvents([{ at: NOW, type: 'request', agentId: 'a', to: { provider: 'p', model: 'm' } }], NOW)).toBe(0);
      expect(writeEndpointStatsSnapshot([], NOW)).toBe(false);
      expect(readPersistedEvents(10)).toEqual([]);
      expect(readLatestSnapshot()).toBeNull();
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });

  it('prunes day buckets beyond the retention window', () => {
    for (let d = 0; d < MAX_PERSIST_DAYS + 2; d++) {
      const t = NOW - d * 24 * 60 * 60 * 1000;
      appendEvents([{ at: t, type: 'request', agentId: 'a', to: { provider: 'p', model: 'm' } }], t);
    }
    const removed = pruneOldBuckets(NOW);
    expect(removed).toHaveLength(2);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('events-'));
    expect(files).toHaveLength(MAX_PERSIST_DAYS);
  });

  it('falls back to the default dir and exposes it', () => {
    setPersistDirForTest(null);
    expect(getPersistDir()).toBe(DEFAULT_PERSIST_DIR);
  });
});
