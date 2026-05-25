import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { selectedCollection, loading, error } from '../store.js';
import { openModal, closeModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import InsertFileWizard from './InsertFileWizard.jsx';
import * as api from '../api.js';

function FileInput({ onParsed }) {
  const [fileName, setFileName] = useState(null);
  const [docCount, setDocCount] = useState(0);
  const parsedRef = useRef(null);

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) parsed = [parsed];
      parsedRef.current = parsed;
      setFileName(file.name);
      setDocCount(parsed.length);
      if (onParsed) onParsed(parsed);
    }).catch((err) => {
      setFileName('Error: ' + err.message);
      parsedRef.current = null;
    });
  }

  return (
    <div class="file-input-area">
      <input type="file" accept=".json" style="display:none" onChange={handleFileChange} ref={(el) => { if (el) el._fileInput = el; }} />
      <div class="file-input-label" onClick={(e) => { e.currentTarget.previousSibling.click(); }}>
        {fileName || 'Click to select a JSON file'}
      </div>
      {fileName && docCount > 0 && <div class="file-input-info">{docCount} document{docCount !== 1 ? 's' : ''}</div>}
    </div>
  );
}

function MatchFields({ docs, matchFieldsRef }) {
  if (!docs || docs.length === 0) return null;
  const fields = Object.keys(docs[0]);

  return (
    <div ref={matchFieldsRef} class="match-fields">
      {fields.map((field) => (
        <label class="match-field-option">
          <input type="checkbox" value={field} checked={field === '_id'} />
          <span>{field}</span>
        </label>
      ))}
    </div>
  );
}

function getSelectedMatchFields(container) {
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
}

export function openDataOperations(mode, onSuccess, fieldsFn) {
  // Bulk update/delete by filter live in BulkUpdate/BulkDelete; this dispatcher
  // now only handles insert (inline + file) and the file-driven update/replace
  // reconciliation flows.
  const isFile = mode.endsWith('-file');
  const op = mode.replace('-file', '');
  const title = op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');

  openModal(title, () => {
    if (op === 'insert' && isFile) return <InsertFileWizard onSuccess={onSuccess} />;
    if (op === 'insert') return <InsertPanel isFile={false} onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    if (op === 'update' && isFile) return <UpdatePanel onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    if (op === 'replace' && isFile) return <ReplacePanel onSuccess={onSuccess} fieldsFn={fieldsFn} />;
    return null;
  });
}

// Inline (JSON-editor) insert path. The file-import path is handled by
// InsertFileWizard, which adds chunking, pre-validation, conflict resolution,
// progress, and cancellation.
function InsertPanel({ onSuccess, fieldsFn }) {
  const editorRef = useRef(null);
  const hintRef = useRef(null);

  async function handleSubmit() {
    const collection = selectedCollection.value;
    let docs;
    try {
      if (!editorRef.current?.isValid()) { hintRef.current.textContent = 'Invalid JSON'; return; }
      docs = editorRef.current.getParsed();
    } catch (e) { hintRef.current.textContent = e.message; return; }

    if (!Array.isArray(docs)) docs = [docs];
    if (docs.length === 0) { hintRef.current.textContent = 'No documents'; return; }

    try {
      loading.value = true;
      error.value = null;
      if (docs.length === 1) await api.insertOne(collection, docs[0]);
      else await api.insertMany(collection, docs);
      loading.value = false;
      hintRef.current.style.color = 'var(--success)';
      hintRef.current.textContent = `Inserted ${docs.length} document${docs.length !== 1 ? 's' : ''}`;
      setTimeout(() => { closeModal(); if (onSuccess) onSuccess(); }, 500);
    } catch (err) {
      loading.value = false;
      hintRef.current.style.color = '';
      hintRef.current.textContent = err.message;
    }
  }

  return (
    <div class="modal-body">
      <div>
        <div class="modal-field-label">Document or array of documents:</div>
        <JsonEditor value={'{\n  \n}'} minHeight="200px" fields={fieldsFn} editorRef={editorRef} />
      </div>
      <div ref={hintRef} class="input-hint"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-success" onClick={handleSubmit}>Insert</button>
      </div>
    </div>
  );
}

