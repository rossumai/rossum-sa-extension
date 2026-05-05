// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import { modalContent, selectedCollection } from '../src/mdh/store.js';
import { openBulkUpdate } from '../src/mdh/components/BulkUpdate.jsx';

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

describe('openBulkUpdate — filter mode', () => {
  it('shows preview with count and sample, and submit calls updateMany', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 2 }] })
      .mockResolvedValueOnce({ result: [{ _id: '1', status: 'old' }, { _id: '2', status: 'old' }] })
      .mockResolvedValueOnce({ result: [{ _id: '1', status: 'old' }, { _id: '2', status: 'old' }] }); // snapshot
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 2, modified_count: 2 } });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'filter', filter: { status: 'old' }, onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    // Default update expression is `{ "$set": {} }` — submit it.
    // Count is 2 → one-click mode (≤10), no typing required.
    const submitBtn = root.querySelector('[data-testid="bulk-submit"]');
    submitBtn.click();
    await flush();

    expect(api.updateMany).toHaveBeenCalledWith('vendors', { status: 'old' }, { $set: {} });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('forces the name-gate when the filter is exactly {}', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ total: 5 }] })
      .mockResolvedValueOnce({ result: [] });

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'filter', filter: {}, onSuccess: () => {}, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    const input = root.querySelector('[data-testid="bulk-confirm-input"]');
    expect(input.placeholder).toBe('vendors');
  });
});

describe('openBulkUpdate — selection mode', () => {
  it('uses ids→$in filter for updateMany', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }) // sample
      .mockResolvedValueOnce({ result: [{ _id: 'a' }, { _id: 'b' }] }); // snapshot
    api.updateMany.mockResolvedValueOnce({ result: { matched_count: 2, modified_count: 2 } });
    const onSuccess = vi.fn();

    const root = mountModal();
    openBulkUpdate({ collection: 'vendors', mode: 'selection', ids: ['a', 'b'], onSuccess, fieldsFn: () => [] });
    rerender(root);
    await flush();
    rerender(root);

    root.querySelector('[data-testid="bulk-submit"]').click();
    await flush();

    expect(api.updateMany).toHaveBeenCalledWith('vendors', { _id: { $in: ['a', 'b'] } }, { $set: {} });
    expect(onSuccess).toHaveBeenCalled();
  });
});
