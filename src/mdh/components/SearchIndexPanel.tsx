import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, loading, error } from '../store.js';
import { openModal, closeModal, ModalBody, ModalActions, ModalFieldLabel } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import IndexCard from './IndexCard.jsx';
import {
  toSearchIndexDefinition,
  statusBadge,
  syncSummary,
  isTransitional,
  summarizeDefinition,
  splitPastedDefinition,
  firstValidationLine,
} from '../searchIndexDef.js';
import { formatTime, parseUtcTimestamp } from '../relativeTime.js';
import useIndexReconcile from '../hooks/useIndexReconcile.js';
import * as api from '../api.js';
import * as cache from '../cache.js';
import type { JsonEditorHandle } from './JsonEditor.jsx';

export default function SearchIndexPanel() {
  const [indexes, setIndexes] = useState<any[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // V2 writes return no operation id, so progress is only visible by re-reading
  // the list. This is what makes a PENDING_CREATE badge become READY on its own.
  const { watch, stop } = useIndexReconcile((rows, at) => {
    setIndexes(rows);
    setCheckedAt(at);
  });

  async function loadSearchIndexes() {
    const collection = selectedCollection.value as string;
    // A slash in the name cannot be addressed through the V2 path even
    // percent-encoded — the router 404s. Say so rather than fire a request whose
    // "not found" would be a lie about a collection that plainly exists.
    if (!collection || collection.includes('/')) return;

    const cached = cache.get(collection, 'searchIndexes');
    if (cached !== null) {
      setIndexes(cached);
      return;
    }

    const isVisible = activePanel.value === 'search-indexes';
    try {
      if (isVisible) {
        loading.value = true;
        error.value = null;
      }
      const result = await api.listSearchIndexes(collection);
      cache.set(collection, 'searchIndexes', result);
      if (isVisible) loading.value = false;
      if (selectedCollection.value !== collection) return;
      setIndexes(result);
      setCheckedAt(Date.now());
      // Opening the panel onto a build already in flight has to resume the poll,
      // or the badge sits at "pending create" until someone hits Refresh.
      if (result.some((r: any) => isTransitional(r?.status))) watch(collection);
    } catch (err: any) {
      if (isVisible) {
        error.value = { message: err.message };
        loading.value = false;
      }
    }
  }

  useEffect(() => {
    stop();
    loadSearchIndexes();
  }, [selectedCollection.value, activePanel.value]);

  function openIndexModal({
    mode,
    name: initialName = '',
    definition: initialDefinition,
  }: {
    mode: 'create' | 'edit';
    name?: string;
    definition?: any;
  }) {
    const editorRef: { current: JsonEditorHandle | null } = { current: null };
    const isEdit = mode === 'edit';
    const initialJson = JSON.stringify(
      initialDefinition ?? { mappings: { dynamic: true } },
      null,
      2,
    );

    openModal(isEdit ? 'Edit Search Index' : 'Create Search Index', () => {
      const hintRef = useRef<HTMLDivElement | null>(null);
      const nameRef = useRef<HTMLInputElement | null>(null);

      async function handleSubmit() {
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        // A snippet copied from the build that emitted {indexName, mappings}
        // still pastes: the name is lifted out rather than sent in the body,
        // where V2 rejects it as an extra key.
        const split = splitPastedDefinition(editorRef.current.getParsed());
        if (!isEdit && split.name && nameRef.current && !nameRef.current.value.trim()) {
          nameRef.current.value = split.name;
        }
        const indexName = (nameRef.current?.value || '').trim();
        if (!indexName) {
          if (hintRef.current) hintRef.current.textContent = 'A name is required';
          nameRef.current?.focus();
          return;
        }
        const definition = split.definition;
        if (!definition || typeof definition !== 'object' || !definition.mappings) {
          if (hintRef.current)
            hintRef.current.textContent = 'The definition needs a "mappings" object';
          return;
        }

        try {
          loading.value = true;
          error.value = null;
          await api.putSearchIndex(selectedCollection.value as string, indexName, definition);
          cache.invalidate(selectedCollection.value as string, 'searchIndexes');
          loading.value = false;
          closeModal();
          watch(selectedCollection.value as string);
        } catch (err: any) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = firstValidationLine(err.message);
        }
      }

      return (
        <ModalBody>
          <ModalFieldLabel>{isEdit ? 'Name (cannot be changed)' : 'Name'}</ModalFieldLabel>
          <input
            ref={nameRef}
            class={'input' + (isEdit ? ' input-locked' : '')}
            style="width:100%"
            placeholder="my_search_index"
            value={initialName}
            readOnly={isEdit}
          />
          <ModalFieldLabel style="margin-top:8px">Definition</ModalFieldLabel>
          <JsonEditor value={initialJson} minHeight="250px" editorRef={editorRef} />
          <div ref={hintRef} class="input-hint"></div>
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={handleSubmit}>
              {isEdit ? 'Save & rebuild' : 'Create Search Index'}
            </button>
          </ModalActions>
        </ModalBody>
      );
    });
  }

  async function doDropSearchIndex(indexName: any) {
    try {
      loading.value = true;
      error.value = null;
      await api.deleteSearchIndex(selectedCollection.value as string, indexName);
      cache.invalidate(selectedCollection.value as string, 'searchIndexes');
      loading.value = false;
      watch(selectedCollection.value as string);
    } catch (err: any) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  const sync = syncSummary(indexes, checkedAt);

  if (((selectedCollection.value as string) || '').includes('/')) {
    return (
      <div class="panel">
        <div style="padding:16px;color:var(--text-secondary);font-size:12px">
          Search indexes cannot be managed for a collection whose name contains a slash {'\u2014'}{' '}
          Master Data Hub addresses the collection in the URL path.
        </div>
      </div>
    );
  }

  return (
    <div class="panel">
      <div class="toolbar">
        <span class="toolbar-stack">
          <span style="font-weight:500">Search Indexes (Atlas Search)</span>
          <span class="toolbar-sync">
            {sync.working ? <span class="spin" /> : <span class="dot" />}
            {sync.text}
          </span>
        </span>
        <button class="btn btn-success btn-sm" onClick={() => openIndexModal({ mode: 'create' })}>
          + Create
        </button>
        <button
          class="icon-btn"
          title="Refresh"
          onClick={() => {
            cache.invalidate(selectedCollection.value as string, 'searchIndexes');
            loadSearchIndexes();
          }}
        >
          {'\u21bb'}
        </button>
      </div>
      <div class="index-list">
        {indexes.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">
            No search indexes
          </div>
        ) : (
          indexes.map((idx) => {
            const isObj = typeof idx === 'object' && idx !== null;
            const name = isObj ? idx.name || '(unnamed)' : String(idx);
            const badges = [];
            const badge = isObj ? statusBadge(idx.status) : null;
            const isFailed = badge?.cls === 'index-badge-failed';
            if (badge) badges.push(badge);
            if (isObj && idx.queryable === false)
              badges.push({ text: 'not queryable', cls: 'index-badge-warning' });

            const definition = isObj ? toSearchIndexDefinition(idx) : null;
            const ver = isObj ? idx.latest_definition_version : null;
            const declaredAt = ver ? parseUtcTimestamp(ver.created_at) : null;
            const meta = ver
              ? `v${ver.version}${declaredAt ? ` · declared ${formatTime(declaredAt)}` : ''}`
              : null;
            // FAILED does not mean down: a failed re-declaration leaves the
            // previous build serving and `queryable` stays true (verified live).
            // Without this line the red card reads as an outage.
            const stillServing =
              isObj && String(idx.status).toUpperCase() === 'FAILED' && idx.queryable;
            const openEdit = () =>
              openIndexModal({ mode: 'edit', name, definition: definition || undefined });
            const notice = stillServing ? (
              <>
                <span class="record-card-notice-text">
                  The engine rejected v{ver ? ver.version : '?'}. The previous version is still
                  serving.
                </span>
                <button class="btn btn-sm" onClick={openEdit}>
                  Edit definition
                </button>
              </>
            ) : null;

            return (
              <IndexCard
                name={name}
                badges={badges}
                summary={definition ? summarizeDefinition(definition) : ''}
                definition={definition}
                meta={meta}
                notice={notice}
                onEdit={openEdit}
                canDrop
                onDrop={() => doDropSearchIndex(name)}
                cardClass={(isFailed ? 'record-card-failed' : null) as string | undefined}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
