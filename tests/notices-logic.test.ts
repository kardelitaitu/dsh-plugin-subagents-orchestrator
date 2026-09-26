/**
 * Adversarial rounds for src/notices.ts.
 *
 * Every test here is a probe for one hypothesis about the failover-notice
 * delivery contract: it must NEVER throw, NEVER report a degradation as
 * 'delivered', and must never leak non-value text into the model-facing notice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildFailoverNotice,
  deliverFailoverNotice,
  setNoticeModuleForTest,
  type NoticeDelivery,
  type NoticeModule
} from '../src/notices.js';

const INFO = {
  from: { provider: 'p1', model: 'm1' },
  to: { provider: 'p3', model: 'm3' },
  code: 'RATE_LIMIT',
  hintMs: 60000
};

function fakeModule(): NoticeModule & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    createUserMessage: ((input: { content: unknown; source: unknown }) => {
      calls.push(input);
      return { role: 'user', id: 'msg-test', content: input.content, source: input.source };
    }) as NoticeModule['createUserMessage']
  };
}

/** Captures the summary+text actually handed to the module factory. */
function captureModule(): NoticeModule & { last: { summary: string; text: string } | null } {
  const box: NoticeModule & { last: { summary: string; text: string } | null } = {
    last: null,
    createUserMessage: ((input: any) => {
      box.last = {
        summary: String(input?.source?.summary ?? ''),
        text: String(input?.content?.[0]?.text ?? '')
      };
      return { role: 'user', id: 'm', content: input.content, source: input.source };
    }) as NoticeModule['createUserMessage']
  };
  return box;
}

beforeEach(() => {
  setNoticeModuleForTest(null);
});

describe('Round 1: outcome vocabulary — degradations are distinguishable and never "delivered"', () => {
  // Hypothesis: every skip path returns a non-'delivered' value, and the three
  // skip reasons are mutually distinct so diagnostics can tell them apart.
  it('never reports a degradation as delivered, and keeps the three reasons distinct', async () => {
    setNoticeModuleForTest(null);
    const moduleUnavailable = await deliverFailoverNotice({ inject: vi.fn() }, INFO);

    setNoticeModuleForTest(fakeModule());
    const noInject = await deliverFailoverNotice({}, INFO);

    setNoticeModuleForTest({ createUserMessage: () => { throw new Error('boom'); } });
    const failed = await deliverFailoverNotice({ inject: vi.fn() }, INFO);

    const all: NoticeDelivery[] = [moduleUnavailable, noInject, failed];
    expect(all).not.toContain('delivered');
    expect(new Set(all).size).toBe(3);
    expect(all).toEqual(['module-unavailable', 'no-agent-inject', 'failed']);
  });

  it('reports the success path as exactly "delivered"', async () => {
    setNoticeModuleForTest(fakeModule());
    const delivery = await deliverFailoverNotice({ inject: vi.fn() }, INFO);
    expect(delivery).toBe('delivered');
  });
});

describe('Round 2: agent.inject absent / non-function / throwing', () => {
  // Hypothesis: any non-callable inject degrades to 'no-agent-inject'; a
  // throwing inject (including non-Error throws) degrades to 'failed'.
  it('degrades every non-function inject value to no-agent-inject', async () => {
    setNoticeModuleForTest(fakeModule());
    const nonFunctions: unknown[] = [
      null, undefined, 42, 'not-a-function', {}, [], true, Symbol('s')
    ];
    for (const inject of nonFunctions) {
      expect(await deliverFailoverNotice({ inject }, INFO)).toBe('no-agent-inject');
    }
  });

  it('degrades a throwing inject to failed and does not propagate the throw', async () => {
    setNoticeModuleForTest(fakeModule());
    const throwers = [
      () => { throw new Error('boom'); },
      () => { throw 'a string'; },
      () => { throw undefined; },
      () => { throw null; }
    ];
    for (const inject of throwers) {
      let threw = false;
      let result: NoticeDelivery | undefined;
      try {
        result = await deliverFailoverNotice({ inject }, INFO);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBe('failed');
    }
  });

  it('treats non-object agents as no-agent-inject without throwing', async () => {
    setNoticeModuleForTest(fakeModule());
    expect(await deliverFailoverNotice(undefined, INFO)).toBe('no-agent-inject');
    expect(await deliverFailoverNotice(null, INFO)).toBe('no-agent-inject');
    expect(await deliverFailoverNotice('agent', INFO)).toBe('no-agent-inject');
    expect(await deliverFailoverNotice(0, INFO)).toBe('no-agent-inject');
    expect(await deliverFailoverNotice(false, INFO)).toBe('no-agent-inject');
  });
});

describe('Round 3: missing / partial context', () => {
  // Hypothesis: an agent without id/session still delivers (delivery targets the
  // object), while missing endpoints degrade to 'failed' rather than throwing.
  it('delivers to an agent with no id and no session', async () => {
    setNoticeModuleForTest(fakeModule());
    expect(await deliverFailoverNotice({ inject: vi.fn() }, INFO)).toBe('delivered');
    expect(await deliverFailoverNotice({ id: '', inject: vi.fn() }, INFO)).toBe('delivered');
    expect(await deliverFailoverNotice({ id: 'sub-1', session: undefined, inject: vi.fn() }, INFO)).toBe('delivered');
  });

  it('degrades missing endpoints to failed without throwing', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { from: INFO.from },
      { to: INFO.to },
      { from: null, to: INFO.to },
      { from: INFO.from, to: null },
      { from: {}, to: INFO.to }
    ];
    for (const info of malformed) {
      let threw = false;
      let result: NoticeDelivery | undefined;
      try {
        result = await deliverFailoverNotice({ inject }, info as any);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBe('failed');
    }
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('Round 4: message content correctness', () => {
  // Hypothesis: the notice names both endpoints, includes code/hint only when
  // supplied, and never leaks the literal "undefined" into model-facing text.
  it('names both endpoints and the code in text and summary', () => {
    const { summary, text } = buildFailoverNotice(INFO);
    expect(summary).toContain('p1/m1');
    expect(summary).toContain('p3/m3');
    expect(text).toContain('p1/m1');
    expect(text).toContain('p3/m3');
    expect(text).toContain('RATE_LIMIT');
    expect(text).not.toContain('undefined');
    expect(summary).not.toContain('undefined');
  });

  it('omits code/hint text when they are absent and never prints "undefined"', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(text).toContain('connection failure');
    expect(text).not.toContain('undefined');
    expect(summary).not.toContain('undefined');
  });

  it('prints only the hint when code is absent, and only the code when hint is absent', () => {
    const hintOnly = buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: 5000 });
    expect(hintOnly.summary).toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 5000ms)');
    const codeOnly = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'TIMEOUT' });
    expect(codeOnly.summary).toBe('Failover: p1/m1 -> p3/m3 (TIMEOUT)');
  });
});

