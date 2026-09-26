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
import { getDiagnosticsSnapshot } from '../src/diagnostics.js';
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

// ===========================================================================
// ROUND 2 OF THE HUNT (rounds 11-30).
// ===========================================================================

describe('Round 11: malformed HYDRATION snapshot must not wipe live state', () => {
  it('a hydrated array quarantine map is ignored, not applied as an empty snapshot', () => {
    seedQuarantine();
    expect(isQuarantined()).toBe(true);
    const scope = { get: () => ({ quarantines: [] }), watch: () => () => {} };
    armWithService({ register: () => scope });
    // An array passes a bare typeof === object check but is not a keyed map;
    // handing it to applyQuarantines treats it as authoritative-empty and
    // silently clears every live quarantine.
    expect(isQuarantined()).toBe(true);
  });

  it('a hydrated string / number / boolean quarantine value is ignored', () => {
    for (const bad of ['x', 7, true]) {
      defaultCircuitBreaker.clear();
      seedQuarantine();
      const scope = { get: () => ({ quarantines: bad }), watch: () => () => {} };
      armWithService({ register: () => scope });
      expect(isQuarantined()).toBe(true);
    }
  });
});

describe('Round 12: malformed WATCH payload must not wipe live state', () => {
  it('a payload with quarantines as an ARRAY does not wipe the breaker', () => {
    seedQuarantine();
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    expect(() => watchCbs[0]!({ quarantines: [1, 2] })).not.toThrow();
    expect(isQuarantined()).toBe(true);
  });

  it('a payload with quarantines as an empty ARRAY does not wipe the breaker', () => {
    seedQuarantine();
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({ quarantines: [] });
    expect(isQuarantined()).toBe(true);
  });

  it('a payload with quarantines as a string/number is ignored (no wipe, no throw)', () => {
    for (const bad of ['x', 7]) {
      defaultCircuitBreaker.clear();
      seedQuarantine();
      const { scope, watchCbs } = capturingScope();
      armWithService({ register: () => scope });
      expect(() => watchCbs[0]!({ quarantines: bad })).not.toThrow();
      expect(isQuarantined()).toBe(true);
    }
  });
});

describe('Round 13: armSettingsPanel called TWICE on the same ctx', () => {
  it('registers twice, installs two watches, and the LAST scope wins', () => {
    const regs: string[] = [];
    const scopes: any[] = [];
    const watchCbs: ((next: unknown) => void)[] = [];
    const service = {
      register: (ns: string) => {
        regs.push(ns);
        const scope = { get: () => undefined, watch: (cb: (next: unknown) => void) => { watchCbs.push(cb); } };
        scopes.push(scope);
        return scope;
      }
    };
    setConfigForTest({ ui: { panel: true } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(true);
    expect(armSettingsPanel(h.ctx)).toBe(true);
    h.run(service);
    expect(regs).toEqual([NS, NS]);
    expect(watchCbs).toHaveLength(2);
    expect(scopes).toHaveLength(2);
    // The second registration is the live handle; the first must not remain
    // the one persistence writes through.
    expect(getActiveRegistrationScope()).toBe(scopes[1]);
    // Both watches drive the same singleton breaker, so the effect is idempotent.
    watchCbs[0]!({ quarantines: { 'd::m': Date.now() + 600_000 } });
    watchCbs[1]!({ quarantines: { 'd::m': Date.now() + 600_000 } });
    expect(isQuarantined('d::m')).toBe(true);
  });
});

describe('Round 14: disposeSettings during an in-flight persist', () => {
  it('resolves safely against the already-captured path', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const calls: string[] = [];
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      mutate: async () => {
        calls.push('start');
        await gate;
        calls.push('end');
      }
    });
    const p = persistQuarantines({ [KEY]: 1 });
    disposeSettings();
    release();
    await expect(p).resolves.toBeUndefined();
    expect(calls).toEqual(['start', 'end']);
    expect(getActiveSettingsService()).toBeNull();
  });
});

describe('Round 15: registration ORDER and a schema-rejecting register', () => {
  it('arms in register -> get -> watch order', () => {
    const order: string[] = [];
    const scope = {
      get: () => {
        order.push('get');
        return undefined;
      },
      watch: () => {
        order.push('watch');
      }
    };
    armWithService({
      register: () => {
        order.push('register');
        return scope;
      }
    });
    expect(order).toEqual(['register', 'get', 'watch']);
  });

  it('a register that rejects the stored section installs no watch and no scope', () => {
    let watchCalls = 0;
    const service = {
      register() {
        throw new Error('SCHEMA_REJECTED');
      },
      watch: () => {
        watchCalls += 1;
      }
    };
    expect(() => armWithService(service)).not.toThrow();
    expect(getActiveRegistrationScope()).toBeNull();
    expect(watchCalls).toBe(0);
  });
});

