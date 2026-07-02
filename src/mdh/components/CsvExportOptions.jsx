import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Segmented, Toggle } from './ImportControls.jsx';
import { csvHeader, csvRow } from '../csv.js';

const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'csv-export-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'csv-export-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'csv-export-delim-tab' },
];

// Options + live CSV-text preview shown before a CSV export. `loadPreview` (injected
// by DataPanel) resolves { columns, sample } — the exact-union columns + a small row
// sample. The discovered columns are handed back through onDownload so the download
// doesn't re-scan. The preview re-serializes locally on a delimiter/header change.
export default function CsvExportOptions({ loadPreview, onDownload }) {
  const [delimiter, setDelimiter] = useState(',');
  const [header, setHeader] = useState(true);
  const [preview, setPreview] = useState({ loading: true, columns: [], sample: [], error: null });

  useEffect(() => {
    let live = true;
    if (!loadPreview) { setPreview({ loading: false, columns: [], sample: [], error: null }); return undefined; }
    loadPreview()
      .then((r) => { if (live) setPreview({ loading: false, columns: r.columns || [], sample: r.sample || [], error: null }); })
      .catch((e) => { if (live) setPreview({ loading: false, columns: [], sample: [], error: e?.message || 'failed' }); });
    return () => { live = false; };
  }, []);

  const dialect = { delimiter };
  const previewText = preview.columns.length
    ? (header ? csvHeader(preview.columns, dialect) + '\n' : '') +
      preview.sample.map((d) => csvRow(d, preview.columns, dialect)).join('\n')
    : '';

  function download() {
    const cols = (!preview.loading && !preview.error && preview.columns.length) ? preview.columns : null;
    closeModal();
    onDownload({ delimiter, header, columns: cols });
  }

  return (
    <div class="modal-body csv-export-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Character between fields.">Delimiter</span>
          <Segmented value={delimiter} options={DELIM_SEG} onChange={setDelimiter} ariaLabel="Delimiter" />
        </span>
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Write a first row with the field names.">Header row</span>
          <Toggle checked={header} onChange={setHeader} testid="csv-export-header" title="Write a header row." />
        </span>
      </div>

      <div class="csv-export-preview" data-testid="csv-export-preview">
        {preview.loading ? (
          <div class="csv-export-preview-note">Building preview{'…'}</div>
        ) : preview.error ? (
          <div class="csv-export-preview-note">Preview unavailable</div>
        ) : preview.columns.length === 0 ? (
          <div class="csv-export-preview-note">No rows to preview</div>
        ) : (
          <Fragment>
            <div class="csv-export-preview-caption">
              Preview {'·'} first {preview.sample.length} row{preview.sample.length === 1 ? '' : 's'} {'·'} {preview.columns.length} column{preview.columns.length === 1 ? '' : 's'}
            </div>
            <pre class="csv-export-preview-text">{previewText}</pre>
          </Fragment>
        )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="csv-export-download" onClick={download}>Download</button>
      </div>
    </div>
  );
}
