import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { loading, error } from '../store.js';
import * as api from '../api.js';

const PAGE_SIZE = 100;

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

function duration(startedStr, updatedStr) {
  if (!startedStr || !updatedStr) return '\u2014';
  const ms = new Date(updatedStr).getTime() - new Date(startedStr).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
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

const STATUS_OPTIONS = ['All', 'FINISHED', 'FAILED', 'PROCESSING'];

export default function UploadsPanel() {
  const [allOperations, setAllOperations] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [page, setPage] = useState(0);

  async function loadOperations() {
    try {
      loading.value = true;
      error.value = null;
      const res = await api.listOperations();
      setAllOperations(res.operations || []);
      setLoaded(true);
      loading.value = false;
    } catch (err) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  useEffect(() => { if (!loaded) loadOperations(); }, []);

  const filtered = useMemo(() => {
    let ops = allOperations;
    if (statusFilter !== 'All') {
      ops = ops.filter((op) => (op.status || '').toUpperCase() === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      ops = ops.filter((op) =>
        (op.dataset_name || '').toLowerCase().includes(q) ||
        (op.metadata?.file_metadata?.filename || '').toLowerCase().includes(q),
      );
    }
    return ops;
  }, [allOperations, statusFilter, search]);

  useEffect(() => { setPage(0); }, [statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageOps = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div class="panel">
      <div class="toolbar">
        <span style="font-weight:500">Operation Logs</span>
        <span style="flex:1" />
        <input
          class="ops-search"
          type="text"
          placeholder="Filter by dataset or filename…"
          value={search}
          onInput={(e) => setSearch(e.target.value)}
        />
        <select
          class="ops-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === 'All' ? 'All statuses' : s.toLowerCase()}</option>
          ))}
        </select>
        <button class="icon-btn" title="Refresh" onClick={() => { setLoaded(false); loadOperations(); }}>{'\u21bb'}</button>
      </div>
      <div class="uploads-table-wrap">
        {pageOps.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">
            {loaded ? (allOperations.length === 0 ? 'No operations' : 'No matching operations') : ''}
          </div>
        ) : (
          <table class="uploads-table">
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
              {pageOps.map((op) => {
                const fileMeta = op.metadata?.file_metadata;
                const summary = op.metadata?.operation_summary;
                const failed = (op.status || '').toUpperCase() === 'FAILED';
                const errMsg = failed && op.message
                  ? (op.error_type ? `${op.error_type}: ${op.message}` : op.message)
                  : null;
                return (
                  <tbody key={op._id} class={failed ? 'uploads-row-failed' : ''}>
                    <tr class={errMsg ? 'uploads-row-has-error' : ''}>
                      <td>
                        <span class={`op-status-badge ${statusClass(op.status)}`}>
                          {(op.status || 'unknown').toLowerCase()}
                        </span>
                      </td>
                      <td>{op.type || '\u2014'}</td>
                      <td class="uploads-cell-dataset">{op.dataset_name || '\u2014'}</td>
                      <td class="uploads-cell-file" title={fileMeta?.filename}>{fileMeta?.filename || '\u2014'}</td>
                      <td>{fileSize(fileMeta?.file_size)}</td>
                      <td>{summary?.record_count ?? '\u2014'}</td>
                      <td title={op.created}>{op.created ? timeAgo(op.created) : '\u2014'}</td>
                      <td>{duration(op.started, op.updated)}</td>
                    </tr>
                    {errMsg && (
                      <tr class="uploads-row-error">
                        <td colspan="8">{errMsg}</td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
          </table>
        )}
      </div>
      <div class="pagination">
        <span class="record-count">
          {loaded ? (filtered.length > 0
            ? `Showing ${page * PAGE_SIZE + 1}\u2013${Math.min((page + 1) * PAGE_SIZE, filtered.length)} (out of ${filtered.length})`
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
