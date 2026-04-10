import * as api from '../api.js';
import * as state from '../state.js';
import * as cache from '../cache.js';
import { openRecordEditor, openDataOperations } from './record-editor.js';
import { confirmModal, openModal } from './modal.js';
import { addToHistory, saveQuery, unsaveQuery, isSaved, renderHistoryPanel, renderSavedPanel } from './query-history.js';

import { createJsonEditor, extractFieldNames } from './json-editor.js';
import JSON5 from 'json5';

let pipelineEditor = null;
let sortState = {};     // { "field.path": 1 | -1 }
let filterState = {};   // { "field.path": value }
let knownFields = [];
let expandedSet = new Set([0]); // indices of expanded records; default: first
let expandAll = false;
let lastQueryMs = 0;
let suppressPipelineSync = false; // prevent loop when updating editor from UI
let placeholderValues = {};       // { "vendor_name": "Acme" }
let cacheNextQuery = false;
let queryId = 0;  // monotonic counter for stale query detection
let splitMenuDelegationRegistered = false;

function currentFields() {
  return extractFieldNames(state.get('records'));
}

export function loadPipeline(pipeline, collection, variables) {
  if (variables) placeholderValues = { ...variables };

  const current = state.get('selectedCollection');
  if (collection && collection !== current) {
    state.set({ selectedCollection: collection, records: [], skip: 0, error: null });
    setTimeout(() => {
      if (pipelineEditor) {
        suppressPipelineSync = true;
        pipelineEditor.setValue(pipeline);
        setTimeout(() => {
          suppressPipelineSync = false;
          renderPlaceholderInputs();
          runQuery();
        }, 100);
      }
    }, 50);
  } else if (pipelineEditor) {
    suppressPipelineSync = true;
    pipelineEditor.setValue(pipeline);
    setTimeout(() => {
      suppressPipelineSync = false;
      renderPlaceholderInputs();
      runQuery();
    }, 100);
  }
}

function loadFromPanel(pipeline, collection, variables) {
  loadPipeline(pipeline, collection, variables);
}