describe('Round 5: hint duration formatting', () => {
  // Hypothesis: raw ms is printed with the correct "ms" unit for every numeric
  // hint, and a non-finite / non-numeric hint must NOT leak NaN/Infinity/raw
  // text into model-facing output.
  it('prints 0ms, sub-second and large hints with the ms unit', () => {
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: 0 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 0ms)');
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: 250 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 250ms)');
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: 86400000 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 86400000ms)');
  });

  it('does not leak NaN into the notice when hintMs is NaN', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'RATE_LIMIT', hintMs: NaN });
    expect(summary).not.toContain('NaN');
    expect(text).not.toContain('NaN');
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT)');
  });

  it('does not leak Infinity into the notice when hintMs is Infinity', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: Infinity });
    expect(summary).not.toContain('Infinity');
    expect(text).not.toContain('Infinity');
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
  });

  it('does not leak a non-numeric hint into the notice', () => {
    const { summary, text } = buildFailoverNotice({
      from: INFO.from,
      to: INFO.to,
      hintMs: 'soon' as unknown as number
    });
    expect(summary).not.toContain('soon');
    expect(text).not.toContain('soon');
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
  });
});

describe('Round 6: async behavior — slow/hung inject and the sync-inject assumption', () => {
  // Hypothesis: the host contract types inject as synchronous void, so the
  // delivery wrapper calls it fire-and-forget and never awaits its return.
  it('returns delivered without awaiting a promise returned by inject', async () => {
    setNoticeModuleForTest(fakeModule());
    let settled = false;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inject = () => {
      void gate.then(() => { settled = true; });
      return gate;
    };

    const delivery = await deliverFailoverNotice({ inject }, INFO);
    // The notice was queued synchronously; the caller did not wait on inject.
    expect(delivery).toBe('delivered');
    expect(settled).toBe(false);
    release!();
    await gate;
    expect(settled).toBe(true);
  });

  it('delivers with an async inject that resolves', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn(async () => {});
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('resolves promptly even when inject is synchronous and returns nothing', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn((): void => undefined);
    const delivery = await deliverFailoverNotice({ inject }, INFO);
    expect(delivery).toBe('delivered');
  });
});

describe('Round 7: idempotence — delivering twice', () => {
  // Hypothesis: two deliveries both succeed, call inject twice, and build a
  // fresh independent message each time without corrupting shared state.
  it('delivers twice without throwing and produces distinct messages', async () => {
    const mod = fakeModule();
    setNoticeModuleForTest(mod);
    const seen: unknown[] = [];
    const inject = vi.fn((m: unknown) => { seen.push(m); });

    const first = await deliverFailoverNotice({ inject }, INFO);
    const second = await deliverFailoverNotice({ inject }, INFO);

    expect(first).toBe('delivered');
    expect(second).toBe('delivered');
    expect(inject).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(mod.calls).toHaveLength(2);
  });

  it('does not corrupt the info object across repeated deliveries', async () => {
    setNoticeModuleForTest(fakeModule());
    const info = { from: { provider: 'p1', model: 'm1' }, to: { provider: 'p3', model: 'm3' }, code: 'RATE_LIMIT' };
    const snapshot = JSON.parse(JSON.stringify(info));
    await deliverFailoverNotice({ inject: vi.fn() }, info);
    await deliverFailoverNotice({ inject: vi.fn() }, info);
    expect(info).toEqual(snapshot);
  });
});

