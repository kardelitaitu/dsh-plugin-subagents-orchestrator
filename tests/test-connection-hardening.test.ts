import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  composeTimeout,
  storedBaseURL,
  runEndpointTest,
  bindEndpointTest
} from '../src/client/testConnection.js';

/**
 * Adversarial regressions for the Test-Connection probe (the panel's
 * client->host RPC path).
 *
 * This is a trust boundary in both directions: the host can answer with any
 * shape, and the probe must degrade to a structured outcome rather than throw
 * into the panel's click handler. Two real defects were found and fixed here:
 *
 *  - storedBaseURL() read \`described.value?.namespaces ?? []\` and called
 *    .find(). The \`??\` guards only null/undefined, so a non-array
 *    \`namespaces\` (or a non-object \`value\`) threw a TypeError straight
 *    out of storedBaseURL, through runEndpointTest's documented never-throw
 *    guarantee, and into the click handler.
 *  - runEndpointTest() read \`response.ok\` without checking \`response\` was an
 *    envelope at all, so a null/undefined answer surfaced the raw text
 *    "Cannot read properties of null (reading 'ok')" to the user.
 *
 * The rest of the file pins the surrounding contract that already held:
 * dispose really clears the timeout, an aborted caller signal propagates, and
 * every hostile face resolves to a structured outcome.
 */
describe('testConnection: trust-boundary hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('storedBaseURL never throws (returns undefined)', () => {
    it('returns undefined when describe() rejects', async () => {
      const settings = { describe: async () => { throw new Error('boom'); } };
      await expect(storedBaseURL(settings as never, 'p')).resolves.toBeUndefined();
    });

    it('returns undefined for a null face without calling describe', async () => {
      await expect(storedBaseURL(null, 'p')).resolves.toBeUndefined();
    });

    it('returns undefined when the envelope reports ok:false', async () => {
      const settings = { describe: async () => ({ ok: false as const, error: { message: 'nope' } }) };
      await expect(storedBaseURL(settings as never, 'p')).resolves.toBeUndefined();
    });

    it('REGRESSION: a non-array namespaces is a shape failure, not a throw', async () => {
      for (const namespaces of ['nope', 42, true, { not: 'an array' }, () => []] as unknown[]) {
        const settings = { describe: async () => ({ ok: true as const, value: { namespaces } }) };
        const outcome = await storedBaseURL(settings as never, 'p');
        expect(outcome, 'namespaces=' + String(namespaces)).toBeUndefined();
      }
    });

    it('REGRESSION: a non-object describe value is a shape failure, not a throw', async () => {
      for (const value of [null, undefined, 'string', 7, true] as unknown[]) {
        const settings = { describe: async () => ({ ok: true as const, value }) };
        const outcome = await storedBaseURL(settings as never, 'p');
        expect(outcome, 'value=' + String(value)).toBeUndefined();
      }
    });

    it('returns undefined for a missing namespace, a non-object provider record, and a blank baseURL', async () => {
      const wrap = (providers: unknown) => ({
        describe: async () => ({ ok: true as const, value: { namespaces: [{ ns: 'other', value: { providers } }] } })
      });
      await expect(storedBaseURL(wrap({ p: { baseURL: 'https://x' } }) as never, 'p')).resolves.toBeUndefined();

      const wrongNs = {
        describe: async () => ({ ok: true as const, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { p: { baseURL: '  ' } } } }] } })
      };
      await expect(storedBaseURL(wrongNs as never, 'p')).resolves.toBeUndefined();

      const nonStringBase = {
        describe: async () => ({ ok: true as const, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { p: { baseURL: 42 } } } }] } })
      };
      await expect(storedBaseURL(nonStringBase as never, 'p')).resolves.toBeUndefined();
    });

    it('returns the stored baseURL on the happy path', async () => {
      const settings = {
        describe: async () => ({ ok: true as const, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { p: { baseURL: 'https://api.example.com/v1' } } } }] } })
      };
      await expect(storedBaseURL(settings as never, 'p')).resolves.toBe('https://api.example.com/v1');
    });
  });

  describe('runEndpointTest always resolves to a structured outcome', () => {
    it('REGRESSION: a non-envelope response is a probe failure, not a raw TypeError', async () => {
      for (const answer of [null, undefined, 'ok', 42, true] as unknown[]) {
        const llm = { discoverModels: async () => answer };
        const outcome = await runEndpointTest({ llm } as never, { provider: 'p', model: 'm', baseURL: 'https://x' });
        expect(outcome.status, 'answer=' + String(answer)).toBe('fail');
        const message = outcome.status === 'fail' ? outcome.message : '';
        expect(message).not.toContain('Cannot read properties');
        expect(message).not.toContain('undefined');
      }
    });

    it('never throws for a face that throws synchronously or asynchronously', async () => {
      const throwing = [
        { discoverModels: () => { throw new Error('sync boom'); } },
        { discoverModels: async () => { throw new Error('async boom'); } }
      ];
      for (const llm of throwing) {
        const outcome = await runEndpointTest({ llm } as never, { provider: 'p', model: 'm', baseURL: 'https://x' });
        expect(outcome.status).toBe('fail');
      }
    });

    it('REGRESSION: a malformed describe() does not escape when no baseURL was supplied', async () => {
      const settings = { describe: async () => ({ ok: true as const, value: { namespaces: 'nope' } }) };
      const llm = { discoverModels: async () => ({ ok: true as const, value: [] }) };
      const outcome = await runEndpointTest({ llm, settings } as never, { provider: 'p', model: 'm' });
      // No baseURL is resolvable, so the probe reports that -- it must not throw.
      expect(['fail', 'ok', 'unavailable']).toContain(outcome.status);
    });

    it('tolerates null/undefined entries in the advertised model list', async () => {
      const llm = { discoverModels: async () => ({ ok: true as const, value: [null, { id: 'm' }, undefined] }) };
      const outcome = await runEndpointTest({ llm } as never, { provider: 'p', model: 'm', baseURL: 'https://x' });
      expect(outcome.status).toBe('ok');
      expect(outcome.status === 'ok' && outcome.modelFound).toBe(true);
    });
  });

  describe('composeTimeout lifecycle', () => {
    it('dispose clears the timer so it cannot abort later', () => {
      vi.useFakeTimers();
      const composed = composeTimeout(undefined, 10_000);
      composed.dispose();
      vi.advanceTimersByTime(60_000);
      expect(composed.signal.aborted).toBe(false);
    });

    it('an already-aborted caller signal aborts immediately', () => {
      const caller = new AbortController();
      caller.abort();
      const composed = composeTimeout(caller.signal, 10_000);
      expect(composed.signal.aborted).toBe(true);
      composed.dispose();
    });

    it('dispose detaches the caller listener, so a late abort does not leak through', () => {
      const caller = new AbortController();
      const composed = composeTimeout(caller.signal, 10_000);
      composed.dispose();
      caller.abort();
      expect(composed.signal.aborted).toBe(false);
    });

    it('propagates the caller abort reason', () => {
      const caller = new AbortController();
      const reason = new Error('caller cancelled');
      const composed = composeTimeout(caller.signal, 10_000);
      caller.abort(reason);
      expect(composed.signal.reason).toBe(reason);
      composed.dispose();
    });

    it('the timeout aborts with a descriptive error', () => {
      vi.useFakeTimers();
      const composed = composeTimeout(undefined, 5_000);
      vi.advanceTimersByTime(5_001);
      expect(composed.signal.aborted).toBe(true);
      expect(String(composed.signal.reason)).toContain('timed out');
      composed.dispose();
    });
  });
});

