import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

export function initSearchIndexes() {
  const panelEl = document.getElementById('panel-search-indexes');

  panelEl.innerHTML = `
    <div class="toolbar">
      <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
      <button id="refreshSearchIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
    </div>
    <div id="searchIndexList" class="index-list"></div>
    <div id="searchIndexOpStatus" class="hidden" style="padding:8px 16px"></div>
    <div class="index-create-form" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;gap:6px;align-items:center">
        <span class="toolbar-label">Name:</span>
        <input id="searchIndexName" class="input" style="flex:1" placeholder="my_search_index" />
      </div>
      <div>
        <span class="toolbar-label" style="display:block;margin-bottom:4px">Mappings (JSON):</span>
        <textarea id="searchIndexMappings" class="input" style="width:100%;min-height:80px">{
  "dynamic": true
}</textarea>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <span class="toolbar-label">Analyzer:</span>
        <input id="searchIndexAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
        <span class="toolbar-label" style="width:auto">Search Analyzer:</span>
        <input id="searchIndexSearchAnalyzer" class="input" style="flex:1" placeholder="(optional)" />
      </div>
      <div>
        <button id="createSearchIndexBtn" class="btn btn-primary btn-sm">Create Search Index</button>
      </div>
    </div>
  `;

  panelEl.querySelector('#refreshSearchIndexes').addEventListener('click', loadSearchIndexes);
  panelEl.querySelector('#createSearchIndexBtn').addEventListener('click', doCreateSearchIndex);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'search-indexes') loadSearchIndexes();
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
    const name = typeof idx === 'string' ? idx : (idx.name || JSON.stringify(idx));
    const row = document.createElement('div');
    row.className = 'index-row';
    row.innerHTML = `
      <div><span class="index-name">${escapeHtml(name)}</span></div>
      <button class="btn btn-sm btn-danger drop-btn">Drop</button>
    `;
    row.querySelector('.drop-btn').addEventListener('click', () => {
      confirmModal(
        'Drop search index?',
        `Drop search index "${name}"?`,
        () => doDropSearchIndex(name),
      );
    });
    listEl.appendChild(row);
  }
}

async function doCreateSearchIndex() {
  const nameInput = document.getElementById('searchIndexName');
  const mappingsInput = document.getElementById('searchIndexMappings');
  const analyzerInput = document.getElementById('searchIndexAnalyzer');
  const searchAnalyzerInput = document.getElementById('searchIndexSearchAnalyzer');
  const statusEl = document.getElementById('searchIndexOpStatus');

  const indexName = nameInput.value.trim();
  if (!indexName) {
    nameInput.classList.add('input-error');
    return;
  }
  nameInput.classList.remove('input-error');

  let mappings;
  try {
    mappings = JSON.parse(mappingsInput.value);
    mappingsInput.classList.remove('input-error');
  } catch {
    mappingsInput.classList.add('input-error');
    return;
  }

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

function showAsyncStatus(statusEl, message) {
  const operationId = message ? message.match(/[a-f0-9]{24}/i)?.[0] : null;
  if (!operationId) {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = `
    <div class="op-status">
      <span class="op-status-badge running">pending</span>
      <span>Operation: ${operationId}</span>
      <button class="btn btn-sm check-btn" style="margin-left:auto">Check Status</button>
    </div>
  `;
  statusEl.querySelector('.check-btn').addEventListener('click', async () => {
    try {
      const res = await api.checkOperationStatus(operationId);
      const op = res.result || {};
      const badgeClass = op.status === 'FINISHED' ? 'finished' : op.status === 'FAILED' ? 'failed' : 'running';
      statusEl.innerHTML = `
        <div class="op-status">
          <span class="op-status-badge ${badgeClass}">${(op.status || 'unknown').toLowerCase()}</span>
          <span>Operation: ${operationId}</span>
          ${op.status !== 'FINISHED' && op.status !== 'FAILED' ? '<button class="btn btn-sm check-btn" style="margin-left:auto">Check Status</button>' : ''}
          ${op.error_message ? `<span style="color:var(--danger)">${escapeHtml(op.error_message)}</span>` : ''}
        </div>
      `;
      const btn = statusEl.querySelector('.check-btn');
      if (btn) btn.addEventListener('click', () => showAsyncStatus(statusEl, message));
    } catch (err) {
      state.set({ error: { message: err.message } });
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
