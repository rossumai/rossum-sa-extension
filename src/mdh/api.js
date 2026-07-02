let serviceBase = '';
let baseDomain = '';
let authHeader = '';

export function init(domain, token) {
  baseDomain = domain;
  serviceBase = `${domain}/svc/data-storage`;
  authHeader = `Bearer ${token}`;
}

const REQUEST_TIMEOUT = 30_000;

function combinedSignal(externalSignal) {
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

async function post(path, body, { signal: externalSignal } = {}) {
  const { signal, timer } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${serviceBase}/api/v1${path}`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Data Storage again to reconnect.', 401);
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
function operationIdFromResponse(res, data) {
  const loc = res.headers?.get?.('content-location') || res.headers?.get?.('location') || '';
  const fromHeader = loc.match(/\/operation_status\/([^/?#\s]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  // Message fallback only for async-accept responses, so a stray 24-hex run in
  // an ordinary response's message can't be mistaken for an operation id.
  if (data?.code !== 'accept') return null;
  const msg = typeof data.message === 'string' ? data.message : '';
  return msg.match(/[a-f0-9]{24}/i)?.[0] || null;
}

async function get(path, { signal: externalSignal } = {}) {
  const { signal, timer } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${serviceBase}${path}`, {
      headers: { Authorization: authHeader },
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Data Storage again to reconnect.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw apiError(data?.message || `API error ${res.status}`, res.status);
  }
  return data;
}

function apiError(message, status) {
  const e = new Error(message);
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
export async function getOrgId() {
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

export function listCollections(filter = null, nameOnly = true) {
  return post('/collections/list', { filter, nameOnly });
}

export function createCollection(collectionName, options = {}) {
  return post('/collections/create', { collectionName, options });
}

export function renameCollection(collectionName, target, dropTarget = false) {
  return post('/collections/rename', { collectionName, target, dropTarget });
}

export function dropCollection(collectionName) {
  return post('/collections/drop', { collectionName });
}

export function find(collectionName, { query = {}, projection = null, skip = 0, limit = 30, sort = null } = {}) {
  return post('/data/find', { collectionName, query, projection, skip, limit, sort });
}

export function insertOne(collectionName, document) {
  return post('/data/insert_one', { collectionName, document });
}

export function insertMany(collectionName, documents, ordered = false) {
  return post('/data/insert_many', { collectionName, documents, ordered });
}

export function updateOne(collectionName, filter, update, options) {
  const body = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_one', body);
}

export function updateMany(collectionName, filter, update, options) {
  const body = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_many', body);
}

export function deleteOne(collectionName, filter) {
  return post('/data/delete_one', { collectionName, filter });
}

export function deleteMany(collectionName, filter) {
  return post('/data/delete_many', { collectionName, filter });
}

export function replaceOne(collectionName, filter, replacement, options) {
  const body = { collectionName, filter, replacement };
  if (options) body.options = options;
  return post('/data/replace_one', body);
}

export function aggregate(collectionName, pipeline, { signal } = {}) {
  return post('/data/aggregate', { collectionName, pipeline }, { signal });
}

export function bulkWrite(collectionName, operations) {
  return post('/data/bulk_write', { collectionName, operations });
}

// Per-collection storage stats via $collStats. Returns doc count + on-disk
// sizes including a per-index `indexSizes` map (regular indexes only — Atlas
// search indexes are not covered). $indexStats (usage) is NOT authorized.
export function collectionStats(collectionName, { signal } = {}) {
  return aggregate(collectionName, [
    { $collStats: { storageStats: {} } },
    { $project: {
      count: '$storageStats.count',
      size: '$storageStats.size',
      storageSize: '$storageStats.storageSize',
      totalIndexSize: '$storageStats.totalIndexSize',
      indexSizes: '$storageStats.indexSizes',
    } },
  ], { signal });
}

export function listIndexes(collectionName, nameOnly = false, { signal } = {}) {
  return post('/indexes/list', { collectionName, nameOnly }, { signal });
}

export function createIndex(collectionName, indexName, keys, options = {}) {
  return post('/indexes/create', { collectionName, indexName, keys, options });
}

export function dropIndex(collectionName, indexName) {
  return post('/indexes/drop', { collectionName, indexName });
}

export function listSearchIndexes(collectionName, nameOnly = false, { signal } = {}) {
  return post('/search_indexes/list', { collectionName, nameOnly }, { signal });
}

export function createSearchIndex(collectionName, { indexName, mappings, analyzer, analyzers, searchAnalyzer, synonyms } = {}) {
  const body = { collectionName, indexName, mappings };
  if (analyzer) body.analyzer = analyzer;
  if (analyzers) body.analyzers = analyzers;
  if (searchAnalyzer) body.searchAnalyzer = searchAnalyzer;
  if (synonyms) body.synonyms = synonyms;
  return post('/search_indexes/create', body);
}

export function dropSearchIndex(collectionName, indexName) {
  return post('/search_indexes/drop', { collectionName, indexName });
}

export function checkOperationStatus(operationId) {
  return get(`/api/v1/operation_status/${operationId}`);
}

// Poll an async operation until it reaches a terminal state. Resolves with the
// Operation object on FINISHED; throws on FAILED (surfacing the server's
// error_message) or once `timeoutMs` elapses. A 202 only means "accepted" — the
// work runs in the background — so callers that must see the effect reflected
// immediately afterwards (e.g. re-listing collections after a drop) have to
// await this first.
const MAX_POLL_ERRORS = 5;

export async function waitForOperation(operationId, { intervalMs = 600, timeoutMs = 120_000, signal } = {}) {
  const start = Date.now();
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    let op;
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
        const e = new Error(`Could not check operation ${operationId} status: ${err.message}`);
        e.pollUnavailable = true;
        throw e;
      }
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
      continue;
    }
    if (op.status === 'FINISHED') return op;
    if (op.status === 'FAILED') throw new Error(op.error_message || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      const e = new Error(`Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      e.timedOut = true; // let callers render a "still running" state, not a red failure
      throw e;
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

export function healthz() {
  return get('/api/healthz');
}

export async function listOperations(limit = 5000) {
  const params = new URLSearchParams({ limit: String(limit) });
  const url = `${baseDomain}/svc/master-data-hub/api/v2/operation/?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request timed out after 30s');
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw new Error('Session expired. Open a Rossum page and click Data Storage again to reconnect.');
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
function dmBase() { return `${baseDomain}/svc/data-matching/api/v1`; }

function opIdFromLocation(res) {
  const loc = res.headers?.get?.('location') || res.headers?.get?.('content-location') || '';
  const m = loc.match(/\/operation\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

async function dmWrite(method, collectionName, form, externalSignal) {
  const { signal, timer } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${dmBase()}/dataset/${encodeURIComponent(collectionName)}`, {
      method,
      headers: { Authorization: authHeader }, // NO Content-Type: browser sets the multipart boundary
      body: form,
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) throw apiError('Session expired. Open a Rossum page and click Data Storage again to reconnect.', 401);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(data?.message || `API error ${res.status}`, res.status);
  const operationId = opIdFromLocation(res);
  if (!operationId) throw apiError('No operation id in dataset response', res.status);
  return { operationId };
}

function jsonFilePart(file) {
  // Accept a Blob (already built by the caller) or a JSON string.
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  return new Blob([typeof file === 'string' ? file : JSON.stringify(file)], { type: 'application/json' });
}

export function datasetReplace(collectionName, file, { signal } = {}) {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  return dmWrite('PUT', collectionName, form, signal);
}

export function datasetUpdate(collectionName, file, idKeys, { signal } = {}) {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  form.append('update_or_new', 'true');
  for (const k of (idKeys || [])) form.append('id_keys', k);
  return dmWrite('PATCH', collectionName, form, signal);
}

// Poll a data-matching operation to a terminal state. Resolves the op on
// `finished` (and on `unknown`, treated as terminal-uncertain); throws on
// `failed` surfacing `error`. Tolerant of a few transient poll failures.
export async function waitForDatasetOperation(operationId, { intervalMs = 2000, timeoutMs = 300_000, signal, onPoll } = {}) {
  const start = Date.now();
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    let op;
    try {
      const { signal: reqSignal, timer } = combinedSignal(signal);
      const res = await fetch(`${dmBase()}/operation/${encodeURIComponent(operationId)}`, { headers: { Authorization: authHeader }, signal: reqSignal });
      clearTimeout(timer);
      op = await res.json().catch(() => ({}));
      consecutiveErrors = 0;
    } catch (err) {
      if (++consecutiveErrors >= 5 || Date.now() - start > timeoutMs) {
        const e = new Error(`Could not check operation ${operationId}: ${err.message}`);
        e.pollUnavailable = true;
        throw e;
      }
      await new Promise((r) => { setTimeout(r, intervalMs); });
      continue;
    }
    // Surface the live operation object each poll so callers can show a
    // heartbeat (status, timestamps, file metadata) — proof the job is alive.
    try { onPoll?.(op); } catch { /* a caller callback must never break polling */ }
    if (op.status === 'finished' || op.status === 'unknown') return op;
    if (op.status === 'failed') throw new Error(op.error || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      const e = new Error(`Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      e.timedOut = true;
      throw e;
    }
    await new Promise((r) => { setTimeout(r, intervalMs); });
  }
}
