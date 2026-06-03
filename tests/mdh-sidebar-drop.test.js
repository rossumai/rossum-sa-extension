// @vitest-environment jsdom
//
// Regression test for the drop-collection sidebar bug: POST /collections/drop
// is ASYNC (202 Accepted; the drop runs in the background), so performDrop must
// wait for the operation to FINISH before re-listing — otherwise loadCollections
// re-fetches the still-present collection and the sidebar looks unchanged.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import * as store from '../src/mdh/store.js';
import * as cache from '../src/mdh/cache.js';
import { _reset as resetUndo } from '../src/mdh/undo.js';
import { undoToast } from '../src/mdh/store.js';
import { performDrop } from '../src/mdh/components/Sidebar.jsx';

const OP_MESSAGE = 'Accepted, operation aaaaaaaaaaaaaaaaaaaaaaaa scheduled';
const OP_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidateAll();
  resetUndo();
  store.collections.value = ['keep', 'doomed'];
  store.selectedCollection.value = 'doomed';
  store.activeView.value = 'operations'; // avoid first-collection auto-select noise
  store.loading.value = false;
  store.error.value = null;
  // parseOperationId behaves like the real implementation in these tests.
  api.parseOperationId.mockImplementation(
    (m) => (typeof m === 'string' ? m.match(/[a-f0-9]{24}/i)?.[0] ?? null : null),
  );
});

describe('performDrop waits for the async drop before refreshing the sidebar', () => {
  it('removes the collection from the sidebar only after the drop operation finishes', async () => {
    let dropFinished = false;
    api.dropCollection.mockResolvedValue({ code: 'accept', message: OP_MESSAGE });
    api.waitForOperation.mockImplementation(async () => {
      dropFinished = true; // the background drop completes here
      return { status: 'FINISHED' };
    });
    // The server keeps listing the collection until the drop has finished.
    api.listCollections.mockImplementation(async () => ({
      result: dropFinished ? ['keep'] : ['keep', 'doomed'],
    }));

    await performDrop('doomed', null);

    expect(api.waitForOperation).toHaveBeenCalledWith(OP_ID);
    expect(store.collections.value).toEqual(['keep']); // gone from the sidebar
    expect(store.loading.value).toBe(false);
  });

  it('surfaces an error and leaves the collection listed if the drop operation fails', async () => {
    api.dropCollection.mockResolvedValue({ code: 'accept', message: OP_MESSAGE });
    api.waitForOperation.mockRejectedValue(new Error('drop failed: disk error'));
    api.listCollections.mockResolvedValue({ result: ['keep', 'doomed'] });

    await performDrop('doomed', null);

    expect(store.error.value).toEqual({ message: 'drop failed: disk error' });
    expect(api.listCollections).not.toHaveBeenCalled(); // never re-listed — drop failed
    expect(store.collections.value).toEqual(['keep', 'doomed']);
    expect(store.loading.value).toBe(false);
  });

  it('offers undo only after the drop has finished (no recreate-while-dropping race)', async () => {
    let undoVisibleDuringDrop = false;
    let dropFinished = false;
    api.dropCollection.mockResolvedValue({ code: 'accept', message: OP_MESSAGE });
    api.waitForOperation.mockImplementation(async () => {
      if (undoToast.value) undoVisibleDuringDrop = true; // toast must not exist yet
      dropFinished = true;
      return { status: 'FINISHED' };
    });
    api.listCollections.mockImplementation(async () => ({
      result: dropFinished ? ['keep'] : ['keep', 'doomed'],
    }));

    await performDrop('doomed', { docs: [], indexes: [] });

    expect(undoVisibleDuringDrop).toBe(false);
    expect(undoToast.value).toMatchObject({ message: 'Dropped "doomed"' });
  });

  it('falls back to an immediate reload when the response carries no operation id (sync 200)', async () => {
    api.dropCollection.mockResolvedValue({ code: 'success' }); // no message → no op id
    api.listCollections.mockResolvedValue({ result: ['keep'] });

    await performDrop('doomed', null);

    expect(api.waitForOperation).not.toHaveBeenCalled();
    expect(store.collections.value).toEqual(['keep']);
  });
});
