/**
 * Adversarial, test-first probes for src/settings.ts.
 *
 * Round-by-round hunt over the settings-panel seam: gating, registration
 * degradation, persist fallback ordering, failure swallowing, the scope watch,
 * the registered schema, dispose/rebind, module state and hydration.
 *
 * Complements tests/settings.test.ts + tests/settings-integration.test.ts
 * (which cover the happy path); nothing here duplicates those.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armSettingsPanel,
  persistQuarantines,
  disposeSettings,
  resetSettingsForTest,
  getActiveSettingsService,
  getActiveRegistrationScope,
  ORCHESTRATOR_SETTINGS_NAMESPACE,
  orchestratorSettingsSchema,
  endpointSettingsSchema,
  type SettingsPanelContext
} from '../src/settings.js';
import { setConfigForTest, resetConfigForTest, disposeWatcher } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { apply } from '../src/index.js';
import { MockCordisContext } from './mocks/cordis.js';

const NS = ORCHESTRATOR_SETTINGS_NAMESPACE;
const KEY = 'p::m';

/** Context that records inject() calls but fans out only when told to. */
function lazyCtx() {
  const deps: string[][] = [];
  const cbs: ((sctx: unknown) => void)[] = [];
  const ctx: SettingsPanelContext = {
    inject(d, cb) {
      deps.push(d);
      cbs.push(cb);
    }
  };
  return {
    ctx,
    deps,
    run(settings: unknown) {
      for (const cb of cbs) cb({ settings });
    }
  };
}

function armWithService(settings: unknown) {
  setConfigForTest({ ui: { panel: true } } as any);
  const h = lazyCtx();
  const armed = armSettingsPanel(h.ctx);
  h.run(settings);
  return { armed, ...h };
}

/** Scope that captures its watch callback; get() returns undefined by default. */
function capturingScope(extra: Record<string, unknown> = {}) {
  const watchCbs: ((next: unknown) => void)[] = [];
  const scope = {
    get: () => undefined,
    watch: (cb: (next: unknown) => void) => {
      watchCbs.push(cb);
      return () => {};
    },
    ...extra
  };
  return { scope, watchCbs };
}

function seedQuarantine(key = KEY, ttlMs = 600_000): void {
  defaultCircuitBreaker.applyQuarantines({ [key]: Date.now() + ttlMs });
}

function isQuarantined(key = KEY): boolean {
  const parts = key.split('::');
  return !defaultCircuitBreaker.isHealthy({ provider: parts[0]!, model: parts[1]! });
}

beforeEach(() => {
  resetSettingsForTest();
  defaultCircuitBreaker.clear();
});

afterEach(() => {
  resetSettingsForTest();
  defaultCircuitBreaker.clear();
  setConfigForTest(null);
  resetConfigForTest('unused.yaml');
  disposeWatcher();
});

// ---------------------------------------------------------------------------

