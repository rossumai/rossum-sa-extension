import { describe, it, expect, vi } from 'vitest';
import {
  getSchemaHints, detectNumericStringFields, leafFieldTypes, arrayLeafPaths, summarizeSearchIndexes, extendedJsonType,
} from '../src/mdh/agent/aiContext.js';

describe('schema-hint detectors (pure, from in-memory records)', () => {
  it('detects string-of-digits fields (numeric-string), excluding mixed', () => {
    expect(detectNumericStringFields([{ vendorId: '7440', name: 'x' }, { vendorId: '12', name: 'y2' }])).toEqual(['vendorId']);
    expect(detectNumericStringFields([{ code: '12' }, { code: 'AB' }])).toEqual([]); // mixed → not numeric-string
  });

  it('maps leaf field types and treats extended-JSON as its semantic type', () => {
    const t = leafFieldTypes([{ n: 1, s: 'a', ok: true, d: { $date: '2020-01-01' }, id: { $oid: 'abc' } }]);
    expect(t).toEqual({ n: 'number', s: 'string', ok: 'boolean', d: 'date', id: 'objectId' });
  });

  it('finds array leaf paths for $unwind', () => {
    expect(arrayLeafPaths([{ items: [{ sku: 'A', qty: 2 }] }])).toEqual(['items[].qty', 'items[].sku']);
    expect(arrayLeafPaths([{ tags: ['a', 'b'] }])).toEqual(['tags[]']);
  });

  it('summarizes queryable/READY search indexes', () => {
    expect(summarizeSearchIndexes([
      { name: 'dyn', queryable: true, status: 'READY', latest_definition: { mappings: { dynamic: true } } },
      { name: 'stopped', queryable: false, latest_definition: {} },
    ])).toEqual([{ name: 'dyn', fields: 'all', synonyms: false }]);
  });

  it('recognizes extended-JSON wrappers', () => {
    expect(extendedJsonType({ $date: 'x' })).toBe('date');
    expect(extendedJsonType({ a: 1, b: 2 })).toBeNull();
  });
});

describe('getSchemaHints', () => {
  it('gathers $facet-based hints + free detectors', async () => {
    const api = {
      aggregate: vi.fn(async () => ({ result: [{ status: [{ _id: 'open' }, { _id: 'closed' }] }] })),
      listSearchIndexes: vi.fn(async () => ({ result: [] })),
    };
    const h = await getSchemaHints(api, 'c', [{ status: 'open', amount: 5, vendorId: '10' }]);
    expect(h.knownValues.status).toEqual(['closed', 'open']); // sorted distinct
    expect(h.numericStringFields).toEqual(['vendorId']);
    expect(h.fieldTypes.amount).toBe('number');
    expect(api.aggregate).toHaveBeenCalled();
  });

  it('degrades to empties (never throws) when the facet call fails', async () => {
    const api = { aggregate: vi.fn(async () => { throw new Error('nope'); }), listSearchIndexes: vi.fn(async () => { throw new Error('nope'); }) };
    const h = await getSchemaHints(api, 'c2', [{ a: 1 }]);
    expect(h.knownValues).toEqual({});
    expect(h.searchIndexes).toEqual([]);
    expect(h.fieldTypes.a).toBe('number'); // free detector still works
  });

  it('returns free detectors only when no collection is selected (no API calls)', async () => {
    const api = { aggregate: vi.fn(), listSearchIndexes: vi.fn() };
    const h = await getSchemaHints(api, null, [{ vendorId: '9' }]);
    expect(h.numericStringFields).toEqual(['vendorId']);
    expect(api.aggregate).not.toHaveBeenCalled();
  });
});
