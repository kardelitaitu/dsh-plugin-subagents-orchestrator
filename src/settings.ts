import z from '@deepseek-ai/schemastery';
import { getConfig } from './config.js';

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
 * Schema of the panel-editable fields. Deliberately narrower than
 * `parseConfigDocument`: the `endpoints`/`fallback` lists stay out of the
 * form (list editing is Tier C), and schemastery's non-strict objects keep
 * unknown keys untouched so sections holding them still validate.
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
    })
  });

export interface SettingsPanelContext {
  /** Cordis service injection; never fires when 'settings' is not composed. */
  inject(deps: string[], cb: (sctx: unknown) => void): void;
}

export interface SettingsService {
  register(ns: string, schema: unknown, options?: { base?: unknown }): {
    get(): unknown;
    watch(cb: (next: unknown) => void): void;
  };
}

/**
 * Register the settings panel when the config opts in. Returns whether the
 * registration was armed. Never throws: a rejected registration (malformed
 * stored section) must not break orchestration, which keeps working through
 * the YAML cache.
 */
export function armSettingsPanel(ctx: SettingsPanelContext): boolean {
  const config = getConfig();
  if (config?.ui?.panel !== true) return false;

  ctx.inject(['settings'], (sctx) => {
    const settings = (sctx as { settings?: SettingsService } | null)?.settings;
    if (!settings) return;
    try {
      settings.register(ORCHESTRATOR_SETTINGS_NAMESPACE, orchestratorSettingsSchema, { base: {} });
    } catch {
      // A stored section our schema rejects would fail registration loud;
      // degrade to the plain YAML path instead of failing the plugin.
    }
  });
  return true;
}
