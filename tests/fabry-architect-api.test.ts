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
  it('no longer offers a manual state write, and no longer maps the fields', async () => {
    // Dropped 2026-08-19 (owner): status is the check verdict alone. Existing documents keep their
    // `state`/`stateDate` — retiring a feature must not delete customer data.
    // The point of the assertion is that the export is GONE, so it cannot be named directly.
    expect((api as any).saveState).toBeUndefined();
    vi.mocked(mdh.find).mockResolvedValueOnce({ result: [{ _id: 'a', kind: 'requirement', text: 'x', order: 1, state: 'verified', stateDate: '2026-08-12' }] });
    const { deliverables } = await api.loadDeliverables();
    // Same for the retired fields: still on the stored document, deliberately not on the type.
    expect((deliverables[0] as any).state).toBeUndefined();
    expect((deliverables[0] as any).stateDate).toBeUndefined();
  });

  it('uses the _SA_EXTENSION__fabry_architect collection', () => { expect(api.COLLECTION).toBe('_SA_EXTENSION__fabry_architect'); });

  it('ensureCollection tolerates already-exists but rethrows 401', async () => {
    vi.mocked(mdh.createCollection).mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 400 }));
    await expect(api.ensureCollection()).resolves.toBeUndefined();
    vi.mocked(mdh.createCollection).mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 }));
    await expect(api.ensureCollection()).rejects.toMatchObject({ status: 401 });
  });

  it('loadDeliverables maps docs and derives stale persisted results', async () => {
    vi.mocked(mdh.find).mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, lastVerdict: 'pass', lastEvidence: 'ok', lastChatId: 'c1', ranAt: 111 },
      { _id: 'b', kind: 'requirement', text: '# B', order: 2 },
    ] });
    const { deliverables, results } = await api.loadDeliverables();
    expect(mdh.find).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
    // `state`/`stateDate` are no longer mapped at all: the manual state was dropped on 2026-08-19 and
    // status comes from the check verdict. Existing docs keep the fields; nothing reads them.
    // createdAt/editedAt are carried so the merge in collectionPlan.js can pick the newest
    // edit when two collections hold the same id, and so History can date an entry.
    expect(deliverables).toEqual([
      { id: 'a', text: '# A', order: 1, title: '', titleSource: '', createdAt: null, editedAt: null },
      { id: 'b', text: '# B', order: 2, title: '', titleSource: '', createdAt: null, editedAt: null },
    ]);
    expect(results.a).toEqual({ verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 111, stale: true });
    expect(results.b).toBeUndefined(); // no lastVerdict → no result
  });

  it('loadDeliverables maps a persisted title verbatim', async () => {
    vi.mocked(mdh.find).mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, title: 'A Nice Title' },
    ] });
    const { deliverables } = await api.loadDeliverables();
    expect(deliverables).toEqual([{ id: 'a', text: '# A', order: 1, title: 'A Nice Title', titleSource: '', createdAt: null, editedAt: null }]);
  });



  it('loadDeliverables tolerates a missing result envelope', async () => {
    vi.mocked(mdh.find).mockResolvedValueOnce({});
    expect(await api.loadDeliverables()).toEqual({ deliverables: [], results: {}, implement: {}, legacyCount: 0 });
  });

  it('addDeliverable inserts the documented shape', async () => {
    await api.addDeliverable({ id: 'x', text: 'body', order: 3, createdAt: 111 });
    expect(mdh.insertOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x', kind: 'requirement', text: 'body', order: 3, createdAt: 111 });
  });
  it('updateDeliverable $sets text + editedAt', async () => {
    await api.updateDeliverable('x', 'new', 222);
    expect(mdh.updateOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x' }, { $set: { text: 'new', editedAt: 222 } });
  });
  it('deleteDeliverable deletes by _id', async () => {
    await api.deleteDeliverable('x');
    expect(mdh.deleteOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x' });
  });
  it('saveResult $sets the last-run fields', async () => {
    await api.saveResult('x', { verdict: 'fail', evidence: 'bad', chatId: 'c9', ranAt: 333 });
    expect(mdh.updateOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x' }, { $set: { lastVerdict: 'fail', lastEvidence: 'bad', lastChatId: 'c9', ranAt: 333 } });
  });
  it('setOrder $sets order by _id', async () => {
    await api.setOrder('x', 4);
    expect(mdh.updateOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x' }, { $set: { order: 4 } });
  });
  it('saveTitle $sets title + its source by _id', async () => {
    await api.saveTitle('x', 'A Nice Title', 'manual');
    expect(mdh.updateOne).toHaveBeenCalledWith('_SA_EXTENSION__fabry_architect', { _id: 'x' }, { $set: { title: 'A Nice Title', titleSource: 'manual' } });
  });

  it('loadDeliverables maps titleSource, defaulting legacy docs (no marker) to ""', async () => {
    vi.mocked(mdh.find).mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, title: 'Renamed', titleSource: 'manual' },
      { _id: 'b', kind: 'requirement', text: '# B', order: 2, title: 'Generated', titleSource: 'ai' },
      { _id: 'c', kind: 'requirement', text: '# C', order: 3, title: 'Legacy' },
    ] });
    const { deliverables } = await api.loadDeliverables();
    expect(deliverables.map((d) => d.titleSource)).toEqual(['manual', 'ai', '']);
  });
});
