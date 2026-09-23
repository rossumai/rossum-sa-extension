import { describe, it, expect } from 'vitest';
import {
  resolvePath,
  bsonType,
  mongoTrim,
  hasLeadingWs,
  hasTrailingWs,
  cpLength,
  groupKey,
  computeCoverage,
  computeEmpties,
  computeTypes,
  computeSchema,
  computeDistribution,
  computeCardinality,
  computeStrings,
  computeSentinels,
  computeNumeric,
  computeDates,
  computeSampledChecks,
  assembleSampledStats,
} from '../src/mdh/statsCompute.js';
import { transformStatsResults } from '../src/mdh/statsSummary.js';
import {
  transformCardinality,
  transformDistribution,
  transformNumeric,
  transformDates,
} from '../src/mdh/statsView.js';

describe('resolvePath', () => {
  it('distinguishes a missing path from a null value', () => {
    expect(resolvePath({ a: null }, 'a')).toEqual({ found: true, value: null });
    expect(resolvePath({}, 'a')).toEqual({ found: false, value: undefined });
    expect(resolvePath({ a: {} }, 'a.b')).toEqual({ found: false, value: undefined });
  });

  it('traverses an array of documents the way $a.b does', () => {
    expect(resolvePath({ a: [{ b: 1 }, { b: 2 }] }, 'a.b')).toEqual({ found: true, value: [1, 2] });
  });

  it('omits elements that lack the key, rather than emitting a hole', () => {
    expect(resolvePath({ a: [{ b: 1 }, {}, { b: 3 }] }, 'a.b')).toEqual({
      found: true,
      value: [1, 3],
    });
    expect(resolvePath({ a: [1, 2] }, 'a.b')).toEqual({ found: true, value: [] });
  });

  it('returns a whole array when the path stops at it', () => {
    expect(resolvePath({ a: [1, 2] }, 'a')).toEqual({ found: true, value: [1, 2] });
  });

  it('does not walk through a scalar', () => {
    expect(resolvePath({ a: 'text' }, 'a.b')).toEqual({ found: false, value: undefined });
  });
});

describe('bsonType', () => {
  it('never reports an EJSON wrapper as an object — they are BSON scalars server-side', () => {
    expect(bsonType({ $oid: '507f1f77bcf86cd799439011' })).toBe('objectId');
    expect(bsonType({ $date: '2026-01-01T00:00:00Z' })).toBe('date');
  });

  it('collapses every numeric subtype to "number", which is what the UI already does', () => {
    expect(bsonType(1)).toBe('number');
    expect(bsonType(0.5)).toBe('number');
    expect(bsonType({ $numberLong: '9007199254740993' })).toBe('number');
    expect(bsonType({ $numberDecimal: '1.10' })).toBe('number');
  });

  it('names the other EJSON wrappers the way $type does, not as objects', () => {
    // Falling through to 'object' here turned a field holding only binary — or
    // only regexes, or only timestamps — into a spurious type MIX, because the
    // server calls the same value 'binData'.
    expect(bsonType({ $binary: { base64: 'AQID', subType: '00' } })).toBe('binData');
    expect(bsonType({ $regularExpression: { pattern: '^a', options: 'i' } })).toBe('regex');
    expect(bsonType({ $regex: '^a', $options: 'i' })).toBe('regex');
    expect(bsonType({ $timestamp: { t: 1, i: 2 } })).toBe('timestamp');
  });

  it("reports resolvePath's not-found sentinel as missing, not object", () => {
    expect(bsonType(undefined)).toBe('missing');
    expect(bsonType(resolvePath({}, 'nope').value)).toBe('missing');
  });

  it('names the remaining types the way $type does', () => {
    expect(bsonType(null)).toBe('null');
    expect(bsonType('x')).toBe('string');
    expect(bsonType(true)).toBe('bool');
    expect(bsonType([1])).toBe('array');
    expect(bsonType({ a: 1 })).toBe('object');
  });
});

