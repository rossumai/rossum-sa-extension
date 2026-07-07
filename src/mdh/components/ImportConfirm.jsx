import { h, Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { analyzeDocs } from '../importFile.js';
import { collectFieldPaths, countRowsMissingKeys } from '../importPlan.js';
import { validateAgainstShape } from '../shape.js';
import { Segmented } from './ImportControls.jsx';
import MatchKeyPicker from './MatchKeyPicker.jsx';
import PlanSummary from './PlanSummary.jsx';
import SpecialText from './SpecialText.jsx';

const MODE_SEG = [
  { value: 'insert', label: 'Insert' },
  { value: 'update', label: 'Update' },
  { value: 'replace', label: 'Replace' },
];

function pluralDocs(n) { return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`; }

// Mode-aware one-sentence outcome+risk summary (spec: exact copy).
function summarySentence({ mode, keys, docs, insertCount, dupesDropped }) {
  if (mode === 'insert') {
    return `Adds ${insertCount.toLocaleString()} new record${insertCount === 1 ? '' : 's'} — existing records are never modified.` +
      (dupesDropped > 0 ? ` (${dupesDropped.toLocaleString()} duplicate _id row${dupesDropped === 1 ? '' : 's'} dropped.)` : '');
  }
  if (mode === 'update') {
    if (keys.length === 0) return 'Pick one or more fields above to match existing records by.';
    const keyList = keys.join(' + ') + (keys.length > 1 ? ' (all must match)' : '');
    return `Upserts ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'} matched by ${keyList} — matched records are replaced whole, unmatched rows are inserted. Runs on the server; can’t be undone.`;
  }
  return `Deletes every existing record, then loads these ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'} as the collection’s new contents. Can’t be undone.`;
}

// Renders a shape-error field/path name with quotes and leading/trailing
// whitespace made visible (edge U+0020 -> "·" chips; interior specials like
// NBSP already render as labeled chips via SpecialText).
function FieldName({ name }) {
  return <code><SpecialText value={name} quote markEdgeSpaces /></code>;
}

