import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/mdh/api.js';

let fetchMock;

function ok(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function err(status, data = null) {
  return { ok: false, status, json: () => Promise.resolve(data) };
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok({}));
  vi.stubGlobal('fetch', fetchMock);
  api.init('https://example.rossum.app', 'test-token-123');
});

describe('MDH API client', () => {
  it('sends Bearer auth header and correct base URL', async () => {
    await api.listCollections();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.rossum.app/svc/data-storage/api/v1/collections/list',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token-123',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('find sends query parameters in request body', async () => {
    fetchMock.mockResolvedValue(ok({ results: [] }));

    await api.find('my_collection', {
      query: { status: 'active' },
      skip: 10,
      limit: 20,
      sort: { name: 1 },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      collectionName: 'my_collection',
      query: { status: 'active' },
      projection: null,
      skip: 10,
      limit: 20,
      sort: { name: 1 },
    });
  });

  it('aggregate sends pipeline correctly', async () => {
    const pipeline = [{ $match: {} }, { $count: 'total' }];
    await api.aggregate('test_col', pipeline);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ collectionName: 'test_col', pipeline });
  });

  it('throws "Session expired" on 401', async () => {
    fetchMock.mockResolvedValue(err(401));
    await expect(api.listCollections()).rejects.toThrow('Session expired');
  });

  it('throws API error message on non-ok response', async () => {
    fetchMock.mockResolvedValue(err(404, { message: 'Collection not found' }));
    await expect(api.find('missing')).rejects.toThrow('Collection not found');
  });

  it('throws generic error when no message in response', async () => {
    fetchMock.mockResolvedValue(err(500, {}));
    await expect(api.find('col')).rejects.toThrow('API error 500');
  });

  it('attaches HTTP status to thrown errors so callers can render it', async () => {
    fetchMock.mockResolvedValue(err(400, { message: '$search is not allowed within $facet' }));
    let caught;
    try {
      await api.aggregate('col', [{ $facet: {} }]);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(400);
    expect(caught.message).toBe('$search is not allowed within $facet');

    fetchMock.mockResolvedValue(err(401));
    let caught401;
    try {
      await api.listCollections();
    } catch (e) { caught401 = e; }
    expect(caught401.status).toBe(401);
  });

  it('CRUD operations hit correct endpoints', async () => {
    const cases = [
      [() => api.insertOne('col', { a: 1 }), '/data/insert_one'],
      [() => api.insertMany('col', [{ a: 1 }]), '/data/insert_many'],
      [() => api.updateOne('col', { _id: '1' }, { $set: { a: 2 } }), '/data/update_one'],
      [() => api.updateMany('col', {}, { $set: { a: 2 } }), '/data/update_many'],
      [() => api.deleteOne('col', { _id: '1' }), '/data/delete_one'],
      [() => api.deleteMany('col', {}), '/data/delete_many'],
      [() => api.replaceOne('col', { _id: '1' }, { a: 3 }), '/data/replace_one'],
      [() => api.bulkWrite('col', []), '/data/bulk_write'],
      [() => api.createCollection('new_col'), '/collections/create'],
      [() => api.renameCollection('old', 'new'), '/collections/rename'],
      [() => api.dropCollection('old_col'), '/collections/drop'],
      [() => api.listIndexes('col'), '/indexes/list'],
      [() => api.createIndex('col', 'idx1', { name: 1 }), '/indexes/create'],
      [() => api.dropIndex('col', 'idx1'), '/indexes/drop'],
      [() => api.listSearchIndexes('col'), '/search_indexes/list'],
      [() => api.createSearchIndex('col', { indexName: 'si', mappings: {} }), '/search_indexes/create'],
      [() => api.dropSearchIndex('col', 'si'), '/search_indexes/drop'],
    ];

    for (const [fn, expectedPath] of cases) {
      fetchMock.mockClear();
      await fn();
      expect(fetchMock.mock.calls[0][0]).toContain(expectedPath);
    }
  });

  it('healthz uses GET (no method override)', async () => {
    await api.healthz();

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.method).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/healthz');
  });

  it('checkOperationStatus uses GET with operation ID in URL', async () => {
    await api.checkOperationStatus('op-123');

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/operation_status/op-123');
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });

  it('listOperations calls master-data-hub endpoint', async () => {
    await api.listOperations(50);

    expect(fetchMock.mock.calls[0][0]).toContain('/svc/master-data-hub/api/v2/operation/');
    expect(fetchMock.mock.calls[0][0]).toContain('limit=50');
  });
});

describe('async operation helpers', () => {
  it('parseOperationId extracts a 24-hex operation id from the message', () => {
    expect(api.parseOperationId('Accepted, operation 5f4e3d2c1b0a98765432abcd scheduled'))
      .toBe('5f4e3d2c1b0a98765432abcd');
    expect(api.parseOperationId('nothing here')).toBeNull();
    expect(api.parseOperationId(undefined)).toBeNull();
    expect(api.parseOperationId(null)).toBeNull();
  });

  it('waitForOperation polls until the operation reaches FINISHED', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ result: { status: 'CREATED' } }))
      .mockResolvedValueOnce(ok({ result: { status: 'RUNNING' } }))
      .mockResolvedValueOnce(ok({ result: { status: 'FINISHED', _id: 'op1' } }));

    const op = await api.waitForOperation('op1', { intervalMs: 1, timeoutMs: 1000 });

    expect(op).toEqual({ status: 'FINISHED', _id: 'op1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/operation_status/op1');
  });

  it('waitForOperation throws the server error_message on FAILED', async () => {
    fetchMock.mockResolvedValueOnce(ok({ result: { status: 'FAILED', error_message: 'disk is full' } }));
    await expect(api.waitForOperation('op1', { intervalMs: 1 })).rejects.toThrow('disk is full');
  });

  it('waitForOperation throws on timeout when the operation never finishes', async () => {
    fetchMock.mockResolvedValue(ok({ result: { status: 'RUNNING' } }));
    await expect(api.waitForOperation('op1', { intervalMs: 1, timeoutMs: 5 }))
      .rejects.toThrow(/did not finish/);
  });

  it('waitForOperation bails out immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(api.waitForOperation('op1', { signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
