import * as api from './api.js';
import * as cache from './cache.js';
import * as store from './store.js';
import {
  FIELD_DISCOVERY_SIZE,
  discoverFieldsWithTotal,
  STATS_CHECKS,
  buildAllPipelines,
  buildSampleReadPipeline,
  buildStoragePipeline,
  sampledStatsKey,
  analysisPlan,
  STATS_EXACT,
} from './statsPipelines.js';
import { assembleSampledStats } from './statsCompute.js';
import { updateStatsSummary } from './statsSummary.js';

function isAbort(err: unknown) {
  return (err as any)?.name === 'AbortError';
}

// ── Individual prefetch functions ───────────────

async function prefetchRecords(collection: string, signal?: AbortSignal) {
  if (cache.get(collection, 'records') !== null) return;
  try {
    const res = await api.aggregate(
      collection,
      [{ $match: {} }, { $skip: 0 }, { $limit: store.limit.value }],
      { signal },
    );
    if (signal?.aborted) return;
    cache.set(collection, 'records', res.result || []);
  } catch (err) {
    if (!isAbort(err)) {
      /* silent */
    }
  }
}

async function prefetchTotalCount(collection: string, signal?: AbortSignal) {
  if (cache.get(collection, 'totalCount') !== null) return;
  try {
    const res = await api.aggregate(collection, [{ $collStats: { count: {} } }, { $limit: 1 }], {
      signal,
    });
    if (signal?.aborted) return;
    cache.set(collection, 'totalCount', res.result?.[0]?.count ?? 0);
  } catch (err) {
    if (!isAbort(err)) {
      /* silent */
    }
  }
}

async function prefetchIndexes(collection: string, signal?: AbortSignal) {
  if (cache.get(collection, 'indexes') !== null) return;
  try {
    const res = await api.listIndexes(collection, false, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'indexes', res.result || []);
  } catch (err) {
    if (!isAbort(err)) {
      /* silent */
    }
  }
}

async function prefetchSearchIndexes(collection: string, signal?: AbortSignal) {
  if (cache.get(collection, 'searchIndexes') !== null) return;
  try {
    const rows = await api.listSearchIndexes(collection, { signal });
    if (signal?.aborted) return;
    cache.set(collection, 'searchIndexes', rows || []);
  } catch (err) {
    if (!isAbort(err)) {
      /* silent */
    }
  }
}

