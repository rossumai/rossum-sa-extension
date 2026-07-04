// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import {
  analyzeDocs,
  dedupeById,
  normalizeDocId,
  runChunkedInsert,
  stableKey,
  stripServerFields,
} from '../src/mdh/importFile.js';
import { BATCH_SIZE } from '../src/mdh/downloadCollection.js';

describe('stableKey', () => {
  it('distinguishes primitives by type', () => {
    expect(stableKey('1')).not.toBe(stableKey(1));
    expect(stableKey(true)).not.toBe(stableKey('true'));
  });

  it('produces the same key for EJSON $oid regardless of declaration order', () => {
    const a = { $oid: 'abc' };
    const b = { $oid: 'abc' };
    expect(stableKey(a)).toBe(stableKey(b));
  });

  it('produces the same key for multi-key objects regardless of order', () => {
    const a = { $date: '2026-01-01', $type: 'ts' };
    const b = { $type: 'ts', $date: '2026-01-01' };
    expect(stableKey(a)).toBe(stableKey(b));
  });

  it('separates null/undefined from string null', () => {
    expect(stableKey(null)).not.toBe(stableKey('null'));
    expect(stableKey(undefined)).not.toBe(stableKey(null));
  });
});

describe('analyzeDocs', () => {
  it('counts total, withId, withoutId', () => {
    const stats = analyzeDocs([
      { _id: 'a', x: 1 },
      { _id: 'b', x: 2 },
      { x: 3 },
    ]);
    expect(stats.total).toBe(3);
    expect(stats.withId).toBe(2);
    expect(stats.withoutId).toBe(1);
    expect(stats.uniqueIdCount).toBe(2);
    expect(stats.inFileDupeCount).toBe(0);
  });

  it('detects in-file duplicate _ids and samples them', () => {
    const stats = analyzeDocs([
      { _id: 'a' },
      { _id: 'b' },
      { _id: 'a' },
      { _id: 'a' },
      { _id: 'c' },
    ]);
    expect(stats.total).toBe(5);
    expect(stats.uniqueIdCount).toBe(3); // a, b, c
    expect(stats.inFileDupeCount).toBe(1); // only 'a' is duplicated (counted once)
    expect(stats.inFileDupeIdSample).toEqual(['a']);
  });

  it('handles EJSON $oid _ids as object keys', () => {
    const oid1 = { $oid: '69c65a799ec46e786beb4c5a' };
    const oid2 = { $oid: '69c65a799ec46e786beb4c5a' }; // same canonical
    const oid3 = { $oid: '69c65a799ec46e786beb4c5b' };
    const stats = analyzeDocs([{ _id: oid1 }, { _id: oid2 }, { _id: oid3 }]);
    expect(stats.uniqueIdCount).toBe(2);
    expect(stats.inFileDupeCount).toBe(1);
  });
});

describe('normalizeDocId', () => {
  it('coerces a 24-hex-char string _id to an EJSON {$oid}', () => {
    expect(normalizeDocId({ _id: '69c65a799ec46e786beb4c5a', n: 1 }))
      .toEqual({ _id: { $oid: '69c65a799ec46e786beb4c5a' }, n: 1 });
  });
  it('accepts uppercase hex', () => {
    expect(normalizeDocId({ _id: 'AABBCCDDEEFF00112233445A' }))
      .toEqual({ _id: { $oid: 'AABBCCDDEEFF00112233445A' } });
  });
  it('leaves non-ObjectId string _ids untouched (real string keys stay strings)', () => {
    expect(normalizeDocId({ _id: 'US', n: 1 })).toEqual({ _id: 'US', n: 1 });
    expect(normalizeDocId({ _id: 'SKU-12345' })).toEqual({ _id: 'SKU-12345' });
    expect(normalizeDocId({ _id: 'zzz65a799ec46e786beb4c5a' })).toEqual({ _id: 'zzz65a799ec46e786beb4c5a' }); // 24 chars, non-hex
    expect(normalizeDocId({ _id: '69c65a799ec46e786beb4c5' })).toEqual({ _id: '69c65a799ec46e786beb4c5' }); // 23 chars
  });
  it('leaves numeric, object, and missing _ids untouched', () => {
    expect(normalizeDocId({ _id: 42 })).toEqual({ _id: 42 });
    expect(normalizeDocId({ _id: { $oid: 'abc' } })).toEqual({ _id: { $oid: 'abc' } });
    expect(normalizeDocId({ name: 'x' })).toEqual({ name: 'x' });
  });
  it('returns non-objects unchanged and does not mutate the input', () => {
    expect(normalizeDocId(null)).toBe(null);
    const doc = { _id: '69c65a799ec46e786beb4c5a' };
    const out = normalizeDocId(doc);
    expect(doc._id).toBe('69c65a799ec46e786beb4c5a'); // original untouched
    expect(out).not.toBe(doc);
  });
});

