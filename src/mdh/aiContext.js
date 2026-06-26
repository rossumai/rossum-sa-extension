// Per-collection schema hints for the AI pipeline prompt:
//  • knownValues         — distinct values of low-cardinality string fields (one cached $facet)
//  • topValues           — top-N by frequency for higher-cardinality string fields
//  • ranges              — numeric min/max for numeric fields
//  • searchIndexes       — queryable Atlas Search indexes (cached)
//  • numericStringFields — string-of-digits fields (free, from the in-memory records)
//  • fieldTypes          — leaf field type map (free, from the in-memory records)
//  • arrayPaths          — array leaf paths (free, from the in-memory records)
// The $facet + search-index list are cached per collection for the session (they're
// stable); numericStringFields/fieldTypes/arrayPaths are recomputed cheaply from the
// current records each call.
import { leafStringFields, detectNumericStringFields, summarizeSearchIndexes, leafFieldTypes, arrayLeafPaths } from './llmPipeline.js';

const MAX_DISTINCT = 25;   // ≤ this in-sample distinct → enumerate exactly (knownValues)
const TOP_N = 15;          // higher-card string fields → top-N by frequency
const MAX_TOP_FIELDS = 8;  // cap higher-card fields faceted (keeps $facet cheap)
const cache = new Map();   // collection -> { knownValues, topValues, ranges, searchIndexes }

export function _resetSchemaHintsCache() { cache.clear(); }

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function inMemDistinct(records, field) {
  const s = new Set();
  for (const r of records) { const v = getPath(r, field); if (v != null) s.add(v); if (s.size > MAX_DISTINCT) return s.size; }
  return s.size;
}
const keyFor = (f) => f.replace(/[^a-zA-Z0-9]/g, '_');

// One $facet gathers: low-card distinct (kv), high-card top-N (tv), numeric
// min/max (rg). Keys are keyFor(field) (no collision: a field is in at most one
// group). Search indexes fetched in parallel. Degrades to empties on failure.
async function fetchCollectionHints(api, collection, records) {
  const types = leafFieldTypes(records);
  const strings = leafStringFields(records);
  const lowCard = strings.filter((f) => inMemDistinct(records, f) <= MAX_DISTINCT);
  const highCard = strings.filter((f) => inMemDistinct(records, f) > MAX_DISTINCT).slice(0, MAX_TOP_FIELDS);
  const numeric = Object.keys(types).filter((f) => types[f] === 'number');

  const facet = {};
  const meta = {}; // key -> { field, kind }
  for (const f of lowCard) { const k = keyFor(f); facet[k] = [{ $group: { _id: `$${f}` } }, { $limit: MAX_DISTINCT + 1 }]; meta[k] = { field: f, kind: 'kv' }; }
  for (const f of highCard) { const k = keyFor(f); facet[k] = [{ $group: { _id: `$${f}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: TOP_N + 1 }]; meta[k] = { field: f, kind: 'tv' }; }
  for (const f of numeric) { const k = keyFor(f); facet[k] = [{ $group: { _id: null, min: { $min: `$${f}` }, max: { $max: `$${f}` } } }]; meta[k] = { field: f, kind: 'rg' }; }

  const [row, searchIndexes] = await Promise.all([
    (Object.keys(facet).length
      ? api.aggregate(collection, [{ $facet: facet }]).then((res) => (res?.result || [])[0] || {})
      : Promise.resolve({})).catch(() => ({})),
    api.listSearchIndexes(collection).then((r) => summarizeSearchIndexes(r?.result || r)).catch(() => []),
  ]);

  const knownValues = {}, topValues = {}, ranges = {};
  for (const [k, arr] of Object.entries(row)) {
    const m = meta[k]; if (!m) continue;
    if (m.kind === 'kv') {
      const vals = (arr || []).map((x) => x._id).filter((v) => v != null && v !== '');
      if (vals.length > 0 && vals.length <= MAX_DISTINCT) knownValues[m.field] = vals.sort((a, b) => String(a).localeCompare(String(b)));
    } else if (m.kind === 'tv') {
      const vals = (arr || []).map((x) => x._id).filter((v) => v != null && v !== '');
      if (vals.length > 0) topValues[m.field] = { values: vals.slice(0, TOP_N), more: Math.max(0, vals.length - TOP_N) };
    } else if (m.kind === 'rg') {
      const r = (arr || [])[0];
      if (r && r.min != null && r.max != null) ranges[m.field] = { min: r.min, max: r.max };
    }
  }
  return { knownValues, topValues, ranges, searchIndexes };
}

export async function getSchemaHints(api, collection, records) {
  const recs = Array.isArray(records) ? records : [];
  const numericStringFields = detectNumericStringFields(recs);
  const fieldTypes = leafFieldTypes(recs);
  const arrayPaths = arrayLeafPaths(recs);
  if (!collection) return { knownValues: {}, topValues: {}, ranges: {}, numericStringFields, searchIndexes: [], fieldTypes, arrayPaths };
  if (!cache.has(collection)) cache.set(collection, await fetchCollectionHints(api, collection, recs));
  const { knownValues, topValues, ranges, searchIndexes } = cache.get(collection);
  return { knownValues, topValues, ranges, numericStringFields, searchIndexes, fieldTypes, arrayPaths };
}
