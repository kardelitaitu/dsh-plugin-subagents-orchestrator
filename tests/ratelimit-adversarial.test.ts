import { describe, it, expect } from 'vitest';
import {
  parseResetTimestampMs,
  extractCooldownHintMs,
  isHardRateLimitError,
  isAccountLevelRateLimit,
  isClientSideError,
  MAX_HINT_COOLDOWN_MS
} from '../src/ratelimit.js';

// =============================================================================
// Adversarial probe file for src/ratelimit.ts  (test-first bug hunt)
// Each describe block = one round. One-line hypothesis comment per test.
// =============================================================================

describe('Round 1: parseResetTimestampMs timezone forms', () => {
  // Baseline: the exact form used by the CodeBuddy 6004 provider error (UTC+8).
  it('UTC+8 whole-hour offset', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const got = parseResetTimestampMs('your usage will reset at 2026-09-24 05:17:08 UTC+8', now);
    expect(got).toBe(Date.parse('2026-09-24T05:17:08+08:00') - now);
  });

  // HYPOTHESIS: tzPart regex 'UTC[+-]\d+' matches 'GMT+5' first, dropping ':30'
  // so the parsed instant is 30 minutes off.
  it('GMT+5:30 keeps its half-hour offset', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23 12:00:00 GMT+5:30', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00+05:30') - now);
  });

  // HYPOTHESIS: same truncation with a leading zero and a colon.
  it('UTC+05:30 keeps its half-hour offset', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC+05:30', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00+05:30') - now);
  });

  it('UTC-8 negative whole-hour offset', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC-8', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00-08:00') - now);
  });

  it('bare +/-HH:MM offset', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23 12:00:00 +05:30', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00+05:30') - now);
  });

  it('bare +/-HHMM offset', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23 12:00:00 +0530', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00+05:30') - now);
  });

  it('bare Z suffix means UTC', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23T12:00:00Z', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00Z') - now);
  });

  // HYPOTHESIS: '(?:\.\d+)?' consumes the fraction then drops it, truncating ms.
  it('fractional seconds with an offset are preserved', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23T12:00:00.250+05:30', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00.250+05:30') - now);
  });

  it('fractional seconds without an offset are preserved', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    const got = parseResetTimestampMs('resets at 2026-09-23T12:00:00.500', now);
    expect(got).toBe(Date.parse('2026-09-23T12:00:00.500') - now);
  });

  // Contract: a reset time already in the past yields null (no cooldown needed).
  it('a reset time in the PAST returns null', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(parseResetTimestampMs('resets at 2026-09-23 09:00:00 UTC+0', now)).toBeNull();
    expect(parseResetTimestampMs('resets at 2026-09-23T09:00:00Z', now)).toBeNull();
  });

  it('null / undefined / empty input returns null', () => {
    expect(parseResetTimestampMs(null)).toBeNull();
    expect(parseResetTimestampMs(undefined)).toBeNull();
    expect(parseResetTimestampMs('')).toBeNull();
  });
});

