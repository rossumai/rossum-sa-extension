import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { skip, selectedCollection, selectionMode, selectedIds, selectionPipelineDirty } from '../store.js';
import RecordCard from './RecordCard.jsx';
import DownloadSplitButton from './DownloadSplitButton.jsx';
import JSON5 from 'json5';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { RESERVED_PX, CHAR_WIDTH_PX, MIN_CHAR_BUDGET } from '../recordSummary.js';
import { ALT_KEY } from '../platform.js';

export default function RecordList({
  records, pipelineText, filterState, sortState, lastQueryMs, totalCount, pagination,
  onSort, onFilter, onPageChange, onEdit, onDelete, onRefresh, downloadState, onCancelDownload,
  onEnterSelectionMode, onExitSelectionMode, onBulkDelete, onBulkUpdate, onSelectPage, onClearSelection,
  onViewSelected,
}) {
  const [expandedSet, setExpandedSet] = useState(new Set([0]));
  const [expandAll, setExpandAll] = useState(false);

  const listRef = useRef(null);
  const [listWidth, setListWidth] = useState(0);
  const [indexes, setIndexes] = useState([]);

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
    return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadIndexes() {
      const col = selectedCollection.value;
      if (!col) { setIndexes([]); return; }
      const cached = cache.get(col, 'indexes');
      if (cached !== null) { setIndexes(cached); return; }
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
    return () => { cancelled = true; };
  }, [selectedCollection.value]);

  const charBudget = listWidth > 0
    ? Math.max(MIN_CHAR_BUDGET, Math.floor((listWidth - RESERVED_PX) / CHAR_WIDTH_PX))
    : MIN_CHAR_BUDGET;

  function toggleExpand(idx) {
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
    let hasNonTrivialPipeline = Object.keys(filterState).length > 0 || Object.keys(sortState).length > 0;
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
      } catch { /* ignore */ }
    }

    if (skip.value > 0) {
      emptyContent = <div class="record-list-empty"><p>No more records on this page</p><p class="record-list-empty-hint">Try going back to the previous page</p></div>;
    } else if (hasNonTrivialPipeline) {
      emptyContent = <div class="record-list-empty"><p>0 records match the current query</p><p class="record-list-empty-hint">Try modifying the pipeline or click Reset</p></div>;
    } else {
      emptyContent = <div class="record-list-empty"><p>No records</p></div>;
    }
  }

  const s = skip.value;
  // The footer intentionally shows only "Showing X-Y". The total collection count
  // and the query timing (plus the >1s slow-query warning) now live in the Aggregate
  // Pipeline Debug, so `totalCount` / `lastQueryMs` are accepted (DataPanel still
  // passes them) but no longer rendered here.
  const countText = records.length > 0 ? `Showing ${s + 1}\u2013${s + records.length}` : 'No records';

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
          />
        )}
      </div>
      {selectionMode.value && selectedIds.value.size > 0 && selectionPipelineDirty.value && (
        <div class="selection-mismatch-banner">
          {selectedIds.value.size} selected record{selectedIds.value.size !== 1 ? 's' : ''} may no longer match the current view.
          <button class="btn-link" onClick={onViewSelected}>View selected only</button>
        </div>
      )}
      <div class="record-list" ref={listRef}>
        {emptyContent}
        {records.map((record, i) => (
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
      <div class="pagination">
        <span class="record-count">{countText}</span>
        <span class="pagination-hint">Click key to sort {'\u00b7'} Click value to filter {'\u00b7'} {ALT_KEY}+click to copy</span>
        <div class="pagination-controls">
          <button disabled={!pagination.hasPrev()} onClick={() => onPageChange('prev')}>{'\u2190'} Prev</button>
          <span>Page {pagination.page()}</span>
          <button disabled={!pagination.hasNext(records.length)} onClick={() => onPageChange('next')}>Next {'\u2192'}</button>
        </div>
      </div>
    </div>
  );
}

function SplitButton({ label, cls, onMain, menuItems = [] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} class="split-btn">
      <button class={`btn btn-sm ${cls}`} onClick={onMain}>{label}</button>
      <button class={`btn btn-sm split-btn-drop ${cls}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{'\u25BE'}</button>
      {open && (
        <div class="toolbar-more-menu">
          {menuItems.map((item) => (
            <button key={item.label} class="toolbar-menu-item" onClick={() => { setOpen(false); item.onClick(); }}>
              {item.label}{item.beta && <span class="toolbar-menu-beta">beta</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DefaultToolbar({ allExpanded, toggleExpandAll, downloadState, onRefresh, onCancelDownload, onEnterSelectionMode, onBulkDelete, onBulkUpdate }) {
  return (
    <div style="display:contents">
      <div class="toolbar-group">
        <button class="btn btn-sm" onClick={onEnterSelectionMode}>Select</button>
        <button class="btn btn-sm" onClick={toggleExpandAll}>{allExpanded ? 'Collapse All' : 'Expand All'}</button>
      </div>
      <div style="flex:1"></div>
      <div class="toolbar-group">
        {downloadState ? (
          <span class="download-progress">
            <span class="download-progress-text">
              {downloadState.counting
                ? 'Counting matching documents\u2026'
                : downloadState.cancelled
                  ? 'Cancelled'
                  : downloadState.done
                    ? `\u2713 ${downloadState.count} records`
                    : `Downloading\u2026 ${downloadState.count}${downloadState.total ? ' / ' + downloadState.total : ''} records${downloadState.filtered ? ' (filtered)' : ''}`}
            </span>
            {!downloadState.cancelled && !downloadState.done && (
              <span class="download-bar">
                {!downloadState.counting && downloadState.total > 0
                  ? <span class="download-bar-fill" style={`width:${Math.min(100, Math.round((downloadState.count / downloadState.total) * 100))}%`}></span>
                  : <span class="download-bar-fill download-bar-indeterminate"></span>
                }
              </span>
            )}
            {!downloadState.cancelled && !downloadState.done && (
              <button class="download-cancel-btn" title="Cancel download" onClick={onCancelDownload}>{'\u2715'}</button>
            )}
          </span>
        ) : (
          <DownloadSplitButton
            onAllJson={() => onRefresh('download')}
            onFilteredJson={() => onRefresh('download-filtered')}
            onAllCsv={() => onRefresh('download-csv')}
            onFilteredCsv={() => onRefresh('download-filtered-csv')}
            onAllXml={() => onRefresh('download-xml')}
            onFilteredXml={() => onRefresh('download-filtered-xml')}
            onAllJsonl={() => onRefresh('download-jsonl')}
            onFilteredJsonl={() => onRefresh('download-filtered-jsonl')}
          />
        )}
        <BulkSplitButton onUpdate={onBulkUpdate} onDelete={onBulkDelete} />
        <SplitButton
          label="Insert"
          cls="btn-success"
          onMain={() => onRefresh('insert')}
          menuItems={[
            { label: 'From JSON file', onClick: () => onRefresh('insert-file') },
            { label: 'From JSONL file', beta: true, onClick: () => onRefresh('insert-jsonl-file') },
            { label: 'From CSV file', beta: true, onClick: () => onRefresh('insert-csv-file') },
            { label: 'From Excel file', beta: true, onClick: () => onRefresh('insert-xlsx-file') },
            { label: 'From XML file', beta: true, onClick: () => onRefresh('insert-xml-file') },
          ]}
        />
      </div>
    </div>
  );
}

function BulkSplitButton({ onUpdate, onDelete }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} class="dropdown-btn">
      <button class="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        Bulk {'\u25BE'}
      </button>
      {open && (
        <div class="toolbar-more-menu">
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); onUpdate(); }}>Update by filter</button>
          <button class="toolbar-menu-item toolbar-menu-danger" onClick={() => { setOpen(false); onDelete(); }}>Delete by filter</button>
        </div>
      )}
    </div>
  );
}

function SelectionToolbar({ records, onExit, onBulkDelete, onBulkUpdate, onSelectPage, onClearSelection, onViewSelected }) {
  const ids = selectedIds.value;
  const total = ids.size;
  const pageIds = records.map((r) => r._id?.$oid || String(r._id));
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => ids.has(id));
  const anyOnPageSelected = pageIds.some((id) => ids.has(id));
  const headerState = allOnPageSelected ? 'all' : anyOnPageSelected ? 'some' : 'none';
  const [popoverOpen, setPopoverOpen] = useState(false);

  function removeId(id) {
    const next = new Map(selectedIds.value);
    next.delete(id);
    selectedIds.value = next;
  }

  return (
    <div style="display:contents">
      <div class="toolbar-group">
        <button class="btn btn-sm" onClick={onExit}>Cancel</button>
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
          >{total} selected</span>
          {popoverOpen && total > 0 && (
            <div class="selection-popover">
              {[...ids.keys()].map((id) => (
                <div class="selection-popover-row">
                  <span class="selection-popover-id">{id}</span>
                  <button
                    class="selection-popover-remove"
                    title="Remove from selection"
                    onClick={() => removeId(id)}
                  >{'\u00D7'}</button>
                </div>
              ))}
              <div class="selection-popover-actions">
                <button class="btn-link" onClick={() => { setPopoverOpen(false); onViewSelected(); }}>View selected only</button>
                <button class="btn-link" onClick={() => { setPopoverOpen(false); onClearSelection(); }}>Clear all</button>
              </div>
            </div>
          )}
        </div>
        {total > 0 && (
          <button class="btn-link" onClick={onClearSelection}>Clear</button>
        )}
      </div>
      <div style="flex:1"></div>
      <div class="toolbar-group">
        <button class="btn btn-sm" disabled={total === 0} onClick={onBulkUpdate}>Edit selected</button>
        <button class="btn btn-sm btn-danger" disabled={total === 0} onClick={onBulkDelete}>Delete selected</button>
      </div>
    </div>
  );
}
