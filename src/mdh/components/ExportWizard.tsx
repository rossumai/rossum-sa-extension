import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { track } from '../../usage/track.js';
import { closeModal, ModalBody, ModalActions, ModalFieldLabel } from './Modal.jsx';
import { AbsentValue, EmptyValue, NullValue, ScalarValue, Segmented } from './ImportControls.jsx';
import PlanSummary from './PlanSummary.jsx';
import { EXPORT_FORMATS, getExportFormat, exportFilename } from '../exportFormats.jsx';
import { discoverLeafPaths } from '../columnDiscovery.js';
import { orderExportColumns } from '../recordColumns.js';
import { flattenDoc } from '../flatten.js';
import { displayValue } from '../displayValue.js';
import * as api from '../api.js';

// Scope labels carry the live record counts so the all-vs-filtered choice is
// impossible to overlook — the numbers ARE the semantic difference.
function scopeLabel(base: any, c: any) {
  if (c.loading) return `${base} \u00b7 \u2026`;
  if (c.value !== null) return `${base} \u00b7 ${c.value.toLocaleString()}`;
  return base;
}
const FORMAT_SEG = EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }));
const LARGE_EXPORT = 10_000;
const PREVIEW_ROWS = 10;

// Single-screen export config collector (the import wizard's counterpart).
// Pure UI: fetches count/preview read-only; hands ONE config object to
// onExport and never touches the download engine itself.
export default function ExportWizard({
  collection, filterState, totalCount, recordsSample, onExport,
}: {
  collection: string;
  filterState: Record<string, any>;
  totalCount?: number | null;
  recordsSample?: any[] | null;
  onExport: (config: any) => unknown;
}) {
  // Always default to All records (owner decision 2026-07-04) — Current filter
  // is one click away and stays disabled when the pipeline doesn't parse.
  const [scope, setScope] = useState('all');
  const [formatId, setFormatId] = useState('json');
  const [opts, setOpts] = useState<Record<string, any>>({});
  // Both scopes' counts are fetched once on mount (the stages are fixed for
  // the modal's lifetime) so the segmented buttons can show them side by side.
  const [counts, setCounts] = useState<Record<string, { value: number | null; loading: boolean }>>({
    all: { value: null, loading: true },
    filtered: { value: null, loading: filterState.available },
  });
  const [preview, setPreview] = useState<{ loading: boolean; columns: string[] | null; sample: any[]; error: string | null }>({ loading: true, columns: null, sample: [], error: null });

  const fmt = getExportFormat(formatId)!;
  const effOpts = { ...fmt.defaultOpts, ...opts };
  const setOpt = (k: any, v: any) => setOpts((o) => ({ ...o, [k]: v }));
  const stages = scope === 'filtered' ? filterState.stages : [{ $match: {} }];
  const filename = exportFilename(collection, scope, fmt);

  function switchFormat(id: any) { setFormatId(id); setOpts({}); }

  // Exact counts for BOTH scopes, fetched once on mount. All-records reuses
  // the pagination total when known; a failure only degrades the labels/line —
  // it never blocks (§4.7). Aborted on unmount.
  useEffect(() => {
    const controller = new AbortController();
    const set = (key: any, patch: any) => setCounts((c) => ({ ...c, [key]: patch }));
    if (totalCount !== null && totalCount !== undefined) {
      set('all', { value: totalCount, loading: false });
    } else {
      api.aggregate(collection, [{ $match: {} }, { $count: 'total' }], { signal: controller.signal })
        .then((r) => set('all', { value: r.result?.[0]?.total ?? 0, loading: false }))
        .catch(() => set('all', { value: null, loading: false }));
    }
    if (filterState.available) {
      api.aggregate(collection, [...filterState.stages, { $count: 'total' }], { signal: controller.signal })
        .then((r) => set('filtered', { value: r.result?.[0]?.total ?? 0, loading: false }))
        .catch(() => set('filtered', { value: null, loading: false }));
    }
    return () => { controller.abort(); };
  }, []);
  const count = counts[scope];

  // Row sample for the preview — always fetched (every format needs the sample
  // rows), independent of column discovery. Aborted on scope change / unmount.
  const samplePromiseRef = useRef<any>(null);
  useEffect(() => {
    let alive = true;
    setPreview((p) => ({ ...p, loading: true, error: null }));
    const controller = new AbortController();
    const samplePromise = api.aggregate(collection, [...stages, { $limit: PREVIEW_ROWS }], { signal: controller.signal });
    samplePromiseRef.current = samplePromise;
    samplePromise
      .then((r) => { if (alive) setPreview({ loading: false, columns: null, sample: r.result || [], error: null }); })
      .catch((e) => { if (alive) setPreview({ loading: false, columns: null, sample: [], error: e?.message || 'failed' }); });
    return () => { alive = false; controller.abort(); };
  }, [scope]);

  // Column discovery is a full-scope $objectToArray/$unwind/$group scan — run
  // it ONLY when the current format actually needs columns (csv/xlsx), lazily
  // on first such selection, and cache the result per scope so a csv<->xlsx
  // switch reuses it instead of re-scanning. A scope change carries a
  // different set of stages, so it's treated as a fresh cache key. Aborted on
  // cleanup (scope change / format change away / unmount).
  const [cols, setCols] = useState<{ loading: boolean; value: string[] | null }>({ loading: false, value: null });
  // Scope for which `cols` is fetched/in-flight; null = not cached.
  const colsFetchedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fmt.needsColumns) return undefined;
    if (colsFetchedScopeRef.current === scope) return undefined; // cached — reused across csv<->xlsx
    colsFetchedScopeRef.current = scope;
    let alive = true;
    const controller = new AbortController();
    setCols({ loading: true, value: null });
    discoverLeafPaths(collection, stages, { aggregate: api.aggregate, signal: controller.signal })
      .then(async (paths) => {
        // Table-order seed: the loaded page first, then the fetched preview
        // rows (covers a fresh view where no page is loaded yet) — so the
        // header follows first-seen order, not the alphabetical fallback.
        const sampleDocs = await (samplePromiseRef.current || Promise.resolve({ result: [] })).then((s: any) => s.result || []).catch(() => []);
        if (alive) setCols({ loading: false, value: orderExportColumns([...(recordsSample || []), ...sampleDocs], paths) });
      })
      .catch(() => {
        if (!alive) return; // superseded/aborted — don't clobber the new scope's cache marker
        setCols({ loading: false, value: null });
        colsFetchedScopeRef.current = null; // allow a retry on next need
      });
    return () => { alive = false; controller.abort(); };
  }, [fmt.needsColumns, scope]);

  const columns = cols.value;
  const isLarge = count.value !== null && count.value > LARGE_EXPORT;

  function download() {
    closeModal();
    track('sa_mdh_export');
    onExport({ scope, formatId, opts: effOpts, columns: fmt.needsColumns ? columns : null, count: count.value });
  }

  const scopeSeg = [
    { value: 'all', label: scopeLabel('All records', counts.all) },
    { value: 'filtered', label: scopeLabel('Current filter', counts.filtered), ...(filterState.available ? {} : { disabled: true }) },
  ];

  return (
    <ModalBody class="export-wizard">
      <ModalFieldLabel>Scope</ModalFieldLabel>
      <Segmented value={scope} options={scopeSeg} onChange={setScope} ariaLabel="Export scope" testid="export-scope" tabs />
      {!filterState.available && filterState.reason && (
        <div class="import-shape-neutral" style="margin-top:4px">{filterState.reason}</div>
      )}

      <ModalFieldLabel style="margin-top:10px">Format</ModalFieldLabel>
      <Segmented value={formatId} options={FORMAT_SEG} onChange={switchFormat} ariaLabel="Export format" testid="export-format" tabs />

      {fmt.OptionsControls && (
        <div class="csv-toolbar" style="margin-top:10px">
          <fmt.OptionsControls opts={effOpts} setOpt={setOpt} />
        </div>
      )}

      <div class="csv-export-preview" data-testid="export-preview">
        {preview.loading ? (
          <div class="csv-export-preview-note">Building preview{'…'}</div>
        ) : preview.error ? (
          <div class="csv-export-preview-note">Preview unavailable</div>
        ) : preview.sample.length === 0 ? (
          <div class="csv-export-preview-note">No rows to preview</div>
        ) : fmt.previewKind === 'grid' ? (
          <Fragment>
            <PreviewCaption sample={preview.sample} columns={columns} />
            <div class="csv-preview-scroll">
              <table class="csv-preview-table">
                {effOpts.header && columns && <thead><tr>{columns.map((c: any) => <th key={c}>{c}</th>)}</tr></thead>}
                <tbody>
                  {preview.sample.map((d, i) => {
                    const flat = d == null ? {} : flattenDoc(d);
                    return <tr key={i}>{(columns || []).map((c) => <td key={c}>{cellPreview(flat[c])}</td>)}</tr>;
                  })}
                </tbody>
              </table>
            </div>
          </Fragment>
        ) : (
          <Fragment>
            <PreviewCaption sample={preview.sample} columns={fmt.needsColumns ? columns : null} />
            <pre class="csv-export-preview-text">{fmt.needsColumns && cols.loading ? 'Building preview…' : fmt.needsColumns && !columns ? 'Preview unavailable' : fmt.buildPreviewText!(preview.sample, columns, effOpts)}</pre>
          </Fragment>
        )}
      </div>

      <PlanSummary
        summaryTestid="export-count"
        summary={
          count.loading ? <span>Counting documents{'…'}</span>
          : count.value !== null ? (
            <span>
              Exports {count.value.toLocaleString()} record{count.value === 1 ? '' : 's'} to <code>{filename}</code> {'—'} streamed to the file you pick; the collection is never modified.
              {isLarge ? <span> Large export {'—'} may take a while.</span> : null}
            </span>
          ) : (
            <span>Exports to <code>{filename}</code> {'—'} streamed to the file you pick; read-only.</span>
          )
        }
      >
        <ul data-testid="export-plan">
          {scope === 'all'
            ? <li>Every record in the collection is exported {'—'} the pipeline editor is ignored.</li>
            : <li>Only records matching the current pipeline are exported; trailing paging stages (<code>$skip</code>/<code>$limit</code>) are removed, so the whole result set is exported {'—'} not just the visible page.</li>}
          <li>Downloads in 1,000-record batches (10 in parallel) and streams to the file you pick; if the browser can{'’'}t stream, the file downloads normally when complete.</li>
          {scope === 'all'
            ? <li>Records are exported in a stable order {'—'} by <code>_id</code>.</li>
            : <li>Records are exported in a stable order {'—'} your filter{'’'}s final sort if it has one, otherwise by <code>_id</code>.</li>}
          {fmt.needsColumns && <li>Columns are the union of fields across the exported records, in table order.</li>}
          <li>Cancelling discards the partial file {'—'} nothing is saved.</li>
          <li>The export is read-only {'—'} the collection is never modified.</li>
        </ul>
      </PlanSummary>

      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="export-download" onClick={download}>
          {count.value !== null
            ? `Download ${count.value.toLocaleString()} record${count.value === 1 ? '' : 's'} \u00b7 ${fmt.label}`
            : `Download ${fmt.label}`}
        </button>
      </ModalActions>
    </ModalBody>
  );
}

function PreviewCaption({ sample, columns }: { sample: any[]; columns?: string[] | null }) {
  return (
    <div class="csv-export-preview-caption">
      Preview {'·'} first {sample.length} row{sample.length === 1 ? '' : 's'}{columns ? <Fragment> {'·'} {columns.length} column{columns.length === 1 ? '' : 's'}</Fragment> : null}
    </div>
  );
}

// flattenDoc only emits paths that exist on the document (src/mdh/flatten.ts),
// so `undefined` here genuinely means the field is absent on this row while
// `null` genuinely means a stored null — the two are distinguishable, unlike
// the blank cell this used to render for both (plus for an empty string,
// which collapsed to the same blank a third way). Shares the three-state
// vocabulary with the import preview (ImportControls.jsx) rather than
// inventing its own; objects still render via displayValue (truncated/
// collapsed), not JSON.stringify, per PreviewValue's own comment on why the
// two value renderers don't merge.
function cellPreview(v: any) {
  if (v === undefined) return <AbsentValue />;
  if (v === null) return <NullValue />;
  if (v === '') return <EmptyValue />;
  if (typeof v === 'object') return <span class="csv-cell-string">{displayValue(v)}</span>;
  return <ScalarValue value={v} />;
}
