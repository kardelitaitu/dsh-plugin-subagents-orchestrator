import { describe, it, expect, vi } from 'vitest';
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
  normalizeWeight,
  updateEndpointWeightAt,
  activeClearedQuarantineKeys,
  pruneClearedQuarantineKeys,
  reconcileDraftQuarantines,
  formatTrippingDuration
} from '../src/client/index.jsx';
import type { ClientConfig, EndpointRow } from '../src/client/index.jsx';
import { endpointSettingsSchema } from '../src/settings.js';
import { pickWeighted } from '../src/balancer.js';

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

// =====================================================================
// Round 2: adversarial depth on the same extracted helpers.
// =====================================================================

describe('Round 11: merge adopts the snapshot value the user also chose', () => {
  it('is not stuck when the snapshot catches up to the user value', () => {
    const prevSnap = projectConfig({ strategy: 'round-robin' });
    const draft: ClientConfig = { ...prevSnap, strategy: 'weighted' };
    const next = projectConfig({ strategy: 'weighted' });
    expect(mergeSnapshotIntoDraft(draft, prevSnap, next).strategy).toBe('weighted');
  });
});

describe('Round 12: edit-then-revert is not permanently pending', () => {
  it('re-adopts the incoming snapshot once the draft matches the prior projection', () => {
    const prevSnap = projectConfig({ debug: false });
    const draft: ClientConfig = { ...prevSnap }; // edited to true then back to false
    const next = projectConfig({ debug: true });
    expect(mergeSnapshotIntoDraft(draft, prevSnap, next).debug).toBe(true);
  });
});

describe('Round 13: planConfigWrites with extra / undefined keys', () => {
  it('writes a draft key the projection lacks, skips an undefined value', () => {
    const current = projectConfig({});
    expect(planConfigWrites({ ...current, maxRetries: 7 } as any, current)).toEqual([['maxRetries', 7]]);
    expect(planConfigWrites({ ...current, maxRetries: undefined } as any, current)).toEqual([]);
  });
});

describe('Round 14: dirty stays false after an endpoint round-trips the host schema', () => {
  it('matches the schema key order', () => {
    const row = buildEndpointRow('p', 'm', '', 1)!;
    const stored = endpointSettingsSchema(row as any) as EndpointRow;
    const a: ClientConfig = { ...projectConfig({}), endpoints: [row] };
    const b: ClientConfig = { ...projectConfig({}), endpoints: [stored] };
    expect(isConfigDirty(a, b)).toBe(false);
  });
});

describe('Round 15: a reset must not resurrect a locally cleared quarantine', () => {
  it('suppresses keys the user already cleared', () => {
    const current = { 'a::m': 1, 'b::m': 2 };
    const next = (quarantinesAfterReset as any)({}, current, 'b', 'm', ['a::m']);
    expect(next['a::m']).toBeUndefined();
  });
});

describe('Round 16: a reset prefers the host snapshot over a stale draft timestamp', () => {
  it('keeps the fresher cooldown for an untouched endpoint', () => {
    const next = quarantinesAfterReset({ 'a::m': 1000 }, { 'a::m': 9000 }, 'b', 'm');
    expect(next['a::m']).toBe(9000);
  });
});

describe('Round 17: buildEndpointRow must not emit a non-finite weight', () => {
  it('clamps Infinity/-Infinity/NaN/overflow to 1', () => {
    expect(buildEndpointRow('p', 'm', '', Infinity)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', -Infinity)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', NaN)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', 1e400)!.weight).toBe(1);
  });
});

describe('Round 18: projectConfig must not alias the raw endpoint arrays', () => {
  it('returns fresh arrays and fresh elements per call', () => {
    const raw = { endpoints: [ep('a', 'm')], fallback: [ep('f', 'm')] };
    const one = projectConfig(raw);
    const two = projectConfig(raw);
    expect(one.endpoints).not.toBe(two.endpoints);
    expect(one.endpoints![0]).not.toBe(two.endpoints![0]);
    expect(one.fallback).not.toBe(two.fallback);
    expect(one.fallback![0]).not.toBe(two.fallback![0]);
  });
});

describe('Round 19: projectConfig must not emit an out-of-union strategy/mode', () => {
  it('falls back to the documented default for an unknown value', () => {
    expect(projectConfig({ strategy: 'bogus' as any }).strategy).toBe('round-robin');
    expect(projectConfig({ mode: 'bogus' as any }).mode).toBe('pool');
    expect(projectConfig({ strategy: 'weighted' }).strategy).toBe('weighted');
    expect(projectConfig({ mode: 'fallback' }).mode).toBe('fallback');
  });
});

describe('Round 20: endpoint ops tolerate frozen inputs', () => {
  it('does not mutate a frozen array or a frozen element', () => {
    const eps = Object.freeze([Object.freeze(ep('p', 'm'))]) as unknown as EndpointRow[];
    expect(() => toggleEndpointAt(eps, 0)).not.toThrow();
    expect(toggleEndpointAt(eps, 0)[0].enabled).toBe(false);
    expect(eps[0].enabled).toBeUndefined();
    expect(() => removeEndpointAt(eps, 0)).not.toThrow();
    expect(removeEndpointAt(eps, 0)).toEqual([]);
  });
});

