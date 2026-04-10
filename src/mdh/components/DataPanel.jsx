import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { selectedCollection, records, skip, limit, loading, error } from '../store.js';
import { usePipeline } from '../hooks/usePipeline.js';
import { useQuery } from '../hooks/useQuery.js';
import { usePagination } from '../hooks/usePagination.js';
import { extractFieldNames } from './JsonEditor.jsx';
import PipelineEditor from './PipelineEditor.jsx';
import PlaceholderInputs from './PlaceholderInputs.jsx';
import PipelineDebug from './PipelineDebug.jsx';
import RecordList from './RecordList.jsx';
import { openRecordEditor } from './RecordEditor.jsx';
import { openDataOperations } from './DataOperations.jsx';
import { openDeleteMany } from './DeleteMany.jsx';
import { confirmModal } from './Modal.jsx';
import { addToHistory } from './QueryHistory.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';
import JSON5 from 'json5';

const MAX_LIMIT = 500;

function enforcePipelineLimit(text, defaultLimit) {
  let pipeline;
  try {
    pipeline = JSON5.parse(text);
    if (!Array.isArray(pipeline)) return null;
  } catch { return null; }

  let changed = false;
  const hasLimit = pipeline.some(s => s != null && typeof s === 'object' && '$limit' in s);
  if (!hasLimit) {
    pipeline.push({ $limit: defaultLimit });
    changed = true;
  }
  for (const stage of pipeline) {
    if (stage != null && typeof stage === 'object' && '$limit' in stage && stage.$limit > MAX_LIMIT) {
      stage.$limit = MAX_LIMIT;
      changed = true;
    }
  }
  return changed ? JSON.stringify(pipeline, null, 2) : null;
}

