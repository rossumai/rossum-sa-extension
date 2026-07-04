# Unified Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ten-path Download hover-menu + three per-format modals with one Export button opening one modal (scope, format, options, preview, exact count, verified copy), collapsing ~450 duplicated DataPanel lines.

**Architecture:** A format registry (`exportFormats.jsx`, mirroring import's `formats/`) + one `ExportWizard.jsx` config-collector modal + a pure `parseExportFilter` in `pipelineOps.js`. DataPanel keeps its single `runDownloadJob`; the streaming engine `downloadCollection.js` is UNTOUCHED. Spec: `docs/superpowers/specs/2026-07-04-export-unify-design.md` (fact table E1–E13 grounds all copy).

**Tech Stack:** Preact + signals, vitest (jsdom), esbuild. No new dependencies.

## Global Constraints

- **NO git commits at any step** (leave everything uncommitted on `master`; unrelated Inspector work is in the tree — never touch `src/inspector/*`, `tests/inspector-*`).
- Tests are `.test.js` rendering via `h(Component, {...})` — no raw JSX in tests; no raw NBSP bytes; no customer-looking data (use `sku`/`name`/`region`/`price`).
- JSX unicode: `\uXXXX` does NOT work in JSX text — use `{'—'}`-style expressions or literal glyphs.
- UI copy must match the spec §4 lines **verbatim** (scope labels `All records` / `Current filter`; the five "What will happen" lines; count line `Exports {n} documents to {filename} — streamed to a file you choose.`; large-export suffix `Large export — this may take a while.`).
- `src/mdh/downloadCollection.js` must not change (engine untouched; its tests `mdh-download-collection`/`mdh-csv-export`/`mdh-download-xlsx` keep passing unmodified).
- Scoped test runs per task; full `npm test` + `npm run build` in the final task.

---

### Task 1: `exportFormats.jsx` registry + `parseExportFilter`

**Files:**
- Create: `src/mdh/exportFormats.jsx`
- Modify: `src/mdh/pipelineOps.js` (append `parseExportFilter`)
- Test: `tests/mdh-export-formats.test.js` (new), `tests/mdh-pipeline-ops.test.js` (append; if the pipelineOps tests live under a different name, locate with `grep -rln "stripPaginationStages" tests/` and append there)

**Interfaces:**
- Produces: `EXPORT_FORMATS` (ordered array), `getExportFormat(id)`, `exportFilename(collection, scope, fmt)`, `buildExportJob(config, collection, stages)`, and per-format descriptors `{ id, label, ext, needsColumns, defaultOpts, OptionsControls|null, buildSerializer(opts, columns), previewKind: 'text'|'grid', buildPreviewText?(sample, columns, opts) }`.
- Produces: `parseExportFilter(rawText, substitute) → { stages, available, trivial?, reason? }` (pipelineOps.js).
- Consumed by Tasks 2–3.

- [ ] **Step 1: Write the failing tests** — `tests/mdh-export-formats.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EXPORT_FORMATS, getExportFormat, exportFilename, buildExportJob } from '../src/mdh/exportFormats.jsx';

describe('export format registry', () => {
  it('lists the five formats in menu order with the right extensions', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['json', 'jsonl', 'csv', 'xlsx', 'xml']);
    expect(EXPORT_FORMATS.map((f) => f.ext)).toEqual(['json', 'jsonl', 'csv', 'xlsx', 'xml']);
    expect(EXPORT_FORMATS.map((f) => f.needsColumns)).toEqual([false, false, true, true, false]);
  });

  it('builds serializers with options passed through (incl. the CSV BOM flag)', () => {
    const csv = getExportFormat('csv').buildSerializer({ delimiter: ';', header: false, bom: true }, ['sku', 'price']);
    expect(csv.ext).toBe('csv');
    expect(csv.preamble()).toBe('\uFEFF'); // BOM on, header off
    const noBom = getExportFormat('csv').buildSerializer({ delimiter: ',', header: true, bom: false }, ['sku']);
    expect(noBom.preamble()).toBe('sku\r\n'); // no BOM (today's default), header on
    expect(getExportFormat('xml').buildSerializer({ rootName: 'rows', recordName: 'row' }).preamble()).toContain('<rows>');
    expect(getExportFormat('json').buildSerializer({}).ext).toBe('json');
    expect(getExportFormat('jsonl').buildSerializer({}).ext).toBe('jsonl');
    expect(getExportFormat('xlsx').buildSerializer({ sheetName: 'S', header: true }, ['sku']).binary).toBe(true);
  });

  it('builds preview text per format', () => {
    const sample = [{ sku: 'A', price: 1 }];
    expect(getExportFormat('jsonl').buildPreviewText(sample, null, {})).toBe('{"sku":"A","price":1}');
    expect(getExportFormat('json').buildPreviewText(sample, null, {})).toContain('"sku": "A"');
    expect(getExportFormat('csv').buildPreviewText(sample, ['sku', 'price'], { delimiter: ';', header: true })).toBe('sku;price\nA;1');
    expect(getExportFormat('xml').buildPreviewText(sample, null, { rootName: 'records', recordName: 'record' })).toContain('<record>');
    expect(getExportFormat('xlsx').previewKind).toBe('grid');
  });

  it('exportFilename follows the col / col-filtered convention', () => {
    const fmt = getExportFormat('csv');
    expect(exportFilename('vendors', 'all', fmt)).toBe('vendors.csv');
    expect(exportFilename('vendors', 'filtered', fmt)).toBe('vendors-filtered.csv');
  });

  it('buildExportJob assembles the runDownloadJob config', async () => {
    const stages = [{ $match: { region: 'EU' } }];
    const job = buildExportJob({ scope: 'filtered', formatId: 'csv', opts: { delimiter: ',', header: true, bom: false }, columns: ['sku'], count: 42 }, 'vendors', stages);
    expect(job.filename).toBe('vendors-filtered.csv');
    expect(job.filtered).toBe(true);
    expect(job.pipelineStages).toBe(stages);
    expect(await job.fetchCount()).toBe(42);
    expect(job.serializer.ext).toBe('csv');
    const allJob = buildExportJob({ scope: 'all', formatId: 'json', opts: {}, columns: null, count: null }, 'vendors', null);
    expect(allJob.pipelineStages).toEqual([{ $match: {} }]);
    expect(allJob.filtered).toBe(false);
    expect(await allJob.fetchCount()).toBe(0); // null count -> engine-tolerated 0 (spec §4.7)
  });
});
```

Append to the pipelineOps test file:

```js
describe('parseExportFilter', () => {
  const id = (t) => t; // substitute pass-through
  it('returns stages for a real filter', () => {
    const r = parseExportFilter('[{"$match":{"region":"EU"}}]', id);
    expect(r.available).toBe(true);
    expect(r.stages).toEqual([{ $match: { region: 'EU' } }]);
    expect(r.trivial).toBe(false);
  });
  it('flags the trivial match-all (spec §2 preselection rule)', () => {
    expect(parseExportFilter('[{"$match":{}}]', id).trivial).toBe(true);
  });
  it('empty pipeline -> unavailable with the exact copy', () => {
    const r = parseExportFilter('[]', id);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('No filter is active — the pipeline is empty.');
  });
  it('parse error / non-array -> unavailable with the error message', () => {
    expect(parseExportFilter('nonsense{', id).available).toBe(false);
    expect(parseExportFilter('{"$match":{}}', id).reason).toMatch(/array/);
  });
  it('strips pagination stages before deciding', () => {
    const r = parseExportFilter('[{"$skip": 20}, {"$limit": 10}]', id);
    expect(r.available).toBe(false); // nothing left after stripping
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/mdh-export-formats.test.js` (module missing) and the pipelineOps file (function missing).

- [ ] **Step 3: Implement** — `src/mdh/exportFormats.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { Segmented, Toggle } from './components/ImportControls.jsx';
import { buildJsonSerializer, buildNdjsonSerializer, buildCsvSerializer, buildXmlSerializer, buildXlsxSerializer } from './downloadCollection.js';
import { csvHeader, csvRow } from './csv.js';
import { docToXml, toXmlName } from './xml.js';

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

// config -> the argument object for DataPanel's runDownloadJob. A null count
// (count fetch failed/pending) degrades to 0, which the engine clamps into an
// indeterminate progress bar (spec §4.7).
export function buildExportJob(config, collection, stages) {
  const fmt = getExportFormat(config.formatId);
  const filtered = config.scope === 'filtered';
  return {
    pipelineStages: filtered ? stages : [{ $match: {} }],
    filename: exportFilename(collection, config.scope, fmt),
    filtered,
    fetchCount: async () => (Number.isFinite(config.count) ? config.count : 0),
    serializer: fmt.buildSerializer(config.opts || fmt.defaultOpts, config.columns),
  };
}
```

Append to `src/mdh/pipelineOps.js` (it already exports `stripPaginationStages`; add `import JSON5 from 'json5';` at the top if absent):

```js
// Parse the editor pipeline for the export wizard's "Current filter" scope.
// substitute = the placeholder substituter (pipeline.substituteWithTypes).
// Never throws: any problem comes back as { available: false, reason }.
export function parseExportFilter(rawText, substitute) {
  try {
    const parsed = JSON5.parse(substitute(rawText));
    if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
    const stages = stripPaginationStages(parsed);
    if (stages.length === 0) return { stages: null, available: false, reason: 'No filter is active — the pipeline is empty.' };
    return { stages, available: true, trivial: stages.length === 1 && JSON.stringify(stages[0]) === '{"$match":{}}' };
  } catch (err) {
    return { stages: null, available: false, reason: err.message };
  }
}
```

- [ ] **Step 4: Run to verify pass** — both test files green. Also `npx vitest run tests/mdh-download-collection.test.js tests/mdh-csv-export.test.js tests/mdh-download-xlsx.test.js` — engine untouched, still green.

### Task 2: `ExportWizard.jsx`

**Files:**
- Create: `src/mdh/components/ExportWizard.jsx`
- Modify: `src/console/console.css` (append `.export-wizard` rules ONLY — do not touch other selectors; Inspector work coexists in this file)
- Test: `tests/mdh-export-wizard.test.js` (new)

**Interfaces:**
- Consumes: `EXPORT_FORMATS`/`getExportFormat`/`exportFilename` (Task 1), `api.aggregate`, `buildColumnDiscoveryPipeline` (csv.js), `orderExportColumns` (recordColumns.js), `Segmented` (ImportControls), `closeModal` (Modal.jsx), `displayValue` (grid cells).
- Produces: `<ExportWizard collection filterState totalCount recordsSample onExport />`; on Download calls `closeModal()` then `onExport({ scope, formatId, opts, columns, count })`. Task 3 wires it.

Props contract: `filterState` is `parseExportFilter`'s result; `totalCount` number|null; `recordsSample` array (column ordering seed).

- [ ] **Step 1: Write the failing tests** — `tests/mdh-export-wizard.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/components/Modal.jsx', () => ({ closeModal: vi.fn() }));
import { h, render } from 'preact';
import ExportWizard from '../src/mdh/components/ExportWizard.jsx';
import * as api from '../src/mdh/api.js';
import { closeModal } from '../src/mdh/components/Modal.jsx';

function mount(props) { const el = document.createElement('div'); document.body.appendChild(el); render(h(ExportWizard, props), el); return el; }
async function waitFor(fn, ms = 2000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }

const FILTER = { stages: [{ $match: { region: 'EU' } }], available: true, trivial: false };
const NO_FILTER = { stages: null, available: false, reason: 'No filter is active — the pipeline is empty.' };
const base = { collection: 'vendors', filterState: NO_FILTER, totalCount: 3, recordsSample: [], onExport: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: sample fetch -> 2 docs; count/columns fetches resolved generically.
  api.aggregate.mockImplementation(async (_c, pipeline) => {
    const last = pipeline[pipeline.length - 1] || {};
    if ('$count' in last) return { result: [{ total: 7 }] };
    if (JSON.stringify(pipeline).includes('$group')) return { result: [{ keys: ['sku', 'price'] }] }; // column discovery
    return { result: [{ sku: 'A', price: 1 }, { sku: 'B', price: 2 }] };
  });
});

describe('ExportWizard', () => {
  it('preselects All records when no filter is active, and disables Current filter with the reason', async () => {
    const root = mount(base);
    const all = await waitFor(() => [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim() === 'All records'));
    expect(all.getAttribute('aria-pressed')).toBe('true');
    const filtered = [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim() === 'Current filter');
    expect(filtered.disabled).toBe(true);
    expect(root.textContent).toMatch(/No filter is active/);
  });

  it('preselects Current filter when a real filter is active', async () => {
    const root = mount({ ...base, filterState: FILTER });
    const filtered = await waitFor(() => [...root.querySelectorAll('[data-testid="export-scope"] button')].find((b) => b.textContent.trim() === 'Current filter'));
    expect(filtered.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the exact count and filename in the count line (all-records uses totalCount)', async () => {
    const root = mount(base);
    await waitFor(() => /Exports 3 documents to vendors\.json/.test(root.querySelector('[data-testid="export-count"]').textContent));
  });

  it('warns inline above 10,000 documents — no popup', async () => {
    const root = mount({ ...base, totalCount: 25000 });
    const line = await waitFor(() => root.querySelector('[data-testid="export-count"]'));
    await waitFor(() => /Large export — this may take a while\./.test(line.textContent));
    expect(line.classList.contains('import-warn')).toBe(true);
    expect(root.querySelector('[data-testid="export-download"]').disabled).toBe(false);
  });

  it('switching format swaps the options strip and preview kind, and re-labels Download', async () => {
    const root = mount(base);
    await waitFor(() => root.querySelector('[data-testid="export-preview"]'));
    const csvBtn = [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV');
    csvBtn.click();
    await waitFor(() => root.querySelector('[data-testid="export-csv-bom"]'));
    await waitFor(() => /sku,price/.test(root.querySelector('[data-testid="export-preview"]').textContent));
    expect(root.querySelector('[data-testid="export-download"]').textContent).toMatch(/Download CSV/);
    const xlsxBtn = [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'Excel');
    xlsxBtn.click();
    await waitFor(() => root.querySelector('.csv-preview-table')); // grid preview
  });

  it('what-will-happen shows the columns line only for column formats', async () => {
    const root = mount(base);
    const steps = await waitFor(() => root.querySelector('[data-testid="export-plan"]'));
    expect(steps.textContent).toMatch(/1,000-record batches/);
    expect(steps.textContent).toMatch(/Cancelling discards the partial file/);
    expect(steps.textContent).toMatch(/read-only/);
    expect(steps.textContent).not.toMatch(/union of fields/);
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => /union of fields/.test(root.querySelector('[data-testid="export-plan"]').textContent));
  });

  it('Download hands the full config to onExport and closes the modal', async () => {
    const onExport = vi.fn();
    const root = mount({ ...base, filterState: FILTER, onExport });
    await waitFor(() => root.querySelector('[data-testid="export-preview"]'));
    [...root.querySelectorAll('[data-testid="export-format"] button')].find((b) => b.textContent.trim() === 'CSV').click();
    await waitFor(() => root.querySelector('[data-testid="export-csv-bom"]'));
    // count for filtered scope resolves to 7 via the $count mock
    await waitFor(() => /Exports 7 documents/.test(root.querySelector('[data-testid="export-count"]').textContent));
    root.querySelector('[data-testid="export-download"]').click();
    expect(closeModal).toHaveBeenCalled();
    expect(onExport).toHaveBeenCalledWith({
      scope: 'filtered', formatId: 'csv',
      opts: { delimiter: ',', header: true, bom: false },
      columns: ['sku', 'price'], count: 7,
    });
  });

  it('a failed count never blocks Download (config carries count: null)', async () => {
    api.aggregate.mockImplementation(async (_c, pipeline) => {
      const last = pipeline[pipeline.length - 1] || {};
      if ('$count' in last) throw new Error('boom');
      return { result: [] };
    });
    const onExport = vi.fn();
    const root = mount({ ...base, totalCount: null, onExport });
    const btn = await waitFor(() => { const b = root.querySelector('[data-testid="export-download"]'); return b && !b.disabled ? b : null; });
    btn.click();
    expect(onExport.mock.calls[0][0].count).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement** — `src/mdh/components/ExportWizard.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Segmented } from './ImportControls.jsx';
