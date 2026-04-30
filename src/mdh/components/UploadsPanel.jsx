import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import {
  loading, error,
  operations, operationsLoaded, pendingOperations, opsSearch,
  selectedCollection, activeView, activePanel,
} from '../store.js';
import * as api from '../api.js';
import AiInsight from './AiInsight.jsx';
import FlashOnChange from './FlashOnChange.jsx';

const DEFAULT_COL_WIDTHS = {
  status: 130,
  type: 110,
  dataset: 200,
  file: 220,
  size: 80,
  records: 90,
  created: 120,
  duration: 95,
};
const COL_KEYS = ['status', 'type', 'dataset', 'file', 'size', 'records', 'created', 'duration'];
const COL_LABELS = {
  status: 'Status',
  type: 'Type',
  dataset: 'Dataset',
  file: 'File',
  size: 'Size',
  records: 'Records',
  created: 'Created',
  duration: 'Duration',
};
const MIN_COL_WIDTH = 50;
const COL_WIDTHS_KEY = 'mdhUploadsColumnWidths';

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
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GROUP_WINDOW_MS = HOUR_MS;
const SPARK_BUCKET_COUNT = 24;

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins - hrs * 60;
  if (hrs < 24) return remMins ? `${hrs}h ${remMins}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs - days * 24;
  return remHrs ? `${days}d ${remHrs}h ago` : `${days}d ago`;
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

function pickActivityRange(ops) {
  let maxT = 0;
  let minT = Infinity;
  for (const op of ops) {
    const t = op.created ? Date.parse(op.created) : 0;
    if (!t) continue;
    if (t > maxT) maxT = t;
    if (t < minT) minT = t;
  }
  if (!maxT) return null;
  const now = Date.now();
  const age = now - maxT;
  if (age < DAY_MS) {
    return { tier: 'hour', bucketMs: HOUR_MS, count: 24, start: now - 24 * HOUR_MS, label: 'last 24h' };
  }
  if (age < 7 * DAY_MS) {
    return { tier: 'day', bucketMs: DAY_MS, count: 7, start: now - 7 * DAY_MS, label: 'last 7d' };
  }
  if (age < 30 * DAY_MS) {
    return { tier: 'day', bucketMs: DAY_MS, count: 30, start: now - 30 * DAY_MS, label: 'last 30d' };
  }
  const span = Math.max(DAY_MS, maxT - minT);
  const raw = Math.ceil(span / SPARK_BUCKET_COUNT);
  let bucketMs = raw;
  if (raw >= 30 * DAY_MS) bucketMs = Math.ceil(raw / (30 * DAY_MS)) * 30 * DAY_MS;
  else if (raw >= 7 * DAY_MS) bucketMs = Math.ceil(raw / (7 * DAY_MS)) * 7 * DAY_MS;
  else if (raw >= DAY_MS) bucketMs = Math.ceil(raw / DAY_MS) * DAY_MS;
  return { tier: 'span', bucketMs, count: SPARK_BUCKET_COUNT, start: minT, label: 'all time' };
}

function bucketActivity(ops) {
  const range = pickActivityRange(ops);
  if (!range) return { buckets: [], range: null };
  const { bucketMs, count, start } = range;
  const buckets = Array.from({ length: count }, (_, i) => ({
    start: start + i * bucketMs,
    success: 0, failed: 0, running: 0,
  }));
  for (const op of ops) {
    const t = op.created ? Date.parse(op.created) : 0;
    if (!t || t < start) continue;
    const idx = Math.floor((t - start) / bucketMs);
    if (idx < 0 || idx >= count) continue;
    const s = (op.status || '').toUpperCase();
    if (s === 'FINISHED') buckets[idx].success++;
    else if (s === 'FAILED') buckets[idx].failed++;
    else buckets[idx].running++;
  }
  return { buckets, range };
}

function formatBucketTooltip(b, range) {
  const d = new Date(b.start);
  let timeLabel;
  if (range.tier === 'hour') {
    const hFrom = String(d.getHours()).padStart(2, '0');
    const hTo = String((d.getHours() + 1) % 24).padStart(2, '0');
    timeLabel = `${hFrom}:00\u2013${hTo}:00`;
  } else if (range.tier === 'day' || range.bucketMs <= DAY_MS) {
    timeLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    const end = new Date(b.start + range.bucketMs - 1);
    const fmt = (x) => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    timeLabel = `${fmt(d)}\u2013${fmt(end)}`;
  }
  const parts = [timeLabel];
  if (b.success) parts.push(`${b.success} finished`);
  if (b.failed) parts.push(`${b.failed} failed`);
  if (b.running) parts.push(`${b.running} running`);
  if (b.success + b.failed + b.running === 0) parts.push('no activity');
  return parts.join(' \u00b7 ');
}

function ActivitySparkline({ buckets, range }) {
  if (!buckets.length || !range) return null;
  const max = Math.max(1, ...buckets.map((b) => b.success + b.failed + b.running));
  const W = 192, H = 28, GAP = 1;
  const barW = (W - (buckets.length - 1) * GAP) / buckets.length;
  const [hover, setHover] = useState(null);

  return (
    <div class="uploads-sparkline-host" onMouseLeave={() => setHover(null)} title={`Activity \u00b7 ${range.label}`}>
      <svg
        class="uploads-sparkline"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Activity over ${range.label}`}
      >
        {buckets.map((b, i) => {
          const total = b.success + b.failed + b.running;
          const x = i * (barW + GAP);
          const bars = [];
          if (total === 0) {
            bars.push(<rect key="empty" x={x} y={H - 1} width={barW} height={1} fill="var(--border)" />);
          } else {
            const sH = (b.success / max) * H;
            const rH = (b.running / max) * H;
            const fH = (b.failed  / max) * H;
            let y = H;
            if (b.success) { y -= sH; bars.push(<rect key="s" x={x} y={y} width={barW} height={sH} fill="var(--success)" />); }
            if (b.running) { y -= rH; bars.push(<rect key="r" x={x} y={y} width={barW} height={rH} fill="var(--warning)" />); }
            if (b.failed)  { y -= fH; bars.push(<rect key="f" x={x} y={y} width={barW} height={fH}  fill="var(--danger)"  />); }
          }
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              {bars}
              <rect x={x} y={0} width={barW + GAP} height={H} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div
          class="uploads-sparkline-tip"
          style={`left:${hover * (barW + GAP) + barW / 2}px`}
        >
          {formatBucketTooltip(buckets[hover], range)}
        </div>
      )}
    </div>
  );
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
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let oldestCreated = null;
  let oldestCreatedMs = Infinity;
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
      if (startMs < minStart) minStart = startMs;
      if (endMs > maxEnd) maxEnd = endMs;
      hasDuration = true;
    }
    if (op.created) {
      const createdMs = new Date(op.created).getTime();
      if (createdMs < oldestCreatedMs) {
        oldestCreatedMs = createdMs;
        oldestCreated = op.created;
      }
    }
  }
  return {
    status: first.status,
    type: first.type,
    dataset: first.dataset_name,
    filename: first.metadata?.file_metadata?.filename,
    totalSize,
    totalRecords: hasRecords ? totalRecords : null,
    totalMs: hasDuration ? Math.max(0, maxEnd - minStart) : null,
    latestCreated: oldestCreated || first.created,
  };
}

