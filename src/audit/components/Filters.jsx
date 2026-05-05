import { h } from 'preact';
import { filters, page, pageSize, constraints, quickSearch } from '../store.js';

// Filter values per the public audit log API reference. The API only
// documents `object_type` (required) and `action` (whitelisted per type).
// `constraints` overrides these once the API tells us otherwise via an
// "Available options: [...]" error.
const HINT_OBJECT_TYPES = ['annotation', 'document', 'user'];
const HINT_ACTIONS_BY_TYPE = {
  document: ['create'],
  annotation: ['update-status'],
  user: ['create', 'delete', 'purge', 'update', 'destroy', 'app_load', 'reset-password', 'change-password'],
};
const PAGE_SIZES = [20, 50, 100];

export default function Filters() {
  const f = filters.value;

  const setField = (key, value) => {
    page.value = 1;
    const next = { ...f, [key]: value };
    if (key === 'object_type') next.action = '';
    filters.value = next;
  };

  const clear = () => {
    page.value = 1;
    // object_type is required by the API — preserve the current selection.
    filters.value = { object_type: f.object_type, action: '' };
  };

  const c = constraints.value;
  const objectTypeOptions = c.object_type || HINT_OBJECT_TYPES;
  const actionOptions = c.action[f.object_type] || HINT_ACTIONS_BY_TYPE[f.object_type] || [];

  return (
    <section class="filters">
      <div class="filters-row">
        <label class="filter">
          <span class="filter-label">Object type *</span>
          <select class="input" value={f.object_type} onChange={(e) => setField('object_type', e.target.value)}>
            {objectTypeOptions.map((t) => (
              <option value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label class="filter">
          <span class="filter-label">Action</span>
          <select class="input" value={f.action} onChange={(e) => setField('action', e.target.value)} disabled={!actionOptions.length}>
            <option value="">any</option>
            {actionOptions.map((a) => (
              <option value={a}>{a}</option>
            ))}
          </select>
        </label>

        <label class="filter filter-grow">
          <span class="filter-label">Quick search <span class="hint-tag">client-side, this page only</span></span>
          <input
            class="input"
            type="search"
            placeholder="Substring match across action, user, path, method, status, IDs"
            value={quickSearch.value}
            onInput={(e) => (quickSearch.value = e.target.value)}
          />
        </label>

        <label class="filter filter-compact">
          <span class="filter-label">Page size</span>
          <select class="input" value={pageSize.value} onChange={(e) => { page.value = 1; pageSize.value = Number(e.target.value); }}>
            {PAGE_SIZES.map((n) => (
              <option value={n}>{n}</option>
            ))}
          </select>
        </label>

        <div class="filters-actions">
          <button class="btn btn-secondary" onClick={clear}>Clear filters</button>
        </div>
      </div>
    </section>
  );
}
