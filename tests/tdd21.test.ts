import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setConfigForTest,
  resetConfigForTest,
  disposeWatcher,
  getConfig,
  getCachedEndpoints,
  getCachedFallbackChain,
  getCachedMode
} from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { resetTelemetry } from '../src/telemetry.js';

/**
 * TDD round 21: mode/fallback config-layer contracts (v2 wave).
 *
 * The runtime layer is not wired yet; these probes pin the landed config
 * semantics so the runtime cannot drift from them when it lands:
 * degradation, chain filtering, parse strictness, and injection consistency.
 */
describe('TDD round 21: mode and fallback config contracts', () => {
  afterEach(() => {
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  const primary = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' }
  ];

  it('PROBE 1: fallback mode with usable rescuers keeps the fallback mode', () => {
    setConfigForTest({
      enabled: true,
      mode: 'fallback',
      endpoints: primary,
      fallback: [{ provider: 'r1', model: 'm1' }, { provider: 'r2', model: 'm1' }]
    });
    expect(getCachedMode()).toBe('fallback');
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1', 'r2']);
    expect(getCachedEndpoints()).toHaveLength(2);
  });

  it('PROBE 2: fallback mode with no usable rescuer degrades to pool', () => {
    // Missing list
    setConfigForTest({ enabled: true, mode: 'fallback', endpoints: primary });
    expect(getCachedMode()).toBe('pool');

    // Every entry parked (enabled: false)
    setConfigForTest({
      enabled: true,
      mode: 'fallback',
      endpoints: primary,
      fallback: [{ provider: 'r1', model: 'm1', enabled: false }]
    });
    expect(getCachedMode()).toBe('pool');
    expect(getCachedFallbackChain()).toEqual([]);
  });

  it('PROBE 3: the chain filters invalid and parked entries, keeping order', () => {
    setConfigForTest({
      enabled: true,
      mode: 'fallback',
      endpoints: primary,
      fallback: [
        { provider: 'r1', model: 'm1' },
        { provider: 'r2', model: 'm1', enabled: false },
        { provider: 'r3', model: 'm1' }
      ]
    });
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1', 'r3']);
    // Degradation does NOT happen while at least one rescuer survives
    expect(getCachedMode()).toBe('fallback');
  });

  it('PROBE 4: parse strictness - invalid fallback entries are dropped, not coerced', () => {
    setConfigForTest({
      enabled: true,
      mode: 'fallback',
      endpoints: primary,
      fallback: [
        { provider: '', model: 'm1' } as any,
        { provider: 'ok', model: 'm1' },
        { provider: 'no-model' } as any
      ]
    });
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['ok']);
  });

  it('PROBE 5: injection and reset keep the new caches consistent', () => {
    setConfigForTest({ enabled: true, mode: 'fallback', endpoints: primary, fallback: [{ provider: 'r1', model: 'm1' }] });
    expect(getCachedMode()).toBe('fallback');

    // Explicit off flips back to pool cleanly
    setConfigForTest({ enabled: true, mode: 'pool', endpoints: primary, fallback: [{ provider: 'r1', model: 'm1' }] });
    expect(getCachedMode()).toBe('pool');

    // Null injection (disable) resets to defaults
    setConfigForTest(null);
    expect(getConfig()).toBeNull();
    expect(getCachedEndpoints()).toEqual([]);

    resetConfigForTest();
    expect(getCachedMode()).toBe('pool');
    expect(getCachedFallbackChain()).toEqual([]);
  });

  it('PROBE 6: pool mode ignores the fallback list as a handling mode', () => {
    setConfigForTest({ enabled: true, endpoints: primary, fallback: [{ provider: 'r1', model: 'm1' }] });
    expect(getCachedMode()).toBe('pool');
    // The chain is still exposed for the lower-tier failover use
    expect(getCachedFallbackChain().map((e) => e.provider)).toEqual(['r1']);
  });
});
