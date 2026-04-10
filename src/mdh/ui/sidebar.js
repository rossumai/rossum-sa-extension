import * as api from '../api.js';
import * as state from '../state.js';
import * as cache from '../cache.js';
import { confirmModal, promptModal, closeModal } from './modal.js';

export function initSidebar() {
  loadCollections();

  document.getElementById('refreshCollections').addEventListener('click', () => {
    cache.invalidateAll();
    loadCollections();
  });
  document.getElementById('sidebarNewBtn').addEventListener('click', showCreateModal);
}

async function loadCollections() {
  try {
    state.set({ loading: true, error: null });
    const res = await api.listCollections(null, true);
    const collections = (res.result || []).sort((a, b) => a.localeCompare(b));
    state.set({ collections, loading: false });
    if (!state.get('selectedCollection') && collections.length > 0) {
      selectCollection(collections[0]);
    }
    renderCollections(collections);
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

function renderCollections(collections) {
  const listEl = document.getElementById('collectionList');
  const selected = state.get('selectedCollection');
  listEl.replaceChildren();

  for (const name of collections) {
    listEl.appendChild(buildCollectionRow(name, name === selected));
  }

  const countEl = document.getElementById('sidebarCount');
  if (countEl) countEl.textContent = `(${collections.length})`;
}

function buildCollectionRow(name, isActive) {
  const item = document.createElement('div');
  item.className = 'collection-item' + (isActive ? ' active' : '');
  item.dataset.collection = name;

  const label = document.createElement('span');
  label.className = 'collection-item-name';
  label.textContent = name;
  label.title = name;

  const actions = document.createElement('span');
  actions.className = 'collection-item-actions';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'collection-action-btn';
  renameBtn.title = 'Rename collection';
  renameBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showRenameModal(name);
  });

  const dropBtn = document.createElement('button');
  dropBtn.className = 'collection-action-btn collection-action-danger';
  dropBtn.title = 'Drop collection';
  dropBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  dropBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDrop(name);
  });

  actions.appendChild(renameBtn);
  actions.appendChild(dropBtn);
  item.appendChild(label);
  item.appendChild(actions);

  item.addEventListener('click', () => selectCollection(name));

  return item;
}

function selectCollection(name) {
  if (state.get('selectedCollection') === name) return;
  state.set({ selectedCollection: name, records: [], skip: 0, error: null });
}

// ── Create ──────────────────────────────────────

function showCreateModal() {
  promptModal('New Collection', {
    placeholder: 'Collection name...',
    submitLabel: 'Create',
    submitClass: 'btn-success',
  }, async (name, hint) => {
    try {
      state.set({ loading: true, error: null });
      await api.createCollection(name);
      cache.invalidateAll();
      closeModal();
      await loadCollections();
      selectCollection(name);
    } catch (err) {
      state.set({ loading: false });
      hint.textContent = err.message;
    }
  });
}

// ── Rename ──────────────────────────────────────

function showRenameModal(oldName) {
  promptModal('Rename Collection', {
    placeholder: 'New name...',
    initialValue: oldName,
    submitLabel: 'Rename',
  }, async (newName, hint) => {
    try {
      state.set({ loading: true, error: null });
      await api.renameCollection(oldName, newName);
      cache.invalidateAll();
      closeModal();
      if (state.get('selectedCollection') === oldName) {
        state.set({ selectedCollection: newName });
      }
      await loadCollections();
    } catch (err) {
      state.set({ loading: false });
      hint.textContent = err.message;
    }
  });
}

// ── Drop ────────────────────────────────────────

function confirmDrop(name) {
  confirmModal(
    'Drop collection?',
    `This will permanently delete "${name}" and all its data. This action cannot be undone.`,
    async () => {
      try {
        state.set({ loading: true, error: null });
        await api.dropCollection(name);
        cache.invalidateAll();
        if (state.get('selectedCollection') === name) {
          state.set({ selectedCollection: null });
        }
        await loadCollections();
      } catch (err) {
        state.set({ error: { message: err.message } });
      } finally {
        state.set({ loading: false });
      }
    },
  );
}

state.on('collectionsChanged', renderCollections);
state.on('selectedCollectionChanged', () => renderCollections(state.get('collections')));
