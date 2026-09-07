import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apply, FAILOVER_TRIGGER_CODES } from '../src/index.js';
import { setConfigForTest, disposeWatcher } from '../src/config.js';
import { MockCordisContext, createMockAgent } from './mocks/cordis.js';

/**
 * Failover activation semantics:
 * - failover defaults to ON (README contract); only explicit `failover: false`
 *   disables it.
 * - per-provider credential failures fail over between pool entries; shared
 *   infrastructure failures (AUTH) do not.
 */
describe('Failover defaults and credential triggers', () => {
  let ctx: MockCordisContext;

  beforeEach(() => {
    ctx = new MockCordisContext();
  });

  afterEach(() => {
    ctx.dispose();
    disposeWatcher();
    setConfigForTest(null);
  });

  const twoEndpoints = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' }
  ];

  it('fails over by default when the failover flag is omitted', async () => {
    setConfigForTest({
      enabled: true,
      maxRetries: 0, // no same-endpoint budget: cross over on the first failure
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: twoEndpoints
    });
    apply(ctx);

    const subagent = createMockAgent('sub-default-on', 'subagent');
    // Attribute the failing endpoint first (the host always dispatches
    // agent/request before a request can fail).
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host-default'
    );
    expect(result).toEqual({ kind: 'retry' });

    const retried: any = await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));
    expect(retried.provider).toBe('p2');
  });

  it('still defers when failover is explicitly disabled', async () => {
    setConfigForTest({
      enabled: true,
      failover: false,
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: twoEndpoints
    });
    apply(ctx);

    const subagent = createMockAgent('sub-default-off', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'RATE_LIMIT' }, turn: 1, step: 1 },
      () => 'host-default'
    );
    expect(result).toBe('host-default');
  });

  it('treats per-provider credential failures as failover triggers', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 0, // no same-endpoint budget: cross over on the first failure
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: twoEndpoints
    });
    apply(ctx);

    expect(FAILOVER_TRIGGER_CODES).toContain('INVALID_CREDENTIAL');
    expect(FAILOVER_TRIGGER_CODES).toContain('MISSING_CREDENTIAL');

    for (const [i, code] of ['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'].entries()) {
      const subagent = createMockAgent(`sub-cred-${i}`, 'subagent');
      await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

      const result = await ctx.emit(
        'agent/request-error',
        { agent: subagent, failure: { code }, turn: 1, step: 1 },
        () => 'host-default'
      );
      expect(result).toEqual({ kind: 'retry' });
    }
  });

  it('keeps shared-infrastructure AUTH failures out of the trigger set', async () => {
    setConfigForTest({
      enabled: true,
      failover: true,
      maxRetries: 0, // no same-endpoint budget: cross over on the first failure
      intervalMinMs: 0,
      intervalMaxMs: 0,
      endpoints: twoEndpoints
    });
    apply(ctx);

    expect(FAILOVER_TRIGGER_CODES).not.toContain('AUTH');

    const subagent = createMockAgent('sub-auth-shared', 'subagent');
    await ctx.emit('agent/request', { agent: subagent }, () => ({ provider: 'p1', model: 'm1' }));

    const result = await ctx.emit(
      'agent/request-error',
      { agent: subagent, failure: { code: 'AUTH' }, turn: 1, step: 1 },
      () => 'host-default'
    );
    expect(result).toBe('host-default');
  });
});
