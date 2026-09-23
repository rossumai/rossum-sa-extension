import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, error, statsSummary, statsMode } from '../store.js';
import {
  computeHealthScore,
  healthComponents,
  transformStatsResults,
  updateStatsSummary,
} from '../statsSummary.js';
import {
  transformCardinality,
  transformDistribution,
  transformNumeric,
  transformDates,
  transformStorage,
  transformDocSize,
  fieldTypeSummary,
  buildFieldProfiles,
  indexPrefixMap,
} from '../statsView.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { assembleSampledStats, docSizeFromStorage } from '../statsCompute.js';
import {
  FIELD_DISCOVERY_SIZE,
  discoverFieldsWithTotal,
  buildOverviewPipeline,
  buildAllPipelines,
  buildSampleReadPipeline,
  buildStoragePipeline,
  sampledStatsKey,
  analysisPlan,
  statsModeLabel,
  STATS_MODES,
  STATS_MODE_SAMPLE,
  STATS_MODE_EXACT,
  STATS_CHECKS,
  STATS_EXACT,
} from '../statsPipelines.js';
import StatsSummary from './StatsSummary.jsx';
import StatsSchema from './StatsSchema.jsx';
import StatsFieldGrid from './StatsFieldGrid.jsx';

export default function StatsPanel() {
  const [overview, setOverview] = useState<any>(null); // { total, fieldCount }
  const [raw, setRaw] = useState<Record<string, any>>({}); // { [check]: apiResponse }
  const [fields, setFields] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<Record<string, any>>({});
  const [discovering, setDiscovering] = useState(false);
  const [fieldsTotal, setFieldsTotal] = useState(0); // uncapped discovered field count
  const [indexes, setIndexes] = useState<any>(null); // regular index list (cache-first)
  const [analyzed, setAnalyzed] = useState(0); // documents the numbers came from
  const [sampledSize, setSampledSize] = useState<number | null>(null); // null on an exact run
  // Whether sampling could engage AT ALL for this collection, independent of
  // the chosen mode — i.e. analysisPlan(..., STATS_MODE_SAMPLE).sampled. True
  // until the first plan lands, so the control shows the stored mode rather
  // than flashing a disabled Sample segment during discovery.
  const [canSample, setCanSample] = useState(true);
  // Which reason canSample is false, so the disabled Sample segment's title
  // does not claim "small enough" when the real cause is a failed storage
  // probe. Only meaningful alongside canSample === false; reset with it.
  const [sizeUnknown, setSizeUnknown] = useState(false);
  const runIdRef = useRef(0);

  function setStatus(key: any, value: any) {
    setStatuses((prev) => ({ ...prev, [key]: value }));
  }

  useEffect(() => {
    const collection = selectedCollection.value;
    if (!collection || activePanel.value !== 'stats') return;
    const runId = ++runIdRef.current;
    setOverview(null);
    setRaw({});
    setFields([]);
    setStatuses({});
    setDiscovering(true);
    setFieldsTotal(0);
    setIndexes(null);
    setCanSample(true);
    setSizeUnknown(false);

    (async () => {
      // Phase 1: discover fields (cache from preload if available)
      let discoveredFields;
      try {
        error.value = null;
        const cached = cache.get(collection, 'statsFields');
        if (cached) {
          discoveredFields = cached;
          setFieldsTotal(cache.get(collection, 'statsFieldsTotal') ?? cached.length);
        } else {
          const sample = await api.aggregate(collection, [
            { $sample: { size: FIELD_DISCOVERY_SIZE } },
          ]);
          if (runId !== runIdRef.current) return;
          const discovered = discoverFieldsWithTotal(sample.result || []);
          discoveredFields = discovered.fields;
          cache.set(collection, 'statsFields', discoveredFields);
          cache.set(collection, 'statsFieldsTotal', discovered.total);
          setFieldsTotal(discovered.total);
        }
        setFields(discoveredFields);
        setDiscovering(false);
      } catch (err: any) {
        if (runId !== runIdRef.current) return;
        error.value = { message: `Stats: ${err.message}` };
        setDiscovering(false);
        return;
      }
      if (discoveredFields.length === 0) return;

      // Regular indexes (cache-first; prefetch usually populates them) to mark
      // which fields are the leading key of an index. Best-effort, non-blocking.
      (async () => {
        try {
          let idx = cache.get(collection, 'indexes');
          if (idx == null) {
            const res = await api.listIndexes(collection, false);
            idx = res.result || [];
            cache.set(collection, 'indexes', idx);
          }
          if (runId === runIdRef.current) setIndexes(idx);
        } catch {
          /* no index markers on failure */
        }
      })();

      // Phase 1.5: exact count and storage stats (both $collStats, O(1)
      // metadata). avgObjSize now decides the sampled/exact path, so it must
      // be known before that decision instead of alongside the sampled read.
      //
      // The two settle INDEPENDENTLY. Sharing one Promise.all meant a failed
      // storage probe rejected before setOverview and took the count with it,
      // although the count was already in hand: the summary and the schema
      // view disappeared, and analysisPlan(0, …) then sent eleven
      // full-collection scans at a multi-million-document collection — the
      // exact behaviour sampling exists to remove. A missing avgObjSize should
      // cost the sampled path, nothing else.
      setStatus('overview', 'loading');
      let totalDocs = 0;
      let storageRes: any = null;
      let storageFetched = false;
      const cachedCount = cache.get(collection, 'totalCount');
      const cachedStorage = cache.get(collection, 'stats_storage');
      const [countOutcome, storageOutcome] = await Promise.allSettled([
        cachedCount !== null
          ? Promise.resolve(null)
          : api.aggregate(collection, buildOverviewPipeline()),
        cachedStorage !== null
          ? Promise.resolve(null)
          : api.aggregate(collection, buildStoragePipeline()),
      ]);
      if (runId !== runIdRef.current) return;
      if (cachedStorage !== null) {
        storageRes = cachedStorage;
      } else if (storageOutcome.status === 'fulfilled') {
        storageRes = storageOutcome.value;
        storageFetched = true;
      }
      if (countOutcome.status === 'fulfilled') {
        totalDocs =
          cachedCount !== null ? cachedCount : (countOutcome.value?.result?.[0]?.count ?? 0);
        if (cachedCount === null) cache.set(collection, 'totalCount', totalDocs);
        setOverview({ total: totalDocs, fieldCount: discoveredFields.length });
        setStatus('overview', 'done');
      } else {
        // The count aggregate failed but the storage probe succeeded: fall back to
        // storageStats.count (the same count source OverviewPanel already uses)
        // instead of leaving totalDocs at 0, which would blank the summary/schema
        // and send analysisPlan(0, …) down the exact-scan path at a large collection.
        const storageCount = storageRes?.result?.[0]?.storageStats?.count;
        if (typeof storageCount === 'number') {
          totalDocs = storageCount;
          if (cachedCount === null) cache.set(collection, 'totalCount', totalDocs);
          setOverview({ total: totalDocs, fieldCount: discoveredFields.length });
          setStatus('overview', 'done');
        } else {
          setStatus('overview', { error: countOutcome.reason?.message });
        }
      }

      // Phase 2. Above the budgets this is ONE sampled read profiled in the
      // browser; below them (or on Exact), the exact server pipelines,
      // unchanged. What decides is analysisPlan, driven by avgObjSize and the
      // analysed field count.
      const avgObjSize = storageRes?.result?.[0]?.storageStats?.avgObjSize ?? 0;
      const plan = analysisPlan(totalDocs, avgObjSize, discoveredFields.length, statsMode.value);
      setAnalyzed(plan.size);
      setSampledSize(plan.sampled ? plan.size : null);
      // The control shows what will actually happen, not the stored mode: a
      // collection that fits the budgets is read in full even in Sample mode,
      // so the switch must not keep showing Sample as active while the panel
      // renders exact numbers. Derived independently of statsMode.value —
      // storage is never written to mdhStatsMode itself.
      setCanSample(
        analysisPlan(totalDocs, avgObjSize, discoveredFields.length, STATS_MODE_SAMPLE).sampled,
      );
      // Which of the two reasons Sample is disabled: fits the budgets already
      // (avgObjSize known), or avgObjSize is missing because the storage probe
      // failed — analysisPlan falls back to exact in both cases, but only one
      // of them means the collection is actually small.
      setSizeUnknown(!(avgObjSize > 0));

      // The stats_* entries are per collection and live for 10 minutes, so a run
      // can find entries another collection's run left at a DIFFERENT size —
      // one run size is in effect per run, not per cache. Distrust anything not
      // produced at the size this run is about to report, or the strip labels a
      // payload with a sample size it never had.
      const runSize = plan.sampled ? plan.size : STATS_EXACT;
      if (cache.get(collection, 'statsRunSize') !== runSize) {
        cache.invalidate(collection, 'stats_sampled');
        // `storage` is exempt: $collStats metadata is exact and independent of
        // how many documents the run analyses, so it survives a run-size change
        // instead of being dropped and immediately written back.
        for (const key of STATS_CHECKS) {
          if (key !== 'storage') cache.invalidate(collection, `stats_${key}`);
        }
      }
      // Only a FRESH read is written back. cache.set restamps the entry, so
      // writing a cache HIT back on every visit would keep a repeatedly-visited
      // collection's storage figures alive indefinitely past TTL_LONG — and
      // OverviewPanel reads the same key.
      if (storageFetched) cache.set(collection, 'stats_storage', storageRes);

      if (plan.sampled) {
        for (const key of STATS_CHECKS) setStatus(key, 'loading');
        try {
          let computed = cache.get(collection, 'stats_sampled');
          if (!computed) {
            // Single-flight across BOTH callers: this effect and the
            // background prefetch fire from the same
            // selectedCollection/activePanel writes, both miss the cache, and
            // before this both did the whole sampled read. The guard lives in
            // cache.ts precisely so the background prefetch can see it — a map
            // private to that module could only ever dedupe it against itself.
            computed = await cache.single(sampledStatsKey(collection, plan.size), async () => {
              const sampleRes = await api.aggregate(
                collection,
                buildSampleReadPipeline(discoveredFields, plan.size),
              );
              return assembleSampledStats(sampleRes.result || [], discoveredFields, storageRes);
            });
            if (runId !== runIdRef.current) return;
            cache.set(collection, 'stats_sampled', computed);
            // `storage` again exempt: computed.storage IS the entry this run
            // read, so writing it back would only restamp it.
            for (const key of STATS_CHECKS) {
              if (key !== 'storage') cache.set(collection, `stats_${key}`, computed[key]);
            }
          }
          setRaw(computed);
          // $sample can deliver fewer rows than it was asked for, and
          // computeCoverage records what actually ARRIVED as `_total`. Report
          // and divide by that: `plan.size` is the request, and using it would
          // make diversityPct divide by a different number than
          // transformCoverage's own pct while the strip named a sample that
          // never came.
          const delivered = computed.coverage?.result?.[0]?._total ?? plan.size;
          setAnalyzed(delivered);
          setSampledSize(delivered);
          for (const key of STATS_CHECKS) setStatus(key, 'done');
        } catch (err: any) {
          if (runId !== runIdRef.current) return;
          // storage and docSize come from the phase-1.5 $collStats probe, not
          // from the sample, so a failed sampled read leaves them untouched
          // rather than reporting errors for figures already in hand.
          const kept = storageRes ? ['storage', 'docSize'] : [];
          if (storageRes) {
            setRaw((prev) => ({
              ...prev,
              storage: storageRes,
              docSize: docSizeFromStorage(storageRes),
            }));
          }
          // No sample ever arrived, so the info strip must not claim one: clear
          // the PLANNED size set above, or the summary would read "Estimated
          // from a random sample of N of M documents" beside figures (storage,
          // docSize) that are exact $collStats metadata, not estimates.
          setSampledSize(null);
          for (const key of STATS_CHECKS) {
            setStatus(key, kept.includes(key) ? 'done' : { error: err.message });
          }
        }
      } else {
        const pipelines = buildAllPipelines(discoveredFields);
        for (const key of STATS_CHECKS) setStatus(key, 'loading');
        await Promise.allSettled(
          STATS_CHECKS.map(async (key) => {
            const cacheKey = `stats_${key}`;
            try {
              let res = cache.get(collection, cacheKey);
              if (!res) {
                res = await api.aggregate(collection, (pipelines as Record<string, any>)[key]);
                if (runId !== runIdRef.current) return;
                cache.set(collection, cacheKey, res);
              }
              setRaw((prev) => ({ ...prev, [key]: res }));
              setStatus(key, 'done');
            } catch (err: any) {
              if (runId !== runIdRef.current) return;
              setStatus(key, { error: err.message });
            }
          }),
        );
      }
      if (runId !== runIdRef.current) return;
      cache.set(collection, 'statsRunSize', runSize);
      updateStatsSummary(collection); // unchanged tab-bar dot path
    })();
  }, [selectedCollection.value, activePanel.value, statsMode.value]);

  const allKeys = [...STATS_CHECKS, 'overview'];
  const resolved = (k: any) => statuses[k] === 'done' || (statuses[k] && statuses[k].error);
  const doneCount = allKeys.filter(resolved).length;
  const totalChecks = allKeys.length;
  const allDone = doneCount === totalChecks && !discovering;
  const running = fields.length > 0 && !allDone;

  if (!selectedCollection.value) return null;

  // ── derive view models from raw responses (cheap; <= 50 fields) ──
  const t = transformStatsResults(
    {
      coverage: raw.coverage,
      empties: raw.empties,
      types: raw.types,
      strings: raw.strings,
      schema: raw.schema,
      sentinels: raw.sentinels,
    },
    fields,
  );
  const typeSummary = raw.types ? fieldTypeSummary(raw.types, fields) : {};
  const cardinality = raw.cardinality ? transformCardinality(raw.cardinality, fields) : null;
  const distribution = raw.distribution ? transformDistribution(raw.distribution, fields) : null;
  const numeric = raw.numeric ? transformNumeric(raw.numeric, fields) : null;
  const dates = raw.dates ? transformDates(raw.dates, fields) : null;
  const storage = raw.storage ? transformStorage(raw.storage) : null;
  const docSize = raw.docSize ? transformDocSize(raw.docSize) : null;

  const profiles = buildFieldProfiles({
    fields,
    total: overview?.total || 0,
    analyzed,
    coverage: t.coverage,
    empties: t.empties,
    typeSummary,
    cardinality,
    distribution,
    strings: t.strings,
    numeric,
    dates,
    sentinels: t.sentinels,
  });
  const health = computeHealthScore(
    t.coverage as any[],
    t.empties,
    t.types,
    t.strings,
    t.schemaShapes,
    fields,
    t.sentinels,
  );
  const components = t.coverage
    ? healthComponents(
        t.coverage,
        t.empties,
        t.types,
        t.strings,
        t.schemaShapes,
        fields,
        t.sentinels,
      )
    : null;
  const idxMap = indexPrefixMap(indexes || []);
  // What the control SHOWS, derived from the plan rather than read straight
  // off the stored preference — mdhStatsMode itself is never rewritten, so a
  // later, larger collection resumes sampling without the user re-choosing it.
  const shownMode = canSample ? statsMode.value : STATS_MODE_EXACT;

  return (
    <div class="panel stats-panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">Collection Stats</span>
        <span class="view-seg stats-mode-seg" role="group" aria-label="Analysis mode">
          {STATS_MODES.map((m) => {
            // Only Sample can ever be the disabled one: a collection that
            // fits the budgets is read in full regardless of mode, so there
            // is nothing Sample would do here that Exact does not already.
            const isDisabled = m === STATS_MODE_SAMPLE && !canSample;
            return (
              <button
                key={m}
                type="button"
                class={`view-seg-opt${shownMode === m ? ' on' : ''}`}
                aria-pressed={shownMode === m}
                disabled={isDisabled}
                title={
                  isDisabled
                    ? sizeUnknown
                      ? "Sampling needs the collection's average document size, which could not be read"
                      : 'This collection is small enough to read in full'
                    : undefined
                }
                onClick={() => {
                  if (isDisabled) return;
                  // The signal dedupes an identical write, so the effect would not
                  // re-run — and the panel would be left rendering its old state
                  // against a cache this handler had just emptied.
                  if (statsMode.value === m) return;
                  // invalidateData clears every stats_* entry, stats_sampled included.
                  cache.invalidateData(selectedCollection.value);
                  statsMode.value = m;
                }}
              >
                {statsModeLabel(m)}
              </button>
            );
          })}
        </span>
        {(discovering || running) && (
          <span class="stats-progress">
            <span class="stats-progress-spinner" />
            {discovering ? 'Discovering fields' : `${doneCount} / ${totalChecks} checks`}
          </span>
        )}
        <button
          class="icon-btn"
          title="Re-run analysis"
          onClick={() => {
            cache.invalidateData(selectedCollection.value);
            statsSummary.value = null;
            activePanel.value = '';
            setTimeout(() => {
              activePanel.value = 'stats';
            }, 0);
          }}
        >
          {'↻'}
        </button>
      </div>

      {running && (
        <div class="stats-progress-track">
          <div
            class="stats-progress-fill"
            style={{ width: `${Math.round((doneCount / totalChecks) * 100)}%` }}
          />
        </div>
      )}

      <div class="stats-scroll" style="display:flex;flex-direction:column;gap:16px">
        {discovering && <div class="stats-empty">Discovering fields{'…'}</div>}
        {fields.length === 0 && !discovering && (
          <div class="stats-empty">No fields found in collection</div>
        )}

        {overview && (
          <StatsSummary
            health={health}
            components={components}
            total={overview.total}
            fieldCount={overview.fieldCount}
            fieldsTotal={fieldsTotal}
            storage={storage}
            docSize={docSize}
            sampled={sampledSize}
          />
        )}
        {overview && t.schemaShapes && t.schemaShapes.length > 0 && (
          <StatsSchema schemaShapes={t.schemaShapes} />
        )}
        {fields.length > 0 && (
          <StatsFieldGrid profiles={profiles} indexMap={idxMap} sampled={sampledSize} />
        )}

        {running && (
          <div class="stats-loading-bottom">
            <span class="stats-progress-spinner" />
            {`Loading… ${doneCount} / ${totalChecks} checks complete`}
          </div>
        )}
      </div>
    </div>
  );
}
