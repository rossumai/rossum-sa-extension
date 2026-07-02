import { describe, it, expect } from 'vitest';
import { collectFieldPaths } from '../src/mdh/importPlan.js';

describe('collectFieldPaths', () => {
  it('flattens nested leaf paths, _id first, arrays and EJSON as leaves', () => {
    const docs = [
      { _id: { $oid: 'a'.repeat(24) }, sku: 'A', address: { zip: '1', geo: { lat: 1 } }, tags: [1, 2] },
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
