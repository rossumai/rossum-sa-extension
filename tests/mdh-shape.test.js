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
  it('walks nested paths, treats arrays as leaves, and detects all fields are required', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10, meta: { active: true }, tags: ['x'] },
      { sku: 'B2', price: 20, meta: { active: false }, tags: [] },
    ]);
    expect([...s.paths.keys()].sort()).toEqual(['meta.active', 'price', 'sku', 'tags']);
    expect(s.paths.get('price')).toEqual(new Set(['number']));
    expect(s.paths.get('tags')).toEqual(new Set(['array']));
    expect(s.optionalPaths).toEqual([]);
  });

  it('detects optional fields and mixed types', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10 },
      { sku: 'B2', price: '20', note: 'hi' },
    ]);
    expect(s.optionalPaths.length).toBeGreaterThan(0);
    expect(s.optionalPaths).toContain('note');
    expect(s.paths.get('price')).toEqual(new Set(['number', 'string']));
  });

  it('treats a nullable field (type ∪ null) as required (null never over-rejects)', () => {
    const s = deriveShape([
      { code: 'A', tax: 'V1' },
      { code: 'B', tax: null },   // nullable column — present everywhere, sometimes null
      { code: 'C', tax: 'V2' },
    ]);
    expect(s.paths.get('tax')).toEqual(new Set(['string', 'null']));
    expect(s.optionalPaths).toEqual([]); // string|null is present everywhere → not optional
    // Validate that a null value is accepted against a string-typed reference
    const r1 = validateAgainstShape([{ code: 'D', tax: null }], s);
    expect(r1.ok).toBe(true); // null is compatible with string|null shape
    // And validate that a string is accepted against a nullable reference
    const r2 = validateAgainstShape([{ code: 'E', tax: 'V3' }], s);
    expect(r2.ok).toBe(true); // string is compatible with string|null shape
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

describe('validateAgainstShape — missingTypes / unknownTypes (additive)', () => {
  it('reports the collection type for a missing path', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, meta: { active: true } }]);
    const r = validateAgainstShape([{ sku: 'B2', price: 20 }], shape);
    expect(r.missing).toContain('meta.active');
    expect(r.missingTypes.get('meta.active')).toBe('bool');
  });

  it('joins a multi-type reference set with "/"', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: '20' }]);
    const r = validateAgainstShape([{ sku: 'C3' }], shape); // price omitted entirely
    expect(r.missing).toContain('price');
    expect(r.missingTypes.get('price').split('/').sort()).toEqual(['number', 'string']);
  });

  it('reports the file type for an unknown path', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const r = validateAgainstShape([{ sku: 'B2', price: 20, extra: 'hi' }], shape);
    expect(r.unknown).toContain('extra');
    expect(r.unknownTypes.get('extra')).toBe('string');
  });

  it('does not change missing/unknown themselves — still plain string arrays', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }]);
    const r = validateAgainstShape([{ sku: 'B2', price: 20, extra: 'hi' }], shape);
    expect(Array.isArray(r.missing)).toBe(true);
    expect(r.missing.every((p) => typeof p === 'string')).toBe(true);
    expect(Array.isArray(r.unknown)).toBe(true);
    expect(r.unknown.every((p) => typeof p === 'string')).toBe(true);
  });
});

describe('validateAgainstShape — whitespace pairing', () => {
  const ref = deriveShape([{ sku: 'A1', price: 10 }]);

  it('pairs a trailing-space file column with the existing column', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }], ref);
    expect(r.ok).toBe(false);
    expect(r.whitespace).toEqual([{ expected: 'sku', got: 'sku ' }]);
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('pairs a leading-space and an NBSP-edged column', () => {
    const lead = validateAgainstShape([{ ' sku': 'A1', price: 10 }], ref);
    expect(lead.whitespace).toEqual([{ expected: 'sku', got: ' sku' }]);
    const nbsp = validateAgainstShape([{ 'sku\u00A0': 'A1', price: 10 }], ref); // NBSP-edged key, explicit escape
    expect(nbsp.whitespace).toEqual([{ expected: 'sku', got: 'sku\u00A0' }]);
    const tab = validateAgainstShape([{ 'sku\t': 'A1', price: 10 }], ref); // TAB-edged key
    expect(tab.whitespace).toEqual([{ expected: 'sku', got: 'sku\t' }]);
  });

  it('pairs when BOTH sides carry different edge whitespace', () => {
    const refWs = deriveShape([{ 'sku ': 'A1' }]);
    const r = validateAgainstShape([{ ' sku': 'A1' }], refWs);
    expect(r.whitespace).toEqual([{ expected: 'sku ', got: ' sku' }]);
  });

  it('pairs nested path segments (a. b vs a.b)', () => {
    const nested = deriveShape([{ a: { b: 1 } }]);
    const r = validateAgainstShape([{ a: { ' b': 1 } }], nested);
    expect(r.whitespace).toEqual([{ expected: 'a.b', got: 'a. b' }]);
  });

  it('pairs multiple file variants of one existing field', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }, { ' sku': 'B2', price: 20 }], ref);
    expect(r.whitespace).toEqual(expect.arrayContaining([
      { expected: 'sku', got: 'sku ' },
      { expected: 'sku', got: ' sku' },
    ]));
    expect(r.unknown).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('a genuine rename stays missing+unknown, not whitespace', () => {
    const r = validateAgainstShape([{ item: 'A1', price: 10 }], ref);
    expect(r.whitespace).toEqual([]);
    expect(r.missing).toEqual(['sku']);
    expect(r.unknown).toEqual(['item']);
  });

  it('failedDocCount still counts whitespace-failing docs', () => {
    const r = validateAgainstShape([{ 'sku ': 'A1', price: 10 }, { sku: 'B2', price: 20 }], ref);
    expect(r.failedDocCount).toBe(1);
  });
});

describe('optional paths are not required (spec §2.4)', () => {
  it('a row missing a field that only some existing records carry is NOT missing', () => {
    const shape = deriveShape([{ sku: 'A1', note: 'x' }, { sku: 'B2' }]); // note is optional
    const r = validateAgainstShape([{ sku: 'C3' }], shape);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('a field present in EVERY existing record is still required', () => {
    const shape = deriveShape([{ sku: 'A1', note: 'x' }, { sku: 'B2', note: 'y' }]);
    const r = validateAgainstShape([{ sku: 'C3' }], shape);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['note']);
  });

  it('an optional path still type-checks when the row DOES carry it', () => {
    const shape = deriveShape([{ sku: 'A1', n: 1 }, { sku: 'B2' }]);
    expect(validateAgainstShape([{ sku: 'C3', n: 'not-a-number' }], shape).ok).toBe(false);
  });
});

describe('path grammar (spec §4.2)', () => {
  it('tells a literal dotted key apart from real nesting', () => {
    const nested = deriveShape([{ a: { b: 1 } }]);
    const literal = deriveShape([{ 'a.b': 1 }]);
    expect([...nested.paths.keys()]).toEqual(['a.b']);
    expect([...literal.paths.keys()]).toEqual(['a\\.b']);
    expect(validateAgainstShape([{ 'a.b': 1 }], nested).ok).toBe(false);
    expect(validateAgainstShape([{ a: { b: 1 } }], literal).ok).toBe(false);
  });
});
