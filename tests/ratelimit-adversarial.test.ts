import { describe, it, expect } from 'vitest';
import {
  parseResetTimestampMs,
  extractCooldownHintMs,
  isHardRateLimitError,
  isAccountLevelRateLimit,
  isClientSideError,
  MAX_HINT_COOLDOWN_MS
} from '../src/ratelimit.js';
import { buildFailoverNotice } from '../src/notices.js';

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

  it('isHardRateLimitError returns false for null / undefined / empty', () => {
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

  it('isClientSideError returns false for null / undefined / empty', () => {
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

// =============================================================================
// ROUND 2 probes (appended). Prefix R2-Round N to keep numbering unambiguous.
// =============================================================================

describe('R2-Round 11: compact UTC offset with no colon (UTC+530)', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  // HYPOTHESIS: the tz group UTC[+-]\d{1,2}(?::?\d{2})? is greedy on hours, so
  // 'UTC+530' is read as hours=53 -> ISO '+53:00' -> invalid -> null.
  it('UTC+530 is read as the +05:30 offset', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC+530', now)).toBe(23_400_000);
  });
  it('GMT-530 is read as the -05:30 offset', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 GMT-530', now)).toBe(63_000_000);
  });
});

describe('R2-Round 12: 1-digit bare offsets must not fall back to local time', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  // HYPOTHESIS: the bare-offset alternative requires exactly 2 hour digits, so
  // '+5:30' / '+5' do not match the tz group at all and the timestamp is parsed
  // in the MACHINE's local zone (TZ-dependent, silently wrong).
  it('bare +5:30 is read as +05:30', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 +5:30', now)).toBe(23_400_000);
  });
  it('bare +5 is read as +05:00', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 +5', now)).toBe(25_200_000);
  });
  it('bare +530 (no colon) is read as +05:30', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 +530', now)).toBe(23_400_000);
  });
});

describe('R2-Round 13: UTC-equivalent offsets', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  it('GMT-0, UTC-00:00 and Z all mean UTC (12h ahead of now)', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 GMT-0', now)).toBe(43_200_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC-00:00', now)).toBe(43_200_000);
    expect(parseResetTimestampMs('resets at 2026-09-23T12:00:00Z', now)).toBe(43_200_000);
  });
});

describe('R2-Round 14: whitespace between time and timezone', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  it('accepts TAB, multiple spaces, CRLF and a date/time TAB separator', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00\tUTC+8', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00   UTC+8', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00\r\nUTC+8', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23\t12:00:00 UTC+8', now)).toBe(14_400_000);
  });
});

describe('R2-Round 15: a past "reset at" plus a live "resets in" clause', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  // HYPOTHESIS: the past timestamp makes the 'at' branch return nothing, so the
  // 'in' branch supplies the cooldown. That is the desirable outcome.
  it('falls through to the duration when the timestamp is already past', () => {
    const msg = 'your usage will reset at 2026-09-23 09:00:00 UTC+0, or resets in 5 minutes';
    expect(parseResetTimestampMs(msg, now)).toBe(300_000);
  });
});

describe('R2-Round 16: retry-after HTTP-date in the past', () => {
  const NOW = 1_700_000_000_000;
  it('a past HTTP-date yields exactly 0, never negative or the cap', () => {
    const past = new Date(NOW - 3_600_000).toUTCString();
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': past } }, NOW);
    expect(hint).toBe(0);
    expect(hint!).toBeLessThan(MAX_HINT_COOLDOWN_MS);
  });
  it('an HTTP-date exactly at now yields 0', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': new Date(NOW).toUTCString() } }, NOW)).toBe(0);
  });
});

describe('R2-Round 17: header precedence between failure.headers and response.headers', () => {
  const NOW = 1_700_000_000_000;
  it('top-level x-ratelimit-reset beats the response envelope value', () => {
    expect(extractCooldownHintMs({
      code: 'QUOTA',
      headers: { 'x-ratelimit-reset': '45' },
      response: { headers: { 'x-ratelimit-reset': '900' } }
    } as never, NOW)).toBe(45_000);
  });
  it('uses the response envelope when the top-level header is absent', () => {
    expect(extractCooldownHintMs({ code: 'QUOTA', response: { headers: { 'x-ratelimit-reset': '45' } } } as never, NOW)).toBe(45_000);
  });
  it('a blank top-level retry-after does not shadow a valid response retry-after', () => {
    expect(extractCooldownHintMs({
      code: 'RATE_LIMIT',
      headers: { 'retry-after': '  ' },
      response: { headers: { 'retry-after': '60' } }
    } as never, NOW)).toBe(60_000);
  });
});