describe('Round 16: mutate rejected-promise vs synchronous throw', () => {
  it('mutate returning a rejected promise is swallowed', async () => {
    const { scope } = capturingScope();
    armWithService({ register: () => scope, mutate: () => Promise.reject(new Error('REJECTED')) });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });

  it('mutate throwing SYNCHRONOUSLY is swallowed', async () => {
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      mutate: () => {
        throw new Error('SYNC_THROW');
      }
    });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
  });
});

describe('Round 17: scope.update present but not a function', () => {
  it('a string scope.update is swallowed and does not cascade to service.update', async () => {
    const order: string[] = [];
    const { scope } = capturingScope({ update: 'not-a-function' });
    armWithService({ register: () => scope, update: async () => void order.push('service.update') });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
    expect(order).toEqual([]);
  });
});

describe('Round 18: concurrent persistQuarantines ordering', () => {
  it('invokes the preferred path in call order', async () => {
    const seen: number[] = [];
    const { scope } = capturingScope();
    armWithService({
      register: () => scope,
      mutate: async (_ns: string, ops: any[]) => {
        seen.push(Object.values(ops[0].value)[0] as number);
      }
    });
    await Promise.all([
      persistQuarantines({ [KEY]: 1 }),
      persistQuarantines({ [KEY]: 2 })
    ]);
    expect(seen).toEqual([1, 2]);
  });
});

describe('Round 19: scope accessor after dispose', () => {
  it('getActiveRegistrationScope is null and persist is a no-op', async () => {
    const calls: string[] = [];
    const { scope } = capturingScope();
    armWithService({ register: () => scope, mutate: async () => void calls.push('mutate') });
    disposeSettings();
    expect(getActiveRegistrationScope()).toBeNull();
    expect(getActiveSettingsService()).toBeNull();
    await persistQuarantines({ [KEY]: 1 });
    expect(calls).toEqual([]);
  });
});

describe('Round 20: non-finite quarantine timestamps', () => {
  const schema = orchestratorSettingsSchema as (data: unknown) => any;

  it('the schema ACCEPTS NaN / Infinity (the yaml parser drops non-finite)', () => {
    const resolved = schema({ quarantines: { a: NaN, b: Infinity } });
    expect(Number.isNaN(resolved.quarantines.a)).toBe(true);
    expect(resolved.quarantines.b).toBe(Infinity);
  });

  it('an Infinity quarantine never recovers (documents the hazard)', () => {
    const scope = { get: () => ({ quarantines: { [KEY]: Infinity } }), watch: () => () => {} };
    armWithService({ register: () => scope });
    expect(isQuarantined()).toBe(true);
    expect(defaultCircuitBreaker.isHealthy({ provider: 'p', model: 'm' }, Date.now() + 10 ** 15)).toBe(false);
  });
});

describe('Round 21: armSettingsPanel does not mutate the passed ctx', () => {
  it('only calls inject and adds no keys', () => {
    const ctx = { inject() {} };
    const keys = Object.keys(ctx);
    setConfigForTest({ ui: { panel: true } } as any);
    armSettingsPanel(ctx);
    expect(Object.keys(ctx)).toEqual(keys);
  });
});

describe('Round 22: a throwing get PROPERTY accessor', () => {
  it('still installs the watch (the fix covers accessor throws, not just call throws)', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const base = { watch: (cb: (next: unknown) => void) => { watchCbs.push(cb); } };
    const scope = Object.defineProperty(base, 'get', {
      get() {
        throw new Error('GETTER_BOOM');
      },
      configurable: true
    });
    expect(() => armWithService({ register: () => scope })).not.toThrow();
    expect(watchCbs).toHaveLength(1);
  });
});

describe('Round 23: a throwing quarantines accessor in the watch payload', () => {
  it('does not escape into the host notification loop', () => {
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    const payload = Object.defineProperty({}, 'quarantines', {
      get() {
        throw new Error('PAYLOAD_BOOM');
      },
      enumerable: true,
      configurable: true
    });
    expect(() => watchCbs[0]!(payload)).not.toThrow();
  });
});