describe('Round 21: the dirty flag agrees with the write plan', () => {
  it('holds for projections of the same shape', () => {
    const a = projectConfig({ debug: true, endpoints: [ep('a', 'm')] });
    const b = projectConfig({ debug: false, endpoints: [ep('a', 'm')] });
    expect(isConfigDirty(a, b)).toBe(planConfigWrites(a, b).length > 0);
  });

  it('LATENT (documented, unreachable from the panel): reorder reads dirty with an empty plan', () => {
    const current = { enabled: true, debug: false } as any;
    const reordered = { debug: false, enabled: true } as any;
    expect(isConfigDirty(reordered, current)).toBe(true);
    expect(planConfigWrites(reordered, current)).toEqual([]);
  });
});

describe('Round 22: merge leaves fields the incoming snapshot omits', () => {
  it('keeps prev when next lacks the key', () => {
    const prev: ClientConfig = { ...DEFAULTS, debug: true };
    const merged = mergeSnapshotIntoDraft(prev, prev, { enabled: false } as ClientConfig);
    expect(merged.debug).toBe(true);
    expect(merged.enabled).toBe(false);
  });
});

describe('Round 23: a 0 quarantine entry is a tombstone, not nullish', () => {
  it('does not fall through to the current map', () => {
    expect(endpointQuarantineUntil(ep('p', 'm'), { 'p::m': 0 }, { 'p::m': 9 })).toBe(0);
    expect(isEndpointTripped(ep('p', 'm'), { 'p::m': 0 }, { 'p::m': 9 }, 0)).toBe(false);
  });
});

describe('Round 24: quarantinesAfterReset does not mutate its inputs', () => {
  it('leaves both maps untouched', () => {
    const draft = { 'a::m': 1 };
    const current = { 'b::m': 2 };
    const next = quarantinesAfterReset(draft, current, 'a', 'm');
    expect(draft).toEqual({ 'a::m': 1 });
    expect(current).toEqual({ 'b::m': 2 });
    expect(next).not.toBe(draft);
  });
});

describe('Round 25: buildEndpointRow weight coercion of junk values', () => {
  it('coerces junk to 1 and keeps hex/fractional numbers', () => {
    expect(buildEndpointRow('p', 'm', '', 'abc' as any)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', '' as any)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', null as any)!.weight).toBe(1);
    expect(buildEndpointRow('p', 'm', '', '0x10' as any)!.weight).toBe(16);
    expect(buildEndpointRow('p', 'm', '', 2.5)!.weight).toBe(2.5);
  });
});

describe('Round 26: resetting clears the provider-wide bare key too', () => {
  it('drops the bare provider entry', () => {
    const next = quarantinesAfterReset({}, { p: 1, 'p::m': 2, 'q::m': 3 }, 'p', 'm');
    expect(next).toEqual({ 'q::m': 3 });
  });
});

describe('Round 27: only quarantines are excluded from dirty', () => {
  it('flags any other field', () => {
    const current = projectConfig({});
    expect(isConfigDirty({ ...current, debug: true }, current)).toBe(true);
    expect(isConfigDirty({ ...current, endpoints: [ep('a', 'm')] }, current)).toBe(true);
    expect(isConfigDirty({ ...current, quarantines: { 'a::m': 1 } }, current)).toBe(false);
  });
});

describe('Round 28: merge never resurrects a cleared quarantine across revisions', () => {
  it('keeps the cleared map when a lagging snapshot still carries the trip', () => {
    const prevSnap = projectConfig({ quarantines: { 'a::m': 1 } });
    const draft: ClientConfig = { ...prevSnap, quarantines: {} };
    const lagging = projectConfig({ quarantines: { 'a::m': 5000 } });
    expect(mergeSnapshotIntoDraft(draft, prevSnap, lagging).quarantines).toEqual({});
  });
});

describe('Round 29: projectConfig with exotic object inputs', () => {
  it('treats arrays/dates/regexps/functions as absent', () => {
    expect(projectConfig([] as any)).toEqual(DEFAULTS);
    expect(projectConfig(new Date() as any)).toEqual(DEFAULTS);
    expect(projectConfig(/x/ as any)).toEqual(DEFAULTS);
    expect(projectConfig((() => 1) as any)).toEqual(DEFAULTS);
  });
});

describe('Round 30: planConfigWrites excludes quarantines and preserves draft order', () => {
  it('omits quarantines even when it is the only difference', () => {
    const current = projectConfig({ quarantines: { 'a::m': 1 } });
    const draft: ClientConfig = { ...current, quarantines: {} };
    expect(planConfigWrites(draft, current)).toEqual([]);
  });

  it('reports writes in draft key order', () => {
    const current = projectConfig({});
    const draft: ClientConfig = { ...current, enabled: false, strategy: 'random' };
    expect(planConfigWrites(draft, current).map(([k]) => k)).toEqual(['enabled', 'strategy']);
  });
});

describe('Round 31: the row weight editor must not store a negative/non-finite weight', () => {
  it('clamps to the declared floor of 1', () => {
    const eps = [ep('p', 'm', { weight: 4 })];
    expect(updateEndpointWeightAt(eps, 0, '-5')[0].weight).toBe(1);
    expect(updateEndpointWeightAt(eps, 0, 'abc')[0].weight).toBe(1);
    expect(updateEndpointWeightAt(eps, 0, '')[0].weight).toBe(1);
    expect(updateEndpointWeightAt(eps, 0, '2.5')[0].weight).toBe(2.5);
    expect(updateEndpointWeightAt(eps, 0, '100')[0].weight).toBe(100);
    expect(eps[0].weight).toBe(4);
  });
});