describe('R2-Round 18: providerRetryAfterMs edge values', () => {
  const NOW = 1_700_000_000_000;
  it('Infinity and -0 are ignored and fall through to headers', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: Number.POSITIVE_INFINITY, headers: { 'retry-after': '30' } }, NOW)).toBe(30_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: -0, headers: { 'retry-after': '30' } }, NOW)).toBe(30_000);
  });
  it('NaN is ignored and yields null when nothing else is present', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: Number.NaN }, NOW)).toBeNull();
  });
  // Documented: the host types this as number, so a string is out of contract and
  // is ignored (falls through) rather than coerced.
  it('a string providerRetryAfterMs is ignored (out-of-contract)', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: '5000' as never, headers: { 'retry-after': '30' } }, NOW)).toBe(30_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: '5000' as never }, NOW)).toBeNull();
  });
});

describe('R2-Round 19: exact 24h cap boundary', () => {
  const NOW = 1_700_000_000_000;
  it('exactly 24h is kept; one ms over is clamped', () => {
    expect(MAX_HINT_COOLDOWN_MS).toBe(86_400_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: 86_400_000 }, NOW)).toBe(86_400_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: 86_400_001 }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });
  it('the same boundary holds on the header path', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '86400' } }, NOW)).toBe(86_400_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '86400.001' } }, NOW)).toBe(MAX_HINT_COOLDOWN_MS);
  });
});

describe('R2-Round 20: isHardRateLimitError gate without keyword', () => {
  it('429 + QUOTA code + empty message does NOT trip (keyword absent)', () => {
    expect(isHardRateLimitError({ code: 'QUOTA', status: 429, message: '' })).toBe(false);
    expect(isHardRateLimitError({ code: 'QUOTA', status: 429 })).toBe(false);
    expect(isHardRateLimitError({ code: 'QUOTA', status: 429, message: 'generic upstream failure' })).toBe(false);
  });
});

describe('R2-Round 21: isClientSideError cross-status precedence', () => {
  it('a client status in either position is client-side; a server one is not', () => {
    expect(isClientSideError({ status: 400, response: { status: 400 } })).toBe(true);
    expect(isClientSideError({ code: 'SERVER', response: { status: 422 } })).toBe(true);
    expect(isClientSideError({ status: null as never, response: { status: 400 } })).toBe(true);
    expect(isClientSideError({ status: 503, response: { status: 400 } })).toBe(false);
    expect(isClientSideError({ status: 400, response: { status: 503 } })).toBe(true);
  });
});

describe('R2-Round 22: isClientSideError with a non-numeric status', () => {
  // Documented: status is host-typed as a number; a string is not coerced, so
  // '400' is not recognised. Reported as a low-severity robustness gap.
  it('a string status "400" is not recognised as client-side', () => {
    expect(isClientSideError({ status: '400' as never })).toBe(false);
  });
});

describe('R2-Round 23: the 6004 substring is context-free', () => {
  // HYPOTHESIS: isAccountLevelRateLimit returns false whenever '6004' appears
  // ANYWHERE, so a requestId containing 6004 suppresses genuine account-level
  // detection. Documented defect (report-only; the fix is semantic).
  it('an account-level message whose requestId merely contains 6004 is misread as model-specific', () => {
    expect(isAccountLevelRateLimit({
      code: 'RATE_LIMIT',
      message: 'CodeBuddy API rate limit exceeded, requestId: 6004abc'
    })).toBe(false);
  });
  it('and isHardRateLimitError likewise trips on a requestId-only 6004', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'throttled, requestId: 6004abc' })).toBe(true);
  });
});

