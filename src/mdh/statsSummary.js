// Pure helpers shared between StatsPanel.jsx (health ring)
// and TabBar.jsx (warning dot on the Stats tab).
//
// Moved verbatim from StatsPanel.jsx so both views derive the
// same score from the same inputs. Parameter name `whitespace`
// was renamed to `strings` to reflect what the caller passes.

import { encKey } from './statsPipelines.js';
import * as cache from './cache.js';
import { statsSummary } from './store.js';

export function computeHealthScore(coverage, empties, types, strings, schemaShapes, fields) {
  if (!coverage || !fields.length) return null;

  // Coverage: average field coverage percentage (0–100)
  const avgCoverage = coverage.reduce((sum, c) => sum + c.pct, 0) / coverage.length;

  // Emptiness: ratio of fields with no empty/null/missing issues (0–100)
  const emptyFieldCount = empties ? empties.length : 0;
  const emptinessScore = ((fields.length - emptyFieldCount) / fields.length) * 100;

  // Type consistency: ratio of fields with a single type (0–100)
  const inconsistentCount = types ? types.length : 0;
  const typeScore = ((fields.length - inconsistentCount) / fields.length) * 100;

  // String-field cleanliness: ratio of string fields without leading/trailing whitespace (0–100)
  let wsScore = 100;
  if (strings) {
    const wsFields = strings.filter((w) => w.leading > 0 || w.trailing > 0).length;
    const stringFields = strings.filter((w) => w.count > 0).length;
    wsScore = stringFields > 0 ? ((stringFields - wsFields) / stringFields) * 100 : 100;
  }

  // Schema consistency: 100 if one shape, degrades with more (0–100)
  let schemaScore = 100;
  if (schemaShapes && schemaShapes.length > 1) {
    schemaScore = Math.max(0, 100 - (schemaShapes.length - 1) * 20);
  }

  return Math.round(
    avgCoverage * 0.25 +
    typeScore * 0.20 +
    emptinessScore * 0.15 +
    wsScore * 0.20 +
    schemaScore * 0.20,
  );
}

export function healthLabel(score) {
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
export function transformStatsResults(rawCache, fields) {
  return {
    coverage: rawCache.coverage ? transformCoverage(rawCache.coverage, fields) : null,
    empties: rawCache.empties ? transformEmpties(rawCache.empties, fields) : null,
    types: rawCache.types ? transformTypes(rawCache.types, fields) : null,
    strings: rawCache.strings ? transformStrings(rawCache.strings, fields) : null,
    schemaShapes: rawCache.schema ? transformSchema(rawCache.schema) : null,
  };
}

function transformCoverage(raw, fields) {
  const r = raw.result?.[0] || {};
  const total = r._total || 0;
  return fields.map((f) => {
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

function transformEmpties(raw, fields) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f) => {
      const k = encKey(f);
      return {
        field: f,
        nullCount: r[`null_${k}`] || 0,
        missingCount: r[`missing_${k}`] || 0,
        emptyCount: r[`empty_${k}`] || 0,
      };
    })
    .filter((x) => x.nullCount + x.missingCount + x.emptyCount > 0);
}

function transformTypes(raw, fields) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f) => ({
      field: f,
      types: (r[encKey(f)] || []).filter((e) => e._id !== 'missing'),
    }))
    .filter((x) => x.types.length > 1);
}

function transformStrings(raw, fields) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f) => {
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
    .filter((x) => x.count > 0);
}

function transformSchema(raw) {
  return (raw.result || []).map((r) => ({
    fieldCount: r._id,
    docCount: r.count,
    sampleFields: (r.sampleFields || []).filter((f) => f !== '_id').sort(),
  }));
}

// Reads the cached stats outputs for `collection`, computes the health
// score, and publishes a summary on the `statsSummary` signal. If any
// of the five health-score inputs is absent (e.g. a check errored during
// prefetch), the signal is set to null so the tab-bar dot stays off —
// we only warn on provable issues.
export function updateStatsSummary(collection) {
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
  };
  const t = transformStatsResults(rawCache, fields);
  if (t.coverage === null || t.empties === null || t.types === null
      || t.strings === null || t.schemaShapes === null) {
    statsSummary.value = null;
    return;
  }
  const health = computeHealthScore(t.coverage, t.empties, t.types, t.strings, t.schemaShapes, fields);
  if (health === null) {
    statsSummary.value = null;
    return;
  }
  statsSummary.value = { collection, health, label: healthLabel(health) };
}
