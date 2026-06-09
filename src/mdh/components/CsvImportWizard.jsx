import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
import { parseCsv } from '../csv.js';

// Multi-stage "Insert from CSV file" flow:
//
//   pick → configure → confirm → importing → done
//
// CSV has no types, so the Configure stage exposes dialect + conversion options
// and shows a live preview of the resulting JSON. Once parsed into row objects,
// the confirm/importing/done stages and the insert itself are identical to the
// JSON importer (shared StageConfirm/StageImporting/StageDone + runChunkedInsert).

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };

const DEFAULT_OPTS = {
  delimiter: ',',
  quoteChar: '"',
  escapeChar: '',
  doubleQuote: true,
  encoding: 'utf-8',
  hasHeader: true,
  inferTypes: false,
  emptyMode: 'empty',
  skipEmptyLines: true,
  trim: false,
};

export default function CsvImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  function handleCancel() {
    abortRef.current?.abort();
  }

  // parseCsv needs escapeChar:null when the field is blank ('' means "none").
  const parsed = useMemo(() => {
    if (!buffer) return null;
    return parseCsv(buffer, { ...opts, escapeChar: opts.escapeChar || null });
  }, [buffer, opts]);

  const setOpt = (key, value) => setOpts((o) => ({ ...o, [key]: value }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.arrayBuffer().then((buf) => {
      setBuffer(buf);
      setStage(STAGE.CONFIGURE);
    }).catch((err) => {
      setErrorMsg(`Couldn't read file: ${err.message}`);
    });
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
        result = await runChunkedOverwrite(selectedCollection.value, kept, {
          signal: controller.signal,
          onProgress: (p) => setImportProgress({ ...p, total: kept.length }),
        });
        result.kind = 'overwrite';
      } else {
        result = await runChunkedInsert(selectedCollection.value, kept, {
          signal: controller.signal,
          onProgress: setImportProgress,
        });
        result.kind = 'insert';
      }
      result.inFileDropped = inFileDropped;
      setImportResult(result);
      if (result.inserted > 0 || result.deleted > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <div class="modal-body import-wizard csv-import-wizard">
      {stage === STAGE.PICK && <CsvStagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}

      {stage === STAGE.CONFIGURE && (
        <CsvStageConfigure
          fileMeta={fileMeta}
          opts={opts}
          setOpt={setOpt}
          parsed={parsed}
          onNext={handleNext}
          onCancel={closeModal}
        />
      )}

      {stage === STAGE.CONFIRM && stats && (
        <StageConfirm
          fileMeta={fileMeta}
          stats={stats}
          mode={mode}
          setMode={setMode}
          errorMsg={errorMsg}
          onImport={startImport}
          onCancel={closeModal}
        />
      )}

      {stage === STAGE.IMPORTING && importProgress && (
        <StageImporting progress={importProgress} mode={mode} onCancel={handleCancel} />
      )}

      {stage === STAGE.DONE && importResult && (
        <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}

function CsvStagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  }
  return (
    <Fragment>
      <div class="modal-field-label">Select a CSV file to insert:</div>
      <input ref={inputRef} type="file" accept=".csv,text/csv" style="display:none" onChange={pick} data-testid="csv-file-input" />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select a CSV file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document in the selected collection</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

// Segmented pill group. options: [{ value, label, title?, testid? }].
// `testid` (on the wrapper) is optional; per-option `testid` lands on each button.
export function Segmented({ value, options, onChange, testid, ariaLabel }) {
  return (
    <span class="csv-seg" role="group" aria-label={ariaLabel} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={`csv-seg-opt${o.value === value ? ' on' : ''}`}
          title={o.title}
          data-testid={o.testid}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >{o.label}</button>
      ))}
    </span>
  );
}

