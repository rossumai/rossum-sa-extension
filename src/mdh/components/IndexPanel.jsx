import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { selectedCollection, activePanel, loading, error } from '../store.js';
import { openModal, closeModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import IndexCard from './IndexCard.jsx';
import * as api from '../api.js';
import * as ai from '../ai.js';
import * as cache from '../cache.js';

function defaultTemplate() {
  return JSON.stringify({ indexName: 'my_index', keys: { field: 1 }, options: {} }, null, 2);
}

function parseOperationId(message) {
  return message ? message.match(/[a-f0-9]{24}/i)?.[0] : null;
}

export default function IndexPanel() {
  const [indexes, setIndexes] = useState([]);
  const [opStatus, setOpStatus] = useState(null);

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
      setIndexes(result);
      result.forEach((idx) => { if (typeof idx === 'object' && idx) ai.preload(idx, 'index'); });
    } catch (err) {
      if (isVisible) { error.value = { message: err.message }; loading.value = false; }
    }
  }

  useEffect(() => { loadIndexes(); }, [selectedCollection.value, activePanel.value]);

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
          loading.value = false;
          closeModal();
          const opId = parseOperationId(res.message);
          if (opId) setOpStatus({ operationId: opId, status: 'RUNNING', errorMessage: null });
          await loadIndexes();
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
            <button class="btn btn-primary" onClick={handleCreate}>Create Index</button>
          </div>
        </div>
      );
    });
  }

  async function doDropIndex(indexName) {
    try {
      loading.value = true;
      error.value = null;
      const res = await api.dropIndex(selectedCollection.value, indexName);
      cache.invalidate(selectedCollection.value, 'indexes');
      loading.value = false;
      const opId = parseOperationId(res.message);
      if (opId) setOpStatus({ operationId: opId, status: 'RUNNING', errorMessage: null });
      await loadIndexes();
    } catch (err) {
      error.value = { message: err.message };
      loading.value = false;
    }
  }

  async function checkStatus() {
    if (!opStatus) return;
    try {
      const res = await api.checkOperationStatus(opStatus.operationId);
      const op = res.result || {};
      setOpStatus({ operationId: opStatus.operationId, status: op.status || 'UNKNOWN', errorMessage: op.error_message });
    } catch (err) {
      setOpStatus({ ...opStatus, status: 'ERROR', errorMessage: err.message });
    }
  }

  return (
    <div class="panel">
      <div class="toolbar">
        <span style="flex:1;font-weight:500">Indexes</span>
        <button class="btn btn-success btn-sm" onClick={openCreateModal}>+ Create</button>
        <button class="icon-btn" title="Refresh" onClick={() => { cache.invalidate(selectedCollection.value, 'indexes'); loadIndexes(); }}>{'\u21bb'}</button>
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
          return <IndexCard name={name} badges={badges} definition={isObj ? idx : null} canDrop={!isDefault} onDrop={() => doDropIndex(name)} indexType="index" />;
        })}
      </div>
      {opStatus && (
        <div style="padding:8px 16px">
          <div class="op-status">
            <span class={`op-status-badge ${opStatus.status === 'FINISHED' ? 'finished' : opStatus.status === 'FAILED' ? 'failed' : 'running'}`}>
              {opStatus.status.toLowerCase()}
            </span>
            <span>Operation: {opStatus.operationId}</span>
            {opStatus.status !== 'FINISHED' && opStatus.status !== 'FAILED' && (
              <button class="btn btn-sm op-check-btn" style="margin-left:auto" onClick={checkStatus}>Check Status</button>
            )}
            {opStatus.errorMessage && <span style="color:var(--danger);margin-left:8px">{opStatus.errorMessage}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
