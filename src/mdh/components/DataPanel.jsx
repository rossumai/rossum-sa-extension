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
import { showUndo } from '../undo.js';
import { addToHistory } from './QueryHistory.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { applySortToPipeline, applyFilterDeltaToPipeline, applySkipToPipeline, extractUIStateFromPipeline } from '../pipelineOps.js';
import { savePipelineState, getPipelineState } from '../pipelineState.js';
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
  // When switching collections via a saved/recent pipeline, stash the payload
  // so the collection-change effect can apply it instead of running the default.
  const pendingLoadRef = useRef(null); // null | { pipelineText, variables }

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

  // Parse the current editor text, mutate only the stage(s) the caller cares about,
  // and write back. Preserves any user-written stages (custom $match, $project,
  // $lookup, etc.) that aren't touched by UI events like sort/filter/pagination.
  // No-op when the editor holds invalid JSON/JSON5 so the user's WIP isn't discarded.
  function mutatePipelineText(mutator) {
    if (!editorRef.current) return;
    let parsed;
    try {
      parsed = JSON5.parse(editorRef.current.getValue());
      if (!Array.isArray(parsed)) return;
    } catch {
      return;
    }
    const next = parsed.map((s) => (s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : s));
    mutator(next);
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(JSON.stringify(next, null, 2));
    setTimeout(() => { pipeline.suppressSync.value = false; }, 600);
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

    // A cross-collection pipeline load is pending — apply it instead of the default.
    const pending = pendingLoadRef.current;
    if (pending) {
      pendingLoadRef.current = null;
      if (pending.variables) pipeline.placeholderValues.value = { ...pending.variables };
      setTimeout(() => {
        if (!editorRef.current) return;
        pipeline.suppressSync.value = true;
        editorRef.current.setValue(pending.pipelineText);
        setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
      }, 50);
      return () => { saveStateForCleanup(collection); };
    }

    // Restore previously saved per-collection state (preserved across tab switches
    // and within-session collection switches) before falling through to defaults.
    const saved = getPipelineState(collection);
    if (saved) {
      skip.value = saved.skip || 0;
      if (saved.variables) pipeline.placeholderValues.value = { ...saved.variables };
      setTimeout(() => {
        if (!editorRef.current) return;
        pipeline.suppressSync.value = true;
        editorRef.current.setValue(saved.pipelineText);
        setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
      }, 50);
      return () => { saveStateForCleanup(collection); };
    }

    const cachedRecords = cache.get(collection, 'records');
    if (cachedRecords !== null) {
      records.value = cachedRecords;
      setTimeout(() => syncPipeline(), 50);
    } else {
      query.setCacheNextQuery(true);
      setTimeout(() => syncPipelineAndRun(), 50);
    }

    // Cleanup runs on unmount (tab switch) and before the next [collection] effect
    // (collection switch). Capture whatever's in the editor at that moment so
    // returning to this collection — from any tab — restores the user's edits.
    return () => { saveStateForCleanup(collection); };
  }, [collection]);

  function saveStateForCleanup(col) {
    if (!editorRef.current) return;
    savePipelineState(col, {
      pipelineText: editorRef.current.getValue(),
      variables: { ...pipeline.placeholderValues.value },
      skip: skip.value,
    });
  }

  function invalidateAndRun() {
    cache.invalidateData(collection);
    pagination.totalCount.value = null;
    pagination.fetchTotalCount(collection);
    runQuery();
  }

  function currentFields() {
    return extractFieldNames(records.value);
  }

  // Mirror the pipeline text into UI state (column sort arrows, filter chips)
  // so direct edits to $sort/$match are reflected in the record view. Runs only
  // after a *valid* parse — invalid intermediate edits leave the last good state
  // in place instead of flickering.
  function syncUIStateFromPipeline() {
    if (!editorRef.current) return;
    try {
      const parsed = JSON5.parse(editorRef.current.getValue());
      const { sorts, filters } = extractUIStateFromPipeline(parsed);
      pipeline.sortState.value = sorts;
      pipeline.filterState.value = filters;
    } catch { /* invalid — keep existing UI state */ }
  }

  function handleEditorChange() {
    // Previously cleared sortState/filterState on every keystroke. No longer
    // needed: the next valid parse repopulates them from the pipeline text
    // (see handleValidChange → syncUIStateFromPipeline).
  }

  function handleValidChange() {
    if (!pipeline.suppressSync.value) {
      syncUIStateFromPipeline();
      runQuery();
    }
  }

  function handleLoadPipeline(pipelineText, col, variables) {
    if (col && col !== collection) {
      // Defer to the [collection] effect — it will apply the pipeline and variables
      // after reset() instead of racing the default path.
      pendingLoadRef.current = { pipelineText, variables };
      selectedCollection.value = col;
      return;
    }
    if (variables) pipeline.placeholderValues.value = { ...variables };
    if (editorRef.current) {
      pipeline.suppressSync.value = true;
      editorRef.current.setValue(pipelineText);
      setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
    }
  }

  function handleSort(field) {
    pipeline.toggleSort(field);
    mutatePipelineText((p) => {
      applySortToPipeline(p, pipeline.sortState.value);
      applySkipToPipeline(p, skip.value); // toggleSort resets skip to 0
    });
    runQuery();
  }

  function handleFilter(field, value) {
    pipeline.toggleFilter(field, value);
    const active = field in pipeline.filterState.value;
    mutatePipelineText((p) => {
      applyFilterDeltaToPipeline(p, field, value, active);
      applySkipToPipeline(p, skip.value); // toggleFilter resets skip to 0
    });
    runQuery();
  }

  function handleReset() {
    pipeline.reset();
    syncPipelineAndRun();
  }

  function handleToolbarAction(action) {
    if (action === 'download') {
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
      const proceed = await confirmModal(
        'Large collection',
        `This collection has ${tc.toLocaleString()} documents. Downloading may take a while and use significant memory. Continue?`,
      );
      if (!proceed) return;
    }

    downloadCancelRef.current = false;
    let total = pagination.totalCount.value;
    setDownloadState({ count: 0, total });

    const BATCH = 5000;
    const CONCURRENCY = 10;
    try {
      error.value = null;

      if (total === null) {
        const countRes = await api.aggregate(collection, [{ $count: 'total' }]);
        total = countRes.result?.[0]?.total ?? 0;
        setDownloadState({ count: 0, total });
      }

      if (total === 0 || downloadCancelRef.current) {
        setDownloadState(null);
        return;
      }

      const offsets = [];
      for (let s = 0; s < total; s += BATCH) offsets.push(s);

      const results = new Array(offsets.length);
      let fetched = 0;

      for (let i = 0; i < offsets.length; i += CONCURRENCY) {
        if (downloadCancelRef.current) break;
        const chunk = offsets.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map((s, j) =>
          api.aggregate(collection, [{ $match: {} }, { $skip: s }, { $limit: BATCH }]).then((res) => {
            results[i + j] = res.result || [];
            fetched += (res.result || []).length;
            setDownloadState({ count: fetched, total });
          })
        ));
      }

      if (downloadCancelRef.current) {
        setDownloadState({ count: fetched, cancelled: true });
        setTimeout(() => setDownloadState(null), 1500);
      } else {
        const allDocs = results.flat();
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
          onReset={handleReset}
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
          onPageChange={(dir) => {
            dir === 'next' ? pagination.goNext() : pagination.goPrev();
            mutatePipelineText((p) => applySkipToPipeline(p, skip.value));
            runQuery();
          }}
          onEdit={(record) => openRecordEditor('edit', record, invalidateAndRun, currentFields)}
          onDelete={(record, idx) => {
            const deleteId = record._id?.$oid || record._id || '?';
            confirmModal('Delete record?', `Delete record with _id "${deleteId}"? You'll have a few seconds to undo.`, async () => {
              const snapshot = record;
              const col = collection;
              try {
                loading.value = true;
                error.value = null;
                await api.deleteOne(col, { _id: record._id });
                invalidateAndRun();
                showUndo({
                  message: `Deleted record ${deleteId}`,
                  action: async () => {
                    await api.insertOne(col, snapshot);
                    if (selectedCollection.value === col) invalidateAndRun();
                  },
                });
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
