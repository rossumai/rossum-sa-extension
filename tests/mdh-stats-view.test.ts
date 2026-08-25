import { describe, it, expect } from 'vitest';
import {
  transformCardinality, transformDistribution, transformNumeric,
  transformDates, transformStorage, transformDocSize,
  fieldTypeSummary, friendlyType,
  indexPrefixMap,
  buildFieldProfiles,
  rangeBar, spanBar,
  buildValueFilterPipeline,
} from '../src/mdh/statsView.js';

const enc = (f: any) => f.replace(/\./g, '__DOT__');

describe('transformCardinality', () => {
  it('reads distinct per field, 0 when absent', () => {
    const res = { result: [{ [enc('a')]: [{ distinct: 12 }], [enc('b')]: [] }] };
    expect(transformCardinality(res, ['a', 'b'])).toEqual([
      { field: 'a', distinct: 12 }, { field: 'b', distinct: 0 },
    ]);
  });
});

describe('transformDistribution', () => {
  it('maps facet buckets to {value,count}', () => {
    const res = { result: [{ [enc('a')]: [{ _id: 'X', count: 5 }, { _id: 'Y', count: 2 }] }] };
    expect(transformDistribution(res, ['a'])).toEqual([
      { field: 'a', values: [{ value: 'X', count: 5 }, { value: 'Y', count: 2 }] },
    ]);
  });
});

describe('transformNumeric / transformDates', () => {
  it('keeps only fields that produced a stat', () => {
    const num = { result: [{ [enc('amt')]: [{ count: 3, min: 1, max: 9, avg: 5 }], [enc('name')]: [] }] };
    expect(transformNumeric(num, ['amt', 'name'])).toEqual([{ field: 'amt', count: 3, min: 1, max: 9, avg: 5 }]);
    const dt = { result: [{ [enc('d')]: [{ count: 2, earliest: '2020-01-01', latest: '2021-01-01' }] }] };
    expect(transformDates(dt, ['d', 'x'])).toEqual([{ field: 'd', count: 2, earliest: '2020-01-01', latest: '2021-01-01' }]);
  });
});

describe('transformStorage / transformDocSize', () => {
  it('extracts the fields the panel shows, null when absent', () => {
    expect(transformStorage({ result: [{ storageStats: { size: 1, storageSize: 2, freeStorageSize: 3, avgObjSize: 4, count: 5 } }] }))
      .toEqual({ size: 1, storageSize: 2, freeStorageSize: 3, avgObjSize: 4, count: 5 });
    expect(transformStorage({ result: [{}] })).toBeNull();
    expect(transformDocSize({ result: [{ count: 5, avgSize: 4, minSize: 1, maxSize: 9, totalSize: 20 }] }))
      .toEqual({ count: 5, avg: 4, min: 1, max: 9, total: 20 });
    expect(transformDocSize({ result: [] })).toBeNull();
  });
});

describe('fieldTypeSummary', () => {
  it('derives primaryType + isMixed from raw facet buckets, ignoring missing', () => {
    const res = { result: [{
      [enc('a')]: [{ _id: 'string', count: 10 }],
      [enc('b')]: [{ _id: 'double', count: 8 }, { _id: 'string', count: 2 }, { _id: 'missing', count: 1 }],
      [enc('c')]: [{ _id: 'missing', count: 4 }],
    }] };
    const s = fieldTypeSummary(res, ['a', 'b', 'c']);
    expect(s.a).toEqual({ primaryType: 'string', types: [{ type: 'string', count: 10 }], isMixed: false });
    expect(s.b.isMixed).toBe(true);
    expect(s.b.primaryType).toBe('number'); // double collapses to friendly "number"
    expect(s.c.primaryType).toBeNull(); // only missing
  });

  it('collapses BSON numeric subtypes (int+double) into one "number" — not a mix', () => {
    const res = { result: [{
      [enc('amt')]: [{ _id: 'double', count: 8 }, { _id: 'int', count: 2 }],
    }] };
    const s = fieldTypeSummary(res, ['amt']);
    expect(s.amt).toEqual({ primaryType: 'number', types: [{ type: 'number', count: 10 }], isMixed: false });
  });
});

describe('indexPrefixMap', () => {
  it('maps only the LEADING key of each index to its name(s); ignores non-prefix members', () => {
    const indexes = [
      { name: '_id_', key: { _id: 1 } },
      { name: 'vendor_id_1', key: { vendor_id: 1 } },
      { name: 'vendor_date', key: { vendor_id: 1, created_date: -1 } },
      { name: 'sku_idx', key: { 'line_items.sku': 1 } },
    ];
    const m = indexPrefixMap(indexes);
    expect(m.get('vendor_id')).toEqual(['vendor_id_1', 'vendor_date']);
    expect(m.get('line_items.sku')).toEqual(['sku_idx']);
    expect(m.get('created_date')).toBeUndefined(); // 2nd key of compound → not a prefix
    expect(m.get('_id')).toEqual(['_id_']);
  });

  it('tolerates empty/missing input and indexes without a key', () => {
    expect(indexPrefixMap([]).size).toBe(0);
    expect(indexPrefixMap(null).size).toBe(0);
    expect(indexPrefixMap([{ name: 'x' }]).size).toBe(0);
  });
});

