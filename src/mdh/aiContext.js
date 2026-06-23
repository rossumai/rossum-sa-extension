// Per-collection schema hints for the AI pipeline prompt:
//  • knownValues       — distinct values of low-cardinality string fields (one cached $facet)
//  • searchIndexes      — queryable Atlas Search indexes (cached)
//  • numericStringFields — string-of-digits fields (free, from the in-memory records)
// The $facet + search-index list are cached per collection for the session (they're
// stable); numericStringFields is recomputed cheaply from the current records each call.
import { leafStringFields, detectNumericStringFields, summarizeSearchIndexes } from './llmPipeline.js';

const MAX_DISTINCT = 25; // a field worth enumerating has ≤ this many distinct values
const cache = new Map(); // collection -> { knownValues, searchIndexes }

export function _resetSchemaHintsCache() { cache.clear(); } // test hook

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function inMemDistinct(records, field) {
  const s = new Set();
  for (const r of records) { const v = getPath(r, field); if (v != null) s.add(v); if (s.size > MAX_DISTINCT) return s.size; }
  return s.size;
}

async function fetchLowCardValues(api, collection, records) {
  // Only facet fields that are plausibly low-cardinality (≤ MAX_DISTINCT distinct
  // even within the loaded sample) — this prunes high-card text/id fields up front
  // so the $facet stays cheap.
  const candidates = leafStringFields(records).filter((f) => inMemDistinct(records, f) <= MAX_DISTINCT);
  if (!candidates.length) return {};
  const keyFor = (f) => f.replace(/[^a-zA-Z0-9]/g, '_');
  const facet = {};
  const keyToField = {};
  for (const f of candidates) { const k = keyFor(f); facet[k] = [{ $group: { _id: `$${f}` } }, { $limit: MAX_DISTINCT + 1 }]; keyToField[k] = f; }
  const res = await api.aggregate(collection, [{ $facet: facet }]);
  const row = (res?.result || [])[0] || {};
  const out = {};
  for (const [k, arr] of Object.entries(row)) {
    const vals = (arr || []).map((x) => x._id).filter((v) => v != null && v !== '');
    if (vals.length > 0 && vals.length <= MAX_DISTINCT) {
      out[keyToField[k]] = vals.sort((a, b) => String(a).localeCompare(String(b)));
    }
  }
  return out;
}

async function fetchCollectionHints(api, collection, records) {
  const [knownValues, searchIndexes] = await Promise.all([
    fetchLowCardValues(api, collection, records).catch(() => ({})),
    api.listSearchIndexes(collection).then((r) => summarizeSearchIndexes(r?.result || r)).catch(() => []),
  ]);
  return { knownValues, searchIndexes };
}

export async function getSchemaHints(api, collection, records) {
  const recs = Array.isArray(records) ? records : [];
  const numericStringFields = detectNumericStringFields(recs);
  if (!collection) return { knownValues: {}, numericStringFields, searchIndexes: [] };
  if (!cache.has(collection)) cache.set(collection, await fetchCollectionHints(api, collection, recs));
  const { knownValues, searchIndexes } = cache.get(collection);
  return { knownValues, numericStringFields, searchIndexes };
}
