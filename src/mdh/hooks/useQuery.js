import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { records as recordsSignal, loading, error } from '../store.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import JSON5 from 'json5';

export function useQuery() {
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      queryId: 0,
      lastQueryMs: signal(0),
      cacheNextQuery: false,
      controller: null,
    };
  }
  const state = stateRef.current;

  async function runQuery(collection, rawText, substituteFn) {
    if (!collection || !rawText) return;

    // Unfilled variables substitute to an empty string, so there is nothing to
    // "wait for" — just run whatever resolves to a valid pipeline. (Invalid
    // JSON, e.g. a half-typed pipeline, is still skipped by the parse below.)
    const resolvedText = substituteFn ? substituteFn(rawText) : rawText;

    let pipeline;
    try {
      pipeline = JSON5.parse(resolvedText);
      if (!Array.isArray(pipeline)) return;
    } catch { return; }

    // Capture and immediately consume the one-shot cache flag so it stays
    // bound to *this* call. Without this, a slow query A could supersede,
    // then query B would see A's flag and cache B's result for a different
    // collection.
    const shouldCache = state.cacheNextQuery;
    state.cacheNextQuery = false;

    // Abort any in-flight aggregate so a superseded request stops consuming
    // bandwidth and can never write its (stale) result into the cache slot.
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const thisQueryId = ++state.queryId;

    try {
      loading.value = true;
      error.value = null;
      const start = performance.now();
      const res = await api.aggregate(collection, pipeline, { signal: controller.signal });
      if (thisQueryId !== state.queryId) return;
      const elapsed = Math.round(performance.now() - start);
      state.lastQueryMs.value = elapsed;
      const result = res.result || [];
      if (shouldCache) cache.set(collection, 'records', result);
      recordsSignal.value = result;
      loading.value = false;
      return { records: result, elapsed };
    } catch (err) {
      if (thisQueryId !== state.queryId) return;
      if (err?.name !== 'AbortError') {
        error.value = { message: err.message };
      }
      loading.value = false;
    }
  }

  function setCacheNextQuery(val) {
    state.cacheNextQuery = val;
  }

  return {
    lastQueryMs: state.lastQueryMs,
    runQuery,
    setCacheNextQuery,
  };
}
