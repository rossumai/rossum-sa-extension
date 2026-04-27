import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { collections, selectedCollection, activeView, loading, error } from '../store.js';
import { confirmModal, promptModal, closeModal, openModal } from './Modal.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';
import * as ai from '../ai.js';
import { showUndo } from '../undo.js';
import { FEATURES } from '../featurePreview/registry.js';
import FeaturePreviewModal from './FeaturePreviewModal.jsx';

async function loadCollections() {
  try {
    loading.value = true;
    error.value = null;
    const res = await api.listCollections(null, true);
    const sorted = (res.result || []).sort((a, b) => a.localeCompare(b));
    collections.value = sorted;
    loading.value = false;
    if (selectedCollection.value && !sorted.includes(selectedCollection.value)) {
      selectedCollection.value = null;
    }
    if (!selectedCollection.value && activeView.value !== 'operations' && sorted.length > 0) {
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

function showOverview() {
  selectedCollection.value = null;
  activeView.value = 'overview';
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

// Below this many docs we snapshot the whole collection (docs + indexes) so
// undo can fully recreate it. Above it, undo would mean keeping potentially
// many MB in memory and a heavy insertMany rollback — instead we raise the
// confirmation bar (type-to-confirm) and skip undo.
const DROP_UNDO_LIMIT = 5000;

async function performDrop(name, snapshot) {
  loading.value = true;
  error.value = null;
  try {
    await api.dropCollection(name);
    cache.invalidateAll();
    if (selectedCollection.value === name) selectedCollection.value = null;
    await loadCollections();
    if (snapshot) {
      showUndo({
        message: `Dropped "${name}"`,
        action: async () => {
          await api.createCollection(name);
          for (const idx of snapshot.indexes) {
            // _id_ is created automatically by the server; skip it.
            if (idx.name === '_id_') continue;
            try {
              await api.createIndex(name, idx.name, idx.key, idx.options || {});
            } catch { /* recreate best-effort; one bad index shouldn't sink the whole undo */ }
          }
          if (snapshot.docs.length > 0) {
            await api.insertMany(name, snapshot.docs, false);
          }
          cache.invalidateAll();
          await loadCollections();
          selectedCollection.value = name;
        },
      });
    }
  } catch (err) {
    error.value = { message: err.message };
  } finally {
    loading.value = false;
  }
}

async function confirmDrop(name) {
  // Look up the size first so we can pick a flow. A failed count is treated
  // the same as "too large" — we'd rather over-confirm than over-snapshot.
  let count = null;
  try {
    const res = await api.aggregate(name, [{ $count: 'n' }]);
    count = res.result?.[0]?.n ?? 0;
  } catch { /* keep null */ }

  if (typeof count === 'number' && count <= DROP_UNDO_LIMIT) {
    const proceed = await confirmModal(
      'Drop collection?',
      `Delete "${name}" and its ${count.toLocaleString()} document${count !== 1 ? 's' : ''}? You'll have a few seconds to undo.`,
    );
    if (!proceed) return;
    let snapshot = null;
    try {
      loading.value = true;
      const [docsRes, idxRes] = await Promise.all([
        count > 0 ? api.aggregate(name, [{ $match: {} }]) : Promise.resolve({ result: [] }),
        api.listIndexes(name),
      ]);
      snapshot = { docs: docsRes.result || [], indexes: idxRes.result || [] };
    } catch (err) {
      loading.value = false;
      error.value = { message: `Snapshot for undo failed: ${err.message}` };
      return;
    }
    await performDrop(name, snapshot);
    return;
  }

  // Large or unknown count — type-to-confirm, no undo.
  const message = typeof count === 'number'
    ? `${count.toLocaleString()} documents will be permanently deleted. Undo is unavailable above ${DROP_UNDO_LIMIT.toLocaleString()} documents.`
    : `This will permanently delete "${name}" and all its data.`;
  await promptModal(
    `Drop "${name}"?`,
    {
      message,
      placeholder: `Type "${name}" to confirm`,
      submitLabel: 'Drop',
      submitClass: 'btn-danger',
    },
    (val, hint) => {
      if (val !== name) {
        if (hint) {
          hint.style.color = 'var(--danger)';
          hint.textContent = `Doesn't match "${name}".`;
        }
        return;
      }
      closeModal();
      performDrop(name, null);
    },
  );
}

export { loadCollections };

function countEnabledFeatures() {
  let n = 0;
  for (const f of FEATURES) {
    const s = f.useState();
    if (s.state === 'on' || s.state === 'downloading') n++;
  }
  return n;
}

function FeaturePreviewEntry() {
  useEffect(() => { ai.initAvailability(); }, []);
  const n = countEnabledFeatures();
  return (
    <div
      class="sidebar-nav-item"
      data-testid="feature-preview-entry"
      onClick={() => openModal('Feature preview', () => <FeaturePreviewModal />)}
      title="Try early-access features"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2l.5 4 4 .5-4 .5-.5 4-.5-4-4-.5 4-.5z"/><path d="M18 9l.5 3 3 .5-3 .5-.5 3-.5-3-3-.5 3-.5z"/><path d="M11 16l.5 3 3 .5-3 .5-.5 3-.5-3-3-.5 3-.5z"/></svg>
      <span>Feature preview</span>
      {n > 0 && <span class="feature-preview-count" style="margin-left:auto">{n}</span>}
    </div>
  );
}

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
        <FeaturePreviewEntry />
        <div
          class={'sidebar-nav-item' + (activeView.value === 'overview' ? ' active' : '')}
          onClick={showOverview}
          title="High-level overview of all collections"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          <span>Overview</span>
        </div>
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
