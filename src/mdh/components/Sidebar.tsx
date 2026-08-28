import { h } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import {
  collections,
  selectedCollection,
  activeView,
  loading,
  error,
  rawCollections,
  hiddenCollections,
  showHiddenCollections,
  applyCollectionFilter,
} from '../store.js';
import {
  promptModal,
  closeModal,
  openModal,
  ModalBody,
  ModalActions,
  ModalMessage,
  ModalLoading,
} from './Modal.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { showUndo } from '../undo.js';
import { UNDO_LIMIT } from '../bulkOps.js';
import { openCollectionTab } from '../openCollectionTab.js';
import { filterCollections, splitByMatch } from '../collectionFilter.js';
import FilterInput from '../../ui/FilterInput.jsx';

async function loadCollections() {
  try {
    loading.value = true;
    error.value = null;
    const res = await api.listCollections(null, true);
    // Keep what the server said; `applyCollectionFilter` derives the visible, sorted list
    // and clears a selection that is no longer in it (this extension's own collections are
    // hidden unless revealed — see hiddenCollections.js).
    rawCollections.value = res.result || [];
    const sorted = applyCollectionFilter();
    loading.value = false;
    if (!selectedCollection.value && activeView.value !== 'operations' && sorted.length > 0) {
      selectedCollection.value = sorted[0];
    }
  } catch (err: any) {
    error.value = { message: err.message };
    loading.value = false;
  }
}

function selectCollection(name: any) {
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

// `onSelected` runs after the created/renamed collection becomes the selection. The sidebar
// passes it a filter-clear: the new name almost certainly does not match whatever is typed in
// the filter box, and leaving it would show an active selection with no row on screen.
function showCreateModal(onSelected?: () => void) {
  promptModal(
    'New Collection',
    {
      placeholder: 'Collection name...',
      submitLabel: 'Create',
      submitClass: 'btn-success',
    },
    async (name, hint) => {
      try {
        loading.value = true;
        error.value = null;
        await api.createCollection(name);
        cache.invalidateAll();
        closeModal();
        await loadCollections();
        selectCollection(name);
        onSelected?.();
      } catch (err: any) {
        loading.value = false;
        hint.textContent = err.message;
      }
    },
  );
}

function showRenameModal(oldName: any, onSelected?: () => void) {
  promptModal(
    'Rename Collection',
    {
      placeholder: 'New name...',
      initialValue: oldName,
      submitLabel: 'Rename',
    },
    async (newName, hint) => {
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
        onSelected?.();
      } catch (err: any) {
        loading.value = false;
        hint.textContent = err.message;
      }
    },
  );
}

async function performDrop(name: any, snapshot: any) {
  loading.value = true;
  error.value = null;
  try {
    // Dropping a collection is asynchronous: the server returns 202 immediately
    // and removes the collection in the background. Wait for that operation to
    // finish before re-listing — otherwise loadCollections() re-fetches the
    // still-present collection and the sidebar looks like nothing happened.
    // Waiting also keeps the undo offer below from recreating the collection
    // while the background drop is still in flight (which would then delete it).
    const res = await api.dropCollection(name);
    const opId = res?.operationId;
    if (opId) await api.waitForOperation(opId);
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
            } catch {
              /* recreate best-effort; one bad index shouldn't sink the whole undo */
            }
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
  } catch (err: any) {
    // A poll timeout / transient poll failure isn't a confirmed drop failure —
    // the background drop may still complete. Surface a softer message rather
    // than asserting the drop failed.
    error.value = {
      message:
        err.timedOut || err.pollUnavailable
          ? `Drop of "${name}" is still running in the background — use Refresh to confirm.`
          : err.message,
    };
  } finally {
    loading.value = false;
  }
}

