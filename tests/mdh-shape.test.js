import { describe, it, expect } from 'vitest';
import { typeOf, deriveShape, validateAgainstShape } from '../src/mdh/shape.js';

describe('typeOf', () => {
  it('maps primitives, arrays, objects, and EJSON', () => {
    expect(typeOf('x')).toBe('string');
    expect(typeOf(3)).toBe('number');
    expect(typeOf(3.5)).toBe('number');
    expect(typeOf(true)).toBe('bool');
    expect(typeOf(null)).toBe('null');
    expect(typeOf([1, 2])).toBe('array');
    expect(typeOf({ a: 1 })).toBe('object');
    expect(typeOf({ $oid: '6a44fe42106e88484ea73b61' })).toBe('objectId');
    expect(typeOf({ $date: '2026-07-01T00:00:00Z' })).toBe('date');
  });
});

describe('deriveShape', () => {
  it('walks nested paths, treats arrays as leaves, and reports uniform', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10, meta: { active: true }, tags: ['x'] },
      { sku: 'B2', price: 20, meta: { active: false }, tags: [] },
    ]);
    expect([...s.paths.keys()].sort()).toEqual(['meta.active', 'price', 'sku', 'tags']);
    expect(s.paths.get('price')).toEqual(new Set(['number']));
    expect(s.paths.get('tags')).toEqual(new Set(['array']));
    expect(s.uniform).toBe(true);
    expect(s.optionalPaths).toEqual([]);
  });

  it('flags non-uniform when a field is optional or has mixed types', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10 },
      { sku: 'B2', price: '20', note: 'hi' },
    ]);
    expect(s.uniform).toBe(false);
    expect(s.optionalPaths).toContain('note');
    expect(s.paths.get('price')).toEqual(new Set(['number', 'string']));
  });

  it('treats a nullable field (type ∪ null) as still uniform (null never over-rejects)', () => {
    const s = deriveShape([
      { code: 'A', tax: 'V1' },
      { code: 'B', tax: null },   // nullable column — present everywhere, sometimes null
      { code: 'C', tax: 'V2' },
    ]);
    expect(s.paths.get('tax')).toEqual(new Set(['string', 'null']));
    expect(s.optionalPaths).toEqual([]); // present in every doc
    expect(s.uniform).toBe(true);        // string|null is NOT a real clash → no false warning
  });
});

describe('validateAgainstShape', () => {
  const shape = deriveShape([{ sku: 'A1', price: 10, meta: { active: true } }]);

  it('passes when every doc has exactly the reference fields and types', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: false } }], shape);
    expect(r.ok).toBe(true);
    expect(r.failedDocCount).toBe(0);
  });

  it('fails on a missing field', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20 }], shape);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('meta.active');
    expect(r.failedDocCount).toBe(1);
  });

  it('fails on an unknown field', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: true }, extra: 1 }], shape);
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('extra');
  });

  it('fails on a type conflict', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: '20', meta: { active: true } }], shape);
    expect(r.ok).toBe(false);
    expect(r.typeMismatch.map((t) => t.path)).toContain('price');
  });

  it('treats null as compatible in both directions', () => {
    const r1 = validateAgainstShape([{ sku: 'B2', price: null, meta: { active: true } }], shape);
    expect(r1.ok).toBe(true);
    const nullShape = deriveShape([{ sku: 'A1', price: null, meta: { active: true } }]);
    const r2 = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: false } }], nullShape);
    expect(r2.ok).toBe(true);
  });
});
