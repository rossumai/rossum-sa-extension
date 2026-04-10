import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';
import { createJsonEditor } from './json-editor.js';

export function openUpdateMany(onSuccess, fields) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const filterLabel = document.createElement('div');
  filterLabel.className = 'modal-field-label';
  filterLabel.textContent = 'Filter (which documents to update):';
  body.appendChild(filterLabel);

  const filterEditor = createJsonEditor({ value: '{}', minHeight: '60px', mode: 'query', fields });
  body.appendChild(filterEditor.el);

  const updateLabel = document.createElement('div');
  updateLabel.className = 'modal-field-label';
  updateLabel.textContent = 'Update expression:';
  body.appendChild(updateLabel);

  const updateEditor = createJsonEditor({ value: '{\n  "$set": {\n    \n  }\n}', minHeight: '80px', mode: 'update', fields });
  body.appendChild(updateEditor.el);

  const hint = document.createElement('div');
  hint.className = 'input-hint';
  body.appendChild(hint);

  const previewBox = document.createElement('div');
  previewBox.className = 'preview-box hidden';
  const previewPre = document.createElement('pre');
  previewBox.appendChild(previewPre);
  body.appendChild(previewBox);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn btn-secondary';
  previewBtn.textContent = 'Preview (5 docs)';

  previewBtn.addEventListener('click', async () => {
    if (!filterEditor.isValid()) {
      hint.textContent = 'Invalid filter JSON';
      return;
    }
    try {
      const res = await api.find(state.get('selectedCollection'), { query: filterEditor.getParsed(), limit: 5 });
      previewPre.textContent = JSON.stringify(res.result, null, 2);
      previewBox.classList.remove('hidden');
      hint.textContent = '';
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Update Many';

  submitBtn.addEventListener('click', async () => {
    if (!filterEditor.isValid()) { hint.textContent = 'Invalid filter JSON'; return; }
    if (!updateEditor.isValid()) { hint.textContent = 'Invalid update JSON'; return; }

    try {
      state.set({ loading: true, error: null });
      const res = await api.updateMany(state.get('selectedCollection'), filterEditor.getParsed(), updateEditor.getParsed());
      state.set({ loading: false });
      const matched = res.result?.matched_count ?? 0;
      const modified = res.result?.modified_count ?? 0;
      hint.style.color = 'var(--success)';
      hint.textContent = `Done: ${matched} matched, ${modified} modified`;
      setTimeout(() => {
        closeModal();
        if (onSuccess) onSuccess();
      }, 1200);
    } catch (err) {
      state.set({ loading: false });
      hint.style.color = '';
      hint.textContent = err.message;
    }
  });

  actions.appendChild(previewBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  openModal('Update Many', body);
}
