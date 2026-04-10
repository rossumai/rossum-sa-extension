export const FIELD_DISCOVERY_SIZE = 200;
export const TOP_VALUES = 5;
export const MAX_DEPTH = 3;
export const MAX_FIELDS = 50;

export function encKey(field) { return field.replace(/\./g, '__DOT__'); }

export function discoverFields(docs) {
  const fields = new Set();
  function walk(obj, prefix, depth) {
    if (depth > MAX_DEPTH) return;
    for (const key of Object.keys(obj)) {
      if (!prefix && key === '_id') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const val = obj[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val.$oid || val.$date)) {
        walk(val, path, depth + 1);
      } else {
        fields.add(path);
      }
    }
  }
  for (const doc of docs) walk(doc, '', 0);
  const sorted = [...fields].sort();
  return sorted.length > MAX_FIELDS ? sorted.slice(0, MAX_FIELDS) : sorted;
}

export function buildOverviewPipeline() {
  return [{ $count: 'total' }];
}

export function buildFieldCoveragePipeline(fields) {
  const group = { _id: null, _total: { $sum: 1 } };
  for (const f of fields) {
    const k = encKey(f);
    group[`f_${k}`] = {
      $sum: { $cond: [{ $and: [
        { $ne: [{ $type: `$${f}` }, 'missing'] },
        { $ne: [`$${f}`, null] },
      ] }, 1, 0] },
    };
  }
  return [{ $group: group }];
}

export function buildEmptyValuesPipeline(fields) {
  const group = { _id: null };
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
  return [{ $group: group }];
}

export function buildTypePipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: { $type: `$${f}` }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
  }
  return [{ $facet: facet }];
}

export function buildValueDistributionPipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: `$${f}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: TOP_VALUES },
    ];
  }
  return [{ $facet: facet }];
}

export function buildCardinalityPipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: `$${f}` } },
      { $count: 'distinct' },
    ];
  }
  return [{ $facet: facet }];
}

export function buildStringAnalysisPipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { [f]: { $type: 'string' } } },
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
  return [{ $facet: facet }];
}

export function buildNumericStatsPipeline(fields) {
  const facet = {};
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
  return [{ $facet: facet }];
}

export function buildDateRangePipeline(fields) {
  const facet = {};
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
  return [{ $facet: facet }];
}

export function buildSchemaConsistencyPipeline() {
  return [
    { $project: { _keys: { $objectToArray: '$$ROOT' } } },
    { $project: { fieldCount: { $subtract: [{ $size: '$_keys' }, 1] } } },
    { $group: { _id: '$fieldCount', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ];
}

export const STATS_CHECKS = [
  'coverage', 'empties', 'types', 'distribution',
  'cardinality', 'strings', 'numeric', 'dates', 'schema',
];

export function buildAllPipelines(fields) {
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
  };
}
