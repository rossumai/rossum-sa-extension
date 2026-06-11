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
  const base = { override: undefined, fieldMap: { code: { field: 'code', op: '$eq' } }, fieldTypes: { code: strInfo }, parsedOk: true };
  it('uses the dataset field type', () => {
    expect(deriveResolvedType('code', base)).toMatchObject({ type: 'string', source: 'field' });
  });
  it('override beats dataset', () => {
    expect(deriveResolvedType('code', { ...base, override: 'number' })).toMatchObject({ type: 'number', source: 'override' });
  });
  it('mixed field marks source mixed', () => {
    const mixed = { ...strInfo, mixed: true, share: 0.82 };
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: mixed } })).toMatchObject({ type: 'string', source: 'mixed' });
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
    expect(deriveResolvedType('code', { ...base, fieldTypes: {} })).toMatchObject({ type: undefined, source: 'detecting' });
  });
  it('null field info → no-data (value-based)', () => {
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: null } })).toMatchObject({ type: undefined, source: 'no-data' });
  });
  it('non-primitive dominant → other (value-based) with detected bson', () => {
    const oid = { dominant: 'other', dominantBson: 'objectId', share: 1, distribution: [], mixed: false };
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: oid } })).toMatchObject({ type: undefined, source: 'other', detectedBson: 'objectId' });
  });
});
