import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection, loading, error } from '../store.js';
import { openModal, closeModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import * as api from '../api.js';
import { showUndo } from '../undo.js';

// Below this many matches we snapshot the docs into the toast's rollback
// closure. Above it we skip undo — keeping the entire result set in browser
// memory for 10 s would risk OOM and the rollback insertMany would itself be
// a heavy multi-megabyte upload.
const UNDO_LIMIT = 1000;

export function openDeleteMany(onSuccess, fieldsFn) {
  openModal('Delete Many', () => <DeleteManyBody onSuccess={onSuccess} fieldsFn={fieldsFn} />);
}

function DeleteManyBody({ onSuccess, fieldsFn }) {
  const editorRef = useRef(null);
  const hintRef = useRef(null);
  const [matchCount, setMatchCount] = useState(null);

  async function refreshCount() {
    if (!editorRef.current?.isValid()) { setMatchCount(null); return; }
    try {
      const res = await api.aggregate(selectedCollection.value, [
        { $match: editorRef.current.getParsed() },
        { $count: 'total' },
      ]);
      setMatchCount(res.result?.[0]?.total ?? 0);
    } catch {
      setMatchCount(null);
    }
  }

  useEffect(() => { refreshCount(); }, []);

  async function handleDelete() {
    if (!editorRef.current?.isValid()) { hintRef.current.textContent = 'Invalid JSON'; return; }
    const col = selectedCollection.value;
    const filter = editorRef.current.getParsed();
    try {
      loading.value = true;
      error.value = null;

      // Capture a snapshot for undo *before* deleting, but only when the
      // match set is small enough to safely keep around.
      const undoEligible = typeof matchCount === 'number' && matchCount > 0 && matchCount <= UNDO_LIMIT;
      let snapshot = null;
      if (undoEligible) {
        const docsRes = await api.aggregate(col, [{ $match: filter }]);
        snapshot = docsRes.result || [];
      }

      const res = await api.deleteMany(col, filter);
      loading.value = false;
      const count = res.result?.deleted_count ?? 0;
      hintRef.current.style.color = 'var(--success)';
      hintRef.current.textContent = `Deleted ${count} document${count !== 1 ? 's' : ''}`;

      if (snapshot && snapshot.length > 0) {
        showUndo({
          message: `Deleted ${snapshot.length} document${snapshot.length !== 1 ? 's' : ''} from "${col}"`,
          action: async () => {
            // ordered:false — partial successes are still useful if a peer
            // process reused some _ids since the delete.
            await api.insertMany(col, snapshot, false);
            if (selectedCollection.value === col && onSuccess) onSuccess();
          },
        });
      }

      setTimeout(() => { closeModal(); if (onSuccess) onSuccess(); }, 1200);
    } catch (err) {
      loading.value = false;
      hintRef.current.style.color = '';
      hintRef.current.textContent = err.message;
    }
  }

  const undoEligible = typeof matchCount === 'number' && matchCount > 0 && matchCount <= UNDO_LIMIT;
  const undoUnavailable = typeof matchCount === 'number' && matchCount > UNDO_LIMIT;

  return (
    <div class="modal-body">
      <p class="modal-message" style="color:var(--danger)">
        This will delete ALL documents matching the filter.
        {undoEligible
          ? ' You’ll have a few seconds to undo.'
          : undoUnavailable
            ? ` Undo is unavailable for deletes over ${UNDO_LIMIT.toLocaleString()} documents.`
            : ' This action cannot be undone.'}
      </p>
      <div class="modal-field-label">Filter:</div>
      <JsonEditor value="{}" minHeight="100px" mode="query" fields={fieldsFn} editorRef={editorRef} onValidChange={refreshCount} />
      <div ref={hintRef} class="input-hint"></div>
      {matchCount !== null && (
        <div class="modal-count-info">{matchCount} document{matchCount !== 1 ? 's' : ''} will be deleted</div>
      )}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-danger" onClick={handleDelete}>Delete</button>
      </div>
    </div>
  );
}