describe('Round 2: parseResetTimestampMs duration form', () => {
  const NOW = 1_700_000_000_000;

  it('parses seconds/minutes/hours in long form', () => {
    expect(parseResetTimestampMs('resets in 45 seconds', NOW)).toBe(45_000);
    expect(parseResetTimestampMs('resets in 15 minutes', NOW)).toBe(15 * 60_000);
    expect(parseResetTimestampMs('resets in 2 hours', NOW)).toBe(2 * 3_600_000);
  });

  it('parses the abbreviated unit prefixes s / m / h', () => {
    expect(parseResetTimestampMs('resets in 30 s', NOW)).toBe(30_000);
    expect(parseResetTimestampMs('resets in 30 m', NOW)).toBe(30 * 60_000);
    expect(parseResetTimestampMs('resets in 3 h', NOW)).toBe(3 * 3_600_000);
  });

  it('parses sec/min/hr variants', () => {
    expect(parseResetTimestampMs('resets in 5 sec', NOW)).toBe(5_000);
    expect(parseResetTimestampMs('resets in 5 secs', NOW)).toBe(5_000);
    expect(parseResetTimestampMs('resets in 5 min', NOW)).toBe(5 * 60_000);
    expect(parseResetTimestampMs('resets in 5 minute', NOW)).toBe(5 * 60_000);
    expect(parseResetTimestampMs('resets in 5 mins', NOW)).toBe(5 * 60_000);
    expect(parseResetTimestampMs('resets in 5 hr', NOW)).toBe(5 * 3_600_000);
    expect(parseResetTimestampMs('resets in 5 hrs', NOW)).toBe(5 * 3_600_000);
    expect(parseResetTimestampMs('resets in 5 hour', NOW)).toBe(5 * 3_600_000);
  });

  // HYPOTHESIS: the unit alternation 's(?:ec...)?' is a prefix match, so a bare
  // 's' wins the alternation and any word starting with m/h falls through.
  it('handles a decimal duration', () => {
    expect(parseResetTimestampMs('resets in 1.5 minutes', NOW)).toBe(90_000);
    expect(parseResetTimestampMs('resets in 2.5 hours', NOW)).toBe(2.5 * 3_600_000);
  });

  it('handles a zero duration', () => {
    expect(parseResetTimestampMs('resets in 0 seconds', NOW)).toBe(0);
    expect(parseResetTimestampMs('resets in 0 minutes', NOW)).toBe(0);
  });

  // HYPOTHESIS: singular 'reset in' works because of 'resets?'.
  it('accepts the singular "reset in" wording', () => {
    expect(parseResetTimestampMs('reset in 10 seconds', NOW)).toBe(10_000);
  });

  it('returns null when no duration is present', () => {
    expect(parseResetTimestampMs('please slow down', NOW)).toBeNull();
  });
});

describe('Round 3: extractCooldownHintMs signal priority', () => {
  const NOW = 1_700_000_000_000;

  // Contract: host-parsed provider hint is the highest-priority signal.
  it('providerRetryAfterMs beats retry-after AND x-ratelimit-reset headers', () => {
    const hint = extractCooldownHintMs({
      code: 'RATE_LIMIT',
      providerRetryAfterMs: 45_000,
      headers: { 'retry-after': '30', 'x-ratelimit-reset': '60' }
    }, NOW);
    expect(hint).toBe(45_000);
  });

  it('retry-after header beats x-ratelimit-reset header', () => {
    const hint = extractCooldownHintMs({
      code: 'RATE_LIMIT',
      headers: { 'retry-after': '30', 'x-ratelimit-reset': '600' }
    }, NOW);
    expect(hint).toBe(30_000);
  });

  // HYPOTHESIS: header sources are consulted before the message body.
  it('headers beat message text', () => {
    const hint = extractCooldownHintMs({
      code: 'RATE_LIMIT',
      headers: { 'retry-after': '30' },
      message: 'your usage will reset at 2026-09-24 05:17:08 UTC+8'
    }, NOW);
    expect(hint).toBe(30_000);
  });

  // HYPOTHESIS: sources = [failure.headers, response.headers], so the top-level
  // header wins over an equally-named header in the response envelope.
  it('top-level failure.headers beat response.headers', () => {
    const hint = extractCooldownHintMs({
      code: 'RATE_LIMIT',
      headers: { 'retry-after': '30' },
      response: { headers: { 'retry-after': '600' } }
    } as never, NOW);
    expect(hint).toBe(30_000);
  });

  // HYPOTHESIS: an unparseable retry-after must not block the reset header.
  it('an unparseable retry-after falls through to x-ratelimit-reset', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': 'soon', 'x-ratelimit-reset': '45' } }, NOW)).toBe(45_000);
  });
});

