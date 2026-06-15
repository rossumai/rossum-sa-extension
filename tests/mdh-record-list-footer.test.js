// @vitest-environment jsdom
//
// The record-list footer was decluttered to show ONLY "Showing X–Y": the total
// count ("of N in collection (unfiltered)") and the query timing ("· Nms") now
// live in the Aggregate Pipeline Debug, so they were removed here — along with the
// >1s slow-query tint (record-count-slow), which moved to the debug timings.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {}, remove() {} } } };

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({ default: () => h('div', { class: 'record-card-stub' }) }));
vi.mock('../src/mdh/components/DownloadSplitButton.jsx', () => ({ default: () => h('div') }));

import RecordList from '../src/mdh/components/RecordList.jsx';
import { skip, limit, selectedCollection, selectionMode, selectedIds, selectionPipelineDirty } from '../src/mdh/store.js';

const pagination = { hasPrev: () => false, hasNext: () => false, page: () => 1 };

function renderList(props = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(RecordList, {
    records: [{ _id: '1' }, { _id: '2' }],
    pipelineText: '[]', filterState: {}, sortState: {},
    lastQueryMs: 0, totalCount: null, pagination,
    onSort() {}, onFilter() {}, onPageChange() {}, onEdit() {}, onDelete() {}, onRefresh() {},
    downloadState: null, onCancelDownload() {}, onEnterSelectionMode() {}, onExitSelectionMode() {},
    onBulkDelete() {}, onBulkUpdate() {}, onSelectPage() {}, onClearSelection() {}, onViewSelected() {},
    ...props,
  }), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  skip.value = 0;
  limit.value = 50;
  selectedCollection.value = null;
  selectionMode.value = false;
  selectedIds.value = new Map();
  selectionPipelineDirty.value = false;
});

describe('RecordList footer', () => {
  it('shows only "Showing X–Y" — no total count, no timing', () => {
    const root = renderList({ totalCount: 162, lastQueryMs: 277 });
    const count = root.querySelector('.record-count');
    expect(count).not.toBeNull();
    expect(count.textContent).toBe('Showing 1–2');
    expect(count.textContent).not.toContain('in collection');
    expect(count.textContent).not.toContain('162');
    expect(count.textContent).not.toContain('ms');
  });

  it('does not apply the slow-query tint, even for a slow (>1s) query', () => {
    const root = renderList({ totalCount: 162, lastQueryMs: 5000 });
    const count = root.querySelector('.record-count');
    expect(count.classList.contains('record-count-slow')).toBe(false);
  });

  it('still shows "No records" when there are no records', () => {
    const root = renderList({ records: [], totalCount: 162, lastQueryMs: 277 });
    expect(root.querySelector('.record-count').textContent).toBe('No records');
  });
});