// Body of the "Drop collection?" modal. Opens instantly with a "Counting
// documents…" placeholder and fetches the count in the background — on a
// large unindexed collection $count can take many seconds, and the user
// needs to see that work is in progress instead of staring at a frozen UI.
function DropConfirmBody({ name }: { name: string }) {
  // count: null = still counting, number = known, false = count failed
  const [count, setCount] = useState<number | false | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [hintMessage, setHintMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .aggregate(name, [{ $count: 'n' }])
      .then((res) => {
        if (cancelled) return;
        setCount(res.result?.[0]?.n ?? 0);
      })
      .catch(() => {
        // Treat a failed count the same as "too large to snapshot" — we'd
        // rather skip undo than attempt to snapshot a collection of unknown size.
        if (cancelled) return;
        setCount(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const countKnown = count !== null;
  const canUndo = typeof count === 'number' && count <= UNDO_LIMIT;
  const nameMatches = confirmText === name;
  const submitDisabled = !countKnown || submitting || !nameMatches;

  let messageEl;
  if (!countKnown) {
    messageEl = (
      <ModalLoading>
        <span>Counting documents{'…'}</span>
      </ModalLoading>
    );
  } else if (count === false) {
    messageEl = (
      <ModalMessage>This will permanently delete "{name}" and all its data.</ModalMessage>
    );
  } else if (count === 0) {
    messageEl = (
      <ModalMessage>This will permanently delete the empty collection "{name}".</ModalMessage>
    );
  } else if (canUndo) {
    messageEl = (
      <ModalMessage>
        {count.toLocaleString()} document{count !== 1 ? 's' : ''} will be deleted. You'll have a few
        seconds to undo.
      </ModalMessage>
    );
  } else {
    messageEl = (
      <ModalMessage>
        {count.toLocaleString()} documents will be permanently deleted. Undo is unavailable above{' '}
        {UNDO_LIMIT.toLocaleString()} documents.
      </ModalMessage>
    );
  }

  async function doSubmit() {
    if (!nameMatches) {
      setHintMessage(`Doesn't match "${name}".`);
      return;
    }
    if (!countKnown) return;
    setSubmitting(true);
    closeModal();

    const numericCount = typeof count === 'number' ? count : null;
    if (canUndo) {
      let snapshot = null;
      try {
        loading.value = true;
        const [docsRes, idxRes] = await Promise.all([
          numericCount! > 0
            ? api.aggregate(name, [{ $match: {} }])
            : Promise.resolve({ result: [] }),
          api.listIndexes(name),
        ]);
        snapshot = { docs: docsRes.result || [], indexes: idxRes.result || [] };
      } catch (err: any) {
        loading.value = false;
        error.value = { message: `Snapshot for undo failed: ${err.message}` };
        return;
      }
      performDrop(name, snapshot);
    } else {
      performDrop(name, null);
    }
  }

  return (
    <ModalBody>
      {messageEl}
      <input
        ref={inputRef}
        class="input"
        style="width:100%"
        placeholder={`Type "${name}" to confirm`}
        value={confirmText}
        onInput={(e: any) => {
          setConfirmText(e.target.value);
          if (hintMessage) setHintMessage('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') doSubmit();
        }}
      />
      <div class="input-hint" style={hintMessage ? 'color: var(--danger)' : ''}>
        {hintMessage}
      </div>
      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>
          Cancel
        </button>
        <button class="btn btn-danger" onClick={doSubmit} disabled={submitDisabled}>
          Drop
        </button>
      </ModalActions>
    </ModalBody>
  );
}

function confirmDrop(name: any) {
  openModal(`Drop "${name}"?`, () => <DropConfirmBody name={name} />);
}

export { loadCollections, performDrop, showCreateModal };

export default function Sidebar() {
  useEffect(() => {
    loadCollections();
  }, []);

  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<any>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Name filter over the listed collections. Deliberately component state and NOT persisted:
  // an org here can have ninety collections, and a filter restored from a previous session
  // would show a fraction of them with no memory of why. It costs one keystroke to retype.
  const [nameFilter, setNameFilter] = useState('');
  const clearFilter = () => setNameFilter('');

  // Close the kebab menu on outside click or any scroll (which would leave
  // the fixed-positioned menu detached from its trigger).
  useEffect(() => {
    if (!menuOpenFor) return;
    function onMouseDown(e: any) {
      if (menuRef.current?.contains(e.target)) return;
      if (e.target.closest('.collection-action-menu-btn')) return;
      setMenuOpenFor(null);
    }
    function onScroll() {
      setMenuOpenFor(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuOpenFor]);

  function toggleMenu(name: any, e: any) {
    e.stopPropagation();
    if (menuOpenFor === name) {
      setMenuOpenFor(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setMenuOpenFor(name);
  }

  const cols = collections.value;
  const selected = selectedCollection.value;
  const showHidden = showHiddenCollections.value;
  // This extension's own collections, listed in their own expandable group BELOW the
  // customer's (owner, 2026-08-18). The group is absent entirely on an org that has none of
  // ours. NOT a security boundary — the collection is plainly visible to anything else
  // holding the org token; it is decluttering, and it must stay reachable because the MDH
  // record editor is the only way to hand-edit a deliverable or read a stored version.
  const hiddenCols = hiddenCollections.value;
  // The filter narrows BOTH lists — a name the user is hunting for may be one of ours, and a
  // box that silently skips a group is worse than no box. While it is active the group is
  // forced open (without persisting that), so a match cannot hide behind a collapsed caret.
  const filtering = nameFilter.trim().length > 0;
  const shownCols = filterCollections(cols, nameFilter);
  const shownHiddenCols = filterCollections(hiddenCols, nameFilter);
  const groupOpen = showHidden || filtering;
  function toggleHidden() {
    // Inert while filtering: `groupOpen` is forced true there, so a flip could not change
    // what is on screen — but it WOULD persist mdhShowHiddenCollections, and the user would
    // find the group expanded next session having just asked to collapse it. The button is
    // also `disabled` in that state, so this guard is the belt to that braces.
    if (filtering) return;
    const next = !showHiddenCollections.value;
    showHiddenCollections.value = next;
    try {
      chrome.storage.local.set({ mdhShowHiddenCollections: next });
    } catch {
      /* no storage (tests) */
    }
  }

  // One row, rendered for BOTH lists — the customer's collections and, under the expandable
  // group, this extension's own. Same click/middle-click/context-menu/kebab behaviour in both
  // places: a hidden collection is a normal collection that merely starts out of sight.
  function collectionRow(name: any) {
    return (
      <div
        class={
          'collection-item' +
          (name === selected && activeView.value === 'collection' ? ' active' : '') +
          (menuOpenFor === name ? ' menu-open' : '')
        }
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            openCollectionTab(name);
          } else selectCollection(name);
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            openCollectionTab(name);
          }
        }}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuPos({ top: e.clientY, left: e.clientX });
          setMenuOpenFor(name);
        }}
      >
        <span class="collection-item-name" title={name}>
          {splitByMatch(name, nameFilter).map((seg) =>
            seg.hit ? <b class="collection-item-hit">{seg.text}</b> : seg.text,
          )}
        </span>
        <span class="collection-item-actions">
          <button
            class="collection-action-btn collection-action-menu-btn"
            title="Collection actions"
            onClick={(e) => toggleMenu(name, e)}
            dangerouslySetInnerHTML={{
              __html:
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
            }}
          />
        </span>
      </div>
    );
  }

  return (
    <aside id="sidebar" class={'sidebar' + (filtering ? ' sidebar-filtering' : '')}>
      <div class="sidebar-header">
        <div class="sidebar-title-group">
          <span class="sidebar-title">Collections</span>
          <span class="sidebar-count">
            ({filtering ? `${shownCols.length} / ${cols.length}` : cols.length})
          </span>
        </div>
        <div class="sidebar-header-actions">
          <button
            class="icon-btn"
            title="New collection"
            onClick={() => showCreateModal(clearFilter)}
          >
            +
          </button>
          <button
            class="icon-btn"
            title="Refresh"
            onClick={() => {
              cache.invalidateAll();
              loadCollections();
            }}
          >
            {'\u21bb'}
          </button>
        </div>
      </div>
      {(cols.length > 0 || hiddenCols.length > 0) && (
        <div class="collection-filter">
          {/* `active={filtering}` rather than letting the primitive derive it from the value:
              whitespace-only is not filtering here, because filterCollections trims. */}
          <FilterInput
            value={nameFilter}
            onInput={setNameFilter}
            onClear={clearFilter}
            active={filtering}
            placeholder="Filter by name..."
            ariaLabel="Filter collections by name"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNameFilter('');
            }}
            title={
              filtering
                ? `Filtering by "${nameFilter}" \u2014 press Escape or click \u00d7 to clear`
                : ''
            }
          />
        </div>
      )}
      {/* Above the list, not after it: `.collection-list` is `flex: 1`, so a sibling below it
          is pushed to the bottom of the sidebar, away from the box that caused it. */}
      {filtering && shownCols.length === 0 && shownHiddenCols.length === 0 && (
        <div class="collection-filter-empty">No collection matches "{nameFilter.trim()}".</div>
      )}
      <div class={'collection-list' + (shownCols.length === 0 ? ' is-empty' : '')}>
        {shownCols.map((name) => collectionRow(name))}
      </div>
      {shownHiddenCols.length > 0 && (
        <div class={'collection-hidden-group' + (groupOpen ? ' open' : '')}>
          <button
            type="button"
            class="collection-hidden-toggle"
            aria-expanded={groupOpen}
            disabled={filtering}
            title={
              filtering
                ? 'Kept open while a filter is active'
                : 'Collections created by this extension'
            }
            onClick={toggleHidden}
          >
            <span class="collection-hidden-caret">{groupOpen ? '\u25be' : '\u25b8'}</span>
            <span class="collection-hidden-label">Extension collections</span>
            <span class="sidebar-count">
              ({filtering ? `${shownHiddenCols.length} / ${hiddenCols.length}` : hiddenCols.length})
            </span>
          </button>
          {groupOpen && (
            <div class="collection-list">{shownHiddenCols.map((name) => collectionRow(name))}</div>
          )}
        </div>
      )}
      {menuOpenFor && menuPos && (
        <div
          ref={menuRef}
          class="collection-action-menu"
          style={
            `position:fixed;top:${menuPos.top}px;` +
            (menuPos.left != null ? `left:${menuPos.left}px` : `right:${menuPos.right}px`)
          }
        >
          <button
            class="toolbar-menu-item"
            onClick={() => {
              const n = menuOpenFor;
              setMenuOpenFor(null);
              openCollectionTab(n);
            }}
          >
            Open in new tab {'↗'}
          </button>
          <button
            class="toolbar-menu-item"
            onClick={() => {
              const n = menuOpenFor;
              setMenuOpenFor(null);
              navigator.clipboard.writeText(n);
            }}
          >
            Copy name
          </button>
          <button
            class="toolbar-menu-item"
            onClick={() => {
              const n = menuOpenFor;
              setMenuOpenFor(null);
              showRenameModal(n, clearFilter);
            }}
          >
            Rename
          </button>
          <button
            class="toolbar-menu-item toolbar-menu-danger"
            onClick={() => {
              const n = menuOpenFor;
              setMenuOpenFor(null);
              confirmDrop(n);
            }}
          >
            Drop
          </button>
        </div>
      )}
      <div class="sidebar-footer">
        <div
          class={'sidebar-nav-item' + (activeView.value === 'overview' ? ' active' : '')}
          onClick={showOverview}
          title="High-level overview of all collections"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span>Overview</span>
        </div>
        <div
          class={'sidebar-nav-item' + (activeView.value === 'operations' ? ' active' : '')}
          onClick={showOperationLogs}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <span>Operation Logs</span>
        </div>
      </div>
    </aside>
  );
}
