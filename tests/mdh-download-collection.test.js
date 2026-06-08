// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { downloadCollection, BATCH_SIZE, CONCURRENCY, buildJsonSerializer, buildCsvSerializer } from '../src/mdh/downloadCollection.js';
import { buildColumnDiscoveryPipeline } from '../src/mdh/csv.js';

function fakeWriter() {
  const chunks = [];
  return {
    chunks,
    write: vi.fn(async (chunk) => { chunks.push(chunk); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

function fakeHandle(writer) {
  return { createWritable: vi.fn(async () => writer) };
}

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// resetAllMocks (not clearAllMocks) — we need to drop any leftover
// mockResolvedValueOnce / mockReturnValueOnce queue entries between tests,
// otherwise an unconsumed deferred from one test leaks into the next.
beforeEach(() => { vi.resetAllMocks(); });

describe('downloadCollection — module constants', () => {
  it('uses 1000-record batches to keep progress feedback frequent', () => {
    expect(BATCH_SIZE).toBe(1000);
  });

  it('keeps the existing 10-way concurrency for batches', () => {
    expect(CONCURRENCY).toBe(10);
  });
});

describe('downloadCollection — streaming (FileSystem Access) path', () => {
  it('writes a valid JSON array round-tripping the source documents', async () => {
    const docs = [{ _id: 1, name: 'a' }, { _id: 2, name: 'b' }, { _id: 3 }];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    const writer = fakeWriter();

    const result = await downloadCollection('test', {
      fetchCount: async () => docs.length,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result).toEqual({ fetched: 3, cancelled: false, streamed: true });
    const text = writer.chunks.join('');
    expect(JSON.parse(text)).toEqual(docs);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
  });

  it('paginates with $skip/$limit/$match across multiple batches', async () => {
    const docs = Array.from({ length: 2500 }, (_, i) => ({ _id: i }));
    api.aggregate
      .mockResolvedValueOnce({ result: docs.slice(0, 1000) })
      .mockResolvedValueOnce({ result: docs.slice(1000, 2000) })
      .mockResolvedValueOnce({ result: docs.slice(2000, 2500) });

    const writer = fakeWriter();
    const result = await downloadCollection('big', {
      fetchCount: async () => docs.length,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result.fetched).toBe(2500);
    expect(api.aggregate).toHaveBeenCalledTimes(3);
    // Every batch must include the {$sort: {_id: 1}} we inject — without it,
    // MongoDB's natural order isn't stable across separate aggregate calls
    // and adjacent windows overlap, producing duplicate _ids in the output.
    expect(api.aggregate).toHaveBeenNthCalledWith(1, 'big', [{ $match: {} }, { $sort: { _id: 1 } }, { $skip: 0 }, { $limit: 1000 }]);
    expect(api.aggregate).toHaveBeenNthCalledWith(2, 'big', [{ $match: {} }, { $sort: { _id: 1 } }, { $skip: 1000 }, { $limit: 1000 }]);
    expect(api.aggregate).toHaveBeenNthCalledWith(3, 'big', [{ $match: {} }, { $sort: { _id: 1 } }, { $skip: 2000 }, { $limit: 1000 }]);
    const parsed = JSON.parse(writer.chunks.join(''));
    expect(parsed).toEqual(docs);
  });

  it('preserves a caller-provided sort instead of overriding it', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      pipelineStages: [{ $match: { status: 'open' } }, { $sort: { name: 1, _id: 1 } }],
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(api.aggregate).toHaveBeenCalledWith('c', [
      { $match: { status: 'open' } },
      { $sort: { name: 1, _id: 1 } },
      { $skip: 0 },
      { $limit: 1000 },
    ]);
  });

  it('appends the trailing _id sort when the caller\'s pipeline ends with a non-sort stage', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      pipelineStages: [{ $match: { active: true } }, { $project: { name: 1 } }],
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(api.aggregate).toHaveBeenCalledWith('c', [
      { $match: { active: true } },
      { $project: { name: 1 } },
      { $sort: { _id: 1 } },
      { $skip: 0 },
      { $limit: 1000 },
    ]);
  });

  it('writes batches in source order even when later batches resolve first', async () => {
    const d0 = defer();
    const d1 = defer();
    const d2 = defer();
    api.aggregate
      .mockReturnValueOnce(d0.promise)
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    const writer = fakeWriter();
    const done = downloadCollection('c', {
      fetchCount: async () => 30,
      batchSize: 10,
      concurrency: 3,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    // Resolve out of order: batch 2 first, then 0, then 1.
    d2.resolve({ result: [{ _id: 20 }, { _id: 21 }] });
    await new Promise((r) => setTimeout(r, 0));
    d0.resolve({ result: [{ _id: 0 }, { _id: 1 }] });
    await new Promise((r) => setTimeout(r, 0));
    d1.resolve({ result: [{ _id: 10 }, { _id: 11 }] });

    const result = await done;
    expect(result.fetched).toBe(6);
    const parsed = JSON.parse(writer.chunks.join(''));
    expect(parsed.map((d) => d._id)).toEqual([0, 1, 10, 11, 20, 21]);
  });

  it('emits valid JSON for an empty collection (total=0)', async () => {
    const writer = fakeWriter();
    const result = await downloadCollection('empty', {
      fetchCount: async () => 0,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result).toEqual({ fetched: 0, cancelled: false, streamed: true });
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(JSON.parse(writer.chunks.join(''))).toEqual([]);
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it('reports progress per batch with the discovered total', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{}, {}] })
      .mockResolvedValueOnce({ result: [{}] });

    const onProgress = vi.fn();
    const writer = fakeWriter();
    await downloadCollection('c', {
      batchSize: 2,
      fetchCount: async () => 3,
      onProgress,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(onProgress).toHaveBeenCalledWith({ fetched: 0, total: 3 });
    expect(onProgress).toHaveBeenCalledWith({ fetched: 2, total: 3 });
    expect(onProgress).toHaveBeenCalledWith({ fetched: 3, total: 3 });
  });

  it('aborts the writer and stops fetching when cancelled between batches', async () => {
    let cancelled = false;
    let calls = 0;
    api.aggregate.mockImplementation(async () => {
      calls++;
      // Serve only the first batch, then flip cancellation so the next
      // for-loop iteration breaks before issuing batch 2.
      if (calls === 1) {
        cancelled = true;
        return { result: Array.from({ length: 10 }, (_, i) => ({ _id: i })) };
      }
      return { result: [{ _id: 'leaked-batch' }] };
    });

    const writer = fakeWriter();
    const result = await downloadCollection('c', {
      batchSize: 10,
      concurrency: 1,
      fetchCount: async () => 30,
      isCancelled: () => cancelled,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result).toEqual({ fetched: 10, cancelled: true, streamed: true });
    expect(api.aggregate).toHaveBeenCalledTimes(1);
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it('aborts the writer on fetch failure and rethrows the error', async () => {
    api.aggregate.mockRejectedValueOnce(new Error('network down'));
    const writer = fakeWriter();

    await expect(downloadCollection('c', {
      fetchCount: async () => 5,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    })).rejects.toThrow('network down');

    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });
});

describe('downloadCollection — Blob fallback', () => {
  it('builds a Blob from individual batch parts when no file picker is available', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ _id: i }));
    api.aggregate.mockResolvedValueOnce({ result: docs });
    const downloadBlob = vi.fn();

    const result = await downloadCollection('c', {
      fetchCount: async () => 5,
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });

    expect(result).toEqual({ fetched: 5, cancelled: false, streamed: false });
    expect(downloadBlob).toHaveBeenCalledOnce();
    const [blob, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe('c.json');
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text)).toEqual(docs);
  });

  it('falls back to Blob when showSaveFilePicker throws a non-Abort error', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ ok: 1 }] });
    const downloadBlob = vi.fn();

    const result = await downloadCollection('c', {
      fetchCount: async () => 1,
      pickFile: () => Promise.reject(new Error('no support')),
      downloadBlob,
    });

    expect(result.streamed).toBe(false);
    expect(downloadBlob).toHaveBeenCalledOnce();
    const text = await downloadBlob.mock.calls[0][0].text();
    expect(JSON.parse(text)).toEqual([{ ok: 1 }]);
  });

  it('keeps each batch as its own Blob part so no giant string is ever materialized', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ a: 1 }] })
      .mockResolvedValueOnce({ result: [{ b: 2 }] })
      .mockResolvedValueOnce({ result: [{ c: 3 }] });

    let capturedParts = null;
    const downloadBlob = vi.fn((blob) => { capturedParts = blob; });

    await downloadCollection('c', {
      batchSize: 1,
      concurrency: 1,
      fetchCount: async () => 3,
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });

    // We can't directly inspect Blob internal parts, but we can verify that
    // serialization happened per-batch by checking the API was called 3
    // times and the final Blob still parses to the concatenated payload.
    expect(api.aggregate).toHaveBeenCalledTimes(3);
    const text = await capturedParts.text();
    expect(JSON.parse(text)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('emits an empty array via Blob when collection is empty and no picker', async () => {
    const downloadBlob = vi.fn();
    await downloadCollection('empty', {
      fetchCount: async () => 0,
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledOnce();
    const text = await downloadBlob.mock.calls[0][0].text();
    expect(JSON.parse(text)).toEqual([]);
  });
});

describe('downloadCollection — picker cancellation', () => {
  it('returns cancelled=true when the user dismisses the picker (AbortError)', async () => {
    const abort = new Error('User cancelled');
    abort.name = 'AbortError';
    const downloadBlob = vi.fn();
    const onProgress = vi.fn();

    const result = await downloadCollection('c', {
      fetchCount: async () => 100,
      pickFile: () => Promise.reject(abort),
      downloadBlob,
      onProgress,
    });

    expect(result).toEqual({ fetched: 0, cancelled: true, streamed: false });
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('honors isCancelled() between picker and first fetch', async () => {
    const writer = fakeWriter();
    const result = await downloadCollection('c', {
      fetchCount: async () => 10,
      isCancelled: () => true,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result.cancelled).toBe(true);
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
  });
});

describe('downloadCollection — sliding-window concurrency', () => {
  // setTimeout(0) lets the microtask queue drain so all pending awaits
  // settle before the assertion runs.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('starts the next batch as soon as any in-flight one finishes (no barrier)', async () => {
    const deferreds = Array.from({ length: 5 }, () => defer());
    let calls = 0;
    api.aggregate.mockImplementation(() => deferreds[calls++].promise);

    const writer = fakeWriter();
    const done = downloadCollection('c', {
      batchSize: 10,
      concurrency: 3,
      fetchCount: async () => 50, // 5 batches
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    await flush();
    // Only 3 fetches in flight initially — concurrency cap.
    expect(api.aggregate).toHaveBeenCalledTimes(3);

    // Finish the first one — a sliding window must start the 4th now,
    // without waiting for the other two in-flight ones.
    deferreds[0].resolve({ result: [{ _id: 0 }] });
    await flush();
    expect(api.aggregate).toHaveBeenCalledTimes(4);

    deferreds[1].resolve({ result: [{ _id: 10 }] });
    await flush();
    expect(api.aggregate).toHaveBeenCalledTimes(5);

    // Drain the rest and finalize.
    deferreds[2].resolve({ result: [{ _id: 20 }] });
    deferreds[3].resolve({ result: [{ _id: 30 }] });
    deferreds[4].resolve({ result: [{ _id: 40 }] });

    const result = await done;
    expect(result.fetched).toBe(5);
    expect(api.aggregate).toHaveBeenCalledTimes(5);
    expect(JSON.parse(writer.chunks.join(''))).toEqual([
      { _id: 0 }, { _id: 10 }, { _id: 20 }, { _id: 30 }, { _id: 40 },
    ]);
  });

  it('caps in-flight requests at the worker pool size', async () => {
    const deferreds = Array.from({ length: 50 }, () => defer());
    let calls = 0;
    api.aggregate.mockImplementation(() => deferreds[calls++].promise);

    const writer = fakeWriter();
    const done = downloadCollection('c', {
      batchSize: 1,
      concurrency: 4,
      fetchCount: async () => 20,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    await flush();
    expect(api.aggregate).toHaveBeenCalledTimes(4); // never more than `concurrency`

    // Drain — each resolution exposes one new slot.
    for (let i = 0; i < 20; i++) deferreds[i].resolve({ result: [{ i }] });
    await done;
    expect(api.aggregate).toHaveBeenCalledTimes(20);
  });

  it('caps pending buffer via maxBuffered backpressure when writes lag fetches', async () => {
    // Mock writer.write to never resolve until we let it.
    let releaseWrite;
    const writeGate = new Promise((r) => { releaseWrite = r; });
    const writer = fakeWriter();
    writer.write.mockImplementation(async (chunk) => {
      writer.chunks.push(chunk);
      // Stall the very first write (the '[\n' opener) so no flush can
      // progress and pending will fill up.
      if (writer.chunks.length === 1) await writeGate;
    });

    const deferreds = Array.from({ length: 20 }, () => defer());
    let calls = 0;
    api.aggregate.mockImplementation(() => deferreds[calls++].promise);

    const done = downloadCollection('c', {
      batchSize: 1,
      concurrency: 4,
      maxBuffered: 3,
      fetchCount: async () => 20,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    // Resolve enough batches that pending overflows. Workers should park.
    for (let i = 0; i < 6; i++) deferreds[i].resolve({ result: [{ i }] });
    await flush();
    await flush();

    // 4 workers each grabbed one offset (4 calls). After the first 3
    // batches landed in pending, the 4th call's worker tried to grab a
    // fifth offset but had to park because pending.size === maxBuffered.
    // So no further api.aggregate calls happen until the writer drains.
    expect(api.aggregate.mock.calls.length).toBeLessThanOrEqual(4 + 3);

    // Now let the writer through. Pending drains, workers unpark, the
    // rest of the offsets are fetched.
    releaseWrite();
    for (let i = 6; i < 20; i++) deferreds[i].resolve({ result: [{ i }] });
    await done;
    expect(api.aggregate).toHaveBeenCalledTimes(20);
  });
});

describe('downloadCollection — output format', () => {
  it('produces output matching JSON.stringify(docs, null, 2) for parity with the previous version', async () => {
    const docs = [
      { _id: 1, name: 'alpha', tags: ['x', 'y'] },
      { _id: 2, name: 'beta', nested: { a: 1, b: { c: 2 } } },
    ];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    const writer = fakeWriter();

    await downloadCollection('c', {
      fetchCount: async () => docs.length,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    const expected = JSON.stringify(docs, null, 2);
    const actual = writer.chunks.join('').trim();
    expect(actual).toBe(expected);
  });
});

describe('downloadCollection — pipelineStages option (filtered download)', () => {
  it('prepends the supplied pipeline stages to every batch aggregate call', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: 1 }] })
      .mockResolvedValueOnce({ result: [{ _id: 2 }] });

    const writer = fakeWriter();
    await downloadCollection('orders', {
      batchSize: 1,
      concurrency: 1,
      fetchCount: async () => 2,
      pipelineStages: [
        { $match: { status: 'paid' } },
        { $sort: { date: -1 } },
      ],
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(api.aggregate).toHaveBeenNthCalledWith(1, 'orders', [
      { $match: { status: 'paid' } },
      { $sort: { date: -1 } },
      { $skip: 0 },
      { $limit: 1 },
    ]);
    expect(api.aggregate).toHaveBeenNthCalledWith(2, 'orders', [
      { $match: { status: 'paid' } },
      { $sort: { date: -1 } },
      { $skip: 1 },
      { $limit: 1 },
    ]);
  });

  it('still writes a valid JSON array with filtered/projected results', async () => {
    const docs = [{ name: 'alpha' }, { name: 'beta' }];
    api.aggregate.mockResolvedValueOnce({ result: docs });

    const writer = fakeWriter();
    await downloadCollection('orders', {
      fetchCount: async () => 2,
      pipelineStages: [
        { $match: { status: 'paid' } },
        { $project: { _id: 0, name: 1 } },
      ],
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(JSON.parse(writer.chunks.join(''))).toEqual(docs);
  });

  it('defaults to $match {} when pipelineStages is omitted (backwards compatible)', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(api.aggregate).toHaveBeenCalledWith('c', [
      { $match: {} },
      { $sort: { _id: 1 } },
      { $skip: 0 },
      { $limit: 1000 },
    ]);
  });
});

describe('downloadCollection — filename option', () => {
  it('uses the supplied filename for the Blob fallback download', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const downloadBlob = vi.fn();

    await downloadCollection('orders', {
      fetchCount: async () => 1,
      pickFile: () => Promise.resolve(null),
      downloadBlob,
      filename: 'orders-filtered.json',
    });

    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(downloadBlob.mock.calls[0][1]).toBe('orders-filtered.json');
  });

  it('passes the supplied filename to the file picker as suggestedName', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const writer = fakeWriter();
    const pickFile = vi.fn(() => Promise.resolve(fakeHandle(writer)));

    await downloadCollection('orders', {
      fetchCount: async () => 1,
      pickFile,
      filename: 'orders-filtered.json',
    });

    expect(pickFile).toHaveBeenCalledWith('orders-filtered.json');
  });

  it('defaults to <collection>.json when filename is omitted', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const downloadBlob = vi.fn();

    await downloadCollection('mycoll', {
      fetchCount: async () => 1,
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });

    expect(downloadBlob.mock.calls[0][1]).toBe('mycoll.json');
  });
});

describe('downloadCollection — CSV serializer', () => {
  it('discovers columns (_id-first, alphabetical) and writes header + CRLF rows', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['name', '_id', 'active'] }] })  // discovery
      .mockResolvedValueOnce({ result: [
        { _id: 'V1', name: 'Acme', active: true },
        { _id: 'V2', name: 'Globex' },                 // missing `active`
      ] });

    const writer = fakeWriter();
    const result = await downloadCollection('vendors', {
      fetchCount: async () => 2,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result).toEqual({ fetched: 2, cancelled: false, streamed: true });
    // discovery call uses the column-discovery pipeline on the default filter
    expect(api.aggregate).toHaveBeenNthCalledWith(1, 'vendors', buildColumnDiscoveryPipeline([{ $match: {} }]));
    // columns ordered _id, active, name
    expect(writer.chunks.join('')).toBe('_id,active,name\r\nV1,true,Acme\r\nV2,,Globex');
  });

  it('omits the header when header:false and prepends a BOM when bom:true', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['_id'] }] })
      .mockResolvedValueOnce({ result: [{ _id: 1 }, { _id: 2 }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 2,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: false, bom: true }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(writer.chunks.join('')).toBe('﻿1\r\n2');
  });

  it('honors a custom delimiter', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['a', 'b'] }] })
      .mockResolvedValueOnce({ result: [{ a: '1', b: '2' }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      serializer: buildCsvSerializer({ dialect: { delimiter: ';' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(writer.chunks.join('')).toBe('a;b\r\n1;2');
  });

  it('uses a .csv Blob (text/csv) in the fallback path', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['_id'] }] })
      .mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const downloadBlob = vi.fn();
    await downloadCollection('orders', {
      fetchCount: async () => 1,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });
    const [blob, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe('orders.csv');
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('_id\r\n1');
  });

  it('buildJsonSerializer is the default — JSON output unchanged when omitted', async () => {
    const docs = [{ _id: 1, name: 'a' }];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(JSON.parse(writer.chunks.join(''))).toEqual(docs);
    // no discovery call — JSON serializer has no init()
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });

  it('aborts the writer and rethrows when CSV column discovery fails', async () => {
    api.aggregate.mockRejectedValueOnce(new Error('discovery timeout'));
    const writer = fakeWriter();
    await expect(downloadCollection('c', {
      fetchCount: async () => 5,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    })).rejects.toThrow('discovery timeout');
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it('writes a header-only CSV for an empty collection', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [] }); // discovery over empty collection -> no $group output
    const writer = fakeWriter();
    const result = await downloadCollection('empty', {
      fetchCount: async () => 0,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(result).toEqual({ fetched: 0, cancelled: false, streamed: true });
    expect(api.aggregate).toHaveBeenCalledTimes(1); // discovery only; no data batches
    expect(writer.chunks.join('')).toBe('\r\n');     // empty header (no columns) + CRLF
  });

  it('JSON-encodes a nested field value through the exporter', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['_id', 'meta'] }] })
      .mockResolvedValueOnce({ result: [{ _id: 'V3', meta: { role: 'admin' } }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(writer.chunks.join('')).toBe('_id,meta\r\nV3,"{""role"":""admin""}"');
  });
});
