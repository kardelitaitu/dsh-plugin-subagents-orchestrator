import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runEndpointTest,
  storedBaseURL,
  bindEndpointTest,
  composeTimeout,
  DISCOVERY_SETTINGS_NS,
  TEST_TIMEOUT_MS,
  type RemoteLlmFace,
  type RemoteSettingsFace,
  type TestConnectionInput
} from '../src/client/testConnection.js';

afterEach(() => {
  vi.useRealTimers();
});

function okLlm(models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>) {
  const discoverModels = vi.fn(async () => ({ ok: true as const, value: models }));
  return { discoverModels } as unknown as RemoteLlmFace & { discoverModels: ReturnType<typeof vi.fn> };
}

const storedSettings = (providers: unknown) =>
  ({
    describe: vi.fn(async () => ({ ok: true as const, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers } }] } }))
  }) as unknown as RemoteSettingsFace & { describe: ReturnType<typeof vi.fn> };

describe('runEndpointTest', () => {
  it('reports unavailable when the remote.llm face is absent', async () => {
    const outcome = await runEndpointTest({ llm: null }, { provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('unavailable');
  });

  it('reports unavailable when the face has no discoverModels callable', async () => {
    const outcome = await runEndpointTest({ llm: {} as RemoteLlmFace }, { provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('unavailable');
  });

  it('probes the llm-pi-ai discovery with a draft carrying provider + baseURL', async () => {
    const llm = okLlm([{ id: 'glm-5.3-flash', contextWindow: 200000 }]);
    const outcome = await runEndpointTest(
      { llm },
      { provider: 'b-ai-1', model: 'glm-5.3-flash', baseURL: 'https://api.example.com/v1' }
    );
    expect(llm.discoverModels).toHaveBeenCalledOnce();
    const [ns, request] = llm.discoverModels.mock.calls[0];
    expect(ns).toBe(DISCOVERY_SETTINGS_NS);
    expect(request).toEqual({ provider: 'b-ai-1', baseURL: 'https://api.example.com/v1' });
    expect(outcome).toMatchObject({ status: 'ok', modelFound: true, modelContextWindow: 200000 });
    expect(outcome.status === 'ok' && typeof outcome.latencyMs === 'number').toBe(true);
  });

  it('reports modelFound=false without a context window when the model is not advertised', async () => {
    const llm = okLlm([{ id: 'other-model' }]);
    const outcome = await runEndpointTest({ llm }, { provider: 'p', model: 'glm-5.3-flash', baseURL: 'https://x' });
    expect(outcome).toMatchObject({ status: 'ok', modelFound: false });
    expect('modelContextWindow' in outcome).toBe(false);
  });

  it('reports modelFound=null when the row has no model (draft probe)', async () => {
    const llm = okLlm([{ id: 'm' }]);
    const input: TestConnectionInput = { provider: 'p', baseURL: 'https://x' };
    const outcome = await runEndpointTest({ llm }, input);
    expect(outcome.status === 'ok' && outcome.modelFound === null).toBe(true);
  });

  it('maps a refused call to a fail outcome with the error message and latency', async () => {
    const llm = {
      discoverModels: vi.fn(async () => ({ ok: false as const, error: { message: 'could not reach https://x', code: 'llm/model-discovery-rejected' } }))
    } as unknown as RemoteLlmFace;
    const outcome = await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' });
    expect(outcome).toMatchObject({ status: 'fail', message: 'could not reach https://x' });
    expect(outcome.status === 'fail' && typeof outcome.latencyMs === 'number').toBe(true);
  });

  it('maps a thrown call to a fail outcome without throwing', async () => {
    const llm = { discoverModels: vi.fn(async () => { throw new Error('wire broke'); }) } as unknown as RemoteLlmFace;
    const outcome = await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' });
    expect(outcome).toMatchObject({ status: 'fail', message: 'wire broke' });
  });

  it('forwards the draft apiKey only when supplied', async () => {
    const llm = okLlm([]);
    await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x', apiKey: 'sk-secret' });
    expect(llm.discoverModels.mock.calls[0][1]).toEqual({ provider: 'p', baseURL: 'https://x', apiKey: 'sk-secret' });
    await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' });
    expect(llm.discoverModels.mock.calls[1][1]).toEqual({ provider: 'p', baseURL: 'https://x' });
  });

  it('falls back to the stored profile baseURL and never sends an empty draft', async () => {
    const llm = okLlm([]);
    const settings = storedSettings({ 'b-ai-1': { baseURL: 'https://stored.example.com/v1' } });
    const outcome = await runEndpointTest({ llm, settings }, { provider: 'b-ai-1' });
    expect(llm.discoverModels.mock.calls[0][1]).toEqual({ provider: 'b-ai-1', baseURL: 'https://stored.example.com/v1' });
    expect(outcome.status).toBe('ok');
  });

  it('fails with guidance when no baseURL is available anywhere', async () => {
    const llm = okLlm([]);
    const settings = storedSettings({});
    const outcome = await runEndpointTest({ llm, settings }, { provider: 'b-ai-1' });
    expect(outcome).toMatchObject({ status: 'fail' });
    expect(outcome.status === 'fail' && outcome.message).toContain('baseURL');
    expect(llm.discoverModels).not.toHaveBeenCalled();
  });

  it('ignores a describe() refusal when resolving the stored baseURL', async () => {
    const llm = okLlm([]);
    const settings = { describe: vi.fn(async () => ({ ok: false as const, error: { message: 'no provider' } })) } as unknown as RemoteSettingsFace;
    const outcome = await runEndpointTest({ llm, settings }, { provider: 'p' });
    expect(outcome.status).toBe('fail');
    expect(llm.discoverModels).not.toHaveBeenCalled();
  });

  it('passes the composed signal through to the discovery call', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const llm = {
      discoverModels: vi.fn(async (_ns: string, _req: unknown, signal?: AbortSignal) => {
        seen.push(signal);
        return { ok: true as const, value: [] };
      })
    } as unknown as RemoteLlmFace;
    const controller = new AbortController();
    await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' }, controller.signal);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
  });

  it('aborts the probe at the client-side timeout and surfaces a fail outcome', async () => {
    vi.useFakeTimers();
    const llm = {
      discoverModels: vi.fn((_ns: string, _req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error(signal.reason?.message ?? 'aborted')), { once: true });
        })
      )
    } as unknown as RemoteLlmFace;
    const pending = runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' });
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 1);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'fail', message: 'test connection timed out' });
  });

  it('honors a pre-aborted caller signal', async () => {
    const llm = {
      discoverModels: vi.fn((_ns: string, _req: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          if (signal?.aborted) reject(new Error('cancelled'));
        })
      )
    } as unknown as RemoteLlmFace;
    const controller = new AbortController();
    controller.abort();
    const outcome = await runEndpointTest({ llm }, { provider: 'p', baseURL: 'https://x' }, controller.signal);
    expect(outcome.status).toBe('fail');
  });
});