describe('R2-Round 24: failure.error.message fallback path', () => {
  it('reads a nested failure.error.message when failure.message is absent', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', error: { message: 'resets in 20 seconds' } } as never, 0)).toBe(20_000);
  });
});

describe('R2-Round 25: reset timestamp without seconds (HH:MM)', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  // HYPOTHESIS: the 'at' pattern hard-requires HH:MM:SS, so a provider that
  // omits seconds loses the hint entirely.
  it('parses "reset at 2026-09-23 12:00 UTC+8"', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00 UTC+8', now)).toBe(14_400_000);
  });
  it('parses a bare HH:MM form with a Z suffix', () => {
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00Z', now)).toBe(43_200_000);
  });
});

describe('R2-Round 26: isHardRateLimitError keyword coverage for "resets at"', () => {
  // HYPOTHESIS: the keyword list contains 'reset at' but NOT 'resets at'; the
  // string 'resets at ...' does not contain the substring 'reset at', so a
  // third-person reset message is not recognised as a hard limit.
  it('"resets at <time>" trips the hard limit', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'resets at 2026-09-24 05:17:08 UTC+8' })).toBe(true);
  });
  it('the singular "reset at <time>" still trips', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'your usage will reset at 2026-09-24 05:17:08 UTC+8' })).toBe(true);
  });
});

describe('R2-Round 27: Unicode / non-ASCII in messages', () => {
  it('non-ASCII characters around an ASCII keyword do not break matching', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'Uber: rate limit exceeded ok' })).toBe(true);
    expect(isClientSideError({ message: 'x invalid parameter: temperature' })).toBe(true);
  });
  // Documented limitation: keywords are ASCII; Turkish dotted capital I lowercases
  // to 'i' + U+0307, so an ASCII keyword spanning it is not matched. Not a
  // realistic provider string.
  it('a Turkish-uppercased keyword is not matched (documented)', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: '\u0130NSUFFICIENT QUOTA' })).toBe(false);
  });
});

describe('R2-Round 28: very long message with the reset phrase at the end', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  it('finds the phrase at the end of a 200k-char message quickly', () => {
    const msg = 'x'.repeat(200_000) + ' resets at 2026-09-23 12:00:00 UTC+8';
    const t0 = Date.now();
    expect(parseResetTimestampMs(msg, now)).toBe(14_400_000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('a pathological run of whitespace after the date does not hang', () => {
    const msg = 'resets at 2026-09-23' + ' '.repeat(100_000) + 'x';
    const t0 = Date.now();
    expect(parseResetTimestampMs(msg, now)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('R2-Round 29: both a future "reset at" and a "resets in" clause', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  it('the absolute timestamp wins because the "at" branch is evaluated first', () => {
    const msg = 'your usage will reset at 2026-09-23 14:00:00 UTC+0, or resets in 5 minutes';
    expect(parseResetTimestampMs(msg, now)).toBe(7_200_000);
  });
});

describe('R2-Round 30: response.data shapes in the message fallback', () => {
  it('an array response.data yields null', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: [1, 2, 3] } } as never, 0)).toBeNull();
  });
  it('data.msg wins over data.message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: { msg: 'resets in 10 seconds', message: 'resets in 99 seconds' } } } as never, 0)).toBe(10_000);
  });
  // Documented: a non-string data.msg is truthy and shadows a valid string
  // data.message, so the hint is lost.
  it('a non-string data.msg shadows a valid data.message (documented)', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', response: { data: { msg: 123, message: 'resets in 20 seconds' } } } as never, 0)).toBeNull();
  });
});

/* ============================================================================
 * ROUND 3 — the ratelimit/notices seam. Rounds 31-42.
 * ==========================================================================*/

const NOW_SEAM = 1_700_000_000_000;

/** Mirrors index.ts: pass code only when truthy, hintMs only when non-null. */
function seamNotice(failure: any, now: number = NOW_SEAM) {
  const hintMs = extractCooldownHintMs(failure, now);
  return buildFailoverNotice({
    from: { provider: 'p1', model: 'm1' },
    to: { provider: 'p3', model: 'm3' },
    ...(failure?.code ? { code: failure.code } : {}),
    ...(hintMs !== null ? { hintMs } : {})
  });
}