// =====================================================================
// Round 3: guard PRECISION on the round-2 hardening.
// =====================================================================

describe('testConnection: round-3 precision probes', () => {
  const llmReturning = (answer: unknown) => ({ discoverModels: async () => answer });

  describe('the non-envelope guard must not swallow a real failure', () => {
    it('surfaces a valid ok:false envelope error verbatim', async () => {
      const outcome = await runEndpointTest(
        { llm: llmReturning({ ok: false, error: { message: 'quota exceeded for this key', code: 'QUOTA' } }) } as never,
        { provider: 'p', model: 'm', baseURL: 'https://x' }
      );
      expect(outcome.status).toBe('fail');
      expect(outcome.status === 'fail' && outcome.message).toBe('quota exceeded for this key');
    });

    it('uses the generic text only when the envelope carries no usable message', async () => {
      for (const answer of [
        { ok: false },
        { ok: false, error: null },
        { ok: false, error: {} },
        { ok: false, error: { message: '' } }
      ]) {
        const outcome = await runEndpointTest({ llm: llmReturning(answer) } as never, { provider: 'p', baseURL: 'https://x' });
        expect(outcome.status, JSON.stringify(answer)).toBe('fail');
        const message = outcome.status === 'fail' ? outcome.message : '';
        expect(message).not.toContain('no result');
      }
    });

    it('does not treat a valid ok:true envelope as a non-envelope', async () => {
      const outcome = await runEndpointTest(
        { llm: llmReturning({ ok: true, value: [{ id: 'm' }] }) } as never,
        { provider: 'p', model: 'm', baseURL: 'https://x' }
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.status === 'ok' && outcome.modelFound).toBe(true);
    });
  });

  describe('runEndpointTest must honour its documented never-throw contract for the CALLER too', () => {
    it('does not throw on a non-string baseURL', async () => {
      for (const baseURL of [42, true, {}, [], () => 'x'] as unknown[]) {
        const outcome = await runEndpointTest(
          { llm: llmReturning({ ok: true, value: [] }) } as never,
          { provider: 'p', baseURL } as never
        );
        expect(['fail', 'ok', 'unavailable'], 'baseURL=' + String(baseURL)).toContain(outcome.status);
      }
    });
  });

  describe('storedBaseURL tolerates a namespaces array containing non-objects', () => {
    it('skips junk entries and still finds the namespace', async () => {
      const settings = {
        describe: async () => ({
          ok: true as const,
          value: { namespaces: [null, 7, 'str', { ns: 'llm-pi-ai', value: { providers: { p: { baseURL: 'https://ok' } } } }] }
        })
      };
      await expect(storedBaseURL(settings as never, 'p')).resolves.toBe('https://ok');
    });

    it('returns undefined when every entry is junk', async () => {
      const settings = {
        describe: async () => ({ ok: true as const, value: { namespaces: [null, 7, 'str', []] } })
      };
      await expect(storedBaseURL(settings as never, 'p')).resolves.toBeUndefined();
    });
  });

  describe('the stored baseURL must be usable verbatim', () => {
    it('hands the probe a TRIMMED url, matching the user-entered path', async () => {
      let seen: any = null;
      const llm = { discoverModels: async (_ns: string, request: any) => { seen = request; return { ok: true as const, value: [] }; } };
      const settings = {
        describe: async () => ({
          ok: true as const,
          value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { p: { baseURL: '  https://api.example.com/v1  ' } } } }] }
        })
      };
      await runEndpointTest({ llm, settings } as never, { provider: 'p', model: 'm' });
      expect(seen?.baseURL).toBe('https://api.example.com/v1');
    });
  });

  describe('modelContextWindow is only reported when it is a number', () => {
    it('omits a non-numeric context window', async () => {
      const outcome = await runEndpointTest(
        { llm: llmReturning({ ok: true, value: [{ id: 'm', contextWindow: 'lots' }] }) } as never,
        { provider: 'p', model: 'm', baseURL: 'https://x' }
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.status === 'ok' && outcome.modelContextWindow).toBeUndefined();
    });

    it('keeps a numeric context window', async () => {
      const outcome = await runEndpointTest(
        { llm: llmReturning({ ok: true, value: [{ id: 'm', contextWindow: 8192 }] }) } as never,
        { provider: 'p', model: 'm', baseURL: 'https://x' }
      );
      expect(outcome.status === 'ok' && outcome.modelContextWindow).toBe(8192);
    });
  });

  describe('a caller abort mid-probe still resolves structured', () => {
    it('reports fail and does not hang', async () => {
      const caller = new AbortController();
      const llm = {
        discoverModels: (_ns: string, _req: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            caller.abort();
          })
      };
      const outcome = await runEndpointTest({ llm } as never, { provider: 'p', baseURL: 'https://x' }, caller.signal);
      expect(outcome.status).toBe('fail');
    });
  });
});

