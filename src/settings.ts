import z from '@deepseek-ai/schemastery';
import { getConfig } from './config.js';
import { defaultCircuitBreaker } from './health.js';

/**
 * DSH settings-surface integration (Tier B): register the orchestrator's
 * configuration as a first-class settings namespace so the host settings UI
 * renders an editable panel for it.
 *
 * Opt-in via the `ui.panel` config flag: the namespace is registered only
 * when the (already loaded) config asks for it, so the plugin stays invisible
 * by default. Decided once at apply time; flipping the flag requires a plugin
 * reload.
 *
 * The write loop closes without any client code: panel edits go through
 * `ctx.settings.update()`, the settings file provider persists them to
 * ~/.dsh/settings.yaml, and our own debounced `fs.watch` reloads the
 * zero-I/O cache from that same file. If the settings service is not
 * composed (headless runs), `ctx.inject` never fires and nothing changes.
 */

/** DSH settings namespace: matches the YAML section key in settings.yaml. */
export const ORCHESTRATOR_SETTINGS_NAMESPACE = 'subagents-orchestrator';

/**
 * Declaration-emit-friendly shape for the exported schemastery schemas: the
 * panel never consumes schemastery's inferred type (whose nameable form
 * drags cosmokit internals into the public surface), it only hands the
 * schema to `ctx.settings.register(unknown)` and tests may call it.
 */
export type SettingsSchema = (data: unknown) => unknown;

/**
 * One panel-editable endpoint. Mirrors the YAML `Endpoint` shape minus the
 * fields the panel has no business editing (nothing secret, nothing the
 * runtime derives): provider/model identity, routing weight, and the park
 * toggle. Unknown keys on stored entries survive validation (schemastery
 * non-strict dicts), so YAML-only fields like `reasoningEffort` pass through.
 */
export const endpointSettingsSchema = z
  .object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
    weight: z.number(),
    enabled: z.boolean()
  }) as unknown as SettingsSchema;

/**
 * Schema of the panel-editable fields, including the Tier C endpoint lists.
 * Items failing the entry schema are dropped during validation rather than
 * poisoning the whole section (matching parseConfigDocument's filter spirit);
 * schemastery's non-strict objects keep extra section keys untouched.
 */
export const orchestratorSettingsSchema = z
  .object({
    enabled: z.boolean(),
    strategy: z.string(),
    failover: z.boolean(),
    cooldownMs: z.number(),
    maxFailures: z.number(),
    maxRetries: z.number(),
    intervalMinMs: z.number(),
    intervalMaxMs: z.number(),
    debug: z.boolean(),
    persistTelemetry: z.boolean(),
    ui: z.object({
      toasts: z.boolean(),
      panel: z.boolean()
    }),
    endpoints: z.array(endpointSettingsSchema),
    fallback: z.array(endpointSettingsSchema),
    alignHourly: z.boolean(),
    quarantines: z.dict(z.number())
  }) as unknown as SettingsSchema;

export interface SettingsPanelContext {
  /** Cordis service injection; never fires when 'settings' is not composed. */
  inject(deps: string[], cb: (sctx: unknown) => void): void;
}

export interface SettingsRegistrationScope {
  get(): unknown;
  watch(cb: (next: unknown) => void): (() => void) | void;
  update?(patch: unknown): Promise<unknown>;
  replace?(section: unknown): Promise<unknown>;
}

export interface SettingsService {
  register(ns: string, schema: unknown, options?: { base?: unknown }): SettingsRegistrationScope;
  update?(ns: string, patch: unknown, expectedRevision?: unknown): Promise<unknown>;
  mutate?(ns: string, ops: unknown[], expectedRevision?: unknown): Promise<unknown>;
}

let activeSettingsService: SettingsService | null = null;
let activeRegistrationScope: SettingsRegistrationScope | null = null;
let activeWatchDispose: (() => void) | null = null;

/**
 * Stop the currently installed scope watch, if any.
 *
 * `scope.watch()` hands back an unsubscribe; discarding it meant a torn-down
 * composition's watch kept applying stale quarantines to the process-wide
 * breaker. A disposer that throws must not break dispose either.
 */
function releaseActiveWatch(): void {
  const stop = activeWatchDispose;
  activeWatchDispose = null;
  if (stop) {
    try {
      stop();
    } catch {
      // A broken host disposer is not our failure to propagate.
    }
  }
}

export function getActiveSettingsService(): SettingsService | null {
  return activeSettingsService;
}

export function getActiveRegistrationScope(): SettingsRegistrationScope | null {
  return activeRegistrationScope;
}

export function resetSettingsForTest(): void {
  releaseActiveWatch();
  activeSettingsService = null;
  activeRegistrationScope = null;
}

/**
 * Release the module-level settings handles on plugin dispose.
 *
 * These are module singletons, so a host reload (dispose -> apply) would
 * otherwise keep writing through the PREVIOUS composition's registration -
 * a handle the host has already torn down. Clearing them makes the next
 * apply() resolve the live service instead of a dead one.
 */