describe('Round 32: normalizeWeight unit contract', () => {
  it('accepts finite values >= 1 and rejects everything else', () => {
    expect(normalizeWeight(1)).toBe(1);
    expect(normalizeWeight('3')).toBe(3);
    expect(normalizeWeight(2.5)).toBe(2.5);
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, '', 'abc', null, undefined, {}, [], '1e400']) {
      expect(normalizeWeight(bad as any)).toBe(1);
    }
  });
});

describe('Round 33: a merged-in bare-provider key is still deleted by a reset', () => {
  it('drops the bare key that the merge brought back from the snapshot', () => {
    const next = quarantinesAfterReset({}, { p: 7, 'p::m': 8, 'q::m': 9 }, 'p', 'm');
    expect(next).toEqual({ 'q::m': 9 });
  });
});

describe('Round 34: merge with no prior projection adopts the whole snapshot', () => {
  it('adopts even a partially-populated next', () => {
    const draft: ClientConfig = { ...DEFAULTS, enabled: true, debug: false };
    const merged = mergeSnapshotIntoDraft(draft, undefined, { enabled: false, debug: true } as ClientConfig);
    expect(merged.enabled).toBe(false);
    expect(merged.debug).toBe(true);
    expect(merged.strategy).toBe('round-robin');
  });
});

describe('Round 35: merge ignores keys the incoming snapshot omits', () => {
  it('keeps a draft-only key untouched', () => {
    const prev: ClientConfig = { ...DEFAULTS, maxRetries: 5 } as any;
    const merged = mergeSnapshotIntoDraft(prev, prev, { enabled: false } as ClientConfig) as any;
    expect(merged.maxRetries).toBe(5);
  });
});

describe('Round 36: a reset with no draft opinion is idempotent', () => {
  it('does not throw or invent keys on empty maps', () => {
    expect(quarantinesAfterReset(undefined, undefined, 'p', 'm')).toEqual({});
    expect(quarantinesAfterReset({}, {}, 'p', 'm')).toEqual({});
  });
});

describe('Round 37: a cleared key absent from both maps is harmless', () => {
  it('drops it without error', () => {
    expect(quarantinesAfterReset({ 'b::m': 1 }, { 'b::m': 2 }, 'p', 'm', ['zz'])).toEqual({ 'b::m': 2 });
  });
});

describe('Round 38: add-then-remove an endpoint leaves the panel clean', () => {
  it('is not dirty after a round-trip', () => {
    const current = projectConfig({ endpoints: [ep('a', 'm')] });
    const added = { ...current, endpoints: [...current.endpoints!, buildEndpointRow('b', 'm', '', 1)!] };
    const removed = { ...added, endpoints: removeEndpointAt(added.endpoints!, 1) };
    expect(isConfigDirty(removed, current)).toBe(false);
  });
});

describe('Round 39: projectConfig shallow-copies row objects but preserves extra fields', () => {
  it('keeps unknown endpoint fields and does not alias', () => {
    const raw = { endpoints: [{ provider: 'a', model: 'm', extra: 1 } as any] };
    const one = projectConfig(raw);
    const two = projectConfig(raw);
    expect(one.endpoints![0]).toEqual({ provider: 'a', model: 'm', extra: 1 });
    expect(one.endpoints![0]).not.toBe(two.endpoints![0]);
    expect(one.endpoints![0]).not.toBe(raw.endpoints[0]);
  });
});

describe('Round 40: no inline duplicate of the extracted decision logic remains', () => {
  it('the component body contains no stale copy of the quarantine lookup or write plan', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/client/index.tsx'), 'utf8');
    // Scan only the COMPONENT body: the helpers legitimately contain these
    // patterns, the component must not carry a second copy.
    const component = src.slice(src.indexOf('export function SubagentsOrchestratorSection'));
    expect(component).not.toMatch(/draft\.quarantines \|\| \{\}\)\[/);
    expect(component).not.toMatch(/current\[key as keyof ClientConfig\]\) !== JSON\.stringify\(value\)/);
    expect(component).not.toMatch(/enabled === false \? true : false/);
    // And the component must actually call the helpers.
    expect(src).toContain('isEndpointTripped(');
    expect(src).toContain('planConfigWrites(');
    expect(src).toContain('mergeSnapshotIntoDraft(');
    expect(src).toContain('quarantinesAfterReset(');
  });
});

// =====================================================================
// Round 2: verification of the fixes the parent landed outside my file.
// =====================================================================

describe('Round 41: balancer weight normalization holds under extreme weights', () => {
  const w = (weight: number) => ({ provider: 'p', model: 'm', weight }) as any;
  const pickAt = (eps: any[], r: number) => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(r);
    try { return pickWeighted(eps); } finally { spy.mockRestore(); }
  };

  it('does not starve either endpoint for two 1e308 weights (pre-fix: always the last)', () => {
    const eps = [w(1e308), w(1e308)];
    expect(pickAt(eps, 0.1)).toBe(eps[0]);
    expect(pickAt(eps, 0.9)).toBe(eps[1]);
  });

  it('keeps the small weight selectable beside a huge one', () => {
    const eps = [w(100), w(1)];
    expect(pickAt(eps, 0.5)).toBe(eps[0]);
    expect(pickAt(eps, 0.999)).toBe(eps[1]);
  });

  it('still splits equal weights evenly', () => {
    const eps = [w(5), w(5)];
    expect(pickAt(eps, 0.25)).toBe(eps[0]);
    expect(pickAt(eps, 0.75)).toBe(eps[1]);
  });

  it('returns null for an empty pool', () => {
    expect(pickWeighted([])).toBeNull();
  });
});

