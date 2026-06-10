// src/mdh/store.js
import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');
// Organization id of the connected project (resolved at connect via
// api.getOrgId). null until resolved, or if the lookup failed.
export const orgId = signal(null);
export const collections = signal([]);
export const selectedCollection = signal(null);
export const records = signal([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal('data');
export const activeView = signal('collection');
export const loading = signal(false);
export const error = signal(null);
// Non-error operation notice (in-progress / inconclusive) shown as a top stripe.
// Shape: { message: string, kind: 'info' | 'warning' } | null
export const opNotice = signal(null);
export const modalContent = signal(null);
// Connection state for the Dataset Management app. null = not yet checked
// (shell shows a connecting state), true/false after the healthz probe. The
// shell passes this to <App connected={...}/>.
export const connected = signal(null);
export const statsSummary = signal(null); // { collection, health, label } | null
export const operations = signal([]);
export const operationsLoaded = signal(false);
export const pendingOperations = signal(null); // { ops, changedOps } | null
export const opsSearch = signal('');
export const undoToast = signal(null); // { id, message, action, ts, ttlMs, status, error } | null
// One-shot pipeline prefill consumed by DataPanel's [collection] effect: set by
// the popup's "Open in Dataset Management" button and by boot to restore the
// last remembered query. Cleared after the matching collection's effect applies it.
export const pendingPipelineLoad = signal(null); // { collection, pipelineText, variables? } | null

// Bulk-op selection state. selectionMode toggles whether RecordCard renders
// checkboxes and whether the RecordList toolbar shows bulk actions instead
// of the default toolbar. selectedIds is a Map<stringKey, originalId> where
// the key is the stringified _id (record._id?.$oid || String(record._id)) for
// fast Set-like lookup, and the value is the original _id (e.g. { $oid: '...' }
// for ObjectId collections, or a plain string for user-supplied ids). The
// original wrapper must round-trip to the server unchanged so $in queries match.
export const selectionMode = signal(false);
export const selectedIds = signal(new Map());
// True once the user has edited the pipeline (sort/filter/$match/load) since
// entering selection mode. Drives the "selection may no longer match the
// current view" banner. Cleared on enter/exit selection, on collection switch,
// and after "View selected only" (which makes the pipeline match the selection
// exactly, so any prior drift is resolved).
export const selectionPipelineDirty = signal(false);

// Suffix that namespaces per-org client state (saved/recent/last queries) so it
// isn't shared across projects. Prefers the org id; falls back to the origin so
// the data is still per-project (never global) if the org id is unavailable.
export function scopeSuffix() {
  return orgId.value != null ? `org:${orgId.value}` : `domain:${domain.value}`;
}
