import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { parseCsv, detectDelimiter } from '../csv.js';
import { Segmented, Toggle } from '../components/ImportControls.jsx';

// The options bag every format's Configure controls edit, plus its setter.
type ControlsProps = { opts: Record<string, any>; setOpt: (key: string, value: any) => void };

const DEFAULT_OPTS = {
  delimiter: ',',
  quoteChar: '"',
  escapeChar: '',
  doubleQuote: true,
  encoding: 'utf-8',
  hasHeader: true,
  inferTypes: false,
  restoreValues: true,
  emptyMode: 'empty',
  skipEmptyLines: true,
  trim: false,
};

// Delimiter pills (comma / semicolon / tab — matches the export modal).
const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'csv-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'csv-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'csv-delim-tab' },
];

const ENCODING_SEG = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1252', label: '1252' },
  { value: 'iso-8859-1', label: 'Latin-1' },
  { value: 'utf-16le', label: 'UTF-16' },
];

const EMPTY_SEG = [
  { value: 'empty', label: '""', title: 'Empty string' },
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

function ConfigureControls({ opts, setOpt }: ControlsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div data-testid="csv-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Character between fields.">Delimiter</span>
          <Segmented
            value={opts.delimiter}
            options={DELIM_SEG}
            onChange={(v) => setOpt('delimiter', v)}
            ariaLabel="Delimiter"
          />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Use row 1 as field names. Off → fields named column_1, column_2, …">First row is a header</span>
          <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="csv-header"
            title="Use row 1 as field names." />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Rebuild objects and arrays the export flattened, and match values to the types this collection already uses.">Restore structure {'&'} types</span>
          <Toggle checked={opts.restoreValues} onChange={(v) => setOpt('restoreValues', v)} testid="csv-restore"
            title="Rebuild what the export flattened." />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Read numbers and true/false out of text, for columns the collection has no type for.">Detect numbers {'&'} booleans</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="csv-infer"
            title="Detect numbers and true/false." />
        </span>

        <button type="button" class="csv-adv-toggle" data-testid="csv-advanced-toggle"
          aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
          Advanced {advancedOpen ? '▴' : '▾'}
        </button>
      </div>

      {advancedOpen && (
        <div class="csv-advanced" data-testid="csv-advanced">
          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Encoding</span>
              <Segmented value={opts.encoding} options={ENCODING_SEG} testid="csv-encoding"
                ariaLabel="Encoding" onChange={(v) => setOpt('encoding', v)} />
            </span>
            <div class="csv-opt-hint">Pick a legacy encoding if accented characters look garbled.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Empty cell {'→'}</span>
              <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="csv-empty"
                ariaLabel="Empty cell" onChange={(v) => setOpt('emptyMode', v)} />
            </span>
            <div class="csv-opt-hint">What an empty cell becomes in the document.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Trim values</span>
              <Toggle checked={opts.trim} onChange={(v) => setOpt('trim', v)} testid="csv-trim" />
            </span>
            <div class="csv-opt-hint">Strip leading/trailing whitespace around each value.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function parse(buffer: any, opts: any) {
  return parseCsv(buffer, { ...opts, escapeChar: opts.escapeChar || null });
}

// Sniff initial options from the raw file (decode a UTF-8 sample) so the
// Delimiter pill is preselected. Best-effort: any failure returns {}.
function detectOpts(arrayBuffer: any) {
  try {
    const sample = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer).subarray(0, 65536));
    return { delimiter: detectDelimiter(sample) };
  } catch {
    return {};
  }
}

export default { id: 'csv', label: 'CSV', accept: '.csv,text/csv', read: 'arrayBuffer', defaultOpts: DEFAULT_OPTS, parse, detectOpts, ConfigureControls };
