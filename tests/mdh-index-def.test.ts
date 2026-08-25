import { describe, it, expect } from 'vitest';
import {
  toCreateIndexDefinition,
  classifyIndexType,
  redundantIndexNames,
  formatBytes,
} from '../src/mdh/indexDef.js';

describe('toCreateIndexDefinition', () => {
  it('turns the real listed sample into a clean create-ready definition', () => {
    // Verbatim from a live /indexes/list response (a customer dev org, PRODUCTS).
    expect(toCreateIndexDefinition({ v: 2, key: { ALT1: 1 }, name: 'products_alt1_idx' }))
      .toEqual({ indexName: 'products_alt1_idx', keys: { ALT1: 1 } });
  });

  it('nests option siblings under options', () => {
    expect(toCreateIndexDefinition({
      v: 2, key: { email: 1 }, name: 'email_1', unique: true, sparse: true,
    })).toEqual({
      indexName: 'email_1', keys: { email: 1 }, options: { unique: true, sparse: true },
    });
  });

  it('omits the options key entirely when there are no options', () => {
    const out = toCreateIndexDefinition({ v: 2, key: { _id: 1 }, name: '_id_' });
    expect(out).toEqual({ indexName: '_id_', keys: { _id: 1 } });
    expect(out).not.toHaveProperty('options');
  });

  it('drops output-only v/ns while keeping real options', () => {
    const out = toCreateIndexDefinition({ v: 2, key: { a: 1 }, name: 'a_1', ns: 'db.coll', unique: true });
    expect(out).toEqual({ indexName: 'a_1', keys: { a: 1 }, options: { unique: true } });
  });

  it('rebuilds a text index key from weights so it can be recreated', () => {
    // listIndexes returns the internal { _fts, _ftsx } key; real fields are in weights.
    const out = toCreateIndexDefinition({
      v: 2, key: { _fts: 'text', _ftsx: 1 }, name: 'desc_text', ns: 'db.coll',
      textIndexVersion: 3, weights: { desc: 1 }, default_language: 'english',
    })!;
    expect(out.keys).toEqual({ desc: 'text' });
    expect(out.keys).not.toHaveProperty('_fts');
    expect(out.keys).not.toHaveProperty('_ftsx');
    expect(out.options).toEqual({ weights: { desc: 1 }, default_language: 'english' });
    expect(out.options).not.toHaveProperty('textIndexVersion');
  });

  it('rebuilds a compound text index, preserving non-text key components and order', () => {
    const out = toCreateIndexDefinition({
      v: 2, key: { tenant: 1, _fts: 'text', _ftsx: 1 }, name: 'tenant_text', weights: { desc: 1, title: 2 },
    });
    expect(out!.keys).toEqual({ tenant: 1, desc: 'text', title: 'text' });
  });

  it('returns non-object input unchanged', () => {
    expect(toCreateIndexDefinition(null)).toBe(null);
    expect(toCreateIndexDefinition('x')).toBe('x');
  });
});

describe('classifyIndexType', () => {
  it('classifies single, compound, text, hashed, 2dsphere, wildcard', () => {
    expect(classifyIndexType({ a: 1 })).toBe('single');
    expect(classifyIndexType({ a: 1, b: -1 })).toBe('compound');
    expect(classifyIndexType({ _fts: 'text', _ftsx: 1 })).toBe('text');
    expect(classifyIndexType({ a: 'hashed' })).toBe('hashed');
    expect(classifyIndexType({ loc: '2dsphere' })).toBe('2dsphere');
    expect(classifyIndexType({ loc: '2d' })).toBe('2d');
    expect(classifyIndexType({ '$**': 1 })).toBe('wildcard');
    expect(classifyIndexType({ 'a.$**': 1 })).toBe('wildcard');
  });

  it('returns null for a missing/invalid key', () => {
    expect(classifyIndexType(null)).toBe(null);
    expect(classifyIndexType('x')).toBe(null);
  });
});

describe('redundantIndexNames', () => {
  it('flags a plain index whose key is a strict prefix of another', () => {
    const out = redundantIndexNames([
      { key: { a: 1 }, name: 'a_1' },
      { key: { a: 1, b: 1 }, name: 'a_1_b_1' },
    ]);
    expect([...out]).toEqual(['a_1']);
  });

  it('never flags the _id_ index', () => {
    const out = redundantIndexNames([
      { key: { _id: 1 }, name: '_id_' },
      { key: { _id: 1, x: 1 }, name: '_id_1_x_1' },
    ]);
    expect(out.has('_id_')).toBe(false);
  });

  it('does not flag a constraint-bearing prefix (unique/sparse/partial/TTL)', () => {
    const out = redundantIndexNames([
      { key: { a: 1 }, name: 'a_unique', unique: true },
      { key: { a: 1, b: 1 }, name: 'a_1_b_1' },
    ]);
    expect(out.has('a_unique')).toBe(false);
  });

  it('does not treat a direction mismatch as a prefix', () => {
    const out = redundantIndexNames([
      { key: { a: -1 }, name: 'a_desc' },
      { key: { a: 1, b: 1 }, name: 'a_1_b_1' },
    ]);
    expect(out.size).toBe(0);
  });

  it('does not flag an equal-length or non-prefix index', () => {
    const out = redundantIndexNames([
      { key: { a: 1 }, name: 'a_1' },
      { key: { b: 1 }, name: 'b_1' },
    ]);
    expect(out.size).toBe(0);
  });

  it('does not flag when the only superset is partial/sparse/collation/hidden (does not fully cover)', () => {
    for (const opt of [
      { partialFilterExpression: { archived: false } },
      { sparse: true },
      { collation: { locale: 'en' } },
      { hidden: true },
    ]) {
      const out = redundantIndexNames([
        { key: { a: 1 }, name: 'a_1' },
        { key: { a: 1, b: 1 }, name: 'superset', ...opt },
      ]);
      expect(out.has('a_1'), `superset ${JSON.stringify(opt)} should not make a_1 redundant`).toBe(false);
    }
  });

  it('still flags when the superset is unique (uniqueness does not restrict read coverage)', () => {
    const out = redundantIndexNames([
      { key: { a: 1 }, name: 'a_1' },
      { key: { a: 1, b: 1 }, name: 'superset', unique: true },
    ]);
    expect(out.has('a_1')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats bytes/KB/MB/GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(913408)).toBe('892 KB');
    expect(formatBytes(303104)).toBe('296 KB');
    expect(formatBytes(1216512)).toBe('1.16 MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.00 GB');
  });

  it('returns empty string for null/NaN', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(Infinity)).toBe('');
  });
});
