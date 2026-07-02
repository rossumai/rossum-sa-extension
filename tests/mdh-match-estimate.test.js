import { describe, it, expect, vi } from 'vitest';
import { estimateMatches, ESTIMATE_MAX_VALUES } from '../src/mdh/matchEstimate.js';

// Build a (possibly nested) doc from a dotted path — mirrors how MongoDB returns
// a doc for a dotted projection like { 'address.zip': 1 } → { address: { zip } }.
function setPath(path, val) {
  const segs = String(path).split('.');
  const root = {};
  let cur = root;
  segs.forEach((s, i) => { if (i === segs.length - 1) cur[s] = val; else { cur[s] = {}; cur = cur[s]; } });
  return root;
}

// A fake api.find: given the set of key-values that "exist" in the collection,
// return the matching subset of whatever was queried via { key: { $in: [...] } },
// shaped the way the real API returns a projected (possibly dotted) field.
function fakeFind(key, existingValues) {
  const set = new Set(existingValues);
  return vi.fn(async (_coll, { query }) => {
    const asked = query[key].$in;
    return { result: asked.filter((v) => set.has(v)).map((v) => setPath(key, v)) };
  });
}

describe('estimateMatches', () => {
  it('splits rows into matched (update) vs new (insert) by a single key', async () => {
    const docs = [{ sku: 'A1' }, { sku: 'B2' }, { sku: 'C3' }];
    const find = fakeFind('sku', ['A1', 'C3']); // A1 & C3 exist; B2 is new
    const r = await estimateMatches('products', docs, ['sku'], find);
    expect(r).toEqual({ supported: true, matched: 2, willInsert: 1, total: 3 });
  });

  it('counts rows missing the key as inserts (they cannot match)', async () => {
    const docs = [{ sku: 'A1' }, { name: 'no key here' }];
    const find = fakeFind('sku', ['A1']);
    const r = await estimateMatches('products', docs, ['sku'], find);
    expect(r.matched).toBe(1);
    expect(r.willInsert).toBe(1);
  });

  it('dedupes repeated key values before probing', async () => {
    const docs = [{ sku: 'A1' }, { sku: 'A1' }, { sku: 'A1' }];
    const find = fakeFind('sku', ['A1']);
    const r = await estimateMatches('products', docs, ['sku'], find);
    expect(r.matched).toBe(3);           // all three rows match
    const askedValues = find.mock.calls[0][1].query.sku.$in;
    expect(askedValues).toEqual(['A1']); // but only one distinct value was probed
  });

  it('resolves a dotted match-key path', async () => {
    const docs = [{ address: { zip: '10001' } }, { address: { zip: '99999' } }];
    const find = fakeFind('address.zip', ['10001']);
    const r = await estimateMatches('addr', docs, ['address.zip'], find);
    expect(r.matched).toBe(1);
    expect(r.willInsert).toBe(1);
  });

  it('is unsupported only when no key is given', async () => {
    const find = vi.fn();
    const r = await estimateMatches('products', [{ a: 1 }], [], find);
    expect(r).toEqual({ supported: false });
    expect(find).not.toHaveBeenCalled();
  });

  // A composite-aware fake find: understands { $or: [ {$and:[{k0:v0},{k1:v1}]}, ... ] }
  // and returns the asked tuples that "exist" (matched by keys, in key order).
  function fakeFindComposite(keys, existingTuples) {
    const set = new Set(existingTuples.map((vals) => vals.join('|')));
    return vi.fn(async (_coll, { query }) => {
      const clauses = query.$or || [];
      const result = [];
      for (const clause of clauses) {
        const vals = keys.map((k, j) => clause.$and[j][k]);
        if (set.has(vals.join('|'))) {
          const doc = {};
          keys.forEach((k, j) => { doc[k] = vals[j]; });
          result.push(doc);
        }
      }
      return { result };
    });
  }

  it('estimates a composite (two-key) split via $or of $and', async () => {
    const docs = [
      { sku: 'A1', region: 'EU' }, // exists
      { sku: 'A1', region: 'US' }, // same sku, different region → new
      { sku: 'B2', region: 'EU' }, // exists
    ];
    const find = fakeFindComposite(['sku', 'region'], [['A1', 'EU'], ['B2', 'EU']]);
    const r = await estimateMatches('products', docs, ['sku', 'region'], find);
    expect(r).toEqual({ supported: true, matched: 2, willInsert: 1, total: 3 });
    // The probe queried with an $or of $and (composite), not a flat $in.
    expect(find.mock.calls[0][1].query.$or).toBeTruthy();
    expect(find.mock.calls[0][1].projection).toEqual({ sku: 1, region: 1 });
  });

  it('counts a composite row missing part of the key as an insert', async () => {
    const docs = [{ sku: 'A1', region: 'EU' }, { sku: 'B2' /* no region */ }];
    const find = fakeFindComposite(['sku', 'region'], [['A1', 'EU']]);
    const r = await estimateMatches('products', docs, ['sku', 'region'], find);
    expect(r.matched).toBe(1);
    expect(r.willInsert).toBe(1);
  });

  it('does not treat a partial single-field overlap as a composite match', async () => {
    // 'A1' exists with region EU; a row with sku A1 + region APAC must NOT match.
    const docs = [{ sku: 'A1', region: 'APAC' }];
    const find = fakeFindComposite(['sku', 'region'], [['A1', 'EU']]);
    const r = await estimateMatches('products', docs, ['sku', 'region'], find);
    expect(r.matched).toBe(0);
    expect(r.willInsert).toBe(1);
  });

  it('caps composite estimates on too many distinct tuples', async () => {
    const docs = Array.from({ length: ESTIMATE_MAX_VALUES + 1 }, (_, i) => ({ sku: `S${i}`, region: `R${i}` }));
    const find = vi.fn();
    const r = await estimateMatches('products', docs, ['sku', 'region'], find);
    expect(r).toEqual({ supported: true, capped: true });
    expect(find).not.toHaveBeenCalled();
  });

  it('skips (capped) when there are more distinct values than the cap', async () => {
    const docs = Array.from({ length: ESTIMATE_MAX_VALUES + 1 }, (_, i) => ({ sku: `S${i}` }));
    const find = vi.fn();
    const r = await estimateMatches('products', docs, ['sku'], find);
    expect(r).toEqual({ supported: true, capped: true });
    expect(find).not.toHaveBeenCalled();
  });
});
