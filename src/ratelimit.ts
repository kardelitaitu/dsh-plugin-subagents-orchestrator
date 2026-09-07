import type { FailureInfo } from './types.js';

/** Hard ceiling for any provider-derived cooldown, so a nonsense header can never stall the pool for hours. */
export const MAX_HINT_COOLDOWN_MS = 15 * 60 * 1000;

const RETRY_AFTER_HEADERS = ['retry-after'];
const RATE_LIMIT_RESET_HEADERS = ['x-ratelimit-reset', 'ratelimit-reset'];

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
 * Derive an exact cooldown window (ms) from a provider failure.
 *
 * Understood signals, in priority order:
 * 0. `failure.providerRetryAfterMs` — already parsed and validated by the
 *    host's LLM layer (dsh-llm) from the provider's `retry-after` header;
 *    taken as-is when present and within the cap.
 * 1. `Retry-After` header — delta seconds, or an HTTP-date.
 * 2. `x-ratelimit-reset` / `ratelimit-reset` headers — delta seconds, epoch
 *    seconds, or epoch milliseconds (disambiguated by magnitude).
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

  const response = failure.response as { headers?: Record<string, string> } | undefined;
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

  if (hintMs === null) return null;
  return Math.min(Math.max(0, hintMs), MAX_HINT_COOLDOWN_MS);
}
