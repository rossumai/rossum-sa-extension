import { h, Fragment } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import { collections, selectedCollection, activeView, connected } from '../store.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { buildStoragePipeline, buildBatchStoragePipeline } from '../statsPipelines.js';
import FlashOnChange from './FlashOnChange.jsx';
import OverviewCharts from './OverviewCharts.jsx';
import CollectionEmptyState from './CollectionEmptyState.jsx';

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 3;
const LIVE_POLL_VISIBLE_MS = 15_000;
const LIVE_POLL_HIDDEN_MS = 120_000;

function formatBytes(n) {
  if (n == null) return '\u2014';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

async function runWithConcurrency(items, concurrency, signal, worker) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal.aborted) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(workers);
}

function extractStats(row) {
  const s = row?.storageStats || {};
  return {
    count: s.count,
    size: s.size,
    storageSize: s.storageSize,
    avgObjSize: s.avgObjSize,
    nindexes: s.nindexes,
    totalIndexSize: s.totalIndexSize,
  };
}

export default function OverviewPanel() {
  const cols = collections.value;
  const [data, setData] = useState({});
  const [loadingSet, setLoadingSet] = useState(new Set());
  const [sortKey, setSortKey] = useState('count');
  const [sortDir, setSortDir] = useState('desc');
  const [reloadKey, setReloadKey] = useState(0);
  const abortRef = useRef(null);

  // Shared fetch pipeline used by both the initial load (cache-first, populates
  // loadingSet) and the live poll (cache-bypass, leaves loadingSet alone).
  // `publish(name, value)` is called incrementally as each batch resolves.
  async function streamStats(names, signal, publish, { useCache }) {
    const toFetch = [];
    if (useCache) {
      for (const name of names) {
        const cached = cache.get(name, 'stats_storage');
        if (cached) {
          const s = cached.result?.[0]?.storageStats;
          if (typeof s?.count === 'number' && cache.get(name, 'totalCount') === null) {
            cache.set(name, 'totalCount', s.count);
          }
          publish(name, extractStats(cached.result?.[0]));
        } else {
          toFetch.push(name);
        }
      }
    } else {
      toFetch.push(...names);
    }

    function cacheAndRecord(name, res) {
      cache.set(name, 'stats_storage', res);
      const s = res.result?.[0]?.storageStats;
      if (typeof s?.count === 'number' && cache.get(name, 'totalCount') === null) {
        cache.set(name, 'totalCount', s.count);
      }
      publish(name, extractStats(res.result?.[0]));
    }

    async function fetchOne(name) {
      try {
        const res = await api.aggregate(name, buildStoragePipeline(), { signal });
        if (signal.aborted) return;
        cacheAndRecord(name, res);
      } catch (err) {
        if (err.name === 'AbortError') return;
        publish(name, { error: err.message });
      }
    }

    async function fetchBatch(group) {
      if (group.length === 0) return;
      if (group.length === 1) { await fetchOne(group[0]); return; }
      try {
        const res = await api.aggregate(group[0], buildBatchStoragePipeline(group), { signal });
        if (signal.aborted) return;
        const byName = new Map();
        for (const row of res.result || []) if (row?._coll) byName.set(row._coll, row);
        for (const name of group) {
          const row = byName.get(name);
          if (!row) { publish(name, { error: 'Missing from batch response' }); continue; }
          cacheAndRecord(name, { result: [row] });
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        await runWithConcurrency(group, BATCH_CONCURRENCY, signal, fetchOne);
      }
    }

    const batches = [];
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      batches.push(toFetch.slice(i, i + BATCH_SIZE));
    }
    await runWithConcurrency(batches, BATCH_CONCURRENCY, signal, fetchBatch);
  }

  // Microtask-batched publisher — coalesces N concurrent arrivals into one
  // setData/setLoadingSet pass. `withLoadingSet=false` is used by the poll
  // path so it never re-shows skeletons.
  function makePublisher(controller, withLoadingSet) {
    const pending = {};
    let scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (controller.signal.aborted) return;
        const batch = pending.batch;
        const done = pending.done;
        pending.batch = null;
        pending.done = null;
        if (batch) setData((d) => ({ ...d, ...batch }));
        if (withLoadingSet && done) {
          setLoadingSet((prev) => {
            const next = new Set(prev);
            for (const n of done) next.delete(n);
            return next;
          });
        }
      });
    }
    return function publish(name, value) {
      (pending.batch ||= {})[name] = value;
      if (withLoadingSet) (pending.done ||= []).push(name);
      schedule();
    };
  }

  // Initial load — shows skeletons, cache-first.
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setData({});
    setLoadingSet(new Set(cols));

    streamStats(cols, controller.signal, makePublisher(controller, true), { useCache: true });

    return () => controller.abort();
  }, [cols, reloadKey]);

  // Live polling — refreshes values in place at a visibility-aware cadence
  // so users watching a collection grow (e.g., during a bulk import) see
  // counts and sizes update without manual refresh. Only ticks while the
  // overview is the active view.
  useEffect(() => {
    if (cols.length === 0) return undefined;

    let cancelled = false;
    let timer = null;
    let inFlight = false;
    let pollController = null;

    const delay = () => (document.visibilityState === 'hidden' ? LIVE_POLL_HIDDEN_MS : LIVE_POLL_VISIBLE_MS);
    const schedule = (ms = delay()) => {
      if (cancelled || timer) return;
      timer = setTimeout(tick, ms);
    };

    async function tick() {
      timer = null;
      if (cancelled || inFlight) return;
      if (activeView.value !== 'overview') { schedule(); return; }
      inFlight = true;
      pollController = new AbortController();
      try {
        await streamStats(cols, pollController.signal, makePublisher(pollController, false), { useCache: false });
      } catch {
        // poll errors are non-fatal — try again next tick
      } finally {
        inFlight = false;
        pollController = null;
        schedule();
      }
    }

    function onVisibility() {
      if (cancelled) return;
      if (document.visibilityState === 'visible') {
        if (timer) { clearTimeout(timer); timer = null; }
        tick();
      }
    }

    schedule();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (pollController) pollController.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cols, reloadKey]);

  function onSort(key) {
    if (sortKey === key) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function sortIndicator(key) {
    if (sortKey !== key) return null;
    return <span class="stats-sort-arrow">{sortDir === 'desc' ? '\u25be' : '\u25b4'}</span>;
  }

  const rows = cols.map((name) => ({ name, ...(data[name] || {}) }));
  rows.sort((a, b) => {
    if (sortKey === 'name') {
      const cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      return sortDir === 'desc' ? -cmp : cmp;
    }
    const av = a[sortKey];
    const bv = b[sortKey];
    const an = av == null ? -1 : av;
    const bn = bv == null ? -1 : bv;
    if (an === bn) return a.name.localeCompare(b.name, undefined, { numeric: true });
    return sortDir === 'desc' ? bn - an : an - bn;
  });

  const totals = rows.reduce((acc, r) => {
    acc.count += r.count || 0;
    acc.storageSize += r.storageSize || 0;
    acc.size += r.size || 0;
    acc.totalIndexSize += r.totalIndexSize || 0;
    acc.nindexes += r.nindexes || 0;
    return acc;
  }, { count: 0, storageSize: 0, size: 0, totalIndexSize: 0, nindexes: 0 });

  // Size-bar normalization. Bars are proportional to the largest value in
  // each column so the dominant collection fills the bar and smaller ones
  // scale visibly against it (share-of-total would hide variance when one
  // collection dwarfs the others).
  const maxStorageSize = rows.reduce((m, r) => Math.max(m, r.storageSize || 0), 0);
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count || 0), 0);
  const maxIndexSize = rows.reduce((m, r) => Math.max(m, r.totalIndexSize || 0), 0);
  function barPct(value, max) {
    if (!value || !max) return 0;
    return Math.max((value / max) * 100, 1);
  }

  const loadingCount = loadingSet.size;
  const totalCount = cols.length;
  const doneCount = totalCount - loadingCount;

  function openCollection(name) {
    selectedCollection.value = name;
    activeView.value = 'collection';
  }

  function refresh() {
    for (const name of cols) cache.invalidate(name, 'stats_storage');
    setReloadKey((k) => k + 1);
  }

  return (
    <div class="panel stats-panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">All Collections</span>
        {loadingCount > 0 && (
          <span class="stats-progress">
            <span class="stats-progress-spinner" />
            {doneCount} / {totalCount}
          </span>
        )}
        <button class="icon-btn" title="Refresh" onClick={refresh}>{'\u21bb'}</button>
      </div>

      {totalCount > 0 && (
        <OverviewCharts rows={rows} settled={doneCount === totalCount} onOpen={openCollection} />
      )}

      {loadingCount > 0 && totalCount > 0 && (
        <div class="stats-progress-track">
          <div class="stats-progress-fill" style={{ width: `${Math.round((doneCount / totalCount) * 100)}%` }} />
        </div>
      )}

      <div class="stats-scroll">
        {totalCount === 0 ? (
          <CollectionEmptyState connected={connected.value} />
        ) : (
          <table class="stats-table stats-overview-table">
            <colgroup>
              <col />
              <col style="width:120px" />
              <col style="width:100px" />
              <col style="width:100px" />
              <col style="width:90px" />
              <col style="width:80px" />
              <col style="width:100px" />
            </colgroup>
            <thead>
              <tr>
                <th class="stats-sortable" onClick={() => onSort('name')}>Collection{sortIndicator('name')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('count')}>Documents{sortIndicator('count')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('storageSize')}>On disk{sortIndicator('storageSize')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('size')}>Logical{sortIndicator('size')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('avgObjSize')}>Avg doc{sortIndicator('avgObjSize')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('nindexes')}>Indexes{sortIndicator('nindexes')}</th>
                <th class="stats-sortable stats-num" onClick={() => onSort('totalIndexSize')}>Index size{sortIndicator('totalIndexSize')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isLoading = loadingSet.has(r.name);
                const err = r.error;
                return (
                  <tr
                    class="stats-clickable"
                    onClick={() => openCollection(r.name)}
                    title={`Open "${r.name}"`}
                  >
                    <td>{r.name}</td>
                    {err ? (
                      <td colspan="6" class="stats-row-error">{err}</td>
                    ) : isLoading ? (
                      <Fragment>
                        <td class="stats-num"><span class="stats-skeleton" style="width:90px" /></td>
                        <td class="stats-num"><span class="stats-skeleton" style="width:72px" /></td>
                        <td class="stats-num"><span class="stats-skeleton" style="width:72px" /></td>
                        <td class="stats-num"><span class="stats-skeleton" style="width:60px" /></td>
                        <td class="stats-num"><span class="stats-skeleton" style="width:32px" /></td>
                        <td class="stats-num"><span class="stats-skeleton" style="width:70px" /></td>
                      </Fragment>
                    ) : (
                      <Fragment>
                        <td class="stats-mono stats-num stats-coverage-cell">
                          <div class="stats-coverage-bar" style={{ width: `${barPct(r.count, maxCount)}%` }} />
                          <span class="stats-coverage-text"><FlashOnChange value={r.count != null ? r.count.toLocaleString() : '\u2014'} /></span>
                        </td>
                        <td class="stats-mono stats-num stats-coverage-cell">
                          <div class="stats-coverage-bar" style={{ width: `${barPct(r.storageSize, maxStorageSize)}%` }} />
                          <span class="stats-coverage-text"><FlashOnChange value={formatBytes(r.storageSize)} /></span>
                        </td>
                        <td class="stats-mono stats-num"><FlashOnChange value={formatBytes(r.size)} /></td>
                        <td class="stats-mono stats-num"><FlashOnChange value={formatBytes(r.avgObjSize)} /></td>
                        <td class="stats-mono stats-num"><FlashOnChange value={r.nindexes ?? '\u2014'} /></td>
                        <td class="stats-mono stats-num stats-coverage-cell">
                          <div class="stats-coverage-bar" style={{ width: `${barPct(r.totalIndexSize, maxIndexSize)}%` }} />
                          <span class="stats-coverage-text"><FlashOnChange value={formatBytes(r.totalIndexSize)} /></span>
                        </td>
                      </Fragment>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {doneCount > 0 && (
              <tfoot>
                <tr class="stats-totals-row">
                  <td><strong>Total ({totalCount})</strong></td>
                  <td class="stats-mono stats-num"><strong><FlashOnChange value={totals.count.toLocaleString()} /></strong></td>
                  <td class="stats-mono stats-num"><strong><FlashOnChange value={formatBytes(totals.storageSize)} /></strong></td>
                  <td class="stats-mono stats-num"><strong><FlashOnChange value={formatBytes(totals.size)} /></strong></td>
                  <td class="stats-mono stats-num">{'\u2014'}</td>
                  <td class="stats-mono stats-num"><strong><FlashOnChange value={totals.nindexes.toLocaleString()} /></strong></td>
                  <td class="stats-mono stats-num"><strong><FlashOnChange value={formatBytes(totals.totalIndexSize)} /></strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}
