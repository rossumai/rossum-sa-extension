import { h } from 'preact';
import { useState } from 'preact/hooks';
import { skip, limit } from '../store.js';
import RecordCard from './RecordCard.jsx';
import JSON5 from 'json5';

export default function RecordList({ records, pipelineText, filterState, sortState, lastQueryMs, totalCount, pagination, onSort, onFilter, onPageChange, onEdit, onDelete, onRefresh, downloadState, onCancelDownload }) {
  const [expandedSet, setExpandedSet] = useState(new Set([0]));
  const [expandAll, setExpandAll] = useState(false);

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
  const l = limit.value;
  let countText = records.length > 0 ? `Showing ${s + 1}\u2013${s + records.length}` : 'No records';
  if (totalCount !== null) countText += ` (out of ${totalCount})`;
  if (lastQueryMs) countText += ` \u00b7 ${lastQueryMs}ms`;

  return (
    <div style="display:flex;flex-direction:column;flex:1;overflow:hidden">
      <div class="toolbar">
        <div class="toolbar-group">
          <button class="btn btn-sm" onClick={() => onRefresh('reset')}>Reset</button>
          <button class="btn btn-sm" onClick={toggleExpandAll}>{allExpanded ? 'Collapse All' : 'Expand All'}</button>
        </div>
        <div style="flex:1"></div>
        <div class="toolbar-group">
          {downloadState ? (
            <span class="download-progress">
              <span class="download-progress-text">
                {downloadState.cancelled ? 'Cancelled' : downloadState.done ? `\u2713 ${downloadState.count} records` : `Downloading\u2026 ${downloadState.count}${downloadState.total ? ' / ' + downloadState.total : ''} records`}
              </span>
              {!downloadState.cancelled && !downloadState.done && (
                <span class="download-bar">
                  {downloadState.total > 0
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
            <button class="btn btn-sm" title="Download entire collection as JSON" onClick={() => onRefresh('download')}>Download all</button>
          )}
          <SplitButton label="Insert" cls="btn-success" onMain={() => onRefresh('insert')} onFile={() => onRefresh('insert-file')} />
        </div>
      </div>
      <div class="record-list">
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
          />
        ))}
      </div>
      <div class="pagination">
        <span class={'record-count' + (lastQueryMs > 1000 ? ' record-count-slow' : '')}>{countText}</span>
        <span class="pagination-hint">Click key to sort {'\u00b7'} Click value to filter</span>
        <div class="pagination-controls">
          <button disabled={!pagination.hasPrev()} onClick={() => onPageChange('prev')}>{'\u2190'} Prev</button>
          <span>Page {pagination.page()}</span>
          <button disabled={!pagination.hasNext(records.length)} onClick={() => onPageChange('next')}>Next {'\u2192'}</button>
        </div>
      </div>
    </div>
  );
}

function SplitButton({ label, cls, onMain, onFile }) {
  const [open, setOpen] = useState(false);

  return (
    <div class="split-btn">
      <button class={`btn btn-sm ${cls}`} onClick={onMain}>{label}</button>
      <button class={`btn btn-sm split-btn-drop ${cls}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{'\u25BE'}</button>
      {open && (
        <div class="toolbar-more-menu">
          <button class="toolbar-menu-item" onClick={() => { setOpen(false); onFile(); }}>{label} from JSON file</button>
        </div>
      )}
    </div>
  );
}
