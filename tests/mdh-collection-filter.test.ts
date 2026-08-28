import { describe, it, expect } from 'vitest';
import { filterCollections, splitByMatch } from '../src/mdh/collectionFilter.js';

// Real shape of the problem this exists for: an org whose 90 collections share a
// long prefix, so the distinguishing part sits in the middle or at the end.
const NAMES = [
  'wc_po_eurofins_dev',
  'wc_po_eurofins_uat',
  'wc_supplier_eurofins_dev',
  'wc_supplier_eurofins_uat',
  'wc_supplier_master',
];

describe('filterCollections', () => {
  it('returns every name for an empty or whitespace-only query', () => {
    expect(filterCollections(NAMES, '')).toEqual(NAMES);
    expect(filterCollections(NAMES, '   ')).toEqual(NAMES);
  });

  it('keeps the names containing the query as a substring, in the given order', () => {
    expect(filterCollections(NAMES, 'supplier')).toEqual([
      'wc_supplier_eurofins_dev',
      'wc_supplier_eurofins_uat',
      'wc_supplier_master',
    ]);
  });

  it('matches anywhere in the name, not just at the start', () => {
    expect(filterCollections(NAMES, '_uat')).toEqual([
      'wc_po_eurofins_uat',
      'wc_supplier_eurofins_uat',
    ]);
  });

  it('ignores case on both sides', () => {
    expect(filterCollections(['Vendors', 'ITEMS'], 'vend')).toEqual(['Vendors']);
    expect(filterCollections(['Vendors', 'ITEMS'], 'ITE')).toEqual(['ITEMS']);
  });

  it('trims the query, so a trailing space from typing does not blank the list', () => {
    expect(filterCollections(NAMES, ' supplier ')).toEqual([
      'wc_supplier_eurofins_dev',
      'wc_supplier_eurofins_uat',
      'wc_supplier_master',
    ]);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(filterCollections(NAMES, 'zzz')).toEqual([]);
  });

  it('treats the query as literal text, not a pattern', () => {
    // A regex-based implementation would throw on '(' or match everything on '.*'.
    const odd = ['orders (v2)', 'orders_v3'];
    expect(filterCollections(odd, '(v2)')).toEqual(['orders (v2)']);
    expect(filterCollections(odd, '.*')).toEqual([]);
  });

  it('tolerates a missing list', () => {
    expect(filterCollections(undefined as any, 'x')).toEqual([]);
  });
});

describe('splitByMatch', () => {
  it('brackets the matched run so a caller can emphasise it', () => {
    expect(splitByMatch('wc_supplier_eurofins_uat', 'supplier')).toEqual([
      { text: 'wc_', hit: false },
      { text: 'supplier', hit: true },
      { text: '_eurofins_uat', hit: false },
    ]);
  });

  it('keeps the name original casing, not the query casing', () => {
    expect(splitByMatch('Vendors', 'vend')).toEqual([
      { text: 'Vend', hit: true },
      { text: 'ors', hit: false },
    ]);
  });

  it('marks every occurrence, not just the first', () => {
    expect(splitByMatch('a_b_a_b', 'b')).toEqual([
      { text: 'a_', hit: false },
      { text: 'b', hit: true },
      { text: '_a_', hit: false },
      { text: 'b', hit: true },
    ]);
  });

  it('emits a match at the very start and the very end without empty segments', () => {
    expect(splitByMatch('uat_x', 'uat')).toEqual([
      { text: 'uat', hit: true },
      { text: '_x', hit: false },
    ]);
    expect(splitByMatch('x_uat', 'uat')).toEqual([
      { text: 'x_', hit: false },
      { text: 'uat', hit: true },
    ]);
    expect(splitByMatch('uat', 'uat')).toEqual([{ text: 'uat', hit: true }]);
  });

  it('returns the whole name as one plain segment for an empty query', () => {
    expect(splitByMatch('vendors', '')).toEqual([{ text: 'vendors', hit: false }]);
    expect(splitByMatch('vendors', '   ')).toEqual([{ text: 'vendors', hit: false }]);
  });

  it('returns the whole name as one plain segment when the query does not occur', () => {
    expect(splitByMatch('vendors', 'zzz')).toEqual([{ text: 'vendors', hit: false }]);
  });

  it('reassembles to exactly the input, whatever the query', () => {
    for (const q of ['', 'w', 'wc_', 'uat', 'ZZZ', '_']) {
      const name = 'wc_supplier_eurofins_uat';
      expect(
        splitByMatch(name, q)
          .map((s) => s.text)
          .join(''),
      ).toBe(name);
    }
  });
});
