import { stableKey } from './importFile.js';

// Read-only ESTIMATE of how a server-side Update (upsert by id_keys) will split
// the file's rows: how many match an existing record (→ overwritten) vs don't
// (→ inserted as new). This never writes — it batches an existence probe against
// the collection, mirroring the retired match engine's probe but purely for a
// confirm-stage preview. The server still performs the actual upsert.
//
// Single key → one batched `$in` probe. Composite keys → an `$or` of `$and`
// (one clause per distinct file tuple), the same shape the old engine used;
// note this can be a collection scan per batch without a compound index, so the
// distinct-tuple cap below keeps the confirm stage snappy (beyond it we skip,
// { capped: true }).

const SINGLE_BATCH = 1000;           // values per single-key $in probe
const COMPOSITE_BATCH = 500;         // tuples per composite $or-of-$and probe (compound clauses are heavier)
export const ESTIMATE_MAX_VALUES = 10000; // > this many distinct keys/tuples → skip
const SEP = String.fromCharCode(31);                // unit separator: joins per-field stableKeys into one tuple key (no collisions)

// Resolve a dotted path (a / a.b.c) without traversing arrays/non-objects.
function resolvePath(doc, path) {
  if (!doc || typeof doc !== 'object') return { present: false };
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { present: false };
    }
    cur = cur[seg];
  }
  return { present: true, value: cur };
}

// Composite key of a doc across all key paths. Returns null when ANY key is
// absent — a row missing part of the key cannot match an existing record.
function tupleOf(doc, keys) {
  const vals = [];
  for (const k of keys) {
    const r = resolvePath(doc, k);
    if (!r.present) return null;
    vals.push(r.value);
  }
  return { sk: vals.map(stableKey).join(SEP), vals };
}

// `find` is the api.find function: (collection, { query, projection, limit }) → { result: [...] }.
export async function estimateMatches(collection, docs, keys, find) {
  if (!Array.isArray(keys) || keys.length === 0) return { supported: false };
  const single = keys.length === 1;

  const rowKeys = [];          // per-row composite stableKey, or null when a key is missing
  const distinct = new Map();  // composite stableKey → value tuple (deduped)
  for (const d of (docs || [])) {
    const t = tupleOf(d, keys);
    if (!t) { rowKeys.push(null); continue; }
    rowKeys.push(t.sk);
    if (!distinct.has(t.sk)) distinct.set(t.sk, t.vals);
  }

  if (distinct.size > ESTIMATE_MAX_VALUES) return { supported: true, capped: true };

  const projection = {};
  for (const k of keys) projection[k] = 1;

  const existing = new Set();
  const tuples = [...distinct.values()];
  const batch = single ? SINGLE_BATCH : COMPOSITE_BATCH;
  for (let i = 0; i < tuples.length; i += batch) {
    const chunk = tuples.slice(i, i + batch);
    const query = single
      ? { [keys[0]]: { $in: chunk.map((vals) => vals[0]) } }
      : { $or: chunk.map((vals) => ({ $and: keys.map((k, j) => ({ [k]: vals[j] })) })) };
    const res = await find(collection, { query, projection, limit: 0 });
    for (const doc of (res?.result || [])) {
      const t = tupleOf(doc, keys);
      if (t) existing.add(t.sk);
    }
  }

  let matched = 0;
  let willInsert = 0;
  for (const sk of rowKeys) {
    // A row missing (part of) the key can't match, so the server inserts it as new.
    if (sk !== null && existing.has(sk)) matched++;
    else willInsert++;
  }
  return { supported: true, matched, willInsert, total: (docs || []).length };
}
