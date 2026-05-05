import { h } from 'preact';
import JsonTree from './JsonTree.jsx';
import { domain } from '../store.js';

export default function RecordDetail({ record }) {
  const content = record?.content || {};
  const link = buildResourceLink(record);

  const sections = [
    ['Request', {
      method: content.method,
      path: content.path,
      request_id: content.request_id,
      status_code: content.status_code,
      groups: content.groups,
    }],
  ];
  if (content.details && hasContent(content.details)) {
    sections.push(['Details', content.details]);
  }
  if (content.payload && hasContent(content.payload)) {
    sections.push(['Payload', content.payload]);
  }
  // Forward-compat: surface any top-level field not already shown above.
  // Excludes the internal `_idx` and other underscore-prefixed helpers.
  const known = new Set(['timestamp','username','object_id','object_type','action','content','organization_id','id']);
  const extra = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith('_')) continue;
    if (!known.has(k)) extra[k] = v;
  }
  if (hasContent(extra)) sections.push(['Other', extra]);

  return (
    <div class="record-detail">
      <div class="record-detail-meta">
        <span class="meta-item"><span class="meta-label">When</span><span class="meta-value mono">{record.timestamp}</span></span>
        <span class="meta-item"><span class="meta-label">User</span><span class="meta-value">{record.username || '—'}</span></span>
        <span class="meta-item"><span class="meta-label">Org</span><span class="meta-value mono">{record.organization_id ?? '—'}</span></span>
        {link && (
          <a class="meta-link" href={link} target="_blank" rel="noopener noreferrer">
            Open {record.object_type} {record.object_id} {externalIcon()}
          </a>
        )}
      </div>
      {sections.map(([title, data]) => (
        <details class="detail-section" open>
          <summary class="detail-summary">{title}</summary>
          <div class="detail-body">
            <JsonTree data={data} />
          </div>
        </details>
      ))}
    </div>
  );
}

function hasContent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.length > 0;
  return Object.keys(obj).length > 0;
}

function buildResourceLink(record) {
  const d = domain.value;
  if (!d || !record?.object_id) return null;
  switch (record.object_type) {
    case 'annotation':
      return `${d}/document/${record.object_id}`;
    case 'document':
      return `${d}/api/v1/documents/${record.object_id}`;
    case 'user':
      return `${d}/users/${record.object_id}/edit`;
    default:
      return null;
  }
}

function externalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 17L17 7M17 7H7M17 7v10" />
    </svg>
  );
}
