import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseConfigDocument, extractEndpoints, setConfigForTest, disposeWatcher } from '../src/config.js';
import { apply } from '../src/index.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { recordRequest, setDebugLogging, getEndpointStats, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

describe('Config Extension: debug flag & per-endpoint enabled', () => {
  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
    delete process.env['DSH_ORCHESTRATOR_DEBUG'];
  });

  describe('schema validation', () => {
    it('accepts a boolean debug flag and drops wrong-typed values', () => {
      expect(parseConfigDocument({ 'subagents-orchestrator': { debug: true } })?.debug).toBe(true);
      expect(parseConfigDocument({ 'subagents-orchestrator': { debug: false } })?.debug).toBe(false);
      expect(parseConfigDocument({ 'subagents-orchestrator': { debug: 'yes' } })?.debug).toBeUndefined();
      expect(parseConfigDocument({ 'subagents-orchestrator': { debug: 1 } })?.debug).toBeUndefined();
    });

    it('keeps boolean endpoint enabled and drops wrong-typed values', () => {
      const parsed = parseConfigDocument({
        'subagents-orchestrator': {
          endpoints: [
            { provider: 'p1', model: 'm1', enabled: false },
            { provider: 'p2', model: 'm2', enabled: 'no' },
            { provider: 'p3', model: 'm3', enabled: true }
          ]
        }
      });
      expect(parsed?.endpoints).toHaveLength(3);
      expect(parsed?.endpoints?.[0]).toMatchObject({ provider: 'p1', enabled: false });
      expect(parsed?.endpoints?.[1]).not.toHaveProperty('enabled');
      expect(parsed?.endpoints?.[2]?.enabled).toBe(true);
    });

    it('excludes disabled endpoints from the effective pool', () => {
      const config = parseConfigDocument({
        'subagents-orchestrator': {
          endpoints: [
            { provider: 'p1', model: 'm1' },
            { provider: 'p2', model: 'm2', enabled: false }
          ]
        }
      });
      expect(extractEndpoints(config).map((e) => e.provider)).toEqual(['p1']);
    });
  });

  describe('routing & failover', () => {
    let ctx: MockCordisContext;

    beforeEach(() => {
      ctx = new MockCordisContext();
      resetTelemetry();
    });

    afterEach(() => {
      ctx.dispose();
    });

    it('never routes new subagents to a disabled endpoint', async () => {
      setConfigForTest({
        enabled: true,
        strategy: 'round-robin',
        endpoints: [
          { provider: 'on-1', model: 'm1' },
          { provider: 'off-1', model: 'm2', enabled: false },
          { provider: 'on-2', model: 'm3' }
        ]
      });

      apply(ctx);

      const r1: any = await ctx.subagents.start!('w1', {});
      const r2: any = await ctx.subagents.start!('w2', {});
      const r3: any = await ctx.subagents.start!('w3', {});

      const providers = [r1.request.agentOptions.provider, r2.request.agentOptions.provider, r3.request.agentOptions.provider];
      expect(providers).toEqual(['on-1', 'on-2', 'on-1']);
    });

    it('skips disabled endpoints when selecting a failover target', async () => {
      setConfigForTest({
        enabled: true,
        failover: true,
        intervalMinMs: 0,
        intervalMaxMs: 0,
        maxRetries: 0,
        endpoints: [
          { provider: 'p1', model: 'm1' },
          { provider: 'off', model: 'm2', enabled: false },
          { provider: 'p3', model: 'm3' }
        ]
      });

      apply(ctx);

      const subagent = createMockAgent('sub-ext-1', 'subagent');
      // The host assigned p1 (the only enabled candidate before the failure).
      await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      await ctx.emit('agent/request-error', { agent: subagent, failure: { code: 'SERVER' } });

      const retry: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
      expect(retry.provider).toBe('p3');
    });
  });

  describe('debug logging switch', () => {
    it('config debug: false silences lines even when the env var is set', () => {
      process.env['DSH_ORCHESTRATOR_DEBUG'] = '1';
      resetTelemetry();
      setDebugLogging(false);

      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        recordRequest('a', { provider: 'p', model: 'm' });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('config debug: true emits lines without any environment variable', () => {
      resetTelemetry();
      setDebugLogging(true);

      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        recordRequest('a', { provider: 'p', model: 'm' });
        expect(spy).toHaveBeenCalledTimes(1);

        const [, payload] = spy.mock.calls[0];
        expect(JSON.parse(String(payload))).toMatchObject({ type: 'request' });
      } finally {
        spy.mockRestore();
      }
    });

    it('auto mode follows the environment variable', () => {
      resetTelemetry();
      setDebugLogging(undefined);

      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        recordRequest('a', { provider: 'p', model: 'm' });
        expect(spy).not.toHaveBeenCalled();

        process.env['DSH_ORCHESTRATOR_DEBUG'] = '1';
        recordRequest('b', { provider: 'p', model: 'm' });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
