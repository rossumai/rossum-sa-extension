// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/agentApi.js', () => ({ createChat: vi.fn(), streamMessage: vi.fn() }));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '_SA_EXTENSION__fabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  resolveCollection: vi.fn().mockResolvedValue({ use: '_SA_EXTENSION__fabry_architect', legacy: null, action: 'none', migrated: false }),
  loadDeliverables: vi.fn().mockResolvedValue({ deliverables: [], results: {}, implement: {}, legacyCount: 0 }),
  addDeliverable: vi.fn().mockResolvedValue({}), updateDeliverable: vi.fn().mockResolvedValue({}),
  deleteDeliverable: vi.fn().mockResolvedValue({}), saveResult: vi.fn().mockResolvedValue({}),
  setOrder: vi.fn().mockResolvedValue({}), saveTitle: vi.fn().mockResolvedValue({}),
  listRevisions: vi.fn().mockResolvedValue({ result: [] }), getRevision: vi.fn().mockResolvedValue({ result: [] }),
  addRevision: vi.fn().mockResolvedValue({}), deleteRevisions: vi.fn().mockResolvedValue({}),
  deleteRevisionsFor: vi.fn().mockResolvedValue({}),
}));

import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import { updateDeliverable, restoreRevision, loadRevisions, deleteDeliverable, resetSession } from '../src/fabry/architect/actions.js';
import { CAP } from '../src/fabry/architect/revisionPolicy.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const seed = (text = 'v1', over = {}) => {
  store.deliverables.value = [{ id: 'd1', text, order: 1, title: '', titleSource: '', editedAt: 1000, createdAt: 500, ...over }];
};

beforeEach(() => {
  vi.clearAllMocks();
  // The editing session is module state by design (see resetSession) — without this, one
  // test's open session suppresses the next test's first snapshot.
  resetSession();
  vi.mocked(api.listRevisions).mockResolvedValue({ result: [] });
  vi.mocked(api.getRevision).mockResolvedValue({ result: [] });
  store.deliverables.value = [];
  store.revisions.value = {};
  store.revisionTexts.value = {};
  store.selectedRevision.value = null;
  store.loadError.value = null;
});

describe('version capture on save', () => {
  it('stores the PRE-EDIT text once per editing session, not once per autosave', async () => {
    seed('before');
    await updateDeliverable('d1', 'before + a');
    await updateDeliverable('d1', 'before + ab');
    await updateDeliverable('d1', 'before + abc');
    await flush();
    expect(api.addRevision).toHaveBeenCalledTimes(1);
    const doc = vi.mocked(api.addRevision).mock.calls[0][0];
    expect(doc).toMatchObject({ deliverableId: 'd1', text: 'before', source: 'edit' });
    expect(doc.id).toMatch(/^rev_/);
  });

  it('opens a new version when the source changes — an accepted Refine is its own act', async () => {
    seed('before');
    await updateDeliverable('d1', 'typed');
    await updateDeliverable('d1', 'agent wrote this', 'refine');
    await flush();
    expect(api.addRevision).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.addRevision).mock.calls[1][0]).toMatchObject({ text: 'typed', source: 'refine' });
  });

  it('never writes a version for a no-op save', async () => {
    seed('same');
    await updateDeliverable('d1', 'same');
    await flush();
    expect(api.addRevision).not.toHaveBeenCalled();
    expect(api.updateDeliverable).not.toHaveBeenCalled();
  });

  it('saves the text even when the history write fails', async () => {
    seed('before');
    vi.mocked(api.addRevision).mockRejectedValueOnce(new Error('history down'));
    await updateDeliverable('d1', 'after');
    await flush();
    expect(api.updateDeliverable).toHaveBeenCalledWith('d1', 'after', expect.any(Number));
    expect(store.loadError.value).toBe(null);   // history is best-effort and stays quiet
    expect(store.deliverables.value[0].text).toBe('after');
  });

  it('prunes past the cap, keeping the earliest', async () => {
    seed('before');
    const many = Array.from({ length: CAP + 3 }, (_, i) => ({ _id: `r${i}`, at: 1000 + i, source: 'edit' }));
    vi.mocked(api.listRevisions).mockResolvedValue({ result: many });
    await updateDeliverable('d1', 'after');
    await flush();
    const [, dropped] = vi.mocked(api.deleteRevisions).mock.calls[0];
    expect(dropped).toHaveLength(3);
    expect(dropped).not.toContain('r0');            // the earliest survives
    // Which ids, not in which order: they go out in one $in.
    expect([...dropped!].sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('takes the history with the deliverable when it is deleted', async () => {
    seed('x');
    await deleteDeliverable('d1');
    expect(api.deleteRevisionsFor).toHaveBeenCalledWith('d1');
  });
});

describe('restore', () => {
  it('snapshots the current text first, then writes the old text back', async () => {
    seed('current text');
    vi.mocked(api.getRevision).mockResolvedValueOnce({ result: [{ _id: 'r1', text: 'old text' }] });
    await restoreRevision('d1', 'r1');
    await flush();
    // The pre-restore text is preserved as its own version, which is what makes restore undoable.
    expect(api.addRevision).toHaveBeenCalledWith(expect.objectContaining({ text: 'current text', source: 'restore' }));
    expect(api.updateDeliverable).toHaveBeenCalledWith('d1', 'old text', expect.any(Number));
    expect(store.deliverables.value[0].text).toBe('old text');
  });

  it('reports a version that is no longer stored instead of writing an empty document', async () => {
    seed('current text');
    vi.mocked(api.getRevision).mockResolvedValueOnce({ result: [] });
    await restoreRevision('d1', 'gone');
    expect(api.updateDeliverable).not.toHaveBeenCalled();
    expect(store.loadError.value).toMatch(/no longer stored/i);
  });
});

describe('loadRevisions', () => {
  it('maps and sorts newest-first, and does not refetch what it already has', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ result: [
      { _id: 'a', at: 100, source: 'edit' }, { _id: 'b', at: 300, source: 'refine' },
    ] });
    await loadRevisions('d1');
    expect(store.revisions.value.d1.items.map((r: any) => r.id)).toEqual(['b', 'a']);
    await loadRevisions('d1');
    expect(api.listRevisions).toHaveBeenCalledTimes(1);
    await loadRevisions('d1', { force: true });
    expect(api.listRevisions).toHaveBeenCalledTimes(2);
  });

  it('records an error without throwing', async () => {
    vi.mocked(api.listRevisions).mockRejectedValueOnce(new Error('nope'));
    await loadRevisions('d1');
    expect(store.revisions.value.d1.error).toMatch(/nope/);
  });
});
