import { describe, it, expect } from 'vitest';
import {
  discoverFields,
  encKey,
  buildFieldCoveragePipeline,
  buildEmptyValuesPipeline,
  buildTypePipeline,
  buildValueDistributionPipeline,
  buildCardinalityPipeline,
  buildStringAnalysisPipeline,
  buildNumericStatsPipeline,
  buildDateRangePipeline,
  buildSchemaConsistencyPipeline,
  buildOverviewPipeline,
  buildAllPipelines,
  MAX_FIELDS,
  TOP_VALUES,
} from '../src/mdh/statsPipelines.js';

describe('field discovery', () => {
  it('extracts top-level fields, excludes _id', () => {
    const docs = [
      { _id: '1', name: 'Alice', age: 30 },
      { _id: '2', name: 'Bob', email: 'bob@test.com' },
    ];
    const fields = discoverFields(docs);
    expect(fields).toEqual(['age', 'email', 'name']);
  });

  it('discovers nested field paths with dot notation', () => {
    const docs = [{ address: { city: 'NYC', zip: '10001' } }];
    expect(discoverFields(docs)).toEqual(['address.city', 'address.zip']);
  });

  it('treats BSON types ($oid, $date) as leaf values', () => {
    const docs = [{
      created: { $date: '2024-01-01' },
      ref: { $oid: '507f1f77' },
      name: 'test',
    }];
    const fields = discoverFields(docs);
    expect(fields).toContain('name');
    expect(fields).toContain('created');
    expect(fields).toContain('ref');
    expect(fields).not.toContain('created.$date');
    expect(fields).not.toContain('ref.$oid');
  });

  it('treats arrays as leaf values', () => {
    const docs = [{ tags: ['a', 'b'], name: 'test' }];
    const fields = discoverFields(docs);
    expect(fields).toContain('tags');
    expect(fields).toContain('name');
  });

  it('truncates to MAX_FIELDS', () => {
    const doc = {};
    for (let i = 0; i < 60; i++) doc[`field_${String(i).padStart(3, '0')}`] = i;
    const fields = discoverFields([doc]);
    expect(fields).toHaveLength(MAX_FIELDS);
  });

  it('returns sorted field names', () => {
    const docs = [{ z: 1, a: 2, m: 3 }];
    expect(discoverFields(docs)).toEqual(['a', 'm', 'z']);
  });

  it('merges fields across multiple documents', () => {
    const docs = [{ a: 1 }, { b: 2 }, { a: 3, c: 4 }];
    expect(discoverFields(docs)).toEqual(['a', 'b', 'c']);
  });

  it('removes parent fields when child paths exist to avoid $project collisions', () => {
    // Simulates mixed documents: some have line_items as array, others as object
    const docs = [
      { line_items: [{ item_amount: 10 }], contract_number: 'C1' },
      { line_items: { item_amount: 20, item_description: 'Widget' }, contract_number: 'C2' },
    ];
    const fields = discoverFields(docs);
    // "line_items" parent should be removed since child paths exist
    expect(fields).not.toContain('line_items');
    expect(fields).toContain('line_items.item_amount');
    expect(fields).toContain('line_items.item_description');
    expect(fields).toContain('contract_number');
  });
});

describe('encKey', () => {
  it('replaces dots with __DOT__', () => {
    expect(encKey('a.b.c')).toBe('a__DOT__b__DOT__c');
  });

  it('leaves dot-free keys unchanged', () => {
    expect(encKey('simple')).toBe('simple');
  });
});

describe('pipeline builders', () => {
  const fields = ['name', 'address.city', 'count'];

  it('buildOverviewPipeline returns $collStats count', () => {
    expect(buildOverviewPipeline()).toEqual([
      { $collStats: { count: {} } },
      { $project: { host: 0, localTime: 0 } },
      { $limit: 1 },
    ]);
  });

  it('buildFieldCoveragePipeline produces $project + $group', () => {
    const p = buildFieldCoveragePipeline(fields);
    expect(p).toHaveLength(2);
    expect(p[0]).toHaveProperty('$project');
    expect(p[0].$project._id).toBe(0);
    expect(p[1].$group._id).toBeNull();
    expect(p[1].$group._total).toEqual({ $sum: 1 });
    expect(p[1].$group).toHaveProperty('f_name');
    expect(p[1].$group).toHaveProperty('f_address__DOT__city');
  });

  it('buildEmptyValuesPipeline tracks null, missing, empty per field', () => {
    const p = buildEmptyValuesPipeline(fields);
    expect(p[1].$group).toHaveProperty('null_name');
    expect(p[1].$group).toHaveProperty('missing_name');
    expect(p[1].$group).toHaveProperty('empty_name');
  });

  it('buildTypePipeline uses $facet with encoded keys', () => {
    const p = buildTypePipeline(fields);
    expect(p[1]).toHaveProperty('$facet');
    expect(p[1].$facet).toHaveProperty('name');
    expect(p[1].$facet).toHaveProperty('address__DOT__city');
    expect(p[1].$facet).toHaveProperty('count');
  });

  it('buildValueDistributionPipeline limits to TOP_VALUES', () => {
    const p = buildValueDistributionPipeline(fields);
    const stages = p[1].$facet.name;
    const limitStage = stages.find((s) => s.$limit);
    expect(limitStage.$limit).toBe(TOP_VALUES);
  });

  it('buildCardinalityPipeline counts distinct values', () => {
    const p = buildCardinalityPipeline(fields);
    const stages = p[1].$facet.name;
    expect(stages).toContainEqual({ $count: 'distinct' });
  });

  it('buildStringAnalysisPipeline filters by string type', () => {
    const p = buildStringAnalysisPipeline(fields);
    const stages = p[1].$facet.name;
    expect(stages[0]).toHaveProperty('$match');
  });

  it('buildNumericStatsPipeline computes min/max/avg', () => {
    const p = buildNumericStatsPipeline(fields);
    const group = p[1].$facet.name[1].$group;
    expect(group).toHaveProperty('min');
    expect(group).toHaveProperty('max');
    expect(group).toHaveProperty('avg');
  });

  it('buildDateRangePipeline computes earliest/latest', () => {
    const p = buildDateRangePipeline(fields);
    const group = p[1].$facet.name[1].$group;
    expect(group).toHaveProperty('earliest');
    expect(group).toHaveProperty('latest');
  });

  it('buildSchemaConsistencyPipeline returns valid pipeline', () => {
    const p = buildSchemaConsistencyPipeline();
    expect(p.length).toBeGreaterThan(0);
    expect(p[0].$project).toHaveProperty('_keys');
    expect(p[p.length - 1]).toEqual({ $limit: 20 });
  });

  it('buildAllPipelines returns all 11 pipeline types', () => {
    const all = buildAllPipelines(fields);
    expect(Object.keys(all).sort()).toEqual([
      'cardinality', 'coverage', 'dates', 'distribution', 'docSize',
      'empties', 'numeric', 'schema', 'storage', 'strings', 'types',
    ]);
    for (const pipeline of Object.values(all)) {
      expect(Array.isArray(pipeline)).toBe(true);
      expect(pipeline.length).toBeGreaterThan(0);
    }
  });
});
