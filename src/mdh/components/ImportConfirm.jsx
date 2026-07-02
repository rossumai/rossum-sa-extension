import { h, Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { analyzeDocs } from '../importFile.js';
import { collectFieldPaths } from '../importPlan.js';
import { validateAgainstShape } from '../shape.js';
import { Segmented, Toggle } from './ImportControls.jsx';
import { formatBytes } from './ImportStages.jsx';
import MatchKeyPicker from './MatchKeyPicker.jsx';

const MODE_SEG = [
  { value: 'insert', label: 'Insert' },
  { value: 'update', label: 'Update' },
  { value: 'replace', label: 'Replace' },
];

export function defaultKeysFor(docs) {
  if (!docs || docs.length === 0) return [];
  const allHaveId = docs.every((d) => d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, '_id'));
  return allHaveId ? ['_id'] : [];
}

function pluralDocs(n) { return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`; }

export default function ImportConfirm({
  fileMeta, docs, mode, setMode, keys, setKeys,
  validateShape, setValidateShape, shape, shapeLoading,
  estimate, estimateLoading, onImport, onCancel,
}) {
  const isUpdate = mode === 'update';
  const isReplace = mode === 'replace';

  const insertStats = mode === 'insert' ? analyzeDocs(docs) : null;
  const insertCount = insertStats ? insertStats.uniqueIdCount + insertStats.withoutId : 0;
  const fieldPaths = useMemo(() => collectFieldPaths(docs), [docs]);

  // Shape check: only when the toggle is on and we have a reference shape
  // (empty/new collections have none -> skipped).
  const shapeCheck = useMemo(() => {
    if (!validateShape || !shape) return null;
    return validateAgainstShape(docs, shape);
  }, [validateShape, shape, docs]);
  const shapeOk = !shapeCheck || shapeCheck.ok;

  let canImport;
  if (isUpdate) canImport = keys.length > 0 && shapeOk;
  else canImport = insertCount > 0 && shapeOk; // insert & replace both need docs
  if (isReplace) canImport = docs.length > 0 && shapeOk;

  const goClass = isReplace ? 'btn-danger' : 'btn-success';
  const goLabel = isReplace ? `Replace with ${pluralDocs(docs.length)}` : isUpdate ? `Upsert ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'}` : `Insert ${pluralDocs(insertCount)}`;

  return (
    <Fragment>
      <div class="modal-count-info">
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">{fileMeta?.name}</div>
        <div>{pluralDocs(docs.length)}{fileMeta?.size ? ` · ${formatBytes(fileMeta.size)}` : ''}</div>
      </div>

      <Segmented value={mode} options={MODE_SEG} onChange={setMode} ariaLabel="Import mode" testid="import-mode" tabs />

      {isUpdate && (
        <Fragment>
          <div class="modal-field-label" style="margin-top:10px">Match existing records by</div>
          <MatchKeyPicker paths={fieldPaths} keys={keys} setKeys={setKeys} />
          {keys.length === 0 && <div class="input-hint" style="color:var(--danger)">Select at least one match field.</div>}
        </Fragment>
      )}

      {/* Shape validation */}
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
        <Toggle checked={validateShape} onChange={setValidateShape} testid="shape-toggle" title="Validate against the existing records' shape" />
        <span>Validate shape against existing records</span>
      </label>
      {validateShape && (
        <div class="import-shape" data-testid="import-shape">
          {shapeLoading && <span>Checking shape{'…'}</span>}
          {!shapeLoading && !shape && <span class="input-hint">New or empty collection {'—'} nothing to validate against.</span>}
          {!shapeLoading && shape && !shape.uniform && (
            <div class="import-warn">Existing records aren't uniform (varying fields: <code>{shape.optionalPaths.slice(0, 6).join(', ') || 'mixed types'}</code>). Exact-shape validation may over-reject {'—'} consider turning it off.</div>
          )}
          {!shapeLoading && shapeCheck && !shapeCheck.ok && (
            <div class="import-error" data-testid="import-shape-error" role="alert">
              <div class="import-error-head">
                <span class="import-error-icon" aria-hidden="true">{'⚠'}</span>
                <span><strong>Shape mismatch {'—'} import blocked.</strong> {shapeCheck.failedDocCount.toLocaleString()} row{shapeCheck.failedDocCount === 1 ? '' : 's'} don{'’'}t match the fields of the existing records.</span>
              </div>
              <ul class="import-error-list">
                {shapeCheck.missing.length > 0 && (
                  <li><span class="import-error-label">Missing</span><span class="import-error-fields">{shapeCheck.missing.map((p) => <code key={p}>{p}</code>)}</span></li>
                )}
                {shapeCheck.unknown.length > 0 && (
                  <li><span class="import-error-label">Unexpected</span><span class="import-error-fields">{shapeCheck.unknown.map((p) => <code key={p}>{p}</code>)}</span></li>
                )}
                {shapeCheck.typeMismatch.length > 0 && (
                  <li><span class="import-error-label">Wrong type</span><span class="import-error-fields">{shapeCheck.typeMismatch.map((t) => <code key={t.path}>{`${t.path}: ${t.expected.join('/')} → ${t.got}`}</code>)}</span></li>
                )}
              </ul>
              <div class="import-error-hint">Fix the file to match, or turn off shape validation above to import anyway.</div>
            </div>
          )}
          {!shapeLoading && shapeCheck && shapeCheck.ok && shape?.uniform && <span class="input-hint" style="color:var(--success)">Shape matches.</span>}
        </div>
      )}

      <div class="import-summary" data-testid="import-plan">
        {mode === 'insert' && (
          <span>Adds every row as a new document. If a row's <code>_id</code> already exists the insert is rejected and reported afterward {'—'} nothing already in the collection is changed. <strong>This file adds {insertCount.toLocaleString()} new document{insertCount === 1 ? '' : 's'}.</strong></span>
        )}
        {isUpdate && keys.length === 0 && <span>Choose one or more fields to match existing records by.</span>}
        {isUpdate && keys.length > 0 && (
          <span>Matches each row to an existing record by <code>{keys.join(', ')}</code>, then overwrites the whole matched record with the row. Rows that match nothing are inserted as new documents (upsert). Runs on the server{'—'} the collection updates in about a minute.</span>
        )}
        {isReplace && (
          <span><strong>Replaces the entire collection.</strong> Every existing record is deleted, then the {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} in this file become the collection's only contents. Indexes are kept. Runs on the server.</span>
        )}
      </div>

      {isUpdate && keys.length > 0 && (
        <div class="import-estimate" data-testid="import-estimate">
          {estimateLoading && <span class="input-hint">Estimating how many rows match{'…'}</span>}
          {!estimateLoading && estimate && estimate.supported && estimate.capped && (
            <span class="input-hint">Large file {'—'} match estimate skipped.</span>
          )}
          {!estimateLoading && estimate && estimate.supported && !estimate.capped && typeof estimate.matched === 'number' && (
            <span>Estimated: <strong>~{estimate.matched.toLocaleString()}</strong> will update existing record{estimate.matched === 1 ? '' : 's'}, <strong>~{estimate.willInsert.toLocaleString()}</strong> will be inserted as new (by <code>{keys.join(', ')}</code>).</span>
          )}
        </div>
      )}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class={`btn ${goClass}`} data-testid="import-go" disabled={!canImport} onClick={onImport}>{goLabel}</button>
      </div>
    </Fragment>
  );
}
