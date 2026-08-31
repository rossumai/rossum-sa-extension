/** An Error carrying the HTTP status, plus the two flags pollers set. */
export type ApiError = Error & {
  status?: number;
  /** Polling gave up without learning the outcome — render "couldn't confirm", not failure. */
  pollUnavailable?: boolean;
  /** The operation is probably still running — render "still running", not failure. */
  timedOut?: boolean;
};

type RequestOpts = { signal?: AbortSignal | null };

/** A Data Storage document. Keys are the customer's; `_id` is Mongo's. */
export type DsDocument = Record<string, any>;
/** Mongo filter / update / aggregation stage — passed to the service verbatim. */
export type MongoQuery = Record<string, any>;
export type PipelineStage = Record<string, any>;

export type FindOptions = {
  query?: MongoQuery;
  projection?: Record<string, 0 | 1 | boolean> | null;
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1> | null;
};

/** An async operation from /operation_status. Terminal states are FINISHED and FAILED. */
export type Operation = {
  status?: 'FINISHED' | 'FAILED' | string;
  error_message?: string;
  [key: string]: any;
};

/** A data-matching operation. Terminal: finished, unknown (terminal-uncertain), failed. */
export type DatasetOperation = {
  status?: 'finished' | 'unknown' | 'failed' | string;
  error?: string;
  [key: string]: any;
};

let serviceBase = '';
let baseDomain = '';
let authHeader = '';

export function init(domain: string, token: string): void {
  baseDomain = domain;
  serviceBase = `${domain}/svc/data-storage`;
  authHeader = `Bearer ${token}`;
}

const REQUEST_TIMEOUT = 30_000;

function combinedSignal(externalSignal?: AbortSignal | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  // Drop the timer immediately if the caller aborts, so a long-lived (or
  // already-aborted) external signal can't keep an idle timer alive.
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
    } else {
      const onAbort = () => clearTimeout(timer);
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  return { signal, timer, externalSignal };
}

async function post(
  path: string,
  body: unknown,
  { signal: externalSignal }: RequestOpts = {},
): Promise<any> {
  const { signal, timer } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(`${serviceBase}/api/v1${path}`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
      401,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw apiError(data?.message || `API error ${res.status}`, res.status);
  }
  // Async (202) endpoints return the operation id in the `content-location`
  // header (a .../operation_status/<id> URL); the body `message` is empty on
  // this Data Storage version. Surface it as `data.operationId` so callers can
  // poll. Only attached when present, so ordinary responses are untouched.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const opId = operationIdFromResponse(res, data);
    if (opId) data.operationId = opId;
  }
  return data;
}

