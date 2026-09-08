import { describe, it, expect, afterEach } from 'vitest';
import { armSettingsPanel, ORCHESTRATOR_SETTINGS_NAMESPACE, orchestratorSettingsSchema } from '../src/settings.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher, parseConfigDocument } from '../src/config.js';

interface Registered {
  ns: string;
  schema: unknown;
  options?: { base?: unknown };
}

function makeCtx() {
  const calls: { deps: string[] }[] = [];
  const registered: Registered[] = [];
  let failRegister = false;
  const ctx = {
    inject(deps: string[], cb: (sctx: { settings?: unknown }) => void) {
      calls.push({ deps });
      cb({
        settings: {
          register(ns: string, schema: unknown, options?: { base?: unknown }) {
            if (failRegister) throw new Error('SETTINGS_REJECTED');
            registered.push({ ns, schema, options });
            return { get: () => undefined, watch: () => undefined };
          }
        }
      });
    }
  };
  return { ctx, calls, registered, setFailRegister: () => { failRegister = true; } };
}

describe('armSettingsPanel', () => {
  afterEach(() => {
    setConfigForTest(null);
    resetConfigForTest('unused.yaml');
    disposeWatcher();
  });

  it('does not inject when ui.panel is not opted in', () => {
    setConfigForTest({ enabled: true, endpoints: [{ provider: 'p', model: 'm' }] });
    const { ctx, calls, registered } = makeCtx();

    expect(armSettingsPanel(ctx)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(registered).toHaveLength(0);
  });

  it('does not inject when there is no config at all', () => {
    setConfigForTest(null);
    const { ctx, calls } = makeCtx();

    expect(armSettingsPanel(ctx)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('registers the namespace under the yaml section key when ui.panel is on', () => {
    setConfigForTest({ enabled: true, ui: { panel: true } });
    const { ctx, calls, registered } = makeCtx();

    expect(armSettingsPanel(ctx)).toBe(true);
    expect(calls).toEqual([{ deps: ['settings'] }]);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.ns).toBe(ORCHESTRATOR_SETTINGS_NAMESPACE);
    expect(registered[0]!.ns).toBe('subagents-orchestrator'); // same key our parser reads
  });

  it('swallows a rejected registration instead of failing the plugin', () => {
    setConfigForTest({ ui: { panel: true } });
    const { ctx, registered, setFailRegister } = makeCtx();
    setFailRegister();

    expect(() => armSettingsPanel(ctx)).not.toThrow();
    expect(registered).toHaveLength(0);
  });
});

describe('orchestratorSettingsSchema', () => {
  it('accepts a full section and preserves the panel-managed fields', () => {
    const section = {
      enabled: true,
      strategy: 'weighted',
      failover: true,
      cooldownMs: 45000,
      maxFailures: 5,
      maxRetries: 8,
      intervalMinMs: 250,
      intervalMaxMs: 750,
      debug: false,
      persistTelemetry: true,
      ui: { toasts: true, panel: true }
    };
    const resolved = (orchestratorSettingsSchema as (data: unknown) => unknown)(section);
    expect(resolved).toMatchObject(section);
  });

  it('leaves unmodeled keys (endpoints, fallback) untouched for the yaml path', () => {
    const section = {
      enabled: true,
      endpoints: [{ provider: 'p', model: 'm', weight: 3 }],
      fallback: [{ provider: 'f', model: 'm2' }]
    };
    const resolved = (orchestratorSettingsSchema as (data: unknown) => Record<string, unknown>)(section);
    // schemastery objects merge unknown keys in non-strict mode
    expect(resolved.endpoints).toEqual([{ provider: 'p', model: 'm', weight: 3 }]);
    expect(resolved.fallback).toEqual([{ provider: 'f', model: 'm2' }]);
  });

  it('rejects a wrong-typed panel field instead of coercing it', () => {
    const bad = { enabled: 'yes' };
    expect(() => (orchestratorSettingsSchema as (data: unknown) => unknown)(bad)).toThrow();
  });

  it('validates endpoint lists item-by-item (Tier C list editing)', () => {
    const schema = orchestratorSettingsSchema as (data: unknown) => any;
    const resolved = schema({
      endpoints: [
        { provider: 'p1', model: 'm1', weight: 3, enabled: false },
        { provider: 'p2', model: 'm2' }
      ],
      fallback: [{ provider: 'f1', model: 'm3' }]
    });
    expect(resolved.endpoints).toEqual([
      { provider: 'p1', model: 'm1', weight: 3, enabled: false },
      { provider: 'p2', model: 'm2' }
    ]);
    expect(resolved.fallback).toEqual([{ provider: 'f1', model: 'm3' }]);
  });

  it('a list edit round-trips into a parseable settings.yaml section', () => {
    // Simulate the settings write path end to end: the panel validates via
    // the schema, the file provider serializes YAML, our parser reads it.
    const schema = orchestratorSettingsSchema as (data: unknown) => any;
    const edited = schema({
      enabled: true,
      strategy: 'weighted',
      endpoints: [{ provider: 'p1', model: 'm1', weight: 2 }, { provider: 'p2', model: 'm2', enabled: false }],
      ui: { toasts: false, panel: true }
    });
    // The resolver output must feed parseConfigDocument unchanged.
    const reparsed = parseConfigDocument({ 'subagents-orchestrator': edited });
    expect(reparsed?.endpoints).toEqual(edited.endpoints);
    expect(reparsed?.strategy).toBe('weighted');
    expect(reparsed?.ui).toEqual({ toasts: false, panel: true });
  });

  it('an item missing its required provider fails loudly, not silently', () => {
    const schema = orchestratorSettingsSchema as (data: unknown) => unknown;
    expect(() => schema({ endpoints: [{ model: 'no-provider' }] })).toThrow();
  });
});
