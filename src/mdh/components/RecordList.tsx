import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { track } from '../../usage/track.js';
import {
  skip,
  selectedCollection,
  selectionMode,
  selectedIds,
  selectionPipelineDirty,
  resultsView,
  inspectTarget,
} from '../store.js';

import RecordCard from './RecordCard.jsx';
import RecordTable from './RecordTable.jsx';
import StagesView from './StagesView.jsx';
import { deriveColumns } from '../recordColumns.js';
import JSON5 from 'json5';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { RESERVED_PX, CHAR_WIDTH_PX, MIN_CHAR_BUDGET } from '../recordSummary.js';
import { ALT_KEY } from '../platform.js';
import type { SortFilterControls } from '../hooks/usePipeline.js';

export default function RecordList({
  records,
  pipelineText,
  filterState,
  sortState,
  lastQueryMs,
  totalCount,
  pagination,
  onSort,
  onFilter,
  onPageChange,
  onEdit,
  onDelete,
  onRefresh,
  downloadState,
  onCancelDownload,
  onEnterSelectionMode,
  onExitSelectionMode,
  onBulkDelete,
  onBulkUpdate,
  onSelectPage,
  onClearSelection,
  onViewSelected,
  filtered = false,
  entries,
  rawStages,
  variables,
  onToggleStage,
}: SortFilterControls & {
  records: any[];
  pipelineText?: string;

  lastQueryMs?: any;
  totalCount?: number | null;
  pagination?: any;
  onPageChange: (direction: string) => void;
  onEdit: (record: any) => void;
  onDelete: (record: any, index?: number) => void;
  onRefresh: (action?: any) => void;
  downloadState?: any;
  onCancelDownload: () => void;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  onBulkDelete: () => void;
  onBulkUpdate: () => void;
  onSelectPage: (select?: boolean) => void;
  onClearSelection: () => void;
  onViewSelected: () => void;
  filtered?: boolean;
  entries?: any[];
  rawStages?: any[] | null;
  variables?: any[] | null;
  onToggleStage?: (i: number) => void;
}) {
  const [expandedSet, setExpandedSet] = useState(new Set([0]));
  const [expandAll, setExpandAll] = useState(false);
  const view = resultsView.value;

  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWidth, setListWidth] = useState(0);
  const [indexes, setIndexes] = useState<any[]>([]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Throttle: dragging the panel resizer fires the observer per pixel and
    // each setListWidth re-renders every RecordCard. Only update when the
    // width actually changes by enough to affect the char-budget calculation
    // (~one character at the smallest font), and coalesce with rAF.
    const WIDTH_THRESHOLD_PX = CHAR_WIDTH_PX;
    let lastReported = el.getBoundingClientRect().width;
    let pending = lastReported;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) pending = entry.contentRect.width;
      if (raf) return;
      if (typeof requestAnimationFrame !== 'function') return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (Math.abs(pending - lastReported) >= WIDTH_THRESHOLD_PX) {
          lastReported = pending;
          setListWidth(pending);
        }
      });
    });
    ro.observe(el);
    setListWidth(lastReported);
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadIndexes() {
      const col = selectedCollection.value;
      if (!col) {
        setIndexes([]);
        return;
      }
      const cached = cache.get(col, 'indexes');
      if (cached !== null) {
        setIndexes(cached);
        return;
      }
      try {
        const res = await api.listIndexes(col, false);
        const result = res.result || [];
        if (cancelled || selectedCollection.value !== col) return;
        cache.set(col, 'indexes', result);
        setIndexes(result);
      } catch {
        // Non-fatal: preview gracefully falls back to lower tiers.
      }
    }
    loadIndexes();
    return () => {
      cancelled = true;
    };
  }, [selectedCollection.value]);

  useEffect(() => {
    chrome.storage.local.get(['mdhResultsView'], ({ mdhResultsView }) => {
      if (mdhResultsView === 'table' || mdhResultsView === 'stages')
        resultsView.value = mdhResultsView;
    });
  }, []);
  function changeView(v: any) {
    // Count ENTERING the Stages view, not clicking the button: this control has
    // no `v === view` guard, so clicking the already-active option re-fires.
    //
    // Deliberately NOT collapsed with trackOnce (tried, reverted 2026-08-19).
    // The analogy to sa_mdh_query_run does not hold: runQuery is auto-invoked on
    // every keystroke, sort, filter and page change, so no user intent maps onto
    // a call — whereas this is a deliberate click, and someone who opens Stages
    // three times in a session used it three times.
    if (v === 'stages' && resultsView.value !== 'stages') track('sa_mdh_stages_view');
    resultsView.value = v;
    inspectTarget.value = null; // a manual view switch isn't a "jump to stage"
    chrome.storage.local.set({ mdhResultsView: v });
  }

  const charBudget =
    listWidth > 0
      ? Math.max(MIN_CHAR_BUDGET, Math.floor((listWidth - RESERVED_PX) / CHAR_WIDTH_PX))
      : MIN_CHAR_BUDGET;

  function toggleExpand(idx: any) {
    const next = new Set(expandedSet);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setExpandedSet(next);
    setExpandAll(false);
  }

  function toggleExpandAll() {
    if (expandAll || expandedSet.size >= records.length) {
      setExpandedSet(new Set());
      setExpandAll(false);
    } else {
      setExpandAll(true);
      setExpandedSet(new Set());
    }
  }

  const allExpanded = expandAll || (records.length > 0 && expandedSet.size >= records.length);

  let emptyContent = null;
  if (records.length === 0) {
    let hasNonTrivialPipeline =
      Object.keys(filterState).length > 0 || Object.keys(sortState).length > 0;
    if (!hasNonTrivialPipeline && pipelineText) {
      try {
        const pipeline = JSON5.parse(pipelineText);
        if (Array.isArray(pipeline)) {
          hasNonTrivialPipeline = pipeline.some((stage) => {
            if (stage.$match && Object.keys(stage.$match).length > 0) return true;
            if (stage.$project || stage.$group || stage.$unwind || stage.$lookup) return true;
            return false;
          });
        }
      } catch {
        /* ignore */
      }
    }

    if (skip.value > 0) {
      emptyContent = (
        <div class="record-list-empty">
          <p>No more records on this page</p>
          <p class="record-list-empty-hint">Try going back to the previous page</p>
        </div>
      );
    } else if (hasNonTrivialPipeline) {
      emptyContent = (
        <div class="record-list-empty">
          <p>0 records match the current query</p>
          <p class="record-list-empty-hint">Try modifying the pipeline or click Reset</p>
        </div>
      );
    } else {
      emptyContent = (
        <div class="record-list-empty">
          <p>No records</p>
        </div>
      );
    }
  }

  const s = skip.value;
  // The footer intentionally shows only "Showing X-Y". The total collection count
  // and the query timing (plus the >1s slow-query warning) now live in the Aggregate
  // Pipeline Debug, so `totalCount` / `lastQueryMs` are accepted (DataPanel still
  // passes them) but no longer rendered here.
  const countText =
    records.length > 0 ? `Showing ${s + 1}\u2013${s + records.length}` : 'No records';

  return (
    <div style="display:flex;flex-direction:column;flex:1;overflow:hidden">
      <div class="toolbar">
        {selectionMode.value ? (
          <SelectionToolbar
            records={records}
            onExit={onExitSelectionMode}
            onBulkDelete={onBulkDelete}
            onBulkUpdate={onBulkUpdate}
            onSelectPage={onSelectPage}
            onClearSelection={onClearSelection}
            onViewSelected={onViewSelected}
          />
        ) : (
          <DefaultToolbar
            allExpanded={allExpanded}
            toggleExpandAll={toggleExpandAll}
            downloadState={downloadState}
            onRefresh={onRefresh}
            onCancelDownload={onCancelDownload}
            onEnterSelectionMode={onEnterSelectionMode}
            onBulkDelete={onBulkDelete}
            onBulkUpdate={onBulkUpdate}
            view={view}
            changeView={changeView}
          />
        )}
      </div>
      {selectionMode.value && selectedIds.value.size > 0 && selectionPipelineDirty.value && (
        <div class="selection-mismatch-banner">
          {selectedIds.value.size} selected record{selectedIds.value.size !== 1 ? 's' : ''} may no
          longer match the current view.
          <button class="btn-link" onClick={onViewSelected}>
            View selected only
          </button>
        </div>
      )}
      {view === 'stages' ? (
        <StagesView
          collection={selectedCollection.value as string}
          entries={entries}
          rawStages={rawStages}
          variables={variables}
          onToggleStage={onToggleStage}
          inspectTarget={inspectTarget.value}
        />
      ) : (
        <div class="record-list" ref={listRef}>
          {emptyContent}
          {records.length > 0 && view === 'table' && (
            <RecordTable
              records={records}
              columns={deriveColumns(records)}
              sortState={sortState}
              filterState={filterState}
              onSort={onSort}
              onFilter={onFilter}
            />
          )}
          {records.length > 0 &&
            view === 'list' &&
            records.map((record, i) => (
              <RecordCard
                key={i}
                record={record}
                index={i}
                expanded={expandAll || expandedSet.has(i)}
                onToggle={toggleExpand}
                onCopy={() => {}}
                onEdit={onEdit}
                onDelete={onDelete}
                sortState={sortState}
                filterState={filterState}
                onSort={onSort}
                onFilter={onFilter}
                charBudget={charBudget}
                indexes={indexes}
              />
            ))}
        </div>
      )}
      {view !== 'stages' && (
        <div class="pagination">
          <span class="record-count">{countText}</span>
          <span class="pagination-hint">
            Click key to sort {'\u00b7'} Click value to filter {'\u00b7'} {ALT_KEY}+click to copy
          </span>
          <div class="pagination-controls">
            <button disabled={!pagination.hasPrev()} onClick={() => onPageChange('prev')}>
              {'\u2190'} Prev
            </button>
            <span>Page {pagination.page()}</span>
            <button
              disabled={!pagination.hasNext(records.length, filtered)}
              onClick={() => onPageChange('next')}
            >
              Next {'\u2192'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const STAGES_DISABLED_TITLE =
  'Unavailable in the Stages view — switch to List or Table to use this.';

function DefaultToolbar({
  allExpanded,
  toggleExpandAll,
  downloadState,
  onRefresh,
  onCancelDownload,
  onEnterSelectionMode,
  onBulkDelete,
  onBulkUpdate,
  view,
  changeView,
}: {
  allExpanded?: boolean;
  toggleExpandAll: () => void;
  downloadState?: any;
  onRefresh: (action?: any) => void;
  onCancelDownload: () => void;
  onEnterSelectionMode: () => void;
  onBulkDelete: () => void;
  onBulkUpdate: () => void;
  view?: string;
  changeView: (v: string) => void;
}) {
  // In the Stages view the record-list actions don't apply — keep them visible but
  // greyed/inert (so the toolbar doesn't collapse), with a tooltip explaining why,
  // and leave the View switch live. The disabling lives on the group wrappers (so
  // the tooltip can show on hover); the View switch stays outside them.
  const recordsDisabled = view === 'stages';
  const disabledTitle = recordsDisabled ? STAGES_DISABLED_TITLE : undefined;
  const disabledAttr = recordsDisabled ? 'true' : undefined;
  return (
    <div style="display:contents">
      <div class="toolbar-group">
        <span
          class={'toolbar-group' + (recordsDisabled ? ' toolbar-group-disabled' : '')}
          title={disabledTitle}
          aria-disabled={disabledAttr}
        >
          <button class="btn btn-sm" onClick={onEnterSelectionMode}>
            Select
          </button>
          <button class="btn btn-sm" onClick={toggleExpandAll}>
            {allExpanded ? 'Collapse All' : 'Expand All'}
          </button>
        </span>
        <ViewSwitch view={view} changeView={changeView} />
      </div>
      <div style="flex:1"></div>
      <div
        class={'toolbar-group' + (recordsDisabled ? ' toolbar-group-disabled' : '')}
        title={disabledTitle}
        aria-disabled={disabledAttr}
      >
        <BulkSplitButton onUpdate={onBulkUpdate} onDelete={onBulkDelete} />
        {downloadState ? (
          <span class="download-progress">
            <span class="download-progress-text">
              {downloadState.cancelled
                ? 'Cancelled'
                : downloadState.done
                  ? `\u2713 ${downloadState.count} records`
                  : `Downloading\u2026 ${downloadState.count}${downloadState.total ? ' / ' + downloadState.total : ''} records${downloadState.filtered ? ' (filtered)' : ''}`}
            </span>
            {!downloadState.cancelled && !downloadState.done && (
              <span class="download-bar">
                {downloadState.total > 0 ? (
                  <span
                    class="download-bar-fill"
                    style={`width:${Math.min(100, Math.round((downloadState.count / downloadState.total) * 100))}%`}
                  ></span>
                ) : (
                  <span class="download-bar-fill download-bar-indeterminate"></span>
                )}
              </span>
            )}
            {!downloadState.cancelled && !downloadState.done && (
              <button
                class="download-cancel-btn"
                title="Cancel download"
                onClick={onCancelDownload}
              >
                {'\u2715'}
              </button>
            )}
          </span>
        ) : (
          <button
            class="btn btn-sm"
            data-testid="export-open"
            title="Export collection"
            onClick={() => onRefresh('export')}
          >
            Export
          </button>
        )}
        <button class="btn btn-sm btn-success" onClick={() => onRefresh('import')}>
          Import
        </button>
      </div>
    </div>
  );
}

const VIEW_OPTIONS = [
  { value: 'list', label: 'List' },
  { value: 'table', label: 'Table' },
  { value: 'stages', label: 'Stages' },
];

// Segmented results-view switch: List / Table / Stages, one click to switch
// (replaces the old "View: ▾" dropdown that took two clicks).
function ViewSwitch({ view, changeView }: { view?: string; changeView: (v: string) => void }) {
  return (
    <div class="view-seg" role="group" title="Results view">
      {VIEW_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          class={'view-seg-opt' + (view === o.value ? ' on' : '')}
          aria-pressed={view === o.value}
          onClick={() => changeView(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BulkSplitButton({ onUpdate, onDelete }: { onUpdate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: any) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} class="dropdown-btn">
      <button
        class="btn btn-sm"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        Bulk {'\u25BE'}
      </button>
      {open && (
        <div class="toolbar-more-menu">
          <button
            class="toolbar-menu-item"
            onClick={() => {
              setOpen(false);
              onUpdate();
            }}
          >
            Update by filter
          </button>
          <button
            class="toolbar-menu-item toolbar-menu-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete by filter
          </button>
        </div>
      )}
    </div>
  );
}

function SelectionToolbar({
  records,
  onExit,
  onBulkDelete,
  onBulkUpdate,
  onSelectPage,
  onClearSelection,
  onViewSelected,
}: {
  records: any[];
  onExit: () => void;
  onBulkDelete: () => void;
  onBulkUpdate: () => void;
  onSelectPage: (select?: boolean) => void;
  onClearSelection: () => void;
  onViewSelected: () => void;
}) {
  const ids = selectedIds.value;
  const total = ids.size;
  const pageIds = records.map((r) => r._id?.$oid || String(r._id));
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => ids.has(id));
  const anyOnPageSelected = pageIds.some((id) => ids.has(id));
  const headerState = allOnPageSelected ? 'all' : anyOnPageSelected ? 'some' : 'none';
  const [popoverOpen, setPopoverOpen] = useState(false);

  function removeId(id: any) {
    const next = new Map(selectedIds.value);
    next.delete(id);
    selectedIds.value = next;
  }

  return (
    <div style="display:contents">
      <div class="toolbar-group">
        <button class="btn btn-sm" onClick={onExit}>
          Cancel
        </button>
        <button
          class="btn btn-sm"
          onClick={() => onSelectPage(headerState !== 'all')}
          title={headerState === 'all' ? 'Deselect all on page' : 'Select all on page'}
        >
          {headerState === 'all' ? 'Deselect page' : `Select page (${pageIds.length})`}
        </button>
        <div style="position:relative">
          <span
            class="selection-count"
            onClick={() => setPopoverOpen((v) => !v)}
            title="Click to review selected ids"
          >
            {total} selected
          </span>
          {popoverOpen && total > 0 && (
            <div class="selection-popover">
              {[...ids.keys()].map((id) => (
                <div class="selection-popover-row">
                  <span class="selection-popover-id">{id}</span>
                  <button
                    class="selection-popover-remove"
                    title="Remove from selection"
                    onClick={() => removeId(id)}
                  >
                    {'\u00D7'}
                  </button>
                </div>
              ))}
              <div class="selection-popover-actions">
                <button
                  class="btn-link"
                  onClick={() => {
                    setPopoverOpen(false);
                    onViewSelected();
                  }}
                >
                  View selected only
                </button>
                <button
                  class="btn-link"
                  onClick={() => {
                    setPopoverOpen(false);
                    onClearSelection();
                  }}
                >
                  Clear all
                </button>
              </div>
            </div>
          )}
        </div>
        {total > 0 && (
          <button class="btn-link" onClick={onClearSelection}>
            Clear
          </button>
        )}
      </div>
      <div style="flex:1"></div>
      <div class="toolbar-group">
        <button class="btn btn-sm" disabled={total === 0} onClick={onBulkUpdate}>
          Edit selected
        </button>
        <button class="btn btn-sm btn-danger" disabled={total === 0} onClick={onBulkDelete}>
          Delete selected
        </button>
      </div>
    </div>
  );
}