async function prefetchStats(collection: string, signal?: AbortSignal) {
  let fields = cache.get(collection, 'statsFields');
  if (!fields) {
    try {
      const sample = await api.aggregate(
        collection,
        [{ $sample: { size: FIELD_DISCOVERY_SIZE } }],
        { signal },
      );
      if (signal?.aborted) return;
      const discovered = discoverFieldsWithTotal(sample.result || []);
      fields = discovered.fields;
      if (fields.length > 0) {
        cache.set(collection, 'statsFields', fields);
        cache.set(collection, 'statsFieldsTotal', discovered.total);
      }
    } catch (err) {
      if (!isAbort(err)) return;
      return;
    }
  }
  if (!fields || fields.length === 0 || signal?.aborted) return;

  // prefetchTotalCount already caches this and is a no-op when it is cached —
  // do not inline a second $collStats call beside it.
  await prefetchTotalCount(collection, signal);
  if (signal?.aborted) return;
  let total = cache.get(collection, 'totalCount');

  // avgObjSize now decides the path, so storage stats must be fetched BEFORE
  // the decision rather than alongside the sampled read. Cache-first under the
  // same key the exact branch's per-check loop uses (`stats_storage`), so a
  // hit here is also a hit there.
  let storageRes = cache.get(collection, 'stats_storage');
  let storageFetched = false;
  if (storageRes === null) {
    try {
      storageRes = await api.aggregate(collection, buildStoragePipeline(), { signal });
      if (signal?.aborted) return;
      storageFetched = true;
    } catch (err) {
      // A failed probe costs the SAMPLED path and nothing else. Returning here
      // skipped updateStatsSummary, so the tab-bar dot silently stopped
      // appearing for this collection — for a read that only chooses between
      // two paths. Without avgObjSize, analysisPlan reads exactly, and the run
      // carries on and publishes the dot.
      if (isAbort(err)) return;
      // storageRes stays null, which analysisPlan reads as "size unknown".
    }
  }
  if (total === null) {
    // The count aggregate failed but the storage probe succeeded: fall back to
    // storageStats.count (the same fallback StatsPanel and OverviewPanel use)
    // instead of returning outright, which left the tab-bar dot silent until
    // the panel was opened.
    const storageCount = storageRes?.result?.[0]?.storageStats?.count;
    if (typeof storageCount !== 'number') return;
    total = storageCount;
    cache.set(collection, 'totalCount', total);
  }
  const avgObjSize = storageRes?.result?.[0]?.storageStats?.avgObjSize ?? 0;
  const plan = analysisPlan(total, avgObjSize, fields.length, store.statsMode.value);

  // The stats_* entries are per collection and live for 10 minutes, so a run can
  // find entries another collection's run left at a DIFFERENT size — one run
  // size is in effect per run, not per cache. Distrust anything not produced at
  // the size this run is about to report.
  const runSize = plan.sampled ? plan.size : STATS_EXACT;
  if (cache.get(collection, 'statsRunSize') !== runSize) {
    cache.invalidate(collection, 'stats_sampled');
    // `storage` is exempt: $collStats metadata is exact and independent of how
    // many documents the run analyses, so it survives a run-size change instead
    // of being dropped and immediately written back.
    for (const key of STATS_CHECKS) {
      if (key !== 'storage') cache.invalidate(collection, `stats_${key}`);
    }
  }
  // Only a FRESH read is written back. cache.set restamps the entry, so writing
  // a cache HIT back on every prefetch would keep a repeatedly-visited
  // collection's storage figures alive indefinitely past TTL_LONG — and
  // components/OverviewPanel.tsx reads the same key.
  if (storageFetched) cache.set(collection, 'stats_storage', storageRes);

  if (plan.sampled) {
    // A cache hit falls THROUGH rather than returning: the tab-bar dot is
    // republished at the end of this function, and returning here left the
    // summary holding whichever collection was profiled last.
    if (cache.get(collection, 'stats_sampled') === null) {
      try {
        // Single-flight across BOTH callers — the fuller note is in
        // components/StatsPanel.tsx, which joins this very promise.
        const computed = await cache.single(sampledStatsKey(collection, plan.size), async () => {
          // No signal inside the shared closure: StatsPanel joins this same promise
          // via cache.single, and a background abort must not cancel the panel's
          // work. The aborted check after the await still discards our own result.
          const sampleRes = await api.aggregate(
            collection,
            buildSampleReadPipeline(fields, plan.size),
          );
          return assembleSampledStats(sampleRes.result || [], fields, storageRes);
        });
        if (signal?.aborted) return;
        cache.set(collection, 'stats_sampled', computed);
        // `storage` again exempt: computed.storage IS the entry this run read,
        // so writing it back would only restamp it.
        for (const key of STATS_CHECKS) {
          if (key !== 'storage') cache.set(collection, `stats_${key}`, computed[key]);
        }
      } catch (err) {
        if (!isAbort(err)) {
          /* silent */
        }
        return;
      }
    }
  } else {
    const pipelines: Record<string, any> = buildAllPipelines(fields);
    await Promise.allSettled(
      STATS_CHECKS.map(async (key) => {
        if (signal?.aborted) return;
        const cacheKey = `stats_${key}`;
        if (cache.get(collection, cacheKey) !== null) return;
        try {
          const res = await api.aggregate(collection, pipelines[key], { signal });
          if (signal?.aborted) return;
          cache.set(collection, cacheKey, res);
        } catch (err) {
          if (!isAbort(err)) {
            /* silent */
          }
        }
      }),
    );
  }
  if (signal?.aborted) return;
  cache.set(collection, 'statsRunSize', runSize);
  updateStatsSummary(collection);
}

// ── Tab-to-prefetch mapping ─────────────────────

const PANEL_PREFETCH: Record<string, (col: string, signal?: AbortSignal) => Promise<unknown>> = {
  data: (col, signal) =>
    Promise.allSettled([prefetchRecords(col, signal), prefetchTotalCount(col, signal)]),
  indexes: (col, signal) => prefetchIndexes(col, signal),
  'search-indexes': (col, signal) => prefetchSearchIndexes(col, signal),
  stats: (col, signal) => prefetchStats(col, signal),
};

// ── Public API ──────────────────────────────────

export function prefetchForPanel(
  collection: string,
  panel: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  const fn = PANEL_PREFETCH[panel];
  return fn ? fn(collection, signal) : Promise.resolve();
}

export function prefetchAll(collection: string, { signal }: { signal?: AbortSignal } = {}) {
  return Promise.allSettled([
    prefetchRecords(collection, signal),
    prefetchTotalCount(collection, signal),
    prefetchIndexes(collection, signal),
    prefetchSearchIndexes(collection, signal),
    prefetchStats(collection, signal),
  ]);
}
