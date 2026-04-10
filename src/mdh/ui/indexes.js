import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

export function initIndexes() {
  const panelEl = document.getElementById('panel-indexes');

  panelEl.innerHTML = `
    <div class="toolbar">
      <span style="flex:1;font-weight:500">Indexes</span>
      <button id="refreshIndexes" class="icon-btn" title="Refresh">&#x21bb;</button>
    </div>
    <div id="indexList" class="index-list"></div>
    <div id="indexOpStatus" class="hidden" style="padding:8px 16px"></div>
    <div class="index-create-form">
      <span class="toolbar-label">Name:</span>
      <input id="indexName" class="input" style="width:140px" placeholder="my_index" />
      <span class="toolbar-label">Keys:</span>
      <input id="indexKeys" class="input" style="flex:1" value='{"field": 1}' />
      <button id="createIndexBtn" class="btn btn-primary btn-sm">Create</button>
    </div>
  `;

  panelEl.querySelector('#refreshIndexes').addEventListener('click', loadIndexes);
  panelEl.querySelector('#createIndexBtn').addEventListener('click', doCreateIndex);

  state.on('activePanelChanged', (panel) => {
    if (panel === 'indexes') loadIndexes();
  });

  state.on('selectedCollectionChanged', () => {
    if (state.get('activePanel') === 'indexes') loadIndexes();
  });
}

async function loadIndexes() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  try {
    state.set({ loading: true, error: null });
    const res = await api.listIndexes(collection, false);
    state.set({ loading: false });
    renderIndexes(res.result || []);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderIndexes(indexes) {
  const listEl = document.getElementById('indexList');
  listEl.innerHTML = '';

  for (const idx of indexes) {
    const name = typeof idx === 'string' ? idx : (idx.name || idx.key ? JSON.stringify(idx.key) : String(idx));
    const keys = typeof idx === 'object' && idx.key ? JSON.stringify(idx.key) : '';
    const isDefault = name === '_id_';

    const row = document.createElement('div');
    row.className = 'index-row';
    row.innerHTML = `
      <div>
        <span class="index-name">${escapeHtml(name)}</span>
        ${keys ? `<span class="index-keys">${escapeHtml(keys)}</span>` : ''}
      </div>
      ${isDefault ? '<span class="index-default">default</span>' : `<button class="btn btn-sm btn-danger drop-index-btn">Drop</button>`}
    `;

    if (!isDefault) {
      row.querySelector('.drop-index-btn').addEventListener('click', () => {
        confirmModal(
          'Drop index?',
          `Drop index "${name}"? This may affect query performance.`,
          () => doDropIndex(name),
        );
      });
    }

    listEl.appendChild(row);
  }
}

async function doCreateIndex() {
  const nameInput = document.getElementById('indexName');
  const keysInput = document.getElementById('indexKeys');
  const statusEl = document.getElementById('indexOpStatus');
  const indexName = nameInput.value.trim();

  if (!indexName) {
    nameInput.classList.add('input-error');
    return;
  }
  nameInput.classList.remove('input-error');

  let keys;
  try {
    keys = JSON.parse(keysInput.value);
    keysInput.classList.remove('input-error');
  } catch {
    keysInput.classList.add('input-error');
    return;
  }

  try {
    state.set({ loading: true, error: null });
    const res = await api.createIndex(state.get('selectedCollection'), indexName, keys);
    state.set({ loading: false });
    nameInput.value = '';
    showAsyncStatus(statusEl, res.message);
    await loadIndexes();
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

async function doDropIndex(indexName) {
  const statusEl = document.getElementById('indexOpStatus');
  try {
    state.set({ loading: true, error: null });
    const res = await api.dropIndex(state.get('selectedCollection'), indexName);
    state.set({ loading: false });
    showAsyncStatus(statusEl, res.message);
    await loadIndexes();
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
      <button class="btn btn-sm check-status-btn" style="margin-left:auto">Check Status</button>
    </div>
  `;
  statusEl.querySelector('.check-status-btn').addEventListener('click', async () => {
    try {
      const res = await api.checkOperationStatus(operationId);
      const op = res.result || {};
      const badgeClass = op.status === 'FINISHED' ? 'finished' : op.status === 'FAILED' ? 'failed' : 'running';
      statusEl.innerHTML = `
        <div class="op-status">
          <span class="op-status-badge ${badgeClass}">${(op.status || 'unknown').toLowerCase()}</span>
          <span>Operation: ${operationId}</span>
          ${op.status !== 'FINISHED' && op.status !== 'FAILED' ? '<button class="btn btn-sm check-status-btn" style="margin-left:auto">Check Status</button>' : ''}
          ${op.error_message ? `<span style="color:var(--danger)">${escapeHtml(op.error_message)}</span>` : ''}
        </div>
      `;
      const btn = statusEl.querySelector('.check-status-btn');
      if (btn) btn.addEventListener('click', () => showAsyncStatus(statusEl, message));
    } catch (err) {
      state.set({ error: { message: err.message } });
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
