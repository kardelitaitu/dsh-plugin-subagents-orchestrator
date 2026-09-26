import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The offline reporter (scripts/telemetry-report.mjs) is the out-of-process
 * consumer of the persisted store, and it duplicates persist.ts's read logic.
 * That duplication is why persist.ts's round-2 shape filter did not protect it:
 * a valid-JSON line with no usable 'at' reached the formatter and aborted the
 * whole report with 'RangeError: Invalid time value' (exit 1), so a single
 * hand-edited or truncated line could make support diagnostics unusable.
 *
 * These probes run the REAL script against a hostile temp store, because the
 * bug only manifests end to end.
 */
describe('telemetry-report: hostile store resilience', () => {
  const dir = path.join(os.tmpdir(), 'dsh-report-hardening-' + Date.now());

  const run = () => {
    try {
      const out = execFileSync(process.execPath, ['scripts/telemetry-report.mjs', '--dir', dir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  };

  beforeEach(() => fs.mkdirSync(dir, { recursive: true }));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('REGRESSION: a valid-JSON line with no at does not abort the report', () => {
    fs.writeFileSync(
      path.join(dir, 'events-2026-01-01.jsonl'),
      '{"type":"request","agentId":"no-at"}\n{"type":"success","agentId":"ok","at":' + Date.now() + '}\n',
      'utf8'
    );
    const r = run();
    console.log('exit', r.code, '| has report header:', r.out.includes('telemetry report'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('telemetry report');
  });

  it('REGRESSION: primitives and arrays are skipped, not formatted', () => {
    fs.writeFileSync(
      path.join(dir, 'events-2026-01-01.jsonl'),
      ['null', '42', '"bare string"', '[1,2,3]', '{"type":"success","agentId":"ok","at":' + Date.now() + '}'].join('\n') + '\n',
      'utf8'
    );
    const r = run();
    console.log('exit', r.code);
    expect(r.code).toBe(0);
  });

  it('REGRESSION: an out-of-range timestamp renders instead of throwing', () => {
    fs.writeFileSync(
      path.join(dir, 'events-2026-01-01.jsonl'),
      '{"type":"failure","agentId":"huge","at":1e300}\n',
      'utf8'
    );
    const r = run();
    console.log('exit', r.code, '| contains RangeError:', r.out.includes('RangeError'));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('RangeError');
  });

  it('still reports a clean store normally', () => {
    fs.writeFileSync(
      path.join(dir, 'events-2026-01-01.jsonl'),
      '{"type":"success","agentId":"ok","at":' + Date.now() + '}\n',
      'utf8'
    );
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('success');
  });
});
