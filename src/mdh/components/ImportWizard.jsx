import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import FileDropArea from './FileDropArea.jsx';
import JsonEditor from './JsonEditor.jsx';
import { CsvPreview, Segmented } from './ImportControls.jsx';
import ImportConfirm, { defaultKeysFor } from './ImportConfirm.jsx';
import { ImportProgress, ImportSummary } from './ImportStages.jsx';
import { getFormat, detectFormat, ALL_ACCEPT } from '../formats/index.js';
import { runChunkedInsert, dedupeById } from '../importFile.js';
import { deriveShape } from '../shape.js';
import { estimateMatches } from '../matchEstimate.js';
import * as api from '../api.js';

const VALIDATE_SHAPE_KEY = 'mdhImportValidateShape';
function readValidateShapePref() { try { return globalThis.__mdhValidateShape !== false; } catch { return true; } }
function persistValidateShape(v) {
  try { globalThis.__mdhValidateShape = v; chrome?.storage?.local?.set?.({ [VALIDATE_SHAPE_KEY]: v }); } catch { /* no-op */ }
}

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
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
  const [opts, setOpts] = useState({});
  const [parsed, setParsed] = useState(null);
  const [mode, setMode] = useState('insert');
  const [keys, setKeys] = useState([]);
  const [validateShape, setValidateShape] = useState(readValidateShapePref());
  const [shape, setShape] = useState(null);
  const [shapeLoading, setShapeLoading] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const parseToken = useRef(0);
  const abortRef = useRef(null);
  const editorRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const fmt = format ? getFormat(format) : null;
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  // Hydrate validateShape from storage on mount
  useEffect(() => { try { chrome?.storage?.local?.get?.(VALIDATE_SHAPE_KEY, (r) => { if (r && typeof r[VALIDATE_SHAPE_KEY] === 'boolean') setValidateShape(r[VALIDATE_SHAPE_KEY]); }); } catch { /* no-op */ } }, []);

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
      setKeys(defaultKeysFor(res.docs));
      setStage(STAGE.CONFIRM);
    }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }

  // ---- clipboard next: parse the editor's raw text as JSON / JSON-lines ----
  function clipboardNext() {
    setErrorMsg(null);
    const text = (editorRef.current?.getValue?.() ?? '').trim();
    if (!text) { setErrorMsg('No documents to import'); return; }
    const res = getFormat('json').parse(text);
    if (res.error) { setErrorMsg(res.error.message); return; }
    if (!res.docs.length) { setErrorMsg('No documents to import'); return; }
    setFormat('json');
    setFileMeta({ name: 'Pasted data', size: null });
    setParsed(res);
    setKeys(defaultKeysFor(res.docs));
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
    setKeys(defaultKeysFor(parsed.docs));
    setStage(STAGE.CONFIRM);
  }

  // ---- confirm: sample the existing collection to derive its shape ----
  useEffect(() => {
    if (stage !== STAGE.CONFIRM) return undefined;
    let alive = true;
    setShapeLoading(true);
    api.find(selectedCollection.value, { limit: 500 })
      .then((res) => { if (!alive) return; const existing = res?.result || []; setShape(existing.length ? deriveShape(existing) : null); setShapeLoading(false); })
      .catch(() => { if (alive) { setShape(null); setShapeLoading(false); } });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);

  // ---- confirm (Update only): estimate the matched-vs-insert split by the
  // chosen match key. Read-only, debounced, stale-guarded. ----
  const estKeysKey = keys.join(' ');
  useEffect(() => {
    if (stage !== STAGE.CONFIRM || mode !== 'update' || keys.length === 0 || !parsed) {
      setEstimate(null); setEstimateLoading(false);
      return undefined;
    }
    let alive = true;
    setEstimateLoading(true);
    const timer = setTimeout(() => {
      estimateMatches(selectedCollection.value, parsed.docs, keys, api.find)
        .then((r) => { if (alive) { setEstimate(r); setEstimateLoading(false); } })
        .catch(() => { if (alive) { setEstimate(null); setEstimateLoading(false); } });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [stage, mode, estKeysKey, parsed]);

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
        const blob = new Blob([JSON.stringify(docs)], { type: 'application/json' });
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

  // Reset source-specific input when toggling, so a half-finished pick in one
  // source never lingers behind the other.
  function switchSource(v) {
    setErrorMsg(null);
    setSource(v);
    setFormat(null);
    setRawInput(null);
    setOpts({});
    setFileMeta(null);
    setParsed(null);
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
              <JsonEditor value={'[\n  \n]'} minHeight="200px" fields={fieldsFn} editorRef={editorRef} />
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
            validateShape={validateShape} setValidateShape={(v) => { setValidateShape(v); persistValidateShape(v); }}
            shape={shape} shapeLoading={shapeLoading}
            estimate={estimate} estimateLoading={estimateLoading}
            onImport={startImport} onCancel={closeModal}
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
