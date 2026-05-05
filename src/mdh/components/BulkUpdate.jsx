import { h } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { loading, error } from '../store.js';
import { openModal, closeModal } from './Modal.jsx';
import JsonEditor from './JsonEditor.jsx';
import BulkConfirm from './BulkConfirm.jsx';
import * as api from '../api.js';
import { previewMatch, runBulkUpdate, selectionToFilter, UNDO_LIMIT } from '../bulkOps.js';

const PREVIEW_DEBOUNCE_MS = 400;

export function openBulkUpdate({ collection, mode, ids, filter, onSuccess, fieldsFn }) {
  openModal(mode === 'selection' ? `Update ${ids.length} record${ids.length !== 1 ? 's' : ''}` : 'Update by filter', () => (
    <Body collection={collection} mode={mode} ids={ids} initialFilter={filter} onSuccess={onSuccess} fieldsFn={fieldsFn} />
  ));
}

// For the trivial `$set` case we surface a per-field diff: read the new value
// from the expression and compare to the doc field. For other operators
// ($inc, $push, $unset, $rename, …) we don't try to predict — surfacing those
// diffs would mean reimplementing a chunk of the MongoDB update engine.
function trivialSetDiff(updateExpr, doc) {
  if (!updateExpr || typeof updateExpr !== 'object') return null;
  const keys = Object.keys(updateExpr);
  if (keys.length !== 1 || keys[0] !== '$set') return null;
  const setObj = updateExpr.$set;
  if (!setObj || typeof setObj !== 'object') return null;
  const out = {};
  for (const k of Object.keys(setObj)) {
    out[k] = { from: doc?.[k], to: setObj[k] };
  }
  return out;
}

// Renders the document as pretty-printed JSON, but with any field listed in
// `diff` highlighted inline as `"key": <from> → <to>` so the user can see
// exactly which lines will change in the context of the surrounding doc.
// Returns an array of JSX/string children (suitable for inserting into a
// <pre> body). Top-level fields only — dot-notation keys like "address.city"
// fall through and appear in the doc as-is, with the change visible only via
// the entry in `diff`.
function diffJsonContent(doc, diff) {
  const docKeys = Object.keys(doc);
  const additions = Object.keys(diff).filter((k) => !(k in doc));
  const totalLines = docKeys.length + additions.length;
  const out = ['{\n'];

  docKeys.forEach((k, i) => {
    const trail = i < totalLines - 1 ? ',\n' : '\n';
    if (k in diff) {
      out.push(
        <span class="sample-card-line-changed" key={`c-${k}`}>
          {`  ${JSON.stringify(k)}: `}
          <span class="sample-card-diff-from">{JSON.stringify(diff[k].from)}</span>
          {' → '}
          <span class="sample-card-diff-to">{JSON.stringify(diff[k].to)}</span>
          {trail}
        </span>,
      );
    } else {
      const valStr = JSON.stringify(doc[k], null, 2).replace(/\n/g, '\n  ');
      out.push(`  ${JSON.stringify(k)}: ${valStr}${trail}`);
    }
  });

  additions.forEach((k, i) => {
    const lineIdx = docKeys.length + i;
    const trail = lineIdx < totalLines - 1 ? ',\n' : '\n';
    out.push(
      <span class="sample-card-line-added" key={`a-${k}`}>
        {`  ${JSON.stringify(k)}: `}
        <span class="sample-card-diff-to">{JSON.stringify(diff[k].to)}</span>
        {trail}
      </span>,
    );
  });

  out.push('}');
  return out;
}