function openQueryPanel(e, panelEl) {
  document.querySelector('.query-history-panel')?.remove();
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  panelEl.style.position = 'fixed';
  panelEl.style.top = rect.bottom + 4 + 'px';
  panelEl.style.left = rect.left + 'px';
  document.body.appendChild(panelEl);
  const close = (ev) => {
    if (!panelEl.contains(ev.target) && ev.target !== btn) {
      panelEl.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

export function initDataPanel() {
  render();
  state.on('selectedCollectionChanged', onCollectionChange);
  state.on('recordsChanged', onRecordsChanged);
  state.on('activePanelChanged', (panel) => {
    if (panel === 'data') {
      // Force placeholder re-render when returning to data tab
      const container = document.getElementById('placeholderInputs');
      if (container) container.dataset.key = '';
      renderPlaceholderInputs();
    }
  });
}

let totalCount = null;

function onCollectionChange(collection) {
  if (collection) {
    state.set({ skip: 0 });
    sortState = {};
    filterState = {};
    expandedSet = new Set([0]);
    expandAll = false;

    const cachedCount = cache.get(collection, 'totalCount');
    if (cachedCount !== null) {
      totalCount = cachedCount;
    } else {
      totalCount = null;
      fetchTotalCount(collection);
    }

    const cachedRecords = cache.get(collection, 'records');
    if (cachedRecords !== null) {
      syncPipeline();
      state.set({ records: cachedRecords });
      debugPipeline();
    } else {
      cacheNextQuery = true;
      syncPipelineAndRun();
    }
  }
}

async function fetchTotalCount(collection) {
  try {
    const res = await api.aggregate(collection, [{ $count: 'total' }]);
    const count = res.result?.[0]?.total ?? 0;
    totalCount = count;
    cache.set(collection, 'totalCount', count);
    // Re-render so the "out of N" text appears even if records rendered first
    if (state.get('selectedCollection') === collection) {
      renderRecords(state.get('records'));
    }
  } catch { /* ignore */ }
}

function invalidateRecordCache() {
  const col = state.get('selectedCollection');
  if (col) {
    cache.invalidate(col, 'records');
    cache.invalidate(col, 'totalCount');
  }
}

export async function prefetchRecords(collection) {
  if (cache.get(collection, 'records') !== null) return;
  try {
    const res = await api.aggregate(collection, [
      { $match: {} },
      { $skip: 0 },
      { $limit: state.get('limit') },
    ]);
    cache.set(collection, 'records', res.result || []);
  } catch { /* silent */ }
}

export async function prefetchTotalCount(collection) {
  if (cache.get(collection, 'totalCount') !== null) return;
  try {
    const res = await api.aggregate(collection, [{ $count: 'total' }]);
    cache.set(collection, 'totalCount', res.result?.[0]?.total ?? 0);
  } catch { /* silent */ }
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

// Update editor value from UI state (suppresses editor's onValidChange)
let suppressTimer = null;
function syncPipeline() {
  if (!pipelineEditor) return;
  suppressPipelineSync = true;
  pipelineEditor.setValue(JSON.stringify(buildPipelineFromUI(), null, 2));
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => { suppressPipelineSync = false; }, 600);
}

function syncPipelineAndRun() {
  syncPipeline();
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
    if (!(name in placeholderValues)) return match;
    const val = placeholderValues[name];
    if (val === 'true' || val === 'false' || val === 'null') return val;
    if (val !== '' && !isNaN(Number(val))) return val;
    return val;
  });
}

function parseAnnotationId(input) {
  // Plain number
  if (/^\d+$/.test(input)) return input;
  // URL like https://....rossum.ai/.../annotations/12345 or /api/v1/annotations/12345
  const urlMatch = input.match(/annotations\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  return null;
}

async function fetchAnnotationFields(annotId) {
  const domain = state.get('domain');
  const token = state.get('token');
  const res = await fetch(`${domain}/api/v1/annotations/${annotId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const fields = {};
  extractDatapoints(data.results || data.content || [], fields);
  return fields;
}

function extractDatapoints(nodes, fields) {
  for (const node of nodes) {
    if (node.schema_id && node.content && node.content.value != null && node.content.value !== '') {
      fields[node.schema_id] = String(node.content.value);
    }
    if (node.children) extractDatapoints(node.children, fields);
  }
}

function renderPlaceholderInputs() {
  const container = document.getElementById('placeholderInputs');
  if (!container) return;

  const text = pipelineEditor ? pipelineEditor.getValue() : '';
  const names = extractPlaceholders(text);

  if (names.length === 0) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }

  container.classList.remove('hidden');

  const valuesKey = names.map((n) => placeholderValues[n] || '').join(',');
  const newKey = names.join(',') + '::' + valuesKey;
  if (container.dataset.key === newKey) return;
  container.dataset.key = newKey;
  container.replaceChildren();

  const header = document.createElement('div');
  header.className = 'placeholder-header';

  const label = document.createElement('div');
  label.className = 'placeholder-label';
  label.textContent = 'Variables:';
  header.appendChild(label);

  const annotBtn = document.createElement('button');
  annotBtn.className = 'placeholder-annotation-btn';
  annotBtn.textContent = 'Fill from Annotation';
  annotBtn.title = 'Paste an annotation ID or URL to populate variables from annotation data';
  annotBtn.addEventListener('click', () => {
    const existing = container.querySelector('.placeholder-annotation-row');
    if (existing) { existing.remove(); return; }
    const row = document.createElement('div');
    row.className = 'placeholder-annotation-row';
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = 'Annotation ID or URL\u2026';
    input.style.flex = '1';
    const status = document.createElement('span');
    status.className = 'placeholder-annotation-status';
    row.appendChild(input);
    row.appendChild(status);
    container.insertBefore(row, header.nextSibling);
    input.focus();

    async function load() {
      const val = input.value.trim();
      if (!val) return;
      const annotId = parseAnnotationId(val);
      if (!annotId) { status.textContent = 'Invalid ID'; return; }
      status.textContent = 'Loading\u2026';
      try {
        const fields = await fetchAnnotationFields(annotId);
        let filled = 0;
        for (const name of names) {
          if (name in fields) {
            placeholderValues[name] = fields[name];
            filled++;
          }
        }
        status.textContent = filled > 0 ? `${filled} filled` : 'No matches';
        // Force re-render with new values
        container.dataset.key = '';
        renderPlaceholderInputs();
        if (filled > 0) runQuery();
      } catch (err) {
        status.textContent = err.message.length > 30 ? err.message.slice(0, 30) + '\u2026' : err.message;
      }
    }

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    input.addEventListener('paste', () => setTimeout(load, 0));
  });
  header.appendChild(annotBtn);
  container.appendChild(header);

  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'placeholder-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'placeholder-name';
    nameEl.textContent = `{${name}}`;

    const input = document.createElement('input');
    input.className = 'input placeholder-input';
    if (!(name in placeholderValues)) placeholderValues[name] = '';
    input.value = placeholderValues[name];

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
  if (/\{\w+\}/.test(resolvedText)) return;

  let pipeline;
  try {
    pipeline = JSON5.parse(resolvedText);
    if (!Array.isArray(pipeline)) return;
  } catch {
    return;
  }

  const thisQueryId = ++queryId;

  try {
    state.set({ loading: true, error: null });
    const start = performance.now();
    const res = await api.aggregate(collection, pipeline);
    if (thisQueryId !== queryId) return; // stale — a newer query superseded this one
    const elapsed = Math.round(performance.now() - start);
    lastQueryMs = elapsed;
    const records = res.result || [];
    if (cacheNextQuery) {
      cache.set(collection, 'records', records);
      cacheNextQuery = false;
    }
    state.set({ records, loading: false });
    addToHistory(collection, rawText, { ...placeholderValues });
    debugPipeline();
  } catch (err) {
    if (thisQueryId !== queryId) return;
    cacheNextQuery = false;
    state.set({ error: { message: err.message }, loading: false });
  }
}

// ── Pipeline debug ──────────────────────────────

const DEBUG_PREVIEW_LIMIT = 5;

function attachStageTooltip(row, stage) {
  let tip = null;
  let hideTimer = null;

  row.addEventListener('mouseenter', (e) => {
    clearTimeout(hideTimer);
    if (tip) return;
    tip = document.createElement('div');
    tip.className = 'pipeline-debug-tooltip';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(stage, null, 2);
    tip.appendChild(pre);
    document.body.appendChild(tip);

    const rect = row.getBoundingClientRect();
    tip.style.top = rect.top + 'px';
    tip.style.left = rect.right + 8 + 'px';

    // If tooltip goes off-screen right, flip to left
    const tipRect = tip.getBoundingClientRect();
    if (tipRect.right > window.innerWidth - 8) {
      tip.style.left = '';
      tip.style.right = (window.innerWidth - rect.left + 8) + 'px';
    }
    // If goes off bottom, shift up
    if (tipRect.bottom > window.innerHeight - 8) {
      tip.style.top = Math.max(8, window.innerHeight - tipRect.height - 8) + 'px';
    }
  });

  row.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(() => {
      if (tip) { tip.remove(); tip = null; }
    }, 150);
  });
}

async function debugPipeline() {
  const collection = state.get('selectedCollection');
  if (!collection || !pipelineEditor) return;

  const rawText = pipelineEditor.getValue();
  const resolvedText = substitutePlaceholders(rawText);

  let pipeline;
  try {
    pipeline = JSON5.parse(resolvedText);
    if (!Array.isArray(pipeline) || pipeline.length === 0) return;
  } catch { return; }

  const container = document.getElementById('pipelineDebug');
  if (!container) return;
  container.replaceChildren();

  const title = document.createElement('div');
  title.className = 'placeholder-label';
  title.textContent = 'Aggregation Pipeline Debug';
  container.appendChild(title);

  // Total row showing starting document count
  const totalRow = document.createElement('div');
  totalRow.className = 'pipeline-debug-row pipeline-debug-total';
  const totalLabel = document.createElement('span');
  totalLabel.className = 'pipeline-debug-stage';
  totalLabel.textContent = 'collection';
  const totalArrow = document.createElement('span');
  totalArrow.className = 'pipeline-debug-arrow';
  totalArrow.textContent = '\u2192';
  const totalCountEl = document.createElement('span');
  totalCountEl.className = 'pipeline-debug-count';
  totalCountEl.textContent = totalCount !== null ? `${totalCount.toLocaleString()} docs` : '\u2026';
  totalRow.appendChild(totalLabel);
  totalRow.appendChild(totalArrow);
  totalRow.appendChild(totalCountEl);
  container.appendChild(totalRow);

  // Fetch total if not available
  if (totalCount === null) {
    fetchTotalCount(collection).then(() => {
      if (totalCount !== null) totalCountEl.textContent = `${totalCount.toLocaleString()} docs`;
    });
  }

  const rows = [];
  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    const stageKey = Object.keys(stage)[0] || '?';
    const stageStr = JSON.stringify(stage);
    const preview = stageStr.length > 50 ? stageStr.slice(0, 50) + '\u2026' : stageStr;

    const row = document.createElement('div');
    row.className = 'pipeline-debug-row';

    const num = document.createElement('span');
    num.className = 'pipeline-debug-num';
    num.textContent = `${i + 1}.`;

    const stageLabel = document.createElement('span');
    stageLabel.className = 'pipeline-debug-stage';
    stageLabel.textContent = stageKey;

    const previewEl = document.createElement('span');
    previewEl.className = 'pipeline-debug-preview';
    previewEl.textContent = preview;
    attachStageTooltip(row, stage);

    const arrow = document.createElement('span');
    arrow.className = 'pipeline-debug-arrow';
    arrow.textContent = '\u2192';

    const countEl = document.createElement('span');
    countEl.className = 'pipeline-debug-count';
    countEl.textContent = '\u2026';

    row.appendChild(num);
    row.appendChild(stageLabel);
    row.appendChild(previewEl);
    row.appendChild(arrow);
    row.appendChild(countEl);

    // Click to inspect first N records after this stage
    const stageIndex = i;
    row.addEventListener('click', () => inspectStage(collection, pipeline, stageIndex, stageKey));

    container.appendChild(row);
    rows.push({ index: i, countEl });
  }

  // Run counts in parallel
  await Promise.allSettled(rows.map(async ({ index, countEl }) => {
    const prefix = pipeline.slice(0, index + 1);
    try {
      const res = await api.aggregate(collection, [...prefix, { $count: 'n' }]);
      const n = res.result?.[0]?.n ?? 0;
      countEl.textContent = `${n.toLocaleString()} docs`;
      countEl.className = 'pipeline-debug-count' + (n === 0 ? ' pipeline-debug-zero' : '');
    } catch (err) {
      countEl.textContent = 'error';
      countEl.className = 'pipeline-debug-count pipeline-debug-error';
      countEl.title = err.message;
    }
  }));
}

async function inspectStage(collection, pipeline, stageIndex, stageKey) {
  const prefix = pipeline.slice(0, stageIndex + 1);

  const body = document.createElement('div');
  body.className = 'modal-body';

  const info = document.createElement('div');
  info.className = 'pipeline-inspect-info';
  info.textContent = `Showing first ${DEBUG_PREVIEW_LIMIT} documents after stage ${stageIndex + 1} (${stageKey})`;
  body.appendChild(info);

  const content = document.createElement('div');
  content.className = 'pipeline-inspect-content';
  content.textContent = 'Loading\u2026';
  body.appendChild(content);

  openModal(`Stage ${stageIndex + 1}: ${stageKey}`, body);

  try {
    const res = await api.aggregate(collection, [...prefix, { $limit: DEBUG_PREVIEW_LIMIT }]);
    const docs = res.result || [];
    content.replaceChildren();

    if (docs.length === 0) {
      content.textContent = 'No documents at this stage';
      content.style.color = 'var(--text-secondary)';
      return;
    }

    for (let i = 0; i < docs.length; i++) {
      const card = document.createElement('div');
      card.className = 'pipeline-inspect-card';

      const header = document.createElement('div');
      header.className = 'pipeline-inspect-card-header';
      header.textContent = `Document ${i + 1}`;
      card.appendChild(header);

      const pre = document.createElement('pre');
      pre.className = 'pipeline-inspect-json';
      pre.textContent = JSON.stringify(docs[i], null, 2);
      card.appendChild(pre);

      content.appendChild(card);
    }
  } catch (err) {
    content.textContent = 'Error: ' + err.message;
    content.style.color = 'var(--danger)';
  }
}

// ── Download collection ─────────────────────────

let downloadCancelled = false;
const DOWNLOAD_BATCH = 1000;

async function downloadCollection() {
  const collection = state.get('selectedCollection');
  if (!collection) return;

  // Warn for large collections
  if (totalCount !== null && totalCount > 10_000) {
    const proceed = await new Promise((resolve) => {
      confirmModal(
        'Large collection',
        `This collection has ${totalCount.toLocaleString()} documents. Downloading may take a while and use significant memory. Continue?`,
        () => resolve(true),
      );
      // If modal is closed without confirming, resolve false
      const checkClosed = setInterval(() => {
        if (!document.querySelector('.modal-overlay.visible')) {
          clearInterval(checkClosed);
          resolve(false);
        }
      }, 200);
    });
    if (!proceed) return;
  }

  const btn = document.getElementById('recordDownloadBtn');
  btn.classList.add('hidden');
  downloadCancelled = false;

  // Show progress bar next to the button
  const progress = document.createElement('span');
  progress.className = 'download-progress';
  progress.innerHTML = `
    <span class="download-progress-text">Downloading\u2026 0 records</span>
    <button class="download-cancel-btn" title="Cancel download">\u2715</button>
  `;
  btn.parentElement.insertBefore(progress, btn.nextSibling);
  progress.querySelector('.download-cancel-btn').addEventListener('click', () => {
    downloadCancelled = true;
  });

  const allDocs = [];
  let skip = 0;

  try {
    state.set({ error: null });

    while (true) {
      if (downloadCancelled) break;
      const res = await api.aggregate(collection, [
        { $match: {} },
        { $skip: skip },
        { $limit: DOWNLOAD_BATCH },
      ]);
      if (downloadCancelled) break;
      const batch = res.result || [];
      allDocs.push(...batch);
      progress.querySelector('.download-progress-text').textContent =
        `Downloading\u2026 ${allDocs.length} records`;
      if (batch.length < DOWNLOAD_BATCH) break;
      skip += DOWNLOAD_BATCH;
    }

    if (downloadCancelled) {
      progress.querySelector('.download-progress-text').textContent = 'Cancelled';
      setTimeout(() => { progress.remove(); btn.classList.remove('hidden'); }, 1500);
    } else {
      const json = JSON.stringify(allDocs, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${collection}.json`;
      a.click();
      URL.revokeObjectURL(url);

      progress.querySelector('.download-progress-text').textContent =
        `\u2713 ${allDocs.length} records`;
      progress.querySelector('.download-cancel-btn').remove();
      setTimeout(() => { progress.remove(); btn.classList.remove('hidden'); }, 2000);
    }
  } catch (err) {
    if (!downloadCancelled) {
      state.set({ error: { message: `Download failed: ${err.message}` } });
    }
    progress.remove();
    btn.classList.remove('hidden');
  }
}

// ── Render ──────────────────────────────────────

function render() {
  const panel = document.getElementById('panel-data');
  panel.replaceChildren();
  panel.style.display = 'flex';
  panel.style.flexDirection = 'row';

  // Left: pipeline editor
  const left = document.createElement('div');
  left.className = 'data-panel-left';

  const pipelineHeader = document.createElement('div');
  pipelineHeader.className = 'pipeline-header';

  const editorLabel = document.createElement('span');
  editorLabel.className = 'split-pane-label';
  editorLabel.textContent = 'Aggregate Pipeline';

  const queryActions = document.createElement('div');
  queryActions.className = 'pipeline-header-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'pipeline-save-btn';
  saveBtn.textContent = '\u2606';
  saveBtn.title = 'Save current query';

  // Check and update star state based on whether current pipeline is saved
  async function updateSaveBtn() {
    const col = state.get('selectedCollection');
    if (!col || !pipelineEditor) return;
    const saved = await isSaved(col, pipelineEditor.getValue());
    saveBtn.textContent = saved ? '\u2605' : '\u2606';
    saveBtn.classList.toggle('pipeline-save-btn-active', saved);
  }

  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const collection = state.get('selectedCollection');
    if (!collection || !pipelineEditor) return;
    // If already saved, unsave it
    if (saveBtn.classList.contains('pipeline-save-btn-active')) {
      await unsaveQuery(collection, pipelineEditor.getValue());
      updateSaveBtn();
      return;
    }
    document.querySelector('.pipeline-save-inline')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'pipeline-save-inline';
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = 'Query name\u2026';
    const ok = document.createElement('button');
    ok.className = 'btn btn-sm btn-primary';
    ok.textContent = 'Save';
    wrap.appendChild(input);
    wrap.appendChild(ok);
    const rect = saveBtn.getBoundingClientRect();
    wrap.style.position = 'fixed';
    wrap.style.top = rect.bottom + 4 + 'px';
    wrap.style.left = rect.left + 'px';
    document.body.appendChild(wrap);
    input.focus();
    async function doSave() {
      const name = input.value.trim();
      await saveQuery(collection, pipelineEditor.getValue(), name || null, { ...placeholderValues });
      wrap.remove();
      updateSaveBtn();
    }
    ok.addEventListener('click', doSave);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doSave();
      if (ev.key === 'Escape') wrap.remove();
    });
    const close = (ev) => {
      if (!wrap.contains(ev.target) && ev.target !== saveBtn) {
        wrap.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  });

  const historyBtn = document.createElement('button');
  historyBtn.className = 'pipeline-action-btn';
  historyBtn.textContent = 'Query History';
  historyBtn.title = 'Browse and reuse recent queries';
  historyBtn.addEventListener('click', (e) => openQueryPanel(e, renderHistoryPanel(loadFromPanel)));

  const savedBtn = document.createElement('button');
  savedBtn.className = 'pipeline-action-btn';
  savedBtn.textContent = 'Saved Queries';
  savedBtn.title = 'Browse named saved queries';
  savedBtn.addEventListener('click', (e) => openQueryPanel(e, renderSavedPanel(loadFromPanel)));

  const beautifyBtn = document.createElement('button');
  beautifyBtn.className = 'pipeline-action-btn';
  beautifyBtn.textContent = 'Beautify';
  beautifyBtn.title = 'Format pipeline JSON';
  beautifyBtn.addEventListener('click', () => {
    if (!pipelineEditor) return;
    try {
      const parsed = JSON5.parse(pipelineEditor.getValue());
      suppressPipelineSync = true;
      pipelineEditor.setValue(JSON.stringify(parsed, null, 2));
      setTimeout(() => { suppressPipelineSync = false; }, 100);
    } catch { /* invalid JSON, ignore */ }
  });

  queryActions.appendChild(saveBtn);
  queryActions.appendChild(savedBtn);
  queryActions.appendChild(historyBtn);
  queryActions.appendChild(beautifyBtn);

  // Update star after query runs or collection changes
  state.on('recordsChanged', updateSaveBtn);
  state.on('selectedCollectionChanged', updateSaveBtn);
  pipelineHeader.appendChild(editorLabel);
  pipelineHeader.appendChild(queryActions);
  left.appendChild(pipelineHeader);

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

  const debugContainer = document.createElement('div');
  debugContainer.id = 'pipelineDebug';
  debugContainer.className = 'pipeline-debug';
  left.appendChild(debugContainer);

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
  downloadBtn.textContent = 'Download all';
  dataGroup.appendChild(downloadBtn);

  const onSuccessCb = () => {
    invalidateRecordCache();
    runQuery();
  };
  dataGroup.appendChild(buildSplitButton('Insert', 'btn-success', {
    main: () => openDataOperations('insert', onSuccessCb, currentFields),
    file: () => openDataOperations('insert-file', onSuccessCb, currentFields),
  }));

  toolbar.appendChild(dataGroup);
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
  right.querySelector('#recordDownloadBtn').addEventListener('click', downloadCollection);
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