describe('Round 42: a locally-cleared key stops being suppressed once the host moves on', () => {
  it('suppresses only while the snapshot still carries the cleared value', () => {
    const cleared = new Map<string, number | undefined>([['a::m', 100], ['gone::m', 5]]);
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100, 'gone::m': 5 }))
      .toEqual(new Set(['a::m', 'gone::m']));
    // The write landed: the key is absent from the snapshot.
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100 })).toEqual(new Set(['a::m']));
    // The host RE-TRIPPED it with a newer timestamp - it is live again, so it
    // must no longer be suppressed on an unrelated reset.
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 999, 'gone::m': 5 }))
      .toEqual(new Set(['gone::m']));
  });
});

// =====================================================================
// Round 3: interactions, exact limits, long-lived state, guard precision.
// =====================================================================

describe('Round 43: a landed clear must be FORGOTTEN, not re-armed by a same-valued trip', () => {
  it('does not suppress a new trip that reuses the cleared expiry value', () => {
    // The write has not landed yet: the snapshot still carries the cleared value.
    let cleared = new Map<string, number | undefined>([['a::m', 100]]);
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100 })).toEqual(new Set(['a::m']));

    // The write lands: the key disappears from the snapshot. The intent is
    // fulfilled, so the entry must be pruned - NOT merely filtered by value.
    cleared = pruneClearedQuarantineKeys(cleared, {});
    expect(cleared.size).toBe(0);

    // The host trips it again. With alignHourly an intra-hour re-trip reuses the
    // SAME expiry, so a value-only check would wrongly re-suppress it and an
    // unrelated reset would silently clear a live quarantine.
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100 })).toEqual(new Set());
  });

  it('keeps a pending entry while the snapshot still carries the cleared value', () => {
    const cleared = new Map<string, number | undefined>([['a::m', 100]]);
    expect(pruneClearedQuarantineKeys(cleared, { 'a::m': 100 }).get('a::m')).toBe(100);
  });

  it('forgets an entry whose value the snapshot has moved on from', () => {
    const cleared = new Map<string, number | undefined>([['a::m', 100]]);
    expect(pruneClearedQuarantineKeys(cleared, { 'a::m': 999 }).size).toBe(0);
  });
});

