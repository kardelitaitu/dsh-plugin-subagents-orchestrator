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
 * TDD round 15: offline report edge contracts.
 *
 * The script reimplements the persist read logic in a dependency-free CLI
 * context; these probes pin the truncation ordering, corruption tolerance,
 * and flag edge cases that decide whether the report can be trusted.
 */
describe('TDD round 15: telemetry-report edge contracts', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `dsh-tdd15-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runScript(args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      exec('node', [scriptPath, ...args], (error, stdout) => {
        resolve({ stdout, code: error && typeof (error as any).code === 'number' ? (error as any).code : 0 });
      });
    });
  }

  function writeBucket(name: string, lines: string[]): void {
    fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n', 'utf8');
  }

  const ev = (id: string, type = 'request') => JSON.stringify({ at: 1000, type, agentId: id });

  it('PROBE 1: --events truncation keeps the NEWEST events across buckets, oldest-first', async () => {
    writeBucket('events-2025-01-01.jsonl', [ev('d1-a'), ev('d1-b'), ev('d1-c')]);
    writeBucket('events-2025-01-02.jsonl', [ev('d2-a'), ev('d2-b'), ev('d2-c')]);

    const { stdout, code } = await runScript(['--json', '--dir', dir, '--events', '4']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.recentEvents.map((e: { agentId: string }) => e.agentId)).toEqual(['d1-c', 'd2-a', 'd2-b', 'd2-c']);
  });

  it('PROBE 2: a corrupt line never shifts or breaks truncation', async () => {
    writeBucket('events-2025-01-01.jsonl', [ev('d1-a'), ev('d1-b')]);
    writeBucket('events-2025-01-02.jsonl', ['{corrupt json', ev('d2-a'), 'not json either', ev('d2-b')]);

    const { stdout } = await runScript(['--json', '--dir', dir, '--events', '3']);
    const parsed = JSON.parse(stdout);
    expect(parsed.recentEvents.map((e: { agentId: string }) => e.agentId)).toEqual(['d1-b', 'd2-a', 'd2-b']);
  });

  it('PROBE 3: a corrupt snapshot degrades to null without crashing', async () => {
    fs.writeFileSync(path.join(dir, 'endpoints.json'), '{{{not json', 'utf8');
    writeBucket('events-2025-01-01.jsonl', [ev('x')]);

    const { stdout, code } = await runScript(['--json', '--dir', dir]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.snapshot).toBeNull();
    expect(parsed.recentEvents).toHaveLength(1);
  });

  it('PROBE 4: --events edge values fall back or clamp predictably', async () => {
    writeBucket('events-2025-01-01.jsonl', [ev('a'), ev('b'), ev('c')]);

    // --events 0 falls back to the default 20 (so all 3 events appear)
    const zero = JSON.parse((await runScript(['--json', '--dir', dir, '--events', '0'])).stdout);
    expect(zero.recentEvents).toHaveLength(3);

    // --events 1 clamps to exactly the newest single event
    const one = JSON.parse((await runScript(['--json', '--dir', dir, '--events', '1'])).stdout);
    expect(one.recentEvents.map((e: { agentId: string }) => e.agentId)).toEqual(['c']);

    // A missing value after the flag falls back to the default
    const missing = JSON.parse((await runScript(['--json', '--dir', dir, '--events'])).stdout);
    expect(missing.recentEvents).toHaveLength(3);
  });
});