// Pull the async operation id from a response: the `content-location` header
// (.../operation_status/<id>) is authoritative here; fall back to a 24-hex id
// embedded in the body message for older/other environments.
function operationIdFromResponse(res: Response, data: any): string | null {
  const loc = res.headers?.get?.('content-location') || res.headers?.get?.('location') || '';
  const fromHeader = loc.match(/\/operation_status\/([^/?#\s]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  // Message fallback only for async-accept responses, so a stray 24-hex run in
  // an ordinary response's message can't be mistaken for an operation id.
  if (data?.code !== 'accept') return null;
  const msg = typeof data.message === 'string' ? data.message : '';
  return msg.match(/[a-f0-9]{24}/i)?.[0] || null;
}

async function get(path: string, { signal: externalSignal }: RequestOpts = {}): Promise<any> {
  const { signal, timer } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(`${serviceBase}${path}`, {
      headers: { Authorization: authHeader },
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
      401,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw apiError(data?.message || `API error ${res.status}`, res.status);
  }
  return data;
}

// Master Data Hub V2 is a second service with a different envelope: REST verbs, a
// bare JSON body, and a {message, type} error shape rather than Data Storage's
// {code, message, result}. post()/get() are hard-wired to serviceBase and that
// envelope, so V2 needs its own helper. It deliberately does NOT attach an
// operationId — V2 writes return 202 with no operation to poll, and inventing one
// would be a lie (see hooks/useIndexReconcile.ts).
async function mdhRequest(
  method: string,
  path: string,
  body?: unknown,
  { signal: externalSignal }: RequestOpts = {},
): Promise<any> {
  const { signal, timer } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(`${baseDomain}/svc/master-data-hub${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
      401,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(data?.message || `API error ${res.status}`, res.status);
  return data;
}

function apiError(message: string, status?: number): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  return e;
}

// Resolve the active project's organization UUID from the token's own context via
// /internal/token_info. token_info reflects the org the *token* belongs to (the
// customer org), unlike /auth/user which returns the signed-in user's home org
// (always org 1 for system users). Used only to namespace per-org client state;
// returns null on any failure so callers fall back to a domain-scoped key.
// (Read with the extension's Bearer secureToken; live-verified to return the
// customer org's organization_uuid. Some tokens lack token_info access — hence the
// null-on-failure + domain fallback.)
export async function getOrgId(): Promise<string | null> {
  const { signal, timer } = combinedSignal();
  try {
    const res = await fetch(`${baseDomain}/api/v1/internal/token_info`, {
      headers: { Authorization: authHeader },
      signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.organization_uuid || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function listCollections(filter: MongoQuery | null = null, nameOnly = true): Promise<any> {
  return post('/collections/list', { filter, nameOnly });
}

export function createCollection(
  collectionName: string,
  options: Record<string, unknown> = {},
): Promise<any> {
  return post('/collections/create', { collectionName, options });
}

export function renameCollection(
  collectionName: string,
  target: string,
  dropTarget = false,
): Promise<any> {
  return post('/collections/rename', { collectionName, target, dropTarget });
}

export function dropCollection(collectionName: string): Promise<any> {
  return post('/collections/drop', { collectionName });
}

export function find(
  collectionName: string,
  { query = {}, projection = null, skip = 0, limit = 30, sort = null }: FindOptions = {},
): Promise<any> {
  return post('/data/find', { collectionName, query, projection, skip, limit, sort });
}

export function insertOne(collectionName: string, document: DsDocument): Promise<any> {
  return post('/data/insert_one', { collectionName, document });
}

export function insertMany(
  collectionName: string,
  documents: DsDocument[],
  ordered = false,
): Promise<any> {
  return post('/data/insert_many', { collectionName, documents, ordered });
}

export function updateOne(
  collectionName: string,
  filter: MongoQuery,
  update: MongoQuery,
  options?: Record<string, unknown>,
): Promise<any> {
  const body: Record<string, unknown> = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_one', body);
}

export function updateMany(
  collectionName: string,
  filter: MongoQuery,
  update: MongoQuery,
  options?: Record<string, unknown>,
): Promise<any> {
  const body: Record<string, unknown> = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_many', body);
}

export function deleteOne(collectionName: string, filter: MongoQuery): Promise<any> {
  return post('/data/delete_one', { collectionName, filter });
}

export function deleteMany(collectionName: string, filter: MongoQuery): Promise<any> {
  return post('/data/delete_many', { collectionName, filter });
}

export function replaceOne(
  collectionName: string,
  filter: MongoQuery,
  replacement: DsDocument,
  options?: Record<string, unknown>,
): Promise<any> {
  const body: Record<string, unknown> = { collectionName, filter, replacement };
  if (options) body.options = options;
  return post('/data/replace_one', body);
}

export function aggregate(
  collectionName: string,
  pipeline: PipelineStage[],
  { signal }: RequestOpts = {},
): Promise<any> {
  return post('/data/aggregate', { collectionName, pipeline }, { signal });
}

export function bulkWrite(collectionName: string, operations: MongoQuery[]): Promise<any> {
  return post('/data/bulk_write', { collectionName, operations });
}

// Per-collection storage stats via $collStats. Returns doc count + on-disk
// sizes including a per-index `indexSizes` map (regular indexes only — Atlas
// search indexes are not covered). $indexStats (usage) is NOT authorized.
export function collectionStats(
  collectionName: string,
  { signal }: RequestOpts = {},
): Promise<any> {
  return aggregate(
    collectionName,
    [
      { $collStats: { storageStats: {} } },
      {
        $project: {
          count: '$storageStats.count',
          size: '$storageStats.size',
          storageSize: '$storageStats.storageSize',
          totalIndexSize: '$storageStats.totalIndexSize',
          indexSizes: '$storageStats.indexSizes',
        },
      },
    ],
    { signal },
  );
}

export function listIndexes(
  collectionName: string,
  nameOnly = false,
  { signal }: RequestOpts = {},
): Promise<any> {
  return post('/indexes/list', { collectionName, nameOnly }, { signal });
}

export function createIndex(
  collectionName: string,
  indexName: string,
  keys: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<any> {
  return post('/indexes/create', { collectionName, indexName, keys, options });
}

export function dropIndex(collectionName: string, indexName: string): Promise<any> {
  return post('/indexes/drop', { collectionName, indexName });
}

// Search indexes live on Master Data Hub V2, not Data Storage. The Data Storage
// paths still answer but are served by MDH's compatibility router and carry
// Sunset: 2027-12-31; their async operation ids also land in MDH's operation
// store, which the Data Storage operation_status endpoint cannot see.
function searchIndexPath(collectionName: string, indexName?: string): string {
  const base = `/api/v2/datasets/${encodeURIComponent(collectionName)}/search_indexes`;
  return indexName === undefined ? base : `${base}/${encodeURIComponent(indexName)}`;
}

/**
 * A search index as MDH V2 reports it: the registry declaration overlaid with the
 * live engine fields. `definition` is snake_case when a declaration exists and the
 * engine's own camelCase when the index exists only on the engine — both are valid
 * input to putSearchIndex, so neither needs converting.
 * `latest_definition_version` is absent between a PUT and the changelog write.
 */
export type SearchIndex = {
  name: string;
  definition: Record<string, any>;
  queryable: boolean;
  status: string;
  latest_definition_version?: { version: number; created_at?: string } | null;
};

export function listSearchIndexes(
  collectionName: string,
  { signal }: RequestOpts = {},
): Promise<SearchIndex[]> {
  return mdhRequest('GET', searchIndexPath(collectionName), undefined, { signal });
}

// Upsert: creates when the name is new, replaces the declaration when it is not.
// 202 with no operation id — the caller observes progress by re-reading the list.
export function putSearchIndex(
  collectionName: string,
  indexName: string,
  definition: Record<string, unknown>,
): Promise<any> {
  return mdhRequest('PUT', searchIndexPath(collectionName, indexName), definition);
}

export function deleteSearchIndex(collectionName: string, indexName: string): Promise<any> {
  return mdhRequest('DELETE', searchIndexPath(collectionName, indexName));
}

export function checkOperationStatus(operationId: string): Promise<any> {
  return get(`/api/v1/operation_status/${operationId}`);
}

// Poll an async operation until it reaches a terminal state. Resolves with the
// Operation object on FINISHED; throws on FAILED (surfacing the server's
// error_message) or once `timeoutMs` elapses. A 202 only means "accepted" — the
// work runs in the background — so callers that must see the effect reflected
// immediately afterwards (e.g. re-listing collections after a drop) have to
// await this first.
const MAX_POLL_ERRORS = 5;

export async function waitForOperation(
  operationId: string,
  {
    intervalMs = 600,
    timeoutMs = 120_000,
    signal,
  }: RequestOpts & { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Operation> {
  const start = Date.now();
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    let op: Operation;
    try {
      const res = await checkOperationStatus(operationId);
      op = res?.result || {};
      consecutiveErrors = 0;
    } catch (err) {
      // A transient poll failure (network blip, 30s GET timeout, expired session)
      // does NOT mean the operation failed — the build is very likely still
      // running. Tolerate a few in a row; only give up after MAX, tagged so
      // callers render a neutral "couldn't confirm" state, not a red failure.
      if (++consecutiveErrors >= MAX_POLL_ERRORS || Date.now() - start > timeoutMs) {
        const e = new Error(
          `Could not check operation ${operationId} status: ${(err as Error).message}`,
        ) as ApiError;
        e.pollUnavailable = true;
        throw e;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, intervalMs);
      });
      continue;
    }
    if (op.status === 'FINISHED') return op;
    if (op.status === 'FAILED')
      throw new Error(op.error_message || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      const e = new Error(
        `Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`,
      ) as ApiError;
      e.timedOut = true; // let callers render a "still running" state, not a red failure
      throw e;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

export function healthz(): Promise<any> {
  return get('/api/healthz');
}

export async function listOperations(limit = 5000): Promise<any> {
  const params = new URLSearchParams({ limit: String(limit) });
  const url = `${baseDomain}/svc/master-data-hub/api/v2/operation/?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') throw new Error('Request timed out after 30s');
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw new Error(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `API error ${res.status}`);
  }
  return data;
}

// ---- MDH data-matching dataset API (server-side upsert / whole-dataset replace) ----
// Distinct service from Data Storage: {baseDomain}/svc/data-matching/api/v1.
// Writes are multipart file uploads returning 202 + a `Location` op-status URL
// whose last path segment is the operation id. Uploads are JSON (type fidelity).
function dmBase() {
  return `${baseDomain}/svc/data-matching/api/v1`;
}

function opIdFromLocation(res: Response): string | null {
  const loc = res.headers?.get?.('location') || res.headers?.get?.('content-location') || '';
  const m = loc.match(/\/operation\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

async function dmWrite(
  method: string,
  collectionName: string,
  form: FormData,
  externalSignal?: AbortSignal | null,
): Promise<{ operationId: string }> {
  const { signal, timer } = combinedSignal(externalSignal);
  let res: Response;
  try {
    res = await fetch(`${dmBase()}/dataset/${encodeURIComponent(collectionName)}`, {
      method,
      headers: { Authorization: authHeader }, // NO Content-Type: browser sets the multipart boundary
      body: form,
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401)
    throw apiError(
      'Session expired. Open a Rossum page and click Data Storage again to reconnect.',
      401,
    );
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(data?.message || `API error ${res.status}`, res.status);
  const operationId = opIdFromLocation(res);
  if (!operationId) throw apiError('No operation id in dataset response', res.status);
  return { operationId };
}

function jsonFilePart(file: Blob | string | unknown): Blob {
  // Accept a Blob (already built by the caller) or a JSON string.
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  return new Blob([typeof file === 'string' ? file : JSON.stringify(file)], {
    type: 'application/json',
  });
}

export function datasetReplace(
  collectionName: string,
  file: Blob | string | unknown,
  { signal }: RequestOpts = {},
): Promise<{ operationId: string }> {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  return dmWrite('PUT', collectionName, form, signal);
}

export function datasetUpdate(
  collectionName: string,
  file: Blob | string | unknown,
  idKeys: string[] | null | undefined,
  { signal }: RequestOpts = {},
): Promise<{ operationId: string }> {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  form.append('update_or_new', 'true');
  for (const k of idKeys || []) form.append('id_keys', k);
  return dmWrite('PATCH', collectionName, form, signal);
}

// Poll a data-matching operation to a terminal state. Resolves the op on
// `finished` (and on `unknown`, treated as terminal-uncertain); throws on
// `failed` surfacing `error`. Tolerant of a few transient poll failures.
export async function waitForDatasetOperation(
  operationId: string,
  {
    intervalMs = 2000,
    timeoutMs = 300_000,
    signal,
    onPoll,
  }: RequestOpts & {
    intervalMs?: number;
    timeoutMs?: number;
    onPoll?: (op: DatasetOperation) => void;
  } = {},
): Promise<DatasetOperation> {
  const start = Date.now();
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    let op: DatasetOperation;
    try {
      const { signal: reqSignal, timer } = combinedSignal(signal);
      const res = await fetch(`${dmBase()}/operation/${encodeURIComponent(operationId)}`, {
        headers: { Authorization: authHeader },
        signal: reqSignal,
      });
      clearTimeout(timer);
      op = await res.json().catch(() => ({}));
      consecutiveErrors = 0;
    } catch (err) {
      if (++consecutiveErrors >= 5 || Date.now() - start > timeoutMs) {
        const e = new Error(
          `Could not check operation ${operationId}: ${(err as Error).message}`,
        ) as ApiError;
        e.pollUnavailable = true;
        throw e;
      }
      await new Promise((r) => {
        setTimeout(r, intervalMs);
      });
      continue;
    }
    // Surface the live operation object each poll so callers can show a
    // heartbeat (status, timestamps, file metadata) — proof the job is alive.
    try {
      onPoll?.(op);
    } catch {
      /* a caller callback must never break polling */
    }
    if (op.status === 'finished' || op.status === 'unknown') return op;
    if (op.status === 'failed') throw new Error(op.error || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      const e = new Error(
        `Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`,
      ) as ApiError;
      e.timedOut = true;
      throw e;
    }
    await new Promise((r) => {
      setTimeout(r, intervalMs);
    });
  }
}
