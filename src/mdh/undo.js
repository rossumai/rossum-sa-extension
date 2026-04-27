import { undoToast } from './store.js';

const DEFAULT_TTL_MS = 10_000;

let nextId = 1;
let dismissTimer = null;

function clearDismissTimer() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

// Replaces any existing undo toast (mirrors Gmail's "Undo send" — at most one
// pending undo at a time; the previous opportunity has already passed).
export function showUndo({ message, action, ttlMs = DEFAULT_TTL_MS }) {
  clearDismissTimer();
  const id = nextId++;
  undoToast.value = {
    id,
    message,
    action,
    ts: Date.now(),
    ttlMs,
    status: 'pending', // pending | running | done | error
    error: null,
  };
  dismissTimer = setTimeout(() => {
    if (undoToast.value?.id === id && undoToast.value.status === 'pending') {
      undoToast.value = null;
    }
    dismissTimer = null;
  }, ttlMs);
  return id;
}

export async function triggerUndo() {
  const u = undoToast.value;
  if (!u || u.status !== 'pending') return;
  clearDismissTimer();
  undoToast.value = { ...u, status: 'running' };
  try {
    await u.action();
    if (undoToast.value?.id === u.id) {
      undoToast.value = { ...undoToast.value, status: 'done' };
      // Brief success flash, then auto-dismiss.
      setTimeout(() => {
        if (undoToast.value?.id === u.id) undoToast.value = null;
      }, 1500);
    }
  } catch (err) {
    if (undoToast.value?.id === u.id) {
      undoToast.value = { ...undoToast.value, status: 'error', error: err?.message || String(err) };
      // Leave the error visible longer so the user can read it.
      setTimeout(() => {
        if (undoToast.value?.id === u.id) undoToast.value = null;
      }, 6_000);
    }
  }
}

export function dismissUndo() {
  clearDismissTimer();
  undoToast.value = null;
}

// Test helper — reset module state.
export function _reset() {
  clearDismissTimer();
  nextId = 1;
  undoToast.value = null;
}
