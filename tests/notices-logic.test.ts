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
  getNoticeModule,
  setNoticeModuleForTest,
  NOTICE_SUMMARY_MAX_CHARS,
  type NoticeDelivery,
  type NoticeModule
} from '../src/notices.js';
import { extractCooldownHintMs, MAX_HINT_COOLDOWN_MS } from '../src/ratelimit.js';

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


/* ============================================================================
 * ROUND 2 — adversarial depth. Rounds 11-30.
 * ==========================================================================*/

describe('Round 11: endpointLabel — empty-string vs whitespace provider/model', () => {
  // Hypothesis: '' is rejected (fixed last round); whitespace-only is the same
  // class of unusable ref and config.ts already rejects it via .trim().length,
  // so a whitespace-only endpoint must also degrade to 'failed'.
  it('rejects an empty-string provider or model', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, { from: { provider: '', model: 'm' }, to: INFO.to })).toBe('failed');
    expect(await deliverFailoverNotice({ inject }, { from: { provider: 'p', model: '' }, to: INFO.to })).toBe('failed');
    expect(inject).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only provider or model', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, { from: { provider: '  ', model: 'm' }, to: INFO.to })).toBe('failed');
    expect(await deliverFailoverNotice({ inject }, { from: { provider: 'p', model: '\t' }, to: INFO.to })).toBe('failed');
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('Round 12: module resolution is unbounded (re-examining the R6 async claim)', () => {
  // Hypothesis: R6 proved inject is fire-and-forget, but the wrapper DOES await
  // getModule(). A resolver that never settles must therefore hang the caller —
  // there is no timeout. This characterises a documented limitation.
  it('the caller is blocked while the module resolver never settles', async () => {
    setNoticeModuleForTest(fakeModule());
    let settled = false;
    const never = new Promise<NoticeModule | null>(() => { /* never settles */ });
    const delivery = deliverFailoverNotice({ inject: vi.fn() }, INFO, () => never)
      .then(() => { settled = true; });
    const winner = await Promise.race([
      delivery.then(() => 'delivery'),
      new Promise<string>((r) => setTimeout(() => r('timer'), 40))
    ]);
    expect(winner).toBe('timer');
    expect(settled).toBe(false);
  });
});

describe('Round 13: boundSummary exact char boundary', () => {
  // Hypothesis: a summary of exactly NOTICE_SUMMARY_MAX_CHARS is returned intact
  // (no ellipsis); one char longer is truncated to the bound and ellipsized.
  const raw = 'Failover: p1/m1 -> p3/m3 (connection failure)';

  it('leaves a summary of exactly the max length untouched', () => {
    const pad = NOTICE_SUMMARY_MAX_CHARS - raw.length;
    const { summary } = buildFailoverNotice({
      from: { provider: 'p1' + 'a'.repeat(pad), model: 'm1' },
      to: INFO.to
    });
    expect(summary.length).toBe(NOTICE_SUMMARY_MAX_CHARS);
    expect(summary.endsWith('\u2026')).toBe(false);
  });

  it('truncates a summary one char over the bound to exactly the bound', () => {
    const pad = NOTICE_SUMMARY_MAX_CHARS - raw.length + 1;
    const { summary } = buildFailoverNotice({
      from: { provider: 'p1' + 'a'.repeat(pad), model: 'm1' },
      to: INFO.to
    });
    expect(summary.length).toBe(NOTICE_SUMMARY_MAX_CHARS);
    expect(summary.endsWith('\u2026')).toBe(true);
  });
});

describe('Round 14: boundSummary must not split a surrogate pair', () => {
  // Hypothesis: slice() cuts UTF-16 code units, so an emoji straddling the cut
  // leaves a lone surrogate in the model-facing summary. A provider/model name
  // is operator-supplied free text, so this is reachable.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('does not leave a lone surrogate when the cut lands inside an emoji', () => {
    // Place the emoji's high surrogate at index MAX-2 so slice(0, MAX-1) splits it.
    const prefix = 'Failover: ';
    const pad = NOTICE_SUMMARY_MAX_CHARS - 2 - prefix.length - 1;
    const { summary } = buildFailoverNotice({
      from: { provider: 'a'.repeat(pad), model: '\u{1F600}' },
      to: { provider: 'p3', model: 'm3' }
    });
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(loneSurrogate.test(summary)).toBe(false);
  });
});

describe('Round 15: notice TEXT length is unbounded', () => {
  // Hypothesis: only the summary is bounded; the model-facing text scales with
  // the endpoint names. Operator-controlled, so documented rather than "fixed".
  it('does not bound the text, only the summary', () => {
    const huge = 'p'.repeat(10000);
    const { summary, text } = buildFailoverNotice({
      from: { provider: huge, model: 'm' },
      to: { provider: 'q', model: 'n' }
    });
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(text.length).toBeGreaterThan(10000);
  });
});