function UpdatePanel({ onSuccess, fieldsFn }) {
  const hintRef = useRef(null);
  const matchFieldsRef = useRef(null);
  const [fileDocs, setFileDocs] = useState(null);

  async function handleSubmit() {
    const collection = selectedCollection.value;
    hintRef.current.style.color = '';

    if (!fileDocs) { hintRef.current.textContent = 'No file selected'; return; }
    const keys = getSelectedMatchFields(matchFieldsRef.current);
    if (keys.length === 0) { hintRef.current.textContent = 'Select at least one match field'; return; }
    try {
      loading.value = true;
      error.value = null;
      let updated = 0;
      for (const doc of fileDocs) {
        const filter = {};
        for (const k of keys) filter[k] = doc[k];
        const upd = { ...doc };
        for (const k of keys) delete upd[k];
        await api.updateOne(collection, filter, { $set: upd });
        updated++;
        hintRef.current.textContent = `Updating... ${updated}/${fileDocs.length}`;
      }
      loading.value = false;
      hintRef.current.style.color = 'var(--success)';
      hintRef.current.textContent = `Updated ${updated} document${updated !== 1 ? 's' : ''}`;
      setTimeout(() => { closeModal(); if (onSuccess) onSuccess(); }, 500);
    } catch (err) {
      loading.value = false;
      hintRef.current.textContent = err.message;
    }
  }

  return (
    <div class="modal-body">
      <div>
        <div class="modal-field-label">1. Select a JSON file with documents:</div>
        <FileInput onParsed={setFileDocs} />
        {fileDocs && (
          <div>
            <div class="modal-field-label" style="margin-top:10px">2. Select field(s) to match existing documents:</div>
            <div class="modal-message" style="font-size:11px">Each record will be matched by these fields. Remaining fields will be updated with $set.</div>
            <MatchFields docs={fileDocs} matchFieldsRef={matchFieldsRef} />
          </div>
        )}
      </div>
      <div ref={hintRef} class="input-hint"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSubmit}>Update</button>
      </div>
    </div>
  );
}

function ReplacePanel({ onSuccess, fieldsFn }) {
  const hintRef = useRef(null);
  const matchFieldsRef = useRef(null);
  const [fileDocs, setFileDocs] = useState(null);

  async function handleSubmit() {
    const collection = selectedCollection.value;
    hintRef.current.style.color = '';

    if (!fileDocs) { hintRef.current.textContent = 'No file selected'; return; }
    const keys = getSelectedMatchFields(matchFieldsRef.current);
    if (keys.length === 0) { hintRef.current.textContent = 'Select at least one match field'; return; }
    try {
      loading.value = true;
      error.value = null;
      let replaced = 0;
      for (const doc of fileDocs) {
        const filter = {};
        for (const k of keys) filter[k] = doc[k];
        const replacement = { ...doc };
        delete replacement._id;
        await api.replaceOne(collection, filter, replacement);
        replaced++;
        hintRef.current.textContent = `Replacing... ${replaced}/${fileDocs.length}`;
      }
      loading.value = false;
      hintRef.current.style.color = 'var(--success)';
      hintRef.current.textContent = `Replaced ${replaced} document${replaced !== 1 ? 's' : ''}`;
      setTimeout(() => { closeModal(); if (onSuccess) onSuccess(); }, 500);
    } catch (err) {
      loading.value = false;
      hintRef.current.textContent = err.message;
    }
  }

  return (
    <div class="modal-body">
      <div>
        <div class="modal-field-label">1. Select a JSON file with documents:</div>
        <FileInput onParsed={setFileDocs} />
        {fileDocs && (
          <div>
            <div class="modal-field-label" style="margin-top:10px">2. Select field(s) to match existing documents:</div>
            <div class="modal-message" style="font-size:11px">Each record will be matched by these fields and the entire document will be replaced.</div>
            <MatchFields docs={fileDocs} matchFieldsRef={matchFieldsRef} />
          </div>
        )}
      </div>
      <div ref={hintRef} class="input-hint"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSubmit}>Replace</button>
      </div>
    </div>
  );
}
