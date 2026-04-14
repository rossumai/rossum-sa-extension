export const FIELD_DISCOVERY_SIZE = 200;
export const TOP_VALUES = 5;
export const MAX_DEPTH = 3;
export const MAX_FIELDS = 50;

export function encKey(field) { return field.replace(/\./g, '__DOT__'); }

function fieldsOnly(fields) {
  const p = { _id: 0 };
  for (const f of fields) p[f] = 1;
  return { $project: p };
}

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
  // Remove parent fields that have child paths (e.g. "line_items" when
  // "line_items.item_amount" also exists) to avoid $project path collisions.
  const deduped = sorted.filter((f, i) => {
    const next = sorted[i + 1];
    return !next || !next.startsWith(f + '.');
  });
  return deduped.length > MAX_FIELDS ? deduped.slice(0, MAX_FIELDS) : deduped;
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
  return [fieldsOnly(fields), { $group: group }];
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
  return [fieldsOnly(fields), { $group: group }];
}

export function buildTypePipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: { $type: `$${f}` }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
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
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildCardinalityPipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $group: { _id: `$${f}` } },
      { $count: 'distinct' },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}

export function buildStringAnalysisPipeline(fields) {
  const facet = {};
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
  return [fieldsOnly(fields), { $facet: facet }];
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
