import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, error, statsSummary } from '../store.js';
import {
  computeHealthScore, healthComponents, transformStatsResults, updateStatsSummary,
} from '../statsSummary.js';
import {
  transformCardinality, transformDistribution, transformNumeric, transformDates,
  transformStorage, transformDocSize, fieldTypeSummary, buildFieldProfiles,
  indexPrefixMap,
} from '../statsView.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import {
  FIELD_DISCOVERY_SIZE, discoverFieldsWithTotal, buildOverviewPipeline, buildAllPipelines, STATS_CHECKS,
} from '../statsPipelines.js';
import StatsSummary from './StatsSummary.jsx';
import StatsSchema from './StatsSchema.jsx';
import StatsFieldGrid from './StatsFieldGrid.jsx';

export default function StatsPanel() {
  const [overview, setOverview] = useState<any>(null);   // { total, fieldCount }
  const [raw, setRaw] = useState<Record<string, any>>({});                // { [check]: apiResponse }
  const [fields, setFields] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<Record<string, any>>({});
  const [discovering, setDiscovering] = useState(false);
  const [fieldsTotal, setFieldsTotal] = useState(0); // uncapped discovered field count
  const [indexes, setIndexes] = useState<any>(null); // regular index list (cache-first)
  const runIdRef = useRef(0);

  function setStatus(key: any, value: any) { setStatuses((prev) => ({ ...prev, [key]: value })); }

  useEffect(() => {
    const collection = selectedCollection.value;
    if (!collection || activePanel.value !== 'stats') return;
    const runId = ++runIdRef.current;
    setOverview(null); setRaw({}); setFields([]); setStatuses({}); setDiscovering(true); setFieldsTotal(0); setIndexes(null);

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
          const sample = await api.aggregate(collection, [{ $sample: { size: FIELD_DISCOVERY_SIZE } }]);
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
        } catch { /* no index markers on failure */ }
      })();

      // Phase 1.5: exact count
      setStatus('overview', 'loading');
      let totalDocs = 0;
      try {
        const cachedCount = cache.get(collection, 'totalCount');
        if (cachedCount !== null) totalDocs = cachedCount;
        else {
          const countRes = await api.aggregate(collection, buildOverviewPipeline());
          if (runId !== runIdRef.current) return;
          totalDocs = countRes.result?.[0]?.count ?? 0;
          cache.set(collection, 'totalCount', totalDocs);
        }
        setOverview({ total: totalDocs, fieldCount: discoveredFields.length });
        setStatus('overview', 'done');
      } catch (err: any) {
        if (runId !== runIdRef.current) return;
        setStatus('overview', { error: err.message });
      }

      // Phase 2: run all checks in parallel; publish each raw response as it lands.
      const pipelines = buildAllPipelines(discoveredFields);
      for (const key of STATS_CHECKS) setStatus(key, 'loading');
      await Promise.allSettled(STATS_CHECKS.map(async (key) => {
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
      }));
      if (runId !== runIdRef.current) return;
      updateStatsSummary(collection); // unchanged tab-bar dot path
    })();
  }, [selectedCollection.value, activePanel.value]);

  const allKeys = [...STATS_CHECKS, 'overview'];
  const resolved = (k: any) => statuses[k] === 'done' || (statuses[k] && statuses[k].error);
  const doneCount = allKeys.filter(resolved).length;
  const totalChecks = allKeys.length;
  const allDone = doneCount === totalChecks && !discovering;
  const running = fields.length > 0 && !allDone;

  if (!selectedCollection.value) return null;

  // ── derive view models from raw responses (cheap; <= 50 fields) ──
  const t = transformStatsResults(
    { coverage: raw.coverage, empties: raw.empties, types: raw.types, strings: raw.strings, schema: raw.schema, sentinels: raw.sentinels },
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
    fields, total: overview?.total || 0,
    coverage: t.coverage, empties: t.empties, typeSummary,
    cardinality, distribution, strings: t.strings, numeric, dates, sentinels: t.sentinels,
  });
  const health = computeHealthScore(t.coverage as any[], t.empties, t.types, t.strings, t.schemaShapes, fields, t.sentinels);
  const components = t.coverage ? healthComponents(t.coverage, t.empties, t.types, t.strings, t.schemaShapes, fields, t.sentinels) : null;
  const idxMap = indexPrefixMap(indexes || []);

  return (
    <div class="panel stats-panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">Collection Stats</span>
        {(discovering || running) && (
          <span class="stats-progress">
            <span class="stats-progress-spinner" />
            {discovering ? 'Discovering fields' : `${doneCount} / ${totalChecks} checks`}
          </span>
        )}
        <button class="icon-btn" title="Re-run analysis" onClick={() => {
          cache.invalidateData(selectedCollection.value);
          statsSummary.value = null;
          activePanel.value = '';
          setTimeout(() => { activePanel.value = 'stats'; }, 0);
        }}>{'↻'}</button>
      </div>

      {running && (
        <div class="stats-progress-track">
          <div class="stats-progress-fill" style={{ width: `${Math.round((doneCount / totalChecks) * 100)}%` }} />
        </div>
      )}

      <div class="stats-scroll" style="display:flex;flex-direction:column;gap:16px">
        {discovering && <div class="stats-empty">Discovering fields{'…'}</div>}
        {fields.length === 0 && !discovering && <div class="stats-empty">No fields found in collection</div>}

        {overview && (
          <StatsSummary
            health={health} components={components}
            total={overview.total} fieldCount={overview.fieldCount} fieldsTotal={fieldsTotal}
            storage={storage} docSize={docSize}
          />
        )}
        {overview && t.schemaShapes && t.schemaShapes.length > 0 && (
          <StatsSchema schemaShapes={t.schemaShapes} />
        )}
        {fields.length > 0 && (
          <StatsFieldGrid profiles={profiles} indexMap={idxMap} />
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