describe('Round 24: non-array endpoint lists and wrong-typed ui', () => {
  const schema = orchestratorSettingsSchema as (data: unknown) => unknown;

  it('rejects non-array endpoints / fallback and wrong-typed ui', () => {
    expect(() => schema({ endpoints: { provider: 'p' } })).toThrow();
    expect(() => schema({ fallback: 'nope' })).toThrow();
    expect(() => schema({ ui: { toasts: 'yes', panel: true } })).toThrow();
    expect(() => schema({ ui: 'nope' })).toThrow();
  });
});

describe('Round 25: a synchronously throwing ctx.inject', () => {
  it('does not break plugin composition (documented Never-throws contract)', () => {
    setConfigForTest({ ui: { panel: true } } as any);
    const ctx = {
      inject() {
        throw new Error('INJECT_BOOM');
      }
    };
    expect(() => armSettingsPanel(ctx)).not.toThrow();
  });
});

describe('Round 26: non-object hydration snapshots', () => {
  it('a null / primitive / array snapshot neither throws nor wipes', () => {
    for (const snap of [null, undefined, 'nope', 7, [], [1, 2]]) {
      defaultCircuitBreaker.clear();
      seedQuarantine();
      const scope = { get: () => snap, watch: () => () => {} };
      expect(() => armWithService({ register: () => scope })).not.toThrow();
      expect(isQuarantined()).toBe(true);
    }
  });
});

describe('Round 27: a rejecting scope.update must not cascade', () => {
  it('does not fall through to service.update', async () => {
    const order: string[] = [];
    const { scope } = capturingScope({
      update: async () => {
        order.push('scope.update');
        throw new Error('SCOPE_FAIL');
      }
    });
    armWithService({ register: () => scope, update: async () => void order.push('service.update') });
    await expect(persistQuarantines({ [KEY]: 1 })).resolves.toBeUndefined();
    expect(order).toEqual(['scope.update']);
  });
});

describe('Round 28: disposeSettings releases the installed watch', () => {
  it('calls the scope watch disposer so a dead registration cannot drive the breaker', () => {
    let stopped = 0;
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = {
      get: () => undefined,
      watch: (cb: (next: unknown) => void) => {
        watchCbs.push(cb);
        return () => {
          stopped += 1;
        };
      }
    };
    armWithService({ register: () => scope });
    expect(watchCbs).toHaveLength(1);
    disposeSettings();
    expect(getActiveRegistrationScope()).toBeNull();
    // The host gave us an unsubscribe; dispose must use it, or the previous
    // composition keeps applying stale quarantines to the singleton breaker.
    expect(stopped).toBe(1);
  });

  it('a re-arm releases the previous watch before installing the new one', () => {
    const stopped: string[] = [];
    const mkScope = (label: string) => ({
      get: () => undefined,
      watch: () => () => {
        stopped.push(label);
      }
    });
    const first = mkScope('first');
    armWithService({ register: () => first });
    armWithService({ register: () => mkScope('second') });
    expect(stopped).toEqual(['first']);
  });

  it('resetSettingsForTest also releases the installed watch', () => {
    let stopped = 0;
    const scope = {
      get: () => undefined,
      watch: () => () => {
        stopped += 1;
      }
    };
    armWithService({ register: () => scope });
    resetSettingsForTest();
    expect(stopped).toBe(1);
  });

  it('a throwing host disposer does not break dispose', () => {
    const scope = {
      get: () => undefined,
      watch: () => () => {
        throw new Error('UNSUBSCRIBE_BOOM');
      }
    };
    armWithService({ register: () => scope });
    expect(() => disposeSettings()).not.toThrow();
    expect(getActiveRegistrationScope()).toBeNull();
  });
});

describe('Round 29: a fresh arm after dispose still installs the watch', () => {
  it('even when its get() throws', () => {
    disposeSettings();
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = {
      get: () => {
        throw new Error('X');
      },
      watch: (cb: (next: unknown) => void) => {
        watchCbs.push(cb);
      }
    };
    armWithService({ register: () => scope });
    expect(watchCbs).toHaveLength(1);
    watchCbs[0]!({ quarantines: { 'fresh::m': Date.now() + 600_000 } });
    expect(isQuarantined('fresh::m')).toBe(true);
  });
});

