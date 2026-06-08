import { h } from 'preact';
import { useState } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Segmented, Toggle } from './CsvImportWizard.jsx';

const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'csv-export-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'csv-export-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'csv-export-delim-tab' },
];

// Options shown before a CSV export, then handed to the caller which starts the
// download (the Download click is the user gesture for the save-file picker).
export default function CsvExportOptions({ onDownload }) {
  const [delimiter, setDelimiter] = useState(',');
  const [header, setHeader] = useState(true);
  const [bom, setBom] = useState(true);
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
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Add a UTF-8 BOM so Excel reads accented characters correctly.">Excel-friendly (BOM)</span>
          <Toggle checked={bom} onChange={setBom} testid="csv-export-bom" title="Add a UTF-8 BOM for Excel." />
        </span>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="csv-export-download"
          onClick={() => { closeModal(); onDownload({ delimiter, header, bom }); }}>
          Download
        </button>
      </div>
    </div>
  );
}