describe('dedupeById', () => {
  it('coerces ObjectId-looking string _ids to {$oid} in the kept docs', () => {
    const hex = '69c65a799ec46e786beb4c5a';
    const { kept } = dedupeById([{ _id: hex, n: 1 }, { _id: 'plain', n: 2 }]);
    expect(kept).toEqual([{ _id: { $oid: hex }, n: 1 }, { _id: 'plain', n: 2 }]);
  });

  it('keeps the first occurrence of each _id and reports dropped count', () => {
    const { kept, dropped } = dedupeById([
      { _id: 'a', v: 1 },
      { _id: 'b', v: 2 },
      { _id: 'a', v: 3 }, // duplicate -> dropped
      { v: 4 },           // no _id -> kept
      { _id: 'a', v: 5 }, // duplicate -> dropped
    ]);
    expect(kept).toEqual([
      { _id: 'a', v: 1 },
      { _id: 'b', v: 2 },
      { v: 4 },
    ]);
    expect(dropped).toBe(2);
  });

  it('treats EJSON $oid duplicates as duplicates', () => {
    const oid = { $oid: 'abc' };
    const { kept, dropped } = dedupeById([{ _id: oid, n: 1 }, { _id: { $oid: 'abc' }, n: 2 }]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe('runChunkedInsert', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('chunks at the shared dataset BATCH_SIZE (1000) and calls insertMany with ordered:false', async () => {
    api.insertMany.mockResolvedValue({ result: {} });
    const docs = Array.from({ length: 2500 }, (_, i) => ({ _id: `id-${i}` }));
    const result = await runChunkedInsert('vendors', docs);
    expect(api.insertMany).toHaveBeenCalledTimes(3);
    expect(api.insertMany.mock.calls[0][1]).toHaveLength(BATCH_SIZE);
    expect(api.insertMany.mock.calls[0][2]).toBe(false); // ordered: false
    expect(result.inserted).toBe(2500);
    expect(result.failedBatches).toEqual([]);
  });

  it('respects an explicit batchSize override', async () => {
    api.insertMany.mockResolvedValue({ result: {} });
    const docs = Array.from({ length: 1200 }, (_, i) => ({ _id: `id-${i}` }));
    const result = await runChunkedInsert('vendors', docs, { batchSize: 500 });
    expect(api.insertMany).toHaveBeenCalledTimes(3);
    expect(result.inserted).toBe(1200);
  });

  it('continues past a failed batch and records the failed range', async () => {
    api.insertMany
      .mockResolvedValueOnce({ result: {} })
      .mockRejectedValueOnce(new Error('batch op errors occurred'))
      .mockResolvedValueOnce({ result: {} });
    const docs = Array.from({ length: 6 }, (_, i) => ({ _id: `id-${i}` }));
    // After the failed insertMany, runChunkedInsert re-probes the chunk's
    // _ids to count landed docs. Stub api.find for the probe.
    api.find.mockResolvedValueOnce({ result: [{ _id: 'id-2' }] }); // 1 of 2 landed
    const result = await runChunkedInsert('vendors', docs, { batchSize: 2 });
    expect(result.inserted).toBe(2 + 1 + 2); // batches 1 & 3 + 1 from failed batch
    expect(result.failedBatches).toHaveLength(1);
    expect(result.failedBatches[0]).toMatchObject({
      startIdx: 2,
      endIdx: 3,
      count: 2,
      landedFromChunk: 1,
    });
    expect(result.failedBatches[0].message).toMatch(/batch op errors/);
  });

  it('stops between batches when the abort signal fires', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ _id: `id-${i}` }));
    const controller = new AbortController();
    let callCount = 0;
    api.insertMany.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) controller.abort();
      return { result: {} };
    });
    const result = await runChunkedInsert('vendors', docs, { batchSize: 2, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(api.insertMany).toHaveBeenCalledTimes(2);
    expect(result.inserted).toBe(4); // first two batches landed before abort
  });
});

describe('shared chunk size with downloader', () => {
  it('reuses BATCH_SIZE from downloadCollection so up and down round-trip with matching batches', () => {
    expect(BATCH_SIZE).toBe(1000);
  });
});

describe('stripServerFields', () => {
  it('removes _id (plain or EJSON) without mutating inputs', () => {
    const docs = [{ _id: { $oid: 'a'.repeat(24) }, sku: 'A' }, { _id: '1', sku: 'B' }, { sku: 'C' }];
    const out = stripServerFields(docs);
    expect(out).toEqual([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
    expect(docs[0]._id).toBeTruthy(); // originals untouched
    expect(out[2]).toBe(docs[2]);     // rows without server fields pass through by reference
  });
  it('removes __digest_md5 (server stores uploaded digests verbatim, never recomputes)', () => {
    const docs = [{ _id: '1', __digest_md5: '0'.repeat(32), sku: 'A' }, { __digest_md5: 'f'.repeat(32), sku: 'B' }];
    expect(stripServerFields(docs)).toEqual([{ sku: 'A' }, { sku: 'B' }]);
    expect(docs[1].__digest_md5).toBeTruthy(); // originals untouched
  });
  it('leaves non-object rows alone', () => {
    expect(stripServerFields([null, 5])).toEqual([null, 5]);
  });
});
