import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, FAILOVER_TRIGGER_CODES } from '../src/index.js';
import { setConfigForTest, disposeWatcher, getConfig } from '../src/config.js';
import { defaultCircuitBreaker } from '../src/health.js';
import { getEndpointStats, getInFlightRequests, getRecentEvents, resetTelemetry } from '../src/telemetry.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/** Deterministic LCG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * TDD round 20: chaos-sequence invariants.
 *
 * A seeded mix of every event kind the host can emit — all trigger codes,
 * hints, unlisted codes, aborts, disposals, config flips — must never
 * crash the plugin, never emit a decision outside the contract, and never
 * leak in-flight state past disposal.
 */
describe('TDD round 20: chaos-sequence invariants', () => {
  let ctx: MockCordisContext;

  const baseConfig = {
    enabled: true as const,
    failover: true as const,
    intervalMinMs: 0,
    intervalMaxMs: 0,
    maxRetries: 2,
    endpoints: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' }
    ]
  };

  beforeEach(() => {
    ctx = new MockCordisContext();
    resetTelemetry();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
    defaultCircuitBreaker.clear();
    resetTelemetry();
  });

  it('PROBE 1: 60 seeded mixed events uphold every global invariant', async () => {
    const rand = mulberry32(20260908);
    setConfigForTest(baseConfig);
    apply(ctx);

    const agents = Array.from({ length: 4 }, (_, i) => createMockAgent(`chaos-${i}`, 'subagent'));
    const alive = new Set(agents.map((a) => a.id));
    const allCodes = [...FAILOVER_TRIGGER_CODES, 'CANCELLED_BY_HOST', 'WEIRD_CODE'];
    let configFlipPhase = 0;

    for (let step = 0; step < 60; step++) {
      const agent = agents[Math.floor(rand() * agents.length)];
      const roll = rand();

      // Config flips on a fixed cadence (not RNG luck) so the branch is
      // always exercised; the seeded roll drives the other event kinds.
      if (step > 0 && step % 15 === 0) {
        setConfigForTest({ ...baseConfig, enabled: false });
        await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));
        setConfigForTest(baseConfig);
        configFlipPhase += 1;
        continue;
      }

      if (roll < 0.35) {
        // Attribution request
        await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));
      } else if (roll < 0.75) {
        // Failure with a random code, sometimes hint-bearing
        const code = allCodes[Math.floor(rand() * allCodes.length)];
        const failure: Record<string, unknown> = { code };
        if (rand() < 0.3) failure.providerRetryAfterMs = [0, 250, 60_000, 20 * 60_000][Math.floor(rand() * 4)];
        else if (rand() < 0.3) failure.headers = { 'Retry-After': ['1', '120', 'garbage'][Math.floor(rand() * 3)] };
        const decision = await ctx.emit(
          'agent/request-error',
          { agent, failure, turn: 1 + Math.floor(rand() * 2), step: 1 },
          () => 'host'
        );
        const isHandled = FAILOVER_TRIGGER_CODES.includes(code) && getConfig()?.enabled !== false;
        if (isHandled && alive.has(agent.id) && defaultCircuitBreaker.getStatus({ provider: 'p1', model: 'm1' })) {
          expect(decision === 'host' || JSON.stringify(decision) === JSON.stringify({ kind: 'retry' }), `step ${step}: ${code}`).toBe(true);
        }
      } else if (roll < 0.82) {
        // Disposal wave: release one agent, respawn it later
        ctx.emit('agent/disposed', { agent });
        alive.delete(agent.id);
      } else if (roll < 0.9) {
        // Respawn a disposed agent
        if (!alive.has(agent.id)) alive.add(agent.id);
      } else {
        // Pre-aborted signal path
        const controller = new AbortController();
        controller.abort();
        await ctx.emit(
          'agent/request-error',
          { agent, failure: { code: 'SERVER' }, turn: 1, step: 1, signal: controller.signal },
          () => 'host'
        );
      }

      // Global invariants after EVERY event
      expect(getInFlightRequests()).toBeLessThanOrEqual(agents.length);
      expect(getEndpointStats().length).toBeLessThanOrEqual(3);
      for (const e of getRecentEvents()) {
        if (e.type === 'failover') {
          expect(e.to?.provider).toBeDefined();
        }
      }
    }

    // Final: everything disposed -> zero residue
    for (const agent of agents) ctx.emit('agent/disposed', { agent });
    expect(getInFlightRequests()).toBe(0);
    // Flips ran on cadence: steps 15, 30, 45 (60 is beyond the loop)
    expect(configFlipPhase).toBe(3);
  });

  it('PROBE 2: a different seed upholds the same invariants', async () => {
    const rand = mulberry32(777);
    setConfigForTest(baseConfig);
    apply(ctx);

    const agents = Array.from({ length: 3 }, (_, i) => createMockAgent(`s2-${i}`, 'subagent'));
    for (let step = 0; step < 40; step++) {
      const agent = agents[Math.floor(rand() * agents.length)];
      const code = FAILOVER_TRIGGER_CODES[Math.floor(rand() * FAILOVER_TRIGGER_CODES.length)];
      if (rand() < 0.4) {
        await ctx.emit('agent/request', { agent }, () => ({ provider: 'p1', model: 'm1' }));
      } else {
        await ctx.emit(
          'agent/request-error',
          { agent, failure: { code, providerRetryAfterMs: rand() < 0.5 ? 500 : undefined }, turn: 1, step: Math.floor(rand() * 3) },
          () => 'host'
        );
      }
      expect(getInFlightRequests()).toBeLessThanOrEqual(agents.length);
    }
    for (const agent of agents) ctx.emit('agent/disposed', { agent });
    expect(getInFlightRequests()).toBe(0);
  });
});
