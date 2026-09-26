import { describe, it, expect } from 'vitest';
import {
  projectConfig,
  planConfigWrites,
  isConfigDirty,
  endpointQuarantineUntil,
  isEndpointTripped,
  quarantinesAfterReset,
  toggleEndpointAt,
  removeEndpointAt,
  buildEndpointRow,
  mergeSnapshotIntoDraft,
  formatTrippingDuration
} from '../src/client/index.jsx';
import type { ClientConfig, EndpointRow } from '../src/client/index.jsx';

/**
 * Adversarial, test-first bug hunt over the settings-panel logic in
 * src/client/index.tsx. The component cannot be rendered under this suite's
 * Node environment (no react-dom / jsdom / @testing-library), so the file's
 * pure decision logic was extracted verbatim into exported helpers that the
 * component now calls. These tests exercise those helpers.
 */

const DEFAULTS: ClientConfig = {
  enabled: true,
  strategy: 'round-robin',
  failover: true,
  mode: 'pool',
  endpoints: [],
  fallback: [],
  cooldownMs: 3600000,
  maxFailures: 3,
  intervalMinMs: 3000,
  intervalMaxMs: 5000,
  alignHourly: true,
  quarantines: {},
  debug: false,
  persistTelemetry: false
};

const ep = (provider: string, model: string, extra: Partial<EndpointRow> = {}): EndpointRow =>
  ({ provider, model, ...extra });

describe('Round 1: projectConfig input projection', () => {
  it('returns the documented defaults for null/undefined/primitives', () => {
    for (const v of [null, undefined, 0, '', false, 'str', 42, NaN]) {
      expect(projectConfig(v)).toEqual(DEFAULTS);
    }
  });

  it('fills per-field defaults for a partial object', () => {
    expect(projectConfig({ enabled: false })).toEqual({ ...DEFAULTS, enabled: false });
  });

  it('ignores wrongly-typed booleans', () => {
    expect(projectConfig({ enabled: 'yes', failover: 1, alignHourly: 'true', debug: 0, persistTelemetry: 'x' }))
      .toEqual(DEFAULTS);
  });

  it('treats null numeric fields as absent (the reachable form of a non-finite number)', () => {
    // The host settings schema decodes NaN/Infinity to null before the client
    // ever sees the section (verified against @deepseek-ai/schemastery), so
    // null - not NaN - is the shape a non-finite stored value arrives as.
    expect(projectConfig({ cooldownMs: null, maxFailures: null }).cooldownMs).toBe(3600000);
    expect(projectConfig({ intervalMinMs: null, intervalMaxMs: null }).intervalMinMs).toBe(3000);
  });
});

describe('Round 2: projectConfig container typing', () => {
  it('defaults non-array endpoints/fallback to empty arrays', () => {
    expect(projectConfig({ endpoints: 'nope' as any, fallback: 42 as any }).endpoints).toEqual([]);
    expect(projectConfig({ endpoints: null, fallback: {} }).fallback).toEqual([]);
  });

  it('defaults a null/undefined quarantines map to an empty object', () => {
    expect(projectConfig({ quarantines: null }).quarantines).toEqual({});
    expect(projectConfig({}).quarantines).toEqual({});
  });

  it('passes an array of endpoints through verbatim (the host schema is the guard)', () => {
    const junk = [ep('a', 'm')];
    expect(projectConfig({ endpoints: junk }).endpoints).toEqual(junk);
  });

  it('treats a null quarantine timestamp as not-tripped', () => {
    expect(isEndpointTripped(ep('p', 'm'), { 'p::m': null as any }, {}, 100)).toBe(false);
  });
});

describe('Round 3: projectConfig must not alias the module DEFAULTS', () => {
  it('hands out independent quarantines/endpoints containers', () => {
    const a = projectConfig(null);
    a.quarantines!['x::y'] = 123;
    a.endpoints!.push(ep('p', 'm'));
    expect(projectConfig(null).quarantines).toEqual({});
    expect(projectConfig(null).endpoints).toEqual([]);

    const b = projectConfig({});
    b.quarantines!['z::w'] = 9;
    expect(projectConfig({}).quarantines).toEqual({});
  });
});

