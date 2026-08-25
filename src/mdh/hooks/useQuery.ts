import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { trackOnce } from '../../usage/track.js';
import { records as recordsSignal, loading, error } from '../store.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import JSON5 from 'json5';

type QueryState = {
  queryId: number;
  lastQueryMs: ReturnType<typeof signal<number>>;
  cacheNextQuery: boolean;
  controller: AbortController | null;
};

export function useQuery() {
  const stateRef = useRef<QueryState | null>(null);
  if (!stateRef.current) {
    stateRef.current = {
      queryId: 0,
      lastQueryMs: signal(0),
      cacheNextQuery: false,
      controller: null,
    };
  }
  const state = stateRef.current!;

  async function runQuery(
    collection: string | null | undefined,
    rawText: string | null | undefined,
    substituteFn?: (text: string) => string,
  ) {
    if (!collection || !rawText) return;
    // trackOnce, NOT track: DataPanel auto-invokes this on collection select,
    // sort, filter, pagination and every editor keystroke, so per-call counting
    // measured typing rather than use. Once per Console session is the honest
    // signal — "this person used the query surface".
    trackOnce('sa_mdh_query_run');

    // Unfilled variables substitute to an empty string, so there is nothing to
    // "wait for" — just run whatever resolves to a valid pipeline. (Invalid
    // JSON, e.g. a half-typed pipeline, is still skipped by the parse below.)
    const resolvedText = substituteFn ? substituteFn(rawText) : rawText;

    let pipeline: unknown;
    try {
      pipeline = JSON5.parse(resolvedText);
      if (!Array.isArray(pipeline)) return;
    } catch {
      return;
    }

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
      const res = await api.aggregate(collection, pipeline as any[], { signal: controller.signal });
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
      if ((err as any)?.name !== 'AbortError') {
        error.value = { message: (err as any).message };
      }
      loading.value = false;
    }
  }

  function setCacheNextQuery(val: boolean) {
    state.cacheNextQuery = val;
  }

  return {
    lastQueryMs: state.lastQueryMs,
    runQuery,
    setCacheNextQuery,
  };
}
