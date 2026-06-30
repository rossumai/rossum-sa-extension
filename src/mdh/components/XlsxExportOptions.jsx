import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Toggle } from './CsvImportWizard.jsx';
import { displayValue } from '../displayValue.js';

// Options + preview before an .xlsx export. `loadPreview` resolves
// { columns, sample }; the discovered columns are handed back through onDownload
// so the download doesn't re-scan. Mirrors CsvExportOptions (sheet name replaces
// the CSV delimiter; the preview is a small grid instead of CSV text).
export default function XlsxExportOptions({ loadPreview, onDownload }) {
  const [sheetName, setSheetName] = useState('Sheet1');
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

  function download() {
    const cols = (!preview.loading && !preview.error && preview.columns.length) ? preview.columns : null;
    closeModal();
    onDownload({ sheetName, header, columns: cols });
  }

  return (
    <div class="modal-body csv-export-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Worksheet tab name.">Sheet name</span>
          <input class="xlsx-sheet-select" data-testid="xlsx-export-sheet" value={sheetName} onInput={(e) => setSheetName(e.target.value)} />
        </span>
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Write a first row with the field names.">Header row</span>
          <Toggle checked={header} onChange={setHeader} testid="xlsx-export-header" title="Write a header row." />
        </span>
        <span class="toolbar-menu-beta">beta</span>
      </div>

      <div class="csv-export-preview" data-testid="xlsx-export-preview">
        {preview.loading ? <div class="csv-export-preview-note">Building preview{'…'}</div>
          : preview.error ? <div class="csv-export-preview-note">Preview unavailable</div>
          : preview.columns.length === 0 ? <div class="csv-export-preview-note">No rows to preview</div>
          : (
            <Fragment>
              <div class="csv-export-preview-caption">
                Preview {'·'} first {preview.sample.length} row{preview.sample.length === 1 ? '' : 's'} {'·'} {preview.columns.length} column{preview.columns.length === 1 ? '' : 's'}
              </div>
              <div class="csv-preview-scroll">
                <table class="csv-preview-table">
                  {header && <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>}
                  <tbody>
                    {preview.sample.map((d, i) => (
                      <tr key={i}>{preview.columns.map((c) => <td key={c}>{cellPreview(d == null ? undefined : d[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Fragment>
          )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="xlsx-export-download" onClick={download}>Download</button>
      </div>
    </div>
  );
}

function cellPreview(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return displayValue(v);
  return String(v);
}
