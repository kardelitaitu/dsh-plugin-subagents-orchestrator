import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordRequest,
  recordFailure,
  recordFailover,
  getEndpointStats,
  getRecentEvents,
  resetTelemetry,
  MAX_EVENT_BUFFER
} from '../src/telemetry.js';

describe('Endpoint Telemetry', () => {
  beforeEach(() => {
    resetTelemetry();
    delete process.env['DSH_ORCHESTRATOR_DEBUG'];
  });

  it('counts requests per endpoint', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' });
    recordRequest('a2', { provider: 'p1', model: 'm1' });
    recordRequest('a3', { provider: 'p2', model: 'm2' });

    const stats = getEndpointStats();
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({ key: 'p1::m1', requests: 2, failures: 0 });
    expect(stats[1]).toMatchObject({ key: 'p2::m2', requests: 1 });
  });

  it('records failures with code, timestamp and cooldown hints', () => {
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', 30000, 1234);
    recordFailure('a1', { provider: 'p1', model: 'm1' }, 'SERVER', undefined, 2345);

    const [stat] = getEndpointStats();
    expect(stat.failures).toBe(2);
    expect(stat.cooldownHints).toBe(1);
    expect(stat.lastFailureAt).toBe(2345);
    expect(stat.lastFailureCode).toBe('SERVER');
  });

  it('counts failovers against the target endpoint', () => {
    recordFailover('a1', { provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' });
    recordFailover('a1', { provider: 'p2', model: 'm2' }, { provider: 'p3', model: 'm3' });

    const stats = getEndpointStats();
    expect(stats.find((s) => s.key === 'p2::m2')?.failovers).toBe(1);
    expect(stats.find((s) => s.key === 'p3::m3')?.failovers).toBe(1);
    expect(stats.find((s) => s.key === 'p1::m1')?.failovers).toBe(0);
  });

  it('returns copies, not live references', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' });
    const stats = getEndpointStats();
    stats[0].requests = 999;
    const events = getRecentEvents();
    if (events[0]) events[0].agentId = 'tampered';

    expect(getEndpointStats()[0].requests).toBe(1);
    expect(getRecentEvents()[0].agentId).toBe('a1');
  });

  it('caps the event buffer and serves the most recent tail', () => {
    for (let i = 0; i < MAX_EVENT_BUFFER + 25; i++) {
      recordRequest(`a-${i}`, { provider: 'p1', model: 'm1' });
    }

    const all = getRecentEvents();
    expect(all).toHaveLength(MAX_EVENT_BUFFER);
    expect(all[0].agentId).toBe('a-25');
    expect(all[all.length - 1].agentId).toBe(`a-${MAX_EVENT_BUFFER + 24}`);

    expect(getRecentEvents(5)).toHaveLength(5);
  });

  it('emits debug lines only when DSH_ORCHESTRATOR_DEBUG is enabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      recordRequest('a1', { provider: 'p1', model: 'm1' });
      expect(debugSpy).not.toHaveBeenCalled();

      process.env['DSH_ORCHESTRATOR_DEBUG'] = '1';
      recordFailure('a1', { provider: 'p1', model: 'm1' }, 'RATE_LIMIT', 30000);
      expect(debugSpy).toHaveBeenCalledTimes(1);

      const [, payload] = debugSpy.mock.calls[0];
      const parsed = JSON.parse(String(payload));
      expect(parsed).toMatchObject({ type: 'failure', code: 'RATE_LIMIT', hintMs: 30000 });

      process.env['DSH_ORCHESTRATOR_DEBUG'] = 'true';
      recordFailover('a1', { provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' });
      expect(debugSpy).toHaveBeenCalledTimes(2);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('resetTelemetry clears stats and events', () => {
    recordRequest('a1', { provider: 'p1', model: 'm1' });
    resetTelemetry();
    expect(getEndpointStats()).toEqual([]);
    expect(getRecentEvents()).toEqual([]);
  });
});
