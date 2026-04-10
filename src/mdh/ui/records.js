import * as api from '../api.js';
import * as state from '../state.js';
import { confirmModal } from './modal.js';
import { openRecordEditor } from './record-editor.js';
import { openUpdateMany } from './update-many.js';
import { openDeleteMany } from './delete-many.js';
import { createJsonEditor, extractFieldNames } from './json-editor.js';
import JSON5 from 'json5';

let pipelineEditor = null;
let sortState = {};     // { "field.path": 1 | -1 }
let filterState = {};   // { "field.path": value }
let knownFields = [];
let expandedSet = new Set([0]); // indices of expanded records; default: first
let expandAll = false;
let suppressPipelineSync = false; // prevent loop when updating editor from UI
let placeholderValues = {};       // { "vendor_name": "Acme" }

function currentFields() {
  return extractFieldNames(state.get('records'));
}

export function initDataPanel() {
  render();
  state.on('selectedCollectionChanged', onCollectionChange);
  state.on('recordsChanged', onRecordsChanged);
}

function onCollectionChange(collection) {
  if (collection) {
    state.set({ skip: 0 });
    sortState = {};
    filterState = {};
    expandedSet = new Set([0]);
    expandAll = false;
    syncPipelineAndRun();
  }
}

function onRecordsChanged(records) {
  knownFields = extractFieldNames(records);
  renderRecords(records);
}

// ── Pipeline ↔ UI sync ─────────────────────────

function buildPipelineFromUI() {
  const pipeline = [];
  const match = Object.keys(filterState).length > 0 ? { ...filterState } : {};
  pipeline.push({ $match: match });
  if (Object.keys(sortState).length > 0) pipeline.push({ $sort: { ...sortState } });
  pipeline.push({ $skip: state.get('skip') });
  pipeline.push({ $limit: state.get('limit') });
  return pipeline;
}

// Update editor and run query in one shot (suppresses editor's onValidChange)
let suppressTimer = null;
function syncPipelineAndRun() {
  if (!pipelineEditor) return;
  suppressPipelineSync = true;
  pipelineEditor.setValue(JSON.stringify(buildPipelineFromUI(), null, 2));
  // Keep suppressed until after the debounced onValidChange would fire (500ms + margin)
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => { suppressPipelineSync = false; }, 600);
  runQuery();
}

// ── Sort: click key to toggle ───────────────────

function toggleSort(field) {
  if (!sortState[field]) sortState[field] = 1;
  else if (sortState[field] === 1) sortState[field] = -1;
  else delete sortState[field];
  state.set({ skip: 0 });
  syncPipelineAndRun();
}

function sortIndicator(field) {
  if (sortState[field] === 1) return ' \u2191';
  if (sortState[field] === -1) return ' \u2193';
  return '';
}

// ── Filter: click value to toggle exact match ───

function toggleFilter(field, value) {
  if (field in filterState) {
    delete filterState[field];
  } else {
    filterState[field] = value;
  }
  state.set({ skip: 0 });
  syncPipelineAndRun();
}

function isFiltered(field) {
  return field in filterState;
}

// ── Placeholders ────────────────────────────────

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function extractPlaceholders(text) {
  const names = new Set();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    names.add(match[1]);
  }
  return [...names];
}

function substitutePlaceholders(text) {
  return text.replace(PLACEHOLDER_RE, (match, name) => {
    if (name in placeholderValues && placeholderValues[name] !== '') {
      const val = placeholderValues[name];
      // If it looks like a number or boolean, don't quote it
      if (val === 'true' || val === 'false' || val === 'null' || (!isNaN(Number(val)) && val !== '')) {
        return val;
      }
      return val;
    }
    return match;
  });
}

