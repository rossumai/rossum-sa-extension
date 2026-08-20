// Per-collection schema hints for the agent generation prompt (restored from the
// retired llmchat design — verified to improve first-shot precision):
//  • knownValues         — distinct values of low-cardinality string fields (one cached $facet)
//  • topValues           — top-N by frequency for higher-cardinality string fields
//  • ranges              — numeric min/max for numeric fields
//  • searchIndexes       — queryable Atlas Search indexes (cached) — so the agent can $search
//  • numericStringFields — string-of-digits fields (free, from the in-memory records)
//  • fieldTypes          — leaf field type map (free, from the in-memory records)
//  • arrayPaths          — array leaf paths (free, from the in-memory records)
// The $facet + search-index list are cached per collection for the session; the
// three "free" maps are recomputed cheaply from the current records each call.
// Self-contained (the detector helpers live here) so it doesn't depend on the
// trimmed llmPipeline.js.

const MAX_DISTINCT = 25;
const TOP_N = 15;
const MAX_TOP_FIELDS = 8;
const cache = new Map();


// ---- extended-JSON awareness -----------------------------------------------
const EXT_JSON_TYPES = {
  $oid: 'objectId', $date: 'date', $timestamp: 'timestamp',
  $numberLong: 'number', $numberInt: 'number', $numberDouble: 'number', $numberDecimal: 'number',
  $binary: 'binary', $uuid: 'uuid', $regularExpression: 'regex',
};
export function extendedJsonType(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  return keys.length === 1 && EXT_JSON_TYPES[keys[0]] ? EXT_JSON_TYPES[keys[0]] : null;
}

// ---- detectors (pure, from in-memory sample records) -----------------------
export function leafStringFields(records) {
  const fields = new Set();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!extendedJsonType(v)) walk(v, path); continue; }
      if (typeof v === 'string') fields.add(path);
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...fields].filter((f) => f !== '_id' && !f.startsWith('_id.')).sort();
}

export function detectNumericStringFields(records) {
  const seen = new Map();
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!extendedJsonType(v)) walk(v, path); continue; }
      if (v == null) continue;
      const cur = seen.get(path) || { ok: true, any: false };
      if (typeof v === 'string' && /^\d+$/.test(v)) cur.any = true;
      else cur.ok = false;
      seen.set(path, cur);
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...seen.entries()]
    .filter(([f, s]) => s.ok && s.any && f !== '_id' && !f.startsWith('_id.'))
    .map(([f]) => f)
    .sort();
}

export function summarizeSearchIndexes(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .filter((i) => i && i.queryable !== false && (i.status === undefined || i.status === 'READY'))
    .map((i) => {
      const def = i.latest_definition || {};
      const mappings = def.mappings || {};
      const fields = mappings.dynamic === true ? 'all' : Object.keys(mappings.fields || {});
      return { name: i.name, fields, synonyms: Array.isArray(def.synonyms) && def.synonyms.length > 0 };
    });
}

export function leafFieldTypes(records) {
  const seen = new Map();
  const objectPaths = new Set();
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ej = extendedJsonType(v);
        if (ej) { if (!seen.has(path)) seen.set(path, new Set()); seen.get(path).add(ej); continue; }
        objectPaths.add(path); walk(v, path); continue;
      }
      if (!seen.has(path)) seen.set(path, new Set());
      seen.get(path).add(typeOf(v));
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  const out = {};
  for (const [path, types] of seen) {
    if (path === '_id' || path.startsWith('_id.')) continue;
    if (objectPaths.has(path)) continue;
    const nonNull = [...types].filter((t) => t !== 'null');
    out[path] = nonNull.length === 0 ? 'null' : nonNull.length === 1 ? nonNull[0] : 'mixed';
  }
  return out;
}

export function arrayLeafPaths(records) {
  const out = new Set();
  const leafPathsOf = (o, prefix) => {
    const acc = [];
    for (const k of Object.keys(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !extendedJsonType(v)) acc.push(...leafPathsOf(v, path));
      else acc.push(path);
    }
    return acc;
  };
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const path = p ? `${p}.${k}` : k;
      if (path === '_id' || path.startsWith('_id.')) continue;
      const v = o[k];
      if (Array.isArray(v)) {
        const objEl = v.find((e) => e && typeof e === 'object' && !Array.isArray(e) && !extendedJsonType(e));
        if (objEl) for (const sub of leafPathsOf(objEl, '')) out.add(`${path}[].${sub}`);
        else out.add(`${path}[]`);
      } else if (v && typeof v === 'object' && !extendedJsonType(v)) {
        walk(v, path);
      }
    }
  };
  for (const r of Array.isArray(records) ? records : []) walk(r, '');
  return [...out].sort();
}

// ---- collection hints ($facet + search indexes, cached per collection) -----
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function inMemDistinct(records, field) {
  const s = new Set();
  for (const r of records) { const v = getPath(r, field); if (v != null) s.add(v); if (s.size > MAX_DISTINCT) return s.size; }
  return s.size;
}
const keyFor = (f) => f.replace(/[^a-zA-Z0-9]/g, '_');

async function fetchCollectionHints(api, collection, records) {
  const types = leafFieldTypes(records);
  const strings = leafStringFields(records);
  const lowCard = strings.filter((f) => inMemDistinct(records, f) <= MAX_DISTINCT);
  const highCard = strings.filter((f) => inMemDistinct(records, f) > MAX_DISTINCT).slice(0, MAX_TOP_FIELDS);
  const numeric = Object.keys(types).filter((f) => types[f] === 'number');

  const facet = {};
  const meta = {};
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

// Returns { knownValues, topValues, ranges, numericStringFields, searchIndexes,
// fieldTypes, arrayPaths }. Never throws (degrades to empties).
export async function getSchemaHints(api, collection, records) {
  const recs = Array.isArray(records) ? records : [];
  const numericStringFields = detectNumericStringFields(recs);
  const fieldTypes = leafFieldTypes(recs);
  const arrayPaths = arrayLeafPaths(recs);
  if (!collection) return { knownValues: {}, topValues: {}, ranges: {}, numericStringFields, searchIndexes: [], fieldTypes, arrayPaths };
  try {
    if (!cache.has(collection)) cache.set(collection, await fetchCollectionHints(api, collection, recs));
  } catch { cache.set(collection, { knownValues: {}, topValues: {}, ranges: {}, searchIndexes: [] }); }
  const { knownValues, topValues, ranges, searchIndexes } = cache.get(collection);
  return { knownValues, topValues, ranges, numericStringFields, searchIndexes, fieldTypes, arrayPaths };
}