describe('R3RL-Round 31: anchored offset still matches at sentence edges/context', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  // HYPOTHESIS: the round-2 anchoring (^...$) must not stop the offset matching
  // when the tz sits at the very end or is wrapped in punctuation.
  it('matches with leading prose, trailing punctuation, and wrapping brackets', () => {
    expect(parseResetTimestampMs('USAGE LIMIT. resets at 2026-09-23 12:00:00 UTC+8', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC+8. please wait', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 UTC+8; retry', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 (UTC+8)', now)).toBe(14_400_000);
    expect(parseResetTimestampMs('resets at 2026-09-23 12:00:00 [UTC+8]', now)).toBe(14_400_000);
  });
});

describe('R3RL-Round 32: boxed String message (documented safe degradation)', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  // HYPOTHESIS: typeof new String(...) === 'object', so the primitive-only guards
  // ignore it. The hint is lost but nothing throws and nothing is mis-parsed.
  it('does not throw and degrades to null', () => {
    const boxed = new String('your usage will reset at 2026-09-23 12:00:00 UTC+8');
    expect(() => extractCooldownHintMs({ code: 'RATE_LIMIT', message: boxed as never }, now)).not.toThrow();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: boxed as never }, now)).toBeNull();
  });
  it('the classifiers likewise ignore it without throwing', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: new String('rate limit exceeded') as never })).toBe(false);
    expect(isClientSideError({ message: new String('invalid parameter') as never })).toBe(false);
  });
});

describe('R3RL-Round 33: seam values 0 and fractional render verbatim', () => {
  it('a 0-second retry-after renders cooldown hint 0ms in summary and text', () => {
    const { summary, text } = seamNotice({ code: 'RATE_LIMIT', headers: { 'retry-after': '0' } });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT, cooldown hint 0ms)');
    expect(text).toContain('cooldown hint 0ms');
  });
  it('a fractional host hint renders verbatim (0.5ms)', () => {
    const { summary } = seamNotice({ code: 'RATE_LIMIT', providerRetryAfterMs: 0.5 });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT, cooldown hint 0.5ms)');
  });
});

describe('R3RL-Round 34: seam at exactly the 24h cap', () => {
  it('a hint of exactly the cap renders verbatim and is not truncated', () => {
    const { summary } = seamNotice({ code: 'RATE_LIMIT', headers: { 'retry-after': '86400' } });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT, cooldown hint 86400000ms)');
    expect(summary.length).toBeLessThanOrEqual(120);
  });
  it('an over-cap header clamps to exactly the cap before rendering', () => {
    const { summary } = seamNotice({ code: 'RATE_LIMIT', headers: { 'retry-after': '99999' } });
    expect(summary).toContain('cooldown hint 86400000ms');
  });
});

describe('R3RL-Round 35: seam null-vs-undefined hint', () => {
  it('a null hint omits the hint and never renders null/undefined/NaN', () => {
    const { summary, text } = seamNotice({ code: 'RATE_LIMIT', message: 'upstream 502' });
    expect(summary).toBe('Failover: p1/m1 -> p3/m3 (RATE_LIMIT)');
    for (const s of [summary, text]) {
      expect(s).not.toContain('null');
      expect(s).not.toContain('undefined');
      expect(s).not.toContain('NaN');
    }
  });
  it('an explicit undefined hint is identical to an absent hint', () => {
    const base = { from: { provider: 'p1', model: 'm1' }, to: { provider: 'p3', model: 'm3' }, code: 'RATE_LIMIT' };
    expect(buildFailoverNotice({ ...base, hintMs: undefined })).toEqual(buildFailoverNotice(base));
  });
});