function buildSplitButton(label, extraCls, { main, file }) {
  const wrap = document.createElement('div');
  wrap.className = 'split-btn';

  const mainBtn = document.createElement('button');
  mainBtn.className = `btn btn-sm ${extraCls}`.trim();
  mainBtn.textContent = label;
  mainBtn.addEventListener('click', main);

  const dropBtn = document.createElement('button');
  dropBtn.className = `btn btn-sm split-btn-drop ${extraCls}`.trim();
  dropBtn.innerHTML = '\u25BE';
  dropBtn.title = `${label} from JSON file`;

  const menu = document.createElement('div');
  menu.className = 'toolbar-more-menu hidden';
  const menuItem = document.createElement('button');
  menuItem.className = 'toolbar-menu-item';
  menuItem.textContent = `${label} from JSON file`;
  menuItem.addEventListener('click', () => { menu.classList.add('hidden'); file(); });
  menu.appendChild(menuItem);

  dropBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.split-btn .toolbar-more-menu').forEach((m) => {
      if (m !== menu) m.classList.add('hidden');
    });
    menu.classList.toggle('hidden');
  });
  // Use single delegated listener instead of per-button
  if (!splitMenuDelegationRegistered) {
    splitMenuDelegationRegistered = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.split-btn .toolbar-more-menu').forEach((m) => m.classList.add('hidden'));
    });
  }

  wrap.appendChild(mainBtn);
  wrap.appendChild(dropBtn);
  wrap.appendChild(menu);
  return wrap;
}