describe('Round 30: hydrate then watch reset', () => {
  it('an explicit empty map through the watch clears hydrated state', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const scoped = {
      get: () => ({ quarantines: { [KEY]: Date.now() + 600_000 } }),
      watch: (cb: (next: unknown) => void) => {
        watchCbs.push(cb);
      }
    };
    armWithService({ register: () => scoped });
    expect(isQuarantined()).toBe(true);
    watchCbs[0]!({ quarantines: {} });
    expect(isQuarantined()).toBe(false);
  });
});

// ===========================================================================
// ROUND 3 OF THE HUNT (rounds 31-40): the settings <-> diagnostics seam.
// ===========================================================================

describe('Round 31: the quarantine guard must accept ONLY a plain keyed map', () => {
  // The guard exists so a malformed host payload cannot read as
  // "authoritative empty" and silently clear every live quarantine. It must
  // therefore reject every non-plain object, not merely arrays.
  const nonMaps: [string, unknown][] = [
    ['Date', new Date()],
    ['Map', new Map([['p::m', Date.now() + 600_000]])],
    ['Set', new Set(['p::m'])],
    ['Float64Array', new Float64Array([1, 2])],
    ['class instance', new (class Holder { x = 1; })()]
  ];

  for (const [label, bad] of nonMaps) {
    it('a watch payload carrying a ' + label + ' does not wipe live state', () => {
      seedQuarantine();
      expect(isQuarantined()).toBe(true);
      const { scope, watchCbs } = capturingScope();
      armWithService({ register: () => scope });
      expect(() => watchCbs[0]!({ quarantines: bad })).not.toThrow();
      expect(isQuarantined()).toBe(true);
    });
  }

  it('a hydrated non-plain quarantine object does not wipe live state', () => {
    seedQuarantine();
    expect(isQuarantined()).toBe(true);
    const scope = {
      get: () => ({ quarantines: new Map([['p::m', Date.now() + 600_000]]) }),
      watch: () => () => {}
    };
    armWithService({ register: () => scope });
    expect(isQuarantined()).toBe(true);
  });
});

describe('Round 32: a FAILED re-registration must not leave a stale scope', () => {
  it('clears the previous scope so persist cannot write through a dead composition', async () => {
    const calls: string[] = [];
    // First arm installs a working scope.
    const scopeA = {
      get: () => undefined,
      watch: () => () => {},
      update: async () => void calls.push('scopeA.update')
    };
    armWithService({ register: () => scopeA });
    expect(getActiveRegistrationScope()).toBe(scopeA);

    // Second arm: the host now rejects the stored section (register throws).
    const serviceB = {
      register() {
        throw new Error('SCHEMA_REJECTED');
      },
      update: async () => void calls.push('serviceB.update')
    };
    armWithService(serviceB);

    // The new registration failed, so there is no live scope: the previous
    // composition's scope must not survive as the active handle, or persist
    // writes through a registration the host has already replaced.
    expect(getActiveRegistrationScope()).toBeNull();

    await persistQuarantines({ [KEY]: 1 });
    expect(calls).toEqual(['serviceB.update']);
  });

  it('also releases the previous composition\'s watch', () => {
    let stopped = 0;
    const scopeA = {
      get: () => undefined,
      watch: () => () => {
        stopped += 1;
      }
    };
    armWithService({ register: () => scopeA });
    armWithService({
      register() {
        throw new Error('SCHEMA_REJECTED');
      }
    });
    expect(stopped).toBe(1);
    expect(getActiveRegistrationScope()).toBeNull();
  });

  it('the live service handle still follows the newest arm when its registration fails', () => {
    const scopeA = { get: () => undefined, watch: () => () => {} };
    const serviceA = { register: () => scopeA };
    armWithService(serviceA);
    expect(getActiveSettingsService()).toBe(serviceA);

    const serviceB = {
      register() {
        throw new Error('SCHEMA_REJECTED');
      }
    };
    armWithService(serviceB);
    expect(getActiveSettingsService()).toBe(serviceB);
    expect(getActiveRegistrationScope()).toBeNull();
  });
});

