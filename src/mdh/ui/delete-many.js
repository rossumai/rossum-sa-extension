import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';
import { createJsonEditor } from './json-editor.js';

export function openDeleteMany(onSuccess, fields) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const warning = document.createElement('p');
  warning.className = 'modal-message';
  warning.style.color = 'var(--danger)';
  warning.textContent = 'This will delete ALL documents matching the filter. This action cannot be undone.';
  body.appendChild(warning);

  const filterLabel = document.createElement('div');
  filterLabel.className = 'modal-field-label';
  filterLabel.textContent = 'Filter:';
  body.appendChild(filterLabel);

  const filterEditor = createJsonEditor({ value: '{}', minHeight: '80px', mode: 'query', fields });
  body.appendChild(filterEditor.el);

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
      hint.textContent = 'Invalid JSON';
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

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete Many';

  deleteBtn.addEventListener('click', async () => {
    if (!filterEditor.isValid()) {
      hint.textContent = 'Invalid JSON';
      return;
    }

    try {
      state.set({ loading: true, error: null });
      const res = await api.deleteMany(state.get('selectedCollection'), filterEditor.getParsed());
      state.set({ loading: false });
      const count = res.result?.deleted_count ?? 0;
      hint.style.color = 'var(--success)';
      hint.textContent = `Deleted ${count} document${count !== 1 ? 's' : ''}`;
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
  actions.appendChild(deleteBtn);
  body.appendChild(actions);

  openModal('Delete Many', body);
}