function Body({ collection, mode, ids, initialFilter, onSuccess, fieldsFn }) {
  const rootRef = useRef(null);
  const filterEditorRef = useRef(null);
  const updateEditorRef = useRef(null);
  const [filterJson, setFilterJson] = useState(() => JSON.stringify(initialFilter || {}, null, 2));
  const [filterValue, setFilterValue] = useState(initialFilter || {});
  const [filterValid, setFilterValid] = useState(true);
  const [updateJson, setUpdateJson] = useState('{\n  "$set": {}\n}');
  const [updateValue, setUpdateValue] = useState({ $set: {} });
  const [updateValid, setUpdateValid] = useState(true);
  const [count, setCount] = useState(null);
  const [sample, setSample] = useState([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [running, setRunning] = useState(false);
  const [resultMsg, setResultMsg] = useState(null);

  const isSelection = mode === 'selection';
  const effectiveFilter = isSelection ? selectionToFilter(ids) : filterValue;
  const isEmptyFilter = !isSelection && filterValid && Object.keys(filterValue).length === 0;

  function runPreview(filt) {
    setPreviewing(true);
    setPreviewError(null);
    const ac = new AbortController();
    if (isSelection) {
      api.aggregate(collection, [{ $match: filt }, { $limit: 5 }], { signal: ac.signal })
        .then((res) => { setSample(res.result || []); setCount(ids.length); setPreviewing(false); })
        .catch((err) => { setPreviewError(err.message); setPreviewing(false); });
    } else {
      previewMatch(collection, filt, { signal: ac.signal })
        .then(({ count: c, sample: s }) => { setCount(c); setSample(s); setPreviewing(false); })
        .catch((err) => { setPreviewError(err.message); setPreviewing(false); });
    }
    return () => ac.abort();
  }

  useLayoutEffect(() => {
    // Guard against running in an orphaned Preact tree (can happen when a new
    // Modal root is created without properly unmounting the old one, e.g. in
    // tests that clear document.body.innerHTML without calling render(null)).
    if (rootRef.current && !rootRef.current.isConnected) return;
    const cancel = runPreview(effectiveFilter);
    return cancel;
  }, []);

  // Debounced re-preview when the user edits the filter (filter mode only).
  useEffect(() => {
    if (isSelection) return;
    if (!filterValid) return;
    const t = setTimeout(() => runPreview(filterValue), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filterJson, filterValid, isSelection]);

  function handleFilterValidChange() {
    if (!filterEditorRef.current) return;
    if (filterEditorRef.current.isValid()) {
      setFilterValue(filterEditorRef.current.getParsed());
      setFilterValid(true);
      setFilterJson(filterEditorRef.current.getValue());
    } else {
      setFilterValid(false);
    }
  }

  function handleUpdateValidChange() {
    if (!updateEditorRef.current) return;
    if (updateEditorRef.current.isValid()) {
      setUpdateValue(updateEditorRef.current.getParsed());
      setUpdateValid(true);
      setUpdateJson(updateEditorRef.current.getValue());
    } else {
      setUpdateValid(false);
    }
  }

  async function handleSubmit() {
    if (!Number.isFinite(count) || count <= 0) return;
    if (!updateValid) return;
    setRunning(true);
    try {
      loading.value = true;
      error.value = null;
      await runBulkUpdate(collection, effectiveFilter, updateValue, {
        count,
        undoMessage: `Updated ${count} record${count !== 1 ? 's' : ''} in "${collection}"`,
        onSuccess,
      });
      loading.value = false;
      setResultMsg(`Updated ${count} record${count !== 1 ? 's' : ''}`);
      setTimeout(() => closeModal(), 800);
    } catch (err) {
      loading.value = false;
      setRunning(false);
      setPreviewError(err.message);
    }
  }

  const undoNote = count > UNDO_LIMIT
    ? `Undo is unavailable above ${UNDO_LIMIT.toLocaleString()} records.`
    : 'You’ll have a few seconds to undo.';

  return (
    <div ref={rootRef} class="modal-body">
      <div class="modal-field-label">Filter:</div>
      {isSelection ? (
        <pre class="bulk-filter-readonly-pre">{JSON.stringify(effectiveFilter, null, 2)}</pre>
      ) : (
        <JsonEditor
          value={filterJson}
          minHeight="80px"
          mode="query"
          fields={fieldsFn}
          editorRef={filterEditorRef}
          onValidChange={handleFilterValidChange}
        />
      )}

      <div class="modal-field-label" style="margin-top:8px">Update expression:</div>
      <JsonEditor
        value={updateJson}
        minHeight="120px"
        mode="update"
        fields={fieldsFn}
        editorRef={updateEditorRef}
        onValidChange={handleUpdateValidChange}
      />

      <div class="bulk-preview">
        {previewing && <div class="bulk-preview-loading">{'Previewing…'}</div>}
        {previewError && <div class="bulk-preview-error">{previewError}</div>}
        {!previewing && !previewError && (
          <div data-testid="bulk-preview-count" class="bulk-preview-count">
            {count} record{count !== 1 ? 's' : ''} match
          </div>
        )}
        {sample.length > 0 && sample.length < count && (
          <div class="bulk-preview-sample-note">
            Preview shows a sample of the first {sample.length} {sample.length === 1 ? 'record' : 'records'} below — the operation will apply to all {count.toLocaleString()}.
          </div>
        )}
        {sample.length > 0 && (
          <div class="sample-cards">
            {sample.map((doc, i) => {
              const diff = trivialSetDiff(updateValue, doc);
              const hasChanges = diff && Object.keys(diff).length > 0;
              return (
                <div class="sample-card">
                  <div class="sample-card-header">
                    Document {i + 1}
                    {!diff && (
                      <span class="sample-card-header-meta sample-card-diff-opaque">will apply update expression</span>
                    )}
                  </div>
                  <pre class="sample-card-body">
                    {hasChanges ? diffJsonContent(doc, diff) : JSON.stringify(doc, null, 2)}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
        <div class="bulk-undo-note">{undoNote}</div>
      </div>

      {resultMsg && <div class="bulk-result">{resultMsg}</div>}

      <BulkConfirm
        count={count}
        collection={collection}
        forceNameGate={isEmptyFilter}
        disabled={running || !!resultMsg || count === 0 || !updateValid}
        submitLabel={running ? 'Updating…' : 'Update'}
        submitClass="btn-primary"
        onSubmit={handleSubmit}
        onCancel={closeModal}
      />
    </div>
  );
}
