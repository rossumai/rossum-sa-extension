// Pure helpers shared between StatsPanel.jsx (health ring)
// and TabBar.jsx (warning dot on the Stats tab).
//
// Moved verbatim from StatsPanel.jsx so both views derive the
// same score from the same inputs. Parameter name `whitespace`
// was renamed to `strings` to reflect what the caller passes.

import { encKey } from './statsPipelines.js';
import { friendlyType } from './statsView.js';
import * as cache from './cache.js';
import { statsSummary } from './store.js';

// Five 0-100 health sub-scores. Extracted from computeHealthScore so the Stats
// dashboard can render the breakdown and the score stays a single source of truth.
export function healthComponents(
  coverage: any[], empties: any[] | null, types: any[] | null, strings: any[] | null, schemaShapes: any[] | null, fields: any[], sentinels: any[] | null = null,
) {
  const n = fields.length;

  // Field coverage: average per-field present %.
  const fieldCoverage = coverage.reduce((sum: number, c: any) => sum + c.pct, 0) / coverage.length;

  // Value completeness: share of fields with no null/empty/missing AND no sentinel strings.
  const affected = new Set<string>();
  for (const e of (empties || [])) affected.add(e.field);
  for (const s of (sentinels || [])) affected.add(s.field);
  const valueCompleteness = ((n - affected.size) / n) * 100;

  // Type consistency: share of fields with a single type.
  const inconsistentCount = types ? types.length : 0;
  const typeConsistency = ((n - inconsistentCount) / n) * 100;

  // Whitespace cleanliness: share of string fields without leading/trailing ws.
  let whitespace = 100;
  if (strings) {
    const wsFields = strings.filter((w: any) => w.leading > 0 || w.trailing > 0).length;
    const stringFields = strings.filter((w: any) => w.count > 0).length;
    whitespace = stringFields > 0 ? ((stringFields - wsFields) / stringFields) * 100 : 100;
  }

  // Schema consistency: 100 for one shape, degrades 20 per extra shape.
  let schema = 100;
  if (schemaShapes && schemaShapes.length > 1) {
    schema = Math.max(0, 100 - (schemaShapes.length - 1) * 20);
  }

  return { fieldCoverage, typeConsistency, valueCompleteness, whitespace, schema };
}

export function computeHealthScore(
  coverage: any[], empties: any[] | null, types: any[] | null, strings: any[] | null, schemaShapes: any[] | null, fields: any[], sentinels: any[] | null = null,
) {
  if (!coverage || !fields.length) return null;
  const c = healthComponents(coverage, empties, types, strings, schemaShapes, fields, sentinels);
  return Math.round(
    c.fieldCoverage * 0.25 +
    c.typeConsistency * 0.20 +
    c.valueCompleteness * 0.15 +
    c.whitespace * 0.20 +
    c.schema * 0.20,
  );
}

export function healthLabel(score: number) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

// Transform raw cached aggregation results into the UI-ready arrays
// both StatsPanel.jsx (display) and updateStatsSummary (scoring) consume.
// `rawCache` shape: { coverage, empties, types, strings, schema } — each
// either the full API response { result: [...] } as stored in the cache,
// or null/undefined if that specific check errored during prefetch.
// For each missing input the corresponding output is null so consumers
// can still render the pieces that resolved.
export function transformStatsResults(rawCache: any, fields: any[]) {
  return {
    coverage: rawCache.coverage ? transformCoverage(rawCache.coverage, fields) : null,
    empties: rawCache.empties ? transformEmpties(rawCache.empties, fields) : null,
    types: rawCache.types ? transformTypes(rawCache.types, fields) : null,
    strings: rawCache.strings ? transformStrings(rawCache.strings, fields) : null,
    schemaShapes: rawCache.schema ? transformSchema(rawCache.schema) : null,
    sentinels: rawCache.sentinels ? transformSentinels(rawCache.sentinels, fields) : null,
  };
}

function transformCoverage(raw: any, fields: any[]) {
  const r = raw.result?.[0] || {};
  const total = r._total || 0;
  return fields.map((f: any) => {
    const k = encKey(f);
    const present = r[`f_${k}`] || 0;
    return {
      field: f,
      present,
      total,
      pct: total > 0 ? Math.floor((present / total) * 100) : 0,
    };
  });
}

function transformEmpties(raw: any, fields: any[]) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f: any) => {
      const k = encKey(f);
      return {
        field: f,
        nullCount: r[`null_${k}`] || 0,
        missingCount: r[`missing_${k}`] || 0,
        emptyCount: r[`empty_${k}`] || 0,
      };
    })
    .filter((x: any) => x.nullCount + x.missingCount + x.emptyCount > 0);
}

function transformTypes(raw: any, fields: any[]) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f: any) => ({
      field: f,
      types: (r[encKey(f)] || []).filter((e: any) => e._id !== 'missing'),
    }))
    // Count DISTINCT LOGICAL types: int/long/double/decimal all collapse to
    // "number", so a field with mixed BSON numeric subtypes is not flagged as
    // type-inconsistent (consistent with fieldTypeSummary and the card chip).
    .filter((x: any) => new Set(x.types.map((e: any) => friendlyType(e._id))).size > 1);
}

function transformStrings(raw: any, fields: any[]) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f: any) => {
      const s = r[encKey(f)]?.[0];
      if (!s) return { field: f, count: 0 };
      return {
        field: f,
        count: s.count,
        minLen: s.minLen,
        maxLen: s.maxLen,
        avgLen: Math.round(s.avgLen),
        leading: s.leading,
        trailing: s.trailing,
      };
    })
    .filter((x: any) => x.count > 0);
}

function transformSentinels(raw: any, fields: any[]) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f: any) => {
      const buckets = r[encKey(f)] || [];
      const values = buckets.map((b: any) => ({ value: b._id, count: b.count }));
      const total = values.reduce((s: any, v: any) => s + v.count, 0);
      return { field: f, total, values };
    })
    .filter((x: any) => x.total > 0);
}

function transformSchema(raw: any) {
  return (raw.result || []).map((r: any) => ({
    fieldCount: r._id,
    docCount: r.count,
    sampleFields: (r.sampleFields || []).filter((f: any) => f !== '_id').sort(),
  }));
}

// Reads the cached stats outputs for `collection`, computes the health
// score, and publishes a summary on the `statsSummary` signal. If any
// of the five health-score inputs is absent (e.g. a check errored during
// prefetch), the signal is set to null so the tab-bar dot stays off —
// we only warn on provable issues.
export function updateStatsSummary(collection: string) {
  const fields = cache.get(collection, 'statsFields');
  if (!fields || fields.length === 0) {
    statsSummary.value = null;
    return;
  }
  const rawCache = {
    coverage: cache.get(collection, 'stats_coverage'),
    empties: cache.get(collection, 'stats_empties'),
    types: cache.get(collection, 'stats_types'),
    strings: cache.get(collection, 'stats_strings'),
    schema: cache.get(collection, 'stats_schema'),
    sentinels: cache.get(collection, 'stats_sentinels'), // optional — penalty only when present
  };
  const t = transformStatsResults(rawCache, fields);
  if (t.coverage === null || t.empties === null || t.types === null
      || t.strings === null || t.schemaShapes === null) {
    statsSummary.value = null;
    return;
  }
  const health = computeHealthScore(
    t.coverage, t.empties, t.types, t.strings, t.schemaShapes, fields, t.sentinels,
  );
  if (health === null) {
    statsSummary.value = null;
    return;
  }
  statsSummary.value = { collection, health, label: healthLabel(health) };
}