export function disposeSettings(): void {
  releaseActiveWatch();
  activeSettingsService = null;
  activeRegistrationScope = null;
}

/**
 * A persisted quarantine map is a plain keyed object of numeric timestamps.
 *
 * An ARRAY satisfies a bare `typeof === 'object'` check but is not a keyed
 * map: handing one to applyQuarantines reads as an authoritative-empty
 * snapshot and silently clears every live quarantine. The schema rejects
 * arrays, but scope.get() and the watch payload are host-supplied and not
 * guaranteed to have been validated, so the guard belongs here.
 */
function isQuarantineMap(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Only a plain keyed map counts. A Date, Map, Set, typed array or class
  // instance is also "typeof object", and Object.entries() over one yields no
  // usable keys — so handing it to applyQuarantines reads as an
  // authoritative-empty snapshot and clears every live quarantine. The
  // null-prototype form is accepted (Object.create(null) is still a keyed map).
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Register the settings panel when the config opts in. Returns whether the
 * registration was armed. Never throws: a rejected registration (malformed
 * stored section), a throwing host inject() or a throwing scope.watch() must
 * not break orchestration, which keeps working through the YAML cache.
 */
export function armSettingsPanel(ctx: SettingsPanelContext): boolean {
  const config = getConfig();
  if (config?.ui?.panel !== true) return false;

  try {
    ctx.inject(['settings'], (sctx) => {
      const settings = (sctx as { settings?: SettingsService } | null)?.settings;
      if (!settings) return;
      activeSettingsService = settings;
      try {
        const scope = settings.register(ORCHESTRATOR_SETTINGS_NAMESPACE, orchestratorSettingsSchema, { base: {} });
        activeRegistrationScope = scope;

        // Hydrate circuit breaker from persisted settings if present.
        // Best-effort in its OWN try: a host whose stored section cannot be
        // read back (get() throwing - exactly the malformed-section case this
        // file guards against) must not take the live watch down with it, or
        // UI -> breaker propagation is silently dead for the whole session.
        try {
          const snap = scope?.get?.() as any;
          if (isQuarantineMap(snap?.quarantines)) {
            defaultCircuitBreaker.applyQuarantines(snap.quarantines);
          }
        } catch {
          // Hydration only; the watch below is the panel's actual purpose.
        }

        // Watch for settings changes from UI. Best-effort in its OWN try,
        // exactly like the hydration above: register() has already succeeded,
        // so a host whose watch() throws must NOT be mistaken for a failed
        // registration - that would discard the live scope and lose the only
        // persistence path (scope.update). Only register() failing is fatal.
        try {
          // A re-arm replaces the previous composition's watch rather than
          // leaking it.
          releaseActiveWatch();
          const stopWatch = scope?.watch?.((next: any) => {
            try {
              if (next && typeof next === 'object' && !Array.isArray(next) && 'quarantines' in next) {
                const incoming = next.quarantines;
                if (isQuarantineMap(incoming)) {
                  defaultCircuitBreaker.applyQuarantines(incoming);
                } else if (incoming === null || incoming === undefined) {
                  // Key present but empty: an explicit "no quarantines" reset.
                  defaultCircuitBreaker.applyQuarantines({});
                }
                // Any other shape (array/string/number/...) is not a keyed map:
                // ignore it rather than mistaking it for "no quarantines".
              }
            } catch {
              // A payload accessor that throws must not escape into the host
              // notification loop.
            }
          });
          activeWatchDispose = typeof stopWatch === 'function' ? stopWatch : null;
        } catch {
          // Watch installation only; the registration above stays live.
        }
      } catch {
        // A stored section our schema rejects would fail registration loud;
        // degrade to the plain YAML path instead of failing the plugin. The
        // previous composition's scope/watch must NOT survive as the active
        // handle: persist would then write through a registration the host has
        // already replaced, and the dead watch would keep applying stale state.
        activeRegistrationScope = null;
        releaseActiveWatch();
      }
    });
  } catch {
    // A host inject() that throws must not break plugin composition: the
    // "never throws" contract this entry point documents.
  }
  return true;
}

/**
 * Persist quarantine map into ~/.dsh/settings.yaml through host settings service.
 */
export async function persistQuarantines(quarantines: Record<string, number>): Promise<void> {
  try {
    if (activeSettingsService?.mutate) {
      await activeSettingsService.mutate(ORCHESTRATOR_SETTINGS_NAMESPACE, [
        { op: 'set', path: ['quarantines'], value: quarantines }
      ]);
    } else if (activeRegistrationScope?.update) {
      await activeRegistrationScope.update({ quarantines });
    } else if (activeSettingsService?.update) {
      await activeSettingsService.update(ORCHESTRATOR_SETTINGS_NAMESPACE, { quarantines });
    }
  } catch {
    // Non-fatal if settings persistence fails or service not available
  }
}

