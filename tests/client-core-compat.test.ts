import { describe, it, expect } from 'vitest';
import { resolveSettingsScope, bindSnapshotSelector } from '../src/client/index.js';

/**
 * Cross-core settings-service compatibility.
 *
 * Core <= 0.1.x exposed `settingsScope.bind({ namespace })`; core 0.1.7-rc.1
 * removed it in favour of `configForms.get(namespace)`. Declaring either name
 * in `inject` leaves the plugin fiber PENDING on the other core, which surfaces
 * as "client-modules: <id> is waiting for activation" and the panel never
 * mounts. These tests pin the resolution order and the inert fallback.
 */
describe('resolveSettingsScope: cross-core compatibility', () => {
  const NS = 'subagents-orchestrator';
  const form = { getSnapshot: () => ({ ok: 1 }), subscribe: () => () => {}, set: async () => {} };
  const legacy = { bind: () => form };

  it('prefers configForms (new core) and looks up by namespace, not package id', () => {
    const seen: string[] = [];
    const ctx = { configForms: { get: (n: string) => { seen.push(n); return form; } } };
    const scope = resolveSettingsScope(ctx, NS);
    expect(scope).toBe(form);
    expect(seen).toEqual([NS]);
  });

  it('falls back to settingsScope.bind when configForms is absent (old core)', () => {
    const bound: unknown[] = [];
    const ctx = { settingsScope: { bind: (spec: unknown) => { bound.push(spec); return form; } } };
    const scope = resolveSettingsScope(ctx, NS);
    expect(scope).toBe(form);
    expect(bound).toEqual([{ namespace: NS }]);
  });

  it('prefers the new service when BOTH exist', () => {
    const legacyForm = { getSnapshot: () => ({ old: true }) };
    const ctx = { configForms: { get: () => form }, settingsScope: { bind: () => legacyForm } };
    expect(resolveSettingsScope(ctx, NS)).toBe(form);
  });

  it('an inert scope is returned when neither service exists (never throws)', () => {
    for (const ctx of [undefined, null, {}, { configForms: {} }, { settingsScope: {} }]) {
      const scope = resolveSettingsScope(ctx, NS);
      expect(typeof scope.subscribe).toBe('function');
      expect(typeof scope.getSnapshot).toBe('function');
      expect(typeof scope.set).toBe('function');
      // Inert: no snapshot, no-op writes, unsubscribe is callable.
      expect(scope.getSnapshot()).toBeUndefined();
      expect(() => scope.subscribe(() => {})()).not.toThrow();
    }
  });

  it('a THROWING configForms.get degrades to the legacy seat, not a crash', () => {
    const ctx = {
      configForms: { get: () => { throw new Error('not served'); } },
      settingsScope: { bind: () => form }
    };
    expect(resolveSettingsScope(ctx, NS)).toBe(form);
  });

  it('a configForms.get returning a shapeless object degrades to the legacy seat', () => {
    const ctx = {
      configForms: { get: () => ({ notAForm: true }) },
      settingsScope: { bind: () => form }
    };
    expect(resolveSettingsScope(ctx, NS)).toBe(form);
  });

  it('PRECISION: a VALID configForms form is used even when settingsScope also exists', () => {
    // Guards the guard: the degrade paths must not swallow the happy path.
    const ctx = { configForms: { get: () => form }, settingsScope: { bind: () => ({ bad: 1 }) } };
    const scope = resolveSettingsScope(ctx, NS);
    expect(scope.getSnapshot()).toEqual({ ok: 1 });
  });

  it('bound selector reads through whichever scope was resolved', () => {
    const ctx = { settingsScope: { bind: () => legacy } };
    const useSel = bindSnapshotSelector(resolveSettingsScope(ctx, NS));
    expect(typeof useSel).toBe('function');
  });
});

/** The fiber-guard contract: `inject` must not name a possibly-absent service. */
describe('client inject declaration is core-agnostic', () => {
  it('does NOT require settingsScope or configForms (either would hang one core)', async () => {
    const mod: any = await import('../src/client/index.js');
    expect(Array.isArray(mod.inject)).toBe(true);
    expect(mod.inject).toContain('slots');
    expect(mod.inject).not.toContain('settingsScope');
    expect(mod.inject).not.toContain('configForms');
  });
});
