import { h, render } from 'preact';
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import App from './components/App.jsx';
import { prefetchForPanel, prefetchAll } from './prefetch.js';

async function boot() {
  const { mdhToken, mdhDomain } = await chrome.storage.local.get(['mdhToken', 'mdhDomain']);

  if (!mdhToken || !mdhDomain) {
    render(<App connected={false} />, document.getElementById('app'));
    return;
  }

  store.domain.value = mdhDomain;
  store.token.value = mdhToken;
  api.init(mdhDomain, mdhToken);

  let connected = false;
  try {
    await api.healthz();
    connected = true;
  } catch {
    connected = false;
  }

  render(<App connected={connected} />, document.getElementById('app'));

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