describe('R3RL-Round 36: asLower guard precision (no coercion, no over-swallow)', () => {
  // HYPOTHESIS: the round-1 guard is precise — a non-string message is not
  // coerced via toString/Array.join, so it can never trip a keyword.
  it('never coerces a non-string message into a keyword match', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 123 as never })).toBe(false);
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: { toString: () => 'rate limit exceeded' } as never })).toBe(false);
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: ['rate limit exceeded'] as never })).toBe(false);
    expect(isAccountLevelRateLimit({ message: ['account rate limit'] as never })).toBe(false);
    expect(isClientSideError({ message: ['invalid parameter'] as never })).toBe(false);
  });
  it('does not make the code/status gate pass on its own', () => {
    expect(isHardRateLimitError({ code: 429 as never, message: 'rate limit exceeded' })).toBe(false);
    expect(isHardRateLimitError({ code: {} as never, message: 'rate limit exceeded' })).toBe(false);
  });
});

describe('R3RL-Round 37: asUpper guard precision (exact code match)', () => {
  it('client codes match exactly: no prefix, no whitespace tolerance', () => {
    expect(isClientSideError({ code: 'bad_request' })).toBe(true);
    expect(isClientSideError({ code: 'BAD_REQUEST' })).toBe(true);
    expect(isClientSideError({ code: 'BAD' })).toBe(false);
    expect(isClientSideError({ code: 'BAD_REQUEST_EXTRA' })).toBe(false);
    expect(isClientSideError({ code: ' BAD_REQUEST ' })).toBe(false);
  });
  it('hard-limit codes match exactly: no prefix tolerance', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT_2', message: 'rate limit exceeded' })).toBe(false);
    expect(isHardRateLimitError({ code: 'RATE LIMIT', message: 'rate limit exceeded' })).toBe(false);
    expect(isHardRateLimitError({ code: 'QUOTA_EXCEEDED', message: 'insufficient quota' })).toBe(false);
    expect(isHardRateLimitError({ code: 'INSUFFICIENT_QUOTA', message: 'insufficient quota' })).toBe(true);
  });
});

describe('R3RL-Round 38: parser accepted forms x classifier keywords', () => {
  const GATED = ['QUOTA', 'RATE_LIMIT', 'INSUFFICIENT_QUOTA'];
  // HYPOTHESIS: after the round-2 'resets at' fix, every reset-phrase form the
  // parser accepts is recognised by the classifier for each gated code.
  it('every gated code recognises each reset-phrase form the parser accepts', () => {
    const msgs = [
      'your usage will reset at 2026-09-24 05:17:08 UTC+8',
      'resets at 2026-09-24 05:17:08 UTC+8',
      'usage reset at 2026-09-24 05:17:08Z'
    ];
    for (const code of GATED) {
      for (const m of msgs) expect(isHardRateLimitError({ code, message: m })).toBe(true);
    }
  });
  // HYPOTHESIS: the parser accepts the duration form but the classifier's
  // keyword list does not cover it; the hint path is what makes it terminal.
  it('the duration form is parsed but not classified (covered by the hint path)', () => {
    const f = { code: 'RATE_LIMIT', message: 'resets in 5 minutes' };
    expect(parseResetTimestampMs(f.message, NOW_SEAM)).toBe(300_000);
    expect(isHardRateLimitError(f)).toBe(false);
  });
});

describe('R3RL-Round 39: combined threshold decision (hint OR classifier)', () => {
  // HYPOTHESIS: index.ts computes threshold = (hint !== null || isHard) ? 1 : max.
  // A hint must trip immediately even when the classifier declines.
  it('trips immediately when either signal fires, and only then', () => {
    const matrix = [
      { f: { code: 'SERVER', message: 'resets in 5 minutes' }, threshold: 1 },
      { f: { code: 'SERVER', message: 'resets at 2099-01-01 00:00:00 UTC+0' }, threshold: 1 },
      { f: { code: 'TIMEOUT', headers: { 'retry-after': '30' } }, threshold: 1 },
      { f: { code: 'RATE_LIMIT', message: 'rate limit exceeded' }, threshold: 1 },
      { f: { code: 'SERVER', message: 'upstream 502' }, threshold: 3 },
      { f: { code: 'RATE_LIMIT', message: 'upstream 502' }, threshold: 3 }
    ];
    for (const { f, threshold } of matrix) {
      const hintMs = extractCooldownHintMs(f as never, NOW_SEAM);
      const actual = (hintMs !== null || isHardRateLimitError(f as never)) ? 1 : 3;
      expect(actual).toBe(threshold);
    }
  });
});