describe('Round 4: dirty computation', () => {
  it('is false for two independent projections of the same raw object', () => {
    const raw = { debug: true, enabled: false };
    expect(isConfigDirty(projectConfig(raw), projectConfig(raw))).toBe(false);
  });

  it('LATENT (documented, not reachable from the panel): differing key order reads as dirty', () => {
    // Both sides always come from projectConfig (fixed key order), so this is
    // unreachable; recorded so a future refactor knows the comparison is
    // order-sensitive.
    expect(isConfigDirty({ enabled: true, debug: false } as any, { debug: false, enabled: true } as any)).toBe(true);
  });
});

describe('Round 5: save() must not clobber the host-owned quarantines field', () => {
  it('does not write quarantines from a draft the sync effect never hydrated', () => {
    const current = projectConfig({ quarantines: { 'a::m': 9999999999999 } });
    const draft: ClientConfig = { ...current, quarantines: {} };
    const keys = planConfigWrites(draft, current).map(([k]) => k);
    expect(keys).not.toContain('quarantines');
  });

  it('does not report the panel dirty solely because quarantines differ', () => {
    const current = projectConfig({ quarantines: { 'a::m': 1 } });
    expect(isConfigDirty({ ...current, quarantines: {} }, current)).toBe(false);
  });
});

