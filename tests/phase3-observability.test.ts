import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { apply } from '../src/index.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { setNoticeModuleForTest, type NoticeModule } from '../src/notices.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

function fakeNoticeModule(): NoticeModule & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    createUserMessage: ((input: { content: unknown; source: unknown }) => {
      calls.push(input);
      return { role: 'user', id: 'msg-test', content: input.content, source: input.source };
    }) as NoticeModule['createUserMessage']
  };
}

/** Standard two-endpoint failover rig. */
const BASE_CONFIG = {
  enabled: true,
  failover: true,
  strategy: 'round-robin' as const,
  maxRetries: 0,
  intervalMinMs: 0,
  intervalMaxMs: 0,
  endpoints: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p3', model: 'm3' }
  ]
};

describe('Phase 3 integration: success spans, token meter and failover notices', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
    defaultCircuitBreaker.clear();
    setNoticeModuleForTest(null);
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
    setNoticeModuleForTest(null);
  });

  it('closes a success span when the host stops the turn after a routed request', async () => {
    setConfigForTest({ ...BASE_CONFIG });
    apply(ctx);

    const agent = createMockAgent('sub-ok', 'subagent');
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/turn-stopping', { agent, turn: 0 });

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.successes).toBe(1);
    expect(stat?.successLatencySamples).toBe(1);
    const success = getRecentEvents().find((e) => e.type === 'success');
    expect(success?.agentId).toBe('sub-ok');
  });

  it('attributes token deltas through the optional ctx.tokenMeter composition', async () => {
    setConfigForTest({ ...BASE_CONFIG });
    let measured = 0;
    (ctx as Record<string, unknown>)['tokenMeter'] = {
      measure: async () => ({ totalTokens: measured })
    };
    apply(ctx);

    const agent = createMockAgent('sub-tok', 'subagent');

    // First step: meter reads 900 tokens after the request.
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    measured = 900;
    await ctx.emit('agent/request', { agent, turn: 0, step: 1 }, () => ({ provider: 'p1', model: 'm1' }));
    // Second step: meter reads 1500.
    measured = 1500;
    await ctx.emit('agent/turn-stopping', { agent, turn: 0 });

    // First sample attributes the full 900 (first mark), the turn close the
    // remaining 600 — the host's cumulative meter never double-counts.
    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.successes).toBe(2);
    expect(stat?.tokensTotal).toBe(1500);
  });

  it('delivers an opt-in failover notice on the committed endpoint switch', async () => {
    setConfigForTest({ ...BASE_CONFIG, ui: { toasts: true } });
    const mod = fakeNoticeModule();
    setNoticeModuleForTest(mod);
    apply(ctx);

    const agent = createMockAgent('sub-notice', 'subagent');
    agent.inject = vi.fn();
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent, turn: 0, step: 0, failure: { code: 'SERVER' } });

    // The walk committed p3 and delivered the notice into the agent inbox.
    expect(agent.inject).toHaveBeenCalledTimes(1);
    const message = (agent.inject as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      role?: string;
      source?: Record<string, unknown>;
    };
    expect(message.role).toBe('user');
    expect(message.source).toMatchObject({ kind: 'plugin', form: 'notice', plugin: 'dsh-plugin-subagents-orchestrator' });

    // The retried request is rewritten onto the failover target as before.
    const retry: any = await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p3');
  });

  it('never notifies when ui.toasts is not opted into', async () => {
    setConfigForTest({ ...BASE_CONFIG });
    setNoticeModuleForTest(fakeNoticeModule());
    apply(ctx);

    const agent = createMockAgent('sub-quiet', 'subagent');
    agent.inject = vi.fn();
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent, turn: 0, step: 0, failure: { code: 'SERVER' } });

    const retry: any = await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p3'); // failover still happened
    expect(agent.inject).not.toHaveBeenCalled(); // ...silently
  });

  it('a notice is skipped without breaking the failover when inject is missing', async () => {
    setConfigForTest({ ...BASE_CONFIG, ui: { toasts: true }, debug: true });
    setNoticeModuleForTest(fakeNoticeModule());
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    apply(ctx);

    const agent = createMockAgent('sub-noinj', 'subagent');
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent, turn: 0, step: 0, failure: { code: 'SERVER' } });

    const retry: any = await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p3');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('failover notice skipped (no-agent-inject)'));
    debugSpy.mockRestore();
  });

  it('a failed step poisoned by request-error is never sampled as a success', async () => {
    setConfigForTest({ ...BASE_CONFIG, maxRetries: 0, endpoints: [{ provider: 'p1', model: 'm1' }, { provider: 'p3', model: 'm3', enabled: false }] });
    apply(ctx);

    const agent = createMockAgent('sub-fail', 'subagent');
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    // Every remaining candidate is parked: the walk is spent, decision
    // delegated back to the host — the step fails.
    await ctx.emit('agent/request-error', { agent, turn: 0, step: 0, failure: { code: 'SERVER' } });
    await ctx.emit('agent/turn-stopping', { agent, turn: 0 });

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    // Defer-path contract: the failure itself is not counted when the
    // failover machinery never engages (single-endpoint pool) — but the
    // poisoned span must still be suppressed.
    expect(stat?.failures).toBe(0);
    expect(stat?.successes).toBe(0);
    expect(getRecentEvents().find((e) => e.type === 'success')).toBeUndefined();
  });

  it('token meter failures cost the latency sample, not the listener', async () => {
    setConfigForTest({ ...BASE_CONFIG });
    (ctx as Record<string, unknown>)['tokenMeter'] = {
      measure: async () => {
        throw new Error('meter exploded');
      }
    };
    apply(ctx);

    const agent = createMockAgent('sub-meter-boom', 'subagent');
    await ctx.emit('agent/request', { agent, turn: 0, step: 0 }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/turn-stopping', { agent, turn: 0 });

    const stat = getEndpointStats().find((s) => s.key === 'p1::m1');
    expect(stat?.successes).toBe(1);
    expect(stat?.tokensTotal).toBe(0);
  });
});
