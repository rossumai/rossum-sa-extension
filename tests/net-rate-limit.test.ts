// tests/net-rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import { isRateLimited, rateLimitError, rateLimitMessage } from '../src/net/rateLimit.js';

const resp = (retryAfter: string | null) => ({
  headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
});

describe('rateLimitError', () => {
  it('carries status 429, the message, and Retry-After in whole seconds', () => {
    const e = rateLimitError(resp('7'), 'Request was throttled.');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('Request was throttled.');
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(7);
  });

  it('reads retryAfter as null when the header is absent', () => {
    expect(rateLimitError(resp(null), 'x').retryAfter).toBeNull();
  });

  it('reads retryAfter as null for the HTTP-date form', () => {
    expect(rateLimitError(resp('Wed, 21 Oct 2026 07:28:00 GMT'), 'x').retryAfter).toBeNull();
  });

  it('reads retryAfter as null for a non-numeric value', () => {
    expect(rateLimitError(resp('soon'), 'x').retryAfter).toBeNull();
  });

  it('tolerates a response with no headers object (test doubles, odd transports)', () => {
    expect(rateLimitError({}, 'x').retryAfter).toBeNull();
  });
});

describe('isRateLimited', () => {
  it('is true for a rateLimitError and for any error with status 429', () => {
    expect(isRateLimited(rateLimitError(resp(null), 'x'))).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
  });

  it('is false for other statuses and non-errors', () => {
    expect(isRateLimited({ status: 403 })).toBe(false);
    expect(isRateLimited(new Error('HTTP 500'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited('429')).toBe(false);
  });
});

describe('rateLimitMessage', () => {
  it('names the wait when Retry-After was given', () => {
    expect(rateLimitMessage({ retryAfter: 30 })).toBe(
      'Rossum is rate-limiting requests. Try again in 30 s.',
    );
  });

  it('says "shortly" when it was not', () => {
    expect(rateLimitMessage({ retryAfter: null })).toBe(
      'Rossum is rate-limiting requests. Try again shortly.',
    );
    expect(rateLimitMessage({})).toBe('Rossum is rate-limiting requests. Try again shortly.');
  });
});
