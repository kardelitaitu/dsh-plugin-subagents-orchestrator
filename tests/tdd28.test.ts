import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, WRAPPED } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext } from './mocks/cordis.js';

/**
 * TDD round 28: continuable routing and unwrap-on-dispose.
 *
 * The subagents wrapper covers start AND startContinuable uniformly;
 * removing the plugin must restore the originals exactly (no double-wrap,
 * no orphaned routing after the plugin is gone).
 */
describe('TDD round 28: continuable routing and unwrapping', () => {
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
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  it('PROBE 1: a spec-less startContinuable is routed like a bare start', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const res: any = await ctx.subagents.startContinuable!(undefined);
    expect(res.spec?.request?.agentOptions?.provider).toBe('p1');
  });

  it('PROBE 2: a spec with an explicit request keeps the caller agentOptions untouched', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const res: any = await ctx.subagents.startContinuable!({
      request: { agentOptions: { provider: 'custom', model: 'custom-model' } }
    });
    expect(res.spec.request.agentOptions).toEqual({ provider: 'custom', model: 'custom-model' });
  });

  it('PROBE 3: a spec with an empty request is routed', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const res: any = await ctx.subagents.startContinuable!({});
    expect(res.spec.request.agentOptions?.provider).toBe('p1');
  });

  it('PROBE 4: dispose restores the original service - no routing after removal', async () => {
    setConfigForTest(baseConfig);
    apply(ctx);

    const raw: any = (ctx.subagents as any);
    expect(raw[WRAPPED]).toBe(true);

    ctx.dispose();

    // The wrapper is removed: starts pass through with the caller's
    // request exactly as given, and re-applying wraps cleanly again.
    const after: any = await ctx.subagents.start!('post-dispose', {});
    expect(after.request).toEqual({});
    expect(after.request.agentOptions).toBeUndefined();

    apply(ctx);
    const rewrapped: any = await ctx.subagents.start!('re-applied', {});
    expect(rewrapped.request.agentOptions?.provider).toBeDefined();
  });
});
