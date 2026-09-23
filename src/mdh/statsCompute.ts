// Pure client-side equivalent of the Stats check pipelines, computed over one
// `$sample` read instead of eleven full-collection scans. DOM-free and
// network-free, like statsView.ts and the pure half of statsSummary.ts.
//
// Its contract is the RAW response shape: every emitter returns exactly what
// `api.aggregate` returns for the server pipeline it replaces, so statsView.ts,
// statsSummary.ts and their tests are untouched by sampling.
//
// The helpers below exist because the obvious JavaScript diverges from
// MongoDB. See the design spec's §5 table for the full list.

import { encKey, TOP_VALUES, SENTINEL_STRINGS, SCHEMA_GROUP_LIMIT } from './statsPipelines.js';

// Resolve a dotted path the way `$a.b.c` does, including MongoDB's implicit
// traversal of an array of documents — `$a.b` over `a: [{b:1},{b:2}]` is
// `[1,2]`, and elements without `b` are OMITTED rather than left as holes.
// `found` is what separates a missing path from a stored null; `?? null` would
// merge the two and `$type` reports them differently.
export function resolvePath(doc: any, path: string): { found: boolean; value: any } {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length; i++) {
    if (Array.isArray(cur)) {
      const rest = parts.slice(i).join('.');
      const out: any[] = [];
      for (const el of cur) {
        const r = resolvePath(el, rest);
        if (r.found) out.push(r.value);
      }
      return { found: true, value: out };
    }
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (!(parts[i] in cur)) return { found: false, value: undefined };
    cur = cur[parts[i]];
  }
  return { found: true, value: cur };
}

// `$type`, with two deliberate departures.
//
// EJSON wrappers are BSON scalars server-side, so `$type` never says 'object'
// for them. And a JSON number carries no subtype, so int/long/double/decimal
// all report as 'number' — which every consumer already does anyway:
// `friendlyType` maps all four to 'number', and both `transformTypes` and
// `fieldTypeSummary` count distinct LOGICAL types so that a field holding 1 and
// 0.5 is not flagged as a type mix. The divergence is visible in the raw shape
// and invisible in every rendered number.
export function bsonType(v: any): string {
  // `undefined` is resolvePath's not-found sentinel. Reporting it as 'missing'
  // rather than falling through to 'object' makes this primitive correct on its
  // own, instead of relying on every caller writing `found ? bsonType(v) : …`.
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'number') return 'number';
  if (t === 'object') {
    if ('$oid' in v) return 'objectId';
    if ('$date' in v) return 'date';
    if ('$numberLong' in v || '$numberInt' in v) return 'number';
    if ('$numberDouble' in v || '$numberDecimal' in v) return 'number';
    // The rest of the EJSON wrappers this data can carry. Falling through to
    // 'object' here reported a field holding only binary (or only regexes, or
    // only timestamps) as a MIX of types, because the server calls the same
    // value 'binData'. `$regularExpression` is canonical EJSON, `$regex` the
    // relaxed form; both arrive as one BSON regex.
    if ('$binary' in v) return 'binData';
    if ('$regularExpression' in v || '$regex' in v) return 'regex';
    if ('$timestamp' in v) return 'timestamp';
    return 'object';
  }
  return 'object';
}

// The character class `$ltrim`/`$rtrim` use with no `chars` argument: MongoDB's
// documented set of 20 code points, ending at U+200A. It INCLUDES NUL and
// EXCLUDES the BOM, so String.prototype.trim is wrong on both — and it also
// excludes U+2028, U+2029, U+202F, U+205F and U+3000, so general "Unicode
// whitespace" is wrong the other way. U+3000 is the CJK full-width space: a
// client that trims it reports CJK values as carrying stray whitespace that the
// server does not see.
const WS = '\\u0000\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a';
const LEADING = new RegExp(`^[${WS}]+`);
const TRAILING = new RegExp(`[${WS}]+$`);

export function mongoTrim(s: string): string {
  return s.replace(LEADING, '').replace(TRAILING, '');
}
export function hasLeadingWs(s: string): boolean {
  return LEADING.test(s);
}
export function hasTrailingWs(s: string): boolean {
  return TRAILING.test(s);
}

// `$strLenCP` counts code points; `.length` counts UTF-16 units.
export function cpLength(s: string): number {
  return [...s].length;
}

// Identity for `$group: { _id: '$field' }` — distinct by value AND type, with
// an array grouped as one whole value. JSON.stringify preserves insertion
// order, which is what makes `{a:1,b:2}` and `{b:2,a:1}` distinct here, as they
// are in BSON. Do NOT sort the keys.
export function groupKey(v: any): string {
  return `${bsonType(v)}\u0000${JSON.stringify(v ?? null)}`;
}