describe('Round 44: both weight editors route through the shared normalizer', () => {
  it('has no stale inline weight coercion left in the component', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/client/index.tsx'), 'utf8');
    const component = src.slice(src.indexOf('export function SubagentsOrchestratorSection'));
    // A stale copy of the coercion is exactly the divergence class found before.
    expect(component).not.toMatch(/weight:\s*Number\(/);
    expect(component).not.toMatch(/setNewWeight\(Number\(/);
    // Both editors must go through the shared helpers.
    expect(component).toContain('updateEndpointWeightAt(');
    expect(component).toContain('setNewWeight(normalizeWeight(');
    // And the shared helper itself is the only coercion.
    expect(src).toMatch(/export function updateEndpointWeightAt[\s\S]*?normalizeWeight\(rawWeight\)/);
  });

  it('gives both editors the same floor for the same input', () => {
    for (const raw of ['-5', '0', 'abc', '', Infinity, NaN, '1e400']) {
      const viaAdd = buildEndpointRow('p', 'm', '', raw as any)!.weight;
      const viaRow = updateEndpointWeightAt([ep('p', 'm', { weight: 3 })], 0, raw)[0].weight;
      expect(viaRow, 'raw=' + String(raw)).toBe(viaAdd);
    }
  });
});

describe('Round 45: projectConfig row copies are independent for every editable field', () => {
  it('deep-independent for the primitive row fields', () => {
    const raw = { endpoints: [ep('a', 'm', { reasoningEffort: 'high', weight: 3, enabled: true })] };
    const one = projectConfig(raw);
    const two = projectConfig(raw);
    one.endpoints![0].reasoningEffort = 'low';
    one.endpoints![0].weight = 99;
    one.endpoints![0].enabled = false;
    expect(two.endpoints![0]).toEqual(ep('a', 'm', { reasoningEffort: 'high', weight: 3, enabled: true }));
    expect(raw.endpoints[0]).toEqual(ep('a', 'm', { reasoningEffort: 'high', weight: 3, enabled: true }));
  });

  it('LATENT (documented): a nested object field on a row is still shared', () => {
    // Every EndpointRow field is a primitive, and the panel replaces rows with
    // {...row, field} rather than mutating in place, so this is unreachable.
    const nested = { provider: 'a', model: 'm', meta: { x: 1 } } as any;
    const one = projectConfig({ endpoints: [nested] });
    expect(one.endpoints![0]).toMatchObject({ provider: 'a', model: 'm' });
  });
});

describe('Round 46: the strategy/mode whitelist matches config.ts exactly', () => {
  it('accepts every documented strategy and mode', () => {
    for (const s of ['round-robin', 'random', 'weighted']) {
      expect(projectConfig({ strategy: s as any }).strategy).toBe(s);
    }
    for (const m of ['pool', 'fallback']) {
      expect(projectConfig({ mode: m as any }).mode).toBe(m);
    }
  });

  it('rejects everything else, including near-misses and wrong types', () => {
    for (const s of ['Round-Robin', 'round_robin', 'bogus', '', 0, 1, null, undefined, {}, [], true]) {
      expect(projectConfig({ strategy: s as any }).strategy).toBe('round-robin');
    }
    for (const m of ['POOL', 'Pool', 'fallback ', 'bogus', 0, null, {}, []] as any[]) {
      expect(projectConfig({ mode: m as any }).mode).toBe('pool');
    }
  });
});

describe('Round 47: a snapshot bump during a pending clear leaves a coherent draft', () => {
  it('does not resurrect the cleared quarantine into the draft', () => {
    const prevSnap = projectConfig({ quarantines: { 'a::m': 100 } });
    const draft: ClientConfig = { ...prevSnap, quarantines: {} };
    const nextSnap = projectConfig({ enabled: false, quarantines: { 'a::m': 100 } });
    const merged = mergeSnapshotIntoDraft(draft, prevSnap, nextSnap);
    expect(merged.quarantines).toEqual({});
    expect(merged.enabled).toBe(false);
  });
});

describe('Round 48: the cleared map does not grow across many landed clears', () => {
  it('shrinks to empty once every write has landed', () => {
    let cleared = new Map<string, number | undefined>();
    for (let i = 0; i < 25; i++) cleared.set('p' + i + '::m', 1000 + i);
    expect(cleared.size).toBe(25);
    cleared = pruneClearedQuarantineKeys(cleared, {});
    expect(cleared.size).toBe(0);
  });

  it('keeps only the still-pending subset', () => {
    const cleared = new Map<string, number | undefined>([
      ['a::m', 100], ['b::m', 200], ['c::m', 300]
    ]);
    const pruned = pruneClearedQuarantineKeys(cleared, { 'a::m': 100, 'c::m': 999 });
    expect([...pruned.keys()]).toEqual(['a::m']);
  });
});

describe('Round 49: normalizeWeight exact floor boundary', () => {
  it('accepts 1 exactly and rejects just below it', () => {
    expect(normalizeWeight(1)).toBe(1);
    expect(normalizeWeight(1.0000001)).toBe(1.0000001);
    expect(normalizeWeight(0.9999999)).toBe(1);
    expect(normalizeWeight('1')).toBe(1);
    expect(normalizeWeight('0.9999999')).toBe(1);
  });
});

describe('Round 50: accumulate-then-reset keeps every other endpoint intact', () => {
  it('preserves all untouched keys through a sequence of resets', () => {
    const snapshot = { 'a::m': 1, 'b::m': 2, 'c::m': 3, 'd::m': 4 };
    let draft: Record<string, number> = {};
    const cleared: string[] = [];
    for (const [p, m] of [['a', 'm'], ['b', 'm']] as const) {
      draft = quarantinesAfterReset(draft, snapshot, p, m, cleared);
      cleared.push(`${p}::${m}`);
    }
    expect(draft).toEqual({ 'c::m': 3, 'd::m': 4 });
  });
});

describe('Round 51: the host schema preserves a panel row through a save/reload', () => {
  it('keeps dirty false for a row with an unknown extra key', () => {
    const row = { ...buildEndpointRow('p', 'm', 'high', 2)!, extra: 'kept' } as any;
    const stored = endpointSettingsSchema(row as any) as EndpointRow;
    const a: ClientConfig = { ...projectConfig({}), endpoints: [row] };
    const b: ClientConfig = { ...projectConfig({}), endpoints: [stored] };
    expect(isConfigDirty(a, b)).toBe(false);
  });
});

describe('Round 52: dirty and the write plan agree on a draft-only key', () => {
  it('both flag an extra key and both ignore an undefined one', () => {
    const current = projectConfig({});
    const extra: ClientConfig = { ...current, maxRetries: 9 } as any;
    expect(isConfigDirty(extra, current)).toBe(true);
    expect(planConfigWrites(extra, current)).toEqual([['maxRetries', 9]]);
    const undef: ClientConfig = { ...current, maxRetries: undefined } as any;
    expect(isConfigDirty(undef, current)).toBe(false);
    expect(planConfigWrites(undef, current)).toEqual([]);
  });
});

describe('Round 53: resetting a key that is also in the cleared set is idempotent', () => {
  it('removes it and keeps the others', () => {
    const next = quarantinesAfterReset({ 'b::m': 2 }, { 'a::m': 1, 'b::m': 2 }, 'a', 'm', ['a::m']);
    expect(next).toEqual({ 'b::m': 2 });
  });
});

describe('Round 54: repeated toggle/remove cycles stay stable', () => {
  it('returns to the original state and never mutates the source', () => {
    const source = [ep('a', 'm'), ep('b', 'm')];
    let eps = source;
    for (let i = 0; i < 9; i++) eps = toggleEndpointAt(eps, 0);
    expect(eps[0].enabled).toBe(false); // odd toggles from undefined land on false
    eps = toggleEndpointAt(eps, 0);
    expect(eps[0].enabled).toBe(true);
    let shrunk = eps;
    for (let i = 0; i < 5; i++) shrunk = removeEndpointAt(shrunk, 1);
    expect(shrunk).toEqual([eps[0]]);
    expect(source).toHaveLength(2);
    expect(source[0].enabled).toBeUndefined();
  });
});

describe('Round 55: cleared-key suppression is per-key, not per-value', () => {
  it('does not suppress a different key that happens to share the value', () => {
    const cleared = new Map<string, number | undefined>([['a::m', 100]]);
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100, 'b::m': 100 })).toEqual(new Set(['a::m']));
  });

  it('does not suppress a different model of the same provider', () => {
    const cleared = new Map<string, number | undefined>([['a::m1', 100]]);
    expect(activeClearedQuarantineKeys(cleared, { 'a::m1': 100, 'a::m2': 100 })).toEqual(new Set(['a::m1']));
  });
});