describe('Round 33: partial hydration applies only usable entries', () => {
  it('applies numeric timestamps and ignores non-numeric / non-finite ones', () => {
    const future = Date.now() + 600_000;
    const scope = {
      get: () => ({ quarantines: { 'good::m': future, 'bad::m': 'x', 'nan::m': NaN, 'neg::m': -1 } }),
      watch: () => () => {}
    };
    armWithService({ register: () => scope });
    expect(isQuarantined('good::m')).toBe(true);
    expect(isQuarantined('bad::m')).toBe(false);
    expect(isQuarantined('nan::m')).toBe(false);
    expect(isQuarantined('neg::m')).toBe(false);
  });

  it('hydration is an authoritative snapshot: a key absent from it is cleared', () => {
    // applyQuarantines documents itself as "here is the current state", so a
    // hydration snapshot without a previously-live key intentionally clears it.
    // This pins that contract rather than assuming a merge.
    seedQuarantine('keep::m');
    expect(isQuarantined('keep::m')).toBe(true);
    const future = Date.now() + 600_000;
    const scope = {
      get: () => ({ quarantines: { 'new::m': future } }),
      watch: () => () => {}
    };
    armWithService({ register: () => scope });
    expect(isQuarantined('keep::m')).toBe(false);
    expect(isQuarantined('new::m')).toBe(true);
  });
});

describe('Round 34: watch -> breaker -> diagnostics snapshot seam', () => {
  it('reflects a watch-applied quarantine, then clears it on an empty-map reset', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [{ provider: 'p', model: 'm' }] } as any);
    const { scope, watchCbs } = capturingScope();
    const h = lazyCtx();
    armSettingsPanel(h.ctx);
    h.run({ register: () => scope });

    const future = Date.now() + 600_000;
    watchCbs[0]!({ quarantines: { 'p::m': future } });

    const tripped = getDiagnosticsSnapshot(Date.now());
    expect(tripped.endpoints[0]!.breaker.healthy).toBe(false);
    expect(tripped.endpoints[0]!.breaker.trippedUntil).toBe(future);

    watchCbs[0]!({ quarantines: {} });
    const cleared = getDiagnosticsSnapshot(Date.now());
    expect(cleared.endpoints[0]!.breaker.healthy).toBe(true);
    expect(cleared.endpoints[0]!.breaker.trippedUntil).toBeNull();
  });
});

describe('Round 35: reading diagnostics across a dispose-then-rearm window', () => {
  it('stays safe and non-mutating, and the re-armed watch still works', () => {
    setConfigForTest({ enabled: true, ui: { panel: true }, endpoints: [{ provider: 'p', model: 'm' }] } as any);
    const first = capturingScope();
    const h1 = lazyCtx();
    armSettingsPanel(h1.ctx);
    h1.run({ register: () => first.scope });
    first.watchCbs[0]!({ quarantines: { 'p::m': Date.now() + 600_000 } });

    disposeSettings();
    const during = getDiagnosticsSnapshot(Date.now());
    // The breaker's state is not owned by settings: dispose releases handles,
    // it does not reset health.
    expect(during.endpoints[0]!.breaker.healthy).toBe(false);
    expect(defaultCircuitBreaker.getStatus({ provider: 'p', model: 'm' }).trippedUntil).not.toBeNull();

    // Re-arm: a fresh watch is installed and still drives the breaker.
    const second = capturingScope();
    const h2 = lazyCtx();
    armSettingsPanel(h2.ctx);
    h2.run({ register: () => second.scope });
    expect(second.watchCbs).toHaveLength(1);
    second.watchCbs[0]!({ quarantines: {} });
    expect(getDiagnosticsSnapshot(Date.now()).endpoints[0]!.breaker.healthy).toBe(true);
  });
});

describe('Round 36: the guard does not OVER-reject valid maps', () => {
  it('still applies a plain map and a null-prototype map', () => {
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({ quarantines: { 'plain::m': Date.now() + 600_000 } });
    expect(isQuarantined('plain::m')).toBe(true);

    const nullProto = Object.create(null) as Record<string, number>;
    nullProto['np::m'] = Date.now() + 600_000;
    watchCbs[0]!({ quarantines: nullProto });
    expect(isQuarantined('np::m')).toBe(true);
  });

  it('still applies a plain map through the HYDRATION path', () => {
    const future = Date.now() + 600_000;
    const scope = { get: () => ({ quarantines: { 'hyd::m': future } }), watch: () => () => {} };
    armWithService({ register: () => scope });
    expect(isQuarantined('hyd::m')).toBe(true);
  });
});

describe('Round 37: many arm/dispose cycles do not leak a watch', () => {
  it('releases exactly one watch per cycle and leaves no handles', () => {
    let stopped = 0;
    for (let i = 0; i < 25; i++) {
      const scope = {
        get: () => undefined,
        watch: () => () => {
          stopped += 1;
        }
      };
      armWithService({ register: () => scope });
      disposeSettings();
      expect(getActiveRegistrationScope()).toBeNull();
      expect(getActiveSettingsService()).toBeNull();
    }
    expect(stopped).toBe(25);
  });
});

