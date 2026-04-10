import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';
import { createJsonEditor } from './json-editor.js';

export function openRecordEditor(mode, record, onSuccess, fields) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const label = document.createElement('div');
  label.className = 'modal-field-label';
  body.appendChild(label);

  let initialValue = '{\n  \n}';
  if (mode === 'insert') {
    label.textContent = 'Document or array of documents (JSON):';
  } else if (mode === 'edit') {
    label.textContent = 'Update expression (MongoDB update syntax):';
    const copy = { ...record };
    delete copy._id;
    initialValue = JSON.stringify({ $set: copy }, null, 2);
  } else if (mode === 'replace') {
    label.textContent = 'Replacement document (full document, excluding _id):';
    const copy = { ...record };
    delete copy._id;
    initialValue = JSON.stringify(copy, null, 2);
  }

  const editor = createJsonEditor({ value: initialValue, minHeight: '200px', fields });
  body.appendChild(editor.el);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = mode === 'insert' ? 'Insert' : mode === 'edit' ? 'Update' : 'Replace';

  submitBtn.addEventListener('click', async () => {
    if (!editor.isValid()) {
      hint.textContent = 'Invalid JSON: ' + editor.getError();
      return;
    }
    const parsed = editor.getParsed();
    hint.textContent = '';

    const collection = state.get('selectedCollection');
    try {
      state.set({ loading: true, error: null });
      if (mode === 'insert') {
        if (Array.isArray(parsed)) {
          await api.insertMany(collection, parsed);
        } else {
          await api.insertOne(collection, parsed);
        }
      } else if (mode === 'edit') {
        await api.updateOne(collection, { _id: record._id }, parsed);
      } else if (mode === 'replace') {
        await api.replaceOne(collection, { _id: record._id }, parsed);
      }
      state.set({ loading: false });
      closeModal();
      if (onSuccess) onSuccess();
    } catch (err) {
      state.set({ loading: false });
      hint.textContent = err.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  const title = mode === 'insert' ? 'Insert' : mode === 'edit' ? 'Edit Record' : 'Replace Record';
  openModal(title, body);
}
