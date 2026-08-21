import { signal } from '@preact/signals';
import type { PageInfo } from './api.js';

/** One source's filter + paging state. `page` is for offset sources, `cursor` for cursor ones. */
export type AuditFilters = {
  object_type: string;
  action: string;
  object_id: string;
  username: string;
  timestamp_after: string;
  timestamp_before: string;
  page: number;
  cursor: string | null;
  pageSize: number;
  search: string;
  /** Per-source descriptors name their own filter keys (see sources/), so the shell reads
   *  and patches this by a key it only knows at runtime. The named members above are the
   *  ones every source has; the index signature is what lets a descriptor add more. */
  [key: string]: unknown;
};

export type FiltersBySource = Record<string, AuditFilters>;

/** One Fabry turn in the audit panel. `question: null` marks the auto summary. */
export type FabryTurn = {
  id: number;
  question: string | null;
  text: string;
  reasoning: string;
  tools: unknown[];
  state: string;
};

export type FabryState = {
  status: 'idle' | 'running' | 'done' | 'error';
  chatId: string | null;
  turns: FabryTurn[];
  error: string | null;
  /** View signature the summary was computed for; a mismatch means it is stale. */
  forView: string | null;
  /** Give-up marker: the view signature a refresh last FAILED for. Omitted by the
   *  transitions that do not carry one forward (start / success), which is why it is
   *  optional rather than required-nullable. */
  refreshFailedFor?: string | null;
};

// Shared connection (set by the console shell before initAudit runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal<boolean | null>(null); // null = not yet probed; true/false after whoami

// Which source tab is active.
export const activeSource = signal('audit');

// Per-source filter + paging state. `page` is used by offset sources, `cursor`
// by cursor sources; both reset on any filter/search/pageSize change.
export const filtersBySource = signal<FiltersBySource>({
  audit: { object_type: 'annotation', action: '', object_id: '', username: '',
           timestamp_after: '', timestamp_before: '', page: 1, cursor: null, pageSize: 100, search: '' },
});

// Active-view results for the currently displayed source.
export const rows = signal<any[]>([]);
export const pageInfo = signal<PageInfo>({ total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null });
export const loading = signal(false);
export const error = signal<string | null>(null);
export const selectedRow = signal<number | null>(null); // row._idx of the open detail, or null

// Per-active-source availability (a source may 403 independently).
export const availability = signal<'unknown' | 'available' | 'unavailable'>('unknown');
export const availabilityMessage = signal<string | null>(null);
export const availabilityStatus = signal<number | null>(null);

// Merge a patch into one source's filter state (immutably, to trigger signals).
export function patchFilters(key: string, patch: Partial<AuditFilters>): void {
  const cur = filtersBySource.value[key];
  filtersBySource.value = { ...filtersBySource.value, [key]: { ...cur, ...patch } };
}

// Pagination is patched THROUGH filtersBySource (Pagination.jsx sends `page` /
// `cursor` here), so anything asking "did the SEARCH change" must ignore those
// two keys — otherwise every next-page click reads as a brand new search. Keys
// are sorted so a patch that merely reorders them is not mistaken for a change.
const PAGING_KEYS = new Set(['page', 'cursor']);
export function searchSignature(source: string, bySource?: FiltersBySource | null): string {
  const f: Record<string, unknown> = (bySource && bySource[source]) || {};
  const stable: Record<string, unknown> = {};
  for (const k of Object.keys(f).sort()) if (!PAGING_KEYS.has(k)) stable[k] = f[k];
  return JSON.stringify([source, stable]);
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
export const fabry = signal<FabryState>({ status: 'idle', chatId: null, turns: [], error: null, forView: null, refreshFailedFor: null });
export function resetFabry(): void {
  fabry.value = { status: 'idle', chatId: null, turns: [], error: null, forView: null, refreshFailedFor: null };
}
