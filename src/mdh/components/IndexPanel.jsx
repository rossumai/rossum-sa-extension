import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, loading, error } from '../store.js';
import { openModal, closeModal, ModalBody, ModalActions, ModalFieldLabel } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import IndexCard from './IndexCard.jsx';
import { toCreateIndexDefinition, classifyIndexType, redundantIndexNames, formatBytes } from '../indexDef.js';
import useOperationStatus from '../hooks/useOperationStatus.js';
import * as api from '../api.js';
import * as cache from '../cache.js';

function defaultTemplate() {
  return JSON.stringify({ indexName: 'my_index', keys: { field: 1 }, options: {} }, null, 2);
}

export default function IndexPanel() {
  const [indexes, setIndexes] = useState([]);
  const [stats, setStats] = useState(null);
  const { track, clear } = useOperationStatus();

  async function loadIndexes() {
    const collection = selectedCollection.value;
    if (!collection) return;

    const cached = cache.get(collection, 'indexes');
    if (cached !== null) { setIndexes(cached); return; }

    const isVisible = activePanel.value === 'indexes';
    try {
      if (isVisible) { loading.value = true; error.value = null; }
      const res = await api.listIndexes(collection, false);
      const result = res.result || [];
      cache.set(collection, 'indexes', result);
      if (isVisible) loading.value = false;
      if (selectedCollection.value !== collection) return;
      setIndexes(result);
    } catch (err) {
      if (isVisible) { error.value = { message: err.message }; loading.value = false; }
    }
  }

  // Best-effort: per-index sizes + collection totals via $collStats. Never
  // surfaces an error — size display is purely additive (and $collStats may be
  // unavailable on some environments).
  async function loadStats() {
    const collection = selectedCollection.value;
    if (!collection) return;
    const cached = cache.get(collection, 'collStats');
    if (cached !== null) { setStats(cached); return; }
    try {
      const res = await api.collectionStats(collection);
      const s = res.result?.[0] || null;
      cache.set(collection, 'collStats', s);
      if (selectedCollection.value === collection) setStats(s);
    } catch { /* size display is optional */ }
  }

  // Re-list indexes and refresh sizes — run once an async op actually finishes.
  function reloadAll() { loadIndexes(); loadStats(); }

  // Reset on collection/panel switch — including clearing any in-flight op poll
  // so a previous collection's operation can't surface its result under another.
  useEffect(() => { clear(); setStats(null); loadIndexes(); loadStats(); }, [selectedCollection.value, activePanel.value]);

  function openCreateModal() {
    const editorRef = { current: null };

    openModal('Create Index', () => {
      const hintRef = useRef(null);

      async function handleCreate() {
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        const parsed = editorRef.current.getParsed();
        const { indexName, keys, options: opts } = parsed;
        if (!indexName || !keys) {
          if (hintRef.current) hintRef.current.textContent = 'indexName and keys are required';
          return;
        }

        try {
          loading.value = true;
          error.value = null;
          const res = await api.createIndex(selectedCollection.value, indexName, keys, opts || {});
          cache.invalidate(selectedCollection.value, 'indexes');
          cache.invalidate(selectedCollection.value, 'collStats');
          loading.value = false;
          closeModal();
          const opId = res.operationId;
          if (opId) track(opId, { label: `Creating index "${indexName}"`, onFinished: reloadAll });
          else reloadAll();
        } catch (err) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = err.message;
        }
      }

      return (
        <ModalBody>
          <ModalFieldLabel>collectionName is set automatically from the selected collection</ModalFieldLabel>
          <JsonEditor value={defaultTemplate()} minHeight="250px" editorRef={editorRef} />
          <div ref={hintRef} class="input-hint"></div>
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-primary" onClick={handleCreate}>Create Index</button>
          </ModalActions>
        </ModalBody>
      );
    });
  }

  async function doDropIndex(indexName) {
    try {
      loading.value = true;
      error.value = null;
      const res = await api.dropIndex(selectedCollection.value, indexName);
      cache.invalidate(selectedCollection.value, 'indexes');
      cache.invalidate(selectedCollection.value, 'collStats');
      loading.value = false;
      const opId = res.operationId;
      if (opId) track(opId, { label: `Dropping index "${indexName}"`, onFinished: reloadAll });
      else reloadAll();
    } catch (err) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  const redundant = redundantIndexNames(indexes);
  const indexSizes = stats?.indexSizes || {};
  const metaLabel = stats ? [
    stats.count != null ? `${stats.count.toLocaleString('en-US')} docs` : null,
    stats.totalIndexSize != null ? formatBytes(stats.totalIndexSize) : null,
  ].filter(Boolean).join(' \u00b7 ') : '';

  return (
    <div class="panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">
          Indexes{metaLabel ? <span class="panel-meta">{metaLabel}</span> : null}
        </span>
        <button class="btn btn-success btn-sm" onClick={openCreateModal}>+ Create</button>
        <button class="icon-btn" title="Refresh" onClick={() => { cache.invalidate(selectedCollection.value, 'indexes'); cache.invalidate(selectedCollection.value, 'collStats'); loadIndexes(); loadStats(); }}>{'\u21bb'}</button>
      </div>
      <div class="index-list">
        {indexes.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">No indexes</div>
        ) : indexes.map((idx) => {
          const isObj = typeof idx === 'object' && idx !== null;
          const name = isObj ? (idx.name || '(unnamed)') : String(idx);
          const isDefault = name === '_id_';
          const badges = [];
          if (isDefault) badges.push({ text: 'default', cls: 'index-badge-default' });
          if (isObj && idx.unique) badges.push({ text: 'unique', cls: 'index-badge-unique' });
          if (isObj && idx.sparse) badges.push({ text: 'sparse' });
          if (isObj && idx.expireAfterSeconds != null) badges.push({ text: `TTL: ${idx.expireAfterSeconds}s` });
          const type = isObj ? classifyIndexType(idx.key) : null;
          if (type && type !== 'single') badges.push({ text: type });
          if (redundant.has(name)) badges.push({ text: 'redundant?', cls: 'index-badge-warning' });
          const sizeMeta = formatBytes(indexSizes[name]);
          return <IndexCard name={name} badges={badges} definition={isObj ? toCreateIndexDefinition(idx) : null} meta={sizeMeta || null} canDrop={!isDefault} onDrop={() => doDropIndex(name)} />;
        })}
      </div>
    </div>
  );
}
