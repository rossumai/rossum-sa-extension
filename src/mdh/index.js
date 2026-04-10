import * as api from './api.js';
import * as state from './state.js';
import { initSidebar } from './ui/sidebar.js';
import { initRecords } from './ui/records.js';
import { initAggregate } from './ui/aggregate.js';
import { initIndexes } from './ui/indexes.js';
import { initSearchIndexes } from './ui/search-indexes.js';
import { initBulkWrite } from './ui/bulk-write.js';

async function boot() {
  const { mdhToken, mdhDomain } = await chrome.storage.local.get(['mdhToken', 'mdhDomain']);

  const connectionBar = document.getElementById('connectionBar');
  if (!mdhToken || !mdhDomain) {
    connectionBar.innerHTML = '<span class="connection-dot error"></span> Not connected — open a Rossum page and click Data Storage in the extension popup';
    return;
  }

  state.set({ domain: mdhDomain, token: mdhToken });
  api.init(mdhDomain, mdhToken);

  try {
    await api.healthz();
    connectionBar.innerHTML = `<span class="connection-dot"></span> Connected to ${mdhDomain}`;
  } catch {
    connectionBar.innerHTML = `<span class="connection-dot error"></span> Cannot reach ${mdhDomain}`;
  }

  state.on('errorChanged', (error) => {
    const banner = document.getElementById('errorBanner');
    if (error) {
      banner.innerHTML = `<span>${error.message}</span><button class="dismiss" onclick="this.parentElement.classList.add('hidden')">\u00d7</button>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  });

  state.on('loadingChanged', (loading) => {
    document.getElementById('loadingOverlay').classList.toggle('hidden', !loading);
  });

  const tabs = document.querySelectorAll('.tab-bar .tab');
  const panels = ['records', 'aggregate', 'indexes', 'search-indexes', 'bulk-write'];

  function showPanel(name) {
    for (const p of panels) {
      document.getElementById(`panel-${p}`).classList.toggle('hidden', p !== name);
    }
    for (const t of tabs) {
      t.classList.toggle('active', t.dataset.panel === name);
    }
    state.set({ activePanel: name });
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  }

  state.on('selectedCollectionChanged', (collection) => {
    document.getElementById('emptyState').classList.toggle('hidden', collection !== null);
    document.getElementById('mainContent').classList.toggle('hidden', collection === null);
  });

  initSidebar();
  initRecords();
  initAggregate();
  initIndexes();
  initSearchIndexes();
  initBulkWrite();
}

boot();