describe('mongoTrim', () => {
  it('trims NUL, which String.prototype.trim does not', () => {
    expect(mongoTrim('\u0000abc\u0000')).toBe('abc');
    expect('\u0000abc\u0000'.trim()).toBe('\u0000abc\u0000');
  });

  it('does not trim the BOM, which String.prototype.trim does', () => {
    expect(mongoTrim('\ufeffabc')).toBe('\ufeffabc');
    expect('\ufeffabc'.trim()).toBe('abc');
  });

  it('trims the ordinary and the exotic whitespace $trim names', () => {
    expect(mongoTrim('  a\t\n')).toBe('a');
    expect(mongoTrim('  a ')).toBe('a');
  });

  it("does NOT trim whitespace outside MongoDB's documented set", () => {
    // U+3000 is the CJK full-width space. JS trims it, $trim does not — trimming
    // it here would report CJK values as dirty when the server calls them clean.
    // Both characters are written as escapes: U+2028 is an ECMAScript line
    // terminator, and as a raw byte it is invisible in every diff and editor.
    expect(mongoTrim('\u3000a\u3000')).toBe('\u3000a\u3000');
    expect('\u3000a\u3000'.trim()).toBe('a');
    expect(mongoTrim('\u2028a\u2028')).toBe('\u2028a\u2028');
  });

  it('reports leading and trailing separately, as the pipeline does', () => {
    expect(hasLeadingWs(' a')).toBe(true);
    expect(hasTrailingWs(' a')).toBe(false);
    expect(hasTrailingWs('a ')).toBe(true);
  });
});

describe('cpLength', () => {
  it('counts code points like $strLenCP, not UTF-16 units', () => {
    expect(cpLength('a\u{1F600}b')).toBe(3);
    expect('a\u{1F600}b'.length).toBe(4);
  });
});

describe('groupKey', () => {
  it('separates values that differ only by type', () => {
    expect(groupKey(1)).not.toBe(groupKey('1'));
    expect(groupKey(null)).not.toBe(groupKey('null'));
  });

  it('treats documents with different key ORDER as different, as BSON equality does', () => {
    expect(groupKey({ a: 1, b: 2 })).not.toBe(groupKey({ b: 2, a: 1 }));
  });

  it('treats an array as one value, in order', () => {
    expect(groupKey([1, 2])).toBe(groupKey([1, 2]));
    expect(groupKey([1, 2])).not.toBe(groupKey([2, 1]));
  });
});

const enc = (f: string) => f.replace(/\./g, '__DOT__');

// One sample, shaped like what buildSampleReadPipeline returns: the analysed
// fields plus `_topKeys` (which includes _id, as the server pipeline's
// $objectToArray does).
const DOCS = [
  { supplier: 'ACME', amount: 10, _topKeys: ['_id', 'supplier', 'amount'] },
  { supplier: '', amount: 20, _topKeys: ['_id', 'supplier', 'amount'] },
  { supplier: null, amount: 30, _topKeys: ['_id', 'supplier', 'amount'] },
  { amount: 40, _topKeys: ['_id', 'amount'] },
];

describe('computeCoverage', () => {
  it('counts present as neither missing nor null, and carries the sample size as _total', () => {
    const r = computeCoverage(DOCS, ['supplier', 'amount']).result[0];
    expect(r._total).toBe(4);
    expect(r[`f_${enc('supplier')}`]).toBe(2); // 'ACME' and '' are both present
    expect(r[`f_${enc('amount')}`]).toBe(4);
  });

  it('counts an empty array and an empty string as PRESENT, as the server $cond does', () => {
    const docs = [{ tags: [], note: '' }, { tags: ['x'], note: 'hi' }, {}];
    const r = computeCoverage(docs, ['tags', 'note']).result[0];
    expect(r[`f_${enc('tags')}`]).toBe(2);
    expect(r[`f_${enc('note')}`]).toBe(2);
  });
});

describe('computeEmpties', () => {
  it('separates null, missing and empty-string into their own counters', () => {
    const r = computeEmpties(DOCS, ['supplier']).result[0];
    expect(r[`null_${enc('supplier')}`]).toBe(1);
    expect(r[`missing_${enc('supplier')}`]).toBe(1);
    expect(r[`empty_${enc('supplier')}`]).toBe(1);
  });
});

