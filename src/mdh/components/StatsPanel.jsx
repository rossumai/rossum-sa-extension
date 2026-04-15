import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, error, statsSummary } from '../store.js';
import {
  computeHealthScore, healthLabel, transformStatsResults, updateStatsSummary,
} from '../statsSummary.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import {
  FIELD_DISCOVERY_SIZE, TOP_VALUES, encKey, discoverFields,
  buildAllPipelines, buildOverviewPipeline, STATS_CHECKS,
} from '../statsPipelines.js';

const LARGE_COLLECTION_WARN = 100_000;

function FieldName({ path }) {
  const parts = path.split('.');
  if (parts.length === 1) return <span class="stats-field-name">{path}</span>;
  const parent = parts.slice(0, -1).join('.');
  const leaf = parts[parts.length - 1];
  return (
    <span class="stats-field-name">
      <span class="stats-field-parent">{parent}.</span>{leaf}
    </span>
  );
}

// ── UI helpers ──────────────────────────────────

function Section({ title, status, children }) {
  const [isCollapsed, setCollapsed] = useState(false);
  const isError = status && typeof status === 'object' && status.error;
  const statusCls = status === 'done'
    ? 'stats-status-done'
    : isError
      ? 'stats-status-error'
      : 'stats-status-loading';
  const statusText = status === 'done' ? 'done' : isError ? 'error' : 'running\u2026';
  return (
    <div class="stats-section">
      <div class="stats-section-header" onClick={() => setCollapsed(!isCollapsed)}>
        <span class="stats-section-chevron">{isCollapsed ? '\u25b8' : '\u25be'}</span>
        <span class="stats-section-title" style="flex:1">{title}</span>
        <span class={`stats-status ${statusCls}`}>{statusText}</span>
      </div>
      {!isCollapsed && (
        <div class="stats-section-body">
          {isError && <div class="stats-error">{status.error}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

function healthColor(score) {
  if (score >= 90) return 'var(--success)';
  if (score >= 75) return 'var(--accent)';
  if (score >= 50) return 'var(--warning)';
  return 'var(--danger)';
}

function formatValue(v) {
  if (v === null) return 'null';
  if (v === '') return '""';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isSpecialValue(v) {
  return v === null || v === '' || v === true || v === false || typeof v === 'undefined';
}

function FormattedValue({ value }) {
  if (value === null) return <span class="stats-dist-special">null</span>;
  if (value === '') return <span class="stats-dist-special">""</span>;
  if (value === true) return <span class="stats-dist-special">true</span>;
  if (value === false) return <span class="stats-dist-special">false</span>;
  if (typeof value === 'object') return <span class="stats-dist-object">{JSON.stringify(value)}</span>;
  return String(value);
}

function formatDate(d) {
  if (!d) return '\u2014';
  const s = typeof d === 'string' ? d : d.$date || String(d);
  try { return new Date(s).toISOString().split('T')[0]; } catch { return String(s); }
}

// ── Visual helpers ──────────────────────────────

function HealthRing({ score }) {
  const size = 80;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const hasScore = score !== null && score !== undefined;
  const offset = hasScore ? circumference - (score / 100) * circumference : circumference;
  const color = hasScore ? healthColor(score) : 'var(--text-secondary)';
  return (
    <svg width={size} height={size} class="stats-health-ring" viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" stroke-width={strokeWidth} />
      {hasScore && (
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} stroke-width={strokeWidth}
          stroke-dasharray={circumference} stroke-dashoffset={offset}
          stroke-linecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`}
          class="stats-health-ring-arc" />
      )}
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        fill={color} class="stats-health-ring-text">{hasScore ? score : '?'}</text>
    </svg>
  );
}



function toTimestamp(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d : d.$date || String(d);
  try { return new Date(s).getTime(); } catch { return null; }
}

function DateTimeline({ ranges }) {
  const timestamps = ranges.flatMap((d) => [toTimestamp(d.earliest), toTimestamp(d.latest)]).filter(Boolean);
  if (timestamps.length < 2) return null;
  const globalMin = Math.min(...timestamps);
  const globalMax = Math.max(...timestamps);
  const span = globalMax - globalMin || 1;
  return (
    <div class="stats-timeline">
      {ranges.map((d) => {
        const start = toTimestamp(d.earliest);
        const end = toTimestamp(d.latest);
        if (start == null || end == null) return null;
        const left = ((start - globalMin) / span) * 100;
        const width = Math.max(((end - start) / span) * 100, 1);
        return (
          <div class="stats-timeline-row">
            <span class="stats-timeline-label">{d.field.split('.').pop()}</span>
            <div class="stats-timeline-track">
              <div class="stats-timeline-bar" style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
            <span class="stats-timeline-dates">{formatDate(d.earliest)} {'\u2014'} {formatDate(d.latest)}</span>
          </div>
        );
      })}
      <div class="stats-timeline-axis">
        <span>{formatDate(new Date(globalMin).toISOString())}</span>
        <span>{formatDate(new Date(globalMax).toISOString())}</span>
      </div>
    </div>
  );
}

// ── Component ───────────────────────────────────

export default function StatsPanel() {
  const [overview, setOverview] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [empties, setEmpties] = useState(null);
  const [types, setTypes] = useState(null);
  const [distribution, setDistribution] = useState(null);
  const [cardinality, setCardinality] = useState(null);
  const [stringAnalysis, setStringAnalysis] = useState(null);
  const [numericStats, setNumericStats] = useState(null);
  const [dateRanges, setDateRanges] = useState(null);
  const [schemaShapes, setSchemaShapes] = useState(null);
  const [fields, setFields] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [discovering, setDiscovering] = useState(false);
  const runIdRef = useRef(0);

  const SECTION_ORDER = ['overview', 'coverage', 'schema', 'cardinality', 'strings', 'numeric', 'dates', 'distribution'];

  function setStatus(key, value) {
    setStatuses((prev) => ({ ...prev, [key]: value }));
  }

  useEffect(() => {
    const collection = selectedCollection.value;
    if (!collection || activePanel.value !== 'stats') return;

    const runId = ++runIdRef.current;
    setOverview(null);
    setCoverage(null);
    setEmpties(null);
    setTypes(null);
    setDistribution(null);
    setCardinality(null);
    setStringAnalysis(null);
    setNumericStats(null);
    setDateRanges(null);
    setSchemaShapes(null);
    setFields([]);
    setStatuses({});
    setDiscovering(true);

    (async () => {
      // Phase 1: discover fields (use cache from preload if available)
      let discoveredFields;
      try {
        error.value = null;
        const cached = cache.get(collection, 'statsFields');
        if (cached) {
          discoveredFields = cached;
        } else {
          const sample = await api.aggregate(collection, [
            { $sample: { size: FIELD_DISCOVERY_SIZE } },
          ]);
          if (runId !== runIdRef.current) return;
          discoveredFields = discoverFields(sample.result || []);
          cache.set(collection, 'statsFields', discoveredFields);
        }
        setFields(discoveredFields);
        setDiscovering(false);
      } catch (err) {
        if (runId !== runIdRef.current) return;
        error.value = { message: `Stats: ${err.message}` };
        setDiscovering(false);
        return;
      }

      if (discoveredFields.length === 0) {
        return;
      }

      // Phase 1.5: get exact count (use totalCount cache from prefetch)
      setStatus('overview', 'loading');
      let totalDocs = 0;
      try {
        const cachedCount = cache.get(collection, 'totalCount');
        if (cachedCount !== null) {
          totalDocs = cachedCount;
        } else {
          const countRes = await api.aggregate(collection, buildOverviewPipeline());
          if (runId !== runIdRef.current) return;
          totalDocs = countRes.result?.[0]?.total ?? 0;
          cache.set(collection, 'totalCount', totalDocs);
        }
        setOverview({ total: totalDocs, fieldCount: discoveredFields.length });
        setStatus('overview', 'done');
      } catch (err) {
        if (runId !== runIdRef.current) return;
        setStatus('overview', { error: err.message });
      }


      // Phase 2: run all analyses in parallel.
      // Each check publishes its slice of the UI as soon as its result lands —
      // sections render progressively rather than waiting for the slowest check.
      // The 5 health-score checks route their result through transformStatsResults
      // (single-key call) so the panel and the tab-bar dot share one transform.
      const pipelines = buildAllPipelines(discoveredFields);

      const resultHandlers = {
        coverage: (res) => setCoverage(transformStatsResults({ coverage: res }, discoveredFields).coverage),
        empties: (res) => setEmpties(transformStatsResults({ empties: res }, discoveredFields).empties),
        types: (res) => setTypes(transformStatsResults({ types: res }, discoveredFields).types),
        strings: (res) => setStringAnalysis(transformStatsResults({ strings: res }, discoveredFields).strings),
        schema: (res) => setSchemaShapes(transformStatsResults({ schema: res }, discoveredFields).schemaShapes),
        cardinality: (res) => {
          const r = res.result?.[0] || {};
          setCardinality(discoveredFields.map((f) => ({
            field: f,
            distinct: r[encKey(f)]?.[0]?.distinct ?? 0,
          })));
        },
        distribution: (res) => {
          const r = res.result?.[0] || {};
          setDistribution(discoveredFields.map((f) => ({
            field: f,
            values: (r[encKey(f)] || []).map((v) => ({ value: v._id, count: v.count })),
          })));
        },
        numeric: (res) => {
          const r = res.result?.[0] || {};
          setNumericStats(discoveredFields.map((f) => {
            const s = r[encKey(f)]?.[0];
            if (!s) return null;
            return { field: f, count: s.count, min: s.min, max: s.max, avg: s.avg };
          }).filter(Boolean));
        },
        dates: (res) => {
          const r = res.result?.[0] || {};
          setDateRanges(discoveredFields.map((f) => {
            const s = r[encKey(f)]?.[0];
            if (!s) return null;
            return { field: f, count: s.count, earliest: s.earliest, latest: s.latest };
          }).filter(Boolean));
        },
      };

      for (const key of STATS_CHECKS) setStatus(key, 'loading');

      await Promise.allSettled(
        STATS_CHECKS.map(async (key) => {
          const cacheKey = `stats_${key}`;
          try {
            let res = cache.get(collection, cacheKey);
            if (!res) {
              res = await api.aggregate(collection, pipelines[key]);
              if (runId !== runIdRef.current) return;
              cache.set(collection, cacheKey, res);
            }
            resultHandlers[key](res);
            setStatus(key, 'done');
          } catch (err) {
            if (runId !== runIdRef.current) return;
            setStatus(key, { error: err.message });
          }
        }),
      );

      if (runId !== runIdRef.current) return;

      // Publish the summary signal once all 9 checks have settled.
      // updateStatsSummary reads the populated cache, so any check that
      // errored will be missing — it bails to null in that case (no false alarm).
      updateStatsSummary(collection);

    })();
  }, [selectedCollection.value, activePanel.value]);

  // Sections render top-to-bottom: a section only appears once all above it have resolved.
  const resolved = (key) => statuses[key] === 'done' || (statuses[key] && statuses[key].error);
  const canShow = (key) => {
    for (const k of SECTION_ORDER) {
      if (k === key) return true;
      // coverage+empties+types are a merged section; all must resolve
      if (k === 'coverage' && !resolved('coverage')) return false;
      if (k === 'coverage' && !resolved('empties')) return false;
      if (k === 'coverage' && !resolved('types')) return false;
      if (k !== 'coverage' && !resolved(k)) return false;
    }
    return true;
  };

  const allKeys = [...SECTION_ORDER, 'empties', 'types'];
  const doneCount = allKeys.filter((k) => resolved(k)).length;
  const totalChecks = allKeys.length;
  const allDone = doneCount === totalChecks && !discovering;
  const running = fields.length > 0 && !allDone;

  if (!selectedCollection.value) return null;

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
        <button
          class="icon-btn"
          title="Re-run analysis"
          onClick={() => {
            cache.invalidateData(selectedCollection.value);
            statsSummary.value = null;
            activePanel.value = '';
            setTimeout(() => { activePanel.value = 'stats'; }, 0);
          }}
        >
          {'\u21bb'}
        </button>
      </div>

      {running && (
        <div class="stats-progress-track">
          <div class="stats-progress-fill" style={{ width: `${Math.round((doneCount / totalChecks) * 100)}%` }} />
        </div>
      )}

      <div class="stats-scroll">
        {discovering && (
          <div class="stats-empty">Discovering fields{'\u2026'}</div>
        )}
        {fields.length === 0 && !discovering && (
          <div class="stats-empty">No fields found in collection</div>
        )}

        {/* Overview + Health */}
        {overview && (() => {
          const health = computeHealthScore(coverage, empties, types, stringAnalysis, schemaShapes, fields);
          return (
            <Section title="Overview" status={statuses.overview}>
              <div class="stats-note">
                All statistics are computed from the full collection. The health score combines field completeness, type consistency, whitespace cleanliness, schema consistency, and value completeness into a single 0–100 rating.
              </div>
              {overview.total > LARGE_COLLECTION_WARN && (
                <div class="stats-warn">
                  This collection has {overview.total.toLocaleString()} documents. Some checks may be slow or time out.
                </div>
              )}
              <div class="stats-overview-grid">
                <div
                  class="stats-overview-card stats-health-card"
                  style={{ borderColor: health !== null ? healthColor(health) : 'var(--border)' }}
                >
                  <HealthRing score={health} />
                  <div class="stats-overview-label">
                    {health !== null ? `Health \u2014 ${healthLabel(health)}` : 'Health \u2014 calculating\u2026'}
                  </div>
                </div>
                <div class="stats-overview-card">
                  <div class="stats-metric-value">{overview.total.toLocaleString()}</div>
                  <div class="stats-metric-label">Documents</div>
                </div>
                <div class="stats-overview-card">
                  <div class="stats-metric-value">{overview.fieldCount}</div>
                  <div class="stats-metric-label">Fields</div>
                </div>
              </div>
            </Section>
          );
        })()}

        {/* ── Data Quality ─────────────────────────── */}

        {/* Field Quality (merged: coverage + empties + types) */}
        {coverage && canShow('coverage') && (
          <Section title="Field Quality" status={
            (statuses.coverage?.error || statuses.empties?.error || statuses.types?.error)
              ? { error: statuses.coverage?.error || statuses.empties?.error || statuses.types?.error }
              : (statuses.coverage === 'done' && statuses.empties === 'done' && statuses.types === 'done') ? 'done' : 'loading'
          }>
            <div class="stats-note">
              The "%" column shows what share of documents have a real value for each field (not null, not missing, not empty).
              When a field is below 100%, the Null, Missing, and Empty columns break down the reason.
              The "Types" column flags fields where the data type varies across documents (e.g., sometimes text, sometimes a number) — this can cause matching failures.
              Colored cells indicate problems.
            </div>
            <table class="stats-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>%</th>
                  <th>Null</th>
                  <th>Missing</th>
                  <th>Empty</th>
                  <th>Types</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((c) => {
                  const e = empties?.find((x) => x.field === c.field);
                  const t = types?.find((x) => x.field === c.field);
                  return (
                    <tr>
                      <td><FieldName path={c.field} /></td>
                      <td class="stats-mono stats-coverage-cell">
                        <div class="stats-coverage-bar" style={{ width: `${c.pct}%` }} />
                        <span class="stats-coverage-text">{c.pct}%</span>
                      </td>
                      <td class="stats-mono">{e && e.nullCount > 0 ? e.nullCount.toLocaleString() : '\u2014'}</td>
                      <td class="stats-mono">{e && e.missingCount > 0 ? e.missingCount.toLocaleString() : '\u2014'}</td>
                      <td class="stats-mono">{e && e.emptyCount > 0 ? e.emptyCount.toLocaleString() : '\u2014'}</td>
                      <td>
                        {t ? (
                          <span class="stats-type-tags-inline">
                            {t.types.map((entry) => (
                              <span class="stats-type-tag stats-type-tag-warn">
                                {entry._id}
                                <span class="stats-type-tag-count">{entry.count.toLocaleString()}</span>
                              </span>
                            ))}
                          </span>
                        ) : '\u2014'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
        )}

        {/* Schema Consistency */}
        {schemaShapes && canShow('schema') && (() => {
          const baseline = schemaShapes[0]?.sampleFields || [];
          const baselineSet = new Set(baseline);
          return (
            <Section title="Schema Consistency" status={statuses.schema}>
              <div class="stats-note">
                Distribution of field counts per document. If all documents have the same number of fields, the schema is consistent.
                Multiple groups indicate documents with different shapes — likely from merged imports or optional fields.
                {schemaShapes.length > 1 && ' Extra/missing fields are compared against the most common shape.'}
              </div>
              {schemaShapes.length <= 1 ? (
                <div class="stats-ok">All documents have the same structure ({schemaShapes[0]?.fieldCount} fields)</div>
              ) : (
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Fields</th>
                      <th>Documents</th>
                      <th>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schemaShapes.map((s, i) => {
                      const fields = s.sampleFields || [];
                      const fieldsSet = new Set(fields);
                      const extra = i === 0 ? [] : fields.filter((f) => !baselineSet.has(f));
                      const missing = i === 0 ? [] : baseline.filter((f) => !fieldsSet.has(f));
                      return (
                        <tr>
                          <td class="stats-mono">{s.fieldCount}</td>
                          <td class="stats-mono">{s.docCount.toLocaleString()}</td>
                          <td>
                            {i === 0 ? (
                              <span class="stats-schema-baseline">most common</span>
                            ) : (
                              <span class="stats-schema-diff">
                                {extra.length > 0 && (
                                  <span class="stats-schema-extra">
                                    {'+\u2009'}{extra.join(', ')}
                                  </span>
                                )}
                                {missing.length > 0 && (
                                  <span class="stats-schema-missing">
                                    {'\u2212\u2009'}{missing.join(', ')}
                                  </span>
                                )}
                                {extra.length === 0 && missing.length === 0 && '\u2014'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          );
        })()}

        {/* ── Field Profiling ────────────────────────── */}

        {/* Distinct Values */}
        {cardinality && canShow('cardinality') && (() => {
          const total = overview?.total || 0;
          const sorted = [...cardinality].sort((a, b) => {
            const pa = total > 0 ? a.distinct / total : 0;
            const pb = total > 0 ? b.distinct / total : 0;
            return pb - pa;
          });
          return (
            <Section title="Field Diversity" status={statuses.cardinality}>
              <div class="stats-note">
                How many different values each field has out of {total.toLocaleString()} documents. Fields sorted from most diverse (likely IDs) to least (likely categories).
              </div>
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th style="min-width:120px">Diversity</th>
                    <th>Distinct</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => {
                    const pct = total > 0 ? Math.round((c.distinct / total) * 100) : 0;
                    const pctLabel = pct === 0 && c.distinct > 0 ? '<1' : String(pct);
                    return (
                      <tr>
                        <td><FieldName path={c.field} /></td>
                        <td class="stats-mono stats-coverage-cell">
                          <div class="stats-coverage-bar" style={{ width: `${pct}%` }} />
                          <span class="stats-coverage-text">{pctLabel}%</span>
                        </td>
                        <td class="stats-mono stats-subtle">{c.distinct.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>
          );
        })()}

        {/* String Analysis (merged: whitespace + string length) */}
        {stringAnalysis && canShow('strings') && (
          <Section title="String Analysis" status={statuses.strings}>
            <div class="stats-note">
              Character length and whitespace analysis for text fields. "Count" is the number of string values for that field.
              If Min and Max length are the same, the data may be padded or truncated. Leading/trailing whitespace (ws) causes invisible matching failures — values look identical but the hidden spaces make them different.
            </div>
            {stringAnalysis.length === 0 ? (
              <div class="stats-ok">No string fields found in this collection</div>
            ) : (
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Count</th>
                    <th>Min len</th>
                    <th>Max len</th>
                    <th>Avg len</th>
                    <th>Leading ws</th>
                    <th>Trailing ws</th>
                  </tr>
                </thead>
                <tbody>
                  {stringAnalysis.map((s) => (
                      <tr>
                        <td><FieldName path={s.field} /></td>
                        <td class="stats-mono">{s.count.toLocaleString()}</td>
                        <td class="stats-mono">{s.minLen}</td>
                        <td class="stats-mono">{s.maxLen}</td>
                        <td class="stats-mono">{s.avgLen}</td>
                        <td class="stats-mono">{s.leading > 0 ? s.leading.toLocaleString() : '\u2014'}</td>
                        <td class="stats-mono">{s.trailing > 0 ? s.trailing.toLocaleString() : '\u2014'}</td>
                      </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {/* Numeric Stats */}
        {numericStats && canShow('numeric') && (
          <Section title="Numeric Stats" status={statuses.numeric}>
            <div class="stats-note">
              Range and average for numeric fields. "Count" is the number of documents with a numeric value for that field.
              A very large gap between Min and Max may indicate data entry errors or placeholder values like 0 or 999999.
            </div>
            {numericStats.length === 0 ? (
              <div class="stats-ok">No numeric fields found in this collection</div>
            ) : (
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Count</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {numericStats.map((n) => (
                    <tr>
                      <td><FieldName path={n.field} /></td>
                      <td class="stats-mono">{n.count.toLocaleString()}</td>
                      <td class="stats-mono">{n.min.toLocaleString()}</td>
                      <td class="stats-mono">{n.max.toLocaleString()}</td>
                      <td class="stats-mono">{Math.round(n.avg).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {/* Date Ranges */}
        {dateRanges && canShow('dates') && (
          <Section title="Date Ranges" status={statuses.dates}>
            <div class="stats-note">
              The date range for each field that contains dates. "Count" is the number of documents with a date value for that field.
              Dates far in the past (e.g., 1970-01-01) or future (e.g., 2099-12-31) usually indicate default or placeholder values.
            </div>
            {dateRanges.length === 0 ? (
              <div class="stats-ok">No date fields found in this collection</div>
            ) : (
              <Fragment>
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Count</th>
                      <th>Earliest</th>
                      <th>Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dateRanges.map((d) => (
                      <tr>
                        <td><FieldName path={d.field} /></td>
                        <td class="stats-mono">{d.count.toLocaleString()}</td>
                        <td class="stats-mono">{formatDate(d.earliest)}</td>
                        <td class="stats-mono">{formatDate(d.latest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dateRanges.length > 1 && <DateTimeline ranges={dateRanges} />}
              </Fragment>
            )}
          </Section>
        )}

        {/* Value Distribution */}
        {distribution && canShow('distribution') && (
          <Section title={`Value Distribution (top ${TOP_VALUES})`} status={statuses.distribution}>
            <div class="stats-note">The most frequently occurring values for each field, with their count. Useful for spotting placeholder data (e.g., "N/A", "TBD"), unexpected duplicates, or fields dominated by a single value.</div>
            <div class="stats-dist-grid">
              {distribution.map((d) => (
                <div class="stats-dist-card">
                  <div class="stats-dist-field"><FieldName path={d.field} /></div>
                  {d.values.length === 0 ? (
                    <div class="stats-dist-empty">no values</div>
                  ) : (
                    (() => {
                      const maxCount = d.values[0]?.count || 1;
                      return d.values.map((v) => (
                        <div class={`stats-dist-row${isSpecialValue(v.value) ? ' stats-dist-row-special' : ''}`}>
                          <div class="stats-dist-bar" style={{ width: `${Math.round((v.count / maxCount) * 100)}%` }} />
                          <span class="stats-dist-value" title={formatValue(v.value)}>
                            <FormattedValue value={v.value} />
                          </span>
                          <span class="stats-dist-count">{v.count.toLocaleString()}</span>
                        </div>
                      ));
                    })()
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {running && (
          <div class="stats-loading-bottom">
            <span class="stats-progress-spinner" />
            {`Loading\u2026 ${doneCount} / ${totalChecks} checks complete`}
          </div>
        )}
      </div>
    </div>
  );
}
