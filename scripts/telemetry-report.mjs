#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Offline diagnostics report for the subagents-orchestrator plugin.
 *
 * Reads the artifacts written by the opt-in `persistTelemetry` flag
 * (day-bucketed JSONL event log + endpoint snapshot under
 * ~/.dsh/telemetry/subagents-orchestrator) and prints a human-readable
 * summary. Read-only, dependency-free, safe to run any time — including
 * while DSH is running, since all reads are atomic file snapshots.
 *
 * Usage:
 *   node scripts/telemetry-report.mjs [--json] [--events N] [--dir DIR]
 */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const eventsFlag = args.indexOf('--events');
const limit = eventsFlag >= 0 ? Math.max(1, Number(args[eventsFlag + 1]) || 20) : 20;
const dirFlag = args.indexOf('--dir');
const dirOverride = dirFlag >= 0 ? args[dirFlag + 1] : null;

// Default storage root — mirrors DEFAULT_PERSIST_DIR in src/persist.ts
// (guarded by a parity test). The --dir flag overrides it explicitly.
function defaultDir() {
  return path.join(os.homedir(), '.dsh', 'telemetry', 'subagents-orchestrator');
}

const persistDir = dirOverride || defaultDir();

function readSnapshot() {
  try {
    const file = path.join(persistDir, 'endpoints.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.at === 'number' && Array.isArray(parsed.endpoints) ? parsed : null;
  } catch {
    return null;
  }
}

function listBuckets() {
  try {
    if (!fs.existsSync(persistDir)) return [];
    return fs
      .readdirSync(persistDir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

function readEvents(limitN) {
  const buckets = listBuckets();
  const out = [];
  for (let i = buckets.length - 1; i >= 0 && out.length < limitN; i--) {
    try {
      const lines = fs.readFileSync(path.join(persistDir, buckets[i]), 'utf8').split('\n').reverse();
      for (const line of lines) {
        if (out.length >= limitN) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* corrupt tail line */ }
      }
    } catch { /* unreadable bucket: skip */ }
  }
  return out.reverse();
}

const snapshot = readSnapshot();
const events = readEvents(limit);

if (asJson) {
  process.stdout.write(JSON.stringify({ persistDir, snapshot, recentEvents: events }, null, 2) + '\n');
  process.exit(0);
}

console.log('subagents-orchestrator telemetry report');
console.log('  storage:', persistDir, fs.existsSync(persistDir) ? '' : '(missing)');

if (!snapshot) {
  console.log('  snapshot: none yet (persistTelemetry not enabled, or the plugin has not been disposed)');
} else {
  const age = Math.max(0, Date.now() - snapshot.at);
  console.log(`  snapshot: ${snapshot.endpoints.length} endpoint(s), taken ${Math.round(age / 1000)}s ago`);
  for (const e of snapshot.endpoints) {
    const parts = [
      `req=${e.requests}`,
      `fail=${e.failures}`,
      `failover=${e.failovers}`,
      `hints=${e.cooldownHints}`
    ];
    if (typeof e.latencySamples === 'number' && e.latencySamples > 0) {
      parts.push(`fail-latency avg=${Math.round(e.latencyTotalMs / e.latencySamples)}ms max=${e.latencyMaxMs}ms`);
    }
    if (typeof e.successLatencySamples === 'number' && e.successLatencySamples > 0) {
      parts.push(`ok-latency avg=${Math.round(e.successLatencyTotalMs / e.successLatencySamples)}ms max=${e.successLatencyMaxMs}ms`);
    }
    if (typeof e.tokensTotal === 'number' && e.tokensTotal > 0) {
      parts.push(`tokens=${e.tokensTotal}`);
    }
    console.log(`  - ${e.key}  ${parts.join(' ')}`);
  }
}

const buckets = listBuckets();
console.log(`  event buckets: ${buckets.length} day file(s)`);
if (events.length > 0) {
  console.log(`  recent events (oldest → newest, last ${events.length}):`);
  for (const ev of events) {
    const at = new Date(ev.at).toISOString();
    const who = ev.agentId;
    const from = ev.from ? ` ${ev.from.provider}::${ev.from.model} ->` : '';
    const to = ev.to ? ` ${ev.to.provider}::${ev.to.model}` : '';
    const code = ev.code ? ` [${ev.code}${typeof ev.hintMs === 'number' ? ` +${Math.round(ev.hintMs / 1000)}s` : ''}]` : '';
    const span = typeof ev.successLatencyMs === 'number' ? ` ~${ev.successLatencyMs}ms` : '';
    const toks = typeof ev.tokens === 'number' ? ` (${ev.tokens} tok)` : '';
    console.log(`    ${at}  ${ev.type.padEnd(8)} ${who}${from}${to}${code}${span}${toks}`);
  }
}
