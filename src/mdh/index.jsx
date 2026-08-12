import { effect } from '@preact/signals';
import * as api from './api.js';
import { probeAgent } from '../agent/agentApi.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { prefetchForPanel, prefetchAll } from './prefetch.js';
import { lastPipelineKey, bootPrefillFor } from './lastPipeline.js';
import { resolveTabState, writeTabState } from '../console/tabState.js';

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

// Resolve Agent API ("Mr. Fabry") availability for the org, caching per-org in
// sessionStorage so a same-session reload doesn't re-probe. Never throws.
export async function resolveAiAvailability(orgKey) {
  const key = `mdhAiAvailable_${orgKey}`;
  let cached = null;
  try { cached = sessionStorage.getItem(key); } catch {}
  if (cached === 'true' || cached === 'false') return cached === 'true';
  const available = await probeAgent();
  try { sessionStorage.setItem(key, String(available)); } catch {}
  return available;
}

// Post-auth setup for the Dataset Management app. The shell has already resolved
// auth, set store.domain/token, and called api.init. This restores persisted
// view state, applies any pipeline prefill, probes the connection, and registers
// the app's effects. Runs once (the shell memoizes per app).
export async function initMdh({ pendingCollection, pendingPipeline, pendingVariables, pendingVariableTypes } = {}) {
  // Resolve the org id first so per-org keys (last pipeline here, and saved/recent
  // in QueryHistory) are correct before any scoped read. Failure -> null -> the
  // domain-scoped fallback in scopeSuffix.
  store.orgId.value = await api.getOrgId();

  // AI pipeline input: probe the Agent API's health endpoint without blocking
  // boot. A hang or error simply leaves aiAvailable false (the input stays hidden).
  resolveAiAvailability(store.orgId.value || store.domain.value)
    .then((available) => { store.aiAvailable.value = available; })
    .catch(() => {});

  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch',
    'mdhStagesAutoscroll', 'mdhStagesSampleSize', 'mdhStagesShowDef', 'mdhStagesSourceOpen',
  ]);

  // Navigation state is per-tab: prefer this tab's sessionStorage, fall back to
  // the chrome.storage.local seed (already in `stored`). Stages options stay global.
  const tab = resolveTabState(
    ['mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch'],
    stored,
  );

  if (tab.mdhActiveView === 'operations' || tab.mdhActiveView === 'overview') {
    store.activeView.value = tab.mdhActiveView;
  }
  if (tab.mdhSelectedCollection) {
    store.selectedCollection.value = tab.mdhSelectedCollection;
  }
  if (tab.mdhActivePanel) {
    store.activePanel.value = tab.mdhActivePanel;
  }
  if (typeof tab.mdhOpsSearch === 'string') {
    store.opsSearch.value = tab.mdhOpsSearch;
  }
  if (typeof stored.mdhStagesAutoscroll === 'boolean') {
    store.stagesAutoscroll.value = stored.mdhStagesAutoscroll;
  }
  if (stored.mdhStagesSampleSize != null) {
    store.stagesSampleSize.value = store.coerceStageSampleSize(stored.mdhStagesSampleSize);
  }
  if (typeof stored.mdhStagesShowDef === 'boolean') {
    store.stagesShowDef.value = stored.mdhStagesShowDef;
  }
  if (typeof stored.mdhStagesSourceOpen === 'boolean') {
    store.stagesSourceOpen.value = stored.mdhStagesSourceOpen;
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
        placeholderTypes: pendingVariableTypes || undefined,
      };
    }
  }

  // The last pipeline is keyed per-collection, so resolve the collection first
  // (including any pendingCollection override above), then fetch that key.
  const lpKey = lastPipelineKey(store.selectedCollection.value);
  const lpStored = await chrome.storage.local.get(lpKey);
  const restoredPipeline = bootPrefillFor(
    lpStored[lpKey],
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
    writeTabState('mdhActiveView', store.activeView.value);
  });
  effect(() => {
    const v = store.selectedCollection.value;
    if (v) writeTabState('mdhSelectedCollection', v);
  });
  effect(() => {
    writeTabState('mdhActivePanel', store.activePanel.value);
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesAutoscroll: store.stagesAutoscroll.value });
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesSampleSize: store.stagesSampleSize.value });
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesShowDef: store.stagesShowDef.value });
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesSourceOpen: store.stagesSourceOpen.value });
  });
  effect(() => {
    writeTabState('mdhOpsSearch', store.opsSearch.value);
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