function renderPlaceholderInputs() {
  const container = document.getElementById('placeholderInputs');
  if (!container) return;

  const text = pipelineEditor ? pipelineEditor.getValue() : '';
  const names = extractPlaceholders(text);

  if (names.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');

  const newKey = names.join(',');
  if (container.dataset.names === newKey) return;
  container.dataset.names = newKey;
  container.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'placeholder-label';
  label.textContent = 'Variables:';
  container.appendChild(label);

  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'placeholder-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'placeholder-name';
    nameEl.textContent = `{${name}}`;

    const input = document.createElement('input');
    input.className = 'input placeholder-input';
    input.placeholder = name;
    input.value = placeholderValues[name] || '';

    let debounce = null;
    input.addEventListener('input', () => {
      placeholderValues[name] = input.value;
      clearTimeout(debounce);
      debounce = setTimeout(runQuery, 400);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounce);
        placeholderValues[name] = input.value;
        runQuery();
      }
    });

    row.appendChild(nameEl);
    row.appendChild(input);
    container.appendChild(row);
  }
}

// ── Query execution ─────────────────────────────

async function runQuery() {
  const collection = state.get('selectedCollection');
  if (!collection) return;
  if (!pipelineEditor) return;

  const rawText = pipelineEditor.getValue();
  const resolvedText = substitutePlaceholders(rawText);

  // Check if there are unresolved placeholders
  if (PLACEHOLDER_RE.test(resolvedText)) return;

  let pipeline;
  try {
    pipeline = JSON5.parse(resolvedText);
    if (!Array.isArray(pipeline)) return;
  } catch {
    return;
  }

  try {
    state.set({ loading: true, error: null });
    const start = performance.now();
    const res = await api.aggregate(collection, pipeline);
    const elapsed = Math.round(performance.now() - start);
    state.set({ records: res.result || [], loading: false });
    const countEl = document.getElementById('recordCount');
    if (countEl) {
      const count = (res.result || []).length;
      const skip = state.get('skip');
      countEl.textContent = count > 0
        ? `Showing ${skip + 1}\u2013${skip + count} \u00b7 ${elapsed}ms`
        : `No records \u00b7 ${elapsed}ms`;
    }
  } catch (err) {
    state.set({ error: { message: err.message }, loading: false });
  }
}

// ── Download collection ─────────────────────────

let downloadCancelled = false;

