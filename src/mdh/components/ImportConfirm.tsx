import { h, Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { analyzeDocs } from '../importFile.js';
import { collectFieldPaths, countRowsMissingKeys } from '../importPlan.js';
import { validateAgainstShape } from '../shape.js';
import { buildLedger, findFlattenedCauses } from '../shapeReport.js';
import type { LedgerRow } from '../shapeReport.js';
import { AbsentValue, Segmented } from './ImportControls.jsx';
import { ModalActions, ModalFieldLabel } from './Modal.jsx';
import MatchKeyPicker from './MatchKeyPicker.jsx';
import PlanSummary from './PlanSummary.jsx';
import SpecialText from './SpecialText.jsx';

const MODE_SEG = [
  { value: 'insert', label: 'Insert' },
  { value: 'update', label: 'Update' },
  { value: 'replace', label: 'Replace' },
];

function pluralDocs(n: any) {
  return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`;
}

// Mode-aware one-sentence outcome+risk summary (spec: exact copy).
function summarySentence({
  mode,
  keys,
  docs,
  insertCount,
  dupesDropped,
}: {
  mode: string;
  keys: string[];
  docs: any[];
  insertCount: number;
  dupesDropped: number;
}) {
  if (mode === 'insert') {
    return (
      `Adds ${insertCount.toLocaleString()} new record${insertCount === 1 ? '' : 's'} — existing records are never modified.` +
      (dupesDropped > 0
        ? ` (${dupesDropped.toLocaleString()} duplicate _id row${dupesDropped === 1 ? '' : 's'} dropped.)`
        : '')
    );
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
function FieldName({ name }: { name: string }) {
  return (
    <code>
      <SpecialText value={name} quote markEdgeSpaces />
    </code>
  );
}

// A ledger row's "In the collection" / "In the file" cell. `null` here means
// "this side has no finding" (the field doesn't exist on that side at all)
// and renders via the shared AbsentValue vocabulary — muted + italic, never
// to be confused with the STRING "null", which is a real type name a `type`
// row can legitimately carry on either side and which stays mono/plain via
// the plain <code> branch below. For every kind but `whitespace` a non-null
// value is a TYPE name (plain text); for `whitespace` it is a SPELLING, run
// through the same whitespace-revealing renderer as the Field column so an
// edge space or an invisible character stays visible on both sides, not
// just the file's.
function LedgerCell({ value, kind }: { value: string | null; kind: LedgerRow['kind'] }) {
  if (value === null) return <AbsentValue />;
  if (kind === 'whitespace')
    return (
      <code>
        <SpecialText value={value} quote markEdgeSpaces />
      </code>
    );
  return <code>{value}</code>;
}

// shapeCount defaults to 0 only for callers that omit it; ImportWizard sets
// shape and shapeCount atomically in the same effect, so whenever `shape` is
// truthy the count is the real sampled-record count.
export default function ImportConfirm({
  docs,
  mode,
  setMode,
  keys,
  setKeys,
  shapeOverride = false,
  setShapeOverride,
  shape,
  shapeLoading,
  shapeError = false,
  shapeCount = 0,
  shapeCoversAll = false,
  restoreSummary = null,
  onImport,
  onCancel,
  onBack,
}: {
  docs: any[];
  mode: string;
  setMode: (m: string) => void;
  keys: string[];
  setKeys: (k: string[]) => void;
  shapeOverride?: boolean;
  setShapeOverride: (v: boolean) => void;
  shape?: any;
  shapeLoading?: boolean;
  shapeError?: boolean;
  shapeCount?: number;
  shapeCoversAll?: boolean;
  restoreSummary?: string | null;
  onImport: () => unknown;
  onCancel: () => void;
  onBack?: () => void;
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
  const shapeCheck = useMemo(
    () => (shape ? validateAgainstShape(docs, shape) : null),
    [shape, docs],
  );
  const shapeOk = !shapeCheck || shapeCheck.ok || shapeOverride;

  // The mismatch ledger: one row per finding, grouped by root (buildLedger),
  // plus the "N fields arrived flat" coalescing (findFlattenedCauses) — see
  // src/mdh/shapeReport.ts. A group-heading row is shown for a root only when
  // more than one row shares it, so a lone finding (e.g. a single wrong-type
  // field) renders exactly as before: no heading, no indent.
  const ledger = useMemo<LedgerRow[]>(
    () => (shapeCheck && !shapeCheck.ok ? buildLedger(shapeCheck) : []),
    [shapeCheck],
  );
  const flatCauses = useMemo(
    () => (shapeCheck && !shapeCheck.ok ? findFlattenedCauses(shapeCheck) : []),
    [shapeCheck],
  );
  const rootCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of ledger) counts.set(row.root, (counts.get(row.root) || 0) + 1);
    return counts;
  }, [ledger]);

  let canImport;
  if (isUpdate) canImport = keys.length > 0 && shapeOk && missingKeyRows === 0;
  else canImport = insertCount > 0 && shapeOk; // insert & replace both need docs
  if (isReplace) canImport = docs.length > 0 && shapeOk;
  // The "Checking shape…" line below is a sibling render, not a gate — while
  // the $sample round trip is in flight, shapeCheck is null (same as "no
  // reference shape") and restoreDocs already ran with shape===null
  // (heuristics only). A fast click must not import that partially-restored
  // state, so shapeLoading gates the button directly.
  if (shapeLoading) canImport = false;

  // "all N" when the sample exhausted the collection ($sample returned fewer
  // rows than requested => there were no more); "a random sample of N" otherwise.
  const sampleNote = `Checked against ${shapeCoversAll ? `all ${shapeCount.toLocaleString()}` : `a random sample of ${shapeCount.toLocaleString()}`} existing records.`;
  const sampleNoteShort = shapeCoversAll
    ? `checked against all ${shapeCount.toLocaleString()} existing records`
    : `checked against a ${shapeCount.toLocaleString()}-record random sample`;

  const goClass = isReplace ? 'btn-danger' : 'btn-success';
  const goLabel = isReplace
    ? `Replace with ${pluralDocs(docs.length)}`
    : isUpdate
      ? `Upsert ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'}`
      : `Insert ${pluralDocs(insertCount)}`;

  return (
    <Fragment>
      <Segmented
        value={mode}
        options={MODE_SEG}
        onChange={setMode}
        ariaLabel="Import mode"
        testid="import-mode"
        tabs
      />

      {isUpdate && (
        <Fragment>
          <ModalFieldLabel style="margin-top:10px">Match existing records by</ModalFieldLabel>
          <MatchKeyPicker
            paths={fieldPaths.filter((p) => p !== '_id')}
            keys={keys}
            setKeys={setKeys}
          />
        </Fragment>
      )}

      {/* Shape validation: silent pass, loud fail, in-card override. */}
      {restoreSummary && (
        <div class="import-shape-line" data-testid="import-restore-summary">
          {restoreSummary}
        </div>
      )}
      {shapeLoading && (
        <div class="import-shape-line" data-testid="import-shape-loading">
          Checking shape{'…'}
        </div>
      )}
      {!shapeLoading && shapeCheck?.ok && (
        <div class="import-shape-line ok" data-testid="import-shape-ok">
          {'✓'} Shape matches {'·'} {sampleNoteShort}
        </div>
      )}
      {!shapeLoading && shapeCheck && !shapeCheck.ok && (
        <div class="import-error" data-testid="import-shape-error" role="alert">
          <div class="import-error-head">
            <span class="import-error-icon" aria-hidden="true">
              {'⚠'}
            </span>
            <span>
              <strong>Shape mismatch {'—'} import blocked.</strong>{' '}
              {shapeCheck.failedDocCount.toLocaleString()} row
              {shapeCheck.failedDocCount === 1 ? '' : 's'} don{'’'}t match the fields of the
              existing records.
            </span>
          </div>
          <div class="import-ledger-panel">
            <div class="import-ledger-scroll">
              <table class="import-ledger">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>In the collection</th>
                    <th>In the file</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const seenRoots = new Set<string>();
                    return ledger.map((row) => {
                      const grouped = (rootCounts.get(row.root) || 0) > 1;
                      const isFirstOfRoot = !seenRoots.has(row.root);
                      seenRoots.add(row.root);
                      // Colour marks a genuine disagreement only — a `type` row,
                      // where both sides carry a value. Missing/unexpected rows
                      // have a dash on one side (nothing to contrast); whitespace
                      // rows hold spellings, not types, so they stay neutral too.
                      const collectionClass =
                        row.kind === 'type' && row.file !== null
                          ? 'import-ledger-cell-collection import-ledger-type-collection'
                          : 'import-ledger-cell-collection';
                      const fileClass =
                        row.kind === 'type' && row.collection !== null
                          ? 'import-ledger-cell-file import-ledger-type-file'
                          : 'import-ledger-cell-file';
                      return (
                        <Fragment key={`${row.kind}:${row.path}`}>
                          {grouped && isFirstOfRoot && (
                            <tr class="import-ledger-group-row">
                              <td class="import-ledger-group-cell" colSpan={3}>
                                <SpecialText value={row.root} />
                              </td>
                            </tr>
                          )}
                          <tr
                            class="import-ledger-row"
                            data-testid="ledger-row"
                            data-path={row.path}
                            data-kind={row.kind}
                          >
                            <td
                              class={
                                grouped
                                  ? 'import-ledger-cell-field import-ledger-cell-field-indent'
                                  : 'import-ledger-cell-field'
                              }
                            >
                              <FieldName name={row.path} />
                              {row.kind === 'whitespace' && (
                                <span class="import-ledger-tag">spelling</span>
                              )}
                            </td>
                            <td class={collectionClass}>
                              <LedgerCell value={row.collection} kind={row.kind} />
                            </td>
                            <td class={fileClass}>
                              <LedgerCell value={row.file} kind={row.kind} />
                            </td>
                          </tr>
                        </Fragment>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
            {flatCauses.length > 0 && (
              <div class="import-ledger-flat" data-testid="import-shape-flat-causes">
                {flatCauses.length} field{flatCauses.length === 1 ? '' : 's'} arrived flat{': '}
                {flatCauses.map((c, i) => (
                  <Fragment key={c.root}>
                    {i > 0 && ', '}
                    <code>{c.root}</code> ({c.leaves.length} nested)
                  </Fragment>
                ))}
              </div>
            )}
          </div>
          {shapeCheck.whitespace.length > 0 && (
            <div class="import-error-hint">
              Columns marked {'·'} differ only by leading/trailing whitespace.
            </div>
          )}
          <div class="import-shape-note">{sampleNote}</div>
          <label class="import-error-ack">
            <input
              type="checkbox"
              data-testid="shape-override"
              checked={shapeOverride}
              onChange={(e: any) => setShapeOverride(e.target.checked)}
            />
            <span>
              Import anyway {'—'} I{'’'}ve reviewed the mismatch above.
            </span>
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
              <li>
                Rows keep their <code>_id</code> if they have one; rows without one get a
                server-assigned id. If several rows in the file share an <code>_id</code>, the first
                is kept and the rest are dropped before upload.
              </li>
              <li>
                A row whose <code>_id</code> already exists in the collection is rejected by the
                server; the other rows still import, and every rejection is reported at the end.
              </li>
              <li>
                Runs from this browser in batches of 1,000 {'—'} cancelling keeps the rows already
                inserted.
              </li>
            </Fragment>
          )}
          {isUpdate && keys.length === 0 && (
            <li>Choose one or more fields to match existing records by.</li>
          )}
          {isUpdate && keys.length > 0 && (
            <Fragment>
              <li>
                Each row is matched to existing records by <code>{keys.join(', ')}</code>
                {keys.length > 1 && (
                  <Fragment>
                    {' '}
                    {'—'} <strong>all</strong> of them must match at once (AND, not OR); a record
                    equal in only some of these fields is not a match
                  </Fragment>
                )}
                .
              </li>
              <li>
                A matched record is <strong>replaced by the row entirely</strong> {'—'} fields the
                row doesn{'’'}t include are removed. The record keeps its <code>_id</code>.
              </li>
              <li>
                If several existing records share the same key value, only <strong>one</strong> of
                them is updated (which one is not guaranteed).
              </li>
              <li>
                Rows that match nothing are <strong>inserted</strong> as new records.
              </li>
              <li>Existing records not matched by any row are left untouched.</li>
              <li>
                <code>_id</code> values and MDH{'’'}s internal <code>__digest_md5</code> in the file
                are ignored {'—'} records are identified only by the match keys, never by{' '}
                <code>_id</code>. A re-imported export can{'’'}t be matched by <code>_id</code>;
                pick a business key instead.
              </li>
              <li>
                Runs on the Rossum server as a single operation (typically 30{'–'}60 s, even for
                small files). Once started it can{'’'}t be recalled or undone.
              </li>
            </Fragment>
          )}
          {isReplace && (
            <Fragment>
              <li>
                <strong>Deletes every existing record</strong>, then loads this file as the
                collection{'’'}s entire new contents.
              </li>
              <li>
                Custom indexes are kept. <code>_id</code> values and MDH{'’'}s internal{' '}
                <code>__digest_md5</code> in the file are ignored {'—'} the server assigns fresh
                ids, so record ids from an export are not preserved.
              </li>
              <li>
                Runs on the Rossum server (typically 30{'–'}60 s). Once started it can{'’'}t be
                recalled or undone.
              </li>
            </Fragment>
          )}
          {!shapeLoading && !shape && (
            <li>
              {shapeError ? (
                <Fragment>
                  Shape check unavailable {'—'} the existing-records sample couldn{'’'}t be fetched.
                </Fragment>
              ) : (
                <Fragment>New or empty collection {'—'} shape check skipped.</Fragment>
              )}
            </li>
          )}
        </ul>
      </PlanSummary>

      {isUpdate && keys.length > 0 && missingKeyRows > 0 && (
        <div class="import-error" data-testid="import-key-guard" role="alert">
          <div class="import-error-head">
            <span class="import-error-icon" aria-hidden="true">
              {'⚠'}
            </span>
            <span>
              <strong>
                {missingKeyRows.toLocaleString()} row{missingKeyRows === 1 ? ' is' : 's are'}{' '}
                missing <code>{keys.join(', ')}</code>.
              </strong>{' '}
              The server rejects the whole import if any row lacks a match key. Fix the file or pick
              different keys.
            </span>
          </div>
        </div>
      )}

      <ModalActions>
        {onBack && (
          <button
            class="btn btn-secondary"
            style="margin-right:auto"
            data-testid="import-back"
            onClick={onBack}
          >
            {'←'} Back
          </button>
        )}
        <button class="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          class={`btn ${goClass}`}
          data-testid="import-go"
          disabled={!canImport}
          onClick={onImport}
        >
          {goLabel}
        </button>
      </ModalActions>
    </Fragment>
  );
}
