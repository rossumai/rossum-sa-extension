import { describe, it, expect } from 'vitest';
import { deriveColumns, orderExportColumns } from '../src/mdh/recordColumns.js';

describe('deriveColumns', () => {
  it('returns [] for no records', () => {
    expect(deriveColumns([])).toEqual([]);
  });
  it('puts _id first, then first-seen order, unioned across docs', () => {
    const cols = deriveColumns([
      { name: 'a', _id: '1', price: 10 },
      { name: 'b', _id: '2', sku: 'x' },
    ]);
    expect(cols).toEqual(['_id', 'name', 'price', 'sku']);
  });
  it('omits _id when absent', () => {
    expect(deriveColumns([{ a: 1 }, { b: 2 }])).toEqual(['a', 'b']);
  });
});

describe('orderExportColumns', () => {
  it('matches the Table-view order for the loaded page (_id first, then first-seen)', () => {
    const loaded = [
      { name: 'a', _id: '1', price: 10 },
      { name: 'b', _id: '2', sku: 'x' },
    ];
    const discovered = ['price', '_id', 'name', 'sku']; // discovery order is arbitrary ($addToSet)
    expect(orderExportColumns(loaded, discovered)).toEqual(['_id', 'name', 'price', 'sku']);
  });
  it('appends fields found only in off-page docs after the table columns, alphabetically', () => {
    const loaded = [{ _id: '1', name: 'a' }]; // current page shows _id, name
    const discovered = ['name', '_id', 'zeta', 'alpha']; // zeta/alpha live only in off-page docs
    expect(orderExportColumns(loaded, discovered)).toEqual(['_id', 'name', 'alpha', 'zeta']);
  });
  it('drops loaded-only keys that are not in the export result set', () => {
    const loaded = [{ _id: '1', computed: 9, name: 'a' }]; // `computed` not in the exported docs
    const discovered = ['_id', 'name'];
    expect(orderExportColumns(loaded, discovered)).toEqual(['_id', 'name']);
  });
  it('falls back to discovered order (sorted) when no records are loaded', () => {
    expect(orderExportColumns([], ['name', '_id', 'amount'])).toEqual(['_id', 'amount', 'name']);
  });
});

describe('orderExportColumns with leaf paths', () => {
  it('groups leaves under their parent, in the table column order', () => {
    const loaded = [{ _id: '1', name: 'a', address: { city: 'X' } }];
    const discovered = ['address.line', '_id', 'address.city', 'name'];
    expect(orderExportColumns(loaded, discovered)).toEqual([
      '_id',
      'name',
      'address.city',
      'address.line',
    ]);
  });

  it('appends leaves whose parent is not in the table, alphabetically', () => {
    const loaded = [{ _id: '1', name: 'a' }];
    const discovered = ['zeta.b', '_id', 'name', 'alpha.a'];
    expect(orderExportColumns(loaded, discovered)).toEqual(['_id', 'name', 'alpha.a', 'zeta.b']);
  });

  it('groups by the DECODED first segment, so a literal dotted key is its own root', () => {
    const loaded = [{ 'a.b': 1, a: { c: 2 } }];
    expect(orderExportColumns(loaded, ['a.c', 'a\\.b'])).toEqual(['a\\.b', 'a.c']);
  });
});
