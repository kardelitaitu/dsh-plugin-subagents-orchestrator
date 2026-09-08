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
});
