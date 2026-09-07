import { describe, it, expect } from 'vitest';
import { extractCooldownHintMs, MAX_HINT_COOLDOWN_MS } from '../src/ratelimit.js';

describe('Rate-Limit Cooldown Hint Parsing', () => {
  const NOW = 1_700_000_000_000;

  it('returns null when there is no failure or no rate-limit headers', () => {
    expect(extractCooldownHintMs(null, NOW)).toBeNull();
    expect(extractCooldownHintMs(undefined, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT' }, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'content-type': 'application/json' } }, NOW)).toBeNull();
  });

  it('parses Retry-After delta seconds', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'Retry-After': '30' } }, NOW);
    expect(hint).toBe(30_000);
  });

  it('prefers the host-parsed providerRetryAfterMs over raw headers', () => {
    const hint = extractCooldownHintMs(
      { code: 'RATE_LIMIT', providerRetryAfterMs: 45_000, headers: { 'Retry-After': '30' } },
      NOW
    );
    expect(hint).toBe(45_000);
  });

  it('falls back to header sniffing when providerRetryAfterMs is absent', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'Retry-After': '30' } }, NOW);
    expect(hint).toBe(30_000);
  });

  it('ignores invalid providerRetryAfterMs values and sniffs headers instead', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const hint = extractCooldownHintMs(
        { code: 'RATE_LIMIT', providerRetryAfterMs: bad, headers: { 'Retry-After': '12' } } as never,
        NOW
      );
      expect(hint).toBe(12_000);
    }
  });

  it('caps an oversized host hint at the maximum window', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', providerRetryAfterMs: 99_999_999 }, NOW);
    expect(hint).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('accepts numeric header values', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'retry-after': 120 as unknown as string } }, NOW);
    expect(hint).toBe(120_000);
  });

  it('parses Retry-After HTTP-dates relative to now', () => {
    const hint = extractCooldownHintMs(
      { code: 'RATE_LIMIT', headers: { 'Retry-After': new Date(NOW + 10_000).toUTCString() } },
      NOW
    );
    expect(hint).not.toBeNull();
    expect(hint!).toBeGreaterThanOrEqual(9_000);
    expect(hint!).toBeLessThanOrEqual(10_000);
  });

  it('parses x-ratelimit-reset as delta seconds', () => {
    const hint = extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': '45' } }, NOW);
    expect(hint).toBe(45_000);
  });

  it('parses x-ratelimit-reset as epoch seconds', () => {
    const resetEpochS = Math.floor(NOW / 1000) + 60;
    const hint = extractCooldownHintMs({ code: 'QUOTA', headers: { 'x-ratelimit-reset': String(resetEpochS) } }, NOW);
    expect(hint).not.toBeNull();
    expect(hint!).toBeGreaterThanOrEqual(59_000);
    expect(hint!).toBeLessThanOrEqual(60_000);
  });

  it('parses ratelimit-reset as epoch milliseconds', () => {
    const hint = extractCooldownHintMs({ code: 'QUOTA', headers: { 'ratelimit-reset': String(NOW + 5_000) } }, NOW);
    expect(hint).toBe(5_000);
  });

  it('reads headers case-insensitively and inside a response envelope', () => {
    const hint = extractCooldownHintMs(
      { code: 'RATE_LIMIT', response: { headers: { 'RETRY-AFTER': '12' } } } as never,
      NOW
    );
    expect(hint).toBe(12_000);
  });

  it('clamps oversized hints to the maximum window', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'Retry-After': '99999' } }, NOW);
    expect(hint).toBe(MAX_HINT_COOLDOWN_MS);
  });

  it('keeps a zero-second hint at zero', () => {
    const hint = extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'Retry-After': '0' } }, NOW);
    expect(hint).toBe(0);
  });

  it('returns null for garbage values', () => {
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'Retry-After': 'soon' } }, NOW)).toBeNull();
    expect(extractCooldownHintMs({ code: 'RATE_LIMIT', headers: { 'x-ratelimit-reset': '-5' } }, NOW)).toBeNull();
  });
});
