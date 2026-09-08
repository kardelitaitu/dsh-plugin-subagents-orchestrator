import { describe, it, expect, vi } from 'vitest';
import { apply, inject, NS, PLUGIN_ID } from '../src/client/index.jsx';
import { bindEndpointTest } from '../src/client/testConnection.js';

describe('Client Settings Section', () => {
  it('declares slots and settingsScope injection', () => {
    expect(inject).toContain('slots');
    expect(inject).toContain('settingsScope');
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
});
