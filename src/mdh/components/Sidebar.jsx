import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { collections, selectedCollection, activeView, loading, error } from '../store.js';
import { confirmModal, promptModal, closeModal } from './Modal.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';

async function loadCollections() {
  try {
    loading.value = true;
    error.value = null;
    const res = await api.listCollections(null, true);
    const sorted = (res.result || []).sort((a, b) => a.localeCompare(b));
    collections.value = sorted;
    loading.value = false;
    if (!selectedCollection.value && sorted.length > 0) {
      selectedCollection.value = sorted[0];
    }
  } catch (err) {
    error.value = { message: err.message };
    loading.value = false;
  }
}

function selectCollection(name) {
  if (selectedCollection.value === name && activeView.value === 'collection') return;
  selectedCollection.value = name;
  activeView.value = 'collection';
}

function showOperationLogs() {
  selectedCollection.value = null;
  activeView.value = 'operations';
}

function showCreateModal() {
  promptModal('New Collection', {
    placeholder: 'Collection name...',
    submitLabel: 'Create',
    submitClass: 'btn-success',
  }, async (name, hint) => {
    try {
      loading.value = true;
      error.value = null;
      await api.createCollection(name);
      cache.invalidateAll();
      closeModal();
      await loadCollections();
      selectCollection(name);
    } catch (err) {
      loading.value = false;
      hint.textContent = err.message;
    }
  });
}

function showRenameModal(oldName) {
  promptModal('Rename Collection', {
    placeholder: 'New name...',
    initialValue: oldName,
    submitLabel: 'Rename',
  }, async (newName, hint) => {
    try {
      loading.value = true;
      error.value = null;
      await api.renameCollection(oldName, newName);
      cache.invalidateAll();
      closeModal();
      if (selectedCollection.value === oldName) {
        selectedCollection.value = newName;
      }
      await loadCollections();
    } catch (err) {
      loading.value = false;
      hint.textContent = err.message;
    }
  });
}

function confirmDrop(name) {
  confirmModal(
    'Drop collection?',
    `This will permanently delete "${name}" and all its data. This action cannot be undone.`,
    async () => {
      try {
        loading.value = true;
        error.value = null;
        await api.dropCollection(name);
        cache.invalidateAll();
        if (selectedCollection.value === name) {
          selectedCollection.value = null;
        }
        await loadCollections();
      } catch (err) {
        error.value = { message: err.message };
      } finally {
        loading.value = false;
      }
    },
  );
}

export { loadCollections };

export default function Sidebar() {
  useEffect(() => { loadCollections(); }, []);

  const cols = collections.value;
  const selected = selectedCollection.value;

  return (
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title-group">
          <span class="sidebar-title">Collections</span>
          <span class="sidebar-count">({cols.length})</span>
        </div>
        <div class="sidebar-header-actions">
          <button class="icon-btn" title="New collection" onClick={showCreateModal}>+</button>
          <button class="icon-btn" title="Refresh" onClick={() => { cache.invalidateAll(); loadCollections(); }}>{'\u21bb'}</button>
        </div>
      </div>
      <div class="collection-list">
        {cols.map((name) => (
          <div
            class={'collection-item' + (name === selected && activeView.value === 'collection' ? ' active' : '')}
            onClick={() => selectCollection(name)}
          >
            <span class="collection-item-name" title={name}>{name}</span>
            <span class="collection-item-actions">
              <button
                class="collection-action-btn"
                title="Rename collection"
                onClick={(e) => { e.stopPropagation(); showRenameModal(name); }}
                dangerouslySetInnerHTML={{ __html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>' }}
              />
              <button
                class="collection-action-btn collection-action-danger"
                title="Drop collection"
                onClick={(e) => { e.stopPropagation(); confirmDrop(name); }}
                dangerouslySetInnerHTML={{ __html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }}
              />
            </span>
          </div>
        ))}
      </div>
      <div class="sidebar-footer">
        <div
          class={'sidebar-nav-item' + (activeView.value === 'operations' ? ' active' : '')}
          onClick={showOperationLogs}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span>Operation Logs</span>
        </div>
      </div>
    </aside>
  );
}
