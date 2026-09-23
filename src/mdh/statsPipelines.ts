export const FIELD_DISCOVERY_SIZE = 200;
// Top distinct values fetched per field for the distribution. Cards show a
// height-budget-driven count (up to 8 when there's no mini chart and no issue
// messages, fewer otherwise), so fetch 8.
export const TOP_VALUES = 8;
export const MAX_DEPTH = 3;
export const MAX_FIELDS = 50;

// Normalized (lowercase, whitespace-trimmed) placeholder tokens that masquerade
// as real string data. Single source of truth for sentinel detection.
export const SENTINEL_STRINGS = [
  'null',
  'none',
  'nan',
  'undefined',
  'nil',
  'n/a',
  'na',
  'tbd',
  'unknown',
  '-',
  '--',
  '.',
];

export function encKey(field: string): string {
  return field.replace(/\./g, '__DOT__');
}

function fieldsOnly(fields: string[]): { $project: Record<string, number> } {
  const p: Record<string, number> = { _id: 0 };
  for (const f of fields) p[f] = 1;
  return { $project: p };
}

// Distinct leaf field paths discovered in the sample (uncapped, deduped,
// sorted), plus how many sampled documents each appears in (`counts`) so the
// cap can keep the most common fields.
function allDiscoveredFields(docs: any[]): { deduped: string[]; counts: Map<string, number> } {
  const counts = new Map();
  function walk(obj: any, prefix: string, depth: number): void {
    if (depth > MAX_DEPTH) return;
    for (const key of Object.keys(obj)) {
      if (!prefix && key === '_id') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const val = obj[key];
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        !(val.$oid || val.$date)
      ) {
        walk(val, path, depth + 1);
      } else {
        counts.set(path, (counts.get(path) || 0) + 1);
      }
    }
  }
  for (const doc of docs) walk(doc, '', 0);
  const sorted = [...counts.keys()].sort();
  // Remove parent fields that have child paths (e.g. "line_items" when
  // "line_items.item_amount" also exists) to avoid $project path collisions.
  const deduped = sorted.filter((f, i) => {
    const next = sorted[i + 1];
    return !next || !next.startsWith(f + '.');
  });
  return { deduped, counts };
}

// Discovered fields capped at MAX_FIELDS, plus the uncapped `total` so callers
// can be transparent when not every field is analyzed. When more than MAX_FIELDS
// exist, the MOST COMMON (by document frequency in the sample) are kept; the
// returned list is always alphabetical for stable display.
export function discoverFieldsWithTotal(docs: any[]): { fields: string[]; total: number } {
  const { deduped, counts } = allDiscoveredFields(docs);
  const total = deduped.length;
  if (total <= MAX_FIELDS) return { fields: deduped, total };
  const fields = [...deduped]
    .sort((a, b) => (counts.get(b) as number) - (counts.get(a) as number) || a.localeCompare(b))
    .slice(0, MAX_FIELDS)
    .sort();
  return { fields, total };
}

export function buildOverviewPipeline() {
  return [{ $collStats: { count: {} } }, { $project: { host: 0, localTime: 0 } }, { $limit: 1 }];
}

export function buildStoragePipeline() {
  return [
    { $collStats: { storageStats: { scale: 1 } } },
    {
      $project: {
        host: 0,
        localTime: 0,
        'storageStats.wiredTiger': 0,
        'storageStats.indexDetails': 0,
      },
    },
    { $limit: 1 },
  ];
}

// Batched storage stats across many collections in a single aggregate call.
// The outer pipeline runs against names[0]; each subsequent name is added via
// $unionWith. Each row carries the collection name in `_coll` so callers can
// split the result back per collection.
export function buildBatchStoragePipeline(names: string[]): any[] {
  const project = {
    host: 0,
    localTime: 0,
    'storageStats.wiredTiger': 0,
    'storageStats.indexDetails': 0,
  };
  const pipeline: any[] = [
    { $collStats: { storageStats: { scale: 1 } } },
    { $project: project },
    { $addFields: { _coll: names[0] } },
  ];
  for (let i = 1; i < names.length; i++) {
    pipeline.push({
      $unionWith: {
        coll: names[i],
        pipeline: [
          { $collStats: { storageStats: { scale: 1 } } },
          { $project: project },
          { $addFields: { _coll: names[i] } },
        ],
      },
    });
  }
  return pipeline;
}

export function buildDocSizePipeline() {
  return [
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avgSize: { $avg: { $bsonSize: '$$ROOT' } },
        minSize: { $min: { $bsonSize: '$$ROOT' } },
        maxSize: { $max: { $bsonSize: '$$ROOT' } },
        totalSize: { $sum: { $bsonSize: '$$ROOT' } },
      },
    },
    { $limit: 1 },
  ];
}