describe('computeTypes', () => {
  it('buckets by $type including a "missing" bucket, sorted by count descending', () => {
    const buckets = computeTypes(DOCS, ['supplier']).result[0][enc('supplier')];
    expect(buckets).toEqual([
      { _id: 'string', count: 2 },
      { _id: 'null', count: 1 },
      { _id: 'missing', count: 1 },
    ]);
  });
});

describe('computeSchema', () => {
  it('groups by the exact key array, biggest group first', () => {
    expect(computeSchema(DOCS).result).toEqual([
      { _id: ['_id', 'supplier', 'amount'], count: 3 },
      { _id: ['_id', 'amount'], count: 1 },
    ]);
  });

  it('treats two documents with the same field COUNT but different NAMES as two shapes', () => {
    // The defect this task fixes: grouping on fieldCount alone (the old
    // pipeline) would have collapsed these two 2-field docs into one shape.
    const docs = [{ _topKeys: ['_id', 'supplier'] }, { _topKeys: ['_id', 'amount'] }];
    expect(computeSchema(docs).result).toEqual([
      { _id: ['_id', 'supplier'], count: 1 },
      { _id: ['_id', 'amount'], count: 1 },
    ]);
  });

  it("does not itself merge key-order variants of the same set — that is transformSchema's job", () => {
    const docs = [
      { _topKeys: ['_id', 'supplier', 'amount'] },
      { _topKeys: ['_id', 'amount', 'supplier'] },
    ];
    expect(computeSchema(docs).result).toEqual([
      { _id: ['_id', 'supplier', 'amount'], count: 1 },
      { _id: ['_id', 'amount', 'supplier'], count: 1 },
    ]);
  });

  it('emits the array AS STORED, not pre-sorted', () => {
    const docs = [{ _topKeys: ['_id', 'zebra', 'apple'] }];
    expect(computeSchema(docs).result[0]._id).toEqual(['_id', 'zebra', 'apple']);
  });

  it('skips a document whose _topKeys is missing or not an array', () => {
    // Unreachable through buildSampleReadPipeline, which always projects
    // _topKeys as an array — but skipping is the honest answer either way.
    const res = computeSchema([
      { _topKeys: ['_id', 'supplier'] },
      { supplier: 'x' }, // missing _topKeys
      { _topKeys: 'oops' }, // not an array
    ]).result;
    expect(res).toEqual([{ _id: ['_id', 'supplier'], count: 1 }]);
  });
});

describe('the raw shape feeds the existing transforms unchanged', () => {
  it('produces a health-score input set transformStatsResults can read', () => {
    const t = transformStatsResults(
      {
        coverage: computeCoverage(DOCS, ['supplier', 'amount']),
        empties: computeEmpties(DOCS, ['supplier', 'amount']),
        types: computeTypes(DOCS, ['supplier', 'amount']),
        strings: { result: [{}] },
        schema: computeSchema(DOCS),
      },
      ['supplier', 'amount'],
    );
    expect(t.coverage).toEqual([
      { field: 'supplier', present: 2, total: 4, pct: 50 },
      { field: 'amount', present: 4, total: 4, pct: 100 },
    ]);
    expect(t.schemaShapes).toEqual([
      { fieldCount: 2, docCount: 3, fields: ['amount', 'supplier'] },
      { fieldCount: 1, docCount: 1, fields: ['amount'] },
    ]);
  });

  it('merges key-order variants of the same set through transformSchema, with counts summed', () => {
    // computeSchema groups on the raw array (order-sensitive, mirroring the
    // server), so these land as two separate raw groups; transformStatsResults
    // runs the raw shape through transformSchema, which normalises and merges
    // them — proving the merge is exercised end to end, not bypassed.
    const docs = [
      { _topKeys: ['_id', 'supplier', 'amount'] },
      { _topKeys: ['_id', 'supplier', 'amount'] },
      { _topKeys: ['_id', 'amount', 'supplier'] },
    ];
    const raw = computeSchema(docs);
    expect(raw.result).toEqual([
      { _id: ['_id', 'supplier', 'amount'], count: 2 },
      { _id: ['_id', 'amount', 'supplier'], count: 1 },
    ]);
    const t = transformStatsResults(
      {
        coverage: { result: [{ _total: 3 }] },
        empties: { result: [{}] },
        types: { result: [{}] },
        strings: { result: [{}] },
        schema: raw,
      },
      ['supplier', 'amount'],
    );
    expect(t.schemaShapes).toEqual([
      { fieldCount: 2, docCount: 3, fields: ['amount', 'supplier'] },
    ]);
  });
});

