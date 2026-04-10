import * as api from '../api.js';
import * as state from '../state.js';
import { createJsonEditor } from './json-editor.js';
import { showAsyncStatus } from './utils.js';
import { renderIndexCard } from './index-card.js';

let mappingsEditor = null;

export function initSearchIndexes() {
  const panelEl = document.getElementById('panel-search-indexes');
  panelEl.innerHTML = '';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
    <button id="refreshSearchIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
  `;
  panelEl.appendChild(toolbar);

  // Index list
  const listEl = document.createElement('div');
  listEl.id = 'searchIndexList';
  listEl.className = 'index-list';
  panelEl.appendChild(listEl);

  // Op status
  const statusEl = document.createElement('div');
  statusEl.id = 'searchIndexOpStatus';
  statusEl.className = 'hidden';
  statusEl.style.padding = '8px 16px';
  panelEl.appendChild(statusEl);

  // Create form
  const form = document.createElement('div');
  form.className = 'search-index-create-form';

  form.innerHTML = `
    <div class="search-index-form-header">Create Search Index</div>
    <div class="search-index-form-row">
      <span class="search-index-form-label">Name:</span>
      <input id="searchIndexName" class="input" style="flex:1" placeholder="my_search_index" />
    </div>
  `;

  const mappingsLabel = document.createElement('div');
  mappingsLabel.className = 'search-index-form-label';
  mappingsLabel.style.marginBottom = '4px';
  mappingsLabel.textContent = 'Mappings:';
  form.appendChild(mappingsLabel);

  mappingsEditor = createJsonEditor({ value: '{\n  "dynamic": true\n}', minHeight: '80px' });
  form.appendChild(mappingsEditor.el);

  const optRow = document.createElement('div');
  optRow.className = 'search-index-form-row';
  optRow.style.marginTop = '8px';
  optRow.innerHTML = `
    <span class="search-index-form-label">Analyzer:</span>
    <input id="searchIndexAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
    <span class="search-index-form-label" style="margin-left:8px">Search Analyzer:</span>
    <input id="searchIndexSearchAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
  `;
  form.appendChild(optRow);

  const btnRow = document.createElement('div');
  btnRow.style.marginTop = '8px';
  const createBtn = document.createElement('button');
  createBtn.id = 'createSearchIndexBtn';
  createBtn.className = 'btn btn-primary btn-sm';
  createBtn.textContent = 'Create Search Index';
  btnRow.appendChild(createBtn);
  form.appendChild(btnRow);

  panelEl.appendChild(form);

  toolbar.querySelector('#refreshSearchIndexes').addEventListener('click', loadSearchIndexes);
  createBtn.addEventListener('click', doCreateSearchIndex);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'search-indexes') {
      loadSearchIndexes();
      if (mappingsEditor) requestAnimationFrame(() => mappingsEditor.refresh());
    }
  });

  state.on('selectedCollectionChanged', () => {
    if (state.get('activePanel') === 'search-indexes') loadSearchIndexes();
  });
}

async function loadSearchIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  try {
    state.set({ loading: true, error: null });
    const res = await api.listSearchIndexes(collection, false);
    state.set({ loading: false });
    renderSearchIndexes(res.result || []);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderSearchIndexes(indexes) {
  const listEl = document.getElementById('searchIndexList');
  listEl.innerHTML = '';

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

async function doCreateSearchIndex() {
  const nameInput = document.getElementById('searchIndexName');
  const analyzerInput = document.getElementById('searchIndexAnalyzer');
  const searchAnalyzerInput = document.getElementById('searchIndexSearchAnalyzer');
  const statusEl = document.getElementById('searchIndexOpStatus');

  const indexName = nameInput.value.trim();
  if (!indexName) { nameInput.classList.add('input-error'); return; }
  nameInput.classList.remove('input-error');

  if (!mappingsEditor.isValid()) return;
  const mappings = mappingsEditor.getParsed();

  const opts = { indexName, mappings };
  const analyzer = analyzerInput.value.trim();
  const searchAnalyzer = searchAnalyzerInput.value.trim();
  if (analyzer) opts.analyzer = analyzer;
  if (searchAnalyzer) opts.searchAnalyzer = searchAnalyzer;

  try {
    state.set({ loading: true, error: null });
    const res = await api.createSearchIndex(state.get('selectedCollection'), opts);
    state.set({ loading: false });
    nameInput.value = '';
    showAsyncStatus(statusEl, res.message);
    await loadSearchIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

async function doDropSearchIndex(indexName) {
  const statusEl = document.getElementById('searchIndexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropSearchIndex(state.get('selectedCollection'), indexName);
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadSearchIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}