function initPanelResize(resizer, leftPane) {
  // Restore saved width
  chrome.storage.local.get(['mdhPipelineWidth'], ({ mdhPipelineWidth }) => {
    if (mdhPipelineWidth) {
      leftPane.style.width = mdhPipelineWidth + 'px';
      leftPane.style.flexBasis = mdhPipelineWidth + 'px';
    }
  });

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
      chrome.storage.local.set({ mdhPipelineWidth: leftPane.getBoundingClientRect().width });
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
  listEl.replaceChildren();

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
      empty.innerHTML = '<p>0 records match the current query</p><p class="record-list-empty-hint">Try modifying the pipeline or click Reset</p>';
    } else {
      empty.innerHTML = '<p>No records</p>';
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
      openRecordEditor('edit', record, () => { invalidateRecordCache(); runQuery(); }, currentFields);
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
            invalidateRecordCache();
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
  let countText = count > 0
    ? `Showing ${skip + 1}\u2013${skip + count}`
    : 'No records';
  if (totalCount !== null) countText += ` (out of ${totalCount})`;
  const countEl = document.getElementById('recordCount');
  if (lastQueryMs) {
    countText += ` \u00b7 ${lastQueryMs}ms`;
  }
  countEl.textContent = countText;
  countEl.classList.toggle('record-count-slow', lastQueryMs > 1000);
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

