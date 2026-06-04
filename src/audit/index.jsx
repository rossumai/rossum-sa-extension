import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { SOURCE_ORDER } from './sources/index.js';
import { fetchActive } from './query.js';

// Restore persisted per-source state, merging only known sources/keys over the
// defaults so a stale stored shape can't corrupt the store.
function restore(stored) {
  if (SOURCE_ORDER.includes(stored.auditActiveSource)) {
    store.activeSource.value = stored.auditActiveSource;
  }
  const saved = stored.auditFiltersBySource;
  if (saved && typeof saved === 'object') {
    const merged = { ...store.filtersBySource.value };
    for (const key of SOURCE_ORDER) {
      if (saved[key] && typeof saved[key] === 'object') {
        // Page size is fixed (no user control); always force it back to the default.
        merged[key] = { ...merged[key], ...saved[key], cursor: null, page: 1, pageSize: 100 };
      }
    }
    store.filtersBySource.value = merged;
  }
}

export async function initAudit() {
  const stored = await chrome.storage.local.get(['auditActiveSource', 'auditFiltersBySource']);
  restore(stored);

  let connected = false;
  try { await api.whoami(); connected = true; }
  catch (err) { connected = false; store.error.value = err.message || 'Failed to verify session'; }
  store.connected.value = connected;
  if (!connected) return;

  effect(() => { chrome.storage.local.set({ auditActiveSource: store.activeSource.value }); });
  effect(() => { chrome.storage.local.set({ auditFiltersBySource: store.filtersBySource.value }); });

  let queryController = null;
  effect(() => {
    const _src = store.activeSource.value;
    const _f = store.filtersBySource.value;
    const _app = activeApp.value;
    if (activeApp.value !== 'audit') return;
    if (queryController) queryController.abort();
    queryController = new AbortController();
    fetchActive({ signal: queryController.signal });
  });
}
