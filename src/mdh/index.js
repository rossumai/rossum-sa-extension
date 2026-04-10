import * as api from './api.js';
import * as state from './state.js';
import * as cache from './cache.js';
import { initSidebar } from './ui/sidebar.js';
import { initDataPanel, prefetchRecords, prefetchTotalCount } from './ui/records.js';
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
    connectionBar.innerHTML = `<span class="connection-dot"></span> Connected to ${mdhDomain}<span id="cacheIndicator" class="cache-indicator"></span>`;
  } catch {
    connectionBar.innerHTML = `<span class="connection-dot error"></span> Cannot reach ${mdhDomain}`;
  }

  // Update cache indicator every second
  setInterval(() => {
    const el = document.getElementById('cacheIndicator');
    if (!el) return;
    const col = state.get('selectedCollection');
    const s = cache.stats(col);
    let text;
    if (s.fieldCount === 0) {
      text = 'cache: empty';
    } else if (s.age !== null) {
      const secs = Math.round(s.age / 1000);
      text = `cache: ${s.fieldCount} objects \u00b7 ${secs < 2 ? 'fresh' : secs + 's ago'}`;
    } else {
      text = `cache: ${s.fieldCount} objects`;
    }
    el.textContent = text;
  }, 1000);

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
    if (collection) startBackgroundPrefetch();
  });

  initSidebar();
  initDataPanel();
  initIndexes();
  initSearchIndexes();
  initSidebarResize();
}

let prefetchController = null;

function startBackgroundPrefetch() {
  if (prefetchController) prefetchController.abort();
  prefetchController = new AbortController();
  const signal = prefetchController.signal;
  const collections = state.get('collections');
  const selected = state.get('selectedCollection');
  const others = collections.filter((c) => c !== selected);
  prefetchBatches(others, signal);
}

async function prefetchBatches(collections, signal) {
  const BATCH = 5;
  const DELAY = 200;
  for (let i = 0; i < collections.length; i += BATCH) {
    if (signal.aborted) return;
    const batch = collections.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map((col) =>
        Promise.allSettled([
          prefetchRecords(col),
          prefetchTotalCount(col),
        ]),
      ),
    );
    if (i + BATCH < collections.length && !signal.aborted) {
      await new Promise((r) => setTimeout(r, DELAY));
    }
  }
}

function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebarResizer');

  // Restore saved width
  chrome.storage.local.get(['mdhSidebarWidth'], ({ mdhSidebarWidth }) => {
    if (mdhSidebarWidth) {
      sidebar.style.width = mdhSidebarWidth + 'px';
      sidebar.style.minWidth = mdhSidebarWidth + 'px';
    }
  });

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
      chrome.storage.local.set({ mdhSidebarWidth: sidebar.getBoundingClientRect().width });
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

boot();