describe('R3RL-Round 40: duration clause before the absolute clause', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  // HYPOTHESIS: branch order (not textual order) decides, so the absolute reset
  // still wins when the duration clause comes first.
  it('the absolute clause wins even when it appears AFTER the duration clause', () => {
    const msg = 'resets in 5 minutes; your usage will reset at 2026-09-23 14:00:00 UTC+0';
    expect(parseResetTimestampMs(msg, now)).toBe(7_200_000);
  });
});

describe('R3RL-Round 41: an unusable header must not swallow the message fallback', () => {
  // HYPOTHESIS: each guard in extractCooldownHintMs leaves hintMs null (not a
  // bogus value) so the message fallback still runs. Precision, not presence.
  it('invalid / negative / blank header values all fall through to the message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': 'soon' }, message: 'resets in 30 seconds' }, 0)).toBe(30_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'x-ratelimit-reset': '-5' }, message: 'resets in 30 seconds' }, 0)).toBe(30_000);
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': '   ' }, message: 'resets in 30 seconds' }, 0)).toBe(30_000);
  });
});

describe('R3RL-Round 42: seam invariant — the hint is always finite and in range', () => {
  it('no input can produce a negative, non-finite or over-cap hint', () => {
    const inputs = [
      { code: 'RATE_LIMIT', providerRetryAfterMs: -1 },
      { code: 'RATE_LIMIT', headers: { 'retry-after': new Date(0).toUTCString() } },
      { code: 'RATE_LIMIT', headers: { 'retry-after': '-0' } },
      { code: 'RATE_LIMIT', headers: { 'x-ratelimit-reset': '0' } },
      { code: 'RATE_LIMIT', message: 'resets in 0 seconds' },
      { code: 'RATE_LIMIT', providerRetryAfterMs: Number.MAX_VALUE }
    ];
    for (const f of inputs) {
      const h = extractCooldownHintMs(f as never, NOW_SEAM);
      if (h !== null) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeLessThanOrEqual(MAX_HINT_COOLDOWN_MS);
      }
    }
  });
});


// =============================================================================
// ROUND 3 — seam + re-examination. Rounds 31-50 (ratelimit side).
// =============================================================================

describe('R3-Round 31: isHardRateLimitError must read a 429 from the response envelope', () => {
  // Hypothesis: isClientSideError resolves status from BOTH failure.status and
  // failure.response.status, but isHardRateLimitError only reads failure.status,
  // so a 429 carried in the envelope never gates the hard limit.
  it('a 429 in the response envelope gates the hard limit', () => {
    expect(isHardRateLimitError({
      code: 'SERVER',
      message: 'rate limit exceeded',
      response: { status: 429 }
    } as never)).toBe(true);
  });

  it('treats a 429 envelope exactly like a top-level 429', () => {
    const top = isHardRateLimitError({ code: 'SERVER', status: 429, message: 'rate limit exceeded' });
    const env = isHardRateLimitError({ code: 'SERVER', response: { status: 429 }, message: 'rate limit exceeded' } as never);
    expect(env).toBe(top);
    expect(env).toBe(true);
  });

  it('a 429 envelope gates when the top-level status is absent entirely', () => {
    expect(isHardRateLimitError({ message: 'rate limit exceeded', response: { status: 429 } } as never)).toBe(true);
  });
});

describe('R3-Round 32: the envelope-status gate stays precise (no over-swallow)', () => {
  // Hypothesis: extending the gate to the envelope must not admit non-429
  // statuses or bypass the keyword requirement.
  it('a non-429 envelope status does not gate', () => {
    expect(isHardRateLimitError({ code: 'SERVER', response: { status: 500 }, message: 'rate limit exceeded' } as never)).toBe(false);
    expect(isHardRateLimitError({ code: 'SERVER', response: { status: 400 }, message: 'rate limit exceeded' } as never)).toBe(false);
    expect(isHardRateLimitError({ code: 'SERVER', response: { status: '429' }, message: 'rate limit exceeded' } as never)).toBe(false);
  });

  it('a 429 envelope still requires a keyword', () => {
    expect(isHardRateLimitError({ code: 'SERVER', response: { status: 429 }, message: 'generic upstream failure' } as never)).toBe(false);
    expect(isHardRateLimitError({ code: 'SERVER', response: { status: 429 } } as never)).toBe(false);
  });
});

