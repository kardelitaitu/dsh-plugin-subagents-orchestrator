import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, isSubagent, WRAPPED } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

describe('Cordis Subagents Orchestrator Plugin', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
  });

  it('correctly identifies subagents by session header origin', () => {
    const subagent = createMockAgent('agent-1', 'subagent');
    const mainAgent = createMockAgent('agent-2', 'user');
    const unknownAgent = { id: 'agent-3' };

    expect(isSubagent(subagent)).toBe(true);
    expect(isSubagent(mainAgent)).toBe(false);
    expect(isSubagent(unknownAgent as any)).toBe(false);
    expect(isSubagent(null)).toBe(false);
  });

  it('intercepts subagents.start and injects round-robin endpoint options', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [
        { provider: 'prov-1', model: 'mod-1' },
        { provider: 'prov-2', model: 'mod-2' }
      ]
    });

    apply(ctx);

    const call1: any = await ctx.subagents.start!('worker-1', {});
    const call2: any = await ctx.subagents.start!('worker-2', {});

    expect(call1.request.agentOptions).toEqual({
      provider: 'prov-1',
      model: 'mod-1'
    });
    expect(call2.request.agentOptions).toEqual({
      provider: 'prov-2',
      model: 'mod-2'
    });
  });

  it('respects caller explicit model overrides', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [{ provider: 'prov-1', model: 'mod-1' }]
    });

    apply(ctx);

    const explicitOptions = { provider: 'custom', model: 'custom-model' };
    const res: any = await ctx.subagents.start!('worker-explicit', {
      agentOptions: explicitOptions
    });

    expect(res.request.agentOptions).toEqual(explicitOptions);
  });

  it('bypasses orchestration when disabled in config', async () => {
    setConfigForTest({
      enabled: false,
      endpoints: [{ provider: 'prov-1', model: 'mod-1' }]
    });

    apply(ctx);

    const res: any = await ctx.subagents.start!('worker-disabled', {});
    expect(res.request.agentOptions).toBeUndefined();
  });

  it('handles failover retry for subagents encountering RATE_LIMIT', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-test-1', 'subagent');

    // The host assigns p1 before the request can fail (real waterfall order).
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Simulate error event
    const errorResult = await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' }
    });

    expect(errorResult).toEqual({ kind: 'retry' });

    // Simulate retry request event
    const retryRequest = await ctx.emit(
      'agent/request',
      { agent: subagent },
      () => ({ provider: 'p1', model: 'm1', seedParam: true })
    );

    expect(retryRequest.provider).toBe('p2');
    expect(retryRequest.model).toBe('m2');
    expect(retryRequest.seedParam).toBe(true);
  });

  it('does NOT trigger failover retry for main session agents', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const mainAgent = createMockAgent('main-test-1', 'user');

    const errorResult = await ctx.emit(
      'agent/request-error',
      {
        agent: mainAgent,
        failure: { code: 'RATE_LIMIT' }
      },
      () => ({ handledByDefault: true })
    );

    expect(errorResult).toEqual({ handledByDefault: true });
  });

  it('attributes the first failure to the initially assigned endpoint', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-attr-1', 'subagent');

    // Pass-through request records the endpoint the host assigned
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'SERVER' }
    });

    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(1);
  });

  it('trips an endpoint immediately when the provider sends Retry-After', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-hint-1', 'subagent');

    // Assign p1 via a pass-through request
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const errorResult = await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '30' } }
    });
    expect(errorResult).toEqual({ kind: 'retry' });
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p1', model: 'm1' })).toBe(false);

    // New subagent routing must skip the tripped endpoint
    const res: any = await ctx.subagents.start!('worker-after-hint', {});
    expect(res.request.agentOptions).toEqual({ provider: 'p2', model: 'm2' });
  });

  it('skips a tripped endpoint when choosing the failover target', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });

    apply(ctx);

    // p2 is already down before the failure cascade starts
    defaultCircuitBreaker.recordFailure({ provider: 'p2', model: 'm2' }, 1, 60000);

    const subagent = createMockAgent('sub-skip-1', 'subagent');

    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // p2 is tripped, so the failover target must be p3, not p2
    expect(retry.provider).toBe('p3');
    expect(retry.model).toBe('m3');
  });

  it('records telemetry across a full failover lifecycle', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-telemetry-1', 'subagent');

    // 1. Initial (pass-through) request assigned p1
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // 2. p1 fails with a Retry-After hint
    await ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT', headers: { 'Retry-After': '30' } }
    });

    // 3. Retried request lands on p2
    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p2');

    // 4. Cleanup clears the agent's tracked endpoint
    await ctx.emit('agent/disposed', { agent: subagent });

    const stats = getEndpointStats();
    const p1 = stats.find((s) => s.key === 'p1::m1');
    const p2 = stats.find((s) => s.key === 'p2::m2');

    expect(p1).toMatchObject({ requests: 1, failures: 1, cooldownHints: 1 });
    expect(p2).toMatchObject({ requests: 1, failovers: 1 });

    const events = getRecentEvents();
    expect(events.map((e) => e.type)).toEqual(['request', 'failure', 'failover', 'request']);
    expect(events[1]).toMatchObject({ code: 'RATE_LIMIT', hintMs: 30000 });
    expect(events[2]).toMatchObject({ from: { provider: 'p1' }, to: { provider: 'p2' } });
  });

  it('routes bare start() calls that carry no request object', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const r1: any = await ctx.subagents.start!('worker-bare-1');
    const r2: any = await ctx.subagents.start!('worker-bare-2');

    expect(r1.request.agentOptions).toEqual({ provider: 'p1', model: 'm1' });
    expect(r2.request.agentOptions).toEqual({ provider: 'p2', model: 'm2' });
  });

  it('routes spec-less startContinuable() calls', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [{ provider: 'p1', model: 'm1' }]
    });

    apply(ctx);

    const res: any = await ctx.subagents.startContinuable!();
    expect(res.spec.request.agentOptions).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('routes spec-bearing startContinuable() calls and preserves the delegation spec', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    // Mirrors the real dsh-tool-subagent spec shape: named subagent provider,
    // label, request, signal — the LLM route lives in request.agentOptions.
    const res: any = await ctx.subagents.startContinuable!({
      provider: 'named-provider',
      label: 'research',
      request: {},
      signal: { aborted: false }
    });

    expect(res.spec.provider).toBe('named-provider');
    expect(res.spec.label).toBe('research');
    expect(res.spec.signal).toEqual({ aborted: false });
    expect(res.spec.request.agentOptions).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('respects explicit agentOptions carried inside a startContinuable spec', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [{ provider: 'p1', model: 'm1' }]
    });

    apply(ctx);

    const explicit = { provider: 'custom', model: 'custom-model' };
    const res: any = await ctx.subagents.startContinuable!({
      provider: 'named-provider',
      request: { agentOptions: explicit }
    });

    expect(res.spec.request.agentOptions).toEqual(explicit);
  });

  it('leaves requests untouched when the endpoint pool is empty', async () => {
    // Enabled but empty endpoint pool: nothing to route to.
    setConfigForTest({ enabled: true, failover: true, endpoints: [] });
    apply(ctx);
    const emptyPool: any = await ctx.subagents.start!('w-empty', {});
    expect(emptyPool.request.agentOptions).toBeUndefined();
  });

  it('ignores failure codes outside the failover trigger set and records no telemetry', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-auth-1', 'subagent');

    // AUTH / CONTEXT_WINDOW_EXCEEDED are endpoint-independent failures: the
    // same failure would happen on any pool entry, so failover cannot help.
    for (const code of ['AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'UNKNOWN']) {
      const result = await ctx.emit(
        'agent/request-error',
        { agent: subagent, failure: { code } },
        () => 'host-default'
      );
      expect(result, 'code ' + code).toBe('host-default');
    }

    expect(getRecentEvents()).toEqual([]);
  });

  it('defers when the failure carries an already-aborted signal', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const result = await ctx.emit(
      'agent/request-error',
      {
        agent: createMockAgent('sub-aborted-1', 'subagent'),
        failure: { code: 'RATE_LIMIT' },
        signal: { aborted: true }
      },
      () => 'host-default'
    );

    expect(result).toBe('host-default');
  });

  it('defers when failover is disabled or fewer than two endpoints exist', async () => {
    // Failover not enabled
    setConfigForTest({
      enabled: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);
    const disabled = await ctx.emit(
      'agent/request-error',
      { agent: createMockAgent('sub-nofailover-1', 'subagent'), failure: { code: 'RATE_LIMIT' } },
      () => 'host-default'
    );
    expect(disabled).toBe('host-default');

    // Failover enabled but a single-endpoint pool has nowhere to go
    setConfigForTest({ enabled: true, failover: true, endpoints: [{ provider: 'p1', model: 'm1' }] });
    const singleCtx = new MockCordisContext();
    apply(singleCtx);
    const single = await singleCtx.emit(
      'agent/request-error',
      { agent: createMockAgent('sub-single-1', 'subagent'), failure: { code: 'RATE_LIMIT' } },
      () => 'host-default'
    );
    expect(single).toBe('host-default');
    singleCtx.dispose();
  });

  it('veto-semantics: an issued failover retry stops downstream recovery listeners', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-veto-1', 'subagent');

    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // A dsh-llm-retry-style listener registered AFTER the orchestrator: in the
    // cordis waterfall the orchestrator runs outermost-first, and a retry it
    // issues must veto the rest of the chain (llm-retry never re-runs the same
    // failed provider on top of a cross-endpoint failover).
    let downstreamRan = false;
    ctx.on('agent/request-error', () => {
      downstreamRan = true;
      return { kind: 'retry', from: 'downstream' };
    });

    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' } },
      () => null
    );

    expect(result).toEqual({ kind: 'retry' });
    expect(downstreamRan).toBe(false);
  });

  it('composes with an upstream retry listener and defers to the host once the pool is exhausted', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });

    // Registered BEFORE apply(): runs outermost in the waterfall, like the
    // core dsh-llm-retry plugin. It defers via next() and records whatever
    // decision the rest of the chain produced.
    const upstreamSeen: unknown[] = [];
    ctx.on('agent/request-error', async (_payload, next) => {
      const decision = await next();
      upstreamSeen.push(decision);
      return decision;
    });

    apply(ctx);

    const subagent = createMockAgent('sub-cascade-1', 'subagent');

    // The host assigned p1 (pass-through seed); the orchestrator records it
    // for breaker attribution.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // Failure 1: p1 -> p2
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' } }, () => null)
    ).toEqual({ kind: 'retry' });
    const retry1: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry1.provider).toBe('p2');

    // Failure 2: p2 -> p3
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => null)
    ).toEqual({ kind: 'retry' });
    const retry2: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry2.provider).toBe('p3');

    // Failure 3: every pool entry has been tried once — the orchestrator
    // defers and the host/upstream decision stands.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'TIMEOUT' } }, () => null)
    ).toBeNull();

    // The upstream listener observed every decision the chain produced:
    // the two orchestrator failover retries, then the final deferral to the
    // host once the pool was exhausted.
    expect(upstreamSeen).toEqual([{ kind: 'retry' }, { kind: 'retry' }, null]);

    // Breaker attribution followed the cascade: one failure on each of the
    // two failover targets (p1 was assigned by the host, not the orchestrator,
    // so its failure is attributed through the activeEndpoints map too).
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(1);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p2', model: 'm2' }).consecutiveFailures).toBe(1);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p3', model: 'm3' }).consecutiveFailures).toBe(1);
  });

  it('resets the per-agent failover budget on agent/disposed', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-reset-1', 'subagent');

    // The host assigned p1 before the first failure.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // First lifecycle: one failover consumes the entire budget.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => null)
    ).toEqual({ kind: 'retry' });
    const first: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(first.provider).toBe('p2');

    // A second failure without disposal is deferred — the pool was exhausted.
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => 'host-default')
    ).toBe('host-default');

    // The agent settles and is disposed; the host may restart the same id.
    await ctx.emit('agent/disposed', { agent: subagent });

    // Fresh lifecycle: the host assigns p1 again, then failover works again
    // from a clean budget.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => null)
    ).toEqual({ kind: 'retry' });
    const second: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(second.provider).toBe('p2');
  });

  it('strips the inherited seed reasoningEffort when the failover target defines none', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-effort-1', 'subagent');
    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' } }, () => null);

    // Mirrors dsh-agent's own agent/request listener: the inherited effort is
    // tied to the failed provider's route and must not leak onto the fallback.
    const retried: any = await ctx.emit(
      'agent/request',
      { agent: subagent },
      () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'high', maxTokens: 4096 })
    );

    expect(retried).toEqual({ provider: 'p2', model: 'm2', maxTokens: 4096 });
    expect(retried).not.toHaveProperty('reasoningEffort');
  });

  it('applies the failover target reasoningEffort over the inherited seed effort', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2', reasoningEffort: 'low' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-effort-2', 'subagent');
    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' } }, () => null);

    const retried: any = await ctx.emit(
      'agent/request',
      { agent: subagent },
      () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'high', maxTokens: 2048 })
    );

    expect(retried).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'low', maxTokens: 2048 });
  });

  it('passes a null seed through the retried request while keeping the failover state', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-nullseed-1', 'subagent');
    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' } }, () => null)
    ).toEqual({ kind: 'retry' });

    // Host aborted the build before proposing a config: nothing to override.
    expect(await ctx.emit('agent/request', { agent: subagent }, () => null)).toBeNull();

    // The next build still lands on the failover target — state survived.
    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p2');
  });

  it('passes the seed through unchanged when the failover target no longer exists in the pool', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      maxRetries: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-shrink-1', 'subagent');
    // The host assigned p1 before the request failed.
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'RATE_LIMIT' } }, () => null)
    ).toEqual({ kind: 'retry' });

    // Settings hot-reload parked endpoints 2 and 3; the scheduled failover
    // target is gone, so the retry must not fabricate a route.
    setConfigForTest({ enabled: true, failover: true, endpoints: [{ provider: 'p1', model: 'm1' }] });

    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retry.provider).toBe('p1');
    expect(retry.model).toBe('m1');
  });

  it('does not double-wrap the service when apply() runs twice on the same context', async () => {
    setConfigForTest({
      enabled: true,
      strategy: 'round-robin',
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);
    const wrappedOnce = ctx.subagents.start;
    apply(ctx);

    // The WRAPPED symbol guard keeps the second apply from re-wrapping.
    expect(ctx.subagents.start).toBe(wrappedOnce);

    // Routing still advances exactly one cursor step per call.
    const call1: any = await ctx.subagents.start!('w-idem-1', {});
    expect(call1.request.agentOptions).toEqual({ provider: 'p1', model: 'm1' });
  });

  it('restores the original service methods and stops listening on dispose', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    const originalStart = ctx.subagents.start;
    const originalStartContinuable = ctx.subagents.startContinuable;

    apply(ctx);
    expect(ctx.subagents.start).not.toBe(originalStart);

    ctx.dispose();

    // The subagents service is exactly as the plugin found it.
    expect(ctx.subagents.start).toBe(originalStart);
    expect(ctx.subagents.startContinuable).toBe(originalStartContinuable);
    expect((ctx.subagents as any)[WRAPPED]).toBeUndefined();

    // And the failover listeners are gone: events fall through to the host.
    const result = await ctx.emit(
      'agent/request-error',
      { agent: createMockAgent('sub-postdispose-1', 'subagent'), failure: { code: 'RATE_LIMIT' } },
      () => 'host-default'
    );
    expect(result).toBe('host-default');
  });
});