const VDOCS = [
  { cur: 'EUR', amt: 10, when: { $date: '2026-01-02T00:00:00Z' }, _topKeys: ['_id', 'cur'] },
  { cur: 'EUR', amt: 5, when: { $date: '2026-03-04T00:00:00Z' }, _topKeys: ['_id', 'cur'] },
  { cur: ' usd ', amt: 20, _topKeys: ['_id', 'cur'] },
  { cur: 'n/a', _topKeys: ['_id', 'cur'] },
  { _topKeys: ['_id'] },
];

describe('computeDistribution', () => {
  // $group on a missing field yields an _id of null, so missing and stored null
  // land in ONE bucket. Reproducing that is what keeps the counts honest.
  it('groups by exact value, folding missing into the null bucket, top N by count', () => {
    const buckets = computeDistribution(VDOCS, ['cur']).result[0][enc('cur')];
    expect(buckets[0]).toEqual({ _id: 'EUR', count: 2 });
    expect(buckets).toContainEqual({ _id: null, count: 1 });
    expect(
      transformDistribution(computeDistribution(VDOCS, ['cur']), ['cur'])[0].values[0],
    ).toEqual({ value: 'EUR', count: 2 });
  });
});

describe('computeCardinality', () => {
  it('counts distinct groups, including the null bucket', () => {
    // 'EUR', ' usd ', 'n/a', null
    expect(transformCardinality(computeCardinality(VDOCS, ['cur']), ['cur'])).toEqual([
      { field: 'cur', distinct: 4 },
    ]);
  });

  it('emits an empty facet array when nothing matches, as $count does for an empty stream', () => {
    expect(computeCardinality([], ['cur']).result[0][enc('cur')]).toEqual([]);
  });
});

describe('computeStrings', () => {
  it('measures only string values, in code points, with leading/trailing counted apart', () => {
    const s = computeStrings(VDOCS, ['cur']).result[0][enc('cur')][0];
    expect(s.count).toBe(4); // EUR, EUR, ' usd ', 'n/a'
    expect(s.minLen).toBe(3);
    expect(s.maxLen).toBe(5);
    expect(s.leading).toBe(1);
    expect(s.trailing).toBe(1);
  });

  it('emits an empty facet array for a field with no strings, as $facet does', () => {
    expect(computeStrings(VDOCS, ['amt']).result[0][enc('amt')]).toEqual([]);
  });
});

describe('computeSentinels', () => {
  it('matches the normalized token, not the stored casing or padding, sorted by count descending', () => {
    // The lower-count token is inserted FIRST, so Map insertion order already
    // disagrees with count order — passing here requires the sort to run.
    const rows = computeSentinels(
      [{ f: 'TBD' }, { f: 'real' }, { f: 'N/A' }, { f: ' n/a ' }],
      ['f'],
    ).result[0][enc('f')];
    expect(rows).toEqual([
      { _id: 'n/a', count: 2 },
      { _id: 'tbd', count: 1 },
    ]);
  });

  it('emits an empty facet array when nothing matches', () => {
    expect(computeSentinels([{ f: 'real' }], ['f']).result[0][enc('f')]).toEqual([]);
  });
});

