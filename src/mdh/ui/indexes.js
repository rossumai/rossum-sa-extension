import * as api from '../api.js';
import * as state from '../state.js';
import * as cache from '../cache.js';
import { showAsyncStatus } from './utils.js';
import { renderIndexCard } from './index-card.js';
import { createJsonEditor } from './json-editor.js';
import { openModal, closeModal } from './modal.js';

function defaultTemplate() {
  return JSON.stringify({
    indexName: 'my_index',
    keys: { field: 1 },
    options: {},
  }, null, 2);
}

export function initIndexes() {
  const panelEl = document.getElementById('panel-indexes');
  panelEl.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <span style="flex:1;font-weight:500">Indexes</span>
    <button id="createIndexOpenBtn" class="btn btn-success btn-sm">+ Create</button>
    <button id="refreshIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
  `;
  panelEl.appendChild(toolbar);

  const listEl = document.createElement('div');
  listEl.id = 'indexList';
  listEl.className = 'index-list';
  panelEl.appendChild(listEl);

  const statusEl = document.createElement('div');
  statusEl.id = 'indexOpStatus';
  statusEl.className = 'hidden';
  statusEl.style.padding = '8px 16px';
  panelEl.appendChild(statusEl);

  toolbar.querySelector('#refreshIndexes').addEventListener('click', () => {
    const col = state.get('selectedCollection');
    if (col) cache.invalidate(col, 'indexes');
    loadIndexes();
  });
  toolbar.querySelector('#createIndexOpenBtn').addEventListener('click', openCreateModal);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'indexes') loadIndexes();
  });

  state.on('selectedCollectionChanged', (collection) => {
    if (collection) loadIndexes();
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
  createBtn.textContent = 'Create Index';
  createBtn.addEventListener('click', async () => {
    if (!editor.isValid()) {
      errorHint.textContent = 'Invalid JSON';
      return;
    }
    let parsed;
    try { parsed = editor.getParsed(); } catch { return; }

    const { indexName, keys, options } = parsed;
    if (!indexName || !keys) {
      errorHint.textContent = 'indexName and keys are required';
      return;
    }
    errorHint.textContent = '';

    try {
      state.set({ loading: true, error: null });
      const res = await api.createIndex(state.get('selectedCollection'), indexName, keys, options || {});
      cache.invalidate(state.get('selectedCollection'), 'indexes');
      state.set({ loading: false });
      closeModal();
      showAsyncStatus(document.getElementById('indexOpStatus'), res.message);
      await loadIndexes();
    } catch (err) {
      state.set({ loading: false });
      errorHint.textContent = err.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  body.appendChild(actions);

  openModal('Create Index', body);
  requestAnimationFrame(() => editor.refresh());
}

async function loadIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  const cached = cache.get(collection, 'indexes');
  if (cached !== null) {
    renderIndexes(cached);
    return;
  }

  const isVisible = state.get('activePanel') === 'indexes';
  try {
    if (isVisible) state.set({ loading: true, error: null });
    const res = await api.listIndexes(collection, false);
    const indexes = res.result || [];
    cache.set(collection, 'indexes', indexes);
    if (isVisible) state.set({ loading: false });
    renderIndexes(indexes);
  } catch (err) {
    if (isVisible) state.set({ error: { message: err.message }, loading: false });
  }
}

function renderIndexes(indexes) {
  const listEl = document.getElementById('indexList');
  listEl.replaceChildren();

  if (indexes.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:12px">No indexes</div>';
    return;
  }

  for (const idx of indexes) {
    const isObj = typeof idx === 'object' && idx !== null;
    const name = isObj ? (idx.name || '(unnamed)') : String(idx);
    const isDefault = name === '_id_';

    const badges = [];
    if (isDefault) badges.push({ text: 'default', cls: 'index-badge-default' });
    if (isObj && idx.unique) badges.push({ text: 'unique', cls: 'index-badge-unique' });
    if (isObj && idx.sparse) badges.push({ text: 'sparse' });
    if (isObj && idx.expireAfterSeconds != null) badges.push({ text: `TTL: ${idx.expireAfterSeconds}s` });

    listEl.appendChild(renderIndexCard({
      name,
      badges,
      definition: isObj ? idx : null,
      canDrop: !isDefault,
      onDrop: () => doDropIndex(name),
    }));
  }
}

async function doDropIndex(indexName) {
  const statusEl = document.getElementById('indexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropIndex(state.get('selectedCollection'), indexName);
    cache.invalidate(state.get('selectedCollection'), 'indexes');
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}
