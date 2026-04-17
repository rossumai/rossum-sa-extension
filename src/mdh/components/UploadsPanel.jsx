import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import {
  loading, error,
  operations, operationsLoaded, pendingOperations,
  selectedCollection, activeView, activePanel,
} from '../store.js';
import * as api from '../api.js';
import AiInsight from './AiInsight.jsx';

export async function loadOperations() {
  try {
    loading.value = true;
    error.value = null;
    const res = await api.listOperations();
    operations.value = res.operations || [];
    operationsLoaded.value = true;
    pendingOperations.value = null;
    loading.value = false;
  } catch (err) {
    error.value = { message: err.message };
    loading.value = false;
  }
}

const PAGE_SIZE = 100;
const GROUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function isTerminal(status) {
  const s = (status || '').toUpperCase();
  return s === 'FINISHED' || s === 'FAILED';
}

function duration(startedStr, updatedStr, status) {
  if (!startedStr) return '\u2014';
  const startMs = new Date(startedStr).getTime();
  if (isTerminal(status)) {
    if (!updatedStr) return '\u2014';
    return formatDuration(new Date(updatedStr).getTime() - startMs);
  }
  return formatDuration(Date.now() - startMs);
}

function statusClass(status) {
  const s = (status || '').toUpperCase();
  if (s === 'FINISHED') return 'finished';
  if (s === 'FAILED') return 'failed';
  return 'running';
}

function fileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchesFilter(op, statusFilter, search) {
  if (statusFilter !== 'All') {
    const s = (op.status || '').toUpperCase();
    if (statusFilter === 'RUNNING') {
      if (s === 'FINISHED' || s === 'FAILED') return false;
    } else if (s !== statusFilter) return false;
  }
  if (search) {
    const q = search.toLowerCase();
    return (op.dataset_name || '').toLowerCase().includes(q) ||
      (op.metadata?.file_metadata?.filename || '').toLowerCase().includes(q) ||
      (op.message || '').toLowerCase().includes(q) ||
      (op.error_type || '').toLowerCase().includes(q) ||
      (op.type || '').toLowerCase().includes(q);
  }
  return true;
}

function jumpToDataset(name) {
  if (!name) return;
  selectedCollection.value = name;
  activeView.value = 'collection';
  activePanel.value = 'data';
}

function FlashOnChange({ value }) {
  const firstRef = useRef(true);
  const prevRef = useRef(value);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      prevRef.current = value;
      return;
    }
    if (prevRef.current !== value) {
      prevRef.current = value;
      setTick((t) => t + 1);
    }
  }, [value]);
  if (tick === 0) return <span>{value}</span>;
  return <span key={tick} class="flash-value">{value}</span>;
}

function opGroupKey(op) {
  return [
    op.dataset_name || '',
    op.type || '',
    op.metadata?.file_metadata?.filename || '',
    (op.status || '').toUpperCase(),
    op.error_type || '',
  ].join('\x00');
}

function groupOps(ops) {
  if (!ops.length) return [];
  const groups = [];
  let current = null;
  for (const op of ops) {
    const key = opGroupKey(op);
    const t = op.created ? new Date(op.created).getTime() : 0;
    const lastOp = current && current.ops[current.ops.length - 1];
    const lastT = lastOp?.created ? new Date(lastOp.created).getTime() : t;
    if (current && current.key === key && Math.abs(lastT - t) < GROUP_WINDOW_MS) {
      current.ops.push(op);
    } else {
      if (current) groups.push(current);
      current = { key, ops: [op] };
    }
  }
  if (current) groups.push(current);
  return groups;
}

function computeGroupSummary(ops) {
  const first = ops[0];
  let totalSize = 0;
  let totalRecords = 0;
  let totalMs = 0;
  let hasRecords = false;
  let hasDuration = false;
  const now = Date.now();
  for (const op of ops) {
    const fs = op.metadata?.file_metadata?.file_size;
    if (fs != null) totalSize += fs;
    const rc = op.metadata?.operation_summary?.record_count;
    if (rc != null) { totalRecords += rc; hasRecords = true; }
    if (op.started) {
      const startMs = new Date(op.started).getTime();
      const endMs = isTerminal(op.status)
        ? (op.updated ? new Date(op.updated).getTime() : startMs)
        : now;
      totalMs += endMs - startMs;
      hasDuration = true;
    }
  }
  return {
    status: first.status,
    type: first.type,
    dataset: first.dataset_name,
    filename: first.metadata?.file_metadata?.filename,
    totalSize,
    totalRecords: hasRecords ? totalRecords : null,
    totalMs: hasDuration ? totalMs : null,
    latestCreated: first.created,
  };
}