describe('computeNumeric and computeDates', () => {
  it('reports min/max/avg over numbers only', () => {
    expect(transformNumeric(computeNumeric(VDOCS, ['amt']), ['amt'])).toEqual([
      { field: 'amt', count: 3, min: 5, max: 20, avg: 35 / 3 },
    ]);
  });

  it('reports the earliest and latest date, preserving the wire wrapper', () => {
    expect(transformDates(computeDates(VDOCS, ['when']), ['when'])).toEqual([
      {
        field: 'when',
        count: 2,
        earliest: { $date: '2026-01-02T00:00:00Z' },
        latest: { $date: '2026-03-04T00:00:00Z' },
      },
    ]);
  });

  it('omits a field with no values of that type, as the $match does', () => {
    expect(transformNumeric(computeNumeric(VDOCS, ['cur']), ['cur'])).toEqual([]);
  });

  it('counts a wrapped numeric, so it agrees with computeTypes about the same value', () => {
    const docs = [{ n: 5 }, { n: { $numberLong: '15' } }, { n: 'text' }];
    const s = computeNumeric(docs, ['n']).result[0][enc('n')][0];
    expect(s.count).toBe(2);
    expect(s.min).toBe(5);
    expect(s.max).toBe(15);
  });

  it('skips an array of numbers, the one place this deliberately diverges from the server', () => {
    // The server's $match {f: {$type:'number'}} matches when ANY element is a
    // number; the client requires the value itself to be one. Recorded in the
    // design spec under Known divergences.
    const docs = [{ n: 1 }, { n: [2, 3] }];
    const s = computeNumeric(docs, ['n']).result[0][enc('n')][0];
    expect(s.count).toBe(1);
    expect(s.max).toBe(1);
  });

  it('parses the canonical EJSON date, whose epoch ms is a numeric string', () => {
    const docs = [
      { at: { $date: { $numberLong: '0' } } },
      { at: { $date: { $numberLong: '1590868887208' } } },
    ];
    const s = computeDates(docs, ['at']).result[0][enc('at')][0];
    expect(s.count).toBe(2);
    expect(s.earliest).toEqual({ $date: { $numberLong: '0' } });
    expect(s.latest).toEqual({ $date: { $numberLong: '1590868887208' } });
  });

  it('parses a pre-1970 date, whose epoch ms is negative', () => {
    const docs = [
      { at: { $date: { $numberLong: '-86400000' } } },
      { at: { $date: { $numberLong: '0' } } },
    ];
    const s = computeDates(docs, ['at']).result[0][enc('at')][0];
    expect(s.count).toBe(2);
    expect(s.earliest).toEqual({ $date: { $numberLong: '-86400000' } });
    expect(s.latest).toEqual({ $date: { $numberLong: '0' } });
  });
});

describe('assembleSampledStats', () => {
  const storageRes = {
    result: [{ storageStats: { count: 4_000_000, avgObjSize: 812, size: 3_248_000_000 } }],
  };

  it('takes document size from $collStats, which is exact, not from the sample', () => {
    const d = assembleSampledStats(VDOCS, ['cur'], storageRes).docSize.result[0];
    expect(d.count).toBe(4_000_000);
    expect(d.avgSize).toBe(812);
    expect(d.totalSize).toBe(3_248_000_000);
    // $bsonSize has no client equivalent and storage stats carry no range, so
    // a sampled min/max would be a narrower range presented as the true one.
    expect(d.minSize).toBeNull();
    expect(d.maxSize).toBeNull();
  });

  it('passes the storage response through untouched', () => {
    expect(assembleSampledStats(VDOCS, ['cur'], storageRes).storage).toBe(storageRes);
  });

  it('survives a storage response with no stats', () => {
    const d = assembleSampledStats(VDOCS, ['cur'], { result: [] }).docSize.result[0];
    expect(d.count).toBe(VDOCS.length);
    expect(d.avgSize).toBeNull();
  });
});

describe('computeSampledChecks', () => {
  it('returns all ten document-reading checks under their STATS_CHECKS names', () => {
    const all = computeSampledChecks(VDOCS, ['cur', 'amt']);
    expect(Object.keys(all).sort()).toEqual(
      [
        'cardinality',
        'coverage',
        'dates',
        'distribution',
        'empties',
        'numeric',
        'schema',
        'sentinels',
        'strings',
        'types',
      ].sort(),
    );
    expect(all.coverage.result[0]._total).toBe(5);
  });
});