export function buildFieldCoveragePipeline(fields: string[]): any[] {
  const group: Record<string, any> = { _id: null, _total: { $sum: 1 } };
  for (const f of fields) {
    const k = encKey(f);
    group[`f_${k}`] = {
      $sum: {
        $cond: [
          { $and: [{ $ne: [{ $type: `$${f}` }, 'missing'] }, { $ne: [`$${f}`, null] }] },
          1,
          0,
        ],
      },
    };
  }
  return [fieldsOnly(fields), { $group: group }];
}

export function buildEmptyValuesPipeline(fields: string[]): any[] {
  const group: Record<string, any> = { _id: null };
  for (const f of fields) {
    const k = encKey(f);
    group[`null_${k}`] = {
      $sum: {
        $cond: [
          // A missing field path compares equal to null in an aggregation
          // expression, so a bare $eq would count absent documents as null and
          // disagree with computeEmpties, which counts the two separately. This
          // form is correct either way: a no-op if $eq already excludes missing,
          // a fix if it does not.
          { $and: [{ $ne: [{ $type: `$${f}` }, 'missing'] }, { $eq: [`$${f}`, null] }] },
          1,
          0,
        ],
      },
    };
    group[`missing_${k}`] = {
      $sum: { $cond: [{ $eq: [{ $type: `$${f}` }, 'missing'] }, 1, 0] },
    };
    group[`empty_${k}`] = {
      $sum: { $cond: [{ $eq: [`$${f}`, ''] }, 1, 0] },
    };
  }
  return [fieldsOnly(fields), { $group: group }];
}

