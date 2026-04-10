import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';

const contextMenuEl = document.getElementById('contextMenu');

export function initSidebar() {
  loadCollections();

  document.getElementById('refreshCollections').addEventListener('click', loadCollections);

  document.getElementById('createCollectionBtn').addEventListener('click', async () => {
    const input = document.getElementById('newCollectionName');
    const name = input.value.trim();
    if (!name) return;
    try {
      state.set({ loading: true, error: null });
      await api.createCollection(name);
      input.value = '';
      await loadCollections();
    } catch (err) {
      state.set({ error: { message: err.message } });
    } finally {
      state.set({ loading: false });
    }
  });

  document.getElementById('newCollectionName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('createCollectionBtn').click();
  });

  document.addEventListener('click', () => hideContextMenu());
}

async function loadCollections() {
  try {
    state.set({ loading: true, error: null });
    const res = await api.listCollections(null, true);
    const collections = res.result || [];
    state.set({ collections, loading: false });
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
    const item = document.createElement('div');
    item.className = 'collection-item' + (name === selected ? ' active' : '');
    item.textContent = name;
    item.addEventListener('click', () => selectCollection(name));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, name);
    });
    listEl.appendChild(item);
  }

  const footer = document.getElementById('sidebarFooter');
  footer.textContent = `${collections.length} collection${collections.length !== 1 ? 's' : ''}`;
}

function selectCollection(name) {
  state.set({ selectedCollection: name, records: [], skip: 0, error: null });
}

function showContextMenu(x, y, collectionName) {
  contextMenuEl.innerHTML = '';
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  contextMenuEl.classList.remove('hidden');

  const renameBtn = document.createElement('button');
  renameBtn.className = 'context-menu-item';
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    startRename(collectionName);
  });

  const dropBtn = document.createElement('button');
  dropBtn.className = 'context-menu-item danger';
  dropBtn.textContent = 'Drop';
  dropBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    confirmDrop(collectionName);
  });

  contextMenuEl.appendChild(renameBtn);
  contextMenuEl.appendChild(dropBtn);
}

function hideContextMenu() {
  contextMenuEl.classList.add('hidden');
}

function startRename(oldName) {
  const listEl = document.getElementById('collectionList');
  const items = listEl.querySelectorAll('.collection-item');
  for (const item of items) {
    if (item.textContent !== oldName) continue;

    const row = document.createElement('div');
    row.className = 'collection-item-rename';
    const input = document.createElement('input');
    input.className = 'input';
    input.value = oldName;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';

    async function doRename() {
      const newName = input.value.trim();
      if (!newName || newName === oldName) {
        row.replaceWith(item);
        return;
      }
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
    }

    saveBtn.addEventListener('click', doRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doRename();
      if (e.key === 'Escape') row.replaceWith(item);
    });

    row.appendChild(input);
    row.appendChild(saveBtn);
    item.replaceWith(row);
    input.focus();
    input.select();
    break;
  }
}

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
