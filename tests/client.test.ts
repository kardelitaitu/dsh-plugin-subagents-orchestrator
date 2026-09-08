import { describe, it, expect, vi } from 'vitest';
import { apply, inject, NS, PLUGIN_ID } from '../src/client/index.jsx';

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
});
