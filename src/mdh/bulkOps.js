import * as api from './api.js';
import { showUndo } from './undo.js';

// Single source of truth for the snapshot-based undo size limit.
// Sidebar.jsx and the BulkDelete/BulkUpdate modals all import this — keeping
// the value in one place avoids drift between collection-drop and bulk-op
// undo behavior.
export const UNDO_LIMIT = 1000;

const SAMPLE_LIMIT = 5;

export function selectionToFilter(ids) {
  return { _id: { $in: [...ids] } };
}

export async function previewMatch(collection, filter, { signal } = {}) {
  const [countRes, sampleRes] = await Promise.all([
    api.aggregate(collection, [{ $match: filter }, { $count: 'total' }], { signal }),
    api.aggregate(collection, [{ $match: filter }, { $limit: SAMPLE_LIMIT }], { signal }),
  ]);
  return {
    count: countRes.result?.[0]?.total ?? 0,
    sample: sampleRes.result || [],
  };
}

function pluralize(n, singular = 'record') {
  return `${n} ${singular}${n !== 1 ? 's' : ''}`;
}

export async function runBulkDelete(collection, filter, { count, undoMessage, onSuccess } = {}) {
  let snapshot = null;
  if (count > 0 && count <= UNDO_LIMIT) {
    const res = await api.aggregate(collection, [{ $match: filter }]);
    snapshot = res.result || [];
  }

  await api.deleteMany(collection, filter);
  if (onSuccess) await onSuccess();

  if (snapshot && snapshot.length > 0) {
    showUndo({
      message: undoMessage || `Deleted ${pluralize(snapshot.length)}`,
      action: async () => {
        await api.insertMany(collection, snapshot, false);
        if (onSuccess) await onSuccess();
      },
    });
  }
}

export async function runBulkUpdate(collection, filter, updateExpr, { count, undoMessage, onSuccess } = {}) {
  let snapshot = null;
  if (count > 0 && count <= UNDO_LIMIT) {
    const res = await api.aggregate(collection, [{ $match: filter }]);
    snapshot = res.result || [];
  }

  await api.updateMany(collection, filter, updateExpr);
  if (onSuccess) await onSuccess();

  if (snapshot && snapshot.length > 0) {
    showUndo({
      message: undoMessage || `Updated ${pluralize(snapshot.length)}`,
      action: async () => {
        // Restore originals via deleteMany + insertMany. We previously tried
        // bulkWrite first with a per-doc replaceOne fallback, but the bulkWrite
        // wire format isn't reliably accepted by the data-storage service —
        // calls would return success without actually replacing the documents,
        // leaving the user with a "successful" undo that didn't undo anything.
        // delete + insert uses two well-tested endpoints with no ambiguity.
        // Briefly the docs disappear between the two calls; acceptable for a
        // single-user workflow.
        const ids = snapshot.map((d) => d._id);
        await api.deleteMany(collection, { _id: { $in: ids } });
        await api.insertMany(collection, snapshot, false);
        if (onSuccess) await onSuccess();
      },
    });
  }
}
