import * as api from './api.js';
import * as cache from './cache.js';
import * as store from './store.js';
import { FIELD_DISCOVERY_SIZE, discoverFields, STATS_CHECKS, buildAllPipelines } from './statsPipelines.js';
import { updateStatsSummary } from './statsSummary.js';

function isAbort(err) {
  return err?.name === 'AbortError';
}

// ── Individual prefetch functions ───────────────

async function prefetchRecords(collection, signal) {
  if (cache.get(collection, 'records') !== null) return;
  try {
    const res = await api.aggregate(
      collection,
      [{ $match: {} }, { $skip: 0 }, { $limit: store.limit.value }],
      { signal },
    );
    if (signal?.aborted) return;
    cache.set(collection, 'records', res.result || []);
  } catch (err) { if (!isAbort(err)) { /* silent */ } }
}

async function prefetchTotalCount(collection, signal) {
  if (cache.get(collection, 'totalCount') !== null) return;
  try {
    const res = await api.aggregate(collection, [{ $count: 'total' }], { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'totalCount', res.result?.[0]?.total ?? 0);
  } catch (err) { if (!isAbort(err)) { /* silent */ } }
}

async function prefetchIndexes(collection, signal) {
  if (cache.get(collection, 'indexes') !== null) return;
  try {
    const res = await api.listIndexes(collection, false, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'indexes', res.result || []);
  } catch (err) { if (!isAbort(err)) { /* silent */ } }
}

async function prefetchSearchIndexes(collection, signal) {
  if (cache.get(collection, 'searchIndexes') !== null) return;
  try {
    const res = await api.listSearchIndexes(collection, false, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'searchIndexes', res.result || []);
  } catch (err) { if (!isAbort(err)) { /* silent */ } }
}

async function prefetchStats(collection, signal) {
  let fields = cache.get(collection, 'statsFields');
  if (!fields) {
    try {
      const sample = await api.aggregate(
        collection,
        [{ $sample: { size: FIELD_DISCOVERY_SIZE } }],
        { signal },
      );
      if (signal?.aborted) return;
      fields = discoverFields(sample.result || []);
      if (fields.length > 0) cache.set(collection, 'statsFields', fields);
    } catch (err) { if (!isAbort(err)) return; return; }
  }
  if (!fields || fields.length === 0 || signal?.aborted) return;
  const pipelines = buildAllPipelines(fields);
  await Promise.allSettled(
    STATS_CHECKS.map(async (key) => {
      if (signal?.aborted) return;
      const cacheKey = `stats_${key}`;
      if (cache.get(collection, cacheKey) !== null) return;
      try {
        const res = await api.aggregate(collection, pipelines[key], { signal });
        if (signal?.aborted) return;
        cache.set(collection, cacheKey, res);
      } catch (err) { if (!isAbort(err)) { /* silent */ } }
    }),
  );
  if (signal?.aborted) return;
  updateStatsSummary(collection);
}

// ── Tab-to-prefetch mapping ─────────────────────

const PANEL_PREFETCH = {
  'data': (col, signal) => Promise.allSettled([prefetchRecords(col, signal), prefetchTotalCount(col, signal)]),
  'indexes': (col, signal) => prefetchIndexes(col, signal),
  'search-indexes': (col, signal) => prefetchSearchIndexes(col, signal),
  'stats': (col, signal) => prefetchStats(col, signal),
};

// ── Public API ──────────────────────────────────

export function prefetchForPanel(collection, panel, { signal } = {}) {
  const fn = PANEL_PREFETCH[panel];
  return fn ? fn(collection, signal) : Promise.resolve();
}

export function prefetchAll(collection, { signal } = {}) {
  return Promise.allSettled([
    prefetchRecords(collection, signal),
    prefetchTotalCount(collection, signal),
    prefetchIndexes(collection, signal),
    prefetchSearchIndexes(collection, signal),
    prefetchStats(collection, signal),
  ]);
}
