import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
import { Toggle } from './CsvImportWizard.jsx';
import { parseXml } from '../xml.js';
import FileDropArea from './FileDropArea.jsx';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const DEFAULT_OPTS = { recordKey: null, inferTypes: false };

export default function XmlImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [text, setText] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const parsed = useMemo(() => (text == null ? null : parseXml(text, { recordKey: opts.recordKey, inferTypes: opts.inferTypes })), [text, opts.recordKey, opts.inferTypes]);
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.text().then((t) => { setText(t); setStage(STAGE.CONFIGURE); }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
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
    <div class="modal-body import-wizard xml-import-wizard">
      {stage === STAGE.PICK && <XmlStagePick onFile={handleFile} onReject={setErrorMsg} errorMsg={errorMsg} onCancel={closeModal} />}
      {stage === STAGE.CONFIGURE && <XmlStageConfigure fileMeta={fileMeta} opts={opts} setOpt={setOpt} parsed={parsed} onNext={handleNext} onCancel={closeModal} />}
      {stage === STAGE.CONFIRM && stats && <StageConfirm fileMeta={fileMeta} stats={stats} mode={mode} setMode={setMode} errorMsg={errorMsg} onImport={startImport} onCancel={closeModal} />}
      {stage === STAGE.IMPORTING && importProgress && <StageImporting progress={importProgress} mode={mode} onCancel={() => abortRef.current?.abort()} />}
      {stage === STAGE.DONE && importResult && <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />}
    </div>
  );
}

function XmlStagePick({ onFile, onReject, errorMsg, onCancel }) {
  return (
    <Fragment>
      <div class="modal-field-label">Select an XML file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <FileDropArea accept=".xml,text/xml,application/xml" onFile={onFile} onReject={onReject} inputTestid="xml-file-input">
        <div class="file-input-label">Click to select an XML file</div>
        <div class="file-input-info" style="margin-top:4px">Each repeating element becomes one document.</div>
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}

function XmlStageConfigure({ fileMeta, opts, setOpt, parsed, onNext, onCancel }) {
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  const candidates = parsed?.recordCandidates || [];
  const canNext = clean && parsed.docs.length > 0;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="xml-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        <span class="toolbar-menu-beta">beta</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> record{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> field{cols === 1 ? '' : 's'}</span>}
      </div>

      <div class="csv-toolbar">
        {candidates.length > 1 && (
          <span class="csv-tb-item">
            <span class="csv-tb-k" title="Which repeating element becomes one document.">Record element</span>
            <select class="xlsx-sheet-select" data-testid="xml-record" value={parsed?.recordKey ?? ''} onChange={(e) => setOpt('recordKey', e.target.value)}>
              {candidates.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </span>
        )}
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Off → every value is a string. On → detect numbers and true/false.">Infer types</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="xml-infer" title="Detect numbers and true/false." />
        </span>
      </div>
      <div class="csv-opt-hint">Attributes become @_-prefixed fields; namespace prefixes are stripped.</div>

      {parsed?.error && <div class="csv-error" data-testid="xml-error">XML parse error: {parsed.error.message}</div>}
      {clean && parsed.docs.length === 0 && <div class="csv-preview-empty">No records found {'—'} pick a different record element.</div>}
      {clean && parsed.docs.length > 0 && <XmlPreview parsed={parsed} />}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="xml-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}

function XmlPreview({ parsed, limit = 10 }) {
  const sample = parsed.docs.slice(0, limit);
  return (
    <div class="csv-preview" data-testid="xml-preview">
      <div class="csv-preview-caption">
        <span>Preview {'·'} first {Math.min(limit, parsed.docs.length)} of {parsed.docs.length.toLocaleString()} record{parsed.docs.length === 1 ? '' : 's'} {'·'} the documents that will be imported</span>
      </div>
      <pre class="csv-export-preview-text" data-testid="xml-preview-json">{JSON.stringify(sample, null, 2)}</pre>
      {parsed.warnings.map((w, i) => <div key={i} class="csv-warning" data-testid="xml-warning">{'⚠'} {w}</div>)}
    </div>
  );
}