describe('storedBaseURL', () => {
  it('returns undefined for an absent face or a describe() that throws', async () => {
    expect(await storedBaseURL(null, 'p')).toBeUndefined();
    expect(await storedBaseURL(undefined, 'p')).toBeUndefined();
    const throwing = { describe: vi.fn(async () => { throw new Error('x'); }) } as unknown as RemoteSettingsFace;
    expect(await storedBaseURL(throwing, 'p')).toBeUndefined();
  });

  it('reads the provider record and tolerates malformed sections', async () => {
    expect(await storedBaseURL(storedSettings({ p: { baseURL: 'https://ok' } }), 'p')).toBe('https://ok');
    expect(await storedBaseURL(storedSettings({ p: {} }), 'p')).toBeUndefined();
    expect(await storedBaseURL(storedSettings({ p: { baseURL: '   ' } }), 'p')).toBeUndefined();
    expect(await storedBaseURL(storedSettings('not-an-object'), 'p')).toBeUndefined();
    expect(await storedBaseURL(storedSettings(null), 'p')).toBeUndefined();
    const noNamespace = {
      describe: vi.fn(async () => ({ ok: true as const, value: { namespaces: [] } }))
    } as unknown as RemoteSettingsFace;
    expect(await storedBaseURL(noNamespace, 'p')).toBeUndefined();
  });
});

describe('bindEndpointTest (slot-injected face)', () => {
  it('runs the probe against lazily resolved remote faces', async () => {
    const llm = okLlm([{ id: 'm' }]);
    const ctx = { remote: { llm, settings: storedSettings({}) } };
    const face = bindEndpointTest(ctx);
    const outcome = await face.run({ provider: 'p', model: 'm', baseURL: 'https://x' });
    expect(outcome.status).toBe('ok');
  });

  it('degrades to unavailable when the client context has no remote service', async () => {
    const face = bindEndpointTest({});
    const outcome = await face.run({ provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('unavailable');
  });

  it('degrades to unavailable when resolving ctx.remote throws', async () => {
    const face = bindEndpointTest({
      get remote(): never {
        throw new Error('cannot get property "remote" without inject');
      }
    });
    const outcome = await face.run({ provider: 'p', baseURL: 'https://x' });
    expect(outcome.status).toBe('unavailable');
  });

  it('resolves storedBaseURL through the same lazy face', async () => {
    const settings = storedSettings({ p: { baseURL: 'https://stored' } });
    const face = bindEndpointTest({ remote: { settings } });
    expect(await face.storedBaseURL('p')).toBe('https://stored');
  });
});

describe('composeTimeout', () => {
  it('aborts the composed signal at the deadline and disposes cleanly', async () => {
    vi.useFakeTimers();
    const composed = composeTimeout(undefined, 50);
    const observer = vi.fn();
    composed.signal.addEventListener('abort', observer, { once: true });
    vi.advanceTimersByTime(51);
    expect(composed.signal.aborted).toBe(true);
    expect(observer).toHaveBeenCalledOnce();
    composed.dispose();
  });

  it('mirrors a caller abort immediately and removes the listener on dispose', () => {
    const caller = new AbortController();
    const composed = composeTimeout(caller.signal, 10_000);
    caller.abort();
    expect(composed.signal.aborted).toBe(true);
    composed.dispose();
  });
});