describe('Round 16: same failover -> identical text; only identity differs (R7 re-check)', () => {
  // Hypothesis: R7's "distinct messages" meant distinct identity, not distinct
  // content. The same info must yield byte-identical content+source; the host
  // factory supplies a fresh id each call.
  it('produces identical content/source and a fresh identity per delivery', async () => {
    let n = 0;
    setNoticeModuleForTest({
      createUserMessage: ((input: any) => ({ role: 'user', id: 'id-' + (++n), ...input })) as NoticeModule['createUserMessage']
    });
    const seen: any[] = [];
    await deliverFailoverNotice({ inject: (m: unknown) => seen.push(m) }, INFO);
    await deliverFailoverNotice({ inject: (m: unknown) => seen.push(m) }, INFO);
    expect(seen).toHaveLength(2);
    expect(seen[0].content).toEqual(seen[1].content);
    expect(seen[0].source).toEqual(seen[1].source);
    expect(seen[0].id).not.toBe(seen[1].id);
  });
});

describe('Round 17: extreme hintMs values', () => {
  // Hypothesis: every FINITE number renders verbatim (including MIN_VALUE in
  // scientific notation and a negative value); only non-finite/non-numeric are
  // treated as absent.
  it('renders MAX_SAFE_INTEGER, MIN_VALUE and a negative hint verbatim', () => {
    const max = buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: Number.MAX_SAFE_INTEGER });
    expect(max.summary).toContain('cooldown hint ' + Number.MAX_SAFE_INTEGER + 'ms');
    const min = buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: Number.MIN_VALUE });
    expect(min.summary).toContain('cooldown hint 5e-324ms');
    const neg = buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: -5 });
    expect(neg.summary).toContain('cooldown hint -5ms');
  });
});

describe('Round 18: side-effecting code getter cannot desync summary and text', () => {
  // Hypothesis: 'reason' is computed once and reused, so even a getter that
  // returns different values per read yields the SAME reason in summary and text.
  it('embeds one identical reason in both summary and text', () => {
    let reads = 0;
    const info: any = {
      from: INFO.from,
      to: INFO.to,
      get code() { reads += 1; return reads === 1 ? 'FIRST' : 'SECOND'; }
    };
    const { summary, text } = buildFailoverNotice(info);
    const reasonFromSummary = summary.slice(summary.lastIndexOf('(') + 1, -1);
    const reasonFromText = text.slice(text.indexOf('failed with ') + 'failed with '.length, text.indexOf(';'));
    expect(reasonFromText).toBe(reasonFromSummary);
    expect(reasonFromSummary.length).toBeGreaterThan(0);
  });
});

describe('Round 19: no write is ever attempted on the info object', () => {
  // Hypothesis: build/deliver only read the info object, so a write-trapping
  // proxy records zero writes.
  it('records no set/define/delete on the info object', async () => {
    const writes: string[] = [];
    const base = { from: { provider: 'p1', model: 'm1' }, to: { provider: 'p3', model: 'm3' }, code: 'RATE_LIMIT' };
    const proxy = new Proxy(base, {
      set(t, p, v) { writes.push('set:' + String(p)); return Reflect.set(t, p, v); },
      defineProperty(t, p, d) { writes.push('define:' + String(p)); return Reflect.defineProperty(t, p, d); },
      deleteProperty(t, p) { writes.push('delete:' + String(p)); return Reflect.deleteProperty(t, p); }
    });
    const built = buildFailoverNotice(proxy);
    expect(built.summary).toContain('RATE_LIMIT');
    setNoticeModuleForTest(fakeModule());
    expect(await deliverFailoverNotice({ inject: vi.fn() }, proxy)).toBe('delivered');
    expect(writes).toEqual([]);
  });
});

describe('Round 20: createUserMessage returning undefined (no throw)', () => {
  // Hypothesis: the wrapper still calls inject with whatever the module
  // returned; a benign inject accepts undefined ('delivered'), a host-like
  // inject that rejects it degrades to 'failed'.
  it('reports delivered when a benign inject accepts the undefined message', async () => {
    setNoticeModuleForTest({ createUserMessage: (() => undefined) as NoticeModule['createUserMessage'] });
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    expect(inject).toHaveBeenCalledWith(undefined);
  });

  it('degrades to failed when the inject rejects the undefined message', async () => {
    setNoticeModuleForTest({ createUserMessage: (() => undefined) as NoticeModule['createUserMessage'] });
    const inject = vi.fn(() => { throw new Error('invalid message'); });
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('failed');
  });
});