describe('Round 6: endpoint row operations', () => {
  it('toggle flips enabled and treats undefined as enabled', () => {
    expect(toggleEndpointAt([ep('p', 'm')], 0)[0].enabled).toBe(false);
    expect(toggleEndpointAt([ep('p', 'm', { enabled: false })], 0)[0].enabled).toBe(true);
  });

  it('toggle on an out-of-range index is a no-op and does not mutate the input', () => {
    const eps = [ep('p', 'm')];
    expect(toggleEndpointAt(eps, 5)).toEqual(eps);
    expect(eps[0].enabled).toBeUndefined();
  });

  it('remove drops exactly the indexed row; out-of-range is unchanged', () => {
    const eps = [ep('a', 'm'), ep('b', 'm'), ep('c', 'm')];
    expect(removeEndpointAt(eps, 1).map((e) => e.provider)).toEqual(['a', 'c']);
    expect(removeEndpointAt(eps, 9)).toEqual(eps);
  });

  it('buildEndpointRow trims, omits blank effort, and coerces weight', () => {
    expect(buildEndpointRow(' p ', ' m ', '', 0)).toEqual({ provider: 'p', model: 'm', weight: 1, enabled: true });
    expect(buildEndpointRow('p', 'm', 'med', 0)).toMatchObject({ reasoningEffort: 'med', weight: 1 });
    expect(buildEndpointRow('   ', 'm', '', 1)).toBeNull();
    expect(buildEndpointRow('p', '  ', '', 1)).toBeNull();
  });

  it('clamps a negative/zero weight to the UI-declared minimum of 1', () => {
    expect(buildEndpointRow('p', 'm', '', -5)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', 2.5)!.weight).toBe(2.5);
  });
});

describe('Round 7: resetting one endpoint must not clear other endpoints', () => {
  it('preserves other endpoints when the draft map was never hydrated', () => {
    const draft = {};
    const current = { 'b::m': 1e15, 'c::m': 2e15 };
    const next = quarantinesAfterReset(draft, current, 'a', 'm');
    expect(Object.keys(next).sort()).toEqual(['b::m', 'c::m']);
  });

  it('removes every key shape of the reset target', () => {
    const current = { 'a::m': 1, 'a:m': 2, a: 3, 'b::m': 4 };
    const next = quarantinesAfterReset({}, current, 'a', 'm');
    expect(Object.keys(next)).toEqual(['b::m']);
  });
});

describe('Round 8: endpoint quarantine lookup order', () => {
  it('prefers the runtime key shape provider::model', () => {
    expect(endpointQuarantineUntil(ep('p', 'm'), { 'p::m': 5, 'p:m': 6, p: 7 }, {})).toBe(5);
  });

  it('falls back to single-colon then bare provider', () => {
    expect(endpointQuarantineUntil(ep('p', 'm'), { 'p:m': 6, p: 7 }, {})).toBe(6);
    expect(endpointQuarantineUntil(ep('p', 'm'), { p: 7 }, {})).toBe(7);
  });

  it('draft wins over current; current fills a key the draft lacks', () => {
    expect(endpointQuarantineUntil(ep('p', 'm'), { 'p::m': 5 }, { 'p::m': 9 })).toBe(5);
    expect(endpointQuarantineUntil(ep('p', 'm'), {}, { 'p::m': 9 })).toBe(9);
  });

  it('a bare-provider current entry applies to every model of that provider (by design)', () => {
    expect(isEndpointTripped(ep('p', 'other'), {}, { p: 9 }, 0)).toBe(true);
  });

  it('a non-numeric entry is not a trip', () => {
    expect(isEndpointTripped(ep('p', 'm'), { 'p::m': 'soon' as any }, {}, 0)).toBe(false);
  });
});

describe('Round 9: cooldown boundary and duration formatting', () => {
  it('is tripped strictly before expiry and healthy at/after it', () => {
    const q = { 'p::m': 1000 };
    expect(isEndpointTripped(ep('p', 'm'), q, {}, 999)).toBe(true);
    expect(isEndpointTripped(ep('p', 'm'), q, {}, 1000)).toBe(false);
    expect(isEndpointTripped(ep('p', 'm'), q, {}, 1001)).toBe(false);
  });

  it('keeps the documented integer behaviour (NaN cannot reach it: remainingMin is always a positive integer)', () => {
    expect(formatTrippingDuration(60)).toBe('60m');
    expect(formatTrippingDuration(61)).toBe('1h 1m');
    expect(formatTrippingDuration(120)).toBe('2h');
    expect(formatTrippingDuration(1300)).toBe('21h 40m');
  });
});

describe('Round 10: snapshot sync must not discard unsaved edits', () => {
  it('keeps an unsaved endpoint add when the snapshot revision bumps', () => {
    const prevSnap = projectConfig({ endpoints: [ep('a', 'm')] });
    const draft: ClientConfig = { ...prevSnap, endpoints: [ep('a', 'm'), ep('new', 'm')] };
    const nextSnap = projectConfig({ endpoints: [ep('a', 'm'), ep('b', 'm')] });
    const merged = mergeSnapshotIntoDraft(draft, prevSnap, nextSnap);
    expect(merged.endpoints!.map((e) => e.provider)).toEqual(['a', 'new']);
  });

  it('keeps an unsaved strategy change when the snapshot revision bumps', () => {
    const prevSnap = projectConfig({ strategy: 'round-robin' });
    const draft: ClientConfig = { ...prevSnap, strategy: 'weighted' };
    const nextSnap = projectConfig({ strategy: 'round-robin', debug: true });
    const merged = mergeSnapshotIntoDraft(draft, prevSnap, nextSnap);
    expect(merged.strategy).toBe('weighted');
    expect(merged.debug).toBe(true);
  });

  it('adopts the snapshot on first arrival (no prior snapshot)', () => {
    const draft: ClientConfig = { ...DEFAULTS };
    const nextSnap = projectConfig({ enabled: false, endpoints: [ep('a', 'm')] });
    const merged = mergeSnapshotIntoDraft(draft, undefined, nextSnap);
    expect(merged.enabled).toBe(false);
    expect(merged.endpoints).toEqual([ep('a', 'm')]);
  });

  it('adopts a clean draft onto a new snapshot', () => {
    const prevSnap = projectConfig({ enabled: true });
    const nextSnap = projectConfig({ enabled: false });
    expect(mergeSnapshotIntoDraft(prevSnap, prevSnap, nextSnap).enabled).toBe(false);
  });

  it('never lets the snapshot overwrite quarantines (Reset owns that field)', () => {
    const prevSnap = projectConfig({ quarantines: { 'a::m': 1 } });
    const draft: ClientConfig = { ...prevSnap, quarantines: {} };
    const nextSnap = projectConfig({ quarantines: { 'a::m': 9999999999999 } });
    expect(mergeSnapshotIntoDraft(draft, prevSnap, nextSnap).quarantines).toEqual({});
  });
});
