import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'telemetry-report.mjs');

/**
 * The offline CLI report reads the same artifacts persist.ts writes and
 * must degrade gracefully when they are missing or partially corrupt.
 */
describe('scripts/telemetry-report.mjs (offline diagnostics)', () => {
  let dir: string;
  let cleanup: string[] = [];

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `dsh-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  function runScript(args: string[]): { stdout: string; code: number } {
    return new Promise((resolve) => {
      exec('node', [scriptPath, ...args], (error, stdout) => {
        // Exit code 0 is expected for report generation, even on missing data.
        resolve({ stdout, code: error && typeof (error as any).code === 'number' ? (error as any).code : 0 });
      });
    });
  }

  it('renders snapshot stats and recent events from a populated store', async () => {
    fs.mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    fs.writeFileSync(
      path.join(dir, 'endpoints.json'),
      JSON.stringify({
        at: Date.now() - 40_000,
        endpoints: [
          { key: 'p1::m1', provider: 'p1', model: 'm1', requests: 12, failures: 2, failovers: 1, cooldownHints: 1, latencySamples: 2, latencyTotalMs: 1600, latencyMaxMs: 900 },
          { key: 'p2::m2', provider: 'p2', model: 'm2', requests: 5, failures: 0, failovers: 0, cooldownHints: 0 }
        ]
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`),
      [
        JSON.stringify({ at: Date.now() - 2000, type: 'request', agentId: 'agent-a', to: { provider: 'p1', model: 'm1' } }),
        JSON.stringify({ at: Date.now() - 1000, type: 'failure', agentId: 'agent-a', from: { provider: 'p1', model: 'm1' }, code: 'RATE_LIMIT', hintMs: 30_000 }),
        JSON.stringify({ at: Date.now(), type: 'failover', agentId: 'agent-a', from: { provider: 'p1', model: 'm1' }, to: { provider: 'p2', model: 'm2' } })
      ].join('\n'),
      'utf8'
    );

    const { stdout, code } = await runScript(['--dir', dir, '--events', '5']);
    expect(code).toBe(0);
    expect(stdout).toContain('snapshot: 2 endpoint(s)');
    expect(stdout).toContain('p1::m1');
    expect(stdout).toContain('fail-latency avg=800ms max=900ms');
    expect(stdout).toContain('[RATE_LIMIT +30s]');
    expect(stdout).toContain('p1::m1 -> p2::m2');
  });

  it('degrades gracefully on a missing store and reports the location', async () => {
    const missing = path.join(dir, 'never-created');
    const { stdout, code } = await runScript(['--dir', missing]);
    expect(code).toBe(0);
    expect(stdout).toContain('(missing)');
    expect(stdout).toContain('snapshot: none yet');
    expect(stdout).toContain('event buckets: 0 day file(s)');
  });

  it('emits machine-readable JSON for tooling', async () => {
    fs.mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    fs.writeFileSync(
      path.join(dir, 'endpoints.json'),
      JSON.stringify({ at: 123, endpoints: [{ key: 'p1::m1', provider: 'p1', model: 'm1', requests: 1, failures: 0, failovers: 0, cooldownHints: 0 }] }),
      'utf8'
    );
    const { stdout, code } = await runScript(['--json', '--dir', dir]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.snapshot.at).toBe(123);
    expect(parsed.snapshot.endpoints[0].key).toBe('p1::m1');
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
  });
});
