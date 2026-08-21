import { h } from 'preact';
import { parseXlsx } from '../xlsx.js';
import { Segmented, Toggle } from '../components/ImportControls.jsx';

// The options bag every format's Configure controls edit, plus its setter.
type ControlsProps = { opts: Record<string, any>; setOpt: (key: string, value: any) => void };

const defaultOpts = { sheet: null, hasHeader: true, emptyMode: 'null', trim: false };

const EMPTY_SEG = [
  { value: 'empty', label: '""', title: 'Empty string' },
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

function ConfigureControls({ opts, setOpt, parsed }: ControlsProps & { parsed?: any }) {
  const sheets = parsed?.sheets || [];
  return (
    <div class="csv-toolbar">
      {sheets.length > 1 && (
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Which worksheet to import.">Sheet</span>
          <select class="xlsx-sheet-select" data-testid="xlsx-sheet" value={opts.sheet ?? sheets[0]} onChange={(e: any) => setOpt('sheet', e.target.value)}>
            {sheets.map((s: any) => <option key={s} value={s}>{s}</option>)}
          </select>
        </span>
      )}
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Use row 1 as field names.">First row is a header</span>
        <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="xlsx-header" title="Use row 1 as field names." />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="What an empty cell becomes.">Empty cell {'→'}</span>
        <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="xlsx-empty" ariaLabel="Empty cell" onChange={(v) => setOpt('emptyMode', v)} />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Strip leading/trailing whitespace around text cells.">Trim values</span>
        <Toggle checked={opts.trim} onChange={(v) => setOpt('trim', v)} testid="xlsx-trim" title="Strip surrounding whitespace from text cells." />
      </span>
    </div>
  );
}

function parse(arrayBuffer: any, opts: any) {
  return parseXlsx(arrayBuffer, { sheet: opts.sheet, hasHeader: opts.hasHeader, emptyMode: opts.emptyMode, trim: opts.trim });
}

export default { id: 'xlsx', label: 'Excel', accept: '.xlsx', read: 'arrayBuffer', defaultOpts, parse, ConfigureControls };