describe('R3-Round 33: the parser/classifier "resets in" gap is masked by the hint', () => {
  // Hypothesis: isHardRateLimitError has no 'resets in' keyword, but the parser
  // returns a non-null hint for every accepted form and index.ts uses
  // (hintMs !== null || isHardRateLimitError), so the gap cannot change the
  // failover decision. Verified, not fixed.
  it('every parser-accepted "resets in" form yields a non-null hint', () => {
    const forms = [
      'resets in 45 seconds',
      'resets in 15 minutes',
      'resets in 2 hours',
      'reset in 10 seconds',
      'resets in 0 seconds'
    ];
    for (const message of forms) {
      expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message }, 0)).not.toBeNull();
    }
  });

  it('a "resets in"-only message is not itself a hard-limit keyword match', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: 'resets in 30 minutes' })).toBe(false);
  });
});

describe('R3-Round 39: a String-object message is handled without throwing', () => {
  // Hypothesis: host fields are untyped, so a String object (typeof 'object')
  // must not throw; it degrades to the safe default.
  it('extractCooldownHintMs ignores a String-object message without throwing', () => {
    const msg = new String('resets in 30 seconds');
    expect(() => extractCooldownHintMs({ code: 'RATE_LIMIT', message: msg as never }, 0)).not.toThrow();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', message: msg as never }, 0)).toBeNull();
  });

  it('isHardRateLimitError ignores a String-object message', () => {
    expect(isHardRateLimitError({ code: 'RATE_LIMIT', message: new String('rate limit exceeded') as never })).toBe(false);
  });
});

describe('R3-Round 40: a truthy non-string message shadows the nested error.message', () => {
  // Hypothesis: the fallback chain uses ||, so any truthy non-string message
  // hides a valid nested error.message. Documented (out-of-contract input).
  it('a String-object message hides a valid error.message reset phrase', () => {
    const shadowed = extractCooldownHintMs({
      code: 'RATE_LIMIT',
      message: new String('nope') as never,
      error: { message: 'resets in 20 seconds' }
    } as never, 0);
    expect(shadowed).toBeNull();
  });

  it('an absent message falls through to error.message', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', error: { message: 'resets in 20 seconds' } } as never, 0)).toBe(20_000);
  });
});

describe('R3-Round 48: the reset phrase matches at the start and end of a sentence', () => {
  // Hypothesis: neither branch is ^/$-anchored, so the phrase is found anywhere,
  // including at the very start or with trailing prose after the timezone.
  it('finds the phrase at the very start', () => {
    expect(parseResetTimestampMs('resets in 45 seconds remaining', 0)).toBe(45_000);
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(parseResetTimestampMs('reset at 2026-09-24 05:17:08 UTC+8', now)).toBeGreaterThan(0);
  });

  it('finds the phrase at the very end', () => {
    expect(parseResetTimestampMs('your quota is exhausted; resets in 45 seconds', 0)).toBe(45_000);
  });

  it('parses the timezone even with trailing prose after it', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(parseResetTimestampMs('usage will reset at 2026-09-24 05:17:08 UTC+8 thanks', now)).toBeGreaterThan(0);
  });
});

describe('R3-Round 49: "resets in" first, future "reset at" second (reverse order)', () => {
  // Hypothesis: the "at" branch is evaluated first regardless of clause order,
  // so a future absolute timestamp beats an earlier "resets in" duration.
  it('the absolute future timestamp wins when it appears second', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const msg = 'resets in 5 minutes, or your usage will reset at 2026-09-23 12:00:00 UTC+0';
    expect(parseResetTimestampMs(msg, now)).toBe(2 * 3_600_000);
  });

  it('a PAST absolute timestamp second still falls through to the duration', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const msg = 'resets in 5 minutes, or reset at 2026-09-23 09:00:00 UTC+0';
    expect(parseResetTimestampMs(msg, now)).toBe(5 * 60_000);
  });
});
