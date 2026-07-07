import { describe, it, expect } from 'vitest';
import { foldBsonType, transformTypeBuckets } from '../src/mdh/fieldTypes.js';
import { deriveResolvedType } from '../src/mdh/fieldTypes.js';

describe('foldBsonType', () => {
  it('folds numeric subtypes to number, others to category/other', () => {
    expect(['int', 'long', 'double', 'decimal'].map(foldBsonType)).toEqual(['number', 'number', 'number', 'number']);
    expect(foldBsonType('string')).toBe('string');
    expect(foldBsonType('bool')).toBe('boolean');
    expect(foldBsonType('null')).toBe('null');
    expect(['date', 'objectId', 'array', 'object'].map(foldBsonType)).toEqual(['other', 'other', 'other', 'other']);
  });
});

describe('transformTypeBuckets', () => {
  it('single-type field', () => {
    const info = transformTypeBuckets([{ _id: 'string', count: 10 }]);
    expect(info.dominant).toBe('string');
    expect(info.mixed).toBe(false);
    expect(info.share).toBe(1);
  });
  it('mixed field picks the dominant category with a share', () => {
    const info = transformTypeBuckets([{ _id: 'string', count: 8 }, { _id: 'int', count: 2 }]);
    expect(info.dominant).toBe('string');
    expect(info.mixed).toBe(true);
    expect(info.share).toBeCloseTo(0.8);
  });
  it('two numeric subtypes are one category (not mixed)', () => {
    const info = transformTypeBuckets([{ _id: 'int', count: 5 }, { _id: 'long', count: 5 }]);
    expect(info.dominant).toBe('number');
    expect(info.mixed).toBe(false);
  });
  it('count tie prefers string', () => {
    expect(transformTypeBuckets([{ _id: 'int', count: 5 }, { _id: 'string', count: 5 }]).dominant).toBe('string');
  });
  it('excludes the missing bucket', () => {
    const info = transformTypeBuckets([{ _id: 'missing', count: 90 }, { _id: 'string', count: 10 }]);
    expect(info.dominant).toBe('string');
    expect(info.share).toBe(1);
  });
  it('no real data → null', () => {
    expect(transformTypeBuckets([{ _id: 'missing', count: 5 }])).toBeNull();
    expect(transformTypeBuckets([])).toBeNull();
  });
  it('detected non-primitive surfaces via dominantBson', () => {
    const info = transformTypeBuckets([{ _id: 'objectId', count: 7 }]);
    expect(info.dominant).toBe('other');
    expect(info.dominantBson).toBe('objectId');
  });
});

describe('deriveResolvedType', () => {
  const strInfo = { dominant: 'string', dominantBson: 'string', share: 1, distribution: [], mixed: false };
  // fieldTypeInfo is a single FieldTypeInfo (or null/undefined) for the resolved
  // (collection, field) pair — the caller looks it up, deriveResolvedType no
  // longer takes the whole per-collection map.
  const base = { override: undefined, fieldMap: { code: { field: 'code', op: '$eq' } }, fieldTypeInfo: strInfo, parsedOk: true };
  it('uses the dataset field type', () => {
    expect(deriveResolvedType('code', base)).toMatchObject({ type: 'string', source: 'field' });
  });
  it('override beats dataset', () => {
    expect(deriveResolvedType('code', { ...base, override: 'number' })).toMatchObject({ type: 'number', source: 'override' });
  });
  it('mixed field marks source mixed', () => {
    const mixed = { ...strInfo, mixed: true, share: 0.82 };
    expect(deriveResolvedType('code', { ...base, fieldTypeInfo: mixed })).toMatchObject({ type: 'string', source: 'mixed' });
  });
  it('invalid pipeline → invalid (value-based)', () => {
    expect(deriveResolvedType('code', { ...base, parsedOk: false })).toEqual({ type: undefined, source: 'invalid' });
  });
  it('no field → no-field', () => {
    expect(deriveResolvedType('x', base)).toEqual({ type: undefined, source: 'no-field' });
  });
  it('ambiguous → ambiguous', () => {
    expect(deriveResolvedType('x', { ...base, fieldMap: { x: { ambiguous: true } } })).toEqual({ type: undefined, source: 'ambiguous' });
  });
  it('field type not yet resolved → detecting', () => {
    expect(deriveResolvedType('code', { ...base, fieldTypeInfo: undefined })).toMatchObject({ type: undefined, source: 'detecting' });
  });
  it('null field info → no-data (value-based)', () => {
    expect(deriveResolvedType('code', { ...base, fieldTypeInfo: null })).toMatchObject({ type: undefined, source: 'no-data' });
  });
  it('non-primitive dominant → other (value-based) with detected bson', () => {
    const oid = { dominant: 'other', dominantBson: 'objectId', share: 1, distribution: [], mixed: false };
    expect(deriveResolvedType('code', { ...base, fieldTypeInfo: oid })).toMatchObject({ type: undefined, source: 'other', detectedBson: 'objectId' });
  });
});

describe('deriveResolvedType — fieldTypeInfo arg', () => {
  const fieldMap = { cust: { field: 'customer_match', collection: '_PROD_material_match', op: '$eq' } };

  it('uses the passed field type info (string wins over numeric-looking value)', () => {
    const info = { dominant: 'string', dominantBson: 'string', share: 1, mixed: false };
    expect(deriveResolvedType('cust', { override: undefined, fieldMap, fieldTypeInfo: info, parsedOk: true }))
      .toMatchObject({ type: 'string', source: 'field' });
  });

  it('override wins over field info', () => {
    const info = { dominant: 'number', dominantBson: 'int', share: 1, mixed: false };
    expect(deriveResolvedType('cust', { override: 'string', fieldMap, fieldTypeInfo: info, parsedOk: true }))
      .toMatchObject({ type: 'string', source: 'override' });
  });

  it('undefined info → detecting; null info → no-data; unmapped → no-field', () => {
    expect(deriveResolvedType('cust', { fieldMap, fieldTypeInfo: undefined, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'detecting' });
    expect(deriveResolvedType('cust', { fieldMap, fieldTypeInfo: null, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'no-data' });
    expect(deriveResolvedType('nope', { fieldMap, fieldTypeInfo: undefined, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'no-field' });
  });
});
