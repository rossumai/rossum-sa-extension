// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { UNDO_LIMIT, selectionToFilter, previewMatch } from '../src/mdh/bulkOps.js';

describe('UNDO_LIMIT', () => {
  it('matches the existing collection-drop snapshot threshold', () => {
    expect(UNDO_LIMIT).toBe(1000);
  });
});

describe('selectionToFilter', () => {
  it('builds an $in filter from a Set of ids', () => {
    const filter = selectionToFilter(new Set(['a', 'b', 'c']));
    expect(filter).toEqual({ _id: { $in: ['a', 'b', 'c'] } });
  });

  it('builds an $in filter from an array of ids', () => {
    const filter = selectionToFilter(['x', 'y']);
    expect(filter).toEqual({ _id: { $in: ['x', 'y'] } });
  });

  it('preserves $oid wrapper objects untouched', () => {
    const id = { $oid: '67e8abcd' };
    const filter = selectionToFilter([id]);
    expect(filter).toEqual({ _id: { $in: [id] } });
  });
});

describe('previewMatch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns count and up to 5 sample docs from two parallel aggregates', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 42 }] })
      .mockResolvedValueOnce({ result: [{ _id: '1' }, { _id: '2' }] });

    const result = await previewMatch('vendors', { status: 'draft' });

    expect(result).toEqual({ count: 42, sample: [{ _id: '1' }, { _id: '2' }] });
    expect(api.aggregate).toHaveBeenNthCalledWith(
      1,
      'vendors',
      [{ $match: { status: 'draft' } }, { $count: 'total' }],
      expect.any(Object),
    );
    expect(api.aggregate).toHaveBeenNthCalledWith(
      2,
      'vendors',
      [{ $match: { status: 'draft' } }, { $limit: 5 }],
      expect.any(Object),
    );
  });

  it('treats empty $count result as 0', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValueOnce({ result: [] });

    const result = await previewMatch('empty', {});
    expect(result).toEqual({ count: 0, sample: [] });
  });

  it('forwards an AbortSignal to both aggregate calls', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 1 }] })
      .mockResolvedValueOnce({ result: [{}] });
    const ac = new AbortController();

    await previewMatch('c', {}, { signal: ac.signal });

    expect(api.aggregate.mock.calls[0][2]).toEqual({ signal: ac.signal });
    expect(api.aggregate.mock.calls[1][2]).toEqual({ signal: ac.signal });
  });
});

import { undoToast } from '../src/mdh/store.js';
import { _reset as resetUndo, triggerUndo } from '../src/mdh/undo.js';
import { runBulkDelete } from '../src/mdh/bulkOps.js';

describe('runBulkDelete', () => {
  beforeEach(() => { vi.clearAllMocks(); resetUndo(); });

  it('snapshots, deletes, and registers an undo toast when count is within the limit', async () => {
    const docs = [{ _id: '1' }, { _id: '2' }];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 2 } });
    api.insertMany.mockResolvedValueOnce({ result: {} });
    const onSuccess = vi.fn();

    await runBulkDelete('c', { x: 1 }, { count: 2, onSuccess });

    expect(api.aggregate).toHaveBeenCalledWith('c', [{ $match: { x: 1 } }]);
    expect(api.deleteMany).toHaveBeenCalledWith('c', { x: 1 });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(undoToast.value).toMatchObject({ status: 'pending' });

    await triggerUndo();
    expect(api.insertMany).toHaveBeenCalledWith('c', docs, false);
    expect(onSuccess).toHaveBeenCalledTimes(2); // success + undo-success
  });

  it('skips the snapshot and undo toast when count exceeds UNDO_LIMIT', async () => {
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 5000 } });
    const onSuccess = vi.fn();

    await runBulkDelete('c', {}, { count: 5000, onSuccess });

    expect(api.aggregate).not.toHaveBeenCalled();
    expect(api.deleteMany).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(undoToast.value).toBeNull();
  });

  it('skips the undo toast when count is 0', async () => {
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 0 } });

    await runBulkDelete('c', { _id: 'missing' }, { count: 0 });

    expect(api.aggregate).not.toHaveBeenCalled();
    expect(undoToast.value).toBeNull();
  });

  it('uses the supplied undoMessage', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: '1' }] });
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 1 } });

    await runBulkDelete('c', {}, { count: 1, undoMessage: 'Removed thing' });

    expect(undoToast.value.message).toBe('Removed thing');
  });
});

import { runBulkUpdate } from '../src/mdh/bulkOps.js';

describe('runBulkUpdate', () => {
  beforeEach(() => { vi.clearAllMocks(); resetUndo(); });

  it('snapshots, updates, and undo restores via deleteMany + insertMany', async () => {
    const docs = [
      { _id: 'a', status: 'old' },
      { _id: 'b', status: 'old' },
    ];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 2, modified_count: 2 } });
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 2 } });
    api.insertMany.mockResolvedValueOnce({ result: {} });
    const onSuccess = vi.fn();

    await runBulkUpdate('c', {}, { $set: { status: 'new' } }, { count: 2, onSuccess });

    expect(api.aggregate).toHaveBeenCalledWith('c', [{ $match: {} }]);
    expect(api.updateMany).toHaveBeenCalledWith('c', {}, { $set: { status: 'new' } });
    expect(onSuccess).toHaveBeenCalledOnce();

    await triggerUndo();
    expect(api.deleteMany).toHaveBeenCalledWith('c', { _id: { $in: ['a', 'b'] } });
    expect(api.insertMany).toHaveBeenCalledWith('c', docs, false);
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('preserves $oid wrappers in undo restore filter for ObjectId collections', async () => {
    const oidA = { $oid: '67e8abcd1234567890abcdef' };
    const docs = [{ _id: oidA, n: 1 }];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 1, modified_count: 1 } });
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 1 } });
    api.insertMany.mockResolvedValueOnce({ result: {} });

    await runBulkUpdate('c', {}, { $set: { n: 2 } }, { count: 1 });
    await triggerUndo();

    expect(api.deleteMany).toHaveBeenCalledWith('c', { _id: { $in: [oidA] } });
    expect(api.insertMany).toHaveBeenCalledWith('c', docs, false);
  });

  it('skips snapshot and undo above UNDO_LIMIT', async () => {
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 5000, modified_count: 5000 } });
    await runBulkUpdate('c', {}, { $set: { x: 1 } }, { count: 5000 });
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(undoToast.value).toBeNull();
  });

  it('skips the undo toast when count is 0', async () => {
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 0, modified_count: 0 } });
    await runBulkUpdate('c', {}, { $set: {} }, { count: 0 });
    expect(undoToast.value).toBeNull();
  });
});
