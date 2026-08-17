import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({
  listCollections: vi.fn(), createCollection: vi.fn(), renameCollection: vi.fn(),
  find: vi.fn(), insertOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn(), deleteMany: vi.fn(),
}));

import * as mdh from '../src/mdh/api.js';
import * as api from '../src/fabry/architect/api.js';

const NEW = '_SA_EXTENSION__fabry_architect';
const OLD = '__mrfabry_architect';
const listing = (...names) => ({ result: names });
const err = (message, status = 400) => Object.assign(new Error(message), { status });

beforeEach(() => {
  vi.clearAllMocks();
  api.resetCollection();
  mdh.createCollection.mockResolvedValue({});
  mdh.renameCollection.mockResolvedValue({});
  mdh.find.mockResolvedValue({ result: [] });
  mdh.deleteMany.mockResolvedValue({});
});

describe('resolveCollection', () => {
  it('creates the new collection on a fresh org', async () => {
    mdh.listCollections.mockResolvedValueOnce(listing('suppliers'));
    const r = await api.resolveCollection();
    expect(r.action).toBe('create');
    expect(mdh.createCollection).toHaveBeenCalledWith(NEW);
    expect(api.activeCollection()).toBe(NEW);
    expect(api.legacyCollection()).toBe(null);
  });

  it('does nothing when the new collection already exists', async () => {
    mdh.listCollections.mockResolvedValueOnce(listing(NEW, 'suppliers'));
    const r = await api.resolveCollection();
    expect(r.action).toBe('none');
    expect(mdh.createCollection).not.toHaveBeenCalled();
    expect(mdh.renameCollection).not.toHaveBeenCalled();
  });

  it('migrates a legacy-only org by renaming', async () => {
    mdh.listCollections.mockResolvedValueOnce(listing(OLD, 'suppliers'));
    const r = await api.resolveCollection();
    expect(mdh.renameCollection).toHaveBeenCalledWith(OLD, NEW, false);
    expect(r.migrated).toBe(true);
    expect(api.activeCollection()).toBe(NEW);
  });

  it('KEEPS WORKING on the legacy collection when the rename cannot happen', async () => {
    // "Older customers where we cannot rename it now": no throw, no error banner, and the
    // next boot tries again.
    mdh.listCollections.mockResolvedValueOnce(listing(OLD));
    mdh.renameCollection.mockRejectedValueOnce(err('permission denied', 403));
    const r = await api.resolveCollection();
    expect(r.use).toBe(OLD);
    expect(r.migrated).toBe(false);
    expect(r.migrateError).toContain('permission denied');
    expect(api.activeCollection()).toBe(OLD);
  });

  it('treats a lost rename race as the merge state — both collections now exist', async () => {
    mdh.listCollections.mockResolvedValueOnce(listing(OLD));
    mdh.renameCollection.mockRejectedValueOnce(err('target namespace exists'));  // LIVE-VERIFIED wording
    const r = await api.resolveCollection();
    expect(r.action).toBe('merge');
    expect(r.raceLost).toBe(true);
    expect(api.activeCollection()).toBe(NEW);
    expect(api.legacyCollection()).toBe(OLD);
  });

  it('rethrows a 401 rather than silently downgrading', async () => {
    mdh.listCollections.mockResolvedValueOnce(listing(OLD));
    mdh.renameCollection.mockRejectedValueOnce(err('Session expired.', 401));
    await expect(api.resolveCollection()).rejects.toMatchObject({ status: 401 });
  });

  it('falls back to the legacy name when it cannot even list — never creates a second collection', async () => {
    mdh.listCollections.mockRejectedValueOnce(err('boom', 500));
    const r = await api.resolveCollection();
    expect(r.use).toBe(OLD);
    expect(mdh.createCollection).not.toHaveBeenCalled();
    expect(mdh.renameCollection).not.toHaveBeenCalled();
  });
});

