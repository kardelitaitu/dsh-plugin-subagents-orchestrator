import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildFailoverNotice,
  deliverFailoverNotice,
  setNoticeModuleForTest,
  NOTICE_SUMMARY_MAX_CHARS,
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
    createUserMessage: vi.fn(((input: { content: unknown; source: unknown }) => {
      calls.push(input);
      // Echo the input the way the real factory's output is observed:
      // role/id added, content+source preserved.
      return { role: 'user', id: 'msg-test', content: input.content, source: input.source };
    }) as NoticeModule['createUserMessage'])
  };
}

describe('Failover notices (ui.toasts carrier)', () => {
  beforeEach(() => {
    setNoticeModuleForTest(null);
  });

  describe('buildFailoverNotice', () => {
    it('summarizes the endpoint switch with the reason', () => {
      const { summary, text } = buildFailoverNotice(INFO);
      expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT, cooldown hint 60000ms)');
      expect(text).toContain('p1/m1');
      expect(text).toContain('p3/m3');
      expect(text).toContain('RATE_LIMIT');
    });

    it('falls back to the failure code when no hint is present', () => {
      const { summary } = buildFailoverNotice({ from: INFO.from, to: INFO.to, code: 'TIMEOUT' });
      expect(summary).toBe('Failover: p1/m1 -> p3/m3 (TIMEOUT)');
    });

    it('bounds the summary to the host transcript-row limit', () => {
      const longProvider = 'p'.repeat(200);
      const { summary } = buildFailoverNotice({
        from: { provider: longProvider, model: 'm1' },
        to: INFO.to
      });
      expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
      expect(summary.endsWith('\u2026')).toBe(true);
    });
  });

  describe('deliverFailoverNotice', () => {
    it('delivers a plugin-notice user message via agent.inject', async () => {
      const mod = fakeModule();
      setNoticeModuleForTest(mod);
      const inject = vi.fn();
      const delivery = await deliverFailoverNotice({ inject }, INFO);

      expect(delivery).toBe('delivered');
      expect(inject).toHaveBeenCalledTimes(1);
      const message = inject.mock.calls[0][0] as { role?: string; source?: Record<string, unknown> };
      expect(message.role).toBe('user');
      expect(message.source).toMatchObject({
        kind: 'plugin',
        plugin: 'dsh-plugin-subagents-orchestrator',
        form: 'notice'
      });
      expect((message.source?.['summary'] as string).length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS);
    });

    it('is a no-op when the agent has no inject (mocks, older hosts)', async () => {
      setNoticeModuleForTest(fakeModule());
      expect(await deliverFailoverNotice(null, INFO)).toBe('no-agent-inject');
      expect(await deliverFailoverNotice({}, INFO)).toBe('no-agent-inject');
      expect(await deliverFailoverNotice({ inject: 'not-a-function' }, INFO)).toBe('no-agent-inject');
    });

    it('degrades when the dsh-llm module is unavailable', async () => {
      setNoticeModuleForTest(null);
      const inject = vi.fn();
      const delivery = await deliverFailoverNotice({ inject }, INFO);
      expect(delivery).toBe('module-unavailable');
      expect(inject).not.toHaveBeenCalled();
    });

    it('never throws when createUserMessage or inject misbehaves', async () => {
      setNoticeModuleForTest({ createUserMessage: () => { throw new Error('boom'); } });
      expect(await deliverFailoverNotice({ inject: vi.fn() }, INFO)).toBe('failed');

      setNoticeModuleForTest(fakeModule());
      expect(await deliverFailoverNotice({ inject: () => { throw new Error('boom'); } }, INFO)).toBe('failed');
    });
  });
});