describe('Round 21: inject call shape — arity, bound method, prototype method', () => {
  // Hypothesis: inject is invoked as a plain one-arg call; declared arity and
  // where the method lives do not change the call shape.
  it('invokes a bound method inject with the correct this', async () => {
    setNoticeModuleForTest(fakeModule());
    const host = { received: [] as unknown[], inject(m: unknown) { this.received.push(m); } };
    expect(await deliverFailoverNotice({ inject: host.inject.bind(host) }, INFO)).toBe('delivered');
    expect(host.received).toHaveLength(1);
  });

  it('invokes a zero-parameter inject with exactly one argument', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn(() => {});
    expect(inject.length).toBe(0);
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    expect(inject.mock.calls[0]).toHaveLength(1);
  });

  it('accepts inject defined on the prototype', async () => {
    setNoticeModuleForTest(fakeModule());
    class Host { received: unknown[] = []; inject(m: unknown) { this.received.push(m); } }
    const host = new Host();
    expect(await deliverFailoverNotice(host, INFO)).toBe('delivered');
    expect(host.received).toHaveLength(1);
  });
});

describe('Round 22: two interleaved deliveries', () => {
  // Hypothesis: concurrent deliveries do not share mutable per-call state, so
  // each inject receives its own notice.
  it('routes each concurrent notice to its own agent', async () => {
    const mod = fakeModule();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const getModule = async () => { await gate; return mod; };
    const a = vi.fn(); const b = vi.fn();
    const p1 = deliverFailoverNotice({ inject: a }, INFO, getModule);
    const p2 = deliverFailoverNotice({ inject: b }, { ...INFO, code: 'TIMEOUT' }, getModule);
    release();
    expect(await p1).toBe('delivered');
    expect(await p2).toBe('delivered');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect((a.mock.calls[0][0] as any).content[0].text).toContain('RATE_LIMIT');
    expect((b.mock.calls[0][0] as any).content[0].text).toContain('TIMEOUT');
  });
});

describe('Round 23: no JSON leak of endpoint refs / extra fields', () => {
  // Hypothesis: the notice is built from template literals over provider/model
  // only, so extra fields (secrets) never reach the model-facing text.
  it('never stringifies the refs or leaks extra fields', () => {
    const from = { provider: 'p1', model: 'm1', apiKey: 'SECRET-KEY' } as any;
    const to = { provider: 'p3', model: 'm3', secret: 'SECRET2' } as any;
    const { summary, text } = buildFailoverNotice({ from, to });
    for (const s of [summary, text]) {
      expect(s).not.toContain('SECRET-KEY');
      expect(s).not.toContain('SECRET2');
      expect(s).not.toContain('apiKey');
      expect(s).not.toContain('{');
      expect(s).not.toContain('"provider"');
    }
  });
});

describe('Round 24: empty-string code', () => {
  // Hypothesis: code: '' is not undefined, so it becomes the reason verbatim,
  // rendering empty parentheses. index.ts guards with a truthy check, so this
  // is documented rather than fixed.
  it('renders empty parentheses for an empty-string code', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: '' });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 ()');
    expect(text).toContain('failed with ;');
  });
});

describe('Round 25: a very long failure code still bounds the summary', () => {
  // Hypothesis: truncation applies to the assembled summary regardless of which
  // field made it long.
  it('bounds the summary with a 500-char code', () => {
    const { summary } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'X'.repeat(500) });
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(summary.endsWith('\u2026')).toBe(true);
  });
});

