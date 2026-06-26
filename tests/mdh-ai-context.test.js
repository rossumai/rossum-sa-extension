import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSchemaHints, _resetSchemaHintsCache } from '../src/mdh/aiContext.js';

const records = [{ vendorId: '7440', uom: 'EA', name: 'ACME' }, { vendorId: '8000', uom: 'BG', name: 'BETA' }];

function fakeApi({ facet = {}, search = [] } = {}) {
  return {
    aggregate: vi.fn(async () => ({ result: [facet] })),
    listSearchIndexes: vi.fn(async () => ({ result: search })),
  };
}

beforeEach(() => _resetSchemaHintsCache());

describe('getSchemaHints', () => {
  it('returns numeric-string fields from records; no fetch without a collection', async () => {
    const api = fakeApi();
    const h = await getSchemaHints(api, null, records);
    expect(h.numericStringFields).toContain('vendorId');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('fetches low-card values via $facet + search indexes and caches per collection', async () => {
    const api = fakeApi({
      facet: { uom: [{ _id: 'EA' }, { _id: 'BG' }, { _id: 'FT' }], name: Array.from({ length: 26 }, (_, i) => ({ _id: `n${i}` })) },
      search: [{ name: 'default', status: 'READY', queryable: true, latest_definition: { mappings: { dynamic: true } } }],
    });
    const h = await getSchemaHints(api, 'C', records);
    expect(h.knownValues.uom).toEqual(['BG', 'EA', 'FT']);
    expect(h.knownValues.name).toBeUndefined(); // >25 distinct → dropped
    expect(h.searchIndexes[0].name).toBe('default');
    expect(h.numericStringFields).toContain('vendorId');
    await getSchemaHints(api, 'C', records); // cached
    expect(api.aggregate).toHaveBeenCalledTimes(1);
    expect(api.listSearchIndexes).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when fetches fail', async () => {
    const api = { aggregate: vi.fn(async () => { throw new Error('x'); }), listSearchIndexes: vi.fn(async () => { throw new Error('y'); }) };
    const h = await getSchemaHints(api, 'C2', records);
    expect(h.knownValues).toEqual({});
    expect(h.searchIndexes).toEqual([]);
    expect(h.numericStringFields).toContain('vendorId');
  });
});

describe('richer hints', () => {
  it('returns client-side field types and array paths without a collection', async () => {
    const api = fakeApi();
    const recs = [{ amount: 5, name: 'A', line_items: [{ sku: 'X' }] }];
    const h = await getSchemaHints(api, null, recs);
    expect(h.fieldTypes).toEqual({ amount: 'number', name: 'string', line_items: 'array' });
    expect(h.arrayPaths).toEqual(['line_items[].sku']);
    expect(api.aggregate).not.toHaveBeenCalled();
  });
  it('reads top-values and numeric ranges out of the single $facet', async () => {
    // 'name' has 2 distinct in the sample → low-card → kv (knownValues).
    // Force a high-card field by giving it >25 distinct in the sample.
    const recs = Array.from({ length: 30 }, (_, i) => ({ country: `C${i % 28}`, amount: i }));
    const api = fakeApi({
      facet: {
        country: [{ _id: 'US', n: 50 }, { _id: 'DE', n: 20 }],          // tv__country
        amount: [{ _id: null, min: 0, max: 999 }],                       // rg__amount
      },
    });
    const h = await getSchemaHints(api, 'C', recs);
    expect(h.topValues.country).toEqual({ values: ['US', 'DE'], more: 0 });
    expect(h.ranges.amount).toEqual({ min: 0, max: 999 });
  });
});
