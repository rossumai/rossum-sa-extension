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

// Rossum Agent API ("Mr. Fabry") reachable — set from probeAgent() at init.
export const aiAvailable = signal(false);

// Fabry conversation state (ephemeral; no persistence). One chat per session:
// turns[0] is the auto default-summary (question:null); later turns are Q&A.
// status: 'idle' | 'running' | 'done' | 'error'. `forView` is the view
// signature (see src/audit/index.jsx viewSignature) the current summary was
// computed for — null while idle/errored; a mismatch against the live
// signature means the summary is stale (view changed since it ran).
// `refreshFailedFor` is a give-up marker: the view signature a refreshSummary()
// attempt last FAILED for. It prevents the panel's auto-refresh effect from
// retrying the same failed view forever (a failure leaves `forView` stale, so
// without this marker the effect would immediately re-fire on every render);
// cleared on the next successful refresh, and ignored by an explicit
// user-initiated retry (expanding the panel).
export const fabry = signal({ status: 'idle', chatId: null, turns: [], error: null, forView: null, refreshFailedFor: null });
export function resetFabry() {
  fabry.value = { status: 'idle', chatId: null, turns: [], error: null, forView: null, refreshFailedFor: null };
}
