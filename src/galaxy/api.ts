// REST client for the Galaxy app. Mirrors src/audit/api.js (Bearer auth, 30s
// timeout, 401 -> session expired, 403 -> featureUnavailable) and adds full
// collection enumeration (listAll) plus a per-resource bundle fetch that
// degrades a forbidden collection to [] (a "partial galaxy", never a hard fail).
/** Same shape as audit/api's; the duplication is deliberate (see the header). */
export type ApiError = Error & { status: number; featureUnavailable?: boolean };

/** One Rossum resource as the API returns it — buildGraph reads the fields it needs. */
export type RawResource = Record<string, any>;

/** What buildGraph consumes. A 403'd collection arrives as [], never a failure. */
export type RawBundle = {
  organization: RawResource | null;
  workspaces: RawResource[];
  queues: RawResource[];
  hooks: RawResource[];
  engines: RawResource[];
};

type RequestOpts = { signal?: AbortSignal | null };
type ListOpts = RequestOpts & { onPage?: (count: number) => void };

let baseDomain = '';
let authHeader = '';

export function init(domain: string, token: string): void {
  baseDomain = domain;
  authHeader = `Bearer ${token}`;
}

const REQUEST_TIMEOUT = 30_000;

function combinedSignal(externalSignal?: AbortSignal | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  if (externalSignal) {
    if (externalSignal.aborted) clearTimeout(timer);
    else externalSignal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return { signal, timer, externalSignal };
}

function apiError(message: string, status: number): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  return e;
}

// Accepts either a path ('/api/v1/queues/') or an absolute URL (the pagination
// `next` link). Absolute URLs are passed through; paths are joined to baseDomain.
function toUrl(pathOrUrl: string): string {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${baseDomain}${pathOrUrl}`;
}

export async function get(pathOrUrl: string, { signal: externalSignal }: RequestOpts = {}): Promise<any> {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(toUrl(pathOrUrl), {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (ext?.aborted) throw err;
      throw apiError('Request timed out after 30s', 0);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Galaxy again to reconnect.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
    if (res.status === 403) err.featureUnavailable = true;
    throw err;
  }
  return data;
}

export function buildQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

// Fully enumerate a Rossum collection by following pagination.next.
export async function listAll(pathOrUrl: string, { signal, onPage }: ListOpts = {}): Promise<RawResource[]> {
  const out: RawResource[] = [];
  let next: string | null = pathOrUrl;
  while (next) {
    const page = await get(next, { signal });
    if (Array.isArray(page?.results)) {
      out.push(...page.results);
      if (onPage) onPage(page.results.length);
    }
    next = page?.pagination?.next || null;
  }
  return out;
}

// listAll, but a 403/404 on the collection degrades to [] (partial galaxy).
// 401 still propagates (session expired must reach the shell).
async function safeListAll(pathOrUrl: string, opts?: ListOpts): Promise<RawResource[]> {
  try {
    return await listAll(pathOrUrl, opts);
  } catch (err) {
    if ((err as ApiError).status === 403 || (err as ApiError).status === 404) return [];
    throw err;
  }
}

// Fetch the raw resource bundle the graph builder needs.
export async function fetchOrgResources(
  { signal, onProgress }: RequestOpts & { onProgress?: (total: number) => void } = {},
): Promise<RawBundle> {
  const q = buildQuery({ page_size: 100 });
  let total = 0;
  const onPage = (n: number) => { total += n; if (onProgress) onProgress(total); };
  const [orgs, workspaces, queues, hooks, engines] = await Promise.all([
    safeListAll(`/api/v1/organizations/?${q}`, { signal, onPage }),
    safeListAll(`/api/v1/workspaces/?${q}`, { signal, onPage }),
    safeListAll(`/api/v1/queues/?${q}`, { signal, onPage }),
    safeListAll(`/api/v1/hooks/?${q}`, { signal, onPage }),
    safeListAll(`/api/v1/engines/?${q}`, { signal, onPage }),
  ]);
  return {
    organization: orgs[0] || null,
    workspaces,
    queues,
    hooks,
    engines,
  };
}

export function whoami({ signal }: RequestOpts = {}): Promise<any> {
  return get('/api/v1/auth/user/', { signal });
}