// Mirrors buildFieldCoveragePipeline: present == $type is not 'missing' AND the
// value is not null. An empty string and an empty array both count as present,
// exactly as the server's $cond does.
export function computeCoverage(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = { _id: null, _total: docs.length };
  for (const f of fields) row[`f_${encKey(f)}`] = 0;
  for (const doc of docs) {
    for (const f of fields) {
      const r = resolvePath(doc, f);
      if (r.found && r.value !== null) row[`f_${encKey(f)}`]++;
    }
  }
  return { result: [row] };
}

// Mirrors buildEmptyValuesPipeline: three independent counters per field.
export function computeEmpties(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = { _id: null };
  for (const f of fields) {
    const k = encKey(f);
    row[`null_${k}`] = 0;
    row[`missing_${k}`] = 0;
    row[`empty_${k}`] = 0;
  }
  for (const doc of docs) {
    for (const f of fields) {
      const k = encKey(f);
      const r = resolvePath(doc, f);
      if (!r.found) row[`missing_${k}`]++;
      // null and missing are MUTUALLY EXCLUSIVE here, and the server agrees:
      // buildEmptyValuesPipeline's null_ counter excludes 'missing' explicitly
      // rather than relying on whether $eq treats an absent path as null. That
      // was the one open correctness question in this change, and it is settled
      // by construction instead of by a probe — see the design spec's §5.
      else if (r.value === null) row[`null_${k}`]++;
      else if (r.value === '') row[`empty_${k}`]++;
    }
  }
  return { result: [row] };
}

// Mirrors buildTypePipeline. The 'missing' bucket is part of the contract —
// transformTypes and fieldTypeSummary both filter it out themselves.
export function computeTypes(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      const t = r.found ? bsonType(r.value) : 'missing';
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    row[encKey(f)] = [...counts.entries()]
      .map(([_id, count]) => ({ _id, count }))
      .sort((a, b) => b.count - a.count);
  }
  return { result: [row] };
}

// Mirrors buildSchemaConsistencyPipeline, reading `_topKeys` (which the sampled
// read projects) instead of re-deriving it from whole documents. Grouped on the
// key array AS STORED, not sorted — key order can split one real shape into
// several groups here, exactly as the server pipeline's raw $group does.
// Normalising and merging equal key SETS happens in exactly one place,
// transformSchema, so both the exact and the sampled path share the same merge
// logic instead of drifting apart.
export function computeSchema(docs: any[]): { result: any[] } {
  const shapes = new Map<string, { count: number; fields: string[] }>();
  for (const doc of docs) {
    // buildSampleReadPipeline always projects `_topKeys`, so this is a guard
    // rather than a case: a document without it carries no shape to count.
    const keys = doc._topKeys;
    if (!Array.isArray(keys)) continue;
    const dedupeKey = JSON.stringify(keys);
    const seen = shapes.get(dedupeKey);
    if (seen) seen.count++;
    else shapes.set(dedupeKey, { count: 1, fields: keys });
  }
  return {
    result: [...shapes.values()]
      .map((v) => ({ _id: v.fields, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, SCHEMA_GROUP_LIMIT),
  };
}

// Value buckets for $group: {_id: '$f'}. A MISSING field groups as null, the
// same bucket a stored null lands in — reproducing that fold is what keeps
// distribution and cardinality agreeing with the server.
function valueBuckets(docs: any[], field: string) {
  const buckets = new Map<string, { _id: any; count: number }>();
  for (const doc of docs) {
    const r = resolvePath(doc, field);
    const v = r.found ? r.value : null;
    const k = groupKey(v);
    const seen = buckets.get(k);
    if (seen) seen.count++;
    else buckets.set(k, { _id: v, count: 1 });
  }
  return buckets;
}

export function computeDistribution(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    row[encKey(f)] = [...valueBuckets(docs, f).values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_VALUES);
  }
  return { result: [row] };
}

export function computeCardinality(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const n = valueBuckets(docs, f).size;
    // $count emits nothing for an empty stream, so an empty facet array is the
    // honest shape — transformCardinality already reads that as 0.
    row[encKey(f)] = n > 0 ? [{ distinct: n }] : [];
  }
  return { result: [row] };
}

