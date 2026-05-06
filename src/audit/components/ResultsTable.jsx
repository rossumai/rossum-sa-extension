import { h, Fragment } from 'preact';
import { results, loading, expandedRow, quickSearch } from '../store.js';
import { quickMatch } from '../quickSearch.js';
import RecordDetail from './RecordDetail.jsx';

export default function ResultsTable() {
  const all = results.value;
  const q = quickSearch.value.trim();
  const filtered = q ? all.filter((r) => quickMatch(r, q)) : all;

  if (loading.value && all.length === 0) {
    return <div class="results-empty">Loading…</div>;
  }
  if (!loading.value && all.length === 0) {
    return <div class="results-empty">No audit log records match the current filters.</div>;
  }
  if (!loading.value && filtered.length === 0) {
    return <div class="results-empty">No rows on this page match the quick search. Try clearing it, paginating, or increasing page size.</div>;
  }

  return (
    <div class="results-wrap">
      <table class="results-table">
        <thead>
          <tr>
            <th class="col-time">Timestamp</th>
            <th class="col-user">User</th>
            <th class="col-type">Object type</th>
            <th class="col-action">Action</th>
            <th class="col-id">Object ID</th>
            <th class="col-method">Method</th>
            <th class="col-status">Status</th>
            <th class="col-path">Path</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((rec) => {
            // expandedRow is a position-on-page key, deliberately not a record
            // identity — the API doesn't expose a stable id and request_id is
            // not unique. fetchPage clears expandedRow on every page swap so a
            // positional key won't survive across pages.
            const key = String(rec._idx);
            const isExpanded = expandedRow.value === key;
            return (
              <Row key={key} record={rec} rowKey={key} isExpanded={isExpanded} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({ record, rowKey, isExpanded }) {
  const c = record.content || {};
  const status = c.status_code;
  const statusCls = statusClass(status);

  const toggle = () => {
    expandedRow.value = isExpanded ? null : rowKey;
  };

  return (
    <Fragment>
      <tr class={'result-row' + (isExpanded ? ' expanded' : '')} onClick={toggle}>
        <td class="col-time mono">{formatTime(record.timestamp)}</td>
        <td class="col-user">{record.username || <span class="muted">—</span>}</td>
        <td class="col-type"><span class={'type-pill type-' + (record.object_type || 'unknown')}>{record.object_type || '—'}</span></td>
        <td class="col-action mono">{record.action || <span class="muted">—</span>}</td>
        <td class="col-id mono">{record.object_id ?? <span class="muted">—</span>}</td>
        <td class="col-method mono">{c.method || <span class="muted">—</span>}</td>
        <td class={'col-status mono ' + statusCls}>{status ?? <span class="muted">—</span>}</td>
        <td class="col-path mono path-cell" title={c.path}>{c.path || <span class="muted">—</span>}</td>
      </tr>
      {isExpanded && (
        <tr class="detail-row">
          <td colspan="8">
            <RecordDetail record={record} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function statusClass(status) {
  if (typeof status !== 'number') return '';
  if (status >= 500) return 'status-5xx';
  if (status >= 400) return 'status-4xx';
  if (status >= 300) return 'status-3xx';
  if (status >= 200) return 'status-2xx';
  return '';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
