import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import FileDropArea from './FileDropArea.jsx';
import JsonEditor from './JsonEditor.jsx';
import { CsvPreview, Segmented } from './ImportControls.jsx';
import ImportConfirm from './ImportConfirm.jsx';
import { ImportProgress, ImportSummary } from './ImportStages.jsx';
import { getFormat, detectFormat, ALL_ACCEPT } from '../formats/index.js';
import { runChunkedInsert, dedupeById, stripServerFields } from '../importFile.js';
import { deriveShape } from '../shape.js';
import * as api from '../api.js';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const SHAPE_SAMPLE = 500;
const SOURCE_SEG = [
  { value: 'file', label: 'File' },
  { value: 'clipboard', label: 'Clipboard' },
];

export default function ImportWizard({ onSuccess, fieldsFn }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [source, setSource] = useState('file');
  const [format, setFormat] = useState(null);
  const [fileMeta, setFileMeta] = useState(null);
  const [rawInput, setRawInput] = useState(null);
  const [clipboardText, setClipboardText] = useState(null);
  const [opts, setOpts] = useState({});
  const [parsed, setParsed] = useState(null);
  const [mode, setMode] = useState('insert');
  const [keys, setKeys] = useState([]);
  // Deliberately NOT persisted (owner decision 2026-07-04): every wizard opens
  // with shape validation ON; turning it off applies to that import only. A
  // legacy `mdhImportValidateShape` chrome.storage key from older builds is
  // orphaned, not read.
  const [validateShape, setValidateShape] = useState(true);
  const [shape, setShape] = useState(null);
  const [shapeLoading, setShapeLoading] = useState(false);
  const [shapeCount, setShapeCount] = useState(0);
  const [shapeCoversAll, setShapeCoversAll] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const parseToken = useRef(0);
  const abortRef = useRef(null);
  const editorRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const fmt = format ? getFormat(format) : null;
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  // ---- file pick (drop or click) ----
  function handleFile(fileObj) {
    setErrorMsg(null);
    const id = detectFormat(fileObj.name);
    if (!id) { setErrorMsg('Unsupported file — expected JSON, JSONL, CSV, Excel, or XML.'); return; }
    const f = getFormat(id);
    setFormat(id);
    setFileMeta({ name: fileObj.name, size: fileObj.size });
    const read = f.read === 'arrayBuffer' ? fileObj.arrayBuffer() : fileObj.text();
    read.then(async (input) => {
      setRawInput(input);
      const initialOpts = f.detectOpts ? { ...f.defaultOpts, ...f.detectOpts(input) } : f.defaultOpts;
      setOpts(initialOpts);
      if (f.ConfigureControls) { setStage(STAGE.CONFIGURE); return; }
      const res = await Promise.resolve(f.parse(input, initialOpts));
      if (res.error) { setErrorMsg(res.error.message); return; }
      if (!res.docs.length) { setErrorMsg('File contains no documents'); return; }
      setParsed(res);
      setKeys([]);
      setStage(STAGE.CONFIRM);
    }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
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
    setStage(STAGE.CONFIRM);
  }

  // ---- configure: (re)parse on opts change, race-guarded ----
  useEffect(() => {
    if (stage !== STAGE.CONFIGURE || rawInput == null || !fmt) return undefined;
    const token = ++parseToken.current;
    Promise.resolve(fmt.parse(rawInput, opts))
      .then((res) => { if (token === parseToken.current) setParsed(res); })
      .catch((err) => { if (token === parseToken.current) setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message } }); });
    return undefined;
  }, [stage, rawInput, JSON.stringify(opts)]);

  function configureNext() {
    if (!parsed || parsed.error || !parsed.docs.length) return;
    setKeys([]);
    setStage(STAGE.CONFIRM);
  }

  // ---- confirm: derive the existing collection's shape from a RANDOM sample
  // ($sample — F1), falling back to the old first-N find so shape validation
  // never silently disappears if aggregation is unavailable. ----
  async function fetchShapeSample(collection) {
    try {
      const res = await api.aggregate(collection, [{ $sample: { size: SHAPE_SAMPLE } }]);
      return res?.result || [];
    } catch {
      const res = await api.find(collection, { limit: SHAPE_SAMPLE });
      return res?.result || [];
    }
  }

  useEffect(() => {
    if (stage !== STAGE.CONFIRM) return undefined;
    let alive = true;
    setShapeLoading(true);
    fetchShapeSample(selectedCollection.value)
      .then((existing) => {
        if (!alive) return;
        setShape(existing.length ? deriveShape(existing) : null);
        setShapeCount(existing.length);
        // Fewer rows returned than requested => the sample exhausted the
        // collection, so the check covered ALL existing records.
        setShapeCoversAll(existing.length > 0 && existing.length < SHAPE_SAMPLE);
        setShapeLoading(false);
      })
      .catch(() => { if (alive) { setShape(null); setShapeCount(0); setShapeCoversAll(false); setShapeLoading(false); } });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);

  // ---- import ----
  async function startImport() {
    setErrorMsg(null);
    const docs = parsed.docs;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (mode === 'insert') {
        setStage(STAGE.IMPORTING);
        setImportProgress({ phase: 'insert', processed: 0, total: docs.length });
        const { kept } = dedupeById(docs);
        const r = await runChunkedInsert(selectedCollection.value, kept, { signal: ctrl.signal, onProgress: setImportProgress });
        setImportResult({ kind: 'insert', inserted: r.inserted, applied: 0, deleted: 0, skipped: 0, failedBatches: r.failedBatches, cancelled: r.cancelled });
        if (r.inserted > 0) onSuccess?.();
      } else {
        setStage(STAGE.IMPORTING);
        const startedAt = Date.now();
        setImportProgress({ phase: 'uploading', indeterminate: true, elapsedMs: 0 });
        const blob = new Blob([JSON.stringify(stripServerFields(docs))], { type: 'application/json' });
        const { operationId } = mode === 'update'
          ? await api.datasetUpdate(selectedCollection.value, blob, keys, { signal: ctrl.signal })
          : await api.datasetReplace(selectedCollection.value, blob, { signal: ctrl.signal });
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
    } catch (err) {
      if (ctrl.signal.aborted) {
        // User cancelled. An Update/Replace request may already be running on the
        // server (it can't be recalled), so report a neutral cancelled state
        // rather than "Import failed".
        setImportResult({ kind: mode, sent: docs.length, serverManaged: true, ok: false, cancelled: true, failedBatches: [] });
        setStage(STAGE.DONE);
      } else {
        setErrorMsg(`Import failed: ${err.message}`);
        setStage(STAGE.CONFIRM);
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
  function switchSource(v) {
    setErrorMsg(null);
    setSource(v);
    resetFileInput();
  }

  // ---- back navigation ----
  function configureBack() {
    setErrorMsg(null);
    resetFileInput();
    setStage(STAGE.PICK);
  }

  function confirmBack() {
    setErrorMsg(null);
    // Re-parsing with different options can change the column set, so match
    // keys reset (they're re-defaulted to [] on every forward transition too).
    setKeys([]);
    if (source === 'file' && fmt?.ConfigureControls) { setStage(STAGE.CONFIGURE); return; }
    resetFileInput();
    setStage(STAGE.PICK);
  }

  // ---- render ----
  return (
    <div class="modal-body import-wizard">
      {stage === STAGE.PICK && (
        <Fragment>
          <Segmented value={source} options={SOURCE_SEG} onChange={switchSource} ariaLabel="Import source" testid="import-source" tabs />
          {source === 'file' ? (
            <Fragment>
              <div class="modal-field-label" style="margin-top:10px">Drop a file or click to choose:</div>
              <FileDropArea accept={ALL_ACCEPT} onFile={handleFile} onReject={setErrorMsg} inputTestid="import-file-input">
                <div class="file-input-label">Click to select a file</div>
                <div class="file-input-info" style="margin-top:4px">JSON {'·'} JSONL {'·'} CSV {'·'} Excel {'·'} XML</div>
              </FileDropArea>
            </Fragment>
          ) : (
            <Fragment>
              <div class="modal-field-label" style="margin-top:10px">Paste or type JSON (array, object, or JSON-lines):</div>
              <JsonEditor value={clipboardText ?? '[\n  \n]'} minHeight="200px" fields={fieldsFn} editorRef={editorRef} jsonLines />
            </Fragment>
          )}
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
          <div class="modal-actions">
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            {source === 'clipboard' && (
              <button class="btn btn-primary" data-testid="clipboard-next" onClick={clipboardNext}>Next {'→'}</button>
            )}
          </div>
        </Fragment>
      )}

      {stage === STAGE.CONFIGURE && fmt && fmt.ConfigureControls && (
        <Fragment>
          <fmt.ConfigureControls opts={opts} setOpt={setOpt} parsed={parsed} />
          <CsvPreview parsed={parsed} />
          <div class="modal-actions">
            <button class="btn btn-secondary" style="margin-right:auto" data-testid="configure-back" onClick={configureBack}>{'←'} Back</button>
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-primary" data-testid="import-next" disabled={!parsed || !!parsed.error || !parsed.docs.length} onClick={configureNext}>Next {'→'}</button>
          </div>
        </Fragment>
      )}

      {stage === STAGE.CONFIRM && parsed && (
        <Fragment>
          <ImportConfirm
            fileMeta={fileMeta}
            docs={parsed.docs}
            mode={mode} setMode={setMode}
            keys={keys} setKeys={setKeys}
            validateShape={validateShape} setValidateShape={setValidateShape}
            shape={shape} shapeLoading={shapeLoading} shapeCount={shapeCount} shapeCoversAll={shapeCoversAll}
            onImport={startImport} onCancel={closeModal} onBack={confirmBack}
          />
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
        </Fragment>
      )}

      {stage === STAGE.IMPORTING && importProgress && (
        <ImportProgress progress={importProgress} onCancel={() => abortRef.current?.abort()} />
      )}

      {stage === STAGE.DONE && importResult && (
        <ImportSummary result={importResult} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}
