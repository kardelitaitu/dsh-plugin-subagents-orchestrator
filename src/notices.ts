/**
 * Failover notices (`ui.toasts: true`): deliver an opt-in, model-facing
 * notice into the failed subagent when the orchestrator commits a failover.
 *
 * The DSH 0.1.1/0.1.2 remote allowlist (`API_REMOTE_FORWARDED_EVENTS`) is
 * closed to third-party plugins, so a live push toast to the web client is
 * not reachable from a plugin. The reachable carrier is `agent.inject()`:
 * it queues model-facing context for the agent's next pre-step WITHOUT
 * waking the driver, so the retried step sees the notice and the transcript
 * renders it as a collapsed plugin-notice row (`source.form: 'notice'`).
 *
 * Message construction goes through `createUserMessage` from
 * `@deepseek-ai/dsh-llm` (fresh stable identity + freeze, matching the
 * first-party dsh-subagent delivery pattern). The import is lazy and
 * optional: a host without a resolvable `@deepseek-ai/dsh-llm` degrades to
 * no notice, never to a broken failover path.
 */

export interface NoticeEndpointRef {
  provider: string;
  model: string;
}

export interface NoticeFailoverInfo {
  from: NoticeEndpointRef;
  to: NoticeEndpointRef;
  /** Failure code that drove the failover, when known. */
  code?: string;
  /** Provider cooldown hint in ms, when one drove the failover. */
  hintMs?: number;
}

/** Minimal contract the plugin needs from `@deepseek-ai/dsh-llm`. */
export interface NoticeModule {
  createUserMessage: (input: {
    content: { type: 'text'; text: string }[];
    source: {
      kind: 'plugin';
      plugin: string;
      form: 'notice';
      summary: string;
    };
  }) => unknown;
  boundContextSummary?: (summary: string) => string;
}

/** Host-bound of the same name; mirrored locally to stay dependency-free. */
export const NOTICE_SUMMARY_MAX_CHARS = 120;

const NOTICE_PLUGIN_ID = 'dsh-plugin-subagents-orchestrator';

let cachedModule: NoticeModule | null | undefined;
let overrideModule: NoticeModule | null | undefined;

/**
 * Resolve the notice support module once. Returns null when
 * `@deepseek-ai/dsh-llm` is not resolvable (standalone installs, unit
 * tests); callers treat null as "notices unavailable".
 */
export async function getNoticeModule(): Promise<NoticeModule | null> {
  if (overrideModule !== undefined) return overrideModule;
  if (cachedModule === undefined) {
    try {
      const specifier = '@deepseek-ai/dsh-llm';
      cachedModule = (await import(/* @vite-ignore */ specifier)) as NoticeModule;
      if (typeof cachedModule?.createUserMessage !== 'function') cachedModule = null;
    } catch {
      cachedModule = null;
    }
  }
  return cachedModule;
}

/** Test hook: pin or clear the notice module (null simulates absence). */
export function setNoticeModuleForTest(mod: NoticeModule | null): void {
  overrideModule = mod;
  cachedModule = undefined;
}

/** Mirror of the host's `boundContextSummary` ellipsis behavior. */
function boundSummary(summary: string): string {
  if (summary.length <= NOTICE_SUMMARY_MAX_CHARS) return summary;
  return summary.slice(0, Math.max(0, NOTICE_SUMMARY_MAX_CHARS - 1)) + '\u2026';
}

/**
 * Build the one-line summary (collapsed transcript row) and the model-facing
 * notice text for a committed failover.
 */
export function buildFailoverNotice(info: NoticeFailoverInfo): { summary: string; text: string } {
  const from = `${info.from.provider}/${info.from.model}`;
  const to = `${info.to.provider}/${info.to.model}`;
  const reason =
    info.code !== undefined && info.hintMs !== undefined
      ? `${info.code}, cooldown hint ${info.hintMs}ms`
      : info.code ?? (info.hintMs !== undefined ? `cooldown hint ${info.hintMs}ms` : 'connection failure');
  const summary = boundSummary(`Failover: ${from} -> ${to} (${reason})`);
  const text =
    `[subagents-orchestrator] The endpoint ${from} failed with ${reason}; ` +
    `your requests are now routed to ${to}. No user action is needed — ` +
    'continue the task; this note is only routing context.';
  return { summary, text };
}

/** Why a notice was or was not delivered (diagnostics + tests). */
export type NoticeDelivery = 'delivered' | 'no-agent-inject' | 'module-unavailable' | 'failed';

/**
 * Deliver the failover notice to `agent`. Best-effort by contract: every
 * failure mode degrades to a reason string and never throws, because a
 * notice must never break the failover that produced it.
 */
export async function deliverFailoverNotice(
  agent: unknown,
  info: NoticeFailoverInfo,
  getModule: () => Promise<NoticeModule | null> = getNoticeModule
): Promise<NoticeDelivery> {
  try {
    const injectable = agent as { inject?: (message: unknown) => void } | null | undefined;
    if (!injectable || typeof injectable.inject !== 'function') return 'no-agent-inject';
    const mod = await getModule();
    if (!mod) return 'module-unavailable';
    const { summary, text } = buildFailoverNotice(info);
    const message = mod.createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: NOTICE_PLUGIN_ID,
        form: 'notice',
        summary: typeof mod.boundContextSummary === 'function' ? mod.boundContextSummary(summary) : summary
      }
    });
    injectable.inject(message);
    return 'delivered';
  } catch {
    return 'failed';
  }
}
