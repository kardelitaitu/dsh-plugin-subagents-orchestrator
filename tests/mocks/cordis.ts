import type { CordisContext, SubagentsService, Agent, SubagentRequest, ContinuableSpec } from '../../src/types.js';

export interface MockEventListener {
  (payload: any, next: () => any): any;
}

export class MockCordisContext implements CordisContext {
  public listeners = new Map<string, MockEventListener[]>();
  public disposables: (() => void)[] = [];
  public subagents: SubagentsService;
  [key: string]: unknown;

  constructor() {
    this.subagents = {
      start: async (name: string, request?: SubagentRequest) => {
        return { started: name, request };
      },
      startContinuable: async (spec?: ContinuableSpec) => {
        return { continued: true, spec };
      }
    };
  }

  inject(deps: string[], callback: (ctx: CordisContext) => void): void {
    callback(this);
  }

  on(event: string, handler: MockEventListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);

    const dispose = () => {
      const list = this.listeners.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
    return dispose;
  }

  effect(callback: () => void | (() => void)): void {
    const cleanup = callback();
    if (typeof cleanup === 'function') {
      this.disposables.push(cleanup);
    }
  }

  async emit(event: string, payload: any, defaultNext: () => any = () => null): Promise<any> {
    const list = this.listeners.get(event) || [];
    let index = 0;

    const next = async (): Promise<any> => {
      if (index < list.length) {
        const handler = list[index++];
        return handler(payload, next);
      }
      return defaultNext();
    };

    return next();
  }

  dispose(): void {
    for (const d of this.disposables.reverse()) {
      d();
    }
    this.disposables = [];
    this.listeners.clear();
  }
}

export function createMockAgent(id: string, origin = 'subagent'): Agent {
  return {
    id,
    session: {
      header: {
        origin
      }
    }
  };
}