async function downloadCollection() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  const btn = document.getElementById('recordDownloadBtn');
  const originalText = btn.textContent;
  downloadCancelled = false;

  // Switch button to cancel mode
  btn.textContent = 'Cancel';
  btn.className = btn.className.replace('btn-sm', 'btn-sm btn-danger');
  const onCancel = () => { downloadCancelled = true; };
  btn.removeEventListener('click', downloadCollection);
  btn.addEventListener('click', onCancel);

  const BATCH = 500;
  const allDocs = [];
  let skip = 0;

  try {
    state.set({ error: null });

    while (true) {
      if (downloadCancelled) {
        btn.textContent = 'Cancelled';
        setTimeout(resetBtn, 1500);
        return;
      }
      const res = await api.aggregate(collection, [
        { $match: {} },
        { $skip: skip },
        { $limit: BATCH },
      ]);
      if (downloadCancelled) {
        btn.textContent = 'Cancelled';
        setTimeout(resetBtn, 1500);
        return;
      }
      const batch = res.result || [];
      allDocs.push(...batch);
      btn.textContent = `Cancel (${allDocs.length})`;
      if (batch.length < BATCH) break;
      skip += BATCH;
    }

    const json = JSON.stringify(allDocs, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${collection}.json`;
    a.click();
    URL.revokeObjectURL(url);

    btn.textContent = `\u2713 ${allDocs.length} records`;
    setTimeout(resetBtn, 2000);
  } catch (err) {
    if (!downloadCancelled) {
      state.set({ error: { message: `Download failed: ${err.message}` } });
    }
    resetBtn();
  }

  function resetBtn() {
    btn.textContent = originalText;
    btn.className = btn.className.replace(' btn-danger', '');
    btn.removeEventListener('click', onCancel);
    btn.addEventListener('click', downloadCollection);
  }
}

// ── Render ──────────────────────────────────────

function render() {
  const panel = document.getElementById('panel-data');
  panel.innerHTML = '';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'row';

  // Left: pipeline editor
  const left = document.createElement('div');
  left.className = 'data-panel-left';

  const editorLabel = document.createElement('div');
  editorLabel.className = 'split-pane-label';
  editorLabel.textContent = 'Aggregate Pipeline:';
  left.appendChild(editorLabel);

  const fieldsFn = () => extractFieldNames(state.get('records'));
  pipelineEditor = createJsonEditor({
    value: JSON.stringify(buildPipelineFromUI(), null, 2),
    minHeight: '100px',
    mode: 'aggregate',
    fields: fieldsFn,
    onChange: () => {
      renderPlaceholderInputs();
      if (!suppressPipelineSync) {
        // User edited the pipeline directly — clear UI-driven state
        // so highlights don't get out of sync
        filterState = {};
        sortState = {};
      }
    },
    onValidChange: () => {
      if (!suppressPipelineSync) runQuery();
    },
  });
  left.appendChild(pipelineEditor.el);

  const placeholderContainer = document.createElement('div');
  placeholderContainer.id = 'placeholderInputs';
  placeholderContainer.className = 'placeholder-container hidden';
  left.appendChild(placeholderContainer);

  panel.appendChild(left);

  // Resizer between left and right
  const resizer = document.createElement('div');
  resizer.className = 'data-panel-resizer';
  panel.appendChild(resizer);
  initPanelResize(resizer, left);

  // Right: records view
  const right = document.createElement('div');
  right.className = 'data-panel-right';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  // Left group: view controls
  const viewGroup = document.createElement('div');
  viewGroup.className = 'toolbar-group';

  const resetBtn = document.createElement('button');
  resetBtn.id = 'recordResetBtn';
  resetBtn.className = 'btn btn-sm';
  resetBtn.title = 'Reset query to default';
  resetBtn.textContent = 'Reset';

  const expandBtn = document.createElement('button');
  expandBtn.id = 'recordExpandAllBtn';
  expandBtn.className = 'btn btn-sm';
  expandBtn.textContent = 'Expand All';

  viewGroup.appendChild(resetBtn);
  viewGroup.appendChild(expandBtn);
  toolbar.appendChild(viewGroup);

  // Spacer
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  toolbar.appendChild(spacer);

  // Right group: data actions
  const dataGroup = document.createElement('div');
  dataGroup.className = 'toolbar-group';

  const downloadBtn = document.createElement('button');
  downloadBtn.id = 'recordDownloadBtn';
  downloadBtn.className = 'btn btn-sm';
  downloadBtn.title = 'Download entire collection as JSON';
  downloadBtn.textContent = 'Download';
  dataGroup.appendChild(downloadBtn);

  const insertBtn = document.createElement('button');
  insertBtn.id = 'recordInsertBtn';
  insertBtn.className = 'btn btn-success btn-sm';
  insertBtn.textContent = '+ Insert';
  dataGroup.appendChild(insertBtn);

  // Overflow menu
  const moreWrap = document.createElement('div');
  moreWrap.className = 'toolbar-more-wrap';

  const moreBtn = document.createElement('button');
  moreBtn.className = 'btn btn-sm toolbar-more-btn';
  moreBtn.title = 'More actions';
  moreBtn.innerHTML = '\u22EF';

  const moreMenu = document.createElement('div');
  moreMenu.className = 'toolbar-more-menu hidden';

  for (const [id, cls, text] of [
    ['recordImportBtn', '', 'Insert from JSON file'],
    ['recordUpdateManyBtn', '', 'Update Many'],
    ['recordDeleteManyBtn', 'toolbar-menu-danger', 'Delete Many'],
  ]) {
    const item = document.createElement('button');
    item.id = id;
    item.className = 'toolbar-menu-item ' + cls;
    item.textContent = text;
    item.addEventListener('click', () => moreMenu.classList.add('hidden'));
    moreMenu.appendChild(item);
  }

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => moreMenu.classList.add('hidden'));

  moreWrap.appendChild(moreBtn);
  moreWrap.appendChild(moreMenu);
  dataGroup.appendChild(moreWrap);
  toolbar.appendChild(dataGroup);

  const importFile = document.createElement('input');
  importFile.id = 'recordImportFile';
  importFile.type = 'file';
  importFile.accept = '.json';
  importFile.style.display = 'none';
  toolbar.appendChild(importFile);

  right.appendChild(toolbar);

  // Record list
  const listDiv = document.createElement('div');
  listDiv.id = 'recordList';
  listDiv.className = 'record-list';
  right.appendChild(listDiv);

  // Pagination
  const pagination = document.createElement('div');
  pagination.id = 'recordPagination';
  pagination.className = 'pagination';
  pagination.innerHTML = `
    <span id="recordCount"></span>
    <span class="pagination-hint">Click key to sort \u00b7 Click value to filter</span>
    <div class="pagination-controls">
      <button id="recordPrev" disabled>&larr; Prev</button>
      <span id="recordPage">Page 1</span>
      <button id="recordNext">Next &rarr;</button>
    </div>
  `;
  right.appendChild(pagination);

  panel.appendChild(right);

  // Wire up buttons
  right.querySelector('#recordResetBtn').addEventListener('click', () => {
    sortState = {};
    filterState = {};
    placeholderValues = {};
    expandedSet = new Set([0]);
    expandAll = false;
    state.set({ skip: 0 });
    syncPipelineAndRun();
  });
  right.querySelector('#recordExpandAllBtn').addEventListener('click', toggleExpandAll);
  right.querySelector('#recordInsertBtn').addEventListener('click', () => {
    openRecordEditor('insert', null, () => runQuery(), currentFields);
  });

  const importFileInput = right.querySelector('#recordImportFile');
  right.querySelector('#recordImportBtn').addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
  });
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) parsed = [parsed];
      if (parsed.length === 0) {
        state.set({ error: { message: 'File contains no documents' } });
        return;
      }
      state.set({ loading: true, error: null });
      if (parsed.length === 1) {
        await api.insertOne(state.get('selectedCollection'), parsed[0]);
      } else {
        await api.insertMany(state.get('selectedCollection'), parsed);
      }
      state.set({ loading: false });
      runQuery();
    } catch (err) {
      state.set({ error: { message: `Import failed: ${err.message}` }, loading: false });
    }
  });

  right.querySelector('#recordDownloadBtn').addEventListener('click', downloadCollection);

  right.querySelector('#recordUpdateManyBtn').addEventListener('click', () => {
    openUpdateMany(() => runQuery(), currentFields);
  });
  right.querySelector('#recordDeleteManyBtn').addEventListener('click', () => {
    openDeleteMany(() => runQuery(), currentFields);
  });
  right.querySelector('#recordPrev').addEventListener('click', () => {
    const skip = Math.max(0, state.get('skip') - state.get('limit'));
    state.set({ skip });
    syncPipelineAndRun();
  });
  right.querySelector('#recordNext').addEventListener('click', () => {
    state.set({ skip: state.get('skip') + state.get('limit') });
    syncPipelineAndRun();
  });
}

function initPanelResize(resizer, leftPane) {
  let startX, startWidth;
  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = leftPane.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function onMove(e) {
      const w = Math.max(200, Math.min(800, startWidth + e.clientX - startX));
      leftPane.style.width = w + 'px';
      leftPane.style.flexBasis = w + 'px';
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      pipelineEditor.refresh();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── MongoDB Extended JSON (EJSON) ────────────────

// Recognizes MongoDB EJSON wrapper objects like {"$oid": "..."}, {"$date": "..."}
const EJSON_TYPES = {
  $oid: { label: 'ObjectId', css: 'json-tree-value-oid' },
  $date: { label: 'Date', css: 'json-tree-value-date' },
  $numberLong: { label: 'Long', css: 'json-tree-value-number' },
  $numberInt: { label: 'Int', css: 'json-tree-value-number' },
  $numberDouble: { label: 'Double', css: 'json-tree-value-number' },
  $numberDecimal: { label: 'Decimal', css: 'json-tree-value-number' },
  $binary: { label: 'Binary', css: 'json-tree-value-null' },
  $regex: { label: 'Regex', css: 'json-tree-value-string' },
  $timestamp: { label: 'Timestamp', css: 'json-tree-value-date' },
};

function getEjsonType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] in EJSON_TYPES) return keys[0];
  if (keys.length === 2 && keys.includes('$date')) return '$date';
  return null;
}

function formatEjsonValue(value, typeKey) {
  const inner = value[typeKey];
  if (typeKey === '$oid') return String(inner);
  if (typeKey === '$date') {
    const d = typeof inner === 'string' ? inner : inner?.$numberLong || String(inner);
    try { return new Date(typeof d === 'string' && /^\d+$/.test(d) ? Number(d) : d).toISOString(); }
    catch { return String(d); }
  }
  if (typeKey === '$regex') return `/${inner}/${value.$options || ''}`;
  return String(inner);
}

function displayValue(v) {
  if (v === null) return 'null';
  const ejson = getEjsonType(v);
  if (ejson) {
    const formatted = formatEjsonValue(v, ejson);
    return formatted.length > 24 ? formatted.slice(0, 24) + '...' : formatted;
  }
  if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 20)}..."` : `"${v}"`;
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{...}';
  return String(v);
}

// ── Record list ─────────────────────────────────

function recordSummary(record) {
  const keys = Object.keys(record);
  const parts = keys.slice(0, 4).map((k) => `${k}: ${displayValue(record[k])}`);
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  return parts.join(' \u00b7 ');
}

function renderRecords(records) {
  const listEl = document.getElementById('recordList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'record-list-empty';
    const skip = state.get('skip');

    // Check if the pipeline has any non-trivial stages (filters, projections, etc.)
    let hasNonTrivialPipeline = Object.keys(filterState).length > 0 || Object.keys(sortState).length > 0;
    if (!hasNonTrivialPipeline && pipelineEditor) {
      try {
        const pipeline = JSON5.parse(pipelineEditor.getValue());
        if (Array.isArray(pipeline)) {
          hasNonTrivialPipeline = pipeline.some((stage) => {
            if (stage.$match && Object.keys(stage.$match).length > 0) return true;
            if (stage.$project || stage.$group || stage.$unwind || stage.$lookup) return true;
            return false;
          });
        }
      } catch { /* ignore parse errors */ }
    }

    if (skip > 0) {
      empty.innerHTML = '<p>No more records on this page</p><p class="record-list-empty-hint">Try going back to the previous page</p>';
    } else if (hasNonTrivialPipeline) {
      empty.innerHTML = '<p>No records match the current query</p><p class="record-list-empty-hint">Try modifying the pipeline or click Reset to start over</p>';
    } else {
      empty.innerHTML = '<p>This collection is empty</p><p class="record-list-empty-hint">Insert records using the + Insert button or import a JSON file</p>';
    }
    listEl.appendChild(empty);
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const isExpanded = expandAll || expandedSet.has(i);

    const card = document.createElement('div');
    card.className = 'record-card' + (isExpanded ? ' record-card-expanded' : '');

    // Header row (always visible)
    const header = document.createElement('div');
    header.className = 'record-card-header';

    const chevron = document.createElement('span');
    chevron.className = 'record-chevron';
    chevron.textContent = isExpanded ? '\u25BC' : '\u25B6';

    const summary = document.createElement('span');
    summary.className = 'record-summary';
    summary.textContent = recordSummary(record);

    const actions = document.createElement('span');
    actions.className = 'record-actions';
    actions.innerHTML = `
      <button class="action-copy" title="Copy record as JSON">Copy</button>
      <button class="action-edit" title="Edit with update expression">Edit</button>
      <button class="action-replace" title="Replace entire document">Replace</button>
      <button class="action-delete" title="Delete this record">Del</button>
    `;

    header.appendChild(chevron);
    header.appendChild(summary);
    header.appendChild(actions);
    card.appendChild(header);

    // Body (expanded content)
    if (isExpanded) {
      const body = document.createElement('div');
      body.className = 'record-card-body';
      body.appendChild(renderInteractiveJson(record, ''));
      card.appendChild(body);
    }

    // Toggle expand on header click
    const idx = i;
    header.addEventListener('click', (e) => {
      if (e.target.closest('.record-actions')) return;
      if (expandedSet.has(idx)) {
        expandedSet.delete(idx);
      } else {
        expandedSet.add(idx);
      }
      expandAll = false;
      renderRecords(state.get('records'));
    });

    // Action buttons
    actions.querySelector('.action-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
        const btn = actions.querySelector('.action-copy');
        btn.textContent = '\u2713 Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1000);
      });
    });
    actions.querySelector('.action-edit').addEventListener('click', () => {
      openRecordEditor('edit', record, () => runQuery(), currentFields);
    });
    actions.querySelector('.action-replace').addEventListener('click', () => {
      openRecordEditor('replace', record, () => runQuery(), currentFields);
    });
    actions.querySelector('.action-delete').addEventListener('click', () => {
      const deleteId = record._id?.$oid || record._id || '?';
      confirmModal(
        'Delete record?',
        `Delete record with _id "${deleteId}"? This cannot be undone.`,
        async () => {
          try {
            state.set({ loading: true, error: null });
            await api.deleteOne(state.get('selectedCollection'), { _id: record._id });
            expandedSet.delete(idx);
            await runQuery();
          } catch (err) {
            state.set({ error: { message: err.message }, loading: false });
          }
        },
      );
    });

    listEl.appendChild(card);
  }

  // Pagination
  const skip = state.get('skip');
  const limit = state.get('limit');
  const count = records.length;
  document.getElementById('recordCount').textContent = count > 0
    ? `Showing ${skip + 1}\u2013${skip + count}` : 'No records';
  document.getElementById('recordPage').textContent = `Page ${Math.floor(skip / limit) + 1}`;
  document.getElementById('recordPrev').disabled = skip === 0;
  document.getElementById('recordNext').disabled = count < limit;

  updateExpandAllButton();
}

