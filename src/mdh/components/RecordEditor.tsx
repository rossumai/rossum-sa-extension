import { h } from 'preact';
import { useRef } from 'preact/hooks';
import { selectedCollection, loading, error } from '../store.js';
import { openModal, closeModal, ModalBody, ModalActions, ModalFieldLabel } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import { stripEmptyOperators } from '../updateExpr.js';
import * as api from '../api.js';
import type { JsonEditorHandle } from './JsonEditor.jsx';

// Builds the prefilled editor text. Both blocks have parallel hint comments
// inside so the syntax is discoverable without bloating the modal with extra
// inputs. strip-empties on submit drops any block left empty.
function buildEditPrefill(record: any) {
  const copy = { ...record };
  delete copy._id;
  // Render the record body as the inner contents of $set (4-space indented to
  // sit one level inside the outer braces). For an empty record, fall through
  // to just the hint comment.
  const innerLines = JSON.stringify(copy, null, 2)
    .split('\n')
    .slice(1, -1)
    .map((line) => '  ' + line)
    .join('\n');
  const setBody = innerLines
    ? `    // Fields to update, e.g. "status": "active"\n${innerLines}`
    : '    // Fields to update, e.g. "status": "active"';
  return `{
  "$set": {
${setBody}
  },
  "$unset": {
    // Fields to remove, e.g. "legacy": "" (value is ignored)
  }
}`;
}

function buildReplacePrefill(record: any) {
  const copy = { ...record };
  delete copy._id;
  return JSON.stringify(copy, null, 2);
}

export function openRecordEditor(mode: any, record: any, onSuccess: any, fieldsFn: any) {
  openModal(mode === 'edit' ? 'Edit Record' : 'Replace Record', () => (
    <Body mode={mode} record={record} onSuccess={onSuccess} fieldsFn={fieldsFn} />
  ));
}

function Body(
  { mode, record, onSuccess, fieldsFn }:
  { mode: string; record?: any; onSuccess?: () => unknown; fieldsFn?: () => any },
) {
  const editorRef = useRef<JsonEditorHandle | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

  const initialValue = mode === 'edit' ? buildEditPrefill(record) : buildReplacePrefill(record);
  const label = mode === 'edit'
    ? 'Update expression (MongoDB update syntax):'
    : 'Replacement document (full document, excluding _id):';

  async function handleSubmit() {
    if (!editorRef.current?.isValid()) {
      if (hintRef.current) hintRef.current.textContent = 'Invalid JSON: ' + (editorRef.current?.getError() || '');
      return;
    }
    const parsed = editorRef.current.getParsed();
    const collection = selectedCollection.value;
    try {
      loading.value = true;
      error.value = null;
      if (mode === 'edit') await api.updateOne(collection as string, { _id: record._id }, stripEmptyOperators(parsed));
      else await api.replaceOne(collection as string, { _id: record._id }, parsed);
      loading.value = false;
      closeModal();
      if (onSuccess) onSuccess();
    } catch (err: any) {
      loading.value = false;
      if (hintRef.current) hintRef.current.textContent = err.message;
    }
  }

  return (
    <ModalBody>
      <ModalFieldLabel>{label}</ModalFieldLabel>
      <JsonEditor value={initialValue} minHeight="200px" fields={fieldsFn} editorRef={editorRef} />
      <div ref={hintRef} class="input-hint"></div>
      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSubmit}>{mode === 'edit' ? 'Update' : 'Replace'}</button>
      </ModalActions>
    </ModalBody>
  );
}