export function buildTypePipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: { $type: `$${f}` }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildValueDistributionPipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: `$${f}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: TOP_VALUES },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildCardinalityPipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [{ $group: { _id: `$${f}` } }, { $count: 'distinct' }];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildStringAnalysisPipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { $expr: { $eq: [{ $type: `$${f}` }, 'string'] } } },
      {
        $project: {
          len: { $strLenCP: `$${f}` },
          hasLeading: { $cond: [{ $ne: [`$${f}`, { $ltrim: { input: `$${f}` } }] }, 1, 0] },
          hasTrailing: { $cond: [{ $ne: [`$${f}`, { $rtrim: { input: `$${f}` } }] }, 1, 0] },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          minLen: { $min: '$len' },
          maxLen: { $max: '$len' },
          avgLen: { $avg: '$len' },
          leading: { $sum: '$hasLeading' },
          trailing: { $sum: '$hasTrailing' },
        },
      },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildSentinelStringsPipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { $expr: { $eq: [{ $type: `$${f}` }, 'string'] } } },
      { $project: { __n: { $toLower: { $trim: { input: `$${f}` } } } } },
      { $match: { __n: { $in: SENTINEL_STRINGS } } },
      { $group: { _id: '$__n', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildNumericStatsPipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { [f]: { $type: 'number' } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          min: { $min: `$${f}` },
          max: { $max: `$${f}` },
          avg: { $avg: `$${f}` },
        },
      },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildDateRangePipeline(fields: string[]): any[] {
  const facet: Record<string, any> = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { [f]: { $type: 'date' } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          earliest: { $min: `$${f}` },
          latest: { $max: `$${f}` },
        },
      },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

// Shapes are distinct STRUCTURES, so group on the key array itself. Key ORDER can
// differ between writers, which would split one real shape into several — equal
// sets are merged in transformSchema instead. Normalising here would need
// $sortArray (MongoDB 5.2+) and Data Storage's version is unverified, so the extra
// headroom below is what makes the client-side merge lossless in practice.
export const SCHEMA_GROUP_LIMIT = 50;

export function buildSchemaConsistencyPipeline() {
  return [
    { $project: { _keys: { $objectToArray: '$$ROOT' } } },
    { $project: { fields: { $map: { input: '$_keys', as: 'k', in: '$$k.k' } } } },
    { $group: { _id: '$fields', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: SCHEMA_GROUP_LIMIT },
  ];
}

export const STATS_CHECKS = [
  'coverage',
  'empties',
  'types',
  'distribution',
  'cardinality',
  'strings',
  'numeric',
  'dates',
  'schema',
  'storage',
  'docSize',
  'sentinels',
];

export function buildAllPipelines(fields: string[]) {
  return {
    coverage: buildFieldCoveragePipeline(fields),
    empties: buildEmptyValuesPipeline(fields),
    types: buildTypePipeline(fields),
    distribution: buildValueDistributionPipeline(fields),
    cardinality: buildCardinalityPipeline(fields),
    strings: buildStringAnalysisPipeline(fields),
    numeric: buildNumericStatsPipeline(fields),
    dates: buildDateRangePipeline(fields),
    schema: buildSchemaConsistencyPipeline(),
    storage: buildStoragePipeline(),
    docSize: buildDocSizePipeline(),
    sentinels: buildSentinelStringsPipeline(fields),
  };
}

// ── Sampling ────────────────────────────────────
//
// The "Exact" setting. 0 is not a sample size; it means run the existing
// full-collection pipelines whatever the collection holds.
export const STATS_EXACT = 0;

// Bytes one analysis may pull into the browser — and, because $sample drawing more
// than 5% of a collection buffers the drawn documents for a random sort capped at
// 100MB (this API cannot pass allowDiskUse), the ceiling on that buffer too.
//
// Budgeting in BYTES rather than rows is the whole point. It makes the row count
// `floor(BUDGET / avgObjSize)`, so `rows * avgObjSize <= BUDGET` holds by
// construction — the sort buffer can never exceed the budget, and the zone where
// the sample is more than 5% of the collection but less than all of it becomes
// safe to use instead of forbidden. That zone is exactly where the old
// fraction-of-the-collection rule produced its 20x cliff.
export const SAMPLE_BYTE_BUDGET = 64 * 1024 * 1024;
// Absolute ceiling on rows, independent of the byte budget above it and the
// cell ceiling below it.
export const SAMPLE_MAX_ROWS = 100_000;

// The byte budget bounds TRANSFER and the $sample sort buffer. It does not bound
// the client-side profiling, whose cost is O(rows × fields) across nine passes —
// and because rows is INVERSELY proportional to document size, the byte budget's
// protection runs backwards here: the smaller the documents, the more rows fit
// and the longer the main thread is blocked. Measured on V8: 65,536 rows × 50
// fields froze the Console for 12.3s, 100,000 × 50 for 17.2s. This ceiling bounds
// the product instead, at roughly 1.5s of profiling.
export const SAMPLE_MAX_CELLS = 400_000;

export const STATS_MODE_SAMPLE = 'sample';
export const STATS_MODE_EXACT = 'exact';
export const STATS_MODES = [STATS_MODE_SAMPLE, STATS_MODE_EXACT];

// Round down to a readable multiple of 1,000. DOWN specifically: the returned
// count is what keeps `rows * avgObjSize` inside SAMPLE_BYTE_BUDGET, and so
// inside MongoDB's 100MB $sample sort cap, and only a floor preserves that —
// rounding 1,001 up to 2,000 would nearly double the budget. Below 1,000 the
// exact count is returned, because rounding a few hundred rows to thousands
// would floor them to zero.
const SAMPLE_ROUNDING = 1000;

function roundRows(rows: number): number {
  return rows >= SAMPLE_ROUNDING ? Math.floor(rows / SAMPLE_ROUNDING) * SAMPLE_ROUNDING : rows;
}

// How many documents one analysis can afford, bounded by transfer (bytes) and by
// client-side profiling (cells) at once. Deliberately does NOT take `total`:
// EVERY term here is independent of collection size, which is what makes
// `min(total, affordableRows(...))` monotonic in it.
export function affordableRows(avgObjSize: number, fieldCount: number): number {
  const byBytes = Math.floor(SAMPLE_BYTE_BUDGET / avgObjSize);
  const byCells = fieldCount > 0 ? Math.floor(SAMPLE_MAX_CELLS / fieldCount) : SAMPLE_MAX_ROWS;
  return roundRows(Math.min(byBytes, byCells, SAMPLE_MAX_ROWS));
}

// The path decision in one place. `size` is how many documents will be analysed
// either way, so callers report it without re-deriving it.
export function analysisPlan(
  total: number,
  avgObjSize: number,
  fieldCount: number,
  mode: string,
): { sampled: boolean; size: number } {
  if (mode === STATS_MODE_EXACT) return { sampled: false, size: total };
  // Without a document size we cannot bound either the transfer or the sort
  // buffer, so the byte invariant would not hold by construction. Read exactly.
  if (!(avgObjSize > 0)) return { sampled: false, size: total };
  const rows = affordableRows(avgObjSize, fieldCount);
  return total <= rows ? { sampled: false, size: total } : { sampled: true, size: rows };
}

export function statsModeLabel(mode: string): string {
  return mode === STATS_MODE_EXACT ? 'Exact' : 'Sample';
}

// The single read that replaces eleven full-collection scans. `_topKeys`
// carries the top-level key NAMES so the schema-shape check survives the
// projection — shipping whole documents to the browser is the cost this whole
// design exists to avoid. It includes `_id`, matching the server pipeline,
// which derives fieldCount as $size(_keys) - 1.
export function buildSampleReadPipeline(fields: string[], size: number): any[] {
  const project: Record<string, any> = { _id: 0 };
  for (const f of fields) project[f] = 1;
  project._topKeys = {
    $map: { input: { $objectToArray: '$$ROOT' }, as: 'k', in: '$$k.k' },
  };
  return [{ $sample: { size } }, { $project: project }];
}

// The single-flight key for the sampled analysis read. StatsPanel and the
// background prefetch both race to run it for the same collection and sample
// size, so both must derive the same key from the same two values rather than
// each writing the template literal — a mismatch there would silently defeat
// the dedupe it exists to provide.
export function sampledStatsKey(collection: string, size: number): string {
  return `statsSampled::${collection}::${size}`;
}
