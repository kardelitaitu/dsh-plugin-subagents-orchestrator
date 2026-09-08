/**
 * "Test Connection" plumbing for the settings panel client half.
 *
 * Verified contract (read out of the installed host packages, DSH
 * 0.1.2-rc.1): the client bundle can call the host through the Typert
 * Remote namespaces that dsh-api-remotes mounts for every first-party
 * controller. Two of them power the probe:
 *
 * - remote.llm.discoverModels(settingsNs, request, signal?) — interrogates
 *   a DRAFT endpoint ("nothing here reads or writes settings or
 *   credentials — the caller owns both"). Under the llm-pi-ai discovery
 *   implementation a draft carrying a baseURL performs a live GET
 *   {baseURL}/models and maps 401/403 to an explicit "check the API key"
 *   failure; a draft naming a provider without a shipped catalog resolves
 *   that profile's stored credential host-side, so the panel never needs
 *   the secret. This is the roadmap's "live ping and token check": reach
 *   the endpoint, learn the models it serves, and report whether the
 *   configured model (with its context window) is among them.
 * - remote.settings.describe() — read-only, secret-redacted view of every
 *   settings namespace. Used only to prefill the draft baseURL for a
 *   provider whose llm-pi-ai profile already stores one.
 *
 * Both calls return { ok: true, value } | { ok: false, error } envelopes;
 * neither mutates any host state, so probing can never trip a breaker or
 * transition probation (ARCHITECTURE.md §5 design rule).
 */

/** Settings namespace whose discovery implementation serves OpenAI-compatible drafts. */
export const DISCOVERY_SETTINGS_NS = 'llm-pi-ai';

/** Shape of one entry of the discoverModels result (llm draft interrogation). */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** Minimal structural face of the client-mounted remote.llm namespace service. */
export interface RemoteLlmFace {
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
    signal?: AbortSignal
  ): Promise<{ ok: true; value: DiscoveredModel[] } | { ok: false; error: { message: string; code?: string } }>;
}

/** Minimal structural face of the client-mounted remote.settings namespace service. */
export interface RemoteSettingsFace {
  describe(): Promise<{
    ok: true;
    value: { namespaces?: Array<{ ns?: string; value?: unknown }> };
  } | { ok: false; error: { message: string; code?: string } }>;
}

/** Endpoint row (or draft row) the user asked to test. */
export interface TestConnectionInput {
  provider: string;
  model?: string;
  /** Draft baseURL; when absent, a stored llm-pi-ai profile baseURL is used. */
  baseURL?: string;
  /** One-shot draft credential; when absent, the stored profile key resolves host-side. */
  apiKey?: string;
}

export type TestConnectionOutcome =
  | {
      status: 'ok';
      /** Models the endpoint advertises (endpoint order, deduplicated host-side). */
      models: DiscoveredModel[];
      /** Whether the configured model id is among the advertised ones; null when no model given. */
      modelFound: boolean | null;
      /** Context window the endpoint disclosed for the configured model, when present. */
      modelContextWindow?: number;
      latencyMs: number;
    }
  | { status: 'fail'; message: string; latencyMs?: number }
  | { status: 'unavailable'; message: string };

/** Faces the probe needs; absent faces degrade to an explicit 'unavailable' outcome. */
export interface TestConnectionFaces {
  llm?: RemoteLlmFace | null;
  settings?: RemoteSettingsFace | null;
}

/** Default probe budget: an endpoint that cannot answer /models in 15s is down. */
export const TEST_TIMEOUT_MS = 15_000;

/**
 * Read one provider's stored baseURL out of the redacted settings describe()
 * view (llm-pi-ai stores it per provider record: { providers: { [id]: { baseURL } } }).
 * Returns undefined when the face is absent, the namespace is missing, or the
 * profile has no baseURL — callers fall back to asking the user.
 */
