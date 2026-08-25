const apiCache: Record<string, Promise<any>> = {};

// Allowlisted path prefixes. /svc/data-storage/api/v1/ is here for the training
// track's master-data check ONLY. Widen this list one deliberate entry at a
// time, and never by loosening the checks that follow.
const ALLOWED_PREFIXES = ['/api/v1/', '/svc/data-storage/api/v1/'];

// Resolves to an absolute, same-origin URL on the Rossum API. Rejects anything
// that could redirect a token-bearing fetch elsewhere (absolute URLs, scheme,
// protocol-relative, ../ traversal, paths outside the allowlisted prefixes).
function safeApiUrl(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return null;
  if (path.includes('..') || path.includes('//')) return null;
  const url = new URL(path, window.location.origin);
  // Re-check the RESOLVED url, not just the raw string. `new URL` decodes
  // percent-encoded dot segments (`%2e%2e`) into real `..` and normalises them
  // away, so the literal pre-parse check above can be walked straight out of
  // the allowlist — `/api/v1/%2e%2e/%2e%2e/admin` resolves to `/admin`. The
  // origin check is belt-and-braces: dot-segment removal only rewrites the
  // path, never the host, but a token-bearing fetch is worth two guards.
  if (url.origin !== window.location.origin) return null;
  if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;
  return url.toString();
}

export function fetchRossumApi(path: string): Promise<any> {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  if (!apiCache[path]) {
    const token = window.localStorage.getItem('secureToken');
    const headers: Record<string, string> = token ? { Authorization: `Token ${token}` } : {};
    apiCache[path] = fetch(url, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        delete apiCache[path];
        throw err;
      });
  }
  return apiCache[path];
}

// Short-TTL sibling of fetchRossumApi. The cache above never expires, which is
// right for ID overlays and wrong for polling a training step, so training gets
// its own cache with an explicit lifetime and in-flight dedupe. Token handling
// and URL safety stay here, in the one module that owns them.
const freshCache = new Map<string, { at: number; promise: Promise<any> }>(); // path → { at, promise }

/** Data Storage wants Bearer; the Rossum API wants Token. Getting it wrong is a silent 401. */
export type FreshRequest = {
  ttlMs?: number;
  now?: () => number;
  method?: string;
  body?: unknown;
  auth?: 'token' | 'bearer';
};

export function fetchRossumApiFresh(
  path: string,
  {
    ttlMs = 10_000,
    now = () => Date.now(),
    method = 'GET',
    body,
    auth = 'token',
  }: FreshRequest = {},
): Promise<any> {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  // The cache key includes the method and body: a POST check and a GET on the
  // same path are different requests and must not share an entry.
  const key = method === 'GET' ? path : `${method} ${path} ${JSON.stringify(body ?? null)}`;
  const hit = freshCache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.promise;

  const token = window.localStorage.getItem('secureToken');
  // Data Storage authenticates with Bearer; the Rossum API with Token. Getting
  // this wrong is a 401, not a failure you can see in the UI.
  const scheme = auth === 'bearer' ? 'Bearer' : 'Token';
  const headers: Record<string, string> = token ? { Authorization: `${scheme} ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const promise = fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    })
    .catch((err) => {
      freshCache.delete(key); // a failure must never be served from cache
      throw err;
    });
  freshCache.set(key, { at: now(), promise });
  return promise;
}
