import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import {
  analyzeDocs,
  dedupeById,
  runChunkedInsert,
  runChunkedOverwrite,
} from '../importFile.js';

// Multi-stage Import from JSON File flow:
//
//   pick → confirm → importing → done
//
// We don't probe the collection for conflicting _ids before uploading —
// the user opted out of that. In-file deduplication still runs locally
// (free, no network) so the file itself never sends the same _id twice.
// Overwrite mode delegates conflict resolution to a deleteMany pass over
// every _id in the file (no-op for ids that don't exist server-side).

const STAGE = {
  PICK: 'pick',
  CONFIRM: 'confirm',
  IMPORTING: 'importing',
  DONE: 'done',
};

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatIdSample(ids, max = 3) {
  const out = [];
  for (let i = 0; i < ids.length && i < max; i++) {
    const v = ids[i];
    if (v && typeof v === 'object' && '$oid' in v) out.push(String(v.$oid));
    else if (typeof v === 'string') out.push(v.length > 12 ? v.slice(0, 12) + '…' : v);
    else out.push(String(v));
  }
  if (ids.length > max) out.push(`+${ids.length - max} more`);
  return out.join(', ');
}

export default function InsertFileWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [docs, setDocs] = useState(null);
  const [stats, setStats] = useState(null);
  const [mode, setMode] = useState('insert');   // 'insert' | 'overwrite'
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.text().then((text) => {
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) {
        setErrorMsg(`Couldn't parse JSON: ${e.message}`);
        return;
      }
      if (!Array.isArray(parsed)) parsed = [parsed];
      if (parsed.length === 0) {
        setErrorMsg('File contains no documents');
        return;
      }
      setDocs(parsed);
      setStats(analyzeDocs(parsed));
      setStage(STAGE.CONFIRM);
    }).catch((err) => {
      setErrorMsg(`Couldn't read file: ${err.message}`);
    });
  }

  async function startImport() {
    if (!docs) return;
    setErrorMsg(null);

    const { kept, dropped: inFileDropped } = dedupeById(docs);

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

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div class="modal-body import-wizard">
      {stage === STAGE.PICK && <StagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}

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

// ---- stage components ----

function StagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  }
  return (
    <Fragment>
      <div class="modal-field-label">Select a JSON file with documents to insert:</div>
      <input ref={inputRef} type="file" accept=".json,application/json" style="display:none" onChange={pick} />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select a JSON file</div>
        <div class="file-input-info" style="margin-top:4px">Array of documents, or a single document</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

function StageConfirm({ fileMeta, stats, mode, setMode, errorMsg, onImport, onCancel }) {
  const hasInFileDupes = stats.inFileDupeCount > 0;
  const hasIds = stats.withId > 0;
  const willInsert = stats.uniqueIdCount + stats.withoutId;

  return (
    <Fragment>
      <FileSummary fileMeta={fileMeta} stats={stats} />

      {hasInFileDupes && (
        <div class="import-conflict-info">
          <strong>{stats.inFileDupeCount.toLocaleString()}</strong> duplicate <code>_id</code>{stats.inFileDupeCount === 1 ? '' : 's'} within the file will be collapsed to one occurrence.
          {stats.inFileDupeIdSample.length > 0 && <div class="import-id-sample">e.g. {formatIdSample(stats.inFileDupeIdSample)}</div>}
        </div>
      )}

      {hasIds && (
        <div>
          <div class="modal-field-label">If a document's <code>_id</code> already exists in <code>{selectedCollection.value}</code>:</div>
          <div class="import-mode-group">
            <label class={`import-mode-option ${mode === 'insert' ? 'selected' : ''}`}>
              <input type="radio" name="import-mode" value="insert" checked={mode === 'insert'} onChange={() => setMode('insert')} />
              <span>
                <span class="import-mode-title">Insert (fail on duplicate)</span>
                <span class="import-mode-desc">Send the file as-is. Batches with conflicting <code>_id</code>s will be reported as failures in the summary.</span>
              </span>
            </label>
            <label class={`import-mode-option ${mode === 'overwrite' ? 'selected' : ''}`}>
              <input type="radio" name="import-mode" value="overwrite" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
              <span>
                <span class="import-mode-title">Overwrite</span>
                <span class="import-mode-desc">Delete any documents whose <code>_id</code> matches the file (no-op for <code>_id</code>s that don't exist), then insert all {willInsert.toLocaleString()} from the file. Idempotent re-import.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button
          class={`btn ${mode === 'overwrite' ? 'btn-danger' : 'btn-success'}`}
          onClick={onImport}
          disabled={willInsert === 0}
        >
          {mode === 'overwrite'
            ? `Overwrite ${willInsert.toLocaleString()} document${willInsert === 1 ? '' : 's'}`
            : `Insert ${willInsert.toLocaleString()} document${willInsert === 1 ? '' : 's'}`}
        </button>
      </div>
    </Fragment>
  );
}

function StageImporting({ progress, mode, onCancel }) {
  const { processed = 0, total = 0, inserted = 0, failedBatches = 0, phase } = progress;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const label = mode === 'overwrite' && phase === 'delete'
    ? 'Deleting any matching documents'
    : 'Inserting documents';
  return (
    <Fragment>
      <div class="modal-message">{label}…</div>
      <div class="import-progress">
        <div class="import-progress-track">
          <div class="import-progress-fill" style={`width:${pct}%`}></div>
        </div>
        <div class="import-progress-counts">
          <span>{processed.toLocaleString()} / {total.toLocaleString()}</span>
          <span>{pct}%</span>
        </div>
      </div>
      <div class="import-progress-meta">
        {phase !== 'delete' && <span>{inserted.toLocaleString()} inserted</span>}
        {failedBatches > 0 && <span style="color:var(--danger)">{failedBatches} batch{failedBatches === 1 ? '' : 'es'} failed</span>}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

function StageDone({ result, mode, fileMeta, onClose }) {
  const { inserted = 0, deleted = 0, failedBatches = [], inFileDropped = 0, cancelled, kind } = result;
  const overall = failedBatches.length === 0 && !cancelled;

  return (
    <Fragment>
      <div class={`import-result-header ${overall ? 'success' : 'partial'}`}>
        <span class="import-result-icon">{overall ? '✓' : cancelled ? '○' : '⚠'}</span>
        <span>
          {cancelled ? 'Cancelled' : overall ? 'Import complete' : 'Import partially complete'}
          {fileMeta?.name && <span class="import-result-filename"> · {fileMeta.name}</span>}
        </span>
      </div>

      <ul class="import-result-list">
        {kind === 'overwrite' && deleted > 0 && <li>Deleted <strong>{deleted.toLocaleString()}</strong> existing record{deleted === 1 ? '' : 's'}</li>}
        {inserted > 0 && <li>Inserted <strong>{inserted.toLocaleString()}</strong> document{inserted === 1 ? '' : 's'}</li>}
        {inFileDropped > 0 && <li><strong>{inFileDropped.toLocaleString()}</strong> in-file duplicate{inFileDropped === 1 ? '' : 's'} were collapsed</li>}
        {failedBatches.length > 0 && (
          <li style="color:var(--danger)">
            <strong>{failedBatches.length}</strong> batch{failedBatches.length === 1 ? '' : 'es'} failed
            <ul class="import-failure-list">
              {failedBatches.slice(0, 5).map((b) => (
                <li>
                  Records {b.startIdx.toLocaleString()}–{b.endIdx.toLocaleString()} ({b.count.toLocaleString()} docs): <code>{b.message}</code>
                </li>
              ))}
              {failedBatches.length > 5 && <li>{'… and '}{failedBatches.length - 5}{' more'}</li>}
            </ul>
            {failedBatches.some((b) => /batch op errors/i.test(b.message)) && (
              <div class="import-result-hint">
                <code>batch op errors occurred</code> typically means at least one document in the batch had a duplicate <code>_id</code> or violated a collection validator. Re-run with Overwrite mode to replace existing records.
              </div>
            )}
          </li>
        )}
      </ul>

      <div class="modal-actions">
        <button class="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Fragment>
  );
}

function FileSummary({ fileMeta, stats }) {
  if (!fileMeta || !stats) return null;
  const parts = [];
  parts.push(`${stats.total.toLocaleString()} document${stats.total === 1 ? '' : 's'}`);
  if (fileMeta.size) parts.push(formatBytes(fileMeta.size));
  if (stats.withId === stats.total && stats.total > 0) parts.push('all have _id');
  else if (stats.withId === 0) parts.push('no explicit _id');
  else parts.push(`${stats.withId.toLocaleString()} with _id, ${stats.withoutId.toLocaleString()} without`);
  return (
    <div class="modal-count-info">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">{fileMeta.name}</div>
      <div>{parts.join(' · ')}</div>
    </div>
  );
}
