import { describe, it, expect, beforeEach } from 'vitest';
import { computeHealthScore, healthLabel, transformStatsResults, updateStatsSummary } from '../src/mdh/statsSummary.js';
import { encKey } from '../src/mdh/statsPipelines.js';
import * as cache from '../src/mdh/cache.js';
import { statsSummary } from '../src/mdh/store.js';

describe('computeHealthScore', () => {
  const fields = ['a', 'b', 'c', 'd'];
  const perfectCoverage = fields.map((f) => ({ field: f, present: 100, total: 100, pct: 100 }));

  it('returns null when fields is empty', () => {
    expect(computeHealthScore(perfectCoverage, [], [], [], [], [])).toBeNull();
  });

  it('returns null when coverage is missing', () => {
    expect(computeHealthScore(null, [], [], [], [], fields)).toBeNull();
  });

  it('returns 100 for a perfectly clean collection', () => {
    const strings = fields.map((f) => ({ field: f, count: 10, leading: 0, trailing: 0 }));
    expect(computeHealthScore(perfectCoverage, [], [], strings, [{ fieldCount: 4 }], fields)).toBe(100);
  });

  it('penalizes lowered field coverage', () => {
    const coverage = [
      { field: 'a', pct: 50 },
      { field: 'b', pct: 100 },
      { field: 'c', pct: 100 },
      { field: 'd', pct: 100 },
    ];
    // avgCoverage = 87.5, typeScore = 100, emptinessScore = 100, wsScore = 100, schemaScore = 100
    // score = 87.5 * 0.25 + 100 * 0.20 + 100 * 0.15 + 100 * 0.20 + 100 * 0.20 = 96.875 → rounds to 97
    expect(computeHealthScore(coverage, [], [], [], [{ fieldCount: 4 }], fields)).toBe(97);
  });

  it('penalizes multiple schema shapes', () => {
    // Two shapes → schemaScore = 100 - (2-1) * 20 = 80
    // score = 100 * 0.25 + 100 * 0.20 + 100 * 0.15 + 100 * 0.20 + 80 * 0.20 = 96
    const shapes = [{ fieldCount: 4 }, { fieldCount: 3 }];
    expect(computeHealthScore(perfectCoverage, [], [], [], shapes, fields)).toBe(96);
  });

  it('penalizes type inconsistency per field', () => {
    // 1 of 4 fields inconsistent → typeScore = 75
    // score = 100 * 0.25 + 75 * 0.20 + 100 * 0.15 + 100 * 0.20 + 100 * 0.20 = 95
    const types = [{ field: 'a', types: [{ _id: 'string', count: 5 }, { _id: 'int', count: 5 }] }];
    expect(computeHealthScore(perfectCoverage, [], types, [], [{ fieldCount: 4 }], fields)).toBe(95);
  });

  it('penalizes empties per field', () => {
    // 1 of 4 fields has empties → emptinessScore = 75
    // score = 100 * 0.25 + 100 * 0.20 + 75 * 0.15 + 100 * 0.20 + 100 * 0.20
    //       = 25 + 20 + 11.25 + 20 + 20 = 96.25 → rounds to 96
    const empties = [{ field: 'a', nullCount: 5, missingCount: 0, emptyCount: 0 }];
    expect(computeHealthScore(perfectCoverage, empties, [], [], [{ fieldCount: 4 }], fields)).toBe(96);
  });

  it('whitespace score is 100 when there are no string fields', () => {
    // strings array is all count=0 → stringFields = 0 → wsScore = 100
    const strings = fields.map((f) => ({ field: f, count: 0, leading: 0, trailing: 0 }));
    expect(computeHealthScore(perfectCoverage, [], [], strings, [{ fieldCount: 4 }], fields)).toBe(100);
  });
});

