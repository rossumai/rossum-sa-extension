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
      $sum: { $cond: [{ $eq: [`$${f}`, null] }, 1, 0] },
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

export function buildSchemaConsistencyPipeline() {
  return [
    { $project: { _keys: { $objectToArray: '$$ROOT' } } },
    {
      $project: {
        fieldCount: { $subtract: [{ $size: '$_keys' }, 1] },
        fields: { $map: { input: '$_keys', as: 'k', in: '$$k.k' } },
      },
    },
    {
      $group: {
        _id: '$fieldCount',
        count: { $sum: 1 },
        sampleFields: { $first: '$fields' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 20 },
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