describe('Round 4: toEpochMs disambiguation boundaries (via x-ratelimit-reset)', () => {
  const NOW = 1_700_000_000_000;
  const resetHint = (raw: string, now = NOW) =>
    extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': raw } }, now);

  it('a value just above 1e12 is an epoch in ms', () => {
    expect(resetHint(String(NOW + 5_000))).toBe(5_000);
  });

  it('a value just above 1e9 is an epoch in seconds', () => {
    const epochS = Math.floor(NOW / 1000) + 60;
    expect(resetHint(String(epochS))).toBe(60_000);
  });

  // Boundary contract: the guards are strict (>), so exactly 1e9 / 1e12 are NOT
  // epochs - they fall through to the delta-seconds path (value * 1000) and are
  // then bounded by the 24h cap. Verified correct: the outcome stays finite and
  // within [0, MAX], so a knife-edge value cannot leak a wild cooldown.
  it('exactly 1e9 falls through to the delta path and is clamped by the cap', () => {
    expect(resetHint('1000000000')).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('exactly 1e12 falls through to the delta path and is clamped by the cap', () => {
    expect(resetHint('1000000000000')).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('1e12 + 1 is epoch ms and 1e9 + 1 is epoch seconds', () => {
    expect(resetHint(String(1_000_000_000_001), 1_000_000_000_000)).toBe(1);
    // 1e9+1 as epoch seconds = 2001, i.e. in the past relative to NOW -> clamp 0.
    expect(resetHint(String(1_000_000_001), NOW)).toBe(0);
  });

  // HYPOTHESIS: a 10-digit DELTA-seconds value (>1e9) is misread as epoch
  // seconds. Real provider deltas are far below 1e9, and the 24h cap contains
  // the damage, so this is a documented limitation rather than a live bug.
  it('a 10-digit delta-seconds value is read as epoch seconds (documented, capped)', () => {
    expect(resetHint('9999999999')).toBe(MAX_HINT_COOLDOWN_MS);
  });

  // Sanity: an ordinary small delta is NOT read as an epoch.
  it('a normal delta-seconds value is a delta, not an epoch', () => {
    expect(resetHint('3600')).toBe(3_600_000);
  });
});

describe('Round 5: pickHeader case-insensitivity and numeric values', () => {
  const NOW = 1_700_000_000_000;

  it('matches header names case-insensitively', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'ReTrY-AfTeR': '12' } }, NOW)).toBe(12_000);
    expect(extractCooldownHintMs({ code: 'QUOTA', headers: { 'X-RateLimit-Reset': '12' } }, NOW)).toBe(12_000);
  });

  it('accepts numeric header values', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': 120 as never } }, NOW)).toBe(120_000);
    expect(extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': 45 as never } }, NOW)).toBe(45_000);
  });

  it('treats a numeric zero header as 0, not as absent', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': 0 as never } }, NOW)).toBe(0);
  });

  // HYPOTHESIS: non-finite / blank header values are skipped so they cannot
  // produce NaN or silently shadow a later source.
  it('ignores NaN / Infinity / blank header values', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': Number.NaN as never } }, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': Number.POSITIVE_INFINITY as never } }, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '   ' } }, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '' } }, NOW)).toBeNull();
  });

  it('trims padded header values', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': ' 30 ' } }, NOW)).toBe(30_000);
  });

  it('skips a blank retry-after and uses x-ratelimit-reset instead', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '  ', 'x-ratelimit-reset': '45' } }, NOW)).toBe(45_000);
  });
});

describe('Round 6: 24h cap and non-negativity on every path', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 3_600_000;

  it('caps a huge retry-after delta', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '99999999' } }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('caps a far-future retry-after HTTP date', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': new Date(NOW + 999 * DAY).toUTCString() } }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('caps a far-future x-ratelimit-reset given as epoch seconds or ms', () => {
    expect(extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 999 * 86_400) } }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
    expect(extractCooldownHintMs({ code: 'QUOTA', headers: { 'ratelimit-reset': String(NOW + 999 * DAY) } }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('caps a far-future reset timestamp in the message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: 'your usage will reset at 2099-01-01 00:00:00 UTC+0' }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('caps a huge duration in the message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: 'resets in 99999 hours' }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('caps an oversized providerRetryAfterMs', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: MAX_HINT_COOLDOWN_MS * 3 }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('never returns a negative hint for a past retry-after HTTP date', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': new Date(NOW - 60_000).toUTCString() } }, NOW)).toBe(0);
  });

  it('never returns a negative hint for a past x-ratelimit-reset epoch', () => {
    expect(extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': String(Math.floor(NOW / 1000) - 60) } }, NOW)).toBe(0);
  });

  it('always lands within [0, MAX] across signal sources', () => {
    const cases = [
      { code: 'RATE_LIMIT', headers: { 'retry-after': '1' } },
      { code: 'RATE_LIMIT', providerRetryAfterMs: 1234 },
      { code: 'QUOTA', headers: { 'x-ratelimit-reset': '60' } },
      { code: 'RATE_LIMIT', message: 'resets in 30 minutes' }
    ];
    for (const c of cases) {
      const h = extractCooldownHintMs(c as never, NOW);
      expect(h).not.toBeNull();
      expect(h!).toBeGreaterThanOrEqual(0);
      expect(h!).toBeLessThanOrEqual(MAX_HINT_COOLDOWN_MS);
    }
  });
});