describe('healthLabel', () => {
  it('returns Excellent at 90+', () => {
    expect(healthLabel(100)).toBe('Excellent');
    expect(healthLabel(90)).toBe('Excellent');
  });
  it('returns Good at 75-89', () => {
    expect(healthLabel(89)).toBe('Good');
    expect(healthLabel(75)).toBe('Good');
  });
  it('returns Fair at 50-74', () => {
    expect(healthLabel(74)).toBe('Fair');
    expect(healthLabel(50)).toBe('Fair');
  });
  it('returns Poor below 50', () => {
    expect(healthLabel(49)).toBe('Poor');
    expect(healthLabel(0)).toBe('Poor');
  });
});

describe('transformStatsResults', () => {
  const fields = ['name', 'age'];

  it('builds coverage array with pct floored', () => {
    const raw = {
      coverage: { result: [{ _total: 200, [`f_${encKey('name')}`]: 150, [`f_${encKey('age')}`]: 199 }] },
      empties: { result: [{}] },
      types: { result: [{}] },
      strings: { result: [{}] },
      schema: { result: [] },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.coverage).toEqual([
      { field: 'name', present: 150, total: 200, pct: 75 },
      { field: 'age', present: 199, total: 200, pct: 99 },
    ]);
  });

  it('filters empties to only fields with nonzero null/missing/empty', () => {
    const raw = {
      coverage: { result: [{ _total: 10 }] },
      empties: {
        result: [{
          [`null_${encKey('name')}`]: 0,
          [`missing_${encKey('name')}`]: 0,
          [`empty_${encKey('name')}`]: 0,
          [`null_${encKey('age')}`]: 2,
          [`missing_${encKey('age')}`]: 1,
          [`empty_${encKey('age')}`]: 0,
        }],
      },
      types: { result: [{}] },
      strings: { result: [{}] },
      schema: { result: [] },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.empties).toEqual([
      { field: 'age', nullCount: 2, missingCount: 1, emptyCount: 0 },
    ]);
  });

  it('filters types to only fields with multiple types, excluding missing', () => {
    const raw = {
      coverage: { result: [{ _total: 10 }] },
      empties: { result: [{}] },
      types: {
        result: [{
          [encKey('name')]: [{ _id: 'string', count: 10 }],
          [encKey('age')]: [
            { _id: 'int', count: 5 },
            { _id: 'string', count: 3 },
            { _id: 'missing', count: 2 },
          ],
        }],
      },
      strings: { result: [{}] },
      schema: { result: [] },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.types).toEqual([
      {
        field: 'age',
        types: [
          { _id: 'int', count: 5 },
          { _id: 'string', count: 3 },
        ],
      },
    ]);
  });

  it('filters strings to only fields with count > 0 and rounds avgLen', () => {
    const raw = {
      coverage: { result: [{ _total: 10 }] },
      empties: { result: [{}] },
      types: { result: [{}] },
      strings: {
        result: [{
          [encKey('name')]: [{ count: 8, minLen: 3, maxLen: 12, avgLen: 7.6, leading: 1, trailing: 0 }],
          [encKey('age')]: [],
        }],
      },
      schema: { result: [] },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.strings).toEqual([
      { field: 'name', count: 8, minLen: 3, maxLen: 12, avgLen: 8, leading: 1, trailing: 0 },
    ]);
  });

  it('maps schema shapes and strips _id from sampleFields', () => {
    const raw = {
      coverage: { result: [{ _total: 10 }] },
      empties: { result: [{}] },
      types: { result: [{}] },
      strings: { result: [{}] },
      schema: {
        result: [
          { _id: 3, count: 100, sampleFields: ['_id', 'name', 'age'] },
          { _id: 2, count: 5, sampleFields: ['_id', 'name'] },
        ],
      },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.schemaShapes).toEqual([
      { fieldCount: 3, docCount: 100, sampleFields: ['age', 'name'] },
      { fieldCount: 2, docCount: 5, sampleFields: ['name'] },
    ]);
  });

  it('returns null for each piece whose raw input is missing', () => {
    // Simulates a partial failure where `types` errored during prefetch
    // but other checks succeeded. Consumers render the resolved pieces
    // and skip the null ones.
    const raw = {
      coverage: { result: [{ _total: 10, [`f_${encKey('name')}`]: 10, [`f_${encKey('age')}`]: 10 }] },
      empties: { result: [{}] },
      types: null,
      strings: { result: [{}] },
      schema: { result: [{ _id: 2, count: 10, sampleFields: ['name', 'age'] }] },
    };
    const out = transformStatsResults(raw, fields);
    expect(out.coverage).not.toBeNull();
    expect(out.empties).not.toBeNull();
    expect(out.types).toBeNull();
    expect(out.strings).not.toBeNull();
    expect(out.schemaShapes).not.toBeNull();
  });
});

