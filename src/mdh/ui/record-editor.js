import * as api from '../api.js';
import * as state from '../state.js';
import { openModal, closeModal } from './modal.js';
import { createJsonEditor } from './json-editor.js';

function buildPanelActions(panel, { submitLabel, submitClass = 'btn-primary' }) {
  const hint = document.createElement('div');
  hint.className = 'input-hint';
  panel.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);
  const submitBtn = document.createElement('button');
  submitBtn.className = `btn ${submitClass}`;
  submitBtn.textContent = submitLabel;
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  panel.appendChild(actions);

  return { hint, submitBtn };
}

function showSuccessAndClose(hint, message, onSuccess) {
  hint.style.color = 'var(--success)';
  hint.textContent = message;
  setTimeout(() => {
    closeModal();
    if (onSuccess) onSuccess();
  }, 500);
}

// Opens modal for a single record (from row Edit/Replace buttons)
export function openRecordEditor(mode, record, onSuccess, fields) {
  const body = document.createElement('div');
  body.className = 'modal-body';

  const label = document.createElement('div');
  label.className = 'modal-field-label';
  body.appendChild(label);

  let initialValue = '{\n  \n}';
  if (mode === 'edit') {
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

  const { hint, submitBtn } = buildPanelActions(body, {
    submitLabel: mode === 'edit' ? 'Update' : 'Replace',
  });

  submitBtn.addEventListener('click', async () => {
    if (!editor.isValid()) { hint.textContent = 'Invalid JSON: ' + editor.getError(); return; }
    const parsed = editor.getParsed();
    const collection = state.get('selectedCollection');
    try {
      state.set({ loading: true, error: null });
      if (mode === 'edit') {
        await api.updateOne(collection, { _id: record._id }, parsed);
      } else {
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

  openModal(mode === 'edit' ? 'Edit Record' : 'Replace Record', body);
}

// Opens a data operation modal for a specific mode
// Modes: 'insert', 'insert-file', 'update', 'update-file', 'replace', 'replace-file'
export function openDataOperations(mode, onSuccess, fields) {
  const isFile = mode.endsWith('-file');
  const op = mode.replace('-file', '');
  const title = op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');

  let panel;
  if (op === 'insert') panel = buildInsertPanel(onSuccess, fields, isFile);
  else if (op === 'update') panel = buildUpdatePanel(onSuccess, fields, isFile);
  else if (op === 'replace') panel = buildReplacePanel(onSuccess, fields, isFile);

  openModal(title, panel);
}

// ── Insert panel ────────────────────────────────

function buildInsertPanel(onSuccess, fields, fileMode) {
  const panel = document.createElement('div');
  panel.className = 'modal-body';

  let editor = null;
  let fileInput = null;

  if (fileMode) {
    const fileLabel = document.createElement('div');
    fileLabel.className = 'modal-field-label';
    fileLabel.textContent = 'Select a JSON file with documents to insert:';
    panel.appendChild(fileLabel);
    fileInput = buildFileInput();
    panel.appendChild(fileInput.el);
  } else {
    const manualLabel = document.createElement('div');
    manualLabel.className = 'modal-field-label';
    manualLabel.textContent = 'Document or array of documents:';
    panel.appendChild(manualLabel);
    editor = createJsonEditor({ value: '{\n  \n}', minHeight: '200px', fields });
    panel.appendChild(editor.el);
  }

  const { hint, submitBtn } = buildPanelActions(panel, { submitLabel: 'Insert', submitClass: 'btn-success' });

  submitBtn.addEventListener('click', async () => {
    const collection = state.get('selectedCollection');
    let docs;
    try {
      if (fileMode) {
        docs = await fileInput.parse();
      } else {
        if (!editor.isValid()) { hint.textContent = 'Invalid JSON'; return; }
        docs = editor.getParsed();
      }
    } catch (e) { hint.textContent = e.message; return; }

    if (!Array.isArray(docs)) docs = [docs];
    if (docs.length === 0) { hint.textContent = 'No documents'; return; }
    hint.textContent = '';

    try {
      state.set({ loading: true, error: null });
      if (docs.length === 1) await api.insertOne(collection, docs[0]);
      else await api.insertMany(collection, docs);
      state.set({ loading: false });
      showSuccessAndClose(hint, `Inserted ${docs.length} document${docs.length !== 1 ? 's' : ''}`, onSuccess);
    } catch (err) {
      state.set({ loading: false });
      hint.style.color = '';
      hint.textContent = err.message;
    }
  });

  return panel;
}

// ── Update panel ────────────────────────────────

function buildUpdatePanel(onSuccess, fields, fileMode) {
  const panel = document.createElement('div');
  panel.className = 'modal-body';

  let filterEditor = null, updateEditor = null, fileInput = null, matchFields = null;

  if (fileMode) {
    const step1 = document.createElement('div');
    step1.className = 'modal-field-label';
    step1.textContent = '1. Select a JSON file with documents:';
    panel.appendChild(step1);

    fileInput = buildFileInput();
    panel.appendChild(fileInput.el);

    const matchSection = document.createElement('div');
    matchSection.classList.add('hidden');
    const matchInfo = document.createElement('div');
    matchInfo.className = 'modal-field-label';
    matchInfo.style.marginTop = '10px';
    matchInfo.textContent = '2. Select field(s) to match existing documents:';
    matchSection.appendChild(matchInfo);
    const matchHint = document.createElement('div');
    matchHint.className = 'modal-message';
    matchHint.style.fontSize = '11px';
    matchHint.textContent = 'Each record will be matched by these fields. Remaining fields will be updated with $set.';
    matchSection.appendChild(matchHint);
    matchFields = document.createElement('div');
    matchFields.className = 'match-fields';
    matchSection.appendChild(matchFields);
    panel.appendChild(matchSection);

    fileInput.onLoad((docs) => {
      renderMatchFields(matchFields, docs);
      matchSection.classList.remove('hidden');
    });
  } else {
    const filterLabel = document.createElement('div');
    filterLabel.className = 'modal-field-label';
    filterLabel.textContent = 'Filter:';
    panel.appendChild(filterLabel);
    filterEditor = createJsonEditor({ value: '{}', minHeight: '80px', mode: 'query', fields });
    panel.appendChild(filterEditor.el);
    const updateLabel = document.createElement('div');
    updateLabel.className = 'modal-field-label';
    updateLabel.style.marginTop = '8px';
    updateLabel.textContent = 'Update expression:';
    panel.appendChild(updateLabel);
    updateEditor = createJsonEditor({ value: '{\n  "$set": {\n    \n  }\n}', minHeight: '120px', mode: 'update', fields });
    panel.appendChild(updateEditor.el);
  }

  const { hint, submitBtn } = buildPanelActions(panel, { submitLabel: 'Update' });

  submitBtn.addEventListener('click', async () => {
    const collection = state.get('selectedCollection');
    hint.style.color = '';

    if (fileMode) {
      let docs;
      try { docs = await fileInput.parse(); } catch (e) { hint.textContent = e.message; return; }
      if (!Array.isArray(docs)) docs = [docs];
      const keys = getSelectedMatchFields(matchFields);
      if (keys.length === 0) { hint.textContent = 'Select at least one match field'; return; }
      hint.textContent = '';
      try {
        state.set({ loading: true, error: null });
        let updated = 0;
        for (const doc of docs) {
          const filter = {};
          for (const k of keys) filter[k] = doc[k];
          const upd = { ...doc };
          for (const k of keys) delete upd[k];
          await api.updateOne(collection, filter, { $set: upd });
          updated++;
          hint.textContent = `Updating... ${updated}/${docs.length}`;
        }
        state.set({ loading: false });
        showSuccessAndClose(hint, `Updated ${updated} document${updated !== 1 ? 's' : ''}`, onSuccess);
      } catch (err) {
        state.set({ loading: false });
        hint.style.color = '';
        hint.textContent = err.message;
      }
    } else {
      if (!filterEditor.isValid()) { hint.textContent = 'Invalid filter'; return; }
      if (!updateEditor.isValid()) { hint.textContent = 'Invalid update expression'; return; }
      try {
        state.set({ loading: true, error: null });
        const res = await api.updateMany(collection, filterEditor.getParsed(), updateEditor.getParsed());
        state.set({ loading: false });
        const matched = res.result?.matched_count ?? 0;
        const modified = res.result?.modified_count ?? 0;
        showSuccessAndClose(hint, `${matched} matched, ${modified} modified`, onSuccess);
      } catch (err) {
        state.set({ loading: false });
        hint.textContent = err.message;
      }
    }
  });

  return panel;
}

// ── Replace panel ───────────────────────────────

function buildReplacePanel(onSuccess, fields, fileMode) {
  const panel = document.createElement('div');
  panel.className = 'modal-body';

  let filterEditor = null, replaceEditor = null, fileInput = null, matchFields = null;

  if (fileMode) {
    const step1 = document.createElement('div');
    step1.className = 'modal-field-label';
    step1.textContent = '1. Select a JSON file with documents:';
    panel.appendChild(step1);

    fileInput = buildFileInput();
    panel.appendChild(fileInput.el);

    const matchSection = document.createElement('div');
    matchSection.classList.add('hidden');
    const matchInfo = document.createElement('div');
    matchInfo.className = 'modal-field-label';
    matchInfo.style.marginTop = '10px';
    matchInfo.textContent = '2. Select field(s) to match existing documents:';
    matchSection.appendChild(matchInfo);
    const matchHint = document.createElement('div');
    matchHint.className = 'modal-message';
    matchHint.style.fontSize = '11px';
    matchHint.textContent = 'Each record will be matched by these fields and the entire document will be replaced.';
    matchSection.appendChild(matchHint);
    matchFields = document.createElement('div');
    matchFields.className = 'match-fields';
    matchSection.appendChild(matchFields);
    panel.appendChild(matchSection);

    fileInput.onLoad((docs) => {
      renderMatchFields(matchFields, docs);
      matchSection.classList.remove('hidden');
    });
  } else {
    const filterLabel = document.createElement('div');
    filterLabel.className = 'modal-field-label';
    filterLabel.textContent = 'Filter (match one document):';
    panel.appendChild(filterLabel);
    filterEditor = createJsonEditor({ value: '{}', minHeight: '80px', mode: 'query', fields });
    panel.appendChild(filterEditor.el);
    const replaceLabel = document.createElement('div');
    replaceLabel.className = 'modal-field-label';
    replaceLabel.style.marginTop = '8px';
    replaceLabel.textContent = 'Replacement document:';
    panel.appendChild(replaceLabel);
    replaceEditor = createJsonEditor({ value: '{\n  \n}', minHeight: '140px', fields });
    panel.appendChild(replaceEditor.el);
  }

  const { hint, submitBtn } = buildPanelActions(panel, { submitLabel: 'Replace' });

  submitBtn.addEventListener('click', async () => {
    const collection = state.get('selectedCollection');
    hint.style.color = '';

    if (fileMode) {
      let docs;
      try { docs = await fileInput.parse(); } catch (e) { hint.textContent = e.message; return; }
      if (!Array.isArray(docs)) docs = [docs];
      const keys = getSelectedMatchFields(matchFields);
      if (keys.length === 0) { hint.textContent = 'Select at least one match field'; return; }
      hint.textContent = '';
      try {
        state.set({ loading: true, error: null });
        let replaced = 0;
        for (const doc of docs) {
          const filter = {};
          for (const k of keys) filter[k] = doc[k];
          const replacement = { ...doc };
          delete replacement._id;
          await api.replaceOne(collection, filter, replacement);
          replaced++;
          hint.textContent = `Replacing... ${replaced}/${docs.length}`;
        }
        state.set({ loading: false });
        showSuccessAndClose(hint, `Replaced ${replaced} document${replaced !== 1 ? 's' : ''}`, onSuccess);
      } catch (err) {
        state.set({ loading: false });
        hint.style.color = '';
        hint.textContent = err.message;
      }
    } else {
      if (!filterEditor.isValid()) { hint.textContent = 'Invalid filter'; return; }
      if (!replaceEditor.isValid()) { hint.textContent = 'Invalid replacement document'; return; }
      try {
        state.set({ loading: true, error: null });
        await api.replaceOne(collection, filterEditor.getParsed(), replaceEditor.getParsed());
        state.set({ loading: false });
        showSuccessAndClose(hint, 'Document replaced', onSuccess);
      } catch (err) {
        state.set({ loading: false });
        hint.textContent = err.message;
      }
    }
  });

  return panel;
}

function buildFileInput() {
  const el = document.createElement('div');
  el.className = 'file-input-area';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';

  const label = document.createElement('div');
  label.className = 'file-input-label';
  label.textContent = 'Click to select a JSON file';
  label.addEventListener('click', () => input.click());

  const info = document.createElement('div');
  info.className = 'file-input-info hidden';

  el.appendChild(input);
  el.appendChild(label);
  el.appendChild(info);

  let parsedDocs = null;
  let loadCallback = null;

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) parsed = [parsed];
      parsedDocs = parsed;
      label.textContent = file.name;
      info.textContent = `${parsed.length} document${parsed.length !== 1 ? 's' : ''}`;
      info.classList.remove('hidden');
      if (loadCallback) loadCallback(parsed);
    } catch (e) {
      label.textContent = 'Error: ' + e.message;
      parsedDocs = null;
    }
  });

  return {
    el,
    parse: async () => {
      if (!parsedDocs) throw new Error('No file selected');
      return parsedDocs;
    },
    onLoad: (fn) => { loadCallback = fn; },
  };
}

function renderMatchFields(container, docs) {
  container.replaceChildren();
  if (!docs || docs.length === 0) return;

  const fields = Object.keys(docs[0]);
  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'match-field-option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = field;
    // Pre-select _id if present
    if (field === '_id') cb.checked = true;

    const name = document.createElement('span');
    name.textContent = field;

    label.appendChild(cb);
    label.appendChild(name);
    container.appendChild(label);
  }
}

function getSelectedMatchFields(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
}