import { EXPORT_FORMATS, getExportFormat, exportFilename } from '../exportFormats.jsx';
import { buildColumnDiscoveryPipeline } from '../csv.js';
import { orderExportColumns } from '../recordColumns.js';
import { displayValue } from '../displayValue.js';
import * as api from '../api.js';

const SCOPE_SEG_BASE = [
  { value: 'all', label: 'All records' },
  { value: 'filtered', label: 'Current filter' },
];
const FORMAT_SEG = EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }));
const LARGE_EXPORT = 10_000;
const PREVIEW_ROWS = 10;

// Single-screen export config collector (the import wizard's counterpart).
// Pure UI: fetches count/preview read-only; hands ONE config object to
// onExport and never touches the download engine itself.
export default function ExportWizard({ collection, filterState, totalCount, recordsSample, onExport }) {
  const [scope, setScope] = useState(filterState.available && !filterState.trivial ? 'filtered' : 'all');
  const [formatId, setFormatId] = useState('json');
  const [opts, setOpts] = useState({});
  const [count, setCount] = useState({ value: null, loading: true });
  const [preview, setPreview] = useState({ loading: true, columns: null, sample: [], error: null });
  const seq = useRef(0);

  const fmt = getExportFormat(formatId);
  const effOpts = { ...fmt.defaultOpts, ...opts };
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const stages = scope === 'filtered' ? filterState.stages : [{ $match: {} }];
  const filename = exportFilename(collection, scope, fmt);

  function switchFormat(id) { setFormatId(id); setOpts({}); }

  // Exact count per scope (stale-guarded). All-records reuses the pagination
  // total when known; a failure only degrades the line — never blocks (§4.7).
  useEffect(() => {
    const my = ++seq.current;
    if (scope === 'all' && totalCount !== null && totalCount !== undefined) {
      setCount({ value: totalCount, loading: false });
      return undefined;
    }
    setCount({ value: null, loading: true });
    api.aggregate(collection, [...stages, { $count: 'total' }])
      .then((r) => { if (seq.current === my) setCount({ value: r.result?.[0]?.total ?? 0, loading: false }); })
      .catch(() => { if (seq.current === my) setCount({ value: null, loading: false }); });
    return undefined;
  }, [scope]);

  // Sample + (for column formats) column discovery. Columns are fetched once
  // per scope and reused across formats; the preview text re-renders locally
  // on option changes.
  const [cols, setCols] = useState({ loading: false, value: null });
  useEffect(() => {
    let alive = true;
    setPreview((p) => ({ ...p, loading: true, error: null }));
    api.aggregate(collection, [...stages, { $limit: PREVIEW_ROWS }])
      .then((r) => { if (alive) setPreview({ loading: false, columns: null, sample: r.result || [], error: null }); })
      .catch((e) => { if (alive) setPreview({ loading: false, columns: null, sample: [], error: e?.message || 'failed' }); });
    setCols({ loading: true, value: null });
    api.aggregate(collection, buildColumnDiscoveryPipeline(stages))
      .then((r) => { if (alive) setCols({ loading: false, value: orderExportColumns(recordsSample || [], r.result?.[0]?.keys ?? []) }); })
      .catch(() => { if (alive) setCols({ loading: false, value: null }); });
    return () => { alive = false; };
  }, [scope]);

  const columns = cols.value;
  const isLarge = count.value !== null && count.value > LARGE_EXPORT;

  function download() {
    closeModal();
    onExport({ scope, formatId, opts: effOpts, columns: fmt.needsColumns ? columns : null, count: count.value });
  }

  const scopeSeg = SCOPE_SEG_BASE.map((s) => (s.value === 'filtered' && !filterState.available ? { ...s, disabled: true } : s));

  return (
    <div class="modal-body export-wizard">
      <Segmented value={scope} options={scopeSeg} onChange={setScope} ariaLabel="Export scope" testid="export-scope" tabs />
      {!filterState.available && filterState.reason && (
        <div class="import-shape-neutral" style="margin-top:4px">{filterState.reason}</div>
      )}

      <div class="modal-field-label" style="margin-top:10px">Format</div>
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
                {effOpts.header && columns && <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>}
                <tbody>
                  {preview.sample.map((d, i) => (
                    <tr key={i}>{(columns || []).map((c) => <td key={c}>{cellPreview(d == null ? undefined : d[c])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Fragment>
        ) : (
          <Fragment>
            <PreviewCaption sample={preview.sample} columns={fmt.needsColumns ? columns : null} />
            <pre class="csv-export-preview-text">{fmt.needsColumns && !columns ? 'Preview unavailable' : fmt.buildPreviewText(preview.sample, columns, effOpts)}</pre>
          </Fragment>
        )}
      </div>

      <div class={`export-count${isLarge ? ' import-warn' : ''}`} data-testid="export-count">
        {count.loading && <span>Counting documents{'…'}</span>}
        {!count.loading && count.value !== null && (
          <span>Exports {count.value.toLocaleString()} documents to <code>{filename}</code> {'—'} streamed to a file you choose.{isLarge ? ' Large export ' + '—' + ' this may take a while.' : ''}</span>
        )}
        {!count.loading && count.value === null && (
          <span>Exports to <code>{filename}</code> {'—'} streamed to a file you choose.</span>
        )}
      </div>

      <div class="import-steps" data-testid="export-plan">
        <div class="import-steps-head">What will happen</div>
        <ul>
          <li>Downloads in 1,000-record batches (10 in parallel) and streams to the file you pick; if the browser can{'’'}t stream, the file downloads normally when complete.</li>
          <li>Records are exported in a stable order {'—'} your filter{'’'}s final sort if it has one, otherwise by <code>_id</code>.</li>
          {fmt.needsColumns && <li>Columns are the union of fields across the exported records, in table order.</li>}
          <li>Cancelling discards the partial file {'—'} nothing is saved.</li>
          <li>The export is read-only {'—'} the collection is never modified.</li>
        </ul>
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="export-download" onClick={download}>Download {fmt.label}</button>
      </div>
    </div>
  );
}

function PreviewCaption({ sample, columns }) {
  return (
    <div class="csv-export-preview-caption">
      Preview {'·'} first {sample.length} row{sample.length === 1 ? '' : 's'}{columns ? <Fragment> {'·'} {columns.length} column{columns.length === 1 ? '' : 's'}</Fragment> : null}
    </div>
  );
}

function cellPreview(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return displayValue(v);
  return String(v);
}
```

NOTE for the implementer: check whether `Segmented` (ImportControls.jsx) supports a `disabled`
flag on options — read the component first. If it doesn't, add per-option `disabled` support
there (button `disabled={opt.disabled}`), which is additive and safe for existing callers.
The count line inside `.import-warn` needs the em-dash suffix EXACTLY:
`Large export — this may take a while.` (JS-string escape shown above keeps JSX-safety).

Append to `src/console/console.css` (new section, nothing else touched):

```css
/* Unified Export wizard */
.export-wizard .csv-export-preview { margin-top: 10px; }
.export-count { margin-top: 12px; font-size: 13px; color: var(--text-secondary); }
.export-count code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-primary); }
.export-count.import-warn { color: inherit; }
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/mdh-export-wizard.test.js tests/mdh-export-formats.test.js`.

### Task 3: Wire DataPanel + RecordList; collapse the ten handlers

**Files:**
- Modify: `src/mdh/components/DataPanel.jsx` (imports; `handleToolbarAction`; DELETE `downloadAll`, `downloadFiltered`, `downloadAllJsonl`, `downloadFilteredJsonl`, `downloadAllCsv`, `downloadFilteredCsv`, `downloadAllXml`, `downloadFilteredXml`, `downloadAllXlsx`, `downloadFilteredXlsx`; ADD `openExport`/`executeExport`; keep `runDownloadJob` unchanged)
- Modify: `src/mdh/components/RecordList.jsx` (swap `DownloadSplitButton` for the Export button)
- Test: `tests/mdh-export-wire.test.js` (new, light), update `tests/mdh-record-list-footer.test.js` only if it references the split button (check first)

**Interfaces:**
- Consumes: `ExportWizard` (Task 2), `parseExportFilter` + `buildExportJob` (Task 1), existing `openModal`, `runDownloadJob`, `pipeline.substituteWithTypes`, `records`/`pagination` signals.
- Produces: toolbar action `'export'`; `RecordList` renders `<button class="btn btn-sm" data-testid="export-open">Export</button>` → `onRefresh('export')`.

- [ ] **Step 1: Write the failing wire test** — `tests/mdh-export-wire.test.js` exercises the pure seam (DataPanel itself has no dedicated harness; the pure job assembly + the RecordList button are the testable seams):

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildExportJob, getExportFormat } from '../src/mdh/exportFormats.jsx';
import { parseExportFilter } from '../src/mdh/pipelineOps.js';

describe('export wiring seam', () => {
  it('a parsed filter feeds buildExportJob end to end', async () => {
    const f = parseExportFilter('[{"$match":{"region":"EU"}}]', (t) => t);
    const job = buildExportJob({ scope: 'filtered', formatId: 'xlsx', opts: getExportFormat('xlsx').defaultOpts, columns: ['sku'], count: 5 }, 'vendors', f.stages);
    expect(job.filename).toBe('vendors-filtered.xlsx');
    expect(job.pipelineStages).toEqual([{ $match: { region: 'EU' } }]);
    expect(job.serializer.binary).toBe(true);
    expect(await job.fetchCount()).toBe(5);
  });
});
```

Also check `grep -n "DownloadSplitButton\|download-all\|download-filtered" tests/mdh-record-list-footer.test.js` — update any references to expect `[data-testid="export-open"]` instead.

- [ ] **Step 2: Run to verify failure/gaps** — new test passes immediately if Task 1 landed (it's a seam lock, not a red test — acceptable); the record-list test fails if it referenced the split button and RecordList is not yet updated. Proceed.

- [ ] **Step 3: Implement** — `RecordList.jsx`: replace the whole `<DownloadSplitButton …/>` element (10 props) with:

```jsx
          <button class="btn btn-sm" data-testid="export-open" title="Export collection" onClick={() => onRefresh('export')}>Export</button>
```

and delete the `import DownloadSplitButton …` line.

`DataPanel.jsx`:
- Imports: remove `buildCsvSerializer, buildXmlSerializer, buildNdjsonSerializer, buildXlsxSerializer` from the downloadCollection import (keep `downloadCollection as runDownload`); remove the `CsvExportOptions`/`XmlExportOptions`/`XlsxExportOptions` imports; add `import ExportWizard from './ExportWizard.jsx';`, `import { buildExportJob } from '../exportFormats.jsx';`, and add `parseExportFilter` to the pipelineOps import list.
- `handleToolbarAction`: the ten `download*` branches become one:

```js
    if (action === 'export') {
      openExport();
    } else if (action === 'import') {
      openImport(invalidateAndRun, currentFields);
    }
```

- Add the two functions (place where `downloadAll` used to start):

```js
  // ---- unified export ----
  function openExport() {
    const raw = editorRef.current ? editorRef.current.getValue() : '';
    const filterState = parseExportFilter(raw, (t) => pipeline.substituteWithTypes(t));
    const col = collection;
    openModal(`Export ${col}`, () => (
      <ExportWizard
        collection={col}
        filterState={filterState}
        totalCount={pagination.totalCount.value}
        recordsSample={records.value}
        onExport={(config) => executeExport(config, filterState)}
      />
    ));
  }

  async function executeExport(config, filterState) {
    await runDownloadJob(buildExportJob(config, collection, filterState.stages));
  }
```

- Delete the ten `downloadAll*/downloadFiltered*` functions and (after deletion) any now-unused locals they referenced exclusively (`downloadCountAbortRef` usage shrinks — keep the ref if the toolbar cancel path still uses it; verify with grep before removing anything shared).
- KEEP `runDownloadJob` byte-identical.

- [ ] **Step 4: Run to verify pass**

`npx vitest run tests/mdh-export-wire.test.js tests/mdh-record-list-footer.test.js tests/mdh-export-wizard.test.js` — green. Then `grep -n "downloadAllCsv\|downloadFilteredXlsx\|download-filtered-jsonl" src/mdh/components/DataPanel.jsx` — no output.

### Task 4: Delete retired components + sweep

**Files:**
- Delete: `src/mdh/components/DownloadSplitButton.jsx`, `src/mdh/components/CsvExportOptions.jsx`, `src/mdh/components/XlsxExportOptions.jsx`, `src/mdh/components/XmlExportOptions.jsx`, `tests/mdh-download-dropdown.test.js`, `tests/mdh-csv-export-options.test.js`, `tests/mdh-xlsx-export-options.test.js`
- Modify: `src/console/console.css` (remove ONLY selectors that are now referenced nowhere — verify each with grep; `.csv-toolbar`/`.csv-export-preview*`/`.csv-preview-*`/`.xlsx-sheet-select` are REUSED by the wizard and MUST stay; `.dropdown-btn`/`.toolbar-submenu*`/`.toolbar-more-menu`/`.toolbar-menu-item`/`.toolbar-menu-beta` may be shared with other toolbars — delete only what greps to zero uses in src/ after the deletions)

- [ ] **Step 1: Delete** — `rm` the seven files.
- [ ] **Step 2: Sweep** — `grep -rn "DownloadSplitButton\|CsvExportOptions\|XlsxExportOptions\|XmlExportOptions\|download-filtered-csv\|download-jsonl\|chooseSubmenuSide" src/ tests/` → no output. For each candidate CSS selector run `grep -rn "<name>" src/` and remove only zero-hit ones.
- [ ] **Step 3: Scoped green** — `npx vitest run tests/mdh-export-formats.test.js tests/mdh-export-wizard.test.js tests/mdh-export-wire.test.js tests/mdh-record-list-footer.test.js`.

### Task 5: Full verification

- [ ] **Step 1:** `npm test` — everything green (engine tests untouched and passing).
- [ ] **Step 2:** `npm run build` — clean; remind the owner to reload the extension (`dist/` is what runs).
- [ ] **Step 3:** NO commit (owner decides separately; Inspector work shares the tree).
