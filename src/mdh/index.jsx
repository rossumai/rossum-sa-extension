import { h, render } from 'preact';
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import App from './components/App.jsx';
import { prefetchForPanel, prefetchAll } from './prefetch.js';

const POLL_DELAY_OPS_VISIBLE = 5_000;
const POLL_DELAY_VISIBLE = 30_000;
const POLL_DELAY_HIDDEN = 60_000;

let pollTimer = null;
let pollInFlight = false;

function currentPollDelay() {
  if (document.visibilityState === 'hidden') return POLL_DELAY_HIDDEN;
  if (store.activeView.value === 'operations') return POLL_DELAY_OPS_VISIBLE;
  return POLL_DELAY_VISIBLE;
}

async function pollTick() {
  pollInFlight = true;
  try { await pollOperations(); } catch {}
  pollInFlight = false;
  schedulePoll();
}

function schedulePoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollInFlight) return;
  pollTimer = setTimeout(pollTick, currentPollDelay());
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!pollInFlight) pollTick();
  } else {
    schedulePoll();
  }
}

const STRUCTURAL_FIELDS = ['status', 'error_type', 'message', 'dataset_name', 'type'];

function hasStructuralChange(prev, next) {
  for (const key of STRUCTURAL_FIELDS) {
    if ((prev[key] || '') !== (next[key] || '')) return true;
  }
  return false;
}

async function pollOperations() {
  try {
    const res = await api.listOperations();
    const newOps = res.operations || [];
    if (!store.operationsLoaded.value) {
      store.operations.value = newOps;
      store.operationsLoaded.value = true;
      return;
    }
    const prevById = new Map(store.operations.value.map((o) => [o._id, o]));
    const newById = new Map(newOps.map((o) => [o._id, o]));

    const changedOps = [];
    for (const nextOp of newOps) {
      const prevOp = prevById.get(nextOp._id);
      if (!prevOp || hasStructuralChange(prevOp, nextOp)) changedOps.push(nextOp);
    }

    // Live-merge existing rows in place: preserve position + structural fields,
    // adopt live fields (metadata/record_count/file_size, started, updated).
    // A fresh array ref every poll re-renders the panel so time-based values
    // (timeAgo, running duration) refresh too.
    store.operations.value = store.operations.value.map((prevOp) => {
      const nextOp = newById.get(prevOp._id);
      if (!nextOp) return prevOp;
      return {
        ...prevOp,
        metadata: nextOp.metadata,
        started: nextOp.started,
        updated: nextOp.updated,
      };
    });

    if (changedOps.length === 0) return;
    store.pendingOperations.value = { ops: newOps, changedOps };
  } catch {
    // Silent — polling errors shouldn't disrupt the UI.
  }
}

async function boot() {
  const stored = await chrome.storage.local.get([
    'mdhToken', 'mdhDomain',
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel',
  ]);
  const { mdhToken, mdhDomain } = stored;

  if (!mdhToken || !mdhDomain) {
    render(<App connected={false} />, document.getElementById('app'));
    return;
  }

  store.domain.value = mdhDomain;
  store.token.value = mdhToken;
  api.init(mdhDomain, mdhToken);

  if (stored.mdhActiveView === 'operations') {
    store.activeView.value = 'operations';
  }
  if (stored.mdhSelectedCollection) {
    store.selectedCollection.value = stored.mdhSelectedCollection;
  }
  if (stored.mdhActivePanel) {
    store.activePanel.value = stored.mdhActivePanel;
  }

  let connected = false;
  try {
    await api.healthz();
    connected = true;
  } catch {
    connected = false;
  }

  render(<App connected={connected} />, document.getElementById('app'));

  if (connected) {
    pollTick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    effect(() => {
      // Subscribe to activeView so we re-schedule with the right cadence.
      const _ = store.activeView.value;
      schedulePoll();
    });
  }

  effect(() => {
    chrome.storage.local.set({ mdhActiveView: store.activeView.value });
  });
  effect(() => {
    const v = store.selectedCollection.value;
    if (v) chrome.storage.local.set({ mdhSelectedCollection: v });
  });
  effect(() => {
    chrome.storage.local.set({ mdhActivePanel: store.activePanel.value });
  });

  let bgController = null;

  effect(() => {
    const selected = store.selectedCollection.value;
    if (!selected || store.collections.value.length === 0) return;

    if (bgController) bgController.abort();
    bgController = new AbortController();
    const signal = bgController.signal;

    const panel = store.activePanel.value;

    (async () => {
      await prefetchForPanel(selected, panel);
      if (signal.aborted) return;
      await prefetchAll(selected);
    })();
  });
}

boot();
