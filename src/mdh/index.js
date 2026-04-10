import * as api from './api.js';
import * as state from './state.js';
import { initSidebar } from './ui/sidebar.js';
import { initDataPanel } from './ui/records.js';
import { initIndexes } from './ui/indexes.js';
import { initSearchIndexes } from './ui/search-indexes.js';

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
  const panels = ['data', 'indexes', 'search-indexes'];

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
  initDataPanel();
  initIndexes();
  initSearchIndexes();
  initSidebarResize();
}

function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebarResizer');
  let startX, startWidth;

  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const newWidth = Math.max(160, Math.min(600, startWidth + e.clientX - startX));
      sidebar.style.width = newWidth + 'px';
      sidebar.style.minWidth = newWidth + 'px';
    }

    function onUp() {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

boot();
