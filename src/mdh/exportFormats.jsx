import { h, Fragment } from 'preact';
import { Segmented, Toggle } from './components/ImportControls.jsx';
import { buildJsonSerializer, buildNdjsonSerializer, buildCsvSerializer, buildXmlSerializer, buildXlsxSerializer } from './downloadCollection.js';
import { csvHeader, csvRow } from './csv.js';
import { docToXml, toXmlName } from './xml.js';
import * as api from './api.js';

// Unified export-format registry — the export counterpart of formats/ on the
// import side. Each descriptor is a pure bundle of UI + serializer wiring; the
// streaming engine (downloadCollection.js) is untouched.

// Local copy of the engine's per-element JSON indent (not exported there; the
// engine must stay untouched). Preview-only.
function formatJsonDoc(doc) {
  return '  ' + JSON.stringify(doc, null, 2).replace(/\n/g, '\n  ');
}

const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'export-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'export-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'export-delim-tab' },
];

function CsvControls({ opts, setOpt }) {
  return (
    <Fragment>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Character between fields.">Delimiter</span>
        <Segmented value={opts.delimiter} options={DELIM_SEG} onChange={(v) => setOpt('delimiter', v)} ariaLabel="Delimiter" />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Write a first row with the field names.">Header row</span>
        <Toggle checked={opts.header} onChange={(v) => setOpt('header', v)} testid="export-csv-header" title="Write a header row." />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Byte-order mark; helps Excel open UTF-8 CSVs.">Excel-compatible (BOM)</span>
        <Toggle checked={opts.bom} onChange={(v) => setOpt('bom', v)} testid="export-csv-bom" title="Prefix the file with a UTF-8 BOM." />
      </span>
    </Fragment>
  );
}

function XlsxControls({ opts, setOpt }) {
  return (
    <Fragment>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Worksheet tab name.">Sheet name</span>
        <input class="xlsx-sheet-select" data-testid="export-xlsx-sheet" value={opts.sheetName} onInput={(e) => setOpt('sheetName', e.target.value)} />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Write a first row with the field names.">Header row</span>
        <Toggle checked={opts.header} onChange={(v) => setOpt('header', v)} testid="export-xlsx-header" title="Write a header row." />
      </span>
    </Fragment>
  );
}

function XmlControls({ opts, setOpt }) {
  return (
    <Fragment>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Top-level wrapper element.">Root element</span>
        <input class="xlsx-sheet-select" data-testid="export-xml-root" value={opts.rootName} onInput={(e) => setOpt('rootName', e.target.value)} />
      </span>
      <span class="csv-tb-item">
        <span class="csv-tb-k" title="Element wrapping each document.">Record element</span>
        <input class="xlsx-sheet-select" data-testid="export-xml-record" value={opts.recordName} onInput={(e) => setOpt('recordName', e.target.value)} />
      </span>
    </Fragment>
  );
}

export const EXPORT_FORMATS = [
  {
    id: 'json', label: 'JSON', ext: 'json', needsColumns: false, defaultOpts: {},
    OptionsControls: null, previewKind: 'text',
    buildSerializer: () => buildJsonSerializer(),
    buildPreviewText: (sample) => '[\n' + sample.map(formatJsonDoc).join(',\n') + '\n]',
  },
  {
    id: 'jsonl', label: 'JSON Lines', ext: 'jsonl', needsColumns: false, defaultOpts: {},
    OptionsControls: null, previewKind: 'text',
    buildSerializer: () => buildNdjsonSerializer(),
    buildPreviewText: (sample) => sample.map((d) => JSON.stringify(d)).join('\n'),
  },
  {
    id: 'csv', label: 'CSV', ext: 'csv', needsColumns: true,
    defaultOpts: { delimiter: ',', header: true, bom: false },
    OptionsControls: CsvControls, previewKind: 'text',
    buildSerializer: (opts, columns) => buildCsvSerializer({ dialect: { delimiter: opts.delimiter }, header: opts.header, bom: opts.bom, columns }),
    buildPreviewText: (sample, columns, opts) => {
      const dialect = { delimiter: opts.delimiter };
      return (opts.header ? csvHeader(columns, dialect) + '\n' : '') + sample.map((d) => csvRow(d, columns, dialect)).join('\n');
    },
  },
  {
    id: 'xlsx', label: 'Excel', ext: 'xlsx', needsColumns: true,
    defaultOpts: { sheetName: 'Sheet1', header: true },
    OptionsControls: XlsxControls, previewKind: 'grid',
    buildSerializer: (opts, columns) => buildXlsxSerializer({ sheetName: opts.sheetName, header: opts.header, columns }),
  },
  {
    id: 'xml', label: 'XML', ext: 'xml', needsColumns: false,
    defaultOpts: { rootName: 'records', recordName: 'record' },
    OptionsControls: XmlControls, previewKind: 'text',
    buildSerializer: (opts) => buildXmlSerializer({ rootName: opts.rootName, recordName: opts.recordName }),
    buildPreviewText: (sample, _columns, opts) => {
      const root = toXmlName(opts.rootName);
      return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n` + sample.map((d) => '  ' + docToXml(d, opts.recordName)).join('\n') + `\n</${root}>\n`;
    },
  },
];

export function getExportFormat(id) {
  return EXPORT_FORMATS.find((f) => f.id === id);
}

export function exportFilename(collection, scope, fmt) {
  return `${collection}${scope === 'filtered' ? '-filtered' : ''}.${fmt.ext}`;
}

// config -> the argument object for DataPanel's runDownloadJob. `config.count`
// is normally the wizard's already-fetched count (a fast path — no extra
// round-trip). When it isn't a finite number (fetch failed/pending/skipped),
// fetchCount runs the REAL count over the job's own pipelineStages rather than
// degrading to 0 — a 0 count means "zero batches" to the download engine
// (downloadCollection.js), which would silently write a record-less file and
// report success. Any aggregate failure propagates so the caller's catch
// surfaces "Download failed: …" instead of a silent empty export.
export function buildExportJob(config, collection, stages) {
  const fmt = getExportFormat(config.formatId);
  const filtered = config.scope === 'filtered';
  const pipelineStages = filtered ? stages : [{ $match: {} }];
  return {
    pipelineStages,
    filename: exportFilename(collection, config.scope, fmt),
    filtered,
    fetchCount: async () => {
      if (Number.isFinite(config.count)) return config.count;
      const r = await api.aggregate(collection, [...pipelineStages, { $count: 'total' }]);
      return r.result?.[0]?.total ?? 0;
    },
    serializer: fmt.buildSerializer(config.opts || fmt.defaultOpts, config.columns),
  };
}
