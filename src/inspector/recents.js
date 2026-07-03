import * as store from './store.js';

export const MAX_RECENTS = 8;
const KEY = 'inspectorRecents';

// Pure: drop any existing entry with the same id, put the new one first, cap at max.
// id is the identity and is coerced to a string so numeric/string ids dedup together.
export function mergeRecent(list, entry, max = MAX_RECENTS) {
  const id = String(entry.id);
  const rest = (list || []).filter((r) => String(r.id) !== id);
  return [{ ...entry, id }, ...rest].slice(0, max);
}

function hasStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

// Async: read the persisted list into the signal. No-op (leaves []) outside an
// extension context or on any failure — recents are a convenience, never fatal.
export async function loadRecents() {
  try {
    if (!hasStorage()) return;
    const got = await chrome.storage.local.get(KEY);
    const list = got && Array.isArray(got[KEY]) ? got[KEY] : [];
    store.recents.value = list;
  } catch { /* ignore */ }
}

// Record a freshly-inspected annotation: update the signal, then persist.
export function recordRecent(entry) {
  if (entry == null || entry.id == null) return;
  const next = mergeRecent(store.recents.value, entry);
  store.recents.value = next;
  try { if (hasStorage()) chrome.storage.local.set({ [KEY]: next }); } catch { /* ignore */ }
}

export function clearRecents() {
  store.recents.value = [];
  try { if (hasStorage()) chrome.storage.local.remove(KEY); } catch { /* ignore */ }
}
