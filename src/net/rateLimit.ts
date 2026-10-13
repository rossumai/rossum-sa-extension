// src/net/rateLimit.ts
// The Rossum API's rate limit as ONE error shape that every transport throws
// (spec 2026-10-13-api-call-reduction-design.md §4.1). Nothing here retries: a
// 429 is shown to the user, who retries by acting (Refresh, reopen, Retry).

export type RateLimitError = Error & { status: 429; retryAfter: number | null };

type HeaderSource = { headers?: { get(name: string): string | null } | null };

// Retry-After is whole seconds or an HTTP-date; only the seconds form is read.
function retryAfterSeconds(value: string | null | undefined): number | null {
  if (value == null) return null;
  const v = value.trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

export function rateLimitError(resp: HeaderSource, message: string): RateLimitError {
  const e = new Error(message) as RateLimitError;
  e.status = 429;
  e.retryAfter = retryAfterSeconds(resp.headers?.get('Retry-After'));
  return e;
}

export function isRateLimited(err: unknown): err is RateLimitError {
  return (err as { status?: unknown } | null | undefined)?.status === 429;
}

export function rateLimitMessage(err: { retryAfter?: number | null }): string {
  return err.retryAfter != null
    ? `Rossum is rate-limiting requests. Try again in ${err.retryAfter} s.`
    : 'Rossum is rate-limiting requests. Try again shortly.';
}
