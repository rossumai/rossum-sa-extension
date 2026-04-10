import * as state from '../state.js';

const MAX_HISTORY = 30;

export async function addToHistory(collection, pipeline, variables) {
  const { queryHistory = [] } = await chrome.storage.sync.get('queryHistory');
  const key = collection + '::' + pipeline;
  const filtered = queryHistory.filter((e) => e.collection + '::' + e.pipeline !== key);
  const entry = { collection, pipeline, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  filtered.unshift(entry);
  await chrome.storage.sync.set({ queryHistory: filtered.slice(0, MAX_HISTORY) });
}

export async function saveQuery(collection, pipeline, name, variables) {
  const { savedQueries = [] } = await chrome.storage.sync.get('savedQueries');
  const entry = { collection, pipeline, name, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  savedQueries.push(entry);
  await chrome.storage.sync.set({ savedQueries });
}

export async function unsaveQuery(collection, pipeline) {
  const { savedQueries = [] } = await chrome.storage.sync.get('savedQueries');
  const key = collection + '::' + pipeline;
  await chrome.storage.sync.set({ savedQueries: savedQueries.filter((q) => q.collection + '::' + q.pipeline !== key) });
}

async function getHistory() {
  const { queryHistory = [] } = await chrome.storage.sync.get('queryHistory');
  return queryHistory;
}

async function getSaved() {
  const { savedQueries = [] } = await chrome.storage.sync.get('savedQueries');
  return savedQueries;
}

export async function isSaved(collection, pipeline) {
  const { savedQueries = [] } = await chrome.storage.sync.get('savedQueries');
  const key = collection + '::' + pipeline;
  return savedQueries.some((q) => q.collection + '::' + q.pipeline === key);
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Build a lookup of saved queries keyed by collection::pipeline
function buildSavedIndex(savedItems) {
  const index = new Map();
  for (const item of savedItems) {
    const key = item.collection + '::' + item.pipeline;
    if (!index.has(key)) index.set(key, item.name);
  }
  return index;
}

// ── History panel ───────────────────────────────

export function renderHistoryPanel(onLoad) {
  const panel = document.createElement('div');
  panel.className = 'query-history-panel';

  const listEl = document.createElement('div');
  listEl.className = 'query-history-list';
  panel.appendChild(listEl);

  async function refresh() {
    const [items, savedItems] = await Promise.all([getHistory(), getSaved()]);
    const savedIndex = buildSavedIndex(savedItems);
    const currentCollection = state.get('selectedCollection');
    listEl.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'query-history-empty';
      empty.textContent = 'No query history yet';
      listEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const key = item.collection + '::' + item.pipeline;
      const savedName = savedIndex.get(key) || null;
      listEl.appendChild(buildRow(item, currentCollection, null, onLoad, () => panel.remove()));
    }
  }

  refresh();
  return panel;
}

// ── Saved queries panel ─────────────────────────

export function renderSavedPanel(onLoad) {
  const panel = document.createElement('div');
  panel.className = 'query-history-panel';

  const listEl = document.createElement('div');
  listEl.className = 'query-history-list';
  panel.appendChild(listEl);

  async function refresh() {
    const items = await getSaved();
    const currentCollection = state.get('selectedCollection');
    listEl.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'query-history-empty';
      empty.textContent = 'No saved queries';
      listEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = buildRow(item, currentCollection, item.name, onLoad, () => panel.remove());

      const starBtn = document.createElement('button');
      starBtn.className = 'query-history-unsave-btn';
      starBtn.textContent = '\u2605';
      starBtn.title = 'Remove from saved';
      starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await unsaveQuery(item.collection, item.pipeline);
        refresh();
      });
      row.appendChild(starBtn);

      listEl.appendChild(row);
    }
  }

  refresh();
  return panel;
}

// ── Shared row builder ──────────────────────────

function buildRow(item, currentCollection, savedName, onLoad, onDismiss) {
  const row = document.createElement('div');
  row.className = 'query-history-item';
  if (item.collection === currentCollection) row.classList.add('query-history-item-current');

  const info = document.createElement('div');
  info.className = 'query-history-item-info';
  info.addEventListener('click', () => {
    onLoad(item.pipeline, item.collection, item.variables);
    onDismiss();
  });

  const colBadge = document.createElement('span');
  colBadge.className = 'query-history-collection';
  colBadge.textContent = item.collection;
  info.appendChild(colBadge);

  if (savedName) {
    const nameEl = document.createElement('span');
    nameEl.className = 'query-history-name';
    nameEl.textContent = savedName;
    info.appendChild(nameEl);
  }

  const timeEl = document.createElement('span');
  timeEl.className = 'query-history-time';
  timeEl.textContent = formatTime(item.ts);
  info.appendChild(timeEl);

  const preview = document.createElement('div');
  preview.className = 'query-history-preview';
  const text = item.pipeline || '';
  preview.textContent = text.length > 150 ? text.slice(0, 150) + '...' : text;
  info.appendChild(preview);

  if (item.variables && Object.keys(item.variables).length > 0) {
    const vars = document.createElement('div');
    vars.className = 'query-history-variables';
    const parts = Object.entries(item.variables)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `{${k}}=${v}`);
    if (parts.length > 0) {
      vars.textContent = parts.join(', ');
      info.appendChild(vars);
    }
  }

  row.appendChild(info);
  return row;
}
