import { describe, it, expect } from 'vitest';
import { collectFieldPaths, countRowsMissingKeys } from '../src/mdh/importPlan.js';

describe('collectFieldPaths', () => {
  it('flattens nested leaf paths, _id first, arrays and EJSON as leaves', () => {
    const docs = [
      {
        _id: { $oid: 'a'.repeat(24) },
        sku: 'A',
        address: { zip: '1', geo: { lat: 1 } },
        tags: [1, 2],
      },
      { _id: { $oid: 'b'.repeat(24) }, sku: 'B', vendor: { id: 9 } },
    ];
    const paths = collectFieldPaths(docs);
    expect(paths[0]).toBe('_id');
    expect(paths).toContain('sku');
    expect(paths).toContain('address.zip');
    expect(paths).toContain('address.geo.lat');
    expect(paths).toContain('vendor.id');
    expect(paths).toContain('tags');
    expect(paths).not.toContain('tags.0');
    expect(paths.some((p) => p.startsWith('_id.'))).toBe(false);
  });
  it('respects maxDepth', () => {
    const docs = [{ a: { b: { c: { d: 1 } } } }];
    expect(collectFieldPaths(docs, { maxDepth: 2 })).toContain('a.b');
  });
});

describe('countRowsMissingKeys', () => {
  it('counts rows lacking a top-level key', () => {
    expect(countRowsMissingKeys([{ sku: 'A' }, { name: 'x' }, { sku: null }], ['sku'])).toBe(1);
  });
  it('null key values count as present (server accepts them)', () => {
    expect(countRowsMissingKeys([{ sku: null }], ['sku'])).toBe(0);
  });
  it('requires ALL keys per row', () => {
    expect(
      countRowsMissingKeys([{ sku: 'A', region: 'EU' }, { sku: 'B' }], ['sku', 'region']),
    ).toBe(1);
  });
  it('walks dotted paths without traversing arrays', () => {
    expect(countRowsMissingKeys([{ sku: { code: 'X' } }], ['sku.code'])).toBe(0);
    expect(countRowsMissingKeys([{ sku: ['X'] }], ['sku.0'])).toBe(1);
    expect(countRowsMissingKeys([{ sku: 'plain' }], ['sku.code'])).toBe(1);
  });
  it('non-object rows are missing everything; empty keys count nothing', () => {
    expect(countRowsMissingKeys([null, 42, [1]], ['sku'])).toBe(3);
    expect(countRowsMissingKeys([{ sku: 'A' }], [])).toBe(0);
  });
});
