import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { prefetchForPanel, prefetchAll } from './prefetch.js';
import { LAST_PIPELINE_KEY, bootPrefillFor } from './lastPipeline.js';

const POLL_DELAY_VISIBLE = 5_000;
const POLL_DELAY_HIDDEN = 60_000;

let pollTimer = null;
let pollInFlight = false;

function shouldPoll() {
  return activeApp.value === 'mdh' && store.activeView.value === 'operations';
}

function currentPollDelay() {
  return document.visibilityState === 'hidden' ? POLL_DELAY_HIDDEN : POLL_DELAY_VISIBLE;
}

async function pollTick() {
  if (!shouldPoll()) return;
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
  if (pollInFlight || !shouldPoll()) return;
  pollTimer = setTimeout(pollTick, currentPollDelay());
}

function onVisibilityChange() {
  if (!shouldPoll()) return;
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

// Post-auth setup for the Dataset Management app. The shell has already resolved
// auth, set store.domain/token, and called api.init. This restores persisted
// view state, applies any pipeline prefill, probes the connection, and registers
// the app's effects. Runs once (the shell memoizes per app).
export async function initMdh({ pendingCollection, pendingPipeline, pendingVariables } = {}) {
  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch', LAST_PIPELINE_KEY,
  ]);

  if (stored.mdhActiveView === 'operations' || stored.mdhActiveView === 'overview') {
    store.activeView.value = stored.mdhActiveView;
  }
  if (stored.mdhSelectedCollection) {
    store.selectedCollection.value = stored.mdhSelectedCollection;
  }
  if (stored.mdhActivePanel) {
    store.activePanel.value = stored.mdhActivePanel;
  }
  if (typeof stored.mdhOpsSearch === 'string') {
    store.opsSearch.value = stored.mdhOpsSearch;
  }

  if (pendingCollection) {
    store.activeView.value = 'collection';
    store.selectedCollection.value = pendingCollection;
    store.activePanel.value = 'data';
    if (pendingPipeline) {
      store.pendingPipelineLoad.value = {
        collection: pendingCollection,
        pipelineText: pendingPipeline,
        variables: pendingVariables || undefined,
      };
    }
  }

  const restoredPipeline = bootPrefillFor(
    stored[LAST_PIPELINE_KEY],
    store.selectedCollection.value,
    !!store.pendingPipelineLoad.value,
  );
  if (restoredPipeline) store.pendingPipelineLoad.value = restoredPipeline;

  let connected = false;
  try {
    await api.healthz();
    connected = true;
  } catch {
    connected = false;
  }
  store.connected.value = connected;

  if (connected) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    effect(() => {
      const view = store.activeView.value;
      const app = activeApp.value;
      if (app === 'mdh' && view === 'operations') {
        if (!pollInFlight && !pollTimer) pollTick();
      } else if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
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
  effect(() => {
    chrome.storage.local.set({ mdhOpsSearch: store.opsSearch.value });
  });

  let bgController = null;
  effect(() => {
    const selected = store.selectedCollection.value;
    if (activeApp.value !== 'mdh') return;
    if (!selected || store.collections.value.length === 0) return;

    if (bgController) bgController.abort();
    bgController = new AbortController();
    const signal = bgController.signal;

    const panel = store.activePanel.value;

    (async () => {
      await prefetchForPanel(selected, panel, { signal });
      if (signal.aborted) return;
      await prefetchAll(selected, { signal });
    })();
  });
}