describe('Round 38: a gated-off second arm leaves the first registration live', () => {
  it('registers nothing and does not tear the existing handles down', () => {
    const { scope } = capturingScope();
    armWithService({ register: () => scope });
    const service = getActiveSettingsService();
    expect(getActiveRegistrationScope()).toBe(scope);

    setConfigForTest({ ui: { panel: false } } as any);
    const h = lazyCtx();
    expect(armSettingsPanel(h.ctx)).toBe(false);
    expect(h.deps).toHaveLength(0);

    // The round-1 gating early-return must not clobber the round-2 handles.
    expect(getActiveRegistrationScope()).toBe(scope);
    expect(getActiveSettingsService()).toBe(service);
  });
});

describe('Round 39: the quarantines key check is prototype-inclusive', () => {
  it('applies a quarantine map inherited through the payload prototype', () => {
    const payload = Object.create({ quarantines: { 'proto::m': Date.now() + 600_000 } });
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!(payload);
    expect(isQuarantined('proto::m')).toBe(true);
  });

  it('an unrelated inherited key is not mistaken for quarantines', () => {
    seedQuarantine();
    const payload = Object.create({ other: 1 });
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!(payload);
    expect(isQuarantined()).toBe(true);
  });
});

describe('Round 40: resetSettingsForTest with nothing ever armed', () => {
  it('is safe and leaves both handles null', () => {
    expect(() => resetSettingsForTest()).not.toThrow();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });
});
describe('Round 41: the failed-arm cleanup does not disturb the success path', () => {
  it('a successful re-registration still installs the NEW scope', () => {
    const first = capturingScope();
    armWithService({ register: () => first.scope });
    const second = capturingScope();
    armWithService({ register: () => second.scope });
    // The round-32 catch cleanup must only run on failure.
    expect(getActiveRegistrationScope()).toBe(second.scope);
    expect(getActiveRegistrationScope()).not.toBe(first.scope);
  });

  it('a register returning null (no throw) also clears the stale scope and watch', () => {
    let stopped = 0;
    const first = {
      get: () => undefined,
      watch: () => () => {
        stopped += 1;
      }
    };
    armWithService({ register: () => first });
    expect(getActiveRegistrationScope()).toBe(first);

    armWithService({ register: () => null });
    expect(getActiveRegistrationScope()).toBeNull();
    expect(stopped).toBe(1);
  });

  it('a failed FIRST arm clears the scope but keeps the live service handle', () => {
    resetSettingsForTest();
    const service = {
      register() {
        throw new Error('FIRST_ARM_REJECTED');
      }
    };
    armWithService(service);
    // The host service is live and is adopted before register() runs; only the
    // failed registration's scope is cleared (so persist can still degrade to
    // service.update rather than writing through a dead scope).
    expect(getActiveRegistrationScope()).toBeNull();
    expect(getActiveSettingsService()).toBe(service);
  });
});

describe('Round 42: the plain-map guard accepts a genuinely plain map with edge keys', () => {
  it('applies entries keyed by "::", empty string and numeric-looking strings', () => {
    const future = Date.now() + 600_000;
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!({
      quarantines: { 'a::b::c': future, '': future, '123': future }
    });
    // Read the applied keys straight off the breaker: the isQuarantined()
    // helper splits on '::' and cannot address a key carrying extra separators.
    const applied = defaultCircuitBreaker.getQuarantines(Date.now());
    expect(Object.keys(applied).sort()).toEqual(['', '123', 'a::b::c']);
    expect(applied['a::b::c']).toBe(future);
  });

  it('applies a plain map created by JSON.parse (a real wire payload)', () => {
    const future = Date.now() + 600_000;
    const wire = JSON.parse(JSON.stringify({ quarantines: { 'json::m': future } }));
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });
    watchCbs[0]!(wire);
    expect(isQuarantined('json::m')).toBe(true);
  });
});

// ===========================================================================
// ROUND 3, PART 2 (rounds 43+): guard PRECISION — a guard must not swallow a
// case it was never meant to.
// ===========================================================================

