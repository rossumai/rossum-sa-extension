import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { selectedCollection, records, skip, limit, loading, error, pendingPipelineLoad, sampledFields } from '../store.js';
import { usePipeline } from '../hooks/usePipeline.js';
import { useQuery } from '../hooks/useQuery.js';
import { usePagination } from '../hooks/usePagination.js';
import { useEditorSnapshot } from '../hooks/useEditorSnapshot.js';
import { extractFieldNames } from './JsonEditor.jsx';
import PipelineEditor from './PipelineEditor.jsx';
import PlaceholderInputs from './PlaceholderInputs.jsx';
import PipelineDebug from './PipelineDebug.jsx';
import RecordList from './RecordList.jsx';
import StageLinkOverlay from './StageLinkOverlay.jsx';
import { openRecordEditor } from './RecordEditor.jsx';
import { openDataOperations } from './DataOperations.jsx';
import { openBulkDelete } from './BulkDelete.jsx';
import { openBulkUpdate } from './BulkUpdate.jsx';
import { selectionMode, selectedIds, selectionPipelineDirty, resultsView, inspectTarget, stagesAutoscroll } from '../store.js';
import { confirmModal, openModal } from './Modal.jsx';
import { showUndo } from '../undo.js';
import { addToHistory } from './QueryHistory.jsx';
import * as api from '../api.js';
import * as cache from '../cache.js';
import { applySortToPipeline, applyFilterDeltaToPipeline, applySkipToPipeline, extractUIStateFromPipeline, stripPaginationStages, pipelineReducesResultSet, terminalWriteStage } from '../pipelineOps.js';
import { applyMutationToText, normalizeEffectivePipelineText, setStageDisabled, parseEntries } from '../pipelineComments.js';
import { loadCollections } from './Sidebar.jsx';
import { savePipelineState, getPipelineState } from '../pipelineState.js';
import { saveLastPipeline } from '../lastPipeline.js';
import { downloadCollection as runDownload, buildCsvSerializer, buildXmlSerializer, buildNdjsonSerializer } from '../downloadCollection.js';
import { buildColumnDiscoveryPipeline, orderColumns } from '../csv.js';
import CsvExportOptions from './CsvExportOptions.jsx';
import XmlExportOptions from './XmlExportOptions.jsx';
import JSON5 from 'json5';
export default function DataPanel() {
  const editorRef = useRef(null);
  const pipeline = usePipeline();
  const query = useQuery();
  const pagination = usePagination();
  const leftRef = useRef(null);
  const panelRef = useRef(null);
  const [downloadState, setDownloadState] = useState(null); // null | { count, total, filtered?, counting?, cancelled?, done? }
  const downloadCancelRef = useRef(false);
  const downloadCountAbortRef = useRef(null); // AbortController for the pre-flight count of filtered downloads
  // When switching collections via a saved/recent pipeline, stash the payload
  // so the collection-change effect can apply it instead of running the default.
  const pendingLoadRef = useRef(null); // null | { pipelineText, variables }
  // Debounce timer for persisting the editor's contents (text + variables) to
  // chrome.storage.local, so a page reload restores the user's last query.
  const persistTimerRef = useRef(null);
  // Debounced snapshot of the editor (text, variable names, parsed pipeline)
  // that drives the Variables inputs and the Pipeline Debug — see
  // useEditorSnapshot. recomputeEditorState() is called on every editor edit and
  // on placeholder changes.
  const [editorState, recomputeEditorState] = useEditorSnapshot(editorRef, pipeline.computeEditorStateWithTypes);
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
    const next = applyMutationToText(editorRef.current.getValue(), mutator);
    if (next == null) return;
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(next);
    setTimeout(() => { pipeline.suppressSync.value = false; }, 600);
  }

  async function runQuery(opts = {}) {
    if (!collection || !editorRef.current) return;
    const rawText = editorRef.current.getValue();
    // Detect a terminal write stage from the LIVE editor text (not the debounced
    // snapshot) so detection matches exactly what would run.
    const liveStages = parseEntries(pipeline.substituteWithTypes(rawText)).entries
      .filter((e) => !e.disabled)
      .map((e) => e.stage);
    const write = terminalWriteStage(liveStages);
    if (write) {
      // The query UI auto-runs on every edit. A write pipeline must NEVER run
      // automatically — it executes only via the explicit "Run write pipeline"
      // button (opts.explicitWrite), behind a confirmation.
      if (!opts.explicitWrite) return;
      confirmModal(
        'Run write-stage pipeline?',
        `This pipeline ends in ${write.op} and will write results into collection "${write.target}", which may overwrite existing data. Run it?`,
        async () => {
          await pipeline.ensureFieldTypes(collection, pipeline.referencedFields(rawText));
          const result = await query.runQuery(
            collection,
            rawText,
            (t) => normalizeEffectivePipelineText(pipeline.substituteWithTypes(t)),
          );
          if (result) {
            addToHistory(collection, rawText, { ...pipeline.placeholderValues.value }, { ...pipeline.placeholderTypes.value });
          }
          cache.invalidateAll(); // a write may create/replace the target collection
          loadCollections();
        },
      );
      return;
    }
    await pipeline.ensureFieldTypes(collection, pipeline.referencedFields(rawText));
    const result = await query.runQuery(
      collection,
      rawText,
      (t) => normalizeEffectivePipelineText(pipeline.substituteWithTypes(t)),
    );
    if (result) {
      addToHistory(collection, rawText, { ...pipeline.placeholderValues.value }, { ...pipeline.placeholderTypes.value });
    }
  }

  useEffect(() => {
    if (!collection) return;
    skip.value = 0;
    selectionMode.value = false;
    selectedIds.value = new Map();
    selectionPipelineDirty.value = false;
    pipeline.reset();

    sampledFields.value = [];
    api.aggregate(collection, [{ $sample: { size: 200 } }])
      .then((res) => {
        if (selectedCollection.value !== collection) return; // stale guard
        sampledFields.value = extractFieldNames(res.result || []);
      })
      .catch(() => { /* sampling is best-effort; fall back to loaded-record fields */ });

    const cachedCount = cache.get(collection, 'totalCount');
    if (cachedCount !== null) pagination.totalCount.value = cachedCount;
    else { pagination.totalCount.value = null; pagination.fetchTotalCount(collection); }

    // External prefill (from the popup's "Open in Dataset Management" button).
    // Takes precedence over any in-memory state so the user always sees their query.
    const external = pendingPipelineLoad.peek();
    if (external && external.collection === collection) {
      pendingPipelineLoad.value = null;
      if (external.variables) pipeline.placeholderValues.value = { ...external.variables };
      if (external.placeholderTypes) pipeline.placeholderTypes.value = { ...external.placeholderTypes };
      setTimeout(() => {
        if (!editorRef.current) return;
        pipeline.suppressSync.value = true;
        editorRef.current.setValue(external.pipelineText);
        setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
      }, 50);
      return () => { saveStateForCleanup(collection); };
    }

    // A cross-collection pipeline load is pending — apply it instead of the default.
    const pending = pendingLoadRef.current;
    if (pending) {
      pendingLoadRef.current = null;
      if (pending.variables) pipeline.placeholderValues.value = { ...pending.variables };
      if (pending.placeholderTypes) pipeline.placeholderTypes.value = { ...pending.placeholderTypes };
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
      if (saved.placeholderTypes) pipeline.placeholderTypes.value = { ...saved.placeholderTypes };
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

  useEffect(() => {
    if (!collection || !editorRef.current) return;
    pipeline.ensureFieldTypes(collection, pipeline.referencedFields(editorState.text))
      .then((changed) => { if (changed) recomputeEditorState(); });
  }, [editorState.text, collection]);

  function saveStateForCleanup(col) {
    if (!editorRef.current) return;
    savePipelineState(col, {
      pipelineText: editorRef.current.getValue(),
      variables: { ...pipeline.placeholderValues.value },
      placeholderTypes: { ...pipeline.placeholderTypes.value },
      skip: skip.value,
    });
  }

  async function invalidateAndRun() {
    cache.invalidateData(collection);
    pagination.totalCount.value = null;
    pagination.fetchTotalCount(collection);
    await runQuery();
  }

  function currentFields() {
    return extractFieldNames(records.value);
  }

  function currentPipelineFilter() {
    // Extract the active $match from the pipeline editor as our default filter.
    // Falls back to {} when the pipeline has no $match or is unparseable.
    if (!editorRef.current) return {};
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (Array.isArray(parsed)) {
        const match = parsed.find((s) => s && typeof s === 'object' && s.$match);
        if (match && match.$match && typeof match.$match === 'object') return match.$match;
      }
    } catch { /* fall through */ }
    return {};
  }

  function handleBulkDeleteFromToolbar() {
    openBulkDelete({
      collection,
      mode: 'filter',
      filter: currentPipelineFilter(),
      onSuccess: invalidateAndRun,
      fieldsFn: currentFields,
    });
  }

  function handleBulkUpdateFromToolbar() {
    openBulkUpdate({
      collection,
      mode: 'filter',
      filter: currentPipelineFilter(),
      onSuccess: invalidateAndRun,
      fieldsFn: currentFields,
    });
  }

  function handleBulkDeleteFromSelection() {
    openBulkDelete({
      collection,
      mode: 'selection',
      ids: [...selectedIds.value.values()],
      onSuccess: async () => {
        selectedIds.value = new Map();
        selectionMode.value = false;
        await invalidateAndRun();
      },
      fieldsFn: currentFields,
    });
  }

  function handleBulkUpdateFromSelection() {
    openBulkUpdate({
      collection,
      mode: 'selection',
      ids: [...selectedIds.value.values()],
      onSuccess: async () => {
        selectedIds.value = new Map();
        selectionMode.value = false;
        await invalidateAndRun();
      },
      fieldsFn: currentFields,
    });
  }

  function handleEnterSelectionMode() {
    selectionMode.value = true;
    selectionPipelineDirty.value = false;
  }

  function handleExitSelectionMode() {
    selectionMode.value = false;
    selectedIds.value = new Map();
    selectionPipelineDirty.value = false;
  }

  function handleSelectPage(select) {
    const next = new Map(selectedIds.value);
    for (const r of records.value) {
      const id = r._id?.$oid || String(r._id);
      if (select) next.set(id, r._id);
      else next.delete(id);
    }
    selectedIds.value = next;
  }

  function handleClearSelection() {
    selectedIds.value = new Map();
  }

  function handleViewSelected() {
    // Inject {_id:{$in:[...ids]}} as a $match override into the pipeline editor.
    if (!editorRef.current) return;
    const ids = [...selectedIds.value.values()];
    if (ids.length === 0) return;
    const newPipeline = [
      { $match: { _id: { $in: ids } } },
      { $limit: limit.value },
    ];
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(JSON.stringify(newPipeline, null, 2));
    setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
    // The pipeline now matches the selection exactly — banner no longer applies.
    selectionPipelineDirty.value = false;
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

  // Persist the editor text + current placeholder variables (debounced) so the
  // user's last query survives a page reload. Captures whatever is in the
  // editor — valid or not, run or not — per the "remember current editor text"
  // behavior.
  function persistLastPipeline() {
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      if (!editorRef.current) return;
      saveLastPipeline(collection, editorRef.current.getValue(), pipeline.placeholderValues.value, pipeline.placeholderTypes.value);
    }, 400);
  }

  function handleEditorChange() {
    // Previously cleared sortState/filterState on every keystroke. No longer
    // needed: the next valid parse repopulates them from the pipeline text
    // (see handleValidChange → syncUIStateFromPipeline).
    persistLastPipeline();
    recomputeEditorState();
  }

  function handleValidChange() {
    if (!pipeline.suppressSync.value) {
      if (selectionMode.value) selectionPipelineDirty.value = true;
      syncUIStateFromPipeline();
      runQuery();
    }
  }

  function handleLoadPipeline(pipelineText, col, variables, placeholderTypes) {
    if (col && col !== collection) {
      // Defer to the [collection] effect — it will apply the pipeline and variables
      // after reset() instead of racing the default path.
      pendingLoadRef.current = { pipelineText, variables, placeholderTypes };
      selectedCollection.value = col;
      return;
    }
    if (selectionMode.value) selectionPipelineDirty.value = true;
    if (variables) pipeline.placeholderValues.value = { ...variables };
    if (placeholderTypes) pipeline.placeholderTypes.value = { ...placeholderTypes };
    if (editorRef.current) {
      pipeline.suppressSync.value = true;
      editorRef.current.setValue(pipelineText);
      setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
    }
  }

  function handleToggleStage(entryIndex) {
    if (!editorRef.current) return;
    const text = editorRef.current.getValue();
    const { entries, ok } = parseEntries(text);
    if (!ok || entryIndex < 0 || entryIndex >= entries.length) return;
    const next = setStageDisabled(text, entryIndex, !entries[entryIndex].disabled);
    if (next === text) return;
    if (selectionMode.value) selectionPipelineDirty.value = true;
    pipeline.suppressSync.value = true;
    editorRef.current.setValue(next);
    setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
  }

  // A debug-panel row click switches the right pane to the Stages view and
  // targets that stage for scroll + highlight. `index` is the active-stage
  // index (-1 = input). A fresh object re-fires the highlight on each click.
  function handleInspectStage(index) {
    resultsView.value = 'stages';
    inspectTarget.value = { index };
    chrome.storage.local.set({ mdhResultsView: 'stages' });
  }

  // While the Stages view is open, follow the pipeline-editor cursor: scroll to
  // the stage it sits in. (No-op in List/Table — doesn't force the view to switch.)
  // Gated on the Stages "Auto-scroll" option; the explicit debug-panel click jump
  // (handleInspectStage) is unaffected and always scrolls.
  function handleCursorStage(activeIndex) {
    if (resultsView.value === 'stages' && stagesAutoscroll.value) inspectTarget.value = { index: activeIndex };
  }

  function handleSort(field) {
    if (selectionMode.value) selectionPipelineDirty.value = true;
    pipeline.toggleSort(field);
    mutatePipelineText((p) => {
      applySortToPipeline(p, pipeline.sortState.value);
      applySkipToPipeline(p, skip.value); // toggleSort resets skip to 0
    });
    runQuery();
  }

  function handleFilter(field, value) {
    if (selectionMode.value) selectionPipelineDirty.value = true;
    pipeline.toggleFilter(field, value);
    const active = field in pipeline.filterState.value;
    mutatePipelineText((p) => {
      applyFilterDeltaToPipeline(p, field, value, active);
      applySkipToPipeline(p, skip.value); // toggleFilter resets skip to 0
    });
    runQuery();
  }

  function handleReset() {
    if (selectionMode.value) selectionPipelineDirty.value = true;
    pipeline.reset();
    syncPipelineAndRun();
  }

  function handleToolbarAction(action) {
    if (action === 'download') {
      downloadAll();
    } else if (action === 'download-filtered') {
      downloadFiltered();
    } else if (action === 'download-csv') {
      downloadAllCsv();
    } else if (action === 'download-filtered-csv') {
      downloadFilteredCsv();
    } else if (action === 'download-xml') {
      downloadAllXml();
    } else if (action === 'download-filtered-xml') {
      downloadFilteredXml();
    } else if (action === 'download-jsonl') {
      downloadAllJsonl();
    } else if (action === 'download-filtered-jsonl') {
      downloadFilteredJsonl();
    } else if (action === 'insert') {
      openDataOperations('insert', invalidateAndRun, currentFields);
    } else if (action === 'insert-file') {
      openDataOperations('insert-file', invalidateAndRun, currentFields);
    } else if (action === 'insert-jsonl-file') {
      openDataOperations('insert-jsonl-file', invalidateAndRun, currentFields);
    } else if (action === 'insert-csv-file') {
      openDataOperations('insert-csv-file', invalidateAndRun, currentFields);
    } else if (action === 'insert-xlsx-file') {
      openDataOperations('insert-xlsx-file', invalidateAndRun, currentFields);
    } else if (action === 'insert-xml-file') {
      openDataOperations('insert-xml-file', invalidateAndRun, currentFields);
    }
  }

  const pipelineText = editorState.text;
  const placeholderNames = editorState.placeholders;

  function handleSetPlaceholder(name, value) {
    pipeline.setPlaceholder(name, value);
    persistLastPipeline();
    // Filling a variable changes the substitution result, so re-snapshot to
    // resolve the pipeline and bring the debug back.
    recomputeEditorState();
    clearTimeout(handleSetPlaceholder._timer);
    handleSetPlaceholder._timer = setTimeout(runQuery, 400);
  }

  function handleSetPlaceholderType(name, type) {
    pipeline.setPlaceholderType(name, type);
    persistLastPipeline();
    recomputeEditorState();
    clearTimeout(handleSetPlaceholder._timer);
    handleSetPlaceholder._timer = setTimeout(runQuery, 400);
  }

  async function downloadAll() {
    const tc = pagination.totalCount.value;
    if (tc !== null && tc > 10_000) {
      const proceed = await confirmModal(
        'Large collection',
        `This collection has ${tc.toLocaleString()} documents. Downloading may take a while. Continue?`,
      );
      if (!proceed) return;
    }

    const col = collection;
    await runDownloadJob({
      pipelineStages: [{ $match: {} }],
      filename: `${col}.json`,
      filtered: false,
      fetchCount: async () => {
        if (pagination.totalCount.value !== null) return pagination.totalCount.value;
        const r = await api.aggregate(col, [{ $count: 'total' }]);
        return r.result?.[0]?.total ?? 0;
      },
    });
  }

  async function downloadFiltered() {
    if (!editorRef.current) return;

    let pipelineStages;
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot download filtered: ${err.message}` };
      return;
    }

    // Pre-flight count so we can (a) populate the progress bar's total and
    // (b) gate the >10k confirmation on the filtered subset, not the whole
    // collection. Cancellable while in flight.
    downloadCancelRef.current = false;
    error.value = null;
    setDownloadState({ counting: true, filtered: true });

    const ac = new AbortController();
    downloadCountAbortRef.current = ac;
    const col = collection;
    let filteredCount;
    try {
      const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
      filteredCount = r.result?.[0]?.total ?? 0;
    } catch (err) {
      downloadCountAbortRef.current = null;
      if (downloadCancelRef.current || err.name === 'AbortError') {
        setDownloadState(null);
        return;
      }
      error.value = { message: `Cannot download filtered: ${err.message}` };
      setDownloadState(null);
      return;
    }
    downloadCountAbortRef.current = null;

    if (downloadCancelRef.current) { setDownloadState(null); return; }

    if (filteredCount > 10_000) {
      setDownloadState(null);
      const proceed = await confirmModal(
        'Large download',
        `This filter matches ${filteredCount.toLocaleString()} documents. Downloading may take a while. Continue?`,
      );
      if (!proceed) return;
    }

    await runDownloadJob({
      pipelineStages,
      filename: `${col}-filtered.json`,
      filtered: true,
      fetchCount: async () => filteredCount,
    });
  }

  async function downloadAllJsonl() {
    const tc = pagination.totalCount.value;
    if (tc !== null && tc > 10_000) {
      const proceed = await confirmModal('Large collection', `This collection has ${tc.toLocaleString()} documents. Downloading may take a while. Continue?`);
      if (!proceed) return;
    }
    const col = collection;
    await runDownloadJob({
      pipelineStages: [{ $match: {} }],
      filename: `${col}.jsonl`,
      filtered: false,
      fetchCount: async () => {
        if (pagination.totalCount.value !== null) return pagination.totalCount.value;
        const r = await api.aggregate(col, [{ $count: 'total' }]);
        return r.result?.[0]?.total ?? 0;
      },
      serializer: buildNdjsonSerializer(),
    });
  }

  async function downloadFilteredJsonl() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot download filtered: ${err.message}` };
      return;
    }
    downloadCancelRef.current = false;
    error.value = null;
    setDownloadState({ counting: true, filtered: true });
    const ac = new AbortController();
    downloadCountAbortRef.current = ac;
    const col = collection;
    let filteredCount;
    try {
      const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
      filteredCount = r.result?.[0]?.total ?? 0;
    } catch (err) {
      downloadCountAbortRef.current = null;
      if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
      error.value = { message: `Cannot download filtered: ${err.message}` };
      setDownloadState(null);
      return;
    }
    downloadCountAbortRef.current = null;
    if (downloadCancelRef.current) { setDownloadState(null); return; }
    if (filteredCount > 10_000) {
      setDownloadState(null);
      const proceed = await confirmModal('Large download', `This filter matches ${filteredCount.toLocaleString()} documents. Downloading may take a while. Continue?`);
      if (!proceed) return;
    }
    await runDownloadJob({
      pipelineStages,
      filename: `${col}-filtered.jsonl`,
      filtered: true,
      fetchCount: async () => filteredCount,
      serializer: buildNdjsonSerializer(),
    });
  }

  function downloadAllCsv() {
    const col = collection;
    openModal('Export CSV', () => (
      <CsvExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline([{ $match: {} }])),
            api.aggregate(col, [{ $match: {} }, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ delimiter, header, columns }) => {
          const tc = pagination.totalCount.value;
          if (tc !== null && tc > 10_000) {
            const proceed = await confirmModal(
              'Large collection',
              `This collection has ${tc.toLocaleString()} documents. Exporting may take a while. Continue?`,
            );
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages: [{ $match: {} }],
            filename: `${col}.csv`,
            filtered: false,
            fetchCount: async () => {
              if (pagination.totalCount.value !== null) return pagination.totalCount.value;
              const r = await api.aggregate(col, [{ $count: 'total' }]);
              return r.result?.[0]?.total ?? 0;
            },
            serializer: buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns }),
          });
        }}
      />
    ));
  }

  function downloadFilteredCsv() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot export filtered: ${err.message}` };
      return;
    }
    const col = collection;
    openModal('Export CSV', () => (
      <CsvExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline(pipelineStages)),
            api.aggregate(col, [...pipelineStages, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ delimiter, header, columns }) => {
          // Pre-count for the progress total + >10k gate (cancellable).
          downloadCancelRef.current = false;
          error.value = null;
          setDownloadState({ counting: true, filtered: true });
          const ac = new AbortController();
          downloadCountAbortRef.current = ac;
          let filteredCount;
          try {
            const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
            filteredCount = r.result?.[0]?.total ?? 0;
          } catch (err) {
            downloadCountAbortRef.current = null;
            if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
            error.value = { message: `Cannot export filtered: ${err.message}` };
            setDownloadState(null);
            return;
          }
          downloadCountAbortRef.current = null;
          if (downloadCancelRef.current) { setDownloadState(null); return; }
          if (filteredCount > 10_000) {
            setDownloadState(null);
            const proceed = await confirmModal(
              'Large export',
              `This filter matches ${filteredCount.toLocaleString()} documents. Exporting may take a while. Continue?`,
            );
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages,
            filename: `${col}-filtered.csv`,
            filtered: true,
            fetchCount: async () => filteredCount,
            serializer: buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns }),
          });
        }}
      />
    ));
  }

  function downloadAllXml() {
    const col = collection;
    openModal('Export XML', () => (
      <XmlExportOptions
        loadPreview={async () => {
          const r = await api.aggregate(col, [{ $match: {} }, { $limit: 10 }]);
          return { sample: r.result || [] };
        }}
        onDownload={async ({ rootName, recordName }) => {
          const tc = pagination.totalCount.value;
          if (tc !== null && tc > 10_000) {
            const proceed = await confirmModal('Large collection', `This collection has ${tc.toLocaleString()} documents. Exporting may take a while. Continue?`);
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages: [{ $match: {} }],
            filename: `${col}.xml`,
            filtered: false,
            fetchCount: async () => {
              if (pagination.totalCount.value !== null) return pagination.totalCount.value;
              const r = await api.aggregate(col, [{ $count: 'total' }]);
              return r.result?.[0]?.total ?? 0;
            },
            serializer: buildXmlSerializer({ rootName, recordName }),
          });
        }}
      />
    ));
  }

  function downloadFilteredXml() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot export filtered: ${err.message}` };
      return;
    }
    const col = collection;
    openModal('Export XML', () => (
      <XmlExportOptions
        loadPreview={async () => ({ sample: (await api.aggregate(col, [...pipelineStages, { $limit: 10 }])).result || [] })}
        onDownload={async ({ rootName, recordName }) => {
          // Pre-count for the progress total + >10k gate (cancellable).
          downloadCancelRef.current = false;
          error.value = null;
          setDownloadState({ counting: true, filtered: true });
          const ac = new AbortController();
          downloadCountAbortRef.current = ac;
          let filteredCount;
          try {
            const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
            filteredCount = r.result?.[0]?.total ?? 0;
          } catch (err) {
            downloadCountAbortRef.current = null;
            if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
            error.value = { message: `Cannot export filtered: ${err.message}` };
            setDownloadState(null);
            return;
          }
          downloadCountAbortRef.current = null;
          if (downloadCancelRef.current) { setDownloadState(null); return; }
          if (filteredCount > 10_000) {
            setDownloadState(null);
            const proceed = await confirmModal(
              'Large export',
              `This filter matches ${filteredCount.toLocaleString()} documents. Exporting may take a while. Continue?`,
            );
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages,
            filename: `${col}-filtered.xml`,
            filtered: true,
            fetchCount: async () => filteredCount,
            serializer: buildXmlSerializer({ rootName, recordName }),
          });
        }}
      />
    ));
  }

  async function runDownloadJob({ pipelineStages, filename, filtered, fetchCount, serializer }) {
    downloadCancelRef.current = false;
    setDownloadState({ count: 0, total: null, filtered });
    error.value = null;

    try {
      const col = collection;
      const result = await runDownload(col, {
        pipelineStages,
        filename,
        fetchCount,
        serializer,                         // undefined → JSON (default) for the existing callers
        isCancelled: () => downloadCancelRef.current,
        onProgress: ({ fetched, total }) => setDownloadState({ count: fetched, total, filtered }),
      });
      if (result.cancelled) {
        setDownloadState({ count: result.fetched, cancelled: true, filtered });
        setTimeout(() => setDownloadState(null), 1500);
      } else {
        setDownloadState({ count: result.fetched, done: true, filtered });
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
    if (downloadCountAbortRef.current) {
      try { downloadCountAbortRef.current.abort(); } catch { /* already aborted */ }
      downloadCountAbortRef.current = null;
    }
  }

  useEffect(() => () => clearTimeout(persistTimerRef.current), []);

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

  const debugEntries = parseEntries(pipeline.substituteWithTypes(editorState.text)).entries;
  const effectiveStages = debugEntries
    .filter((e) => !e.disabled)
    .map((e) => e.stage);
  const resultsFiltered = pipelineReducesResultSet(effectiveStages);
  const writeStage = terminalWriteStage(effectiveStages);

  return (
    <div class="panel" style="display:flex;flex-direction:row" ref={panelRef}>
      <div class="data-panel-left" ref={leftRef}>
        <PipelineEditor
          editorRef={editorRef}
          initialValue={buildInitialPipeline()}
          onChange={handleEditorChange}
          onValidChange={handleValidChange}
          onLoadPipeline={handleLoadPipeline}
          onReset={handleReset}
          onToggleStage={handleToggleStage}
          onCursorStage={handleCursorStage}
        />
        {writeStage && (
          <div class="pipeline-write-banner">
            <span class="pipeline-write-msg">
              {'⚠'} This pipeline writes to <strong>{writeStage.target}</strong> ({writeStage.op}) and will not run automatically.
            </span>
            <button class="btn btn-sm btn-warning" onClick={() => runQuery({ explicitWrite: true })}>
              Run write pipeline{'…'}
            </button>
          </div>
        )}
        <PlaceholderInputs
          names={placeholderNames}
          values={pipeline.placeholderValues.value}
          types={pipeline.placeholderTypes.value}
          onSetValue={handleSetPlaceholder}
          onSetType={handleSetPlaceholderType}
          onRunQuery={runQuery}
          resolvedTypeFor={(name) => pipeline.resolvedTypeForName(name, editorState.fieldMap || {}, editorState.parsed != null)}
        />
        <PipelineDebug
          entries={debugEntries}
          onToggleStage={handleToggleStage}
          onInspectStage={handleInspectStage}
        />
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
          filtered={resultsFiltered}
          entries={debugEntries}
          onToggleStage={handleToggleStage}
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
          onEnterSelectionMode={handleEnterSelectionMode}
          onExitSelectionMode={handleExitSelectionMode}
          onBulkDelete={selectionMode.value ? handleBulkDeleteFromSelection : handleBulkDeleteFromToolbar}
          onBulkUpdate={selectionMode.value ? handleBulkUpdateFromSelection : handleBulkUpdateFromToolbar}
          onSelectPage={handleSelectPage}
          onClearSelection={handleClearSelection}
          onViewSelected={handleViewSelected}
        />
      </div>
      <StageLinkOverlay editorRef={editorRef} panelRef={panelRef} />
    </div>
  );
}
