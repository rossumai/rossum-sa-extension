// src/rossum/annotate/undo.js — sessionStorage snapshot + revert (start→restore ops→cancel).
import { startAnnotation, applyContentOperations, cancelAnnotation } from './annotationWrite.js';
import { buildRestoreOperations, buildRemoveOperations } from './apply.js';
import { buildGridOp } from './grid.js';

export function snapKey(id) { return `rossum-sa-extension-annotate-snap-${id}`; }
export function saveSnapshot(id, snapshot, store = sessionStorage) {
  try { store.setItem(snapKey(id), JSON.stringify(snapshot)); } catch { /* ignore */ }
}
export function loadSnapshot(id, store = sessionStorage) {
  try { const s = store.getItem(snapKey(id)); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function clearSnapshot(id, store = sessionStorage) {
  try { store.removeItem(snapKey(id)); } catch { /* ignore */ }
}
export async function runUndo({ annotationId, deps, onProgress = () => {} }) {
  const store = deps.store || sessionStorage;
  const snapshot = loadSnapshot(annotationId, store);
  if (!snapshot) return { restored: 0 };
  // Remove rows we added FIRST, then restore original field values. (buildRestoreOperations
  // ignores the reserved __addedRows key.)
  const removeOps = buildRemoveOperations(snapshot.__addedRows || []);
  const gridOps = Object.entries(snapshot.__grids || {}).map(([mvId, g]) => buildGridOp(Number(mvId), g));
  const restoreOps = buildRestoreOperations(snapshot);
  if (!removeOps.length && !gridOps.length && !restoreOps.length) { clearSnapshot(annotationId, store); return { restored: 0 }; }
  onProgress('undo', 'Reverting changes…');
  await startAnnotation(annotationId, deps);
  try {
    await applyContentOperations(annotationId, [...removeOps, ...gridOps, ...restoreOps], deps);
  } finally {
    await cancelAnnotation(annotationId, deps);
  }
  clearSnapshot(annotationId, store);
  return { restored: removeOps.length + gridOps.length + restoreOps.length };
}
