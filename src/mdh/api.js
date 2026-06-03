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
  return data;
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

export function updateOne(collectionName, filter, update) {
  return post('/data/update_one', { collectionName, filter, update });
}

export function updateMany(collectionName, filter, update) {
  return post('/data/update_many', { collectionName, filter, update });
}

export function deleteOne(collectionName, filter) {
  return post('/data/delete_one', { collectionName, filter });
}

export function deleteMany(collectionName, filter) {
  return post('/data/delete_many', { collectionName, filter });
}

export function replaceOne(collectionName, filter, replacement) {
  return post('/data/replace_one', { collectionName, filter, replacement });
}

export function aggregate(collectionName, pipeline, { signal } = {}) {
  return post('/data/aggregate', { collectionName, pipeline }, { signal });
}

export function bulkWrite(collectionName, operations) {
  return post('/data/bulk_write', { collectionName, operations });
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

// Async endpoints (drop collection, create/drop index, drop search index,
// bulk_write) return 202 Accepted with the operation id embedded in the
// response `message`. Extract the 24-hex id so callers can poll for completion.
export function parseOperationId(message) {
  return typeof message === 'string' ? (message.match(/[a-f0-9]{24}/i)?.[0] ?? null) : null;
}

// Poll an async operation until it reaches a terminal state. Resolves with the
// Operation object on FINISHED; throws on FAILED (surfacing the server's
// error_message) or once `timeoutMs` elapses. A 202 only means "accepted" — the
// work runs in the background — so callers that must see the effect reflected
// immediately afterwards (e.g. re-listing collections after a drop) have to
// await this first.
export async function waitForOperation(operationId, { intervalMs = 600, timeoutMs = 120_000, signal } = {}) {
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    const res = await checkOperationStatus(operationId);
    const op = res?.result || {};
    if (op.status === 'FINISHED') return op;
    if (op.status === 'FAILED') throw new Error(op.error_message || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
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
