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
    throw new Error('Session expired. Open a Rossum page and click Data Storage again to reconnect.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `API error ${res.status}`);
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
    throw new Error('Session expired. Open a Rossum page and click Data Storage again to reconnect.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `API error ${res.status}`);
  }
  return data;
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

export function healthz() {
  return get('/api/healthz');
}

export async function listOperations(limit = 5000) {
  const params = new URLSearchParams({ limit: String(limit) });
  const url = `${baseDomain}/svc/data-matching/api/v2/operation/?${params}`;
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