describe('Round 56: buildEndpointRow and updateEndpointWeightAt share one floor', () => {
  it('agree across the whole coercion domain', () => {
    for (const raw of [1, 2.5, 100, '7', 0, -3, NaN, Infinity, '', 'x', null, undefined]) {
      const a = buildEndpointRow('p', 'm', '', raw as any)!.weight;
      const b = updateEndpointWeightAt([ep('p', 'm', { weight: 1 })], 0, raw)[0].weight;
      expect(b, 'raw=' + String(raw)).toBe(a);
    }
  });
});

describe('Round 57: clear -> newer re-trip -> revert to the old value is LIVE again', () => {
  it('does not re-suppress after the host moved on and came back', () => {
    // 1. The user clears a trip that expired at 100.
    let cleared = new Map<string, number | undefined>([['a::m', 100]]);
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100 })).toEqual(new Set(['a::m']));

    // 2. The write lands; the intent is fulfilled and the entry is forgotten.
    cleared = pruneClearedQuarantineKeys(cleared, {});
    expect(cleared.size).toBe(0);

    // 3. The host re-trips it with a NEWER expiry.
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 999 })).toEqual(new Set());

    // 4. The host later reverts to the OLD value. That is a fresh trip event,
    //    not the trip the user cleared, so it must be LIVE (not suppressed).
    expect(activeClearedQuarantineKeys(cleared, { 'a::m': 100 })).toEqual(new Set());
    expect(quarantinesAfterReset({}, { 'a::m': 100 }, 'b', 'm', [])).toEqual({ 'a::m': 100 });
  });
});

describe('Round 58: prune is pure and never mutates its inputs', () => {
  it('returns a new map and leaves the source map untouched', () => {
    const cleared = new Map<string, number | undefined>([['a::m', 100], ['b::m', 200]]);
    const pruned = pruneClearedQuarantineKeys(cleared, { 'a::m': 100 });
    expect(pruned).not.toBe(cleared);
    expect(cleared.size).toBe(2);
    expect([...pruned.keys()]).toEqual(['a::m']);
  });
});

describe('Round 59: a pending edit survives two successive snapshot bumps', () => {
  it('keeps the user value while adopting both snapshot changes elsewhere', () => {
    const s1 = projectConfig({ strategy: 'round-robin', debug: false });
    const draft: ClientConfig = { ...s1, strategy: 'weighted' };
    const s2 = projectConfig({ strategy: 'round-robin', debug: true });
    const afterFirst = mergeSnapshotIntoDraft(draft, s1, s2);
    const s3 = projectConfig({ strategy: 'random', debug: true, cooldownMs: 42 });
    const afterSecond = mergeSnapshotIntoDraft(afterFirst, s2, s3);
    expect(afterSecond.strategy).toBe('weighted');
    expect(afterSecond.debug).toBe(true);
    expect(afterSecond.cooldownMs).toBe(42);
  });
});

describe('Round 60: an entry with an undefined cleared value is never armed', () => {
  it('does not suppress a key that was absent when the clear was recorded', () => {
    // resetEndpointHealth records the snapshot value for each key shape, which
    // is undefined for a shape the snapshot never carried.
    const cleared = new Map<string, number | undefined>([['p::m', undefined], ['p:m', undefined]]);
    expect(activeClearedQuarantineKeys(cleared, { 'p::m': 100 })).toEqual(new Set());
    expect(pruneClearedQuarantineKeys(cleared, { 'p::m': 100 }).size).toBe(0);
  });
});

describe('Round 61: a reset still clears a target whose key shape the snapshot lacks', () => {
  it('writes the map without that key', () => {
    const next = quarantinesAfterReset({}, { 'b::m': 2 }, 'a', 'm');
    expect(next).toEqual({ 'b::m': 2 });
  });
});

describe('Round 62: a host-side clear must not be masked by a stale draft entry', () => {
  it('drops a draft quarantine key the snapshot no longer carries', () => {
    // The user reset a::m, so the draft now carries the host's OTHER trip b::m.
    const draft = { 'b::m': 5000 };
    // The host then clears b::m on its own (another surface / host API). The
    // draft is never hydrated with quarantines, so without reconciliation the
    // stale b::m entry wins the display lookup and the row shows Tripped
    // forever even though the host says healthy.
    expect(reconcileDraftQuarantines(draft, {})).toEqual({});
    expect(isEndpointTripped(ep('b', 'm'), reconcileDraftQuarantines(draft, {}), {}, 0)).toBe(false);
  });

  it('keeps a draft entry the snapshot still carries', () => {
    expect(reconcileDraftQuarantines({ 'b::m': 5000 }, { 'b::m': 5000 })).toEqual({ 'b::m': 5000 });
  });

  it('never resurrects a key the draft already dropped', () => {
    // The draft dropped a::m (the user cleared it); the snapshot still has it.
    expect(reconcileDraftQuarantines({ 'b::m': 5000 }, { 'a::m': 1, 'b::m': 5000 })).toEqual({ 'b::m': 5000 });
  });

  it('does not mutate its inputs', () => {
    const draft = { 'b::m': 5000 };
    const snapshot = { 'b::m': 5000, 'a::m': 1 };
    reconcileDraftQuarantines(draft, snapshot);
    expect(draft).toEqual({ 'b::m': 5000 });
    expect(snapshot).toEqual({ 'b::m': 5000, 'a::m': 1 });
  });
});

