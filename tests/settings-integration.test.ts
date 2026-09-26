import { describe, it, expect, afterEach, vi } from 'vitest';
import { apply } from '../src/index.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { resetTelemetry } from '../src/telemetry.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { MockCordisContext } from './mocks/cordis.js';
import { ORCHESTRATOR_SETTINGS_NAMESPACE } from '../src/settings.js';

/**
 * Integration seam: the settings registration goes through the REAL apply()
 * entry and the REAL MockCordisContext.inject fan-out, not a hand-rolled
 * context - this is the end-to-end guarantee that composing the plugin
 * actually arms the panel when (and only when) ui.panel is opted into.
 */
describe('apply() -> settings panel integration', () => {
  afterEach(() => {
    setConfigForTest(null);
    resetConfigForTest('unused.yaml');
    disposeWatcher();
    resetTelemetry();
    defaultCircuitBreaker.clear();
    vi.restoreAllMocks();
  });

  function ctxWithSettings(store: Map<string, unknown>) {
    const ctx = new MockCordisContext();
    const registered: { ns: string; schema: unknown }[] = [];
    ctx.settings = {
      register(ns: string, schema: unknown) {
        registered.push({ ns, schema });
        store.set(ns, schema);
        return { get: () => undefined, watch: () => undefined };
      }
    };
    return { ctx, registered };
  }

  it('arms the panel through the real apply() when ui.panel is on', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [{ provider: 'p', model: 'm' }] });
    const store = new Map<string, unknown>();
    const { ctx, registered } = ctxWithSettings(store);

    apply(ctx);

    // The inject fan-out ran synchronously inside apply(); registration landed.
    expect(registered).toHaveLength(1);
    expect(registered[0]!.ns).toBe(ORCHESTRATOR_SETTINGS_NAMESPACE);
    expect(store.has('subagents-orchestrator')).toBe(true);
  });

  it('leaves the settings service untouched when ui.panel is off', () => {
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p', model: 'm' }] });
    const { ctx, registered } = ctxWithSettings(new Map());

    apply(ctx);

    // The service object exists on the mock, but apply() never touched it.
    expect(registered).toHaveLength(0);
  });

  it('a settings registration failure never breaks plugin composition', () => {
    setConfigForTest({ enabled: true, ui: { panel: true } });
    const ctx = new MockCordisContext();
    ctx.settings = {
      register() {
        throw new Error('SETTINGS_REJECTED');
      }
    };

    // apply() must complete and install its listeners regardless.
    expect(() => apply(ctx)).not.toThrow();
    expect(ctx.listeners.size).toBeGreaterThan(0);
  });

  it('the registered schema validates a settings-shaped section and keeps unmodeled keys', () => {
    setConfigForTest({ enabled: true, ui: { panel: true } });
    const store = new Map<string, unknown>();
    const { ctx } = ctxWithSettings(store);

    apply(ctx);

    const schema = store.get(ORCHESTRATOR_SETTINGS_NAMESPACE) as (data: unknown) => Record<string, unknown>;
    const resolved = schema({
      enabled: true,
      cooldownMs: 45000,
      ui: { toasts: true, panel: true },
      endpoints: [{ provider: 'kept', model: 'as-is' }]
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.cooldownMs).toBe(45000);
    expect(resolved.ui).toEqual({ toasts: true, panel: true });
    // endpoints stay untouched for the YAML path (non-strict object merge)
    expect(resolved.endpoints).toEqual([{ provider: 'kept', model: 'as-is' }]);
  });

  it('hydrates quarantines on startup from settings scope and watches UI changes', () => {
    const future = Date.now() + 600000;
    let watcherCb: ((next: unknown) => void) | null = null;
    const ctx = new MockCordisContext();
    ctx.settings = {
      register(ns: string, schema: unknown) {
        return {
          get: () => ({ quarantines: { 'p::m': future } }),
          watch: (cb: (next: unknown) => void) => {
            watcherCb = cb;
          }
        };
      }
    };
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [{ provider: 'p', model: 'm' }] });

    apply(ctx);

    // Initial hydration landed in defaultCircuitBreaker
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p', model: 'm' })).toBe(false);

    // Watcher notifies reset from UI
    expect(watcherCb).toBeDefined();
    watcherCb!({ quarantines: {} });
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p', model: 'm' })).toBe(true);
  });

  it('observes errors on root (non-subagent) sessions and records quarantine', async () => {
    let mutated: any = null;
    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({ get: () => undefined, watch: () => undefined }),
      mutate: async (ns: string, ops: any[]) => {
        mutated = { ns, ops };
      }
    };
    setConfigForTest({
      enabled: true,
      ui: { panel: true },
      endpoints: [
        { provider: 'buddy-16', model: 'deepseek-v4.1-flash' },
        { provider: 'buddy-1', model: 'deepseek-v4.1-flash' }
      ]
    });

    apply(ctx);

    // Root agent (origin is 'user' or absent, NOT 'subagent')
    const rootAgent = { id: 'root-chat-session', session: { header: { origin: 'user' } } } as any;

    // Simulate root request on buddy-16
    await ctx.emit('agent/request', { agent: rootAgent }, () => ({
      provider: 'buddy-16',
      model: 'deepseek-v4.1-flash'
    }));

    // Simulate account-level failure (QUOTA)
    const action = await ctx.emit(
      'agent/request-error',
      { agent: rootAgent, failure: { code: 'QUOTA' }, turn: 1, step: 1 },
      () => 'host-fallback'
    );

    // Root agent gets delegated to host (action is 'host-fallback', no subagent rewrite)
    expect(action).toBe('host-fallback');

    // But circuit breaker recorded the failure and quarantined buddy-16!
    expect(defaultCircuitBreaker.isHealthy({ provider: 'buddy-16', model: 'deepseek-v4.1-flash' })).toBe(false);

    // And host settings service received the mutation to persist!
    expect(mutated).toBeDefined();
    expect(mutated.ns).toBe('subagents-orchestrator');
    expect(mutated.ops[0].path).toEqual(['quarantines']);
    expect(mutated.ops[0].value['buddy-16::deepseek-v4.1-flash']).toBeGreaterThan(Date.now());
  });
});

