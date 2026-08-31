import { useEffect, useRef } from 'preact/hooks';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { isTransitional } from '../searchIndexDef.js';

// MDH V2 writes return 202 with no operation id, so there is nothing to poll on
// the operation_status endpoint the way useOperationStatus does — progress is
// only visible in the resource itself. This re-reads the index list while any
// index is transitional and hands each result to the panel.
//
// Observed timings that set the constants (live, 2026-08-28): PENDING_CREATE at
// 0.7s, PENDING at 33s, READY at 55s; a delete disappeared after about 8s. The
// cap is a backstop, not an expectation.
const INTERVAL_MS = 2000;
const MAX_MS = 180_000;
const MAX_ERRORS = 3;

export default function useIndexReconcile(onRows: (rows: any[], checkedAt: number) => void) {
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The panel re-renders on every poll, so `watch` must not capture a stale
  // callback — keep the latest in a ref rather than in the closure.
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  useEffect(() => stop, []);

  function watch(collection: string) {
    stop();
    if (!collection) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();
    let errors = 0;

    const tick = async () => {
      if (controller.signal.aborted) return;
      try {
        const rows = await api.listSearchIndexes(collection, { signal: controller.signal });
        if (controller.signal.aborted) return;
        errors = 0;
        const list = Array.isArray(rows) ? rows : [];
        cache.set(collection, 'searchIndexes', list);
        onRowsRef.current(list, Date.now());
        // Anything unrecognised counts as settled, so a future status value can
        // only stop the poll early — never spin it forever.
        if (!list.some((r) => isTransitional(r?.status))) return;
      } catch {
        if (controller.signal.aborted) return;
        // A failed poll is not a failed reconcile. Retry a few times, then leave
        // whatever the panel last rendered — the badges are already honest and
        // the panel has a Refresh button.
        if (++errors >= MAX_ERRORS) return;
      }
      if (Date.now() - started > MAX_MS) return;
      timerRef.current = setTimeout(tick, INTERVAL_MS);
    };

    tick();
  }

  return { watch, stop };
}