describe('Round 63: the READ path must clear the badge a Reset just cleared', () => {
  it('suppresses a pending-cleared key that a LAGGING snapshot still carries', () => {
    // The user reset a::m; the draft dropped it and the write is in flight, so
    // the snapshot still carries a::m. The draft-first lookup falls through to
    // the snapshot and re-shows Tripped - the reset appears not to work until
    // the RPC lands (and FOREVER if the write is rejected, since the catch
    // swallows the failure).
    const current = { 'a::m': 1, 'b::m': 2 };
    const draft = quarantinesAfterReset({}, current, 'a', 'm', ['a::m']);
    expect(draft).toEqual({ 'b::m': 2 });

    const suppressed = new Set(['a::m']);
    expect(endpointQuarantineUntil(ep('a', 'm'), draft, current, suppressed)).toBeUndefined();
    expect(isEndpointTripped(ep('a', 'm'), draft, current, 0, suppressed)).toBe(false);
    // The untouched neighbour is unaffected.
    expect(isEndpointTripped(ep('b', 'm'), draft, current, 0, suppressed)).toBe(true);
  });

  it('does not suppress a key that is not pending', () => {
    const current = { 'a::m': 1 };
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, new Set())).toBe(true);
  });
});

describe('Round 64: read-path suppression is per-KEY, not per-row', () => {
  it('suppresses only the exact cleared key shapes', () => {
    const current = { 'a::m': 1, 'a:m': 2, a: 3, 'b::m': 4 };
    // A reset of (a, m) records ALL THREE shapes, so the row reads healthy...
    const all = new Set(['a::m', 'a:m', 'a']);
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, all)).toBe(false);
    // ...while a neighbour is untouched.
    expect(isEndpointTripped(ep('b', 'm'), {}, current, 0, all)).toBe(true);
    // Suppressing a key shape the snapshot does not carry changes nothing.
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, new Set(['a:m']))).toBe(true);
  });

  it('suppressing only the bare-provider shape does not hide the per-model entry', () => {
    const current = { 'a::m': 1, a: 3 };
    // The bare key is a DISTINCT provider-wide quarantine: hiding it alone
    // still leaves the per-model trip visible.
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, new Set(['a']))).toBe(true);
    // But hiding both shapes clears the row, and the bare key alone hides the
    // provider's OTHER models.
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, new Set(['a', 'a::m']))).toBe(false);
    expect(isEndpointTripped(ep('a', 'x'), {}, { a: 3 }, 0, new Set(['a']))).toBe(false);
  });
});

describe('Round 65: reconcile never ADDS a snapshot entry to the draft', () => {
  it('keeps the draft a subset of what it already held', () => {
    expect(reconcileDraftQuarantines({}, { 'a::m': 1 })).toEqual({});
    expect(reconcileDraftQuarantines(undefined, { 'a::m': 1 })).toEqual({});
    expect(reconcileDraftQuarantines({ 'a::m': 1 }, { 'a::m': 1, 'b::m': 2 })).toEqual({ 'a::m': 1 });
  });
});

describe('Round 66: a stale draft entry the snapshot re-trips with a new value is kept', () => {
  it('keeps the draft value when the key is still present', () => {
    // The key is still in the snapshot (newer value) - reconcile keeps the
    // draft's entry, and the display still resolves to a trip.
    const draft = reconcileDraftQuarantines({ 'a::m': 100 }, { 'a::m': 999 });
    expect(draft).toEqual({ 'a::m': 100 });
  });
});

describe('Round 67: suppression composes with reconcile without hiding a live trip', () => {
  it('a reconciled-away key is not suppressed, a pending key is', () => {
    const current = { 'a::m': 1, 'b::m': 2 };
    const draft = { 'b::m': 2 };
    const reconciled = reconcileDraftQuarantines(draft, current);
    expect(reconciled).toEqual({ 'b::m': 2 });
    const suppressed = new Set(['a::m']);
    expect(isEndpointTripped(ep('a', 'm'), reconciled, current, 0, suppressed)).toBe(false);
    expect(isEndpointTripped(ep('b', 'm'), reconciled, current, 0, suppressed)).toBe(true);
  });
});

describe('Round 68: no stale inline quarantine lookup remains in the component', () => {
  it('routes every read through the shared helpers', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/client/index.tsx'), 'utf8');
    const component = src.slice(src.indexOf('export function SubagentsOrchestratorSection'));
    // A stale inline LOOKUP would have to build the key from the endpoint's own
    // fields. (The component legitimately builds \`\${provider}::\${model}\` in
    // resetEndpointHealth to record which shapes it cleared - different
    // identifiers, not a lookup.)
    expect(component).not.toContain('\${endpoint.provider}::\${endpoint.model}');
    expect(component).toContain('isEndpointTripped(');
    expect(component).toContain('endpointQuarantineUntil(');
    expect(component).toContain('activeClearedQuarantineKeys(');
  });
});