export default function UploadsPanel() {
  const search = opsSearch.value;
  const setSearch = (v) => { opsSearch.value = v; };
  const [statusFilter, setStatusFilter] = useState('All');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [page, setPage] = useState(0);
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const colWidthsRef = useRef(DEFAULT_COL_WIDTHS);

  useEffect(() => {
    chrome.storage.local.get([COL_WIDTHS_KEY], (result) => {
      const saved = result?.[COL_WIDTHS_KEY];
      if (saved && typeof saved === 'object') {
        const merged = { ...DEFAULT_COL_WIDTHS };
        for (const k of COL_KEYS) {
          const v = Number(saved[k]);
          if (Number.isFinite(v) && v >= MIN_COL_WIDTH) merged[k] = Math.round(v);
        }
        colWidthsRef.current = merged;
        setColWidths(merged);
      }
    });
  }, []);

  function startColResize(key, e) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startW = colWidthsRef.current[key];
    target.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      const w = Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX));
      colWidthsRef.current = { ...colWidthsRef.current, [key]: w };
      setColWidths(colWidthsRef.current);
    }
    function onUp() {
      target.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.local.set({ [COL_WIDTHS_KEY]: colWidthsRef.current });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function resetColWidths(e) {
    e.preventDefault();
    if (e.detail !== 2) return;
    colWidthsRef.current = { ...DEFAULT_COL_WIDTHS };
    setColWidths(colWidthsRef.current);
    chrome.storage.local.set({ [COL_WIDTHS_KEY]: colWidthsRef.current });
  }

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
    const isSearching = !!search;
    let gFinished = 0, gFailed = 0, gRunning = 0;
    let finished = 0, failed = 0, running = 0;
    for (const op of allOperations) {
      const s = (op.status || '').toUpperCase();
      if (s === 'FINISHED') gFinished++;
      else if (s === 'FAILED') gFailed++;
      else gRunning++;
      if (!isSearching || matchesFilter(op, 'All', search)) {
        if (s === 'FINISHED') finished++;
        else if (s === 'FAILED') failed++;
        else running++;
      }
    }
    const total = isSearching ? finished + failed + running : allOperations.length;
    return {
      total, finished, failed, running,
      gTotal: allOperations.length, gFinished, gFailed, gRunning,
      isSearching,
    };
  }, [allOperations, search]);

  const filtered = useMemo(
    () => allOperations.filter((op) => matchesFilter(op, statusFilter, search)),
    [allOperations, statusFilter, search],
  );

  const { buckets, range: bucketRange } = useMemo(() => bucketActivity(allOperations), [allOperations]);

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
                <AiInsight input={errMsg} type="error" mode="overlay" />
                <span class="uploads-error-text">{errMsg}</span>
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
                <AiInsight input={errMsg} type="error" mode="overlay" />
                <span class="uploads-error-text">{errMsg}</span>
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
    <div class="panel uploads-panel">
      <div class="uploads-stats">
        <button
          class={'uploads-stat-chip' + (statusFilter === 'All' ? ' active' : '')}
          onClick={() => setStatusFilter('All')}
          title={stats.isSearching ? `${stats.total} matching · ${stats.gTotal} total` : undefined}
        >{stats.isSearching ? 'Matching' : 'Total'} <b><FlashOnChange value={stats.total} />{stats.isSearching && <span class="uploads-stat-of"> / {stats.gTotal}</span>}</b></button>
        <button
          class={'uploads-stat-chip tone-success' + (statusFilter === 'FINISHED' ? ' active' : '')}
          onClick={() => setStatusFilter('FINISHED')}
          title={stats.isSearching ? `${stats.finished} matching · ${stats.gFinished} total` : undefined}
        >Finished <b><FlashOnChange value={stats.finished} />{stats.isSearching && <span class="uploads-stat-of"> / {stats.gFinished}</span>}</b></button>
        <button
          class={'uploads-stat-chip tone-danger' + (statusFilter === 'FAILED' ? ' active' : '')}
          onClick={() => setStatusFilter('FAILED')}
          title={stats.isSearching ? `${stats.failed} matching · ${stats.gFailed} total` : undefined}
        >Failed <b><FlashOnChange value={stats.failed} />{stats.isSearching && <span class="uploads-stat-of"> / {stats.gFailed}</span>}</b></button>
        <button
          class={'uploads-stat-chip tone-warning' + (statusFilter === 'RUNNING' ? ' active' : '')}
          onClick={() => setStatusFilter('RUNNING')}
          title={stats.isSearching ? `${stats.running} matching · ${stats.gRunning} total` : undefined}
        >Running <b><FlashOnChange value={stats.running} />{stats.isSearching && <span class="uploads-stat-of"> / {stats.gRunning}</span>}</b></button>
        {allOperations.length > 0 && bucketRange && (
          <div class="uploads-sparkline-wrap">
            <ActivitySparkline buckets={buckets} range={bucketRange} />
          </div>
        )}
        <span style="flex:1" />
        <div class={'ops-search-wrap' + (search ? ' has-value' : '')}>
          <svg class="ops-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            class="ops-search"
            type="text"
            placeholder="Filter by dataset, filename, type, or error…"
            value={search}
            onInput={(e) => setSearch(e.target.value)}
            title={search ? `Filtering by "${search}" — click × to clear` : ''}
          />
          {search && (
            <button
              class="ops-search-clear"
              title="Clear filter"
              aria-label="Clear filter"
              onClick={() => setSearch('')}
            >{'×'}</button>
          )}
        </div>
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
              {COL_KEYS.map((k) => (
                <col key={k} style={`width:${colWidths[k]}px`} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COL_KEYS.map((k) => (
                  <th key={k}>
                    {COL_LABELS[k]}
                    <span
                      class="col-resizer"
                      title="Drag to resize · double-click to reset"
                      onMouseDown={(e) => startColResize(k, e)}
                      onClick={resetColWidths}
                    />
                  </th>
                ))}
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
