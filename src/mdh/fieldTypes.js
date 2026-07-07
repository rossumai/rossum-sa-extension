import * as api from './api.js';
import * as cache from './cache.js';
import { buildTypePipeline, encKey } from './statsPipelines.js';

// MongoDB $type strings → primitive Category. Numeric subtypes fold to 'number';
// everything non-primitive (date/objectId/array/object/…) → 'other'.
const NUMBER_BSON = new Set(['int', 'long', 'double', 'decimal']);
export function foldBsonType(t) {
  if (t === 'string') return 'string';
  if (t === 'bool') return 'boolean';
  if (t === 'null') return 'null';
  if (NUMBER_BSON.has(t)) return 'number';
  return 'other';
}

// Tie-break precedence (most permissive first).
const PRECEDENCE = ['string', 'number', 'boolean', 'null', 'other'];

// $type buckets ([{_id: bsonType, count}], as buildTypePipeline emits) →
// FieldTypeInfo, or null when the field has no non-`missing` data.
export function transformTypeBuckets(buckets) {
  const real = (buckets || []).filter((b) => b && b._id !== 'missing');
  const total = real.reduce((s, b) => s + (b.count || 0), 0);
  if (total === 0) return null;
  const byCat = new Map();
  const bsonByCat = new Map();
  for (const b of real) {
    const cat = foldBsonType(b._id);
    byCat.set(cat, (byCat.get(cat) || 0) + b.count);
    if (!bsonByCat.has(cat)) bsonByCat.set(cat, b._id); // first = highest-count bson for the cat
  }
  let dominant = null;
  let dominantCount = -1;
  for (const cat of PRECEDENCE) {            // precedence order → ties resolve to the earlier cat
    if (!byCat.has(cat)) continue;
    const c = byCat.get(cat);
    if (c > dominantCount) { dominant = cat; dominantCount = c; }
  }
  return {
    dominant,
    dominantBson: bsonByCat.get(dominant),
    share: dominantCount / total,
    distribution: real.map((b) => ({ bsonType: b._id, count: b.count, pct: Math.round((b.count / total) * 100) })),
    mixed: byCat.size > 1,
  };
}

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'null']);

// Decide a placeholder's resolved type + the SOURCE label for the badge.
// `.type` drives substitution (undefined → value-based, byte-identical to today);
// `.source` drives the badge text.
export function deriveResolvedType(name, { override, fieldMap, fieldTypeInfo, parsedOk }) {
  if (override && override !== 'auto') {
    return PRIMITIVES.has(override) ? { type: override, source: 'override' } : { type: undefined, source: 'no-field' };
  }
  if (!parsedOk) return { type: undefined, source: 'invalid' };
  const m = fieldMap[name];
  if (!m) return { type: undefined, source: 'no-field' };
  if (m.ambiguous) return { type: undefined, source: 'ambiguous' };
  if (fieldTypeInfo === undefined) return { type: undefined, source: 'detecting', field: m.field };
  if (!fieldTypeInfo) return { type: undefined, source: 'no-data', field: m.field };
  if (fieldTypeInfo.dominant === 'other') return { type: undefined, source: 'other', field: m.field, detectedBson: fieldTypeInfo.dominantBson };
  return { type: fieldTypeInfo.dominant, source: fieldTypeInfo.mixed ? 'mixed' : 'field', field: m.field, share: fieldTypeInfo.share, mixed: fieldTypeInfo.mixed };
}

const FIELD_TYPES_KEY = 'stats_fieldTypes'; // 10-min TTL (cache.js: key starts with 'stats')
const RAW_TYPES_KEY = 'stats_types';        // raw $type facet cached by the Stats panel

// Resolve FieldTypeInfo (or null) for each requested field, reusing the Stats
// panel's cached raw $type facet when present, else probing only the missing
// fields with a small buildTypePipeline facet. Always returns an entry for every
// requested field (null = no usable data / probe failed → caller uses value-based).
export async function resolveFieldTypes(collectionName, fields) {
  if (!collectionName || !fields || fields.length === 0) return {};
  const cached = { ...(cache.get(collectionName, FIELD_TYPES_KEY) || {}) };
  let missing = fields.filter((f) => !(f in cached));

  if (missing.length) {
    const facet = cache.get(collectionName, RAW_TYPES_KEY)?.result?.[0];
    if (facet) {
      const still = [];
      for (const f of missing) {
        const buckets = facet[encKey(f)];
        if (buckets) cached[f] = transformTypeBuckets(buckets);
        else still.push(f);
      }
      missing = still;
    }
  }

  if (missing.length) {
    try {
      const facet = (await api.aggregate(collectionName, buildTypePipeline(missing)))?.result?.[0] || {};
      for (const f of missing) cached[f] = transformTypeBuckets(facet[encKey(f)] || []);
    } catch {
      for (const f of missing) cached[f] = null; // don't hammer; value-based fallback
    }
  }

  cache.set(collectionName, FIELD_TYPES_KEY, cached);
  const out = {};
  for (const f of fields) out[f] = f in cached ? cached[f] : null;
  return out;
}