export function computeStrings(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let minLen = Infinity;
    let maxLen = 0;
    let sumLen = 0;
    let leading = 0;
    let trailing = 0;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || typeof r.value !== 'string') continue;
      const len = cpLength(r.value);
      count++;
      sumLen += len;
      if (len < minLen) minLen = len;
      if (len > maxLen) maxLen = len;
      if (hasLeadingWs(r.value)) leading++;
      if (hasTrailingWs(r.value)) trailing++;
    }
    row[encKey(f)] =
      count > 0
        ? [{ _id: null, count, minLen, maxLen, avgLen: sumLen / count, leading, trailing }]
        : [];
  }
  return { result: [row] };
}

export function computeSentinels(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || typeof r.value !== 'string') continue;
      const norm = mongoTrim(r.value).toLowerCase();
      if (!SENTINEL_STRINGS.includes(norm)) continue;
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }
    row[encKey(f)] = [...counts.entries()]
      .map(([_id, count]) => ({ _id, count }))
      .sort((a, b) => b.count - a.count);
  }
  return { result: [row] };
}

// A wrapped numeric cannot be compared or summed as-is. bsonType already calls
// these 'number', so filtering on typeof would make computeNumeric disagree
// with computeTypes about the same value. Precision: Number() of a large
// $numberDecimal loses digits, which is accepted — these figures are a profile,
// not an accounting total.
function numericValue(v: any): number | null {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object') {
    const raw = v.$numberLong ?? v.$numberInt ?? v.$numberDouble ?? v.$numberDecimal;
    if (raw !== undefined) {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
  }
  return null;
}

export function computeNumeric(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found) continue;
      const n = numericValue(r.value);
      if (n === null) continue;
      count++;
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    row[encKey(f)] = count > 0 ? [{ _id: null, count, min, max, avg: sum / count }] : [];
  }
  return { result: [row] };
}

// The canonical EJSON date carries epoch ms as a numeric STRING:
// { $date: { $numberLong: "1590868887208" } }. new Date() of that string is
// Invalid Date, so it has to go through Number() first — and the sign matters,
// because every date before 1970 is negative. The same grammar is parsed in
// displayValue.ts's formatEjsonValue, which still has the unsigned form of this
// bug; keep the two in step if that one is fixed.
function dateMs(v: any): number {
  const inner = v.$date;
  const raw = inner !== null && typeof inner === 'object' ? inner.$numberLong : inner;
  const t = new Date(typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw).getTime();
  return Number.isNaN(t) ? NaN : t;
}

export function computeDates(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let earliest: any = null;
    let latest: any = null;
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || bsonType(r.value) !== 'date') continue;
      const ms = dateMs(r.value);
      if (Number.isNaN(ms)) continue;
      count++;
      if (ms < minMs) {
        minMs = ms;
        earliest = r.value;
      }
      if (ms > maxMs) {
        maxMs = ms;
        latest = r.value;
      }
    }
    row[encKey(f)] = count > 0 ? [{ _id: null, count, earliest, latest }] : [];
  }
  return { result: [row] };
}

// Every document-reading check, from one sample.
export function computeSampledChecks(
  docs: any[],
  fields: string[],
): Record<string, { result: any[] }> {
  return {
    coverage: computeCoverage(docs, fields),
    empties: computeEmpties(docs, fields),
    types: computeTypes(docs, fields),
    distribution: computeDistribution(docs, fields),
    cardinality: computeCardinality(docs, fields),
    strings: computeStrings(docs, fields),
    numeric: computeNumeric(docs, fields),
    dates: computeDates(docs, fields),
    sentinels: computeSentinels(docs, fields),
    schema: computeSchema(docs),
  };
}

// `docSize` derived from $collStats metadata rather than from the sample:
// $bsonSize has no client equivalent and JSON byte length is not BSON byte
// length. min/max are null because storage stats do not carry them, and a
// sample's range is not the collection's. Exported because it does not depend
// on the sample at all — StatsPanel publishes it from the storage probe alone
// when the sampled read fails.
export function docSizeFromStorage(storageRes: any, fallbackCount = 0): { result: any[] } {
  const storage = storageRes?.result?.[0]?.storageStats || {};
  return {
    result: [
      {
        count: storage.count ?? fallbackCount,
        avgSize: storage.avgObjSize ?? null,
        minSize: null,
        maxSize: null,
        totalSize: storage.size ?? null,
      },
    ],
  };
}

// The complete raw set StatsPanel and prefetch both publish, so neither builds
// it inline. `storage` is $collStats metadata passed straight through.
export function assembleSampledStats(
  docs: any[],
  fields: string[],
  storageRes: any,
): Record<string, { result: any[] }> {
  return {
    ...computeSampledChecks(docs, fields),
    storage: storageRes,
    docSize: docSizeFromStorage(storageRes, docs.length),
  };
}
