import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initAudit runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = not yet probed; true/false after whoami

// Which source tab is active.
export const activeSource = signal('audit');

// Per-source filter + paging state. `page` is used by offset sources, `cursor`
// by cursor sources; both reset on any filter/search/pageSize change.
export const filtersBySource = signal({
  audit: { object_type: 'annotation', action: '', object_id: '', username: '',
           timestamp_after: '', timestamp_before: '', page: 1, cursor: null, pageSize: 100, search: '' },
});

// Active-view results for the currently displayed source.
export const rows = signal([]);
export const pageInfo = signal({ total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null });
export const loading = signal(false);
export const error = signal(null);
export const selectedRow = signal(null); // row._idx of the open detail, or null

// Per-active-source availability (a source may 403 independently).
export const availability = signal('unknown'); // 'unknown' | 'available' | 'unavailable'
export const availabilityMessage = signal(null);
export const availabilityStatus = signal(null);

// Merge a patch into one source's filter state (immutably, to trigger signals).
export function patchFilters(key, patch) {
  const cur = filtersBySource.value[key];
  filtersBySource.value = { ...filtersBySource.value, [key]: { ...cur, ...patch } };
}
