import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';

export function openRecordEditor(mode, record, onSuccess) {
  let currentMode = mode === 'insert' ? 'insertOne' : mode;

  const body = document.createElement('div');
  body.className = 'modal-body';

  if (mode === 'insert') {
    const toggle = document.createElement('div');
    toggle.className = 'mode-toggle';
    toggle.style.marginBottom = '8px';

    const oneBtn = document.createElement('button');
    oneBtn.textContent = 'Insert One';
    oneBtn.className = 'active';

    const manyBtn = document.createElement('button');
    manyBtn.textContent = 'Insert Many';

    oneBtn.addEventListener('click', () => {
      currentMode = 'insertOne';
      oneBtn.className = 'active';
      manyBtn.className = '';
      label.textContent = 'Document (JSON):';
      textarea.value = '{\n  \n}';
      hint.textContent = '';
    });

    manyBtn.addEventListener('click', () => {
      currentMode = 'insertMany';
      manyBtn.className = 'active';
      oneBtn.className = '';
      label.textContent = 'Documents (JSON array):';
      textarea.value = '[\n  {\n    \n  }\n]';
      hint.textContent = '';
    });

    toggle.appendChild(oneBtn);
    toggle.appendChild(manyBtn);
    body.appendChild(toggle);
  }

  const label = document.createElement('div');
  label.className = 'modal-field-label';
  body.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'input textarea-fill';
  textarea.style.minHeight = '200px';
  body.appendChild(textarea);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  if (mode === 'insert') {
    label.textContent = 'Document (JSON):';
    textarea.value = '{\n  \n}';
  } else if (mode === 'edit') {
    label.textContent = 'Update expression (MongoDB update syntax):';
    const fields = { ...record };
    delete fields._id;
    textarea.value = JSON.stringify({ $set: fields }, null, 2);
  } else if (mode === 'replace') {
    label.textContent = 'Replacement document (full document, excluding _id):';
    const fields = { ...record };
    delete fields._id;
    textarea.value = JSON.stringify(fields, null, 2);
  }

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
    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
      hint.textContent = '';
      textarea.classList.remove('input-error');
    } catch (e) {
      hint.textContent = 'Invalid JSON: ' + e.message;
      textarea.classList.add('input-error');
      return;
    }

    const collection = state.get('selectedCollection');
    try {
      state.set({ loading: true, error: null });
      if (currentMode === 'insertOne') {
        await api.insertOne(collection, parsed);
      } else if (currentMode === 'insertMany') {
        if (!Array.isArray(parsed)) {
          hint.textContent = 'Expected a JSON array of documents';
          textarea.classList.add('input-error');
          state.set({ loading: false });
          return;
        }
        await api.insertMany(collection, parsed);
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

  const title = mode === 'insert' ? 'Insert Record' : mode === 'edit' ? 'Edit Record' : 'Replace Record';
  openModal(title, body);
}