describe('buildValueFilterPipeline', () => {
  it('builds an exact $match and preserves default $sort/$skip/$limit stages', () => {
    expect(JSON.parse(buildValueFilterPipeline('status', 'approved', false)))
      .toEqual([
        { $match: { status: 'approved' } },
        { $sort: { _id: -1 } },
        { $skip: 0 },
        { $limit: 50 },
      ]);
    expect(JSON.parse(buildValueFilterPipeline('line_items.sku', 'A1', false))[0])
      .toEqual({ $match: { 'line_items.sku': 'A1' } });
  });

  it('respects a provided limit (the data view page size)', () => {
    const p = JSON.parse(buildValueFilterPipeline('amount', 1240, false, 25));
    expect(p[0]).toEqual({ $match: { amount: 1240 } });
    expect(p[p.length - 1]).toEqual({ $limit: 25 });
  });

  it('builds a case-insensitive, trimmed regex for placeholder string tokens', () => {
    expect(JSON.parse(buildValueFilterPipeline('status', 'n/a', true))[0])
      .toEqual({ $match: { status: { $regex: '^\\s*n/a\\s*$', $options: 'i' } } });
  });

  it('escapes regex-special characters in placeholder tokens', () => {
    expect(JSON.parse(buildValueFilterPipeline('x', '.', true))[0])
      .toEqual({ $match: { x: { $regex: '^\\s*\\.\\s*$', $options: 'i' } } });
  });
});

describe('friendlyType', () => {
  it('maps mongo type names to friendly labels', () => {
    expect(friendlyType('double')).toBe('number');
    expect(friendlyType('int')).toBe('number');
    expect(friendlyType('long')).toBe('number');
    expect(friendlyType('decimal')).toBe('number');
    expect(friendlyType('string')).toBe('string');
    expect(friendlyType('date')).toBe('date');
    expect(friendlyType('bool')).toBe('boolean');
    expect(friendlyType('object')).toBe('object');
    expect(friendlyType(null)).toBe('—');
  });
});

describe('buildFieldProfiles', () => {
  const base = {
    fields: ['amt', 'name', 'sku'],
    total: 100,
    coverage: [{ field: 'amt', pct: 100, present: 100, total: 100 }, { field: 'name', pct: 98, present: 98, total: 100 }, { field: 'sku', pct: 100, present: 100, total: 100 }],
    empties: [{ field: 'name', nullCount: 2, missingCount: 0, emptyCount: 0 }],
    typeSummary: { amt: { primaryType: 'double', types: [{ type: 'double', count: 100 }], isMixed: false }, name: { primaryType: 'string', types: [], isMixed: false }, sku: { primaryType: 'string', types: [], isMixed: false } },
    cardinality: [{ field: 'amt', distinct: 80 }, { field: 'name', distinct: 60 }, { field: 'sku', distinct: 100 }],
    distribution: [{ field: 'amt', values: [{ value: 5, count: 9 }] }, { field: 'name', values: [{ value: 'Acme', count: 4 }] }, { field: 'sku', values: [{ value: 'A1', count: 1 }] }],
    strings: [{ field: 'name', count: 98, minLen: 3, maxLen: 40, avgLen: 17, leading: 0, trailing: 0 }],
    numeric: [{ field: 'amt', count: 100, min: 0, max: 900, avg: 120 }],
    dates: [],
    sentinels: [],
  };

  it('merges per-field slices and computes diversity + fullyDistinct', () => {
    const p = buildFieldProfiles(base);
    const amt = p.find((x: any) => x.field === 'amt');
    expect(amt.numeric).toEqual({ count: 100, min: 0, max: 900, avg: 120 });
    expect(amt.diversityPct).toBe(80);
    expect(amt.fullyDistinct).toBe(false);
    const name = p.find((x: any) => x.field === 'name');
    expect(name.nullCount).toBe(2);
    expect(name.string.maxLen).toBe(40);
    const sku = p.find((x: any) => x.field === 'sku');
    expect(sku.fullyDistinct).toBe(true); // top value count <= 1
  });

  it('tolerates null slices (still loading / errored)', () => {
    const p = buildFieldProfiles({ ...base, numeric: null, strings: null, sentinels: null });
    expect(p.find((x: any) => x.field === 'amt').numeric).toBeNull();
    expect(p.length).toBe(3);
  });
});

describe('rangeBar', () => {
  it('positions the avg tick within min..max', () => {
    expect(rangeBar({ min: 0, max: 100, value: 25 })).toEqual({ left: 0, right: 0, avgPct: 25 });
  });
  it('full width with centered tick when min==max', () => {
    expect(rangeBar({ min: 5, max: 5, value: 5 })).toEqual({ left: 0, right: 0, avgPct: 50 });
  });
  it('null when bounds missing', () => {
    expect(rangeBar({ min: null, max: 1, value: 1 })).toBeNull();
  });
});

describe('spanBar', () => {
  it('returns span ms or null', () => {
    expect(spanBar('2020-01-01', '2021-01-01')!.ms).toBeGreaterThan(0);
    expect(spanBar(null, '2021-01-01')).toBeNull();
  });
});