describe('Round 26: non-string provider/model values', () => {
  // Hypothesis: endpointLabel's typeof check degrades non-string refs to failed.
  it('degrades non-string provider/model values to failed', async () => {
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    const infos: any[] = [
      { from: { provider: 123, model: 'm' }, to: INFO.to },
      { from: { provider: 'p', model: 42 }, to: INFO.to },
      { from: INFO.from, to: { provider: null, model: 'm' } }
    ];
    for (const info of infos) {
      expect(await deliverFailoverNotice({ inject }, info)).toBe('failed');
    }
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('Round 27: boundContextSummary result is not validated', () => {
  // Hypothesis: the wrapper trusts the host's boundContextSummary, so a module
  // returning undefined yields an undefined summary (documented; the host
  // returns a string by contract).
  it('passes a non-string boundContextSummary result straight through', async () => {
    setNoticeModuleForTest({
      createUserMessage: ((input: any) => ({ role: 'user', id: 'm', ...input })) as NoticeModule['createUserMessage'],
      boundContextSummary: (() => undefined) as unknown as (s: string) => string
    });
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    expect((inject.mock.calls[0][0] as any).source.summary).toBeUndefined();
  });
});

describe('Round 28: an endpoint getter that throws', () => {
  // Hypothesis: a throwing endpoint getter is caught by the delivery try/catch
  // and degrades to failed without calling inject.
  it('degrades to failed when a provider getter throws', async () => {
    setNoticeModuleForTest(fakeModule());
    const from = { get provider() { throw new Error('boom'); }, model: 'm1' } as any;
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, { from, to: INFO.to })).toBe('failed');
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('Round 29: module resolution happens exactly once per delivery', () => {
  // Hypothesis: the resolver is consulted once, not per build step.
  it('calls the resolver exactly once', async () => {
    const mod = fakeModule();
    const getModule = vi.fn(async () => mod);
    expect(await deliverFailoverNotice({ inject: vi.fn() }, INFO, getModule)).toBe('delivered');
    expect(getModule).toHaveBeenCalledTimes(1);
  });
});

describe('Round 30: no module resolution when the agent cannot receive a notice', () => {
  // Hypothesis: the inject feature-detect short-circuits before resolution, so a
  // non-injectable agent never triggers a module import.
  it('never resolves the module for a non-injectable agent', async () => {
    const getModule = vi.fn(async () => fakeModule());
    expect(await deliverFailoverNotice({}, INFO, getModule)).toBe('no-agent-inject');
    expect(await deliverFailoverNotice(null, INFO, getModule)).toBe('no-agent-inject');
    expect(getModule).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * ROUND 3 — the ratelimit/notices seam + deeper notices probes. Rounds 43-50.
 * ==========================================================================*/

describe('R3-Round 43: boundSummary must not orphan a LOW surrogate', () => {
  // HYPOTHESIS: the round-2 fix only rewinds when the char BEFORE the cut is a
  // HIGH surrogate. If a low surrogate sits immediately before the cut while its
  // high surrogate is beyond it (or absent), slice can still orphan it.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('never emits a lone surrogate across every possible cut position', () => {
    // Sweep an astral char across every index near the 120-char boundary.
    for (let idx = 100; idx < 125; idx++) {
      const raw = ('x'.repeat(idx) + '\u{1F600}').padEnd(200, 'y');
      const { summary } = buildFailoverNotice({
        from: { provider: raw, model: 'm' },
        to: { provider: 'q', model: 'n' }
      });
      expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
      expect(loneSurrogate.test(summary)).toBe(false);
    }
  });

  // Correct contract: boundSummary must never SEPARATE a well-formed pair. It is
  // not a sanitizer for input that already carries a lone surrogate, so this
  // probes pair integrity rather than malformed input.
  it('keeps every well-formed pair intact at the cut (both halves present or both absent)', () => {
    for (let idx = 100; idx < 125; idx++) {
      const astral = '\u{1F600}';
      const raw = ('x'.repeat(idx) + astral).padEnd(200, 'y');
      const { summary } = buildFailoverNotice({
        from: { provider: raw, model: 'm' },
        to: { provider: 'q', model: 'n' }
      });
      const highCount = (summary.match(/\u{1F600}/gu) || []).length;
      // Either the astral char survived whole, or it was fully dropped with the cut.
      expect(highCount === 0 || highCount === 1).toBe(true);
      expect(loneSurrogate.test(summary)).toBe(false);
    }
  });
});

describe('R3-Round 44: the ellipsis and the cut index', () => {
  // HYPOTHESIS: the bound is "at most MAX chars INCLUDING the ellipsis"; the cut
  // index is MAX-1 so a boundary-length result never exceeds the host bound.
  it('a one-over summary is exactly MAX chars, ending in a single ellipsis', () => {
    const raw = 'Failover: p1/m1 -> p3/m3 (connection failure)';
    const pad = NOTICE_SUMMARY_MAX_CHARS - raw.length + 1;
    const { summary } = buildFailoverNotice({ from: { provider: 'p1' + 'a'.repeat(pad), model: 'm1' }, to: INFO.to });
    expect(summary.length).toBe(NOTICE_SUMMARY_MAX_CHARS);
    expect(summary.endsWith('\u2026')).toBe(true);
    expect(summary.slice(0, -1).endsWith('\u2026')).toBe(false);
    expect(summary.split('\u2026')).toHaveLength(2);
  });

  it('a summary already containing an ellipsis is still cut once at the bound', () => {
    const { summary } = buildFailoverNotice({
      from: { provider: 'p1' + '\u2026'.repeat(200), model: 'm1' },
      to: INFO.to
    });
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(summary.endsWith('\u2026')).toBe(true);
  });
});

describe('R3-Round 45: end-to-end seam — ratelimit output drives the notice text', () => {
  // HYPOTHESIS: the hint ratelimit produces is exactly the hint the notice
  // renders, for a real CodeBuddy-style message.
  it('renders the exact parsed cooldown for a UTC+8 reset message', async () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const failure = { code: 'RATE_LIMIT', message: 'your usage will reset at 2026-09-24 05:17:08 UTC+8' };
    const hintMs = extractCooldownHintMs(failure as never, now);
    expect(hintMs).toBe(Date.parse('2026-09-24T05:17:08+08:00') - now);

    const box = captureModule();
    setNoticeModuleForTest(box);
    const inject = vi.fn();
    const delivery = await deliverFailoverNotice({ inject }, {
      from: { provider: 'p1', model: 'm1' },
      to: { provider: 'p3', model: 'm3' },
      ...(failure.code ? { code: failure.code } : {}),
      ...(hintMs !== null ? { hintMs } : {})
    });
    expect(delivery).toBe('delivered');
    expect(box.last!.text).toContain('RATE_LIMIT, cooldown hint ' + hintMs + 'ms');
    expect(box.last!.text).not.toContain('undefined');
  });

  it('renders the cap verbatim when the message asks for more than 24h', async () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const hintMs = extractCooldownHintMs({ code: 'RATE_LIMIT', message: 'resets in 99999 hours' } as never, now);
    expect(hintMs).toBe(MAX_HINT_COOLDOWN_MS);
    const box = captureModule();
    setNoticeModuleForTest(box);
    await deliverFailoverNotice({ inject: vi.fn() }, {
      from: INFO.from, to: INFO.to, code: 'RATE_LIMIT', hintMs: hintMs!
    });
    expect(box.last!.text).toContain('cooldown hint ' + MAX_HINT_COOLDOWN_MS + 'ms');
  });
});

describe('R3-Round 46: endpointLabel guard precision', () => {
  // HYPOTHESIS: the guard rejects only NON-string / blank refs; it does not
  // trim, so a padded name is rendered padded (config already rejects blanks).
  it('accepts a padded provider/model and renders it verbatim', () => {
    const { summary } = buildFailoverNotice({ from: { provider: ' p1 ', model: ' m1 ' }, to: INFO.to });
    expect(summary).toContain(' p1 / m1 ');
  });

  it('rejects non-string refs without over-reaching into valid ones', () => {
    const bad = [
      { provider: 1, model: 'm' }, { provider: 'p', model: 1 },
      { provider: null, model: 'm' }, { provider: 'p', model: undefined },
      { provider: [], model: 'm' }, { provider: 'p', model: {} }
    ];
    for (const from of bad) {
      expect(() => buildFailoverNotice({ from: from as never, to: INFO.to })).toThrow(TypeError);
    }
    expect(() => buildFailoverNotice({ from: { provider: 'p', model: 'm' }, to: INFO.to })).not.toThrow();
  });
});

describe('R3-Round 47: formatHint guard precision', () => {
  // HYPOTHESIS: only a PRIMITIVE finite number renders; boxed numbers, booleans,
  // strings and null are treated as absent (no coercion, no "nullms").
  it('renders only primitive finite numbers', () => {
    const render = (hintMs: unknown) => buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: hintMs as never }).summary;
    expect(render(5)).toContain('cooldown hint 5ms');
    expect(render(0)).toContain('cooldown hint 0ms');
    expect(render(new Number(5))).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(render(true)).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(render('5')).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(render(null)).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(render(NaN)).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
  });
});

describe('R3-Round 48: many delivery cycles leave no residue', () => {
  // HYPOTHESIS: repeated deliveries across a long run are stateless; toggling the
  // module between cycles (present/absent) must not leak or corrupt state.
  it('stays correct across 200 cycles with module toggling', async () => {
    for (let i = 0; i < 200; i++) {
      const present = i % 2 === 0;
      setNoticeModuleForTest(present ? fakeModule() : null);
      const result = await deliverFailoverNotice({ inject: vi.fn() }, { ...INFO, hintMs: i });
      expect(result).toBe(present ? 'delivered' : 'module-unavailable');
    }
    setNoticeModuleForTest(fakeModule());
    const box = captureModule();
    setNoticeModuleForTest(box);
    await deliverFailoverNotice({ inject: vi.fn() }, { from: INFO.from, to: INFO.to, code: 'X', hintMs: 7 });
    expect(box.last!.text).toContain('cooldown hint 7ms');
  });
});

describe('R3-Round 49: module cache path is stable when notices are absent', () => {
  // HYPOTHESIS: with no test override, the lazy import of a missing
  // @deepseek-ai/dsh-llm caches null and every call resolves to null (never throws).
  it('resolves to null repeatedly without throwing when the host module is absent', async () => {
    setNoticeModuleForTest(undefined as unknown as NoticeModule);
    const first = await getNoticeModule();
    const second = await getNoticeModule();
    expect(first).toBeNull();
    expect(second).toBeNull();
    setNoticeModuleForTest(null);
    expect(await getNoticeModule()).toBeNull();
  });
});

describe('R3-Round 50: the notice never leaks a non-value for any ratelimit output', () => {
  // HYPOTHESIS: for every value extractCooldownHintMs can emit (null or a finite
  // in-range number), the notice text contains no placeholder token.
  it('has no null/undefined/NaN/Infinity for every reachable hint', () => {
    const failures: any[] = [
      { code: 'RATE_LIMIT', headers: { 'retry-after': '0' } },
      { code: 'RATE_LIMIT', providerRetryAfterMs: 0.5 },
      { code: 'RATE_LIMIT', headers: { 'retry-after': '86400' } },
      { code: 'RATE_LIMIT', message: 'upstream 502' },
      { code: 'QUOTA', headers: { 'x-ratelimit-reset': '60' } }
    ];
    for (const f of failures) {
      const hintMs = extractCooldownHintMs(f, 1_700_000_000_000);
      const { summary, text } = buildFailoverNotice({
        from: INFO.from, to: INFO.to, code: f.code,
        ...(hintMs !== null ? { hintMs } : {})
      });
      for (const s of [summary, text]) {
        expect(s).not.toContain('null');
        expect(s).not.toContain('undefined');
        expect(s).not.toContain('NaN');
        expect(s).not.toContain('Infinity');
      }
      expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    }
  });
});


/* ============================================================================
 * ROUND 3 (notices side, this agent's lane) — R3N-Round 1..20.
 * Prefix R3N- avoids colliding with the partner's R3-Round 43-50 above.
 * ==========================================================================*/

describe('R3N-Round 1: guard ordering — from is validated before to', () => {
  // Hypothesis: endpointLabel(info.from) runs first, so with BOTH refs invalid
  // the failure is attributed to from and the thrown error is a TypeError.
  it('throws a TypeError for the first invalid ref regardless of which is bad', () => {
    expect(() => buildFailoverNotice({ from: {} as never, to: {} as never })).toThrow(TypeError);
    expect(() => buildFailoverNotice({ from: INFO.from, to: {} as never })).toThrow(TypeError);
    expect(() => buildFailoverNotice({ from: {} as never, to: INFO.to })).toThrow(TypeError);
    expect(() => buildFailoverNotice({ from: INFO.from, to: INFO.to })).not.toThrow();
  });
});

describe('R3N-Round 2: a nullish code must not leak the literal "null" into the notice', () => {
  // Hypothesis: the first reason branch tests "info.code !== undefined", which is
  // TRUE for null, so {code: null, hintMs: N} renders "null, cooldown hint Nms"
  // into model-facing text. Same non-value-leak class as the round-1 NaN bug.
  it('never renders the literal "null" for a nullish code with a hint', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: null as never, hintMs: 5000 });
    expect(summary).not.toContain('null');
    expect(text).not.toContain('null');
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 5000ms)');
  });
});