// =====================================================================
// Round 3: the ctx->faces adapter (remoteFace) is the real entry point.
// =====================================================================

describe('testConnection: bindEndpointTest never throws on a hostile ctx', () => {
  it('degrades to unavailable/undefined when ctx.remote throws on access', async () => {
    const hostile = {
      get remote(): never {
        throw new Error('cordis refuses property access on an unprovided service');
      }
    };
    const face = bindEndpointTest(hostile);
    const outcome = await face.run({ provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('unavailable');
    await expect(face.storedBaseURL('p')).resolves.toBeUndefined();
  });

  it('degrades for a null/undefined/primitive ctx', async () => {
    for (const ctx of [null, undefined, 0, '', false, 'ctx'] as unknown[]) {
      const face = bindEndpointTest(ctx);
      const outcome = await face.run({ provider: 'p', baseURL: 'https://x' });
      expect(outcome.status, 'ctx=' + String(ctx)).toBe('unavailable');
      await expect(face.storedBaseURL('p')).resolves.toBeUndefined();
    }
  });

  it('degrades when the mounted face is present but malformed', async () => {
    for (const remote of [{}, { llm: null }, { llm: {} }, { llm: { discoverModels: 42 } }, { llm: { discoverModels: 'x' } }]) {
      const face = bindEndpointTest({ remote } as never);
      const outcome = await face.run({ provider: 'p', baseURL: 'https://x' });
      expect(outcome.status, 'remote=' + JSON.stringify(remote)).toBe('unavailable');
    }
  });

  it('wires the live faces on the happy path and forwards the caller signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const llm = {
      discoverModels: async (_ns: string, _req: unknown, signal?: AbortSignal) => {
        seenSignal = signal;
        return { ok: true as const, value: [{ id: 'm' }] };
      }
    };
    const face = bindEndpointTest({ remote: { llm } } as never);
    const caller = new AbortController();
    const outcome = await face.run({ provider: 'p', model: 'm', baseURL: 'https://x' }, caller.signal);
    expect(outcome.status).toBe('ok');
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    // A caller abort AFTER the probe resolved must NOT propagate: dispose()
    // already detached the listener (composeTimeout's documented contract).
    caller.abort();
    expect(seenSignal!.aborted).toBe(false);
  });

  it('aborts the composed signal when the caller aborts DURING the probe', async () => {
    let sawAbort = false;
    const caller = new AbortController();
    const llm = {
      discoverModels: (_ns: string, _req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); }, { once: true });
          // Abort on the next tick, while the probe is still in flight.
          setTimeout(() => caller.abort(), 0);
        })
    };
    const face = bindEndpointTest({ remote: { llm } } as never);
    const outcome = await face.run({ provider: 'p', baseURL: 'https://x' }, caller.signal);
    expect(sawAbort).toBe(true);
    expect(outcome.status).toBe('fail');
  });

  it('routes storedBaseURL through the mounted settings face', async () => {
    const settings = {
      describe: async () => ({
        ok: true as const,
        value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { p: { baseURL: 'https://api' } } } }] }
      })
    };
    const face = bindEndpointTest({ remote: { settings } } as never);
    await expect(face.storedBaseURL('p')).resolves.toBe('https://api');
  });
});

