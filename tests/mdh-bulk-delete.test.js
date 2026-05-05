// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import { modalContent, selectedCollection } from '../src/mdh/store.js';
import { openBulkDelete } from '../src/mdh/components/BulkDelete.jsx';

function mountModal() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Modal, null), root);
  return root;
}

function rerender(root) { render(h(Modal, null), root); }

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  modalContent.value = null;
  selectedCollection.value = 'vendors';
});

describe('openBulkDelete — filter mode', () => {
  it('opens with the prefilled filter and runs preview against the API', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 3 }] })
      .mockResolvedValueOnce({ result: [{ _id: '1' }, { _id: '2' }, { _id: '3' }] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: { status: 'draft' }, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector('[data-testid="bulk-preview-count"]').textContent).toContain('3');
  });

  it('disables submit while the preview is loading', async () => {
    let resolveCount;
    api.aggregate.mockReturnValueOnce(new Promise((r) => { resolveCount = r; }));
    api.aggregate.mockResolvedValueOnce({ result: [] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(true);

    resolveCount({ result: [{ total: 0 }] });
    await flush();
    rerender(root);
    // count = 0 — still disabled, but for a different reason (nothing to delete).
    expect(root.querySelector('[data-testid="bulk-submit"]').disabled).toBe(true);
  });

  it('forces the name-gate when the filter is exactly {}', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 7 }] })
      .mockResolvedValueOnce({ result: [] });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    expect(input.placeholder).toBe('vendors');
  });
});

describe('openBulkDelete — selection mode', () => {
  it('uses the ids→$in filter and shows the count from ids.length without re-counting', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // sample only

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    expect(root.querySelector('[data-testid="bulk-preview-count"]').textContent).toContain('2');
    // Selection mode does not call $count — only the sample query.
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });

  it('runs deleteMany with the $in filter on submit', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // snapshot
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 2 } });
    api.insertMany.mockResolvedValueOnce({ result: {} });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector('[data-testid="bulk-submit"]').click();
    await flush();

    expect(api.deleteMany).toHaveBeenCalledWith('vendors', { _id: { $in: ['a', 'b'] } });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('preserves $oid wrapper in the $in filter (round-trips through deleteMany)', async () => {
    const oidA = { $oid: '67e8abcd1234567890abcdef' };
    const oidB = { $oid: '67e8abcd1234567890abcdee' };
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: oidA }, { _id: oidB }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: oidA }, { _id: oidB }] }); // snapshot
    api.deleteMany.mockResolvedValueOnce({ result: { deleted_count: 2 } });
    api.insertMany.mockResolvedValueOnce({ result: {} });

    const root = mountModal();
    openBulkDelete({ collection: 'vendors', mode: 'selection', ids: [oidA, oidB], onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector('[data-testid="bulk-submit"]').click();
    await flush();

    // The $in array must contain the original wrapped objects, not stringified.
    expect(api.deleteMany).toHaveBeenCalledWith('vendors', {
      _id: { $in: [oidA, oidB] },
    });
  });
});
