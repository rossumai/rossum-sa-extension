import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

export function initSidebar() {
  loadCollections();

  document.getElementById('refreshCollections').addEventListener('click', loadCollections);
  document.getElementById('addCollectionBtn').addEventListener('click', showCreateInput);
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
  listEl.innerHTML = '';

  for (const name of collections) {
    listEl.appendChild(buildCollectionRow(name, name === selected));
  }

  const footer = document.getElementById('sidebarFooter');
  footer.textContent = `${collections.length} collection${collections.length !== 1 ? 's' : ''}`;
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
    startRename(name, item);
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
  state.set({ selectedCollection: name, records: [], skip: 0, error: null });
}

// ── Inline input (shared for create and rename) ──

function showInlineInput({ placeholder, initialValue, onSubmit, insertBefore }) {
  const listEl = document.getElementById('collectionList');

  const row = document.createElement('div');
  row.className = 'collection-inline-input';

  const input = document.createElement('input');
  input.className = 'input';
  input.placeholder = placeholder;
  input.value = initialValue || '';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'collection-action-btn collection-action-confirm';
  confirmBtn.title = 'Confirm';
  confirmBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'collection-action-btn';
  cancelBtn.title = 'Cancel';
  cancelBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function submit() {
    const val = input.value.trim();
    if (!val || val === initialValue) {
      remove();
      return;
    }
    onSubmit(val);
  }

  function remove() {
    row.remove();
  }

  confirmBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', remove);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') remove();
  });

  row.appendChild(input);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);

  if (insertBefore) {
    insertBefore.replaceWith(row);
  } else {
    listEl.prepend(row);
  }

  input.focus();
  if (initialValue) input.select();

  return { row, remove };
}

// ── Create ──────────────────────────────────────

function showCreateInput() {
  // Don't show multiple create inputs
  if (document.querySelector('.collection-inline-input')) return;

  showInlineInput({
    placeholder: 'Collection name...',
    onSubmit: async (name) => {
      try {
        state.set({ loading: true, error: null });
        await api.createCollection(name);
        await loadCollections();
        selectCollection(name);
      } catch (err) {
        state.set({ error: { message: err.message } });
      } finally {
        state.set({ loading: false });
      }
    },
  });
}

// ── Rename ──────────────────────────────────────

function startRename(oldName, itemEl) {
  showInlineInput({
    placeholder: 'New name...',
    initialValue: oldName,
    insertBefore: itemEl,
    onSubmit: async (newName) => {
      try {
        state.set({ loading: true, error: null });
        await api.renameCollection(oldName, newName);
        if (state.get('selectedCollection') === oldName) {
          state.set({ selectedCollection: newName });
        }
        await loadCollections();
      } catch (err) {
        state.set({ error: { message: err.message } });
      } finally {
        state.set({ loading: false });
      }
    },
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
