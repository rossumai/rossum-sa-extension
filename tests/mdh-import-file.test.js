// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import {
  analyzeDocs,
  dedupeById,
  runChunkedInsert,
  runChunkedOverwrite,
  stableKey,
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

describe('dedupeById', () => {
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

describe('runChunkedOverwrite', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes by every _id in the file (no pre-probe), then chunked-inserts all docs', async () => {
    api.deleteMany.mockResolvedValue({ result: { deleted_count: 2 } });
    api.insertMany.mockResolvedValue({ result: {} });

    const docs = [
      { _id: 'a', v: 1 },
      { _id: 'b', v: 2 },
      { _id: 'c', v: 3 },
    ];
    const result = await runChunkedOverwrite('vendors', docs);

    expect(api.deleteMany).toHaveBeenCalledWith('vendors', { _id: { $in: ['a', 'b', 'c'] } });
    expect(api.insertMany).toHaveBeenCalledWith('vendors', docs, false);
    expect(result.deleted).toBe(2);
    expect(result.inserted).toBe(3);
  });

  it('skips the delete pass entirely when no doc has an _id', async () => {
    api.insertMany.mockResolvedValue({ result: {} });
    const result = await runChunkedOverwrite('vendors', [{ v: 1 }, { v: 2 }]);
    expect(api.deleteMany).not.toHaveBeenCalled();
    expect(result.inserted).toBe(2);
  });

  it('bails out without inserting if the delete step fails', async () => {
    api.deleteMany.mockRejectedValueOnce(new Error('boom'));
    const result = await runChunkedOverwrite('vendors', [{ _id: 'a' }]);
    expect(result.deleteError).toBe('boom');
    expect(result.inserted).toBe(0);
    expect(api.insertMany).not.toHaveBeenCalled();
  });

  it('chunks the delete pass when there are many _ids', async () => {
    api.deleteMany.mockResolvedValue({ result: { deleted_count: 0 } });
    api.insertMany.mockResolvedValue({ result: {} });
    const docs = Array.from({ length: 2500 }, (_, i) => ({ _id: `id-${i}` }));
    await runChunkedOverwrite('vendors', docs, { deleteBatch: 1000 });
    // 2500 ids in deleteBatch=1000 means 3 delete calls.
    expect(api.deleteMany).toHaveBeenCalledTimes(3);
  });
});

describe('shared chunk size with downloader', () => {
  it('reuses BATCH_SIZE from downloadCollection so up and down round-trip with matching batches', () => {
    expect(BATCH_SIZE).toBe(1000);
  });
});
