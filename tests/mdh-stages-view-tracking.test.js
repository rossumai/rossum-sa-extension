// @vitest-environment jsdom
//
// sa_mdh_stages_view counts ENTERING the Stages view, not clicking the button.
//
// Two ways it used to over-count: the segmented control calls changeView(o.value)
// with no `v === view` guard, so clicking the already-active Stages option
// re-fired; and DataPanel's debug-panel row click tracked on every stage jump,
// including while Stages was already open. It was briefly "fixed" with
// trackOnce, which threw away the frequency the event exists to report — a
// deliberate open is not the same as useQuery's auto-invoked runQuery.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {}, remove() {} } } };

vi.mock('../src/usage/track.js', () => ({ track: vi.fn(), trackOnce: vi.fn() }));
vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/components/RecordCard.jsx', () => ({ default: () => h('div', { class: 'record-card-stub' }) }));
vi.mock('../src/mdh/components/StagesView.jsx', () => ({ default: () => h('div', { class: 'stages-view-stub' }) }));

import RecordList from '../src/mdh/components/RecordList.jsx';
import { track, trackOnce } from '../src/usage/track.js';
import { skip, selectedCollection, selectionMode, selectedIds, selectionPipelineDirty, resultsView, inspectTarget } from '../src/mdh/store.js';

const pagination = { hasPrev: () => false, hasNext: () => false, page: () => 1 };

function renderList() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(RecordList, {
    records: [{ _id: '1' }], pipelineText: '[]', filterState: {}, sortState: {},
    lastQueryMs: 0, totalCount: null, pagination,
    onSort() {}, onFilter() {}, onPageChange() {}, onEdit() {}, onDelete() {}, onRefresh() {},
    downloadState: null, onCancelDownload() {}, onEnterSelectionMode() {}, onExitSelectionMode() {},
    onBulkDelete() {}, onBulkUpdate() {}, onSelectPage() {}, onClearSelection() {}, onViewSelected() {},
  }), root);
  return root;
}

const clickView = (root, label) => act(() => {
  const btn = [...root.querySelectorAll('.view-seg-opt')].find((b) => b.textContent.trim() === label);
  if (!btn) throw new Error(`no "${label}" view button`);
  btn.click();
});

describe('sa_mdh_stages_view', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    skip.value = 0; selectedCollection.value = 'c'; selectionMode.value = false;
    selectedIds.value = new Set(); selectionPipelineDirty.value = false;
    resultsView.value = 'list'; inspectTarget.value = null;
  });

  it('reports once when the Stages view is opened', () => {
    const root = renderList();
    clickView(root, 'Stages');
    expect(track).toHaveBeenCalledWith('sa_mdh_stages_view');
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-report when the already-active Stages option is clicked again', () => {
    const root = renderList();
    clickView(root, 'Stages');
    clickView(root, 'Stages');
    clickView(root, 'Stages');
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('reports each separate open, because "how often" is the point', () => {
    const root = renderList();
    clickView(root, 'Stages');
    clickView(root, 'List');
    clickView(root, 'Stages');
    clickView(root, 'Table');
    clickView(root, 'Stages');
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('reports nothing for switching between List and Table', () => {
    const root = renderList();
    clickView(root, 'Table');
    clickView(root, 'List');
    expect(track).not.toHaveBeenCalled();
  });

  it('does not use trackOnce, which would collapse every open into one', () => {
    const root = renderList();
    clickView(root, 'Stages');
    expect(trackOnce).not.toHaveBeenCalled();
  });
});
