import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { drainRecentEvents, getEndpointStats, getRecentEvents } from './telemetry.js';
import type { TelemetryEvent, EndpointStats } from './telemetry.js';

/**
 * Durable persistence for orchestrator telemetry (Phase 3 diagnostics).
 *
 * Deliberately standalone: plain node:fs, no scheduler, no host coupling.
 * Nothing here throws — a diagnostics writer must never take the host plane
 * down. Callers opt in explicitly (see `flushTelemetryToDisk`), so wiring is
 * a one-line change and tests stay hermetic via `setPersistDirForTest`.
 *
 * Layout under the persist dir:
 * - `events-YYYY-MM-DD.jsonl` — one JSON event per line (append-only, day-bucketed)
 * - `endpoints.json` — latest endpoint stats snapshot (atomic tmp+rename)
 */

/** Default storage root alongside the rest of the `.dsh` state. */
export const DEFAULT_PERSIST_DIR = path.join(os.homedir(), '.dsh', 'telemetry', 'subagents-orchestrator');

/** Daily event files older than this are pruned on flush. */
export const MAX_PERSIST_DAYS = 7;

let persistDir = DEFAULT_PERSIST_DIR;

/** Override the storage root (tests, or a future config knob). */
export function setPersistDirForTest(dir: string | null): void {
  persistDir = dir ?? DEFAULT_PERSIST_DIR;
}

/** Current storage root (mainly for diagnostics and tests). */
export function getPersistDir(): string {
  return persistDir;
}

/** `events-YYYY-MM-DD.jsonl` bucket name for the given instant. */
export function eventFileName(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `events-${d.getFullYear()}-${mm}-${dd}.jsonl`;
}

function ensureDir(): boolean {
  try {
    fs.mkdirSync(persistDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Append events to today's JSONL bucket. Returns the number of lines written. */
export function appendEvents(events: TelemetryEvent[], now: number = Date.now()): number {
  if (!events || events.length === 0) return 0;
  if (!ensureDir()) return 0;
  const file = path.join(persistDir, eventFileName(now));
  try {
    const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(file, payload, 'utf8');
    return events.length;
  } catch {
    return 0;
  }
}

/** Read persisted events across day buckets, oldest first. Malformed lines are skipped. */
export function readPersistedEvents(limit: number = 500): TelemetryEvent[] {
  try {
    if (!fs.existsSync(persistDir)) return [];
    const files = fs
      .readdirSync(persistDir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort(); // lexicographic == chronological for zero-padded dates
    const out: TelemetryEvent[] = [];
    for (let i = files.length - 1; i >= 0 && out.length < limit; i--) {
      const raw = fs.readFileSync(path.join(persistDir, files[i]), 'utf8');
      const lines = raw.split('\n').reverse(); // newest lines first within a bucket
      for (const line of lines) {
        if (out.length >= limit) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as TelemetryEvent);
        } catch {
          // Partial/corrupt line (e.g. crash mid-append): skip, keep reading.
        }
      }
    }
    return out.reverse(); // caller sees oldest -> newest
  } catch {
    return [];
  }
}

/** Atomically replace the endpoint snapshot. Returns false on any failure. */
export function writeEndpointStatsSnapshot(stats: EndpointStats[], now: number = Date.now()): boolean {
  if (!ensureDir()) return false;
  const target = path.join(persistDir, 'endpoints.json');
  const tmp = path.join(persistDir, `.endpoints.${process.pid}.${now}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: now, endpoints: stats }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/** The latest endpoint snapshot, or null when none exists / it is unreadable. */
export function readLatestSnapshot(): { at: number; endpoints: EndpointStats[] } | null {
  try {
    const file = path.join(persistDir, 'endpoints.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; endpoints: EndpointStats[] };
    if (typeof parsed?.at !== 'number' || !Array.isArray(parsed?.endpoints)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Keep only the newest `MAX_PERSIST_DAYS` event buckets. Returns files removed. */
export function pruneOldBuckets(now: number = Date.now()): string[] {
  try {
    if (!fs.existsSync(persistDir)) return [];
    const files = fs
      .readdirSync(persistDir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
    const removed: string[] = [];
    for (const file of files.slice(MAX_PERSIST_DAYS)) {
      try {
        fs.rmSync(path.join(persistDir, file), { force: true });
        removed.push(file);
      } catch { /* a stuck file must not break the flush */ }
    }
    return removed;
  } catch {
    return [];
  }
}

/** Result of one flush pass; every counter is best-effort. */
export interface FlushResult {
  /** Events appended to the day-bucket log (0 when the buffer was empty). */
  eventsWritten: number;
  /** Whether the endpoint snapshot was replaced. */
  snapshotWritten: boolean;
  /** Day buckets removed by retention pruning. */
  bucketsPruned: string[];
}

/**
 * One telemetry flush pass: drain the ring buffer into the day-bucket log,
 * atomically replace the endpoint snapshot, then apply retention pruning.
 *
 * Safe to call at any cadence — an empty buffer writes nothing (not even the
 * storage root). Never throws: a diagnostics flush must never take the host
 * plane down, so failures surface as falsey counters in the result.
 */
export function flushTelemetryToDisk(now: number = Date.now()): FlushResult {
  // Peek first, append, and only consume the buffer once the append
  // actually succeeded: a drain-first order would lose buffered
  // diagnostics if the append fails (e.g. the disk fills mid-write).
  const pending: TelemetryEvent[] = getRecentEvents();
  const eventsWritten = pending.length > 0 ? appendEvents(pending, now) : 0;
  if (pending.length > 0 && eventsWritten === pending.length) {
    drainRecentEvents();
  }
  const snapshotWritten = writeEndpointStatsSnapshot(getEndpointStats(), now);
  const bucketsPruned = pruneOldBuckets(now);
  return { eventsWritten, snapshotWritten, bucketsPruned };
}
