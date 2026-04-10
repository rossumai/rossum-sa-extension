import * as api from './api.js';
import * as cache from './cache.js';
import * as store from './store.js';
import { FIELD_DISCOVERY_SIZE, discoverFields, STATS_CHECKS, buildAllPipelines } from './statsPipelines.js';

// ── Individual prefetch functions ───────────────

async function prefetchRecords(collection) {
  if (cache.get(collection, 'records') !== null) return;
  try {
    const res = await api.aggregate(collection, [{ $match: {} }, { $skip: 0 }, { $limit: store.limit.value }]);
    cache.set(collection, 'records', res.result || []);
  } catch { /* silent */ }
}

async function prefetchTotalCount(collection) {
  if (cache.get(collection, 'totalCount') !== null) return;
  try {
    const res = await api.aggregate(collection, [{ $count: 'total' }]);
    cache.set(collection, 'totalCount', res.result?.[0]?.total ?? 0);
  } catch { /* silent */ }
}

async function prefetchIndexes(collection) {
  if (cache.get(collection, 'indexes') !== null) return;
  try {
    const res = await api.listIndexes(collection, false);
    cache.set(collection, 'indexes', res.result || []);
  } catch { /* silent */ }
}

async function prefetchSearchIndexes(collection) {
  if (cache.get(collection, 'searchIndexes') !== null) return;
  try {
    const res = await api.listSearchIndexes(collection, false);
    cache.set(collection, 'searchIndexes', res.result || []);
  } catch { /* silent */ }
}

async function prefetchStats(collection) {
  let fields = cache.get(collection, 'statsFields');
  if (!fields) {
    try {
      const sample = await api.aggregate(collection, [{ $sample: { size: FIELD_DISCOVERY_SIZE } }]);
      fields = discoverFields(sample.result || []);
      if (fields.length > 0) cache.set(collection, 'statsFields', fields);
    } catch { return; }
  }
  if (!fields || fields.length === 0) return;
  const pipelines = buildAllPipelines(fields);
  await Promise.allSettled(
    STATS_CHECKS.map(async (key) => {
      const cacheKey = `stats_${key}`;
      if (cache.get(collection, cacheKey) !== null) return;
      try {
        const res = await api.aggregate(collection, pipelines[key]);
        cache.set(collection, cacheKey, res);
      } catch { /* silent */ }
    }),
  );
}

// ── Tab-to-prefetch mapping ─────────────────────

const PANEL_PREFETCH = {
  'data': (col) => Promise.allSettled([prefetchRecords(col), prefetchTotalCount(col)]),
  'indexes': (col) => prefetchIndexes(col),
  'search-indexes': (col) => prefetchSearchIndexes(col),
  'stats': (col) => prefetchStats(col),
};

// ── Public API ──────────────────────────────────

export function prefetchForPanel(collection, panel) {
  const fn = PANEL_PREFETCH[panel];
  return fn ? fn(collection) : Promise.resolve();
}

export function prefetchAll(collection) {
  return Promise.allSettled([
    prefetchRecords(collection),
    prefetchTotalCount(collection),
    prefetchIndexes(collection),
    prefetchSearchIndexes(collection),
    prefetchStats(collection),
  ]);
}

export async function prefetchBatched(collections, signal) {
  const BATCH = 5;
  const DELAY = 200;
  for (let i = 0; i < collections.length; i += BATCH) {
    if (signal.aborted) return;
    const batch = collections.slice(i, i + BATCH);
    await Promise.allSettled(batch.map((col) => prefetchAll(col)));
    if (i + BATCH < collections.length && !signal.aborted) {
      await new Promise((r) => setTimeout(r, DELAY));
    }
  }
}