export default function UploadsPanel() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [page, setPage] = useState(0);

  const allOperations = operations.value;
  const loaded = operationsLoaded.value;
  const pending = pendingOperations.value;

  useEffect(() => {
    if (pendingOperations.value) {
      operations.value = pendingOperations.value.ops;
      pendingOperations.value = null;
      operationsLoaded.value = true;
      return;
    }
    if (!operationsLoaded.value) loadOperations();
  }, []);

  function applyPending() {
    if (!pendingOperations.value) return;
    operations.value = pendingOperations.value.ops;
    pendingOperations.value = null;
  }

  function toggleGroup(key) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const stats = useMemo(() => {
    let finished = 0;
    let failed = 0;
    let running = 0;
    for (const op of allOperations) {
      const s = (op.status || '').toUpperCase();
      if (s === 'FINISHED') finished++;
      else if (s === 'FAILED') failed++;
      else running++;
    }
    const decided = finished + failed;
    const successRate = decided > 0 ? Math.floor((finished / decided) * 100) : null;
    return { total: allOperations.length, finished, failed, running, successRate };
  }, [allOperations]);

  const filtered = useMemo(
    () => allOperations.filter((op) => matchesFilter(op, statusFilter, search)),
    [allOperations, statusFilter, search],
  );

  const pendingVisibleCount = useMemo(() => {
    if (!pending?.changedOps?.length) return 0;
    let n = 0;
    for (const op of pending.changedOps) {
      if (matchesFilter(op, statusFilter, search)) n++;
    }
    return n;
  }, [pending, statusFilter, search]);

  const groups = useMemo(() => groupOps(filtered), [filtered]);

  useEffect(() => { setPage(0); }, [statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const pageSlice = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const hasRunningVisible = useMemo(() => {
    for (const group of pageSlice) {
      for (const op of group.ops) {
        if (!isTerminal(op.status)) return true;
      }
    }
    return false;
  }, [pageSlice]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    const rate = hasRunningVisible ? 1000 : 30000;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        forceTick((t) => (t + 1) % 1_000_000);
      }
    }, rate);
    return () => clearInterval(id);
  }, [hasRunningVisible]);

  function renderOpRows(op, isSub) {
    const fileMeta = op.metadata?.file_metadata;
    const sum = op.metadata?.operation_summary;
    const failed = (op.status || '').toUpperCase() === 'FAILED';
    const errMsg = failed && op.message
      ? (op.error_type ? `${op.error_type}: ${op.message}` : op.message)
      : null;
    const rowClass =
      (isSub ? 'uploads-row-sub ' : '') +
      (errMsg ? 'uploads-row-has-error' : '');
    const errRowClass = (isSub ? 'uploads-row-sub ' : '') + 'uploads-row-error';
    return (
      <Fragment key={op._id}>
        <tr class={rowClass}>
          <td>
            <span class={`op-status-badge ${statusClass(op.status)}`}>
              {(op.status || 'unknown').toLowerCase()}
            </span>
          </td>
          <td>{op.type || '\u2014'}</td>
          <td class="uploads-cell-dataset">
            {op.dataset_name ? (
              <a
                href="#"
                class="uploads-dataset-link"
                title={`Open ${op.dataset_name}`}
                onClick={(e) => { e.preventDefault(); jumpToDataset(op.dataset_name); }}
              >{op.dataset_name}</a>
            ) : '\u2014'}
          </td>
          <td class="uploads-cell-file" title={fileMeta?.filename}>{fileMeta?.filename || '\u2014'}</td>
          <td><FlashOnChange value={fileSize(fileMeta?.file_size) || '\u2014'} /></td>
          <td><FlashOnChange value={sum?.record_count ?? '\u2014'} /></td>
          <td title={op.created}>{op.created ? timeAgo(op.created) : '\u2014'}</td>
          <td>{duration(op.started, op.updated, op.status)}</td>
        </tr>
        {errMsg && (
          <tr class={errRowClass}>
            <td colspan="8">
              <div class="uploads-error-inner">
                <span class="uploads-error-text">{errMsg}</span>
                <AiInsight input={errMsg} type="error" mode="overlay" />
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  function renderGroupTbody(group) {
    const ops = group.ops;
    if (ops.length === 1) {
      const op = ops[0];
      const failed = (op.status || '').toUpperCase() === 'FAILED';
      return (
        <tbody key={op._id} class={failed ? 'uploads-row-failed' : ''}>
          {renderOpRows(op, false)}
        </tbody>
      );
    }
    const first = ops[0];
    const groupId = first._id;
    const isExpanded = expandedGroups.has(groupId);
    const summary = computeGroupSummary(ops);
    const failed = (summary.status || '').toUpperCase() === 'FAILED';
    const errMsg = failed && first.message
      ? (first.error_type ? `${first.error_type}: ${first.message}` : first.message)
      : null;
    return (
      <tbody key={groupId} class={'uploads-group-tbody' + (failed ? ' uploads-row-failed' : '')}>
        <tr
          class={'uploads-row-group' + (errMsg ? ' uploads-row-has-error' : '')}
          onClick={() => toggleGroup(groupId)}
          title={isExpanded ? 'Collapse group' : `Expand ${ops.length} similar operations`}
        >
          <td>
            <span class={`op-status-badge ${statusClass(summary.status)}`}>
              {(summary.status || 'unknown').toLowerCase()}
            </span>
            <span class="uploads-group-count">{ops.length}{'\u00d7'}</span>
          </td>
          <td>{summary.type || '\u2014'}</td>
          <td class="uploads-cell-dataset">
            {summary.dataset ? (
              <a
                href="#"
                class="uploads-dataset-link"
                title={`Open ${summary.dataset}`}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); jumpToDataset(summary.dataset); }}
              >{summary.dataset}</a>
            ) : '\u2014'}
          </td>
          <td class="uploads-cell-file" title={summary.filename}>{summary.filename || '\u2014'}</td>
          <td><FlashOnChange value={summary.totalSize > 0 ? fileSize(summary.totalSize) : '\u2014'} /></td>
          <td><FlashOnChange value={summary.totalRecords != null ? summary.totalRecords : '\u2014'} /></td>
          <td title={summary.latestCreated}>{summary.latestCreated ? timeAgo(summary.latestCreated) : '\u2014'}</td>
          <td>{summary.totalMs != null ? formatDuration(summary.totalMs) : '\u2014'}</td>
        </tr>
        {errMsg && (
          <tr class="uploads-row-error">
            <td colspan="8">
              <div class="uploads-error-inner">
                <span class="uploads-error-text">{errMsg}</span>
                <AiInsight input={errMsg} type="error" mode="overlay" />
              </div>
            </td>
          </tr>
        )}
        {isExpanded && ops.map((op) => renderOpRows(op, true))}
      </tbody>
    );
  }

  const showCountLabel = `${filtered.length} ops in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`;

  return (
    <div class="panel">
      <div class="uploads-stats">
        <button
          class={'uploads-stat-chip' + (statusFilter === 'All' ? ' active' : '')}
          onClick={() => setStatusFilter('All')}
        >Total <b><FlashOnChange value={stats.total} /></b></button>
        <button
          class={'uploads-stat-chip tone-success' + (statusFilter === 'FINISHED' ? ' active' : '')}
          onClick={() => setStatusFilter('FINISHED')}
        >Finished <b><FlashOnChange value={stats.finished} /></b></button>
        <button
          class={'uploads-stat-chip tone-danger' + (statusFilter === 'FAILED' ? ' active' : '')}
          onClick={() => setStatusFilter('FAILED')}
        >Failed <b><FlashOnChange value={stats.failed} /></b></button>
        <button
          class={'uploads-stat-chip tone-warning' + (statusFilter === 'RUNNING' ? ' active' : '')}
          onClick={() => setStatusFilter('RUNNING')}
        >Running <b><FlashOnChange value={stats.running} /></b></button>
        {stats.successRate !== null && (
          <span class="uploads-success-rate"><FlashOnChange value={`${stats.successRate}% success`} /></span>
        )}
        <span style="flex:1" />
        <input
          class="ops-search"
          type="text"
          placeholder="Filter by dataset, filename, type, or error…"
          value={search}
          onInput={(e) => setSearch(e.target.value)}
        />
        <button class="icon-btn" title="Refresh" onClick={() => loadOperations()}>{'\u21bb'}</button>
      </div>

      {pendingVisibleCount > 0 && (
        <button
          class="uploads-new-float"
          onClick={applyPending}
          title="Click to refresh"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7l3 3"/><polyline points="21 3 21 9 15 9"/><path d="M21 12a9 9 0 0 1-15 6.7l-3-3"/><polyline points="3 21 3 15 9 15"/></svg>
          <span>{pendingVisibleCount} new {pendingVisibleCount === 1 ? 'operation' : 'operations'}</span>
        </button>
      )}
      <div class="uploads-table-wrap">
        {pageSlice.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">
            {loaded ? (allOperations.length === 0 ? 'No operations' : 'No matching operations') : ''}
          </div>
        ) : (
          <table class="uploads-table">
            <colgroup>
              <col class="col-status" />
              <col class="col-type" />
              <col />
              <col />
              <col class="col-size" />
              <col class="col-records" />
              <col class="col-created" />
              <col class="col-duration" />
            </colgroup>
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>Dataset</th>
                <th>File</th>
                <th>Size</th>
                <th>Records</th>
                <th>Created</th>
                <th>Duration</th>
              </tr>
            </thead>
            {pageSlice.map((group) => renderGroupTbody(group))}
          </table>
        )}
      </div>
      <div class="pagination">
        <span class="record-count">
          {loaded ? (groups.length > 0
            ? `Showing ${page * PAGE_SIZE + 1}\u2013${Math.min((page + 1) * PAGE_SIZE, groups.length)} (${showCountLabel})`
            : 'No operations') : ''}
        </span>
        <span style="flex:1" />
        <div class="pagination-controls">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>{'\u2190'} Prev</button>
          <span>Page {page + 1}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next {'\u2192'}</button>
        </div>
      </div>
    </div>
  );
}