describe('Round 8: return value shape is stable across every path', () => {
  // Hypothesis: deliverFailoverNotice always resolves to a string reason and
  // never rejects, even when the injected module resolver throws or rejects.
  it('degrades to failed when the module resolver rejects or throws', async () => {
    const rejecting = async () => { throw new Error('resolver boom'); };
    const throwing = () => { throw new Error('resolver sync boom'); };
    for (const getModule of [rejecting, throwing] as any[]) {
      let threw = false;
      let result: NoticeDelivery | undefined;
      try {
        result = await deliverFailoverNotice({ inject: vi.fn() }, INFO, getModule);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBe('failed');
    }
  });

  it('degrades to failed when the resolved module lacks createUserMessage', async () => {
    const getModule = async () => ({}) as NoticeModule;
    expect(await deliverFailoverNotice({ inject: vi.fn() }, INFO, getModule)).toBe('failed');
  });

  it('never rejects for any adversarial (agent, info, getModule) combination', async () => {
    const agents: unknown[] = [undefined, null, {}, { inject: 'x' }, { inject: () => { throw new Error('x'); } }, { inject: vi.fn() }];
    const infos: unknown[] = [undefined, null, {}, { from: INFO.from }, { to: INFO.to }, INFO];
    const resolvers = [async () => null, async () => fakeModule(), async () => { throw new Error('x'); }];
    for (const agent of agents) {
      for (const info of infos) {
        for (const getModule of resolvers as any[]) {
          const result = await deliverFailoverNotice(agent, info as any, getModule);
          expect(['delivered', 'no-agent-inject', 'module-unavailable', 'failed']).toContain(result);
        }
      }
    }
  });
});

describe('Round 9: synchronous inject assumption', () => {
  // Hypothesis: the host types inject as a synchronous `void` method, so the
  // wrapper must invoke it exactly once with exactly one argument and must not
  // await or depend on its return value. (Delivery itself is async — the module
  // is resolved first — so inject fires on a later microtask, not eagerly.)
  it('invokes inject exactly once with exactly one argument', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    await deliverFailoverNotice({ inject }, INFO);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]).toHaveLength(1);
  });

  it('passes the exact message the module produced through to inject', async () => {
    const sentinel = { role: 'user', id: 'sentinel-message' };
    const createUserMessage = vi.fn(() => sentinel);
    setNoticeModuleForTest({ createUserMessage: createUserMessage as NoticeModule['createUserMessage'] });
    const inject = vi.fn();
    await deliverFailoverNotice({ inject }, INFO);
    expect(createUserMessage).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith(sentinel);
    expect(inject.mock.calls[0][0]).toBe(sentinel);
  });

  it('does not await a promise returned by a synchronous-style inject', async () => {
    // A host inject returning void must still deliver; an async one must not
    // delay the returned delivery reason (fire-and-forget).
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn(() => new Promise<void>(() => { /* never settles */ }));
    await expect(deliverFailoverNotice({ inject }, INFO)).resolves.toBe('delivered');
  });
});

describe('Round 10: input mutation and module summary handling', () => {
  // Hypothesis: the notice functions are pure over their inputs (a frozen info
  // object still delivers) and a host boundContextSummary is honored, with a
  // throwing one degrading to failed rather than escaping.
  it('does not mutate a deeply frozen info object', async () => {
    setNoticeModuleForTest(fakeModule());
    const info = Object.freeze({
      from: Object.freeze({ provider: 'p1', model: 'm1' }),
      to: Object.freeze({ provider: 'p3', model: 'm3' }),
      code: 'RATE_LIMIT',
      hintMs: 60000
    });
    expect(await deliverFailoverNotice({ inject: vi.fn() }, info)).toBe('delivered');
    expect(info).toEqual({
      from: { provider: 'p1', model: 'm1' },
      to: { provider: 'p3', model: 'm3' },
      code: 'RATE_LIMIT',
      hintMs: 60000
    });
  });

  it('builds from a frozen info without mutating it', () => {
    const info = Object.freeze({
      from: Object.freeze({ provider: 'p1', model: 'm1' }),
      to: Object.freeze({ provider: 'p3', model: 'm3' })
    });
    const built = buildFailoverNotice(info);
    expect(built.summary).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(info.from).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('honors the module boundContextSummary when present', async () => {
    const box = captureModule();
    const marker = 'BOUND-BY-HOST';
    setNoticeModuleForTest({ ...box, boundContextSummary: () => marker });
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    expect((inject.mock.calls[0][0] as any).source.summary).toBe(marker);
  });

  it('degrades to failed when the module boundContextSummary throws', async () => {
    setNoticeModuleForTest({
      createUserMessage: (input: any) => ({ role: 'user', id: 'm', ...input }),
      boundContextSummary: () => { throw new Error('bound boom'); }
    });
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('failed');
    expect(inject).not.toHaveBeenCalled();
  });
});