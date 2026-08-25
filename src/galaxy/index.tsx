import * as api from './api.js';
import * as store from './store.js';
import { buildGraph } from './graph.js';

// Probe the session, then kick off the (potentially slow) graph load WITHOUT
// awaiting it. This lets the console shell paint the rail + the loading overlay
// immediately on boot/reload, instead of blocking the first render until the
// whole org graph has been fetched.
export async function initGalaxy() {
  store.loading.value = true;
  try {
    await api.whoami();
  } catch (err: any) {
    store.error.value = err.message || 'Failed to verify session';
    store.connected.value = false;
    store.loading.value = false;
    return;
  }
  store.connected.value = true;
  loadGraph();
}

export async function loadGraph() {
  store.loading.value = true;
  store.loadedCount.value = 0;
  try {
    const raw = await api.fetchOrgResources({
      onProgress: (n) => {
        store.loadedCount.value = n;
      },
    });
    store.graph.value = buildGraph(raw);
  } catch (err: any) {
    store.error.value = err.message || 'Failed to load the organization';
  } finally {
    store.loading.value = false;
  }
}
