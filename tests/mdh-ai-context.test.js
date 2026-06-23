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
