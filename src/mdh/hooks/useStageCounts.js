import { useState, useEffect } from 'preact/hooks';
import * as api from '../api.js';
import { stripWriteStages } from '../pipelineOps.js';

// Fetch the cumulative document count after each active stage (prefix + $count)
// plus the whole-collection input count ($collStats), with per-request timing.
// Shared by the Aggregate Pipeline Debug panel and the full-pipeline inspector
// modal so both report identical numbers (and the modal stays correct when
// stages are toggled, since the active-stage set drives the recompute).
//
// Returns:
//   counts: { [activeIndex]: { count, ms } | { error: { message, status }, ms } }
//   inputInfo: { count, ms } | { error: { message, status }, ms } | null
// Both clear (to {} / null) whenever the collection or active-stage set changes,
// and write stages ($out/$merge) are stripped so a count probe never writes.
export default function useStageCounts(collection, activeStages) {
  const [counts, setCounts] = useState({});
  const [inputInfo, setInputInfo] = useState(null);
  const stages = Array.isArray(activeStages) ? activeStages : [];
  const activeKey = JSON.stringify(stages);

  useEffect(() => {
    if (!collection || stages.length === 0) { setCounts({}); setInputInfo(null); return; }
    setCounts({});
    setInputInfo(null);

    const controller = new AbortController();
    stages.forEach((_, i) => {
      const prefix = stages.slice(0, i + 1);
      const t0 = performance.now();
      api.aggregate(collection, [...stripWriteStages(prefix), { $count: 'n' }], { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const n = res?.result?.[0]?.n ?? 0;
          setCounts((prev) => ({ ...prev, [i]: { count: n, ms: Math.round(performance.now() - t0) } }));
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || controller.signal.aborted) return;
          setCounts((prev) => ({
            ...prev,
            [i]: { error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - t0) },
          }));
        });
    });

    const inputT0 = performance.now();
    api.aggregate(collection, [{ $collStats: { count: {} } }, { $limit: 1 }], { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setInputInfo({ count: res?.result?.[0]?.count ?? 0, ms: Math.round(performance.now() - inputT0) });
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setInputInfo({ error: { message: err?.message || String(err), status: err?.status }, ms: Math.round(performance.now() - inputT0) });
      });

    return () => controller.abort();
  }, [collection, activeKey]);

  return { counts, inputInfo };
}
