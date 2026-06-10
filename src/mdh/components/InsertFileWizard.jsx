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
import { StageConfirm, StageImporting, StageDone } from './ImportStages.jsx';
import { parseNdjson } from '../ndjson.js';

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

export default function InsertFileWizard({ onSuccess, format = 'json' }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [docs, setDocs] = useState(null);
  const [stats, setStats] = useState(null);
  const [mode, setMode] = useState('insert');   // 'insert' | 'overwrite'
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [warnings, setWarnings] = useState([]);

  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  function handleFile(file) {
    setErrorMsg(null);
    setWarnings([]);
    setFileMeta({ name: file.name, size: file.size });
    file.text().then((text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) parsed = [parsed];
      } catch (jsonErr) {
        // Not a single JSON value — try JSON Lines (NDJSON).
        const nd = parseNdjson(text);
        if (nd.error) { setErrorMsg(`Couldn't parse as JSON or JSON Lines: ${jsonErr.message}`); return; }
        parsed = nd.docs;
        setWarnings(nd.warnings);
      }
      if (parsed.length === 0) { setErrorMsg('File contains no documents'); return; }
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
      {stage === STAGE.PICK && <StagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} format={format} />}

      {stage === STAGE.CONFIRM && stats && (
        <Fragment>
          {warnings.length > 0 && (
            <div class="csv-preview" data-testid="import-warnings">
              {warnings.map((w, i) => <div key={i} class="csv-warning">{'⚠'} {w}</div>)}
            </div>
          )}
          <StageConfirm
            fileMeta={fileMeta}
            stats={stats}
            mode={mode}
            setMode={setMode}
            errorMsg={errorMsg}
            onImport={startImport}
            onCancel={closeModal}
          />
        </Fragment>
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

function StagePick({ onFile, errorMsg, onCancel, format = 'json' }) {
  const inputRef = useRef(null);
  function pick(e) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  }
  const isJsonl = format === 'jsonl';
  return (
    <Fragment>
      <div class="modal-field-label">{isJsonl ? 'Select a JSONL file to insert:' : 'Select a JSON file with documents to insert:'}</div>
      <input ref={inputRef} type="file" accept={isJsonl ? '.jsonl,.ndjson,application/x-ndjson' : '.json,application/json'} style="display:none" onChange={pick} />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">{isJsonl ? 'Click to select a JSONL file' : 'Click to select a JSON file'}</div>
        <div class="file-input-info" style="margin-top:4px">{isJsonl ? 'One JSON object per line (.jsonl / .ndjson)' : 'JSON array, or a single document'}</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}

