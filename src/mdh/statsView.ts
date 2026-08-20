// Pure view logic for the Collection Stats panel — no DOM, no Preact, so it is
// unit-tested directly (tests/mdh-stats-view.test.js). Mirrors the pattern of
// overviewCharts.js and the pure half of statsSummary.js.
//
// The `res` arguments are raw API responses ({ result: [...] }) as cached under
// `stats_<key>`. Transforms here were moved verbatim from StatsPanel.jsx's old
// resultHandlers so behaviour is unchanged.

import { encKey } from './statsPipelines.js';

const NUMERIC_TYPES = new Set(['double', 'int', 'long', 'decimal']);

export function friendlyType(type?: string | null): string {
  if (!type) return '—';
  if (NUMERIC_TYPES.has(type)) return 'number';
  if (type === 'bool') return 'boolean';
  return type as string; // string, date, object, array, objectId, ...
}

export function transformCardinality(res: any, fields: string[]) {
  const r = res.result?.[0] || {};
  return fields.map((f) => ({ field: f, distinct: r[encKey(f)]?.[0]?.distinct ?? 0 }));
}

export function transformDistribution(res: any, fields: string[]) {
  const r = res.result?.[0] || {};
  return fields.map((f) => ({
    field: f,
    values: (r[encKey(f)] || []).map((v: any) => ({ value: v._id, count: v.count })),
  }));
}

export function transformNumeric(res: any, fields: string[]) {
  const r = res.result?.[0] || {};
  return fields.map((f) => {
    const s = r[encKey(f)]?.[0];
    return s ? { field: f, count: s.count, min: s.min, max: s.max, avg: s.avg } : null;
  }).filter(Boolean);
}

export function transformDates(res: any, fields: string[]) {
  const r = res.result?.[0] || {};
  return fields.map((f) => {
    const s = r[encKey(f)]?.[0];
    return s ? { field: f, count: s.count, earliest: s.earliest, latest: s.latest } : null;
  }).filter(Boolean);
}

export function transformStorage(res: any) {
  const s = res.result?.[0]?.storageStats;
  if (!s) return null;
  return { size: s.size, storageSize: s.storageSize, freeStorageSize: s.freeStorageSize, avgObjSize: s.avgObjSize, count: s.count };
}

export function transformDocSize(res: any) {
  const r = res.result?.[0];
  if (!r) return null;
  return { count: r.count, avg: r.avgSize, min: r.minSize, max: r.maxSize, total: r.totalSize };
}

// Map a regular-index list to { field path → [index names] } for fields that
// are the LEADING (prefix) key of some index — the only case MongoDB can use
// for a query/sort on that field alone. Non-prefix compound members are
// intentionally excluded (a query on them alone can't use the index). Tolerant
// of empty/missing input and indexes without a `key`.
export function indexPrefixMap(indexes: any[]) {
  const map = new Map();
  for (const idx of (indexes || [])) {
    const first = idx && idx.key ? Object.keys(idx.key)[0] : null;
    if (!first) continue;
    if (!map.has(first)) map.set(first, []);
    map.get(first).push(idx.name || '(unnamed)');
  }
  return map;
}

