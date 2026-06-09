import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
import { Segmented, Toggle, CsvPreview } from './CsvImportWizard.jsx';
import { parseXlsx } from '../xlsx.js';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const DEFAULT_OPTS = { sheet: null, hasHeader: true, emptyMode: 'null' };
const EMPTY_SEG = [
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

export default function XlsxImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [parsed, setParsed] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  const parseToken = useRef(0);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Async (re)parse on buffer / option change, with a race guard.
  useEffect(() => {
    if (!buffer) return undefined;
    const token = ++parseToken.current;
    setParsing(true);
    parseXlsx(buffer, { sheet: opts.sheet, hasHeader: opts.hasHeader, emptyMode: opts.emptyMode })
      .then((res) => { if (token === parseToken.current) { setParsed(res); setParsing(false); } })
      .catch((err) => { if (token === parseToken.current) { setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message }, sheets: [] }); setParsing(false); } });
    return undefined;
  }, [buffer, opts.sheet, opts.hasHeader, opts.emptyMode]);

  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.arrayBuffer().then((buf) => { setBuffer(buf); setStage(STAGE.CONFIGURE); })
      .catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }

  function handleNext() {
    if (!parsed || parsed.error || parsed.docs.length === 0) return;
    setStats(analyzeDocs(parsed.docs));
    setErrorMsg(null);
    setStage(STAGE.CONFIRM);
  }

  async function startImport() {
    if (!parsed) return;
    setErrorMsg(null);
    const { kept, dropped: inFileDropped } = dedupeById(parsed.docs);
    setStage(STAGE.IMPORTING);
    const controller = new AbortController();
    abortRef.current = controller;
    setImportProgress({ phase: 'insert', processed: 0, total: kept.length, inserted: 0, failedBatches: 0 });
    try {
      let result;
      if (mode === 'overwrite' && stats.uniqueIdCount > 0) {
        result = await runChunkedOverwrite(selectedCollection.value, kept, { signal: controller.signal, onProgress: (p) => setImportProgress({ ...p, total: kept.length }) });
        result.kind = 'overwrite';
      } else {
        result = await runChunkedInsert(selectedCollection.value, kept, { signal: controller.signal, onProgress: setImportProgress });
        result.kind = 'insert';
      }
      result.inFileDropped = inFileDropped;
      setImportResult(result);
      if (result.inserted > 0 || result.deleted > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally { abortRef.current = null; }
  }

  return (
    <div class="modal-body import-wizard xlsx-import-wizard">
      {stage === STAGE.PICK && <XlsxStagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}
      {stage === STAGE.CONFIGURE && (
        <XlsxStageConfigure fileMeta={fileMeta} opts={opts} setOpt={setOpt} parsed={parsed} parsing={parsing} onNext={handleNext} onCancel={closeModal} />
      )}
      {stage === STAGE.CONFIRM && stats && (
        <StageConfirm fileMeta={fileMeta} stats={stats} mode={mode} setMode={setMode} errorMsg={errorMsg} onImport={startImport} onCancel={closeModal} />
      )}
      {stage === STAGE.IMPORTING && importProgress && (
        <StageImporting progress={importProgress} mode={mode} onCancel={() => abortRef.current?.abort()} />
      )}
      {stage === STAGE.DONE && importResult && (
        <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}

function XlsxStagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) { const f = e.target.files?.[0]; if (f) onFile(f); }
  return (
    <Fragment>
      <div class="modal-field-label">Select an Excel file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <input ref={inputRef} type="file" accept=".xlsx" style="display:none" onChange={pick} data-testid="xlsx-file-input" />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select an Excel (.xlsx) file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document. Date cells import as their Excel serial number.</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}

function XlsxStageConfigure({ fileMeta, opts, setOpt, parsed, parsing, onNext, onCancel }) {
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  const sheets = parsed?.sheets || [];
  const canNext = clean && parsed.docs.length > 0;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="xlsx-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        <span class="toolbar-menu-beta">beta</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> row{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> column{cols === 1 ? '' : 's'}</span>}
      </div>

      <div class="csv-toolbar">
        {sheets.length > 1 && (
          <span class="csv-tb-item">
            <span class="csv-tb-k" title="Which worksheet to import.">Sheet</span>
            <select class="xlsx-sheet-select" data-testid="xlsx-sheet" value={opts.sheet ?? sheets[0]} onChange={(e) => setOpt('sheet', e.target.value)}>
              {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </span>
        )}
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Use row 1 as field names.">First row is a header</span>
          <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="xlsx-header" title="Use row 1 as field names." />
        </span>
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="What an empty cell becomes.">Empty cell {'→'}</span>
          <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="xlsx-empty" ariaLabel="Empty cell" onChange={(v) => setOpt('emptyMode', v)} />
        </span>
      </div>
      <div class="csv-opt-hint">Excel date cells import as their underlying serial number.</div>

      {parsing && !parsed
        ? <div class="csv-preview-empty">Reading{'…'}</div>
        : <CsvPreview parsed={parsed} />}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="xlsx-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}