export async function storedBaseURL(settings: RemoteSettingsFace | null | undefined, provider: string): Promise<string | undefined> {
  if (!settings) return undefined;
  let described: Awaited<ReturnType<RemoteSettingsFace['describe']>>;
  try {
    described = await settings.describe();
  } catch {
    return undefined;
  }
  if (!described.ok) return undefined;
  const namespace = (described.value?.namespaces ?? []).find((ns) => ns?.ns === DISCOVERY_SETTINGS_NS);
  const value = namespace?.value as { providers?: Record<string, { baseURL?: unknown }> | unknown } | undefined;
  const providers = value?.providers;
  if (!providers || typeof providers !== 'object') return undefined;
  const record = (providers as Record<string, { baseURL?: unknown }>)[provider];
  if (!record || typeof record !== 'object') return undefined;
  const baseURL = (record as { baseURL?: unknown }).baseURL;
  return typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL : undefined;
}

/**
 * Compose a caller signal with a client-side timeout without relying on
 * AbortSignal.any/timeout (both newer than the bundle's chrome100 target).
 * Returns the composed signal plus a disposer that must run in a finally.
 */
/**
 * Resolve one client-mounted Typert Remote namespace lazily, at call time.
 * The host client bundle mounts `remote.llm` / `remote.settings` when
 * dsh-api-remotes applies — possibly after this plugin — and an older host
 * may not mount them at all, in which case `ctx.remote` itself can throw
 * (cordis refuses property access on unprovided services). Every failure
 * degrades to a null face and the probe reports 'unavailable'.
 */
function remoteFace(ctx: unknown, name: 'llm' | 'settings'): unknown | null {
  try {
    return (ctx as { remote?: Record<string, unknown> } | null | undefined)?.remote?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Slot-injected probe face for the settings section: `run` executes one probe
 * against the live remote faces and `storedBaseURL` resolves a provider's
 * stored profile baseURL. Neither ever throws.
 */
export function bindEndpointTest(ctx: unknown) {
  return {
    run: (input: TestConnectionInput, signal?: AbortSignal) =>
      runEndpointTest(
        { llm: remoteFace(ctx, 'llm') as RemoteLlmFace | null, settings: remoteFace(ctx, 'settings') as RemoteSettingsFace | null },
        input,
        signal
      ),
    storedBaseURL: (provider: string) => storedBaseURL(remoteFace(ctx, 'settings') as RemoteSettingsFace | null, provider)
  };
}

/**
 * Compose a caller signal with a client-side timeout without relying on
 * AbortSignal.any/timeout (both newer than the bundle's chrome100 target).
 * Returns the composed signal plus a disposer that must run in a finally.
 */
export function composeTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('test connection timed out')), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  };
}

/**
 * Run one endpoint probe. Never throws: every failure mode resolves to a
 * structured outcome the panel can render, keeping the click handler simple.
 */
export async function runEndpointTest(
  faces: TestConnectionFaces,
  input: TestConnectionInput,
  signal?: AbortSignal
): Promise<TestConnectionOutcome> {
  const llm = faces.llm;
  if (!llm || typeof llm.discoverModels !== 'function') {
    return { status: 'unavailable', message: 'This DSH build does not expose the remote.llm probe channel to plugin panels.' };
  }

  let baseURL = input.baseURL?.trim();
  if (!baseURL) baseURL = await storedBaseURL(faces.settings, input.provider);
  if (!baseURL) {
    return { status: 'fail', message: 'No baseURL to probe: enter one, or add this provider to the Models settings first.' };
  }

  const composed = composeTimeout(signal, TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await llm.discoverModels(
      DISCOVERY_SETTINGS_NS,
      {
        provider: input.provider,
        baseURL,
        ...(input.apiKey ? { apiKey: input.apiKey } : {})
      },
      composed.signal
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { status: 'fail', message: response.error?.message || 'The probe was refused without a message.', latencyMs };
    }
    const models = Array.isArray(response.value) ? response.value : [];
    if (!input.model) {
      return { status: 'ok', models, modelFound: null, latencyMs };
    }
    const configured = models.find((model) => model?.id === input.model);
    return {
      status: 'ok',
      models,
      modelFound: Boolean(configured),
      ...(configured?.contextWindow !== undefined ? { modelContextWindow: configured.contextWindow } : {}),
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
      latencyMs
    };
  } finally {
    composed.dispose();
  }
}
