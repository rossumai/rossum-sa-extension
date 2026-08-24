import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { track } from '../../usage/track.js';
import { selectedCollection } from '../store.js';
import { closeModal, setModalTitle, ModalBody, ModalActions, ModalFieldLabel, ModalFileTitle } from './Modal.jsx';
import FileDropArea from './FileDropArea.jsx';
import JsonEditor from './JsonEditor.jsx';
import { CsvPreview, JsonPreview, Segmented } from './ImportControls.jsx';
import ImportConfirm from './ImportConfirm.jsx';
import { ImportProgress, ImportSummary, formatBytes } from './ImportStages.jsx';
import { getFormat, detectFormat, ALL_ACCEPT } from '../formats/index.js';
import { runChunkedInsert, dedupeById, stripServerFields } from '../importFile.js';
import { deriveShape } from '../shape.js';
import { restoreDocs, formatRestoreSummary } from '../restoreValues.js';
import * as api from '../api.js';
import type { JsonEditorHandle } from './JsonEditor.jsx';

const STAGE = { PICK: 'pick', DECIDE: 'decide', IMPORTING: 'importing', DONE: 'done' };
const SHAPE_SAMPLE = 500;
const SOURCE_SEG = [
  { value: 'file', label: 'File' },
  { value: 'clipboard', label: 'Clipboard' },
];

// The picked file's identity + shape, rendered into the modal header (frees
// body space). Filename is emphasized; size/rows/columns follow as muted meta.
function sourceTitle(fileMeta: any, parsed: any) {
  const bits = [];
  if (fileMeta?.size != null) bits.push(formatBytes(fileMeta.size));
  bits.push(`${parsed.docs.length.toLocaleString()} row${parsed.docs.length === 1 ? '' : 's'}`);
  if ((parsed.columns || []).length > 0) bits.push(`${parsed.columns.length} column${parsed.columns.length === 1 ? '' : 's'}`);
  return (
    <ModalFileTitle name={fileMeta?.name} meta={bits.join(' · ')} />
  );
}