describe('Round 43: a scope whose watch() throws is still a successful registration', () => {
  it('keeps the live scope so persist can still write through scope.update', async () => {
    const calls: string[] = [];
    const scope = {
      get: () => undefined,
      watch: () => {
        throw new Error('WATCH_BOOM');
      },
      update: async () => void calls.push('scope.update')
    };
    // The service exposes NO mutate/update: scope.update is the only path.
    const service = { register: () => scope };

    expect(() => armWithService(service)).not.toThrow();
    // register() succeeded, so the scope is live and usable; only the optional
    // watch failed. Discarding it here loses the sole persistence path.
    expect(getActiveRegistrationScope()).toBe(scope);

    await persistQuarantines({ [KEY]: 1 });
    expect(calls).toEqual(['scope.update']);
  });

  it('the failed-WATCH cleanup must not be mistaken for a failed REGISTRATION', () => {
    // Mirror of the get()-throws case (which keeps the scope): the two must be
    // consistent, since both are post-register, best-effort steps.
    const scope = { get: () => { throw new Error('GET_BOOM'); }, watch: () => { throw new Error('WATCH_BOOM'); } };
    armWithService({ register: () => scope });
    expect(getActiveRegistrationScope()).toBe(scope);
  });
});

describe('Round 44: a registration that fails AFTER the scope was captured', () => {
  it('still clears the previous composition scope (the cleanup stays precise)', () => {
    const stale = { get: () => undefined, watch: () => () => {}, update: async () => {} };
    armWithService({ register: () => stale });
    expect(getActiveRegistrationScope()).toBe(stale);

    // register() itself throws: no new scope exists, so the old handle must go.
    armWithService({ register() { throw new Error('SCHEMA_REJECTED'); } });
    expect(getActiveRegistrationScope()).toBeNull();
  });
});

describe('Round 45: the guard rejects a subclassed object (prototype is not Object.prototype)', () => {
  it('a null-prototype map is accepted but a class instance is not', () => {
    const future = Date.now() + 600_000;
    const { scope, watchCbs } = capturingScope();
    armWithService({ register: () => scope });

    class QuarantineBag {
      bag: Record<string, number> = {};
    }
    watchCbs[0]!({ quarantines: new QuarantineBag() });
    // Class instances have no enumerable own numeric entries; they must not be
    // adopted as an authoritative snapshot.
    expect(defaultCircuitBreaker.getQuarantines(Date.now())).toEqual({});

    watchCbs[0]!({ quarantines: { 'p::m': future } });
    expect(isQuarantined()).toBe(true);
  });
});

describe('Round 46: persist is precise about WHICH handle it reads', () => {
  it('uses the newest service even when an older scope is still armed', async () => {
    const order: string[] = [];
    const oldScope = { get: () => undefined, watch: () => () => {}, update: async () => void order.push('old-scope') };
    armWithService({ register: () => oldScope, update: async () => void order.push('old-service.update') });

    // New composition whose register() throws: the service handle still moves.
    armWithService({
      register() { throw new Error('NOPE'); },
      update: async () => void order.push('new-service.update')
    });

    await persistQuarantines({ [KEY]: 1 });
    expect(order).toEqual(['new-service.update']);
  });
});

describe('Round 47: an arm whose inject callback runs twice (fan-out)', () => {
  it('installs one watch per callback and ends with the last scope live', () => {
    const scopes: any[] = [];
    const stops: number[] = [];
    const service = {
      register: () => {
        const scope = { get: () => undefined, watch: () => () => { stops.push(1); } };
        scopes.push(scope);
        return scope;
      }
    };
    setConfigForTest({ ui: { panel: true } } as any);
    const h = lazyCtx();
    armSettingsPanel(h.ctx);
    // The host fans the same callback out twice (re-composition).
    h.run(service);
    h.run(service);
    expect(scopes).toHaveLength(2);
    expect(stops).toEqual([1]); // the first watch released on the second run
    expect(getActiveRegistrationScope()).toBe(scopes[1]);
  });
});

describe('Round 48: hydration is applied BEFORE the watch is installed', () => {
  it('a watch fired synchronously during watch() still sees the hydrated state', () => {
    const future = Date.now() + 600_000;
    let appliedDuringWatch: boolean | null = null;
    const scope = {
      get: () => ({ quarantines: { 'h::m': future } }),
      watch: (cb: (next: unknown) => void) => {
        // Some hosts deliver an initial snapshot synchronously on subscribe.
        appliedDuringWatch = isQuarantined('h::m');
        cb({ quarantines: { 'h::m': future } });
        return () => {};
      }
    };
    armWithService({ register: () => scope });
    expect(appliedDuringWatch).toBe(true);
    expect(isQuarantined('h::m')).toBe(true);
  });
});

