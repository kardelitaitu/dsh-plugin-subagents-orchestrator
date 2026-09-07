import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/** A controllable abort signal for exercising the cancellable retry wait. */
function makeSignal() {
  const state = { aborted: false, listener: null as null | (() => void) };
  return {
    get aborted() {
      return state.aborted;
    },
    addEventListener(_type: string, listener: () => void) {
      state.listener = listener;
    },
    removeEventListener() {
      state.listener = null;
    },
    fire() {
      state.aborted = true;
      state.listener?.();
    }
  };
}

describe('TDD round 2: retry-wait lifecycle integrity', () => {
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

  function setup() {
    setConfigForTest({
      enabled: true,
      failover: true,
      intervalMinMs: 30,
      intervalMaxMs: 30,
      endpoints: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' }
      ]
    });
    apply(ctx);
    return createMockAgent('tdd2', 'subagent');
  }

  it('PROBE 1: an abort during the retry wait must not record a failover that never happens', async () => {
    const subagent = setup();
    const signal = makeSignal();

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const emitting = ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'RATE_LIMIT' },
      signal
    });

    // Abort while the handler is inside its retry wait
    setTimeout(() => signal.fire(), 5);
    await emitting;

    // CONTRACT: no failover was applied (pending plan dropped), so neither
    // the event buffer nor the stats may claim one.
    const events = getRecentEvents();
    expect(events.filter((e) => e.type === 'failover')).toEqual([]);

    const stats = getEndpointStats().find((s) => s.key === 'p2::m2');
    expect(stats?.failovers ?? 0).toBe(0);
  });

  it('PROBE 2: an aborted wait returns a prompt retry decision with no phantom failover effects', async () => {
    const subagent = setup();
    const signal = makeSignal();

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const started = Date.now();
    const emitting = ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, signal },
      () => 'host-decides'
    );

    // Abort shortly into the 30ms wait
    setTimeout(() => signal.fire(), 5);
    const result = await emitting;
    const elapsed = Date.now() - started;

    // CONTRACT (project design): the decision still comes back promptly as a
    // retry (the host checks the abort itself), but the dropped plan must
    // leave no phantom effects: no recorded failover, and the retried
    // request passes through untouched on the original endpoint.
    expect(result).toEqual({ kind: 'retry' });
    expect(elapsed).toBeLessThan(2000);

    const events = getRecentEvents();
    expect(events.filter((e) => e.type === 'failover')).toEqual([]);

    const after: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1', original: true }));
    expect(after).toMatchObject({ provider: 'p1', model: 'm1', original: true });
  });

  it('PROBE 3: disposal during the retry wait must not record a failover either', async () => {
    const subagent = setup();

    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const emitting = ctx.emit('agent/request-error', {
      agent: subagent,
      failure: { code: 'SERVER' }
    });

    // Dispose the plugin while the handler is waiting
    setTimeout(() => ctx.dispose(), 5);
    await emitting;

    const events = getRecentEvents();
    expect(events.filter((e) => e.type === 'failover')).toEqual([]);
    expect(getEndpointStats().find((s) => s.key === 'p2::m2')?.failovers ?? 0).toBe(0);
  });
});
