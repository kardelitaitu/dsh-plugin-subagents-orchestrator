import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { recordRequest, recordFailure, getInFlightRequests, forgetAgent, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 17: requestStarts memory leak for successful agents.
 *
 * recordRequest stores a per-agent start entry; recordFailure consumes it.
 * Agents whose requests SUCCEED never hit recordFailure - and the host
 * exposes no success-side completion event - so without an explicit
 * forgetAgent on agent/disposed, every successful subagent leaks its
 * entry for the host's whole lifetime. In a long session that is
 * unbounded growth.
 */
describe('TDD round 17: requestStarts lifecycle and disposal cleanup', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' }
    ]
  };

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  it('PROBE 1: a successful agent start entry is released on agent/disposed', () => {
    // The release runs in the plugin's agent/disposed listener: apply first.
    setConfigForTest(baseConfig);
    apply(ctx);

    recordRequest('s-1', { provider: 'p1', model: 'm1' });
    recordRequest('s-2', { provider: 'p1', model: 'm1' });
    recordRequest('s-3', { provider: 'p2', model: 'm2' });
    expect(getInFlightRequests()).toBe(3);

    ctx.emit('agent/disposed', { agent: createMockAgent('s-1', 'subagent') });
    ctx.emit('agent/disposed', { agent: createMockAgent('s-2', 'subagent') });

    expect(getInFlightRequests()).toBe(1);

    // The survivor's entry is still consumable by a failure
    recordFailure('s-3', { provider: 'p2', model: 'm2' }, 'SERVER', undefined, Date.now());
    expect(getInFlightRequests()).toBe(0);
  });

  it('PROBE 2: a failure consumes its start entry (no double-release needed)', () => {
    recordRequest('f-1', { provider: 'p1', model: 'm1' });
    recordFailure('f-1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, Date.now());
    expect(getInFlightRequests()).toBe(0);

    // Disposal after the failure is a no-op, not an error
    ctx.emit('agent/disposed', { agent: createMockAgent('f-1', 'subagent') });
    expect(getInFlightRequests()).toBe(0);
  });

  it('PROBE 3: forgetAgent is idempotent and safe for unknown ids', () => {
    recordRequest('known', { provider: 'p1', model: 'm1' });
    forgetAgent('known');
    forgetAgent('known');
    forgetAgent('never-existed');
    expect(getInFlightRequests()).toBe(0);
  });

  it('PROBE 4: plugin flow - a successful subagent leaves no in-flight residue', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    // A delegation attributes the request; the host then reports success
    // (no failure event ever arrives) and disposes the agent.
    await ctx.emit('agent/request', { agent: createMockAgent('ok-agent', 'subagent') }, () => ({ provider: 'p1', model: 'm1' }));
    expect(getInFlightRequests()).toBe(1);

    ctx.emit('agent/disposed', { agent: createMockAgent('ok-agent', 'subagent') });
    expect(getInFlightRequests()).toBe(0);
  });
});
