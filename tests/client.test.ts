import { describe, it, expect, vi } from 'vitest';
import { apply, inject, NS, PLUGIN_ID, formatTrippingDuration } from '../src/client/index.jsx';
import { bindEndpointTest } from '../src/client/testConnection.js';

describe('Client Settings Section', () => {
  it('declares slots but NOT a version-specific settings service', () => {
    expect(inject).toContain('slots');
    // The settings service is resolved at runtime (resolveSettingsScope)
    // because its NAME differs by core version: core <= 0.1.x provided
    // `settingsScope`, core >= 0.1.7-rc.1 replaced it with `configForms`.
    // Naming either one here leaves the plugin fiber PENDING on the other
    // core, which the host reports as "waiting for activation" and the
    // panel never mounts. Both names must therefore stay OUT of inject.
    expect(inject).not.toContain('settingsScope');
    expect(inject).not.toContain('configForms');
  });

  it('registers settings.section on apply', () => {
    let registeredSpec: any = null;
    let registeredComponent: any = null;

    const mockSlots = {
      inject: vi.fn((slotName: string, cb: () => void) => {
        expect(slotName).toBe('settings.section');
        cb();
      }),
      register: vi.fn((spec: any, component: any) => {
        registeredSpec = spec;
        registeredComponent = component;
      })
    };

    const mockScope = {
      bind: vi.fn(({ namespace }: { namespace: string }) => {
        expect(namespace).toBe(NS);
        return {
          subscribe: vi.fn(),
          getSnapshot: vi.fn(() => ({ status: 'ready', value: {}, writable: true })),
          set: vi.fn()
        };
      })
    };

    const mockCtx = {
      slots: mockSlots,
      settingsScope: mockScope
    };

    apply(mockCtx);

    expect(mockScope.bind).toHaveBeenCalledWith({ namespace: 'subagents-orchestrator' });
    expect(mockSlots.inject).toHaveBeenCalled();
    expect(mockSlots.register).toHaveBeenCalled();
    expect(registeredSpec.name).toBe('settings.section');
    expect(registeredSpec.id).toBe('subagents-orchestrator');
    expect(registeredSpec.label()).toBe('Subagents Orchestrator');
    expect(registeredComponent).toBeDefined();
  });

  it('injects an endpointTest probe face alongside the scope', async () => {
    let injected: any = null;
    const llm = { discoverModels: vi.fn(async () => ({ ok: true as const, value: [{ id: 'm' }] })) };
    const mockCtx = {
      remote: { llm },
      slots: {
        inject: vi.fn((_slot: string, cb: () => void) => cb()),
        register: vi.fn((_spec: any, _component: any) => {})
      },
      settingsScope: { bind: vi.fn(() => ({ subscribe: vi.fn(), getSnapshot: vi.fn(), set: vi.fn() })) }
    };
    apply(mockCtx);
    // The section spec's inject face carries the probe bindings.
    const spec = mockCtx.slots.register.mock.calls[0][0];
    injected = spec.inject();
    expect(typeof injected.endpointTest?.run).toBe('function');
    expect(typeof injected.endpointTest?.storedBaseURL).toBe('function');
    // The face binds against the apply-time client context: the probe routes
    // through that context's remote.llm namespace.
    const outcome = await injected.endpointTest.run({ provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('ok');
    expect(llm.discoverModels).toHaveBeenCalledOnce();
  });

  describe('formatTrippingDuration', () => {
    it('formats <= 60 minutes as plain minutes', () => {
      expect(formatTrippingDuration(0)).toBe('0m');
      expect(formatTrippingDuration(-5)).toBe('0m');
      expect(formatTrippingDuration(1)).toBe('1m');
      expect(formatTrippingDuration(15)).toBe('15m');
      expect(formatTrippingDuration(45)).toBe('45m');
      expect(formatTrippingDuration(60)).toBe('60m');
    });

    it('formats > 60 minutes as xh xm', () => {
      expect(formatTrippingDuration(61)).toBe('1h 1m');
      expect(formatTrippingDuration(75)).toBe('1h 15m');
      expect(formatTrippingDuration(119)).toBe('1h 59m');
      expect(formatTrippingDuration(120)).toBe('2h');
      expect(formatTrippingDuration(125)).toBe('2h 5m');
      expect(formatTrippingDuration(1300)).toBe('21h 40m');
      expect(formatTrippingDuration(1362)).toBe('22h 42m');
    });
  });
});

