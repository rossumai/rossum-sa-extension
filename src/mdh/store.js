// src/mdh/store.js
import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');
export const collections = signal([]);
export const selectedCollection = signal(null);
export const records = signal([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal('data');
export const activeView = signal('collection');
export const loading = signal(false);
export const error = signal(null);
export const modalContent = signal(null);
export const aiEnabled = signal(false);
export const aiStatus = signal('idle'); // idle | downloading | ready | unavailable
export const aiDownloadProgress = signal(0);
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