describe('R3N-Round 3: an undefined code with a hint renders only the hint', () => {
  // Hypothesis: undefined is correctly excluded (contrast with R3N-2's null), so
  // the reason is the hint alone and no "undefined" token appears.
  it('renders the hint and no "undefined"', () => {
    const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: undefined, hintMs: 5000 });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 5000ms)');
    expect(text).not.toContain('undefined');
  });
});

describe('R3N-Round 4: endpointLabel does not over-reject a valid unusual provider', () => {
  // Hypothesis: the guard only rejects non-string/blank, so a slash-bearing or
  // non-ASCII provider is accepted and rendered verbatim.
  it('accepts a slash-bearing and a unicode provider', () => {
    expect(buildFailoverNotice({ from: { provider: 'openai/azure', model: 'gpt-4' }, to: INFO.to }).summary)
      .toContain('openai/azure/gpt-4');
    expect(buildFailoverNotice({ from: { provider: '\u63d0\u4f9b\u5546', model: '\u6a21\u578b' }, to: INFO.to }).summary)
      .toContain('\u63d0\u4f9b\u5546/\u6a21\u578b');
  });
});

describe('R3N-Round 5: endpointLabel has no length cap (config enforces nothing here)', () => {
  // Hypothesis: a very long but valid provider is accepted; only the summary is
  // bounded downstream.
  it('accepts a 5000-char provider and still bounds only the summary', () => {
    const { summary, text } = buildFailoverNotice({ from: { provider: 'p'.repeat(5000), model: 'm' }, to: INFO.to });
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(text).toContain('p'.repeat(5000));
  });
});