describe('Round 7: isHardRateLimitError requires BOTH a gate AND a keyword', () => {
  it('a bare RATE_LIMIT code with no keyword is false', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT' })).toBe(false);
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'something went wrong' })).toBe(false);
  });

  it('a bare QUOTA code with no keyword is false', () => {
    expect(isHardRateLimitError({ code: 'QUOTA' })).toBe(false);
  });

  it('a bare 429 status with no keyword is false', () => {
    expect(isHardRateLimitError({ code: 'SERVER', status: 429 })).toBe(false);
    expect(isHardRateLimitError({ status: 429 })).toBe(false);
  });

  // The gate is a code/status check: a keyword alone must NOT trip it.
  it('a keyword without a gate code/status is false', () => {
    expect(isHardRateLimitError({ code: 'SERVER', message: 'rate limit exceeded' })).toBe(false);
    expect(isHardRateLimitError({ code: 'UNKNOWN', message: 'frequency limit reached' })).toBe(false);
    expect(isHardRateLimitError({ code: 'SERVER', message: 'out of credits' })).toBe(false);
  });

  it('each gated keyword trips the hard limit', () => {
    const keywords = [
      'frequency limit', '6004', 'rate limit exceeded', 'exceeds frequency',
      'insufficient_quota', 'insufficient quota', 'daily request limit',
      'out of credits', 'reset at'
    ];
    for (const kw of keywords) {
      expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'error: ' + kw })).toBe(true);
    }
  });

  it('each gate code trips when a keyword is present', () => {
    for (const code of ['QUOTA', 'RATE_LIMIT', 'INSUFFICIENT_QUOTA']) {
      expect(isHardRateLimitError({ code, message: 'rate limit exceeded' })).toBe(true);
    }
  });

  it('matches keywords and codes case-insensitively', () => {
    expect(isHardRateLimitError({ code: 'rate_limit', message: 'Rate Limit Exceeded' })).toBe(true);
    expect(isHardRateLimitError({ code: 'quota', message: 'INSUFFICIENT QUOTA' })).toBe(true);
  });

  it('a 429 status gates, so a keyword then trips', () => {
    expect(isHardRateLimitError({ code: 'SERVER', status: 429, message: 'rate limit exceeded' })).toBe(true);
  });

  it('returns false for null / undefined / empty', () => {
    expect(isHardRateLimitError(null)).toBe(false);
    expect(isHardRateLimitError(undefined)).toBe(false);
    expect(isHardRateLimitError({})).toBe(false);
  });
});

describe('Round 8: isAccountLevelRateLimit negative (model-specific) branch wins', () => {
  it('6004 alone is model-specific (false)', () => {
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'error 6004 usage exceeds frequency limit' })).toBe(false);
  });

  it('"switch to the other models" alone is model-specific (false)', () => {
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'you can switch to the other models' })).toBe(false);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'switch to other models' })).toBe(false);
  });

  // The negative branch is evaluated first and returns unconditionally.
  it('BOTH 6004 and an account-level phrase resolves model-specific (false)', () => {
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: '6004 account rate limit exceeded' })).toBe(false);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'daily request limit hit, switch to the other models' })).toBe(false);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'CodeBuddy API rate limit exceeded (6004)' })).toBe(false);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'account rate limit: 6004' })).toBe(false);
  });

  it('account-level phrases alone are true', () => {
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'CodeBuddy API rate limit exceeded' })).toBe(true);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'account rate limit reached' })).toBe(true);
    expect(isAccountLevelRateLimit({ code: 'RATE_LIMIT', message: 'daily request limit exceeded' })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAccountLevelRateLimit({ message: 'CODEBUDDY API RATE LIMIT EXCEEDED' })).toBe(true);
  });

  it('unrelated messages and empty inputs are false', () => {
    expect(isAccountLevelRateLimit({})).toBe(false);
    expect(isAccountLevelRateLimit(null)).toBe(false);
    expect(isAccountLevelRateLimit(undefined)).toBe(false);
    expect(isAccountLevelRateLimit({ message: 'connection reset by peer' })).toBe(false);
  });
});

