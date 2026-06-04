import { h } from 'preact';
import JsonTree from '../components/JsonTree.jsx';

const ACTIONS_BY_TYPE = {
  document: ['create'],
  annotation: ['update-status'],
  user: ['create', 'delete', 'purge', 'update', 'destroy', 'app_load', 'reset-password', 'change-password'],
};

function statusClass(s) {
  if (typeof s !== 'number') return '';
  if (s >= 500) return 'status-5xx';
  if (s >= 400) return 'status-4xx';
  if (s >= 300) return 'status-3xx';
  if (s >= 200) return 'status-2xx';
  return '';
}

export const auditLogs = {
  key: 'audit',
  label: 'Audit Logs',
  path: '/api/v1/audit_logs/',
  paginationMode: 'cursor',
  supportsServerSearch: false,
  filters: [
    { name: 'object_type', kind: 'select', label: 'Object type *', required: true,
      options: () => ['annotation', 'document', 'user'] },
    { name: 'action', kind: 'select', label: 'Action',
      options: (st) => ACTIONS_BY_TYPE[st.object_type] || [] },
    { name: 'object_id', kind: 'text', label: 'Object ID' },
    { name: 'username', kind: 'text', label: 'Username' },
    { name: 'timestamp_after', kind: 'datetime', label: 'After' },
    { name: 'timestamp_before', kind: 'datetime', label: 'Before' },
  ],
  buildParams: (st) => ({
    object_type: st.object_type,
    action: st.action,
    object_id: st.object_id,
    username: st.username,
    timestamp_after: st.timestamp_after,
    timestamp_before: st.timestamp_before,
  }),
  columns: [
    { key: 'timestamp', label: 'Timestamp', cls: 'col-time mono', render: (r) => fmtTime(r.timestamp) },
    { key: 'username', label: 'User', cls: 'col-user', render: (r) => r.username || dash() },
    { key: 'object_type', label: 'Type', cls: 'col-type',
      render: (r) => <span class={'type-pill type-' + (r.object_type || 'unknown')}>{r.object_type || '—'}</span> },
    { key: 'action', label: 'Action', cls: 'col-action mono', render: (r) => r.action || dash() },
    { key: 'object', label: 'Object', cls: 'col-id mono',
      render: (r, ctx) => objectLink(r, ctx) },
    { key: 'status', label: 'Status', cls: 'col-status mono',
      render: (r) => { const s = r.content?.status_code; return <span class={statusClass(s)}>{s ?? '—'}</span>; } },
  ],
  detail: (r) => {
    // Strip our internal positional key so the panel shows the faithful API record.
    const { _idx, ...record } = r;
    const json = JSON.stringify(record, null, 2);
    return [
      { title: 'Raw JSON', body: (
        <div>
          <div style="margin-bottom:6px"><CopyBtn text={json} label="Copy JSON" /></div>
          <JsonTree data={record} />
        </div>) },
    ];
  },
  refs: (r) => (r.object_id != null && r.object_type ? [{ type: r.object_type, id: r.object_id }] : []),
};

// Shared cell helpers (re-used by other descriptors).
export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function dash() { return <span class="muted">—</span>; }
export function CopyBtn({ text, label }) {
  if (!text) return null;
  return <button class="btn btn-sm" onClick={() => navigator.clipboard.writeText(String(text))}>{label || 'Copy'}</button>;
}
// annotation/document/user object link in audit rows.
function objectLink(r, ctx) {
  if (r.object_id == null) return dash();
  const url = ctx.deeplink(r.object_type, r.object_id);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{r.object_id}</a> : String(r.object_id);
}