describe('loadDeliverables in the merge state', () => {
  const doc = (id, over = {}) => ({ _id: id, kind: 'requirement', text: 't' + id, order: 1, ...over });

  beforeEach(() => { api.resetCollection(NEW, OLD); });

  it('reads both collections, prefers the newest edit, and reports the legacy remainder', async () => {
    mdh.find
      .mockResolvedValueOnce({ result: [doc('a', { text: 'new a', editedAt: 200 })] })   // new
      .mockResolvedValueOnce({ result: [doc('a', { text: 'old a', editedAt: 100 }), doc('b', { text: 'legacy only' })] });
    const { deliverables, legacyCount } = await api.loadDeliverables();
    expect(mdh.find).toHaveBeenNthCalledWith(1, NEW, expect.anything());
    expect(mdh.find).toHaveBeenNthCalledWith(2, OLD, expect.anything());
    expect(deliverables.map((d) => d.text)).toEqual(['new a', 'legacy only']);
    expect(legacyCount).toBe(1);
  });

  it('routes a write to the collection the document actually lives in', async () => {
    mdh.find
      .mockResolvedValueOnce({ result: [doc('a')] })
      .mockResolvedValueOnce({ result: [doc('b')] });
    await api.loadDeliverables();
    await api.updateDeliverable('a', 'x', 1);
    await api.updateDeliverable('b', 'y', 2);
    // 'b' exists only in the legacy collection: writing it against the new one would match
    // zero documents and lose the edit silently.
    expect(mdh.updateOne).toHaveBeenNthCalledWith(1, NEW, { _id: 'a' }, expect.anything());
    expect(mdh.updateOne).toHaveBeenNthCalledWith(2, OLD, { _id: 'b' }, expect.anything());
  });

  it('survives an unreadable legacy collection', async () => {
    mdh.find
      .mockResolvedValueOnce({ result: [doc('a')] })
      .mockRejectedValueOnce(err('nope', 500));
    const { deliverables, legacyCount } = await api.loadDeliverables();
    expect(deliverables.map((d) => d.id)).toEqual(['a']);
    expect(legacyCount).toBe(0);
  });

  it('sends a NEW deliverable to the new collection even while legacy is being read', async () => {
    await api.addDeliverable({ id: 'z', text: 'body', order: 9, createdAt: 1 });
    expect(mdh.insertOne).toHaveBeenCalledWith(NEW, expect.objectContaining({ _id: 'z', kind: 'requirement' }));
  });
});

describe('revision documents', () => {
  it('lists newest-first without pulling the text', async () => {
    await api.listRevisions('d1');
    expect(mdh.find).toHaveBeenCalledWith(NEW, {
      query: { kind: 'revision', deliverableId: 'd1' },
      projection: { text: 0 }, sort: { at: -1 }, limit: 41,
    });
  });

  it('inserts the documented shape, invisible to a kind:requirement reader', async () => {
    await api.addRevision({ id: 'r1', deliverableId: 'd1', text: 'before', at: 5, source: 'edit' });
    expect(mdh.insertOne).toHaveBeenCalledWith(NEW, {
      _id: 'r1', kind: 'revision', deliverableId: 'd1', text: 'before', at: 5, source: 'edit',
    });
  });

  it('fetches one revision text by id', async () => {
    await api.getRevision('d1', 'r1');
    expect(mdh.find).toHaveBeenCalledWith(NEW, { query: { kind: 'revision', _id: 'r1' }, limit: 1 });
  });

  it('prunes by id, and does not call out at all for an empty plan', async () => {
    await api.deleteRevisions('d1', ['r1', 'r2']);
    expect(mdh.deleteMany).toHaveBeenCalledWith(NEW, { kind: 'revision', _id: { $in: ['r1', 'r2'] } });
    mdh.deleteMany.mockClear();
    await api.deleteRevisions('d1', []);
    expect(mdh.deleteMany).not.toHaveBeenCalled();
  });

  it('drops a deleted deliverable history so the collection cannot accrete orphans', async () => {
    await api.deleteRevisionsFor('d1');
    expect(mdh.deleteMany).toHaveBeenCalledWith(NEW, { kind: 'revision', deliverableId: 'd1' });
  });
});