export default function DataPanel() {
  const editorRef = useRef(null);
  const pipeline = usePipeline();
  const query = useQuery();
  const pagination = usePagination();
  const leftRef = useRef(null);
  const [downloadState, setDownloadState] = useState(null); // null | { count, cancelled }
  const downloadCancelRef = useRef(false);

  const collection = selectedCollection.value;

  function buildInitialPipeline() {
    const p = pipeline.buildPipelineFromUI();
    p.push({ $limit: limit.value });
    return JSON.stringify(p, null, 2);
  }

  function syncPipeline() {
    if (!editorRef.current) return;
    const p = pipeline.buildPipelineFromUI();
    p.push({ $limit: limit.value });
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(JSON.stringify(p, null, 2));
    setTimeout(() => { pipeline.suppressSync.value = false; }, 600);
  }

  function syncPipelineAndRun() {
    syncPipeline();
    runQuery();
  }

  async function runQuery() {
    if (!collection || !editorRef.current) return;
    let rawText = editorRef.current.getValue();
    const corrected = enforcePipelineLimit(rawText, limit.value);
    if (corrected !== null) {
      pipeline.suppressSync.value = true;
      editorRef.current.setValue(corrected);
      setTimeout(() => { pipeline.suppressSync.value = false; }, 600);
      rawText = corrected;
    }
    const result = await query.runQuery(collection, rawText, pipeline.substitutePlaceholders);
    if (result) {
      addToHistory(collection, rawText, { ...pipeline.placeholderValues.value });
    }
  }

  useEffect(() => {
    if (!collection) return;
    skip.value = 0;
    pipeline.reset();

    const cachedCount = cache.get(collection, 'totalCount');
    if (cachedCount !== null) pagination.totalCount.value = cachedCount;
    else { pagination.totalCount.value = null; pagination.fetchTotalCount(collection); }

    const cachedRecords = cache.get(collection, 'records');
    if (cachedRecords !== null) {
      records.value = cachedRecords;
      setTimeout(() => syncPipeline(), 50);
    } else {
      query.setCacheNextQuery(true);
      setTimeout(() => syncPipelineAndRun(), 50);
    }
  }, [collection]);

  function invalidateAndRun() {
    cache.invalidateData(collection);
    pagination.totalCount.value = null;
    pagination.fetchTotalCount(collection);
    runQuery();
  }

  function currentFields() {
    return extractFieldNames(records.value);
  }

  function handleEditorChange() {
    if (!pipeline.suppressSync.value) {
      pipeline.sortState.value = {};
      pipeline.filterState.value = {};
    }
  }

  function handleValidChange() {
    if (!pipeline.suppressSync.value) runQuery();
  }

  function handleLoadPipeline(pipelineText, col, variables) {
    if (variables) pipeline.placeholderValues.value = { ...variables };
    if (col && col !== collection) {
      selectedCollection.value = col;
      setTimeout(() => {
        if (editorRef.current) {
          pipeline.suppressSync.value = true;
          editorRef.current.setValue(pipelineText);
          setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
        }
      }, 50);
    } else if (editorRef.current) {
      pipeline.suppressSync.value = true;
      editorRef.current.setValue(pipelineText);
      setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
    }
  }

  function handleSort(field) {
    pipeline.toggleSort(field);
    syncPipelineAndRun();
  }

  function handleFilter(field, value) {
    pipeline.toggleFilter(field, value);
    syncPipelineAndRun();
  }

  function handleToolbarAction(action) {
    if (action === 'reset') {
      pipeline.reset();
      syncPipelineAndRun();
    } else if (action === 'download') {
      downloadCollection();
    } else if (action === 'insert') {
      openDataOperations('insert', invalidateAndRun, currentFields);
    } else if (action === 'insert-file') {
      openDataOperations('insert-file', invalidateAndRun, currentFields);
    }
  }

  const pipelineText = editorRef.current ? editorRef.current.getValue() : '';
  const placeholderNames = pipeline.extractPlaceholders(pipelineText);

  function handleSetPlaceholder(name, value) {
    pipeline.setPlaceholder(name, value);
    clearTimeout(handleSetPlaceholder._timer);
    handleSetPlaceholder._timer = setTimeout(runQuery, 400);
  }

  async function downloadCollection() {
    const tc = pagination.totalCount.value;
    if (tc !== null && tc > 10_000) {
      const proceed = await new Promise((resolve) => {
        confirmModal(
          'Large collection',
          `This collection has ${tc.toLocaleString()} documents. Downloading may take a while and use significant memory. Continue?`,
          () => resolve(true),
        );
        const check = setInterval(() => {
          if (!document.querySelector('.modal-overlay.visible')) { clearInterval(check); resolve(false); }
        }, 200);
      });
      if (!proceed) return;
    }

    downloadCancelRef.current = false;
    const total = pagination.totalCount.value;
    setDownloadState({ count: 0, total });

    const BATCH = 1000;
    const allDocs = [];
    let s = 0;
    try {
      error.value = null;
      while (true) {
        if (downloadCancelRef.current) break;
        const res = await api.aggregate(collection, [{ $match: {} }, { $skip: s }, { $limit: BATCH }]);
        if (downloadCancelRef.current) break;
        const batch = res.result || [];
        allDocs.push(...batch);
        setDownloadState({ count: allDocs.length, total });
        if (batch.length < BATCH) break;
        s += BATCH;
      }

      if (downloadCancelRef.current) {
        setDownloadState({ count: allDocs.length, cancelled: true });
        setTimeout(() => setDownloadState(null), 1500);
      } else {
        const json = JSON.stringify(allDocs, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${collection}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setDownloadState({ count: allDocs.length, done: true });
        setTimeout(() => setDownloadState(null), 2000);
      }
    } catch (err) {
      if (!downloadCancelRef.current) {
        error.value = { message: `Download failed: ${err.message}` };
      }
      setDownloadState(null);
    }
  }

  function cancelDownload() {
    downloadCancelRef.current = true;
  }

  let parsedPipeline = null;
  try {
    const text = editorRef.current ? pipeline.substitutePlaceholders(editorRef.current.getValue()) : '';
    parsedPipeline = JSON5.parse(text);
    if (!Array.isArray(parsedPipeline)) parsedPipeline = null;
  } catch { parsedPipeline = null; }

  useEffect(() => {
    const leftPane = leftRef.current;
    if (!leftPane) return;
    chrome.storage.local.get(['mdhPipelineWidth'], ({ mdhPipelineWidth }) => {
      if (mdhPipelineWidth) {
        leftPane.style.width = mdhPipelineWidth + 'px';
        leftPane.style.flexBasis = mdhPipelineWidth + 'px';
      }
    });
  }, []);

  function initPanelResize(e) {
    const leftPane = leftRef.current;
    if (!leftPane) return;
    const startX = e.clientX;
    const startWidth = leftPane.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function onMove(e) {
      const w = Math.max(200, Math.min(800, startWidth + e.clientX - startX));
      leftPane.style.width = w + 'px';
      leftPane.style.flexBasis = w + 'px';
    }
    function onUp() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (editorRef.current) editorRef.current.refresh();
      chrome.storage.local.set({ mdhPipelineWidth: leftPane.getBoundingClientRect().width });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div class="panel" style="display:flex;flex-direction:row">
      <div class="data-panel-left" ref={leftRef}>
        <PipelineEditor
          editorRef={editorRef}
          initialValue={buildInitialPipeline()}
          onChange={handleEditorChange}
          onValidChange={handleValidChange}
          onLoadPipeline={handleLoadPipeline}
        />
        <PlaceholderInputs
          names={placeholderNames}
          values={pipeline.placeholderValues.value}
          onSetValue={handleSetPlaceholder}
          onRunQuery={runQuery}
        />
        <PipelineDebug pipeline={parsedPipeline} />
      </div>
      <div class="data-panel-resizer" onMouseDown={initPanelResize}></div>
      <div class="data-panel-right">
        <RecordList
          records={records.value}
          pipelineText={pipelineText}
          filterState={pipeline.filterState.value}
          sortState={pipeline.sortState.value}
          lastQueryMs={query.lastQueryMs.value}
          totalCount={pagination.totalCount.value}
          pagination={pagination}
          onSort={handleSort}
          onFilter={handleFilter}
          onPageChange={(dir) => { dir === 'next' ? pagination.goNext() : pagination.goPrev(); syncPipelineAndRun(); }}
          onEdit={(record) => openRecordEditor('edit', record, invalidateAndRun, currentFields)}
          onDelete={(record, idx) => {
            const deleteId = record._id?.$oid || record._id || '?';
            confirmModal('Delete record?', `Delete record with _id "${deleteId}"? This cannot be undone.`, async () => {
              try {
                loading.value = true;
                error.value = null;
                await api.deleteOne(collection, { _id: record._id });
                invalidateAndRun();
              } catch (err) {
                error.value = { message: err.message };
                loading.value = false;
              }
            });
          }}
          onRefresh={handleToolbarAction}
          downloadState={downloadState}
          onCancelDownload={cancelDownload}
        />
      </div>
    </div>
  );
}