// shapeCount defaults to 0 only for callers that omit it; ImportWizard sets
// shape and shapeCount atomically in the same effect, so whenever `shape` is
// truthy the count is the real sampled-record count.
export default function ImportConfirm({
  docs, mode, setMode, keys, setKeys,
  shapeOverride = false, setShapeOverride, shape, shapeLoading, shapeError = false, shapeCount = 0, shapeCoversAll = false,
  onImport, onCancel, onBack,
}) {
  const isUpdate = mode === 'update';
  const isReplace = mode === 'replace';

  const insertStats = mode === 'insert' ? analyzeDocs(docs) : null;
  const insertCount = insertStats ? insertStats.uniqueIdCount + insertStats.withoutId : 0;
  const dupesDropped = insertStats ? insertStats.total - insertCount : 0;
  const fieldPaths = useMemo(() => collectFieldPaths(docs), [docs]);

  const missingKeyRows = useMemo(
    () => (isUpdate && keys.length > 0 ? countRowsMissingKeys(docs, keys) : 0),
    [isUpdate, docs, keys],
  );

  // Shape check: silent pass, loud fail. Always runs when we have a reference
  // shape (empty/new collections have none -> skipped). A mismatch can be
  // overridden per-import from inside the error card (shapeOverride).
  const shapeCheck = useMemo(() => (shape ? validateAgainstShape(docs, shape) : null), [shape, docs]);
  const shapeOk = !shapeCheck || shapeCheck.ok || shapeOverride;

  let canImport;
  if (isUpdate) canImport = keys.length > 0 && shapeOk && missingKeyRows === 0;
  else canImport = insertCount > 0 && shapeOk; // insert & replace both need docs
  if (isReplace) canImport = docs.length > 0 && shapeOk;

  // "all N" when the sample exhausted the collection ($sample returned fewer
  // rows than requested => there were no more); "a random sample of N" otherwise.
  const sampleNote = `Checked against ${shapeCoversAll ? `all ${shapeCount.toLocaleString()}` : `a random sample of ${shapeCount.toLocaleString()}`} existing records.`;
  const sampleNoteShort = shapeCoversAll
    ? `checked against all ${shapeCount.toLocaleString()} existing records`
    : `checked against a ${shapeCount.toLocaleString()}-record random sample`;

  const goClass = isReplace ? 'btn-danger' : 'btn-success';
  const goLabel = isReplace ? `Replace with ${pluralDocs(docs.length)}` : isUpdate ? `Upsert ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'}` : `Insert ${pluralDocs(insertCount)}`;

  return (
    <Fragment>
      <Segmented value={mode} options={MODE_SEG} onChange={setMode} ariaLabel="Import mode" testid="import-mode" tabs />

      {isUpdate && (
        <Fragment>
          <div class="modal-field-label" style="margin-top:10px">Match existing records by</div>
          <MatchKeyPicker paths={fieldPaths.filter((p) => p !== '_id')} keys={keys} setKeys={setKeys} />
        </Fragment>
      )}

      {/* Shape validation: silent pass, loud fail, in-card override. */}
      {shapeLoading && <div class="import-shape-line" data-testid="import-shape-loading">Checking shape{'…'}</div>}
      {!shapeLoading && shapeCheck?.ok && (
        <div class="import-shape-line ok" data-testid="import-shape-ok">{'✓'} Shape matches {'·'} {sampleNoteShort}</div>
      )}
      {!shapeLoading && shapeCheck && !shapeCheck.ok && (
        <div class="import-error" data-testid="import-shape-error" role="alert">
          <div class="import-error-head">
            <span class="import-error-icon" aria-hidden="true">{'⚠'}</span>
            <span><strong>Shape mismatch {'—'} import blocked.</strong> {shapeCheck.failedDocCount.toLocaleString()} row{shapeCheck.failedDocCount === 1 ? '' : 's'} don{'’'}t match the fields of the existing records.</span>
          </div>
          <ul class="import-error-list">
            {shapeCheck.whitespace.length > 0 && (
              <li><span class="import-error-label">Whitespace</span><span class="import-error-fields">
                {shapeCheck.whitespace.map((w) => (
                  <span key={w.got}><FieldName name={w.got} /> (file) vs <FieldName name={w.expected} /> (existing)</span>
                ))}
              </span></li>
            )}
            {shapeCheck.missing.length > 0 && (
              <li><span class="import-error-label">Missing</span><span class="import-error-fields">{shapeCheck.missing.map((p) => <FieldName key={p} name={p} />)}</span></li>
            )}
            {shapeCheck.unknown.length > 0 && (
              <li><span class="import-error-label">Unexpected</span><span class="import-error-fields">{shapeCheck.unknown.map((p) => <FieldName key={p} name={p} />)}</span></li>
            )}
            {shapeCheck.typeMismatch.length > 0 && (
              <li><span class="import-error-label">Wrong type</span><span class="import-error-fields">{shapeCheck.typeMismatch.map((t) => <code key={t.path}><SpecialText value={t.path} quote markEdgeSpaces />{`: ${t.expected.join('/')} → ${t.got}`}</code>)}</span></li>
            )}
          </ul>
          {shape && !shape.uniform && (
            <div class="import-shape-note">Existing records aren{'’'}t uniform (varying fields: <code>{shape.optionalPaths.slice(0, 6).join(', ') || 'mixed types'}</code>) {'—'} exact-shape validation may over-reject.</div>
          )}
          {shapeCheck.whitespace.length > 0 && (
            <div class="import-error-hint">Columns marked {'·'} differ only by leading/trailing whitespace.</div>
          )}
          <div class="import-shape-note">{sampleNote}</div>
          <label class="import-error-ack">
            <input type="checkbox" data-testid="shape-override" checked={shapeOverride} onChange={(e) => setShapeOverride(e.target.checked)} />
            <span>Import anyway {'—'} I{'’'}ve reviewed the mismatch above.</span>
          </label>
        </div>
      )}

      <PlanSummary
        summaryTestid="import-summary"
        summary={summarySentence({ mode, keys, docs, insertCount, dupesDropped })}
      >
        <ul data-testid="import-plan">
          {mode === 'insert' && (
            <Fragment>
              <li>Every row is added as a new record. Existing records are never modified.</li>
              <li>Rows keep their <code>_id</code> if they have one; rows without one get a server-assigned id. If several rows in the file share an <code>_id</code>, the first is kept and the rest are dropped before upload.</li>
              <li>A row whose <code>_id</code> already exists in the collection is rejected by the server; the other rows still import, and every rejection is reported at the end.</li>
              <li>Runs from this browser in batches of 1,000 {'—'} cancelling keeps the rows already inserted.</li>
            </Fragment>
          )}
          {isUpdate && keys.length === 0 && <li>Choose one or more fields to match existing records by.</li>}
          {isUpdate && keys.length > 0 && (
            <Fragment>
              <li>Each row is matched to existing records by <code>{keys.join(', ')}</code>{keys.length > 1 && <Fragment> {'—'} <strong>all</strong> of them must match at once (AND, not OR); a record equal in only some of these fields is not a match</Fragment>}.</li>
              <li>A matched record is <strong>replaced by the row entirely</strong> {'—'} fields the row doesn{'’'}t include are removed. The record keeps its <code>_id</code>.</li>
              <li>If several existing records share the same key value, only <strong>one</strong> of them is updated (which one is not guaranteed).</li>
              <li>Rows that match nothing are <strong>inserted</strong> as new records.</li>
              <li>Existing records not matched by any row are left untouched.</li>
              <li><code>_id</code> values and MDH{'’'}s internal <code>__digest_md5</code> in the file are ignored {'—'} records are identified only by the match keys, never by <code>_id</code>. A re-imported export can{'’'}t be matched by <code>_id</code>; pick a business key instead.</li>
              <li>Runs on the Rossum server as a single operation (typically 30{'–'}60 s, even for small files). Once started it can{'’'}t be recalled or undone.</li>
            </Fragment>
          )}
          {isReplace && (
            <Fragment>
              <li><strong>Deletes every existing record</strong>, then loads this file as the collection{'’'}s entire new contents.</li>
              <li>Custom indexes are kept. <code>_id</code> values and MDH{'’'}s internal <code>__digest_md5</code> in the file are ignored {'—'} the server assigns fresh ids, so record ids from an export are not preserved.</li>
              <li>Runs on the Rossum server (typically 30{'–'}60 s). Once started it can{'’'}t be recalled or undone.</li>
            </Fragment>
          )}
          {!shapeLoading && !shape && (
            <li>{shapeError
              ? <Fragment>Shape check unavailable {'—'} the existing-records sample couldn{'’'}t be fetched.</Fragment>
              : <Fragment>New or empty collection {'—'} shape check skipped.</Fragment>}</li>
          )}
        </ul>
      </PlanSummary>

      {isUpdate && keys.length > 0 && missingKeyRows > 0 && (
        <div class="import-error" data-testid="import-key-guard" role="alert">
          <div class="import-error-head">
            <span class="import-error-icon" aria-hidden="true">{'⚠'}</span>
            <span><strong>{missingKeyRows.toLocaleString()} row{missingKeyRows === 1 ? ' is' : 's are'} missing <code>{keys.join(', ')}</code>.</strong> The server rejects the whole import if any row lacks a match key. Fix the file or pick different keys.</span>
          </div>
        </div>
      )}

      <div class="modal-actions">
        {onBack && <button class="btn btn-secondary" style="margin-right:auto" data-testid="import-back" onClick={onBack}>{'←'} Back</button>}
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class={`btn ${goClass}`} data-testid="import-go" disabled={!canImport} onClick={onImport}>{goLabel}</button>
      </div>
    </Fragment>
  );
}