describe('Round 1: armSettingsPanel gating on ui.panel', () => {
  it('undefined panel: returns false and registers nothing', () => {
    setConfigForTest({ enabled: true } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);
  });

  it('false panel: returns false and registers nothing', () => {
    setConfigForTest({ ui: { panel: false } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);
  });

  it('ui present without panel: returns false and registers nothing', () => {
    setConfigForTest({ ui: { toasts: true } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);
  });

  it('wrongly-typed panel (1) is not treated as opted in', () => {
    setConfigForTest({ ui: { panel: 1 } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);
  });

  it('wrongly-typed panel ("true") is not treated as opted in', () => {
    setConfigForTest({ ui: { panel: 'true' } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);
  });

  it('panel === true injects [settings] and registers the yaml section key', () => {
    const { scope } = capturingScope();
    const registerCalls: { ns: string; options?: unknown }[] = [];
    const service = {
      register(ns: string, _schema: unknown, options?: unknown) {
        registerCalls.push({ ns, options });
        return scope;
      }
    };
    const { armed, deps } = armWithService(service);
    expect(armed).toBe(true);
    expect(deps).toEqual([['settings']]);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]!.ns).toBe(NS);
    expect(registerCalls[0]!.options).toEqual({ base: {} });
  });
});

// ---------------------------------------------------------------------------

describe('Round 2: registration shapes never throw out of arm()', () => {
  it('register() throwing leaves no scope and does not throw', () => {
    const service = {
      register() {
        throw new Error('SETTINGS_REJECTED');
      }
    };
    expect(() => armWithService(service)).not.toThrow();
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('register() returning null does not throw', () => {
    const service = { register: () => null };
    expect(() => armWithService(service)).not.toThrow();
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('register() returning a primitive does not throw', () => {
    const service = { register: () => 42 };
    expect(() => armWithService(service)).not.toThrow();
  });

  it('register() returning an object with no get/watch does not throw', () => {
    const service = { register: () => ({}) };
    expect(() => armWithService(service)).not.toThrow();
  });

  it('register() returning non-function get/watch does not throw', () => {
    const service = { register: () => ({ get: 5, watch: 'nope' }) };
    expect(() => armWithService(service)).not.toThrow();
  });

  it('a degraded registration still lets persist resolve undefined', async () => {
    const service = { register: () => null, update: async () => 'ok' };
    armWithService(service);
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('Round 3: persistQuarantines fallback order', () => {
  it('prefers service.mutate() and calls no other path', async () => {
    const order: string[] = [];
    const { scope } = capturingScope({ update: async () => void order.push('scope.update') });
    const service = {
      register: () => scope,
      mutate: async () => void order.push('mutate'),
      update: async () => void order.push('service.update')
    };
    armWithService(service);
    await persistQuarantines({ [KEY]: 1 });
    expect(order).toEqual(['mutate']);
  });

  it('falls back to scope.update() when mutate is absent', async () => {
    const order: string[] = [];
    const { scope } = capturingScope({ update: async () => void order.push('scope.update') });
    const service = {
      register: () => scope,
      update: async () => void order.push('service.update')
    };
    armWithService(service);
    await persistQuarantines({ [KEY]: 1 });
    expect(order).toEqual(['scope.update']);
  });

  it('falls back to service.update() when mutate and scope.update are absent', async () => {
    const order: string[] = [];
    const { scope } = capturingScope();
    const service = {
      register: () => scope,
      update: async () => void order.push('service.update')
    };
    armWithService(service);
    await persistQuarantines({ [KEY]: 1 });
    expect(order).toEqual(['service.update']);
  });

  it('scope.update receives the quarantine patch verbatim', async () => {
    const patches: unknown[] = [];
    const { scope } = capturingScope({ update: async (p: unknown) => void patches.push(p) });
    armWithService({ register: () => scope });
    const q = { [KEY]: 123 };
    await persistQuarantines(q);
    expect(patches).toEqual([{ quarantines: q }]);
  });

  it('service.update receives namespace + quarantine patch', async () => {
    const calls: unknown[][] = [];
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      update: async (...a: unknown[]) => void calls.push(a)
    });
    const q = { [KEY]: 123 };
    await persistQuarantines(q);
    expect(calls).toEqual([[NS, { quarantines: q }]]);
  });

  it('service.mutate receives namespace + a set op on quarantines', async () => {
    const calls: unknown[][] = [];
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      mutate: async (...a: unknown[]) => void calls.push(a)
    });
    const q = { [KEY]: 123 };
    await persistQuarantines(q);
    expect(calls).toEqual([[NS, [{ op: 'set', path: ['quarantines'], value: q }]]]);
  });
});

// ---------------------------------------------------------------------------

describe('Round 4: every persistence failure is swallowed', () => {
  it('mutate() rejecting resolves undefined', async () => {
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      mutate: async () => {
        throw new Error('MUTATE_FAIL');
      }
    });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('scope.update() rejecting resolves undefined', async () => {
    const { scope } = capturingScope({
      update: async () => {
        throw new Error('SCOPE_UPDATE_FAIL');
      }
    });
    armWithService({ register: () => scope });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('service.update() rejecting resolves undefined', async () => {
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      update: async () => {
        throw new Error('SERVICE_UPDATE_FAIL');
      }
    });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('no service and no scope armed resolves undefined', async () => {
    resetSettingsForTest();
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('a non-function mutate is swallowed rather than thrown', async () => {
    const { scope } = capturingScope({ update: async () => 'never-reached' });
    armWithService({ register: () => scope, mutate: 5 });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('a rejecting mutate does NOT cascade into a second persist path', async () => {
    const order: string[] = [];
    const { scope } = capturingScope({ update: async () => void order.push('scope.update') });
    armWithService({
      register: () => scope,
      mutate: async () => {
        order.push('mutate');
        throw new Error('MUTATE_FAIL');
      },
      update: async () => void order.push('service.update')
    });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
    // One persist attempt per call: the preferred path failing is swallowed,
    // it must not fall through and double-write the same state.
    expect(order).toEqual(['mutate']);
  });
});

// ---------------------------------------------------------------------------

describe('Round 5: watch payload WITHOUT a quarantines key must not clear state', () => {
  it('an unrelated section edit (no quarantines key) does not wipe the breaker', () => {
    seedQuarantine();
    expect(isQuarantined()).toBe(true);
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    expect(watchCbs).toHaveLength(1);
    watchCbs[0]!({ enabled: false, strategy: 'weighted' });
    expect(isQuarantined()).toBe(true);
  });

  it('a payload with an empty object does not wipe the breaker', () => {
    seedQuarantine();
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({});
    expect(isQuarantined()).toBe(true);
  });

  it('a payload that DOES carry quarantines is applied', () => {
    const future = Date.now() + 600_000;
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({ quarantines: { 'q::x': future } });
    expect(isQuarantined('q::x')).toBe(true);
  });

  it('a payload carrying an empty quarantine map clears state (explicit reset)', () => {
    seedQuarantine();
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({ quarantines: {} });
    expect(isQuarantined()).toBe(false);
  });
});

describe('Round 5b: the watch hazard through the REAL apply() seam', () => {
  /** Arm through the real plugin entry so the real watch closure is installed. */
  function armThroughApply(getValue: unknown = undefined) {
    const watchCbs: ((next: unknown) => void)[] = [];
    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({
        get: () => getValue,
        watch: (cb: (next: unknown) => void) => {
          watchCbs.push(cb);
        }
      })
    };
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [{ provider: 'p', model: 'm' }] } as any);
    apply(ctx);
    return { watchCbs, ctx };
  }

  it('an unrelated section edit through the real watch does not wipe the breaker', () => {
    seedQuarantine();
    expect(isQuarantined()).toBe(true);
    const { watchCbs } = armThroughApply();
    expect(watchCbs).toHaveLength(1);
    watchCbs[0]!({ endpoints: [{ provider: 'x', model: 'y' }], strategy: 'round-robin' });
    expect(isQuarantined()).toBe(true);
  });

  it('a real watch payload carrying quarantines is applied', () => {
    const { watchCbs } = armThroughApply();
    watchCbs[0]!({ quarantines: { 'r::m': Date.now() + 600_000 } });
    expect(isQuarantined('r::m')).toBe(true);
  });

  it('a real registration whose get() throws still installs a live watch', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const ctx = new MockCordisContext();
    ctx.settings = {
      register: () => ({
        get: () => {
          throw new Error('HYDRATE_FAIL');
        },
        watch: (cb: (next: unknown) => void) => {
          watchCbs.push(cb);
        }
      })
    };
    setConfigForTest({ enabled: true, ui: { panel: true } } as any);
    expect(() => apply(ctx)).not.toThrow();
    expect(watchCbs).toHaveLength(1);
    watchCbs[0]!({ quarantines: { 'z::m': Date.now() + 600_000 } });
    expect(isQuarantined('z::m')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Round 6: non-object / null watch payloads are safe', () => {
  const payloads: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'quarantines'],
    ['a number', 7],
    ['a boolean', true],
    ['an array', []]
  ];

  for (const [label, payload] of payloads) {
    it('watch payload ' + label + ' neither throws nor wipes state', () => {
      seedQuarantine();
      const { scope, watchCbs } = capturingScope();
      armWithService({ register: () => scope });
      expect(() => watchCbs[0]!(payload)).not.toThrow();
      expect(isQuarantined()).toBe(true);
    });
  }

  it('{ quarantines: null } clears state (key present, falsy value)', () => {
    seedQuarantine();
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    expect(() => watchCbs[0]!({ quarantines: null })).not.toThrow();
    expect(isQuarantined()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('Round 7: registered schema contract', () => {
  const schema = orchestratorSettingsSchema as (data: unknown) => any;

  it('valid data resolves', () => {
    const resolved = schema({
      enabled: true,
      strategy: 'weighted',
      failover: true,
      cooldownMs: 45_000,
      maxFailures: 5,
      maxRetries: 8,
      intervalMinMs: 250,
      intervalMaxMs: 750,
      debug: false,
      persistTelemetry: true,
      ui: { toasts: true, panel: true },
      alignHourly: true,
      quarantines: { [KEY]: 123 }
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.quarantines).toEqual({ [KEY]: 123 });
    expect(resolved.ui).toEqual({ toasts: true, panel: true });
  });

  it('unknown keys survive validation (non-strict)', () => {
    const resolved = schema({ enabled: true, aBrandNewKey: 42, nested: { x: 1 } });
    expect(resolved.aBrandNewKey).toBe(42);
    expect(resolved.nested).toEqual({ x: 1 });
  });

  it('a wrong-typed scalar is rejected, not coerced', () => {
    expect(() => schema({ enabled: true, cooldownMs: '45000' })).toThrow();
  });

  it('a wrong-typed boolean is rejected, not coerced', () => {
    expect(() => schema({ enabled: 'true' })).toThrow();
  });

  it('a wrong-typed quarantines map value is rejected', () => {
    expect(() => schema({ quarantines: { [KEY]: 'not-a-number' } })).toThrow();
  });

  it('a bad endpoint array item throws (documented as drop, actual contract)', () => {
    expect(() => schema({ endpoints: [{ provider: 'p', model: 'm' }, { model: 'no-provider' }] })).toThrow();
  });

  it('endpointSettingsSchema rejects a missing required provider', () => {
    const es = endpointSettingsSchema as (d: unknown) => unknown;
    expect(() => es({ model: 'm' })).toThrow();
  });

  it('endpointSettingsSchema preserves unknown keys on an entry', () => {
    const es = endpointSettingsSchema as (d: unknown) => any;
    const resolved = es({ provider: 'p', model: 'm', extraField: 'kept' });
    expect(resolved.extraField).toBe('kept');
  });

  it('endpointSettingsSchema rejects a wrong-typed weight', () => {
    const es = endpointSettingsSchema as (d: unknown) => unknown;
    expect(() => es({ provider: 'p', model: 'm', weight: '3' })).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('Round 8: disposeSettings clears both refs, is idempotent, rebinds', () => {
  it('clears both module-level refs', () => {
    const { scope } = capturingScope();
    const service = { register: () => scope };
    armWithService(service);
    expect(getActiveSettingsService()).toBe(service);
    expect(getActiveRegistrationScope()).toBe(scope);

    disposeSettings();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('is idempotent', () => {
    const { scope } = capturingScope();
    armWithService({ register: () => scope });
    disposeSettings();
    expect(() => disposeSettings()).not.toThrow();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('a later armSettingsPanel rebinds to the fresh service and scope', () => {
    const first = capturingScope();
    armWithService({ register: () => first.scope });
    disposeSettings();

    const second = capturingScope();
    const fresh = { register: () => second.scope };
    armWithService(fresh);

    expect(getActiveSettingsService()).toBe(fresh);
    expect(getActiveRegistrationScope()).toBe(second.scope);
    expect(getActiveRegistrationScope()).not.toBe(first.scope);
  });
});

// ---------------------------------------------------------------------------

describe('Round 9: module state isolation via resetSettingsForTest', () => {
  it('resetSettingsForTest clears both refs', () => {
    const { scope } = capturingScope();
    armWithService({ register: () => scope });
    resetSettingsForTest();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('does not leak a previous instance service into a fresh arm', () => {
    const a = capturingScope();
    armWithService({ register: () => a.scope });
    resetSettingsForTest();

    const b = capturingScope();
    const serviceB = { register: () => b.scope };
    armWithService(serviceB);

    expect(getActiveSettingsService()).toBe(serviceB);
    expect(getActiveRegistrationScope()).toBe(b.scope);
  });

  it('headless arm (inject never fires) leaves prior refs untouched', () => {
    const { scope } = capturingScope();
    const service = { register: () => scope };
    armWithService(service);
    // A second arm in a headless host: inject() is never called back.
    setConfigForTest({ ui: { panel: true } } as any);
    const headless = lazyCtx();
    expect(armSettingsPanel(headless.ctx)).toBe(true);
    expect(getActiveSettingsService()).toBe(service);
  });
});

// ---------------------------------------------------------------------------

describe('Round 10: hydration reads get() once and survives a throwing get()', () => {
  it('reads scope.get() exactly once on registration', () => {
    let reads = 0;
    const scope = {
      get: () => {
        reads += 1;
        return undefined;
      },
      watch: () => () => {}
    };
    armWithService({ register: () => scope });
    expect(reads).toBe(1);
  });

  it('applies a hydrated quarantine map at registration', () => {
    const future = Date.now() + 600_000;
    const scope = { get: () => ({ quarantines: { 'h::m': future } }), watch: () => () => {} };
    armWithService({ register: () => scope });
    expect(isQuarantined('h::m')).toBe(true);
  });

  it('ignores a hydrated snapshot without a quarantines object', () => {
    const scope = { get: () => ({ enabled: true }), watch: () => () => {} };
    expect(() => armWithService({ register: () => scope })).not.toThrow();
    expect(isQuarantined()).toBe(false);
  });

  it('a throwing get() does not break registration and still installs the watch', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = {
      get: () => {
        throw new Error('HYDRATE_FAIL');
      },
      watch: (cb: (next: unknown) => void) => {
        watchCbs.push(cb);
        return () => {};
      }
    };
    expect(() => armWithService({ register: () => scope })).not.toThrow();
    expect(getActiveRegistrationScope()).toBe(scope);
    // The live watch is the whole point of the panel: one bad get() must not
    // silently disable UI -> breaker propagation for the session.
    expect(watchCbs).toHaveLength(1);
  });
});