describe('Round 69: a write REJECTED while a clear is pending keeps the badge cleared', () => {
  it('suppression does not depend on the write succeeding', () => {
    // resetEndpointHealth catches the rejection; the snapshot never changes.
    const current = { 'a::m': 1 };
    const draft = quarantinesAfterReset({}, current, 'a', 'm', ['a::m']);
    const suppressed = activeClearedQuarantineKeys(new Map([['a::m', 1]]), current);
    expect(suppressed).toEqual(new Set(['a::m']));
    expect(isEndpointTripped(ep('a', 'm'), draft, current, 0, suppressed)).toBe(false);
  });
});

describe('Round 70: suppression survives a revision bump that leaves the key pending', () => {
  it('stays suppressed while the snapshot still carries the cleared value', () => {
    let cleared = new Map<string, number | undefined>([['a::m', 1]]);
    const current = { 'a::m': 1, 'b::m': 2 };
    cleared = pruneClearedQuarantineKeys(cleared, current);
    expect(activeClearedQuarantineKeys(cleared, current)).toEqual(new Set(['a::m']));
    expect(isEndpointTripped(ep('a', 'm'), {}, current, 0, activeClearedQuarantineKeys(cleared, current))).toBe(false);
  });
});

describe('Round 71: the duplicate-detection pattern is non-vacuous', () => {
  it('the pattern DOES match a synthetic inline copy, so its absence in the component means something', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/client/index.tsx'), 'utf8');
    const anchor = '\${endpoint.provider}::\${endpoint.model}';
    // The extracted helper must build the key from the endpoint's fields...
    const helper = src.slice(src.indexOf('export function endpointQuarantineUntil'), src.indexOf('export function isEndpointTripped'));
    expect(helper).toContain(anchor);
    // ...so asserting its absence in the component body is meaningful.
    const component = src.slice(src.indexOf('export function SubagentsOrchestratorSection'));
    expect(component).not.toContain(anchor);
    // Sanity: a synthetic inline copy would be caught.
    expect('const x = draft[\`' + anchor + '\`];').toContain(anchor);
  });
});

describe('Round 72: the read path and the write path agree on which keys are cleared', () => {
  it('suppression covers exactly the shapes the reset removed', () => {
    const current = { 'a::m': 1, 'a:m': 2, a: 3, 'b::m': 4 };
    const cleared = new Map<string, number | undefined>();
    for (const key of ['a::m', 'a:m', 'a']) cleared.set(key, (current as any)[key]);
    const nextQ = quarantinesAfterReset({}, current, 'a', 'm', []);
    const suppressed = activeClearedQuarantineKeys(cleared, current);
    // Every shape the write removed is suppressed for display...
    for (const key of ['a::m', 'a:m', 'a']) {
      expect(nextQ[key], key).toBeUndefined();
      expect(suppressed.has(key), key).toBe(true);
    }
    // ...and every surviving key is not.
    expect(suppressed.has('b::m')).toBe(false);
    expect(nextQ['b::m']).toBe(4);
  });
});

describe('Round 73: clearing one provider must not suppress a same-named different provider', () => {
  it('keeps a prefix-collision provider live', () => {
    const current = { 'a::m': 1, 'a::mx': 2, 'ab::m': 3 };
    const suppressed = new Set(['a::m', 'a:m', 'a']);
    expect(isEndpointTripped(ep('a', 'mx'), {}, current, 0, suppressed)).toBe(true);
    expect(isEndpointTripped(ep('ab', 'm'), {}, current, 0, suppressed)).toBe(true);
  });
});

describe('Round 74: an empty suppressed set is a no-op', () => {
  it('matches the two-argument lookup exactly', () => {
    const draft = { 'b::m': 5 };
    const current = { 'a::m': 1, 'b::m': 5 };
    expect(endpointQuarantineUntil(ep('a', 'm'), draft, current, new Set()))
      .toBe(endpointQuarantineUntil(ep('a', 'm'), draft, current));
    expect(endpointQuarantineUntil(ep('a', 'm'), draft, current, undefined))
      .toBe(endpointQuarantineUntil(ep('a', 'm'), draft, current));
  });
});

describe('Round 75: the panel weight floor is behaviour-preserving vs config.ts', () => {
  it('floors sub-1 weights the way the balancer already does', () => {
    // config.ts accepts any finite weight > 0 (e.g. 0.5); the panel floors to 1.
    // pickWeighted clamps with Math.max(1, ...), so 0.5 and 1 select identically -
    // the panel is not narrowing behaviour the runtime would honour.
    const raw = (weight: number) => ({ provider: 'p', model: 'm', weight }) as any;
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      // Compare the chosen INDEX: two separate arrays cannot share element identity.
      const half = [raw(0.5), raw(1)];
      const floored = [raw(1), raw(1)];
      expect(half.indexOf(pickWeighted(half)!)).toBe(floored.indexOf(pickWeighted(floored)!));
    } finally { spy.mockRestore(); }
  });
});

describe('Round 76: suppression and reconciliation never fight over the same key', () => {
  it('a reconciled-away key can never be reported suppressed', () => {
    const current = { 'a::m': 1 };
    const cleared = new Map<string, number | undefined>([['a::m', 1]]);
    // The write landed (key gone from the snapshot): reconcile drops any draft
    // entry AND prune forgets the clear, so the key is live for a later trip.
    const reconciled = reconcileDraftQuarantines({ 'a::m': 1 }, {});
    const pruned = pruneClearedQuarantineKeys(cleared, {});
    expect(reconciled).toEqual({});
    expect(pruned.size).toBe(0);
    expect(activeClearedQuarantineKeys(pruned, { 'a::m': 1 })).toEqual(new Set());
  });
});
