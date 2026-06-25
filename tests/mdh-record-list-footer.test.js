// @vitest-environment jsdom
//
// The record-list footer was decluttered to show ONLY "Showing X–Y": the total
// count ("of N in collection (unfiltered)") and the query timing ("· Nms") now
// live in the Aggregate Pipeline Debug, so they were removed here — along with the
// >1s slow-query tint (record-count-slow), which moved to the debug timings.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {}, remove() {} } } };

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({ default: () => h('div', { class: 'record-card-stub' }) }));
vi.mock('../src/mdh/components/DownloadSplitButton.jsx', () => ({ default: () => h('div') }));
vi.mock('../src/mdh/components/StagesView.jsx', () => ({ default: () => h('div', { class: 'stages-view-stub' }) }));

import RecordList from '../src/mdh/components/RecordList.jsx';
import { skip, limit, selectedCollection, selectionMode, selectedIds, selectionPipelineDirty, resultsView, inspectTarget } from '../src/mdh/store.js';

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
  resultsView.value = 'list';
  inspectTarget.value = null;
});

describe('RecordList view switch', () => {
  it('renders a 3-way segmented switch and switches to Table in one click', async () => {
    const root = renderList();
    expect(root.querySelector('.view-toggle')).toBeNull();
    const seg = root.querySelector('.view-seg');
    expect(seg).not.toBeNull();
    const tableOpt = [...seg.querySelectorAll('.view-seg-opt')].find((b) => b.textContent.trim() === 'Table');
    expect(tableOpt).toBeTruthy();
    // One click switches — no dropdown to open first.
    await act(() => { tableOpt.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(root.querySelector('table.record-table')).not.toBeNull();
  });

  it('offers exactly List / Table / Stages (no JSON)', () => {
    const root = renderList();
    const labels = [...root.querySelectorAll('.view-seg-opt')].map((b) => b.textContent.trim());
    expect(labels).toEqual(['List', 'Table', 'Stages']);
  });

  it('marks the active view and falls back to List for the legacy "json" value', async () => {
    globalThis.chrome.storage.local.get = (keys, cb) => cb({ mdhResultsView: 'json' });
    const root = renderList();
    await act(() => {});
    const active = root.querySelector('.view-seg-opt.on');
    expect(active).toBeTruthy();
    expect(active.textContent.trim()).toBe('List');
    expect(root.querySelector('table.record-table')).toBeNull();
    globalThis.chrome.storage.local.get = (k, cb) => cb && cb({});
  });
});

describe('RecordList — stages view', () => {
  it('renders StagesView (not records) and hides pagination when view=stages', () => {
    resultsView.value = 'stages';
    const root = renderList({ entries: [{ disabled: false, stage: { $match: {} } }], onToggleStage() {} });
    expect(root.querySelector('.stages-view-stub')).not.toBeNull();
    expect(root.querySelector('.record-list')).toBeNull();
    expect(root.querySelector('.pagination')).toBeNull();
  });

  it('switches to the Stages view in one click via the segmented switch', async () => {
    const root = renderList();
    const stagesOpt = [...root.querySelectorAll('.view-seg-opt')].find((b) => b.textContent.trim() === 'Stages');
    expect(stagesOpt).toBeTruthy();
    await act(() => { stagesOpt.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(resultsView.value).toBe('stages');
    expect(root.querySelector('.stages-view-stub')).not.toBeNull();
  });

  it('shows record-action buttons present-but-disabled in stages view, with an explanatory tooltip; View stays enabled', () => {
    resultsView.value = 'stages';
    const root = renderList({ entries: [{ disabled: false, stage: { $match: {} } }], onToggleStage() {} });
    // Select + Expand All are still rendered, inside a greyed/inert group (not removed).
    const selectBtn = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Select');
    expect(selectBtn).toBeTruthy();
    expect(selectBtn.closest('.toolbar-group-disabled')).not.toBeNull();
    const expandBtn = [...root.querySelectorAll('button')].find((b) => /Expand All|Collapse All/.test(b.textContent));
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.closest('.toolbar-group-disabled')).not.toBeNull();
    // Every disabled group carries a tooltip (title) explaining why it's disabled.
    const disabledGroups = [...root.querySelectorAll('.toolbar-group-disabled')];
    expect(disabledGroups.length).toBeGreaterThanOrEqual(2); // Select/Expand group + Download/Bulk/Insert group
    for (const g of disabledGroups) {
      expect((g.getAttribute('title') || '').toLowerCase()).toContain('stages view');
    }
    // The View switch stays enabled (not inside a disabled group).
    const stagesOpt = [...root.querySelectorAll('.view-seg-opt')].find((b) => b.textContent.trim() === 'Stages');
    expect(stagesOpt).toBeTruthy();
    expect(stagesOpt.closest('.toolbar-group-disabled')).toBeNull();
  });
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