// ── Interactive JSON tree ───────────────────────

function renderInteractiveJson(obj, prefix) {
  const container = document.createElement('div');
  container.className = 'json-tree';

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const row = document.createElement('div');
    row.className = 'json-tree-row';

    const keyEl = document.createElement('button');
    keyEl.className = 'json-tree-key';
    if (sortState[fullPath] === 1) keyEl.classList.add('json-tree-key-asc');
    else if (sortState[fullPath] === -1) keyEl.classList.add('json-tree-key-desc');
    keyEl.textContent = key + sortIndicator(fullPath);
    const sortDir = sortState[fullPath];
    keyEl.title = sortDir === 1 ? `Sorted ascending \u2014 click to sort descending`
      : sortDir === -1 ? `Sorted descending \u2014 click to remove sort`
      : `Click to sort by ${fullPath}`;
    keyEl.addEventListener('click', (e) => { e.stopPropagation(); toggleSort(fullPath); });

    const sep = document.createElement('span');
    sep.className = 'json-tree-sep';
    sep.textContent = ': ';

    row.appendChild(keyEl);
    row.appendChild(sep);

    const ejsonType = getEjsonType(value);

    if (ejsonType) {
      // EJSON type — render as a leaf with a type badge
      const formatted = formatEjsonValue(value, ejsonType);
      const info = EJSON_TYPES[ejsonType];

      const badge = document.createElement('span');
      badge.className = 'json-tree-badge';
      badge.textContent = info.label;

      const valEl = document.createElement('button');
      valEl.className = 'json-tree-value json-tree-value-clickable ' + info.css;
      if (isFiltered(fullPath)) valEl.classList.add('json-tree-value-filtered');
      valEl.textContent = formatted;
      valEl.title = isFiltered(fullPath)
        ? `Filtering by ${fullPath} \u2014 click to remove filter`
        : `Click to filter: ${fullPath} = ${formatted}`;
      valEl.addEventListener('click', (e) => { e.stopPropagation(); toggleFilter(fullPath, value); });

      row.appendChild(badge);
      row.appendChild(valEl);
      container.appendChild(row);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const toggle = document.createElement('span');
      toggle.className = 'json-tree-toggle';
      toggle.textContent = '\u25BC';
      toggle.style.cursor = 'pointer';
      row.appendChild(toggle);
      container.appendChild(row);

      const nested = renderInteractiveJson(value, fullPath);
      nested.classList.add('json-tree-nested');
      container.appendChild(nested);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        nested.classList.toggle('hidden');
        toggle.textContent = nested.classList.contains('hidden') ? '\u25B6 {...}' : '\u25BC';
      });
    } else if (Array.isArray(value)) {
      const toggle = document.createElement('span');
      toggle.className = 'json-tree-toggle';
      toggle.textContent = `\u25BC [${value.length}]`;
      toggle.style.cursor = 'pointer';
      row.appendChild(toggle);
      container.appendChild(row);

      const nested = document.createElement('div');
      nested.className = 'json-tree-nested';
      for (let ai = 0; ai < value.length; ai++) {
        const item = value[ai];
        const itemPath = `${fullPath}.${ai}`;
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const sub = renderInteractiveJson(item, itemPath);
          const wrapper = document.createElement('div');
          wrapper.className = 'json-tree-array-item';
          const idx = document.createElement('span');
          idx.className = 'json-tree-array-index';
          idx.textContent = `[${ai}]`;
          wrapper.appendChild(idx);
          wrapper.appendChild(sub);
          nested.appendChild(wrapper);
        } else {
          const itemRow = document.createElement('div');
          itemRow.className = 'json-tree-row';
          const idxEl = document.createElement('span');
          idxEl.className = 'json-tree-array-index';
          idxEl.textContent = `[${ai}]`;
          const valEl = document.createElement('span');
          valEl.className = 'json-tree-value';
          valEl.textContent = JSON.stringify(item);
          itemRow.appendChild(idxEl);
          itemRow.appendChild(valEl);
          nested.appendChild(itemRow);
        }
      }
      container.appendChild(nested);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        nested.classList.toggle('hidden');
        toggle.textContent = nested.classList.contains('hidden') ? `\u25B6 [${value.length}]` : `\u25BC [${value.length}]`;
      });
    } else {
      const valEl = document.createElement('button');
      valEl.className = 'json-tree-value json-tree-value-clickable';
      if (typeof value === 'string') valEl.classList.add('json-tree-value-string');
      else if (typeof value === 'number') valEl.classList.add('json-tree-value-number');
      else if (typeof value === 'boolean') valEl.classList.add('json-tree-value-bool');
      else if (value === null) valEl.classList.add('json-tree-value-null');
      if (isFiltered(fullPath)) valEl.classList.add('json-tree-value-filtered');

      valEl.textContent = value === null ? 'null'
        : typeof value === 'string' ? `"${value}"` : String(value);
      valEl.title = isFiltered(fullPath)
        ? `Filtering by ${fullPath} \u2014 click to remove filter`
        : `Click to filter: ${fullPath} = ${JSON.stringify(value)}`;
      valEl.addEventListener('click', (e) => { e.stopPropagation(); toggleFilter(fullPath, value); });
      row.appendChild(valEl);
      container.appendChild(row);
    }
  }

  return container;
}

function toggleExpandAll() {
  const records = state.get('records');
  const allExpanded = expandAll || expandedSet.size >= records.length;
  if (allExpanded) {
    expandedSet.clear();
    expandAll = false;
  } else {
    expandAll = true;
    expandedSet.clear();
  }
  renderRecords(records);
}

function updateExpandAllButton() {
  const btn = document.getElementById('recordExpandAllBtn');
  if (!btn) return;
  const records = state.get('records');
  const allExpanded = expandAll || (records.length > 0 && expandedSet.size >= records.length);
  btn.textContent = allExpanded ? 'Collapse All' : 'Expand All';
}

