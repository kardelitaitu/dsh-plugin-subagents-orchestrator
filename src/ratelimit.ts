import type { FailureInfo } from './types.js';

/** Hard ceiling for any provider-derived cooldown (24 hours). */
export const MAX_HINT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const RETRY_AFTER_HEADERS = ['retry-after'];
const RATE_LIMIT_RESET_HEADERS = ['x-ratelimit-reset', 'ratelimit-reset'];

/**
 * Parse an explicit reset timestamp or duration from provider error messages.
 * Examples:
 * - "your usage will reset at 2026-09-24 05:17:08 UTC+8"
 * - "resets at 2026-09-23 12:00:00Z"
 * - "resets in 45 seconds" / "resets in 15 minutes" / "resets in 2 hours"
 */
export function parseResetTimestampMs(text: string | null | undefined, now: number = Date.now()): number | null {
  if (!text || typeof text !== 'string') return null;

  // 1. "reset at 2026-09-24 05:17:08 UTC+8" or ISO format
  const atMatch = text.match(/resets?\s+at\s+(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}:\d{2})(\.\d+)?\s*(UTC[+-]\d{1,2}(?::?\d{2})?|GMT[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|Z)?/i);
  if (atMatch) {
    const datePart = atMatch[1];
    const timePart = atMatch[2];
    const fracPart = atMatch[3] || '';
    const tzPart = atMatch[4];
    let iso = `${datePart}T${timePart}${fracPart}`;
    if (tzPart) {
      const tzMatch = tzPart.match(/(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?/i);
      if (tzMatch) {
        const sign = tzMatch[1];
        const hours = tzMatch[2].padStart(2, '0');
        const mins = (tzMatch[3] || '00').padStart(2, '0');
        iso += `${sign}${hours}:${mins}`;
      } else if (tzPart.toUpperCase() === 'Z') {
        iso += 'Z';
      }
    }
    const when = Date.parse(iso);
    if (!Number.isNaN(when) && when > now) {
      return when - now;
    }
  }

  // 2. "resets in 45 seconds" / "resets in 15 minutes" / "resets in 2 hours"
  const inMatch = text.match(/resets?\s+in\s+(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i);
  if (inMatch) {
    const amount = parseFloat(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    let mult = 1000;
    if (unit.startsWith('m')) mult = 60 * 1000;
    else if (unit.startsWith('h')) mult = 3600 * 1000;
    return Math.round(amount * mult);
  }

  return null;
}

function pickHeader(headers: Record<string, string> | undefined, names: string[]): string | null {
  if (!headers) return null;
  for (const name of names) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== name) continue;
      const value = headers[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

/** Epoch milliseconds (>1e12), epoch seconds (>1e9), or null when the value is neither. */
function toEpochMs(value: number): number | null {
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1000;
  return null;
}

/**
 * Host-supplied failure fields are not type-checked at the plugin boundary, so
 * coerce defensively: a non-string message/code yields '' (no match) rather
 * than throwing inside the failover error handler.
 */
function asLower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function asUpper(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

/**
 * Derive an exact cooldown window (ms) from a provider failure.
 *
 * Understood signals, in priority order:
 * 0. `failure.providerRetryAfterMs` — already parsed and validated by the
 *    host's LLM layer (dsh-llm) from the provider's `retry-after` header;
 *    taken as-is when present and within the cap.
 * 1. `Retry-After` header — delta seconds, or an HTTP-date.
 * 2. `x-ratelimit-reset` / `ratelimit-reset` headers — delta seconds, epoch
 *    seconds, or epoch milliseconds (disambiguated by magnitude).
 * 3. Text in `failure.message` or response body mentioning "reset at <time>"
 *    or "resets in <duration>".
 *
 * @returns cooldown in ms clamped to `[0, MAX_HINT_COOLDOWN_MS]`, or `null`
 *          when the failure carries no usable rate-limit information.
 */
export function extractCooldownHintMs(
  failure: FailureInfo | null | undefined,
  now: number = Date.now()
): number | null {
  if (!failure) return null;

  // Host-parsed hint (dsh-llm validates it as a positive finite ms value).
  const hostHint = failure.providerRetryAfterMs;
  if (typeof hostHint === 'number' && Number.isFinite(hostHint) && hostHint > 0) {
    if (hostHint <= MAX_HINT_COOLDOWN_MS) return hostHint;
    return MAX_HINT_COOLDOWN_MS;
  }

  const response = failure.response as { headers?: Record<string, string>; data?: any } | undefined;
  const sources = [failure.headers, response?.headers];

  let hintMs: number | null = null;

  const retryAfter = sources.map((h) => pickHeader(h, RETRY_AFTER_HEADERS)).find((v) => v !== null);
  if (retryAfter != null) {
    const asSeconds = Number(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      hintMs = asSeconds * 1000;
    } else {
      const when = Date.parse(retryAfter);
      if (!Number.isNaN(when)) hintMs = Math.max(0, when - now);
    }
  }

  if (hintMs === null) {
    const reset = sources.map((h) => pickHeader(h, RATE_LIMIT_RESET_HEADERS)).find((v) => v !== null);
    if (reset != null) {
      const value = Number(reset);
      if (Number.isFinite(value) && value >= 0) {
        const epochMs = toEpochMs(value);
        // Small values are delta seconds; large ones are absolute timestamps.
        hintMs = epochMs !== null ? Math.max(0, epochMs - now) : value * 1000;
      }
    }
  }

  if (hintMs === null) {
    // Check error message or response body for explicit reset timestamps
    const rawMsg =
      failure.message ||
      (failure as any).error?.message ||
      (typeof response?.data === 'string' ? response.data : response?.data?.msg || response?.data?.message);
    if (typeof rawMsg === 'string') {
      hintMs = parseResetTimestampMs(rawMsg, now);
    }
  }

  if (hintMs === null) return null;
  return Math.min(Math.max(0, hintMs), MAX_HINT_COOLDOWN_MS);
}

/**
 * Detect explicit rate limit or quota exhaustion that should trip immediately
 * (threshold: 1) rather than requiring multiple consecutive failures.
 */
export function isHardRateLimitError(failure: FailureInfo | null | undefined): boolean {
  if (!failure) return false;
  const msg = asLower(failure.message);
  const code = asUpper(failure.code);

  if (code === 'QUOTA' || code === 'RATE_LIMIT' || code === 'INSUFFICIENT_QUOTA' || (failure.status === 429)) {
    if (
      msg.includes('frequency limit') ||
      msg.includes('6004') ||
      msg.includes('rate limit exceeded') ||
      msg.includes('exceeds frequency') ||
      msg.includes('insufficient_quota') ||
      msg.includes('insufficient quota') ||
      msg.includes('daily request limit') ||
      msg.includes('out of credits') ||
      msg.includes('reset at')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detect account-wide rate limits (e.g. CodeBuddy account token/request limit)
 * that affect all models under that provider, rather than a single model frequency limit.
 */
export function isAccountLevelRateLimit(failure: FailureInfo | null | undefined): boolean {
  if (!failure) return false;
  const msg = asLower(failure.message);
  // If the message specifically mentions "switch to the other models", it's MODEL-SPECIFIC, not account-level!
  if (msg.includes('switch to the other models') || msg.includes('switch to other models') || msg.includes('6004')) {
    return false;
  }
  if (
    msg.includes('codebuddy api rate limit exceeded') ||
    msg.includes('account rate limit') ||
    msg.includes('daily request limit')
  ) {
    return true;
  }
  return false;
}


/**
 * Detect client-side errors that reflect prompt or parameter issues rather than
 * endpoint infrastructure outages (400 Bad Request, context length exceeded, etc).
 * These must never trip the circuit breaker.
 */
export function isClientSideError(failure: FailureInfo | null | undefined): boolean {
  if (!failure) return false;

  const status = (failure.status ?? (failure.response as { status?: unknown })?.status) as number | undefined;
  if (status === 400 || status === 422) return true;

  const code = asUpper(failure.code);
  if (code === 'BAD_REQUEST' || code === 'INVALID_REQUEST' || code === 'CONTEXT_LENGTH') return true;

  const msg = asLower(failure.message);
  if (
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('prompt is too long') ||
    msg.includes('token count exceeds') ||
    msg.includes('invalid parameter') ||
    msg.includes('unsupported parameter')
  ) {
    return true;
  }

  return false;
}