describe('Round 49: the watch disposer is tracked even when watch() returns a Promise', () => {
  it('does not crash dispose and leaves both handles null', () => {
    const scope = { get: () => undefined, watch: () => Promise.resolve(() => {}) as any };
    expect(() => armWithService({ register: () => scope })).not.toThrow();
    expect(() => disposeSettings()).not.toThrow();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });
});

describe('Round 50: a scope whose get is a non-function but truthy', () => {
  it('does not throw and still installs the watch', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = { get: 5 as any, watch: (cb: (next: unknown) => void) => { watchCbs.push(cb); } };
    expect(() => armWithService({ register: () => scope })).not.toThrow();
    expect(watchCbs).toHaveLength(1);
    expect(getActiveRegistrationScope()).toBe(scope);
  });
});

describe('Round 51: reset during an in-flight persist does not corrupt the write', () => {
  it('the captured path completes with the payload it started with', async () => {
    const written: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    armWithService({
      register: () => ({ get: () => undefined, watch: () => () => {} }),
      mutate: async (_ns: string, ops: any[]) => {
        await gate;
        written.push(ops[0].value);
      }
    });
    const payload = { [KEY]: 42 };
    const p = persistQuarantines(payload);
    resetSettingsForTest();
    release();
    await expect(p).resolves.toBeUndefined();
    expect(written).toEqual([payload]);
  });
});

describe('Round 52: re-arm replaces the watch AND the persisted revision source', () => {
  it('writes through the newest scope after a successful re-arm', async () => {
    const order: string[] = [];
    armWithService({ register: () => ({ get: () => undefined, watch: () => () => {}, update: async () => void order.push('A') }) });
    armWithService({ register: () => ({ get: () => undefined, watch: () => () => {}, update: async () => void order.push('B') }) });
    await persistQuarantines({ [KEY]: 1 });
    expect(order).toEqual(['B']);
  });
});

describe('Round 53: the watch install guard does not swallow a working watch', () => {
  it('still installs a normal watch after the try was narrowed', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = { get: () => undefined, watch: (cb: (next: unknown) => void) => { watchCbs.push(cb); return () => {}; } };
    armWithService({ register: () => scope });
    expect(watchCbs).toHaveLength(1);
    watchCbs[0]!({ quarantines: { 'w::m': Date.now() + 600_000 } });
    expect(isQuarantined('w::m')).toBe(true);
  });

  it('still records the disposer returned by a working watch', () => {
    let stopped = 0;
    armWithService({ register: () => ({ get: () => undefined, watch: () => () => { stopped += 1; } }) });
    disposeSettings();
    expect(stopped).toBe(1);
  });
});

describe('Round 54: hydration failure and watch failure are independent', () => {
  it('a throwing get does not prevent a working watch (and vice versa)', () => {
    const watchCbs: ((next: unknown) => void)[] = [];
    const scope = {
      get: () => { throw new Error('GET_BOOM'); },
      watch: (cb: (next: unknown) => void) => { watchCbs.push(cb); return () => {}; }
    };
    armWithService({ register: () => scope });
    expect(watchCbs).toHaveLength(1);

    // And the other direction: a throwing watch still leaves the scope live.
    const scope2 = { get: () => ({ quarantines: { 'g::m': Date.now() + 600_000 } }), watch: () => { throw new Error('WATCH_BOOM'); } };
    armWithService({ register: () => scope2 });
    expect(isQuarantined('g::m')).toBe(true);
    expect(getActiveRegistrationScope()).toBe(scope2);
  });
});

describe('Round 55: dispose during the inject callback (re-entrant lifecycle)', () => {
  it('does not throw and the post-dispose handles stay null', () => {
    setConfigForTest({ ui: { panel: true } } as any);
    const ctx = {
      inject(_d: string[], cb: (sctx: unknown) => void) {
        cb({ settings: { register: () => ({ get: () => undefined, watch: () => () => {} }) } });
        // A host that disposes synchronously inside the inject fan-out.
        disposeSettings();
      }
    };
    expect(() => armSettingsPanel(ctx)).not.toThrow();
    expect(getActiveSettingsService()).toBeNull();
    expect(getActiveRegistrationScope()).toBeNull();
  });
});