// Toggle switch backed by an accessible button. Forwards `testid` to the button.
export function Toggle({ checked, onChange, title, testid }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      data-testid={testid}
      class={`csv-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span class="csv-switch-knob"></span>
    </button>
  );
}

// Delimiter pills (comma / semicolon / tab — matches the export modal).
const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'csv-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'csv-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'csv-delim-tab' },
];

const ENCODING_SEG = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1252', label: '1252' },
  { value: 'iso-8859-1', label: 'Latin-1' },
  { value: 'utf-16le', label: 'UTF-16' },
];

const EMPTY_SEG = [
  { value: 'empty', label: '""', title: 'Empty string' },
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

function CsvOptions({ opts, setOpt }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div data-testid="csv-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Character between fields.">Delimiter</span>
          <Segmented
            value={opts.delimiter}
            options={DELIM_SEG}
            onChange={(v) => setOpt('delimiter', v)}
            ariaLabel="Delimiter"
          />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Use row 1 as field names. Off → fields named column_1, column_2, …">First row is a header</span>
          <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="csv-header"
            title="Use row 1 as field names." />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Off → every value is a string (keeps leading zeros / IDs). On → detect numbers and true/false.">Infer types</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="csv-infer"
            title="Detect numbers and true/false." />
        </span>

        <button type="button" class="csv-adv-toggle" data-testid="csv-advanced-toggle"
          aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
          Advanced {advancedOpen ? '▴' : '▾'}
        </button>
      </div>

      {advancedOpen && (
        <div class="csv-advanced" data-testid="csv-advanced">
          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Encoding</span>
              <Segmented value={opts.encoding} options={ENCODING_SEG} testid="csv-encoding"
                ariaLabel="Encoding" onChange={(v) => setOpt('encoding', v)} />
            </span>
            <div class="csv-opt-hint">Pick a legacy encoding if accented characters look garbled.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Empty cell {'→'}</span>
              <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="csv-empty"
                ariaLabel="Empty cell" onChange={(v) => setOpt('emptyMode', v)} />
            </span>
            <div class="csv-opt-hint">What an empty cell becomes in the document.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Trim values</span>
              <Toggle checked={opts.trim} onChange={(v) => setOpt('trim', v)} testid="csv-trim" />
            </span>
            <div class="csv-opt-hint">Strip leading/trailing whitespace around each value.</div>
          </div>
        </div>
      )}
    </div>
  );
}

// Configure stage. Shows the live preview (default dialect) and a Next button
// gated on a clean parse. CsvOptions controls mutate opts via setOpt, which
// re-runs the useMemo(parseCsv) in the parent and updates the preview live.
function CsvStageConfigure({ fileMeta, opts, setOpt, parsed, onNext, onCancel }) {
  const canNext = parsed && !parsed.error && parsed.docs.length > 0;
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="csv-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> row{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> column{cols === 1 ? '' : 's'}</span>}
      </div>

      <CsvOptions opts={opts} setOpt={setOpt} />

      <CsvPreview parsed={parsed} />

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="csv-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}

export function CsvPreview({ parsed, limit = 10 }) {
  if (!parsed) return null;
  const { columns = [], docs = [], warnings = [], error } = parsed;
  if (error) {
    return (
      <div class="csv-error" data-testid="csv-error">
        Parse error{error.line ? ` (line ${error.line})` : ''}: {error.message}
      </div>
    );
  }
  const shown = docs.slice(0, limit);
  return (
    <div class="csv-preview" data-testid="csv-preview">
      {docs.length > 0 && (
        <div class="csv-preview-caption">
          <span>Preview {'·'} first {Math.min(limit, docs.length)} of {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} {'·'} {columns.length} column{columns.length === 1 ? '' : 's'}</span>
          <span class="csv-preview-legend">
            <span class="csv-legend-num">123</span> number {'·'} <span class="csv-legend-str">text</span> {'·'} <span class="csv-legend-null">null</span>
          </span>
        </div>
      )}
      {docs.length === 0 ? (
        <div class="csv-preview-empty">No data rows found.</div>
      ) : (
        <div class="csv-preview-scroll">
          <table class="csv-preview-table">
            <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {shown.map((doc, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}><PreviewValue value={doc[c]} present={Object.prototype.hasOwnProperty.call(doc, c)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warnings.map((w, i) => <div key={i} class="csv-warning" data-testid="csv-warning">{'⚠'} {w}</div>)}
    </div>
  );
}

function PreviewValue({ value, present }) {
  if (!present) return <span class="csv-cell-missing" title="field omitted">{'—'}</span>;
  if (value === null) return <span class="csv-cell-null">null</span>;
  if (typeof value === 'number') return <span class="csv-cell-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="csv-cell-bool">{String(value)}</span>;
  if (value === '') return <span class="csv-cell-empty" title="empty string">(empty)</span>;
  return <span class="csv-cell-string">{value}</span>;
}
