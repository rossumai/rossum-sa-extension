import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { docToXml, toXmlName } from '../xml.js';

// Options + live XML-text preview before an XML export. `loadPreview` resolves a
// small { sample } of docs; the preview re-serializes locally on a name change.
export default function XmlExportOptions({ loadPreview, onDownload }) {
  const [rootName, setRootName] = useState('records');
  const [recordName, setRecordName] = useState('record');
  const [preview, setPreview] = useState({ loading: true, sample: [], error: null });

  useEffect(() => {
    let live = true;
    if (!loadPreview) { setPreview({ loading: false, sample: [], error: null }); return undefined; }
    loadPreview()
      .then((r) => { if (live) setPreview({ loading: false, sample: r.sample || [], error: null }); })
      .catch((e) => { if (live) setPreview({ loading: false, sample: [], error: e?.message || 'failed' }); });
    return () => { live = false; };
  }, []);

  const root = toXmlName(rootName);
  const previewText = preview.sample.length
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n` + preview.sample.map((d) => '  ' + docToXml(d, recordName)).join('\n') + `\n</${root}>\n`
    : '';

  function download() { closeModal(); onDownload({ rootName, recordName }); }

  return (
    <div class="modal-body csv-export-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item"><span class="csv-tb-k" title="Top-level wrapper element.">Root element</span>
          <input class="xlsx-sheet-select" data-testid="xml-export-root" value={rootName} onInput={(e) => setRootName(e.target.value)} /></span>
        <span class="csv-tb-item"><span class="csv-tb-k" title="Element wrapping each document.">Record element</span>
          <input class="xlsx-sheet-select" data-testid="xml-export-record" value={recordName} onInput={(e) => setRecordName(e.target.value)} /></span>
        <span class="toolbar-menu-beta">beta</span>
      </div>

      <div class="csv-export-preview" data-testid="xml-export-preview">
        {preview.loading ? <div class="csv-export-preview-note">Building preview{'…'}</div>
          : preview.error ? <div class="csv-export-preview-note">Preview unavailable</div>
          : preview.sample.length === 0 ? <div class="csv-export-preview-note">No rows to preview</div>
          : (
            <Fragment>
              <div class="csv-export-preview-caption">Preview {'·'} first {preview.sample.length} record{preview.sample.length === 1 ? '' : 's'}</div>
              <pre class="csv-export-preview-text">{previewText}</pre>
            </Fragment>
          )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="xml-export-download" onClick={download}>Download</button>
      </div>
    </div>
  );
}
