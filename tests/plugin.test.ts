import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, isSubagent } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

describe('Cordis Subagents Orchestrator Plugin', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
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
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    apply(ctx);

    const subagent = createMockAgent('sub-test-1', 'subagent');

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

    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });
    const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // p2 is tripped, so the failover target must be p3, not p2
    expect(retry.provider).toBe('p3');
    expect(retry.model).toBe('m3');
  });
});
