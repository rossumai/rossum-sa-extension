import { describe, it, expect } from 'vitest';
import { deriveColumns } from '../src/mdh/recordColumns.js';

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
