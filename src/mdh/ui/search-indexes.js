import * as api from '../api.js';
import * as state from '../state.js';
import * as cache from '../cache.js';
import { createJsonEditor } from './json-editor.js';
import { showAsyncStatus } from './utils.js';
import { renderIndexCard } from './index-card.js';
import { openModal, closeModal } from './modal.js';

function defaultTemplate() {
  return JSON.stringify({
    indexName: 'my_search_index',
    mappings: { dynamic: true },
  }, null, 2);
}

export function initSearchIndexes() {
  const panelEl = document.getElementById('panel-search-indexes');
  panelEl.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
    <button id="createSearchIndexOpenBtn" class="btn btn-success btn-sm">+ Create</button>
    <button id="refreshSearchIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
  `;
  panelEl.appendChild(toolbar);

  const listEl = document.createElement('div');
  listEl.id = 'searchIndexList';
  listEl.className = 'index-list';
  panelEl.appendChild(listEl);

  const statusEl = document.createElement('div');
  statusEl.id = 'searchIndexOpStatus';
  statusEl.className = 'hidden';
  statusEl.style.padding = '8px 16px';
  panelEl.appendChild(statusEl);

  toolbar.querySelector('#refreshSearchIndexes').addEventListener('click', () => {
    const col = state.get('selectedCollection');
    if (col) cache.invalidate(col, 'searchIndexes');
    loadSearchIndexes();
  });
  toolbar.querySelector('#createSearchIndexOpenBtn').addEventListener('click', openCreateModal);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'search-indexes') loadSearchIndexes();
  });

  state.on('selectedCollectionChanged', (collection) => {
    if (collection) loadSearchIndexes();
  });
}

function openCreateModal() {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const hint = document.createElement('div');
  hint.className = 'modal-field-label';
  hint.textContent = 'collectionName is set automatically from the selected collection';
  body.appendChild(hint);

  const editor = createJsonEditor({ value: defaultTemplate(), minHeight: '250px' });
  body.appendChild(editor.el);

  const errorHint = document.createElement('div');
  errorHint.className = 'input-hint';
  body.appendChild(errorHint);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.textContent = 'Create Search Index';
  createBtn.addEventListener('click', async () => {
    if (!editor.isValid()) {
      errorHint.textContent = 'Invalid JSON';
      return;
    }
    let parsed;
    try { parsed = editor.getParsed(); } catch { return; }

    const { indexName, mappings, analyzer, analyzers, searchAnalyzer, synonyms } = parsed;
    if (!indexName || !mappings) {
      errorHint.textContent = 'indexName and mappings are required';
      return;
    }
    errorHint.textContent = '';

    const opts = { indexName, mappings };
    if (analyzer) opts.analyzer = analyzer;
    if (analyzers) opts.analyzers = analyzers;
    if (searchAnalyzer) opts.searchAnalyzer = searchAnalyzer;
    if (synonyms) opts.synonyms = synonyms;

    try {
      state.set({ loading: true, error: null });
      const res = await api.createSearchIndex(state.get('selectedCollection'), opts);
      cache.invalidate(state.get('selectedCollection'), 'searchIndexes');
      state.set({ loading: false });
      closeModal();
      showAsyncStatus(document.getElementById('searchIndexOpStatus'), res.message);
      await loadSearchIndexes();
    } catch (err) {
      state.set({ loading: false });
      errorHint.textContent = err.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  body.appendChild(actions);

  openModal('Create Search Index', body);
  requestAnimationFrame(() => editor.refresh());
}

async function loadSearchIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  const cached = cache.get(collection, 'searchIndexes');
  if (cached !== null) {
    renderSearchIndexes(cached);
    return;
  }

  const isVisible = state.get('activePanel') === 'search-indexes';
  try {
    if (isVisible) state.set({ loading: true, error: null });
    const res = await api.listSearchIndexes(collection, false);
    const indexes = res.result || [];
    cache.set(collection, 'searchIndexes', indexes);
    if (isVisible) state.set({ loading: false });
    renderSearchIndexes(indexes);
  } catch (err) {
    if (isVisible) state.set({ error: { message: err.message }, loading: false });
  }
}

function renderSearchIndexes(indexes) {
  const listEl = document.getElementById('searchIndexList');
  listEl.replaceChildren();

  if (indexes.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:12px">No search indexes</div>';
    return;
  }

  for (const idx of indexes) {
    const isObj = typeof idx === 'object' && idx !== null;
    const name = isObj ? (idx.name || '(unnamed)') : String(idx);

    const badges = [];
    if (isObj && idx.status) {
      const cls = idx.status === 'READY' ? 'index-badge-ready'
        : (idx.status === 'PENDING' || idx.status === 'BUILDING') ? 'index-badge-pending' : '';
      badges.push({ text: idx.status.toLowerCase(), cls });
    }
    if (isObj && idx.type) badges.push({ text: idx.type });

    listEl.appendChild(renderIndexCard({
      name,
      badges,
      definition: isObj ? idx : null,
      canDrop: true,
      onDrop: () => doDropSearchIndex(name),
    }));
  }
}

async function doDropSearchIndex(indexName) {
  const statusEl = document.getElementById('searchIndexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropSearchIndex(state.get('selectedCollection'), indexName);
    cache.invalidate(state.get('selectedCollection'), 'searchIndexes');
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadSearchIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}
