import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * TDD round 3: a disabled plugin must be fully inert.
 *
 * Contract: with `enabled: false`, NOTHING may happen on the failure path -
 * no breaker writes, no telemetry, no retry pacing, no retry command - even
 * when `failover: true` is still set. Disabling the plugin means disabling
 * all of it, field by field.
 */
describe('TDD round 3: disabled plugin is fully inert', () => {
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
    resetTelemetry();
  });

  function setupDisabledFailover() {
    setConfigForTest({
      enabled: false,
      failover: true,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);
    return createMockAgent('tdd3', 'subagent');
  }

  it('PROBE A: a failure with the plugin disabled defers to the host without any retry command', async () => {
    const subagent = setupDisabledFailover();

    // Simulate the host having assigned p1 before the plugin was disabled
    const hostSeed = () => ({ provider: 'p1', model: 'm1', hostOwned: true });
    await ctx.emit('agent/request', { agent: subagent }, hostSeed);

    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' } },
      () => 'host-default'
    );

    // CONTRACT: the disabled plugin must not command retries.
    expect(result).toBe('host-default');
  });

  it('PROBE B: a disabled plugin records no telemetry and no breaker state on failures', async () => {
    const subagent = setupDisabledFailover();

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => 'host-default');

    // CONTRACT: inert means inert - no telemetry events, no endpoint stats.
    expect(getRecentEvents()).toEqual([]);
    expect(getEndpointStats()).toEqual([]);
  });

  it('PROBE C: a later host-driven request is untouched by disabled-plugin failover state', async () => {
    const subagent = setupDisabledFailover();

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } }, () => 'host-default');

    const result: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1', pristine: true }));
    expect(result).toMatchObject({ provider: 'p1', model: 'm1', pristine: true });
  });

  it('PROBE D: attribution recorded before a disable must not resurrect failover after it', async () => {
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

    const subagent = createMockAgent('tdd3-stale', 'subagent');

    // While enabled: the host assigns p1 (attributed in activeEndpoints)
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    // The user disables the plugin mid-flight
    setConfigForTest({
      enabled: false,
      failover: true,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });

    // CONTRACT: the stale attribution must not let the disabled plugin act.
    // The decision defers to the host, and nothing is recorded.
    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'SERVER' } },
      () => 'host-default'
    );
    expect(result).toBe('host-default');
    // Telemetry recorded while the plugin was still enabled is legitimate
    // history; what must not exist is any failure/failover written AFTER the
    // disable.
    const events = getRecentEvents().filter((e) => e.type !== 'request');
    expect(events).toEqual([]);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' }).consecutiveFailures).toBe(0);
  });
});
