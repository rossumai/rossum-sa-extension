import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, loading, error } from '../store.js';
import { openModal, closeModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import IndexCard from './IndexCard.jsx';
import { toCreateSearchIndexDefinition } from '../searchIndexDef.js';
import useOperationStatus from '../hooks/useOperationStatus.js';
import * as api from '../api.js';
import * as cache from '../cache.js';

function defaultTemplate() {
  return JSON.stringify({ indexName: 'my_search_index', mappings: { dynamic: true } }, null, 2);
}

export default function SearchIndexPanel() {
  const [indexes, setIndexes] = useState([]);
  const { track, clear } = useOperationStatus();

  async function loadSearchIndexes() {
    const collection = selectedCollection.value;
    if (!collection) return;

    const cached = cache.get(collection, 'searchIndexes');
    if (cached !== null) { setIndexes(cached); return; }

    const isVisible = activePanel.value === 'search-indexes';
    try {
      if (isVisible) { loading.value = true; error.value = null; }
      const res = await api.listSearchIndexes(collection, false);
      const result = res.result || [];
      cache.set(collection, 'searchIndexes', result);
      if (isVisible) loading.value = false;
      if (selectedCollection.value !== collection) return;
      setIndexes(result);
    } catch (err) {
      if (isVisible) { error.value = { message: err.message }; loading.value = false; }
    }
  }

  // Clear any in-flight op poll on collection/panel switch so a previous
  // collection's operation can't surface its result here.
  useEffect(() => { clear(); loadSearchIndexes(); }, [selectedCollection.value, activePanel.value]);

  function openCreateModal() {
    const editorRef = { current: null };

    openModal('Create Search Index', () => {
      const hintRef = useRef(null);

      async function handleCreate() {
        if (!editorRef.current?.isValid()) {
          if (hintRef.current) hintRef.current.textContent = 'Invalid JSON';
          return;
        }
        const parsed = editorRef.current.getParsed();
        const { indexName, mappings, analyzer, analyzers, searchAnalyzer, synonyms } = parsed;
        if (!indexName || !mappings) {
          if (hintRef.current) hintRef.current.textContent = 'indexName and mappings are required';
          return;
        }

        const opts = { indexName, mappings };
        if (analyzer) opts.analyzer = analyzer;
        if (analyzers) opts.analyzers = analyzers;
        if (searchAnalyzer) opts.searchAnalyzer = searchAnalyzer;
        if (synonyms) opts.synonyms = synonyms;

        try {
          loading.value = true;
          error.value = null;
          const res = await api.createSearchIndex(selectedCollection.value, opts);
          cache.invalidate(selectedCollection.value, 'searchIndexes');
          loading.value = false;
          closeModal();
          const opId = res.operationId;
          if (opId) track(opId, { label: `Creating search index "${indexName}"`, onFinished: loadSearchIndexes });
          else loadSearchIndexes();
        } catch (err) {
          loading.value = false;
          if (hintRef.current) hintRef.current.textContent = err.message;
        }
      }

      return (
        <div class="modal-body">
          <div class="modal-field-label">collectionName is set automatically from the selected collection</div>
          <JsonEditor value={defaultTemplate()} minHeight="250px" editorRef={editorRef} />
          <div ref={hintRef} class="input-hint"></div>
          <div class="modal-actions">
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-primary" onClick={handleCreate}>Create Search Index</button>
          </div>
        </div>
      );
    });
  }

  async function doDropSearchIndex(indexName) {
    try {
      loading.value = true;
      error.value = null;
      const res = await api.dropSearchIndex(selectedCollection.value, indexName);
      cache.invalidate(selectedCollection.value, 'searchIndexes');
      loading.value = false;
      const opId = res.operationId;
      if (opId) track(opId, { label: `Dropping search index "${indexName}"`, onFinished: loadSearchIndexes });
      else loadSearchIndexes();
    } catch (err) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  return (
    <div class="panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">Search Indexes (Atlas Search)</span>
        <button class="btn btn-success btn-sm" onClick={openCreateModal}>+ Create</button>
        <button class="icon-btn" title="Refresh" onClick={() => { cache.invalidate(selectedCollection.value, 'searchIndexes'); loadSearchIndexes(); }}>{'\u21bb'}</button>
      </div>
      <div class="index-list">
        {indexes.length === 0 ? (
          <div style="padding:16px;color:var(--text-secondary);font-size:12px">No search indexes</div>
        ) : indexes.map((idx) => {
          const isObj = typeof idx === 'object' && idx !== null;
          const name = isObj ? (idx.name || '(unnamed)') : String(idx);
          const badges = [];
          const status = isObj && idx.status ? String(idx.status).toUpperCase() : null;
          const isFailed = status === 'FAILED' || status === 'STALE';
          if (isObj && idx.status) {
            const cls = status === 'READY' ? 'index-badge-ready'
              : (status === 'PENDING' || status === 'BUILDING') ? 'index-badge-pending'
              : isFailed ? 'index-badge-failed' : '';
            badges.push({ text: idx.status.toLowerCase(), cls });
          }
          if (isObj && idx.type) badges.push({ text: idx.type });
          if (isObj && idx.queryable === false) badges.push({ text: 'not queryable', cls: 'index-badge-warning' });
          return <IndexCard name={name} badges={badges} definition={isObj ? toCreateSearchIndexDefinition(idx) : null} canDrop onDrop={() => doDropSearchIndex(name)} cardClass={isFailed ? 'record-card-failed' : null} />;
        })}
      </div>
    </div>
  );
}