describe('updateStatsSummary', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsSummary.value = null;
  });

  function seedCleanCollection(col) {
    cache.set(col, 'statsFields', ['name', 'age']);
    cache.set(col, 'stats_coverage', {
      result: [{ _total: 100, [`f_${encKey('name')}`]: 100, [`f_${encKey('age')}`]: 100 }],
    });
    cache.set(col, 'stats_empties', { result: [{}] });
    cache.set(col, 'stats_types', { result: [{}] });
    cache.set(col, 'stats_strings', {
      result: [{
        [encKey('name')]: [{ count: 100, minLen: 3, maxLen: 20, avgLen: 10, leading: 0, trailing: 0 }],
      }],
    });
    cache.set(col, 'stats_schema', {
      result: [{ _id: 2, count: 100, sampleFields: ['_id', 'name', 'age'] }],
    });
  }

  it('leaves signal null when statsFields is missing', () => {
    updateStatsSummary('col1');
    expect(statsSummary.value).toBeNull();
  });

  it('leaves signal null when any required stats_* entry is missing', () => {
    seedCleanCollection('col1');
    cache.invalidate('col1', 'stats_coverage');
    updateStatsSummary('col1');
    expect(statsSummary.value).toBeNull();
  });

  it('populates signal for a clean collection with health 100', () => {
    seedCleanCollection('col1');
    updateStatsSummary('col1');
    expect(statsSummary.value).toEqual({ collection: 'col1', health: 100, label: 'Excellent' });
  });

  it('populates signal with lower health for a dirty collection', () => {
    const col = 'col2';
    cache.set(col, 'statsFields', ['name', 'age']);
    // Half the rows are missing "age"
    cache.set(col, 'stats_coverage', {
      result: [{ _total: 100, [`f_${encKey('name')}`]: 100, [`f_${encKey('age')}`]: 50 }],
    });
    cache.set(col, 'stats_empties', {
      result: [{
        [`null_${encKey('age')}`]: 50,
        [`missing_${encKey('age')}`]: 0,
        [`empty_${encKey('age')}`]: 0,
      }],
    });
    cache.set(col, 'stats_types', { result: [{}] });
    cache.set(col, 'stats_strings', { result: [{}] });
    cache.set(col, 'stats_schema', {
      result: [{ _id: 2, count: 100, sampleFields: ['name', 'age'] }],
    });
    updateStatsSummary(col);
    // Deterministic from the fixture above:
    //   avgCoverage = (100 + 50) / 2 = 75
    //   emptinessScore = (2 - 1) / 2 * 100 = 50  (age has nulls)
    //   typeScore = 100, wsScore = 100 (no string data), schemaScore = 100
    //   score = 75 * 0.25 + 100 * 0.20 + 50 * 0.15 + 100 * 0.20 + 100 * 0.20
    //         = 18.75 + 20 + 7.5 + 20 + 20 = 86.25 → rounds to 86 → "Good"
    expect(statsSummary.value).toEqual({ collection: col, health: 86, label: 'Good' });
  });

  it('leaves signal null when fields array is empty', () => {
    cache.set('col3', 'statsFields', []);
    updateStatsSummary('col3');
    expect(statsSummary.value).toBeNull();
  });
});