// Per-field type summary from the RAW types facet (transformTypes in
// statsSummary.js keeps only multi-type fields; here we need every field's
// dominant type for the card chip).
//
// BSON numeric subtypes (int/long/double/decimal) are collapsed into a single
// "number" type before counting, so a field holding e.g. 1 (int) and 0.5
// (double) reports as one consistent "number" rather than a "number + number"
// mix. Mixing is judged on friendly types; `types` is sorted desc by count.
export function fieldTypeSummary(res: any, fields: string[]) {
  const r = res.result?.[0] || {};
  const out: Record<string, any> = {};
  for (const f of fields) {
    const raw = (r[encKey(f)] || []).filter((b: any) => b._id !== 'missing');
    const byFriendly = new Map();
    for (const b of raw) {
      const ft = friendlyType(b._id);
      byFriendly.set(ft, (byFriendly.get(ft) || 0) + b.count);
    }
    const types = [...byFriendly.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
    out[f] = {
      primaryType: types[0]?.type ?? null,
      types,
      isMixed: types.length > 1,
    };
  }
  return out;
}

function indexByField(arr: any[]) {
  const m = new Map();
  for (const x of (arr || [])) m.set(x.field, x);
  return m;
}

// Merge every per-field slice into one profile object per field. Any slice may
// be null (check still loading or errored) → the corresponding region is null.
export function buildFieldProfiles(
  { fields, total, coverage, empties, typeSummary, cardinality, distribution, strings, numeric, dates, sentinels }: Record<string, any>,
) {
  const cov = indexByField(coverage);
  const emp = indexByField(empties);
  const card = indexByField(cardinality);
  const dist = indexByField(distribution);
  const str = indexByField(strings);
  const num = indexByField(numeric);
  const dt = indexByField(dates);
  const sen = indexByField(sentinels);
  const ts = typeSummary || {};

  return fields.map((field: string) => {
    const c = cov.get(field);
    const e = emp.get(field);
    const distinct = card.get(field)?.distinct ?? 0;
    const topValues = dist.get(field)?.values || [];
    return {
      field,
      total,
      pct: c?.pct ?? null,
      present: c?.present ?? null,
      nullCount: e?.nullCount || 0,
      missingCount: e?.missingCount || 0,
      emptyCount: e?.emptyCount || 0,
      primaryType: ts[field]?.primaryType ?? null,
      types: ts[field]?.types || [],
      isMixed: ts[field]?.isMixed || false,
      distinct,
      diversityPct: total > 0 ? Math.round((distinct / total) * 100) : 0,
      topValues,
      fullyDistinct: topValues.length > 0 && (topValues[0].count ?? 0) <= 1,
      string: str.get(field) ? (({ field: _f, ...rest }) => rest)(str.get(field)) : null,
      numeric: num.get(field) ? (({ field: _f, ...rest }) => rest)(num.get(field)) : null,
      date: dt.get(field) ? (({ field: _f, ...rest }) => rest)(dt.get(field)) : null,
      sentinel: sen.get(field) ? (({ field: _f, ...rest }) => rest)(sen.get(field)) : null,
    };
  });
}
function toTimestamp(d: unknown): number | null {
  if (!d) return null;
  const s = typeof d === 'string' ? d : (d as any).$date || String(d);
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

export function rangeBar({ min, max, value }: { min: number; max: number; value: number }) {
  if (min == null || max == null) return null;
  if (max === min) return { left: 0, right: 0, avgPct: 50 };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const avgPct = value == null ? null : clamp(((value - min) / (max - min)) * 100);
  return { left: 0, right: 0, avgPct };
}

export function spanBar(earliest: unknown, latest: unknown) {
  const a = toTimestamp(earliest);
  const b = toTimestamp(latest);
  if (a == null || b == null) return null;
  return { ms: Math.max(0, b - a) };
}
// Build a filter pipeline (as editor text) that filters a collection to
// documents where `field` equals `value` — used by the Stats cards' "click a top
// value to see those records" jump. Placeholder/sentinel string tokens use a
// case-insensitive, whitespace-trimmed regex so every stored casing matches; all
// other values match exactly (the distribution already grouped by exact value).
// Preserves the data view's default $sort/$skip/$limit stages so the jumped-to
// query behaves like a normal paginated query (limit defaults to the page size).
export function buildValueFilterPipeline(field: string, value: unknown, isPlaceholder: boolean, limit = 50) {
  const match = (isPlaceholder && typeof value === 'string')
    ? { $regex: `^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, $options: 'i' }
    : value;
  return JSON.stringify([
    { $match: { [field]: match } },
    { $sort: { _id: -1 } },
    { $skip: 0 },
    { $limit: limit },
  ], null, 2);
}
