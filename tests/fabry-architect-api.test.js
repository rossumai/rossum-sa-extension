import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({
  createCollection: vi.fn().mockResolvedValue({}),
  find: vi.fn(),
  insertOne: vi.fn().mockResolvedValue({}),
  updateOne: vi.fn().mockResolvedValue({}),
  deleteOne: vi.fn().mockResolvedValue({}),
}));

import * as mdh from '../src/mdh/api.js';
import * as api from '../src/fabry/architect/api.js';

beforeEach(() => vi.clearAllMocks());

describe('architect api v2', () => {
  it('uses the __mrfabry_architect collection', () => { expect(api.COLLECTION).toBe('__mrfabry_architect'); });

  it('ensureCollection tolerates already-exists but rethrows 401', async () => {
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 400 }));
    await expect(api.ensureCollection()).resolves.toBeUndefined();
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 }));
    await expect(api.ensureCollection()).rejects.toMatchObject({ status: 401 });
  });

  it('loadDeliverables maps docs and derives stale persisted results', async () => {
    mdh.find.mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, lastVerdict: 'pass', lastEvidence: 'ok', lastChatId: 'c1', ranAt: 111 },
      { _id: 'b', kind: 'requirement', text: '# B', order: 2 },
    ] });
    const { deliverables, results } = await api.loadDeliverables();
    expect(mdh.find).toHaveBeenCalledWith('__mrfabry_architect', { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
    expect(deliverables).toEqual([{ id: 'a', text: '# A', order: 1, title: '' }, { id: 'b', text: '# B', order: 2, title: '' }]);
    expect(results.a).toEqual({ verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 111, stale: true });
    expect(results.b).toBeUndefined(); // no lastVerdict → no result
  });

  it('loadDeliverables maps a persisted title verbatim', async () => {
    mdh.find.mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, title: 'A Nice Title' },
    ] });
    const { deliverables } = await api.loadDeliverables();
    expect(deliverables).toEqual([{ id: 'a', text: '# A', order: 1, title: 'A Nice Title' }]);
  });

  it('loadDeliverables tolerates a missing result envelope', async () => {
    mdh.find.mockResolvedValueOnce({});
    expect(await api.loadDeliverables()).toEqual({ deliverables: [], results: {}, implement: {} });
  });

  it('addDeliverable inserts the documented shape', async () => {
    await api.addDeliverable({ id: 'x', text: 'body', order: 3, createdAt: 111 });
    expect(mdh.insertOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x', kind: 'requirement', text: 'body', order: 3, createdAt: 111 });
  });
  it('updateDeliverable $sets text + editedAt', async () => {
    await api.updateDeliverable('x', 'new', 222);
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { text: 'new', editedAt: 222 } });
  });
  it('deleteDeliverable deletes by _id', async () => {
    await api.deleteDeliverable('x');
    expect(mdh.deleteOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' });
  });
  it('saveResult $sets the last-run fields', async () => {
    await api.saveResult('x', { verdict: 'fail', evidence: 'bad', chatId: 'c9', ranAt: 333 });
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { lastVerdict: 'fail', lastEvidence: 'bad', lastChatId: 'c9', ranAt: 333 } });
  });
  it('setOrder $sets order by _id', async () => {
    await api.setOrder('x', 4);
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { order: 4 } });
  });
  it('saveTitle $sets title by _id', async () => {
    await api.saveTitle('x', 'A Nice Title');
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { title: 'A Nice Title' } });
  });
});