describe('Round 9: isClientSideError status/code/message discrimination', () => {
  it('400 and 422 are client-side, in the body or the envelope', () => {
    expect(isClientSideError({ status: 400 })).toBe(true);
    expect(isClientSideError({ status: 422 })).toBe(true);
    expect(isClientSideError({ response: { status: 400 } })).toBe(true);
    expect(isClientSideError({ response: { status: 422 } })).toBe(true);
  });

  // Contract: 429 / 5xx alone must NEVER be classified client-side.
  it('429 and 5xx statuses are never client-side', () => {
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isClientSideError({ code: 'SERVER', status: s })).toBe(false);
      expect(isClientSideError({ code: 'SERVER', status: s, message: 'upstream unavailable' })).toBe(false);
      expect(isClientSideError({ code: 'SERVER', response: { status: s } })).toBe(false);
    }
  });

  it('a top-level status wins over the response envelope status', () => {
    expect(isClientSideError({ status: 500, response: { status: 400 } })).toBe(false);
    expect(isClientSideError({ status: 400, response: { status: 500 } })).toBe(true);
  });

  it('client error codes are client-side (case-insensitive)', () => {
    expect(isClientSideError({ code: 'BAD_REQUEST' })).toBe(true);
    expect(isClientSideError({ code: 'INVALID_REQUEST' })).toBe(true);
    expect(isClientSideError({ code: 'CONTEXT_LENGTH' })).toBe(true);
    expect(isClientSideError({ code: 'bad_request' })).toBe(true);
  });

  it('every client message keyword is detected', () => {
    const msgs = [
      'context_length_exceeded', 'maximum context length', 'prompt is too long',
      'token count exceeds', 'invalid parameter', 'unsupported parameter'
    ];
    for (const m of msgs) expect(isClientSideError({ message: 'Error: ' + m })).toBe(true);
  });

  it('rate-limit and quota messages are not client-side', () => {
    expect(isClientSideError({ code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded' })).toBe(false);
    expect(isClientSideError({ code: 'QUOTA', message: 'insufficient quota' })).toBe(false);
  });

  it('returns false for null / undefined / empty', () => {
    expect(isClientSideError(null)).toBe(false);
    expect(isClientSideError(undefined)).toBe(false);
    expect(isClientSideError({})).toBe(false);
  });
});

describe('Round 10: malformed failure objects must not throw or mis-default', () => {
  // HYPOTHESIS: the three classifiers do (failure.message || '').toLowerCase()
  // and (failure.code || '').toUpperCase() with no typeof guard, so a
  // provider-supplied non-string message/code throws a TypeError. The sibling
  // functions (parseResetTimestampMs, pickHeader) DO guard types.
  it('a wrong-typed message does not throw', () => {
    expect(() => isHardRateLimitError({ code: 'RATE_LIMIT', message: 123 as never })).not.toThrow();
    expect(() => isAccountLevelRateLimit({ message: 123 as never })).not.toThrow();
    expect(() => isClientSideError({ message: 123 as never })).not.toThrow();
  });

  it('a wrong-typed code does not throw', () => {
    expect(() => isHardRateLimitError({ code: 429 as never })).not.toThrow();
    expect(() => isAccountLevelRateLimit({ code: 429 as never })).not.toThrow();
    expect(() => isClientSideError({ code: 400 as never })).not.toThrow();
  });

  it('a wrong-typed message yields the safe default (false), not a truthy match', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 123 as never })).toBe(false);
    expect(isAccountLevelRateLimit({ message: 123 as never })).toBe(false);
    expect(isClientSideError({ message: 123 as never })).toBe(false);
  });

  it('extractCooldownHintMs survives a non-string message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: 500 as never })).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: { text: 'x' } as never })).toBeNull();
  });

  it('extractCooldownHintMs survives a non-object headers field', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: 'nope' as never })).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: 5 as never })).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: [] as never })).toBeNull();
  });

  it('extractCooldownHintMs survives a non-object response field', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: 'boom' as never })).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: 7 as never })).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { headers: null } as never })).toBeNull();
  });

  it('extractCooldownHintMs reads a response body msg/message string', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: { msg: 'resets in 30 seconds' } } } as never, 0)).toBe(30_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: { message: 'resets in 45 seconds' } } } as never, 0)).toBe(45_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: 'resets in 10 seconds' } } as never, 0)).toBe(10_000);
  });
});