export default function ImportWizard(
  { onSuccess, fieldsFn }: { onSuccess?: () => unknown; fieldsFn?: () => any },
) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [source, setSource] = useState('file');
  const [format, setFormat] = useState<any>(null);
  const [fileMeta, setFileMeta] = useState<any>(null);
  const [rawInput, setRawInput] = useState<any>(null);
  const [clipboardText, setClipboardText] = useState<any>(null);
  const [opts, setOpts] = useState<Record<string, any>>({});
  const [parsed, setParsed] = useState<any>(null);
  const [mode, setMode] = useState('insert');
  const [keys, setKeys] = useState<any[]>([]);
  // Silent-pass/loud-fail: the shape check ALWAYS runs; a mismatch can be
  // overridden per-import from inside the error card. Never persisted
  // (owner decision 2026-07-04); the legacy `mdhImportValidateShape` key
  // stays orphaned.
  const [shapeOverride, setShapeOverride] = useState(false);
  const [shapeError, setShapeError] = useState(false);
  const [shape, setShape] = useState<any>(null);
  // Starts true, not false: ImportConfirm only mounts once stage===DECIDE, at
  // which point the shape-sampling effect below always fires — so there is no
  // real "we haven't decided to check yet" state to distinguish from loading.
  // Defaulting to false left a one-tick gap, before that effect's own
  // setShapeLoading(true) runs, where the confirm button (and the restore
  // summary) briefly read as if there were no reference shape at all — a
  // regression the "Replace" routing tests below caught via a genuine
  // enabled→disabled→enabled flicker once the button started gating on it.
  const [shapeLoading, setShapeLoading] = useState(true);
  const [shapeCount, setShapeCount] = useState(0);
  const [shapeCoversAll, setShapeCoversAll] = useState(false);
  const [importProgress, setImportProgress] = useState<any>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const parseToken = useRef(0);
  const lastParsedOptsRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  const editorRef = useRef<JsonEditorHandle | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Surface the picked file (name · size · rows · columns) in the modal header
  // so the Decide body stays compact; reverts to "Import" before a file exists
  // or after Back. Guarded no-op when rendered outside a modal.
  useEffect(() => {
    setModalTitle(fileMeta && parsed ? sourceTitle(fileMeta, parsed) : 'Import');
  }, [fileMeta?.name, fileMeta?.size, parsed?.docs?.length, parsed?.columns?.length]);

  const fmt = format ? getFormat(format) : null;
  const setOpt = (k: any, v: any) => setOpts((o) => ({ ...o, [k]: v }));

  // Inference is layer 3 and must lose to the collection's own types, so it is
  // relocated out of the parser into restoreDocs whenever restore is on.
  const parseOpts = (o: Record<string, any>) => (o.restoreValues ? { ...o, inferTypes: false } : o);

  // ---- file pick (drop or click) ----
  function handleFile(fileObj: any) {
    setErrorMsg(null);
    const id = detectFormat(fileObj.name);
    if (!id) { setErrorMsg('Unsupported file — expected JSON, JSONL, CSV, Excel, or XML.'); return; }
    const f = getFormat(id);
    setFormat(id);
    setFileMeta({ name: fileObj.name, size: fileObj.size });
    const read = f.read === 'arrayBuffer' ? fileObj.arrayBuffer() : fileObj.text();
    read.then(async (input: any) => {
      setRawInput(input);
      const initialOpts = f.detectOpts ? { ...f.defaultOpts, ...f.detectOpts(input) } : f.defaultOpts;
      setOpts(initialOpts);
      lastParsedOptsRef.current = JSON.stringify(initialOpts);
      const res = await Promise.resolve(f.parse(input, parseOpts(initialOpts)));
      if (!f.ConfigureControls) {
        // No parsing options to fix on the Decide screen — errors stay here.
        if (res.error) { setErrorMsg(res.error.message); return; }
        if (!res.docs.length) { setErrorMsg('File contains no documents'); return; }
      }
      setParsed(res);
      setKeys([]);
      setShapeOverride(false);
      setStage(STAGE.DECIDE);
    }).catch((err: any) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }

  // ---- clipboard next: parse the editor's raw text as JSON / JSON-lines ----
  function clipboardNext() {
    setErrorMsg(null);
    const raw = editorRef.current?.getValue?.() ?? '';
    const text = raw.trim();
    if (!text) { setErrorMsg('No documents to import'); return; }
    const res = getFormat('json').parse(text);
    if (res.error) { setErrorMsg(res.error.message); return; }
    if (!res.docs.length) { setErrorMsg('No documents to import'); return; }
    setClipboardText(raw); // restored into the editor when the user comes Back
    setFormat('json');
    setFileMeta({ name: 'Pasted data', size: null });
    setParsed(res);
    setKeys([]);
    setShapeOverride(false);
    setStage(STAGE.DECIDE);
  }

  // Re-parse on parsing-option change (Decide screen, configurable formats
  // only). The initial parse happens in handleFile; the ref-compare skips a
  // redundant duplicate parse on mount.
  useEffect(() => {
    if (stage !== STAGE.DECIDE || rawInput == null || !fmt?.ConfigureControls) return undefined;
    const optsKey = JSON.stringify(opts);
    if (optsKey === lastParsedOptsRef.current) return undefined;
    lastParsedOptsRef.current = optsKey;
    const token = ++parseToken.current;
    Promise.resolve(fmt.parse(rawInput, parseOpts(opts)))
      .then((res) => { if (token === parseToken.current) { setParsed(res); setKeys([]); setShapeOverride(false); } })
      .catch((err) => { if (token === parseToken.current) setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message } }); });
    return undefined;
  }, [stage, rawInput, JSON.stringify(opts)]);

  // ---- confirm: derive the existing collection's shape from a RANDOM sample
  // ($sample — F1), falling back to the old first-N find so shape validation
  // never silently disappears if aggregation is unavailable. ----
  async function fetchShapeSample(collection: any) {
    try {
      const res = await api.aggregate(collection, [{ $sample: { size: SHAPE_SAMPLE } }]);
      return res?.result || [];
    } catch {
      const res = await api.find(collection, { limit: SHAPE_SAMPLE });
      return res?.result || [];
    }
  }

  useEffect(() => {
    if (stage !== STAGE.DECIDE) return undefined;
    let alive = true;
    setShapeLoading(true);
    setShapeError(false);
    setShapeOverride(false);
    fetchShapeSample(selectedCollection.value as string)
      .then((existing) => {
        if (!alive) return;
        setShape(existing.length ? deriveShape(existing) : null);
        setShapeCount(existing.length);
        // Fewer rows returned than requested => the sample exhausted the
        // collection, so the check covered ALL existing records.
        setShapeCoversAll(existing.length > 0 && existing.length < SHAPE_SAMPLE);
        setShapeLoading(false);
      })
      .catch(() => { if (alive) { setShapeError(true); setShape(null); setShapeCount(0); setShapeCoversAll(false); setShapeLoading(false); } });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);

  // ONE source of truth: the preview, the shape check and the upload all read
  // these docs, so what the user sees is exactly what gets written.
  const restored = useMemo(() => {
    if (!parsed) return null;
    if (!opts.restoreValues) return { docs: parsed.docs, summary: null };
    const r = restoreDocs(parsed.docs, shape, { inferTypes: !!opts.inferTypes });
    return { docs: r.docs, summary: r.summary };
  }, [parsed, shape, opts.restoreValues, opts.inferTypes]);

  const importDocs = restored?.docs ?? [];
  // While the shape sample is still loading, `shape` is null — indistinguishable
  // from "the collection is empty" — so the summary must wait rather than
  // assert an emptiness that isn't known yet (same root cause as the confirm
  // button gate below).
  const restoreSummary = restored?.summary && !shapeLoading
    ? formatRestoreSummary(restored.summary, { hasShape: !!shape, shapeError })
    : null;

  // ---- import ----
  async function startImport() {
    track('sa_mdh_import');
    setErrorMsg(null);
    const docs = importDocs;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (mode === 'insert') {
        setStage(STAGE.IMPORTING);
        setImportProgress({ phase: 'insert', processed: 0, total: docs.length });
        const { kept } = dedupeById(docs);
        const r = await runChunkedInsert(selectedCollection.value as string, kept, { signal: ctrl.signal, onProgress: setImportProgress });
        setImportResult({ kind: 'insert', inserted: r.inserted, applied: 0, deleted: 0, skipped: 0, failedBatches: r.failedBatches, cancelled: r.cancelled });
        if (r.inserted > 0) onSuccess?.();
      } else {
        setStage(STAGE.IMPORTING);
        const startedAt = Date.now();
        setImportProgress({ phase: 'uploading', indeterminate: true, elapsedMs: 0 });
        const blob = new Blob([JSON.stringify(stripServerFields(docs))], { type: 'application/json' });
        const { operationId } = mode === 'update'
          ? await api.datasetUpdate(selectedCollection.value as string, blob, keys, { signal: ctrl.signal })
          : await api.datasetReplace(selectedCollection.value as string, blob, { signal: ctrl.signal });
        let checks = 0;
        setImportProgress({ phase: 'processing', indeterminate: true, elapsedMs: Date.now() - startedAt });
        // Feed each server poll into the progress UI so the user sees a live
        // heartbeat (status + check count + elapsed) instead of a frozen bar.
        await api.waitForDatasetOperation(operationId, {
          signal: ctrl.signal,
          onPoll: (op) => {
            checks += 1;
            const queued = op.status === 'queued' || op.status === 'new';
            setImportProgress({
              phase: queued ? 'uploading' : 'processing',
              indeterminate: true,
              status: op.status,
              checks,
              elapsedMs: Date.now() - startedAt,
              file: op.file_metadata ? { filename: op.file_metadata.filename, size: op.file_metadata.file_size } : null,
            });
          },
        });
        setImportResult({ kind: mode, sent: docs.length, serverManaged: true, ok: true, failedBatches: [] });
        onSuccess?.();
      }
      setStage(STAGE.DONE);
    } catch (err: any) {
      if (ctrl.signal.aborted) {
        // User cancelled. An Update/Replace request may already be running on the
        // server (it can't be recalled), so report a neutral cancelled state
        // rather than "Import failed".
        setImportResult({ kind: mode, sent: docs.length, serverManaged: true, ok: false, cancelled: true, failedBatches: [] });
        setStage(STAGE.DONE);
      } else {
        setErrorMsg(`Import failed: ${err.message}`);
        setStage(STAGE.DECIDE);
      }
    } finally {
      abortRef.current = null;
    }
  }

  // Clear the picked-file state (shared by source toggling and Back-to-Pick).
  // clipboardText deliberately survives so the editor restores what was typed.
  function resetFileInput() {
    setFormat(null);
    setRawInput(null);
    setOpts({});
    setFileMeta(null);
    setParsed(null);
  }

  // Reset source-specific input when toggling, so a half-finished pick in one
  // source never lingers behind the other.
  function switchSource(v: any) {
    setErrorMsg(null);
    setSource(v);
    resetFileInput();
  }

  // ---- back navigation ----
  function decideBack() {
    setErrorMsg(null);
    setKeys([]);
    setShapeOverride(false);
    resetFileInput();
    setStage(STAGE.PICK);
  }

  // ---- render ----
  return (
    <ModalBody class="import-wizard">
      {stage === STAGE.PICK && (
        <Fragment>
          <Segmented value={source} options={SOURCE_SEG} onChange={switchSource} ariaLabel="Import source" testid="import-source" tabs />
          {source === 'file' ? (
            <FileDropArea accept={ALL_ACCEPT} onFile={handleFile} onReject={setErrorMsg} inputTestid="import-file-input">
              <div class="file-input-label">Drop a file here or click to choose</div>
              <div class="file-input-info" style="margin-top:4px">JSON {'·'} JSONL {'·'} CSV {'·'} Excel {'·'} XML</div>
            </FileDropArea>
          ) : (
            <Fragment>
              <ModalFieldLabel style="margin-top:10px">Paste JSON {'—'} array, object, or JSON-lines</ModalFieldLabel>
              <JsonEditor value={clipboardText ?? '[\n  \n]'} minHeight="200px" fields={fieldsFn} editorRef={editorRef} jsonLines />
            </Fragment>
          )}
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
          <ModalActions>
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            {source === 'clipboard' && (
              <button class="btn btn-primary" data-testid="clipboard-next" onClick={clipboardNext}>Next {'→'}</button>
            )}
          </ModalActions>
        </Fragment>
      )}

      {stage === STAGE.DECIDE && parsed && (
        <Fragment>
          {fmt?.ConfigureControls && (
            <div class="parse-strip" data-testid="parse-strip">
              <fmt.ConfigureControls opts={opts} setOpt={setOpt} parsed={parsed} />
            </div>
          )}
          {(parsed.error || (parsed.columns || []).length > 0)
            ? (
              <CsvPreview
                parsed={{ ...parsed, docs: importDocs, warnings: [...(parsed.warnings || []), ...(restored?.summary?.warnings || [])] }}
                nested={!!opts.restoreValues}
              />
            )
            : <JsonPreview docs={importDocs} />}
          {(parsed.error || !importDocs.length) ? (
            <ModalActions>
              <button class="btn btn-secondary" style="margin-right:auto" data-testid="import-back" onClick={decideBack}>{'←'} Back</button>
              <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            </ModalActions>
          ) : (
            <ImportConfirm
              docs={importDocs}
              mode={mode} setMode={setMode}
              keys={keys} setKeys={setKeys}
              shapeOverride={shapeOverride} setShapeOverride={setShapeOverride}
              shape={shape} shapeLoading={shapeLoading} shapeError={shapeError}
              shapeCount={shapeCount} shapeCoversAll={shapeCoversAll}
              restoreSummary={restoreSummary}
              onImport={startImport} onCancel={closeModal} onBack={decideBack}
            />
          )}
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
        </Fragment>
      )}

      {stage === STAGE.IMPORTING && importProgress && (
        <ImportProgress progress={importProgress} onCancel={() => abortRef.current?.abort()} />
      )}

      {stage === STAGE.DONE && importResult && (
        <ImportSummary result={importResult} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </ModalBody>
  );
}