describe('R3N-Round 6: a negative-zero hint renders as 0ms, not "-0ms"', () => {
  // Hypothesis: Number.isFinite(-0) is true and String(-0) is "0", so -0 renders
  // exactly like 0.
  it('renders -0 as cooldown hint 0ms', () => {
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, hintMs: -0 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 0ms)');
  });
});

describe('R3N-Round 7: a throwing hintMs getter degrades safely', () => {
  // Hypothesis: the getter is read once by formatHint inside the try/catch, so
  // build throws and deliver reports failed without calling inject.
  it('build throws and deliver reports failed without injecting', async () => {
    const info: any = { from: INFO.from, to: INFO.to, get hintMs() { throw new Error('boom'); } };
    expect(() => buildFailoverNotice(info)).toThrow('boom');
    setNoticeModuleForTest(fakeModule());
    const inject = vi.fn();
    expect(await deliverFailoverNotice({ inject }, info)).toBe('failed');
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('R3N-Round 8: the delivered content carries the FULL text while the summary is bounded', () => {
  // Hypothesis: content[0].text is the unbounded notice; source.summary is the
  // 120-char transcript-row account.
  it('delivers an unbounded text alongside a bounded summary', async () => {
    const box = captureModule();
    setNoticeModuleForTest(box);
    await deliverFailoverNotice({ inject: vi.fn() }, { from: { provider: 'p'.repeat(500), model: 'm' }, to: INFO.to });
    expect(box.last!.summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    expect(box.last!.text.length).toBeGreaterThan(500);
  });
});

describe('R3N-Round 9: nested endpoint refs are never mutated (extends round-2 R19)', () => {
  // Hypothesis: only reads happen, so write-trapping proxies on from AND to
  // record zero writes.
  it('records no writes on the from/to refs', async () => {
    const writes: string[] = [];
    const wrap = (o: object, tag: string) => new Proxy(o, {
      set(t, p, v) { writes.push(tag + ':set:' + String(p)); return Reflect.set(t, p, v); },
      defineProperty(t, p, d) { writes.push(tag + ':define:' + String(p)); return Reflect.defineProperty(t, p, d); },
      deleteProperty(t, p) { writes.push(tag + ':delete:' + String(p)); return Reflect.deleteProperty(t, p); }
    });
    const info = { from: wrap({ provider: 'p1', model: 'm1' }, 'from'), to: wrap({ provider: 'p3', model: 'm3' }, 'to'), code: 'RATE_LIMIT' };
    buildFailoverNotice(info as never);
    setNoticeModuleForTest(fakeModule());
    expect(await deliverFailoverNotice({ inject: vi.fn() }, info as never)).toBe('delivered');
    expect(writes).toEqual([]);
  });
});

describe('R3N-Round 10: inject is invoked as a method, so this is the agent', () => {
  // Hypothesis: the call site is injectable.inject(message), so a this-using
  // inject bound to the agent object works.
  it('binds this to the agent object', async () => {
    setNoticeModuleForTest(fakeModule());
    const agent = { received: [] as unknown[], inject(m: unknown) { (this as any).received.push(m); } };
    expect(await deliverFailoverNotice(agent, INFO)).toBe('delivered');
    expect(agent.received).toHaveLength(1);
  });
});

describe('R3N-Round 11: getNoticeModule returns a stable identity for a pinned module', () => {
  // Hypothesis: the override is returned by reference on every call.
  it('returns the same object across repeated resolutions', async () => {
    const mod = fakeModule();
    setNoticeModuleForTest(mod);
    expect(await getNoticeModule()).toBe(mod);
    expect(await getNoticeModule()).toBe(mod);
  });
});

describe('R3N-Round 12: a null override wins over any importable module', () => {
  // Hypothesis: overrideModule === null is a distinct state from undefined, so it
  // pins "unavailable" and short-circuits the lazy import.
  it('returns null repeatedly for a null override', async () => {
    setNoticeModuleForTest(null);
    expect(await getNoticeModule()).toBeNull();
    expect(await getNoticeModule()).toBeNull();
  });
});

describe('R3N-Round 13: boundContextSummary receives the already-bounded summary', () => {
  // Hypothesis: the wrapper bounds first, then hands the result to the host hook,
  // so the hook never sees the raw long summary.
  it('hands the hook a summary within the bound', async () => {
    const seen: string[] = [];
    setNoticeModuleForTest({
      createUserMessage: ((input: any) => ({ role: 'user', id: 'm', ...input })) as NoticeModule['createUserMessage'],
      boundContextSummary: (s: string) => { seen.push(s); return s; }
    });
    await deliverFailoverNotice({ inject: vi.fn() }, { from: { provider: 'p'.repeat(500), model: 'm' }, to: INFO.to });
    expect(seen).toHaveLength(1);
    expect(seen[0].length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
  });
});

describe('R3N-Round 14: boundContextSummary is consulted exactly once per delivery', () => {
  // Hypothesis: one call per delivery, not per field.
  it('calls the hook once', async () => {
    const hook = vi.fn((s: string) => s);
    setNoticeModuleForTest({
      createUserMessage: ((input: any) => ({ role: 'user', id: 'm', ...input })) as NoticeModule['createUserMessage'],
      boundContextSummary: hook as unknown as (s: string) => string
    });
    await deliverFailoverNotice({ inject: vi.fn() }, INFO);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe('R3N-Round 15: the delivered summary is always a string', () => {
  // Hypothesis: for every valid info the module receives a string summary, never
  // undefined (the host would render a broken transcript row otherwise).
  it('always passes a string summary to the factory', async () => {
    const infos = [
      INFO,
      { from: INFO.from, to: INFO.to },
      { from: INFO.from, to: INFO.to, code: 'X' },
      { from: INFO.from, to: INFO.to, hintMs: 0 }
    ];
    for (const info of infos) {
      const box = captureModule();
      setNoticeModuleForTest(box);
      expect(await deliverFailoverNotice({ inject: vi.fn() }, info)).toBe('delivered');
      expect(typeof box.last!.summary).toBe('string');
      expect(box.last!.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('R3N-Round 16: provider and model are each read exactly once', () => {
  // Hypothesis: endpointLabel reads each field once (optional chaining), so a
  // read-counting proxy sees exactly one read per field.
  it('reads provider once and model once', () => {
    let p = 0; let m = 0;
    const ref = new Proxy({ provider: 'p1', model: 'm1' }, {
      get(t, k) {
        if (k === 'provider') p += 1;
        if (k === 'model') m += 1;
        return (t as any)[k];
      }
    });
    buildFailoverNotice({ from: ref as never, to: INFO.to });
    expect(p).toBe(1);
    expect(m).toBe(1);
  });
});

describe('R3N-Round 17: the delivered source/content contract is exact', () => {
  // Hypothesis: source is a plugin notice and content is one text block whose
  // text equals the built text.
  it('pins kind/plugin/form and a single text block', async () => {
    const box = captureModule();
    setNoticeModuleForTest(box);
    const seen: any[] = [];
    await deliverFailoverNotice({ inject: (m: unknown) => seen.push(m) }, INFO);
    const message = seen[0];
    expect(message.source.kind).toBe('plugin');
    expect(message.source.plugin).toBe('dsh-plugin-subagents-orchestrator');
    expect(message.source.form).toBe('notice');
    expect(message.content).toHaveLength(1);
    expect(message.content[0].type).toBe('text');
    expect(message.content[0].text).toBe(box.last!.text);
  });
});

describe('R3N-Round 18: 500 sequential deliveries leave no accumulated state', () => {
  // Hypothesis: delivery is stateless; every cycle delivers the same notice and
  // the module identity never drifts.
  it('delivers identically across 500 cycles', async () => {
    const mod = fakeModule();
    setNoticeModuleForTest(mod);
    const inject = vi.fn();
    for (let i = 0; i < 500; i++) {
      expect(await deliverFailoverNotice({ inject }, INFO)).toBe('delivered');
    }
    expect(inject).toHaveBeenCalledTimes(500);
    expect(mod.calls).toHaveLength(500);
    expect(await getNoticeModule()).toBe(mod);
  });
});

describe('R3N-Round 19: unknown info keys are ignored and never leak', () => {
  // Hypothesis: only from/to/code/hintMs are read, so extra keys never reach the
  // model-facing text.
  it('does not leak an unknown key into summary or text', () => {
    const info = { from: INFO.from, to: INFO.to, code: 'RATE_LIMIT', hintMs: 1000, secret: 'LEAK-ME', nested: { a: 1 } } as never;
    const { summary, text } = buildFailoverNotice(info);
    for (const s of [summary, text]) {
      expect(s).not.toContain('LEAK-ME');
      expect(s).not.toContain('secret');
      expect(s).not.toContain('nested');
    }
  });
});

describe('R3N-Round 20: hintMs is not read when an endpoint is invalid (short-circuit)', () => {
  // Hypothesis: endpointLabel(from) throws before formatHint runs, so an invalid
  // endpoint must not trigger a side-effecting hintMs read.
  it('never reads hintMs when from is invalid', () => {
    let reads = 0;
    const info: any = { from: {}, to: INFO.to, get hintMs() { reads += 1; return 5; } };
    expect(() => buildFailoverNotice(info)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});

describe('R3N-Round 21: the string-code guard is precise, not over-swallowing', () => {
  // Hypothesis: only the code TYPE is guarded. A valid string code is preserved
  // verbatim (including '' which stays a deliberate empty reason), while a
  // non-string code is dropped rather than rendered as "[object Object]".
  it('preserves a valid string code and drops non-string codes', () => {
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'RATE_LIMIT' }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT)');
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, code: '' }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 ()');
    const dropped = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: { a: 1 } as never }).summary;
    expect(dropped).toBe('Failover: p1/m1 -> p3/m3 (connection failure)');
    expect(dropped).not.toContain('object');
  });

  it('never renders [object Object] or a numeric code for any non-string code', () => {
    for (const code of [123, true, {}, [], NaN]) {
      const { summary, text } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: code as never });
      expect(summary).not.toContain('object');
      expect(text).not.toContain('object');
      expect(summary).not.toContain('123');
    }
  });
});

describe('R3N-Round 22: the code guard leaves the hint path untouched', () => {
  // Hypothesis: dropping a non-string code must not drop the hint; the reason
  // falls through to the hint, exactly as with an absent code.
  it('renders the hint when a non-string code is dropped', () => {
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, code: null as never, hintMs: 5000 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 5000ms)');
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 42 as never, hintMs: 5000 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (cooldown hint 5000ms)');
  });
});

describe('R3N-Round 23: a string code still gates the combined reason with the hint', () => {
  // Hypothesis: the nullish/non-string guard is narrow — a real code plus a hint
  // still renders "code, cooldown hint Nms".
  it('renders code and hint together for a string code', () => {
    expect(buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'QUOTA', hintMs: 1000 }).summary)
      .toBe('Failover: p1/m1 -> p3/m3 (QUOTA, cooldown hint 1000ms)');
  });
});

describe('R3N-Round 24: no endpoint gets a code-specific bypass', () => {
  // Hypothesis: the code guard is orthogonal to endpoint validation; a valid code
  // with an invalid endpoint still fails at the endpoint guard.
  it('still rejects an invalid endpoint regardless of code validity', () => {
    expect(() => buildFailoverNotice({ from: {} as never, to: INFO.to, code: 'RATE_LIMIT' })).toThrow(TypeError);
  });
});