describe('testConnection: round-3 caller-side trust boundary', () => {
  const llmOk = { discoverModels: async () => ({ ok: true as const, value: [] }) };

  it('does not throw on a null/undefined/primitive input or faces object', async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ llm: llmOk }, null],
      [{ llm: llmOk }, undefined],
      [{ llm: llmOk }, 'input'],
      [null, { provider: 'p', baseURL: 'https://x' }],
      [undefined, { provider: 'p', baseURL: 'https://x' }],
      ['faces', { provider: 'p', baseURL: 'https://x' }]
    ];
    for (const [faces, input] of cases) {
      const outcome = await runEndpointTest(faces as never, input as never);
      expect(['fail', 'ok', 'unavailable'], JSON.stringify([faces, input])).toContain(outcome.status);
    }
  });

  it('never reports a non-string model id as found (documented: null only when NO model given)', async () => {
    // A non-string id is "given" (truthy), so the documented contract is
    // modelFound:false ("not among the advertised"), never true and never a throw.
    for (const model of [42, {}, [], true] as unknown[]) {
      const outcome = await runEndpointTest(
        { llm: llmOk } as never,
        { provider: 'p', model, baseURL: 'https://x' } as never
      );
      expect(outcome.status).toBe('ok');
      expect(outcome.status === 'ok' && outcome.modelFound, 'model=' + String(model)).toBe(false);
    }
  });

  it('keeps a contextWindow of 0 (a number is a number)', async () => {
    const llm = { discoverModels: async () => ({ ok: true as const, value: [{ id: 'm', contextWindow: 0 }] }) };
    const outcome = await runEndpointTest({ llm } as never, { provider: 'p', model: 'm', baseURL: 'https://x' });
    expect(outcome.status === 'ok' && outcome.modelContextWindow).toBe(0);
  });

  it('reports modelFound false when the model id is absent from the list', async () => {
    const llm = { discoverModels: async () => ({ ok: true as const, value: [{ id: 'other' }] }) };
    const outcome = await runEndpointTest({ llm } as never, { provider: 'p', model: 'm', baseURL: 'https://x' });
    expect(outcome.status === 'ok' && outcome.modelFound).toBe(false);
  });

  it('reports modelFound null for an empty-string model', async () => {
    const outcome = await runEndpointTest({ llm: llmOk } as never, { provider: 'p', model: '', baseURL: 'https://x' });
    expect(outcome.status === 'ok' && outcome.modelFound).toBe(null);
  });
});
