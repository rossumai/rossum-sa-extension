# CSV download (export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users export a Data Storage collection (whole or filtered) as a `.csv` file alongside the existing streamed JSON download, choosing delimiter / header / Excel-BOM options first.

**Architecture:** Generalize `downloadCollection.js` to a pluggable **serializer** (the streaming worker engine is reused; JSON behavior becomes the default JSON serializer; CSV is a second serializer that discovers the exact union of top-level columns via one pre-pass aggregation, then streams CSV rows). CSV serialization helpers live in `csv.js` (symmetric with the parser). A small options modal (reusing the wizard's `Segmented`/`Toggle`) precedes the save dialog; the Download menu gains a second "CSV" section.

**Tech Stack:** Preact + signals, esbuild, Vitest (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-mdh-csv-download-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** pure-logic tests = plain imports; component/engine tests = jsdom, `import { h, render } from 'preact'` / `vi.mock('../src/mdh/api.js')`, query by `data-testid`/class, condition-based `waitFor` (never fixed sleeps). JSX unicode literal in `{'…'}` form. `npm test` = whole suite; single file `npx vitest run tests/<file>.test.js`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/csv.js` | modify | Add pure CSV-export helpers: `csvCell`, `csvRow`, `csvHeader`, `orderColumns`, `buildColumnDiscoveryPipeline`. |
| `src/mdh/downloadCollection.js` | modify | Generalize to a `serializer`; add `buildJsonSerializer` (default, identical output) + `buildCsvSerializer`. |
| `src/mdh/components/CsvExportOptions.jsx` | **new** | Options modal (delimiter / header / BOM), reusing `Segmented`/`Toggle`. |
| `src/mdh/components/DownloadSplitButton.jsx` | modify | Two labeled sections (JSON / CSV), four callbacks. |
| `src/mdh/components/RecordList.jsx` | modify | Pass the four download handlers. |
| `src/mdh/components/DataPanel.jsx` | modify | `download-csv`/`download-filtered-csv` actions; `downloadAllCsv`/`downloadFilteredCsv`; `runDownloadJob` gains a `serializer` arg. |
| `src/console/console.css` | modify | `.toolbar-menu-section` label style. |
| `tests/mdh-csv-export.test.js` | **new** | Unit tests for the csv.js export helpers. |
| `tests/mdh-download-collection.test.js` | modify | Add CSV-serializer tests; keep all JSON tests green. |
| `tests/mdh-download-dropdown.test.js` | modify | Rewrite for the two-section / four-callback API. |
| `tests/mdh-csv-export-options.test.js` | **new** | Render tests for the options modal. |

---

## Task 1: CSV-export helpers in `csv.js`

**Files:**
- Modify: `src/mdh/csv.js`
- Test: `tests/mdh-csv-export.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/mdh-csv-export.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { csvCell, csvRow, csvHeader, orderColumns, buildColumnDiscoveryPipeline } from '../src/mdh/csv.js';

describe('csvCell', () => {
  const d = { delimiter: ',' };
  it('renders scalars', () => {
    expect(csvCell('abc', d)).toBe('abc');
    expect(csvCell(42, d)).toBe('42');
    expect(csvCell(true, d)).toBe('true');
    expect(csvCell(false, d)).toBe('false');
    expect(csvCell(null, d)).toBe('');
    expect(csvCell(undefined, d)).toBe('');
  });
  it('JSON-encodes objects and arrays', () => {
    expect(csvCell({ a: 1 }, d)).toBe('"{""a"":1}"');     // quoted because it contains a comma? no comma here, but contains "
    expect(csvCell([1, 2], d)).toBe('"[1,2]"');           // contains the delimiter , -> quoted
  });
  it('quotes and doubles quotes when the cell contains delimiter, quote, or newline', () => {
    expect(csvCell('a,b', d)).toBe('"a,b"');
    expect(csvCell('he said "hi"', d)).toBe('"he said ""hi"""');
    expect(csvCell('line1\nline2', d)).toBe('"line1\nline2"');
    expect(csvCell('semi;colon', { delimiter: ';' })).toBe('"semi;colon"');
  });
});

describe('csvRow / csvHeader', () => {
  it('joins cells by the delimiter in column order; missing key -> empty', () => {
    const cols = ['_id', 'name', 'active'];
    expect(csvRow({ _id: 'V1', name: 'Acme', active: true }, cols, { delimiter: ',' }))
      .toBe('V1,Acme,true');
    expect(csvRow({ _id: 'V2', name: 'Globex' }, cols, { delimiter: ',' }))
      .toBe('V2,Globex,');
  });
  it('quotes header names containing the delimiter', () => {
    expect(csvHeader(['_id', 'full,name'], { delimiter: ',' })).toBe('_id,"full,name"');
  });
});

describe('orderColumns', () => {
  it('puts _id first then sorts the rest alphabetically', () => {
    expect(orderColumns(['name', '_id', 'active'])).toEqual(['_id', 'active', 'name']);
  });
  it('omits _id when absent', () => {
    expect(orderColumns(['b', 'a'])).toEqual(['a', 'b']);
  });
  it('handles an empty key set', () => {
    expect(orderColumns([])).toEqual([]);
  });
});

describe('buildColumnDiscoveryPipeline', () => {
  it('appends objectToArray/unwind/group to the filter stages', () => {
    expect(buildColumnDiscoveryPipeline([{ $match: { active: true } }])).toEqual([
      { $match: { active: true } },
      { $project: { kv: { $objectToArray: '$$ROOT' } } },
      { $unwind: '$kv' },
      { $group: { _id: null, keys: { $addToSet: '$kv.k' } } },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-export.test.js`
Expected: FAIL — the five functions are not exported.

- [ ] **Step 3: Implement (append to `src/mdh/csv.js`)**

```js
// ---- CSV export (serialization) — symmetric with the parser above ----

// Order discovered top-level keys for a CSV header: _id first (if present),
// then the rest alphabetically (locale-aware).
export function orderColumns(keys) {
  const rest = keys.filter((k) => k !== '_id').sort((a, b) => a.localeCompare(b));
  return keys.includes('_id') ? ['_id', ...rest] : rest;
}

// Aggregation that returns { _id: null, keys: [...distinct top-level field names] }
// over the (already-filtered) docs — used to build the CSV header before streaming.
export function buildColumnDiscoveryPipeline(filterStages = [{ $match: {} }]) {
  return [
    ...filterStages,
    { $project: { kv: { $objectToArray: '$$ROOT' } } },
    { $unwind: '$kv' },
    { $group: { _id: null, keys: { $addToSet: '$kv.k' } } },
  ];
}

// Render one value as a CSV field (no delimiter). Objects/arrays are JSON-encoded.
// null/undefined -> empty; boolean -> true/false; number -> as-is; string -> as-is.
// Quote (and double internal quotes) when the field contains the delimiter,
// the quote char, CR, or LF.
export function csvCell(value, { delimiter = ',', quoteChar = '"' } = {}) {
  let s;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (typeof value === 'number') s = String(value);
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (s === '') return s;
  if (s.includes(delimiter) || s.includes(quoteChar) || s.includes('\n') || s.includes('\r')) {
    return quoteChar + s.split(quoteChar).join(quoteChar + quoteChar) + quoteChar;
  }
  return s;
}

// Join one document's column values into a CSV row (missing key -> empty cell).
export function csvRow(doc, columns, dialect = {}) {
  const delimiter = dialect.delimiter || ',';
  return columns.map((c) => csvCell(doc == null ? undefined : doc[c], dialect)).join(delimiter);
}

// Header row from column names (names quoted by the same rule as cells).
export function csvHeader(columns, dialect = {}) {
  const delimiter = dialect.delimiter || ',';
  return columns.map((c) => csvCell(c, dialect)).join(delimiter);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-csv-export.test.js`
Expected: PASS. (Note: `csvCell({a:1})` → `{"a":1}` contains no comma but contains `"` → quoted+doubled → `"{""a"":1}"`; `csvCell([1,2])` → `[1,2]` contains the comma delimiter → quoted → `"[1,2]"`. The test expects exactly these.)

- [ ] **Step 5: Verify the whole suite**

Run: `npm test`
Expected: PASS, no regressions.

---

## Task 2: Generalize `downloadCollection` with a pluggable serializer

**Files:**
- Modify: `src/mdh/downloadCollection.js`
- Test: `tests/mdh-download-collection.test.js`

- [ ] **Step 1: Add the failing CSV-serializer tests**

Append to `tests/mdh-download-collection.test.js` (it already imports `downloadCollection` and has `fakeWriter`/`fakeHandle`; add `buildCsvSerializer` to the import on line 6 and import the discovery-pipeline builder):

Change line 6 to:
```js
import { downloadCollection, BATCH_SIZE, CONCURRENCY, buildJsonSerializer, buildCsvSerializer } from '../src/mdh/downloadCollection.js';
import { buildColumnDiscoveryPipeline } from '../src/mdh/csv.js';
```

Append:
```js
describe('downloadCollection — CSV serializer', () => {
  it('discovers columns (_id-first, alphabetical) and writes header + CRLF rows', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['name', '_id', 'active'] }] })  // discovery
      .mockResolvedValueOnce({ result: [
        { _id: 'V1', name: 'Acme', active: true },
        { _id: 'V2', name: 'Globex' },                 // missing `active`
      ] });

    const writer = fakeWriter();
    const result = await downloadCollection('vendors', {
      fetchCount: async () => 2,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });

    expect(result).toEqual({ fetched: 2, cancelled: false, streamed: true });
    // discovery call uses the column-discovery pipeline on the default filter
    expect(api.aggregate).toHaveBeenNthCalledWith(1, 'vendors', buildColumnDiscoveryPipeline([{ $match: {} }]));
    // columns ordered _id, active, name
    expect(writer.chunks.join('')).toBe('_id,active,name\r\nV1,true,Acme\r\nV2,,Globex');
  });

  it('omits the header when header:false and prepends a BOM when bom:true', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['_id'] }] })
      .mockResolvedValueOnce({ result: [{ _id: 1 }, { _id: 2 }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 2,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: false, bom: true }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(writer.chunks.join('')).toBe('﻿1\r\n2');
  });

  it('honors a custom delimiter', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['a', 'b'] }] })
      .mockResolvedValueOnce({ result: [{ a: '1', b: '2' }] });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      serializer: buildCsvSerializer({ dialect: { delimiter: ';' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(writer.chunks.join('')).toBe('a;b\r\n1;2');
  });

  it('uses a .csv Blob (text/csv) in the fallback path', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: null, keys: ['_id'] }] })
      .mockResolvedValueOnce({ result: [{ _id: 1 }] });
    const downloadBlob = vi.fn();
    await downloadCollection('orders', {
      fetchCount: async () => 1,
      serializer: buildCsvSerializer({ dialect: { delimiter: ',' }, header: true, bom: false }),
      pickFile: () => Promise.resolve(null),
      downloadBlob,
    });
    const [blob, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe('orders.csv');
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('_id\r\n1');
  });

  it('buildJsonSerializer is the default — JSON output unchanged when omitted', async () => {
    const docs = [{ _id: 1, name: 'a' }];
    api.aggregate.mockResolvedValueOnce({ result: docs });
    const writer = fakeWriter();
    await downloadCollection('c', {
      fetchCount: async () => 1,
      pickFile: () => Promise.resolve(fakeHandle(writer)),
    });
    expect(JSON.parse(writer.chunks.join(''))).toEqual(docs);
    // no discovery call — JSON serializer has no init()
    expect(api.aggregate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-download-collection.test.js`
Expected: FAIL — `buildCsvSerializer`/`buildJsonSerializer` not exported.

- [ ] **Step 3: Replace `src/mdh/downloadCollection.js` with the generalized engine**

Replace the **entire file** with the following. The worker pool / backpressure / cancellation / in-order flush / `{$sort:{_id:1}}` injection are unchanged; only the JSON-specific serialization moves into `buildJsonSerializer`, and a `serializer.init()` hook runs after the picker (CSV uses it for column discovery).

```js
import * as api from './api.js';
import { csvHeader, csvRow, orderColumns, buildColumnDiscoveryPipeline } from './csv.js';

// Streamed export of a collection's documents, format-agnostic via a pluggable
// serializer. The streaming engine (sliding-window workers, in-order flush,
// buffer-room backpressure, cancellation, FS-Access-vs-Blob) is unchanged from
// the JSON-only version; only serialization differs.
//
// A serializer is { ext, mimeType, pickerTypes, init?(ctx), preamble(), item(doc),
// separator, postamble() }. `init` (optional) runs AFTER the file picker — so the
// picker stays the first await after the user gesture — and before the preamble;
// the CSV serializer uses it to discover the column set.
//
// Stable ordering across batches: each worker issues its own aggregate, and Mongo
// gives no stable natural order across independent aggregations. We append
// {$sort:{_id:1}} unless the caller's pipeline already ends with a $sort, so every
// worker scans in the same deterministic order.

export const BATCH_SIZE = 1000;
export const CONCURRENCY = 10;
export const MAX_BUFFERED = CONCURRENCY * 2;

function formatJsonDoc(doc) {
  // Match JSON.stringify(array, null, 2)'s per-element indent.
  return '  ' + JSON.stringify(doc, null, 2).replace(/\n/g, '\n  ');
}

// Default serializer — byte-for-byte identical to the previous JSON output.
export function buildJsonSerializer() {
  return {
    ext: 'json',
    mimeType: 'application/json',
    pickerTypes: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }],
    preamble: () => '[\n',
    item: (doc) => formatJsonDoc(doc),
    separator: ',\n',
    postamble: () => '\n]\n',
  };
}

// CSV serializer. Columns are the exact union of top-level keys, discovered in
// init() (after the picker). Objects/arrays are JSON-encoded per csvCell.
export function buildCsvSerializer({ dialect = {}, header = true, bom = true, columns = null } = {}) {
  let cols = columns;
  return {
    ext: 'csv',
    mimeType: 'text/csv',
    pickerTypes: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
    async init({ collectionName, pipelineStages }) {
      if (cols) return;
      const res = await api.aggregate(collectionName, buildColumnDiscoveryPipeline(pipelineStages));
      cols = orderColumns(res?.result?.[0]?.keys ?? []);
    },
    preamble: () => (bom ? '﻿' : '') + (header ? csvHeader(cols, dialect) + '\r\n' : ''),
    item: (doc) => csvRow(doc, cols, dialect),
    separator: '\r\n',
    postamble: () => '',
  };
}

export async function downloadCollection(collectionName, opts = {}) {
  const {
    fetchCount = async () => 0,
    isCancelled = () => false,
    onProgress = () => {},
    serializer = buildJsonSerializer(),
    pickFile = (name) => defaultPickFile(name, serializer.pickerTypes),
    downloadBlob = defaultDownloadBlob,
    batchSize = BATCH_SIZE,
    concurrency = CONCURRENCY,
    maxBuffered = MAX_BUFFERED,
    pipelineStages = [{ $match: {} }],
    filename: filenameOpt,
  } = opts;

  const filename = filenameOpt || `${collectionName}.${serializer.ext}`;

  // Picker must be the first await after the user gesture.
  let writer = null;
  try {
    const handle = await pickFile(filename);
    if (handle) writer = await handle.createWritable();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { fetched: 0, cancelled: true, streamed: false };
    }
    // Anything else (no support, permission denied) → Blob fallback.
  }

  try {
    let total = await fetchCount();
    if (!Number.isFinite(total) || total < 0) total = 0;
    onProgress({ fetched: 0, total });

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched: 0, cancelled: true, streamed: !!writer };
    }

    // Format-specific setup (CSV column discovery). After the picker, so the
    // picker keeps transient activation; cancellable on either side.
    if (serializer.init) {
      await serializer.init({ collectionName, pipelineStages });
      if (isCancelled()) {
        await safeAbort(writer);
        return { fetched: 0, cancelled: true, streamed: !!writer };
      }
    }

    const offsets = [];
    for (let s = 0; s < total; s += batchSize) offsets.push(s);

    const stages = pipelineEndsWithSort(pipelineStages)
      ? pipelineStages
      : [...pipelineStages, { $sort: { _id: 1 } }];

    const parts = [];
    let docsWritten = 0;
    let fetched = 0;
    const pending = new Map();
    let nextFetchIdx = 0;
    let nextWriteIdx = 0;
    let flushChain = Promise.resolve();
    let workerError = null;
    const bufferWaiters = [];

    async function writeChunk(text) {
      if (writer) await writer.write(text);
      else parts.push(text);
    }
    function wakeOneWaiter() { const r = bufferWaiters.shift(); if (r) r(); }
    function wakeAllWaiters() { while (bufferWaiters.length > 0) bufferWaiters.shift()(); }

    function scheduleFlush() {
      flushChain = flushChain.then(async () => {
        while (pending.has(nextWriteIdx)) {
          const docs = pending.get(nextWriteIdx);
          pending.delete(nextWriteIdx);
          let buf = '';
          for (const doc of docs) {
            if (docsWritten > 0) buf += serializer.separator;
            buf += serializer.item(doc);
            docsWritten++;
          }
          if (buf) await writeChunk(buf);
          nextWriteIdx++;
          wakeOneWaiter();
        }
      });
    }

    function stopped() { return isCancelled() || workerError !== null; }

    async function workerLoop() {
      while (true) {
        if (stopped()) return;
        while (pending.size >= maxBuffered && !stopped()) {
          await new Promise((r) => bufferWaiters.push(r));
        }
        if (stopped()) return;
        if (nextFetchIdx >= offsets.length) return;
        const myIdx = nextFetchIdx++;
        const myOffset = offsets[myIdx];
        try {
          const res = await api.aggregate(collectionName, [
            ...stages,
            { $skip: myOffset },
            { $limit: batchSize },
          ]);
          const docs = res?.result || [];
          pending.set(myIdx, docs);
          fetched += docs.length;
          onProgress({ fetched, total });
          scheduleFlush();
        } catch (err) {
          if (workerError === null) workerError = err;
          wakeAllWaiters();
          return;
        }
      }
    }

    await writeChunk(serializer.preamble());

    const workers = Array.from(
      { length: Math.min(concurrency, offsets.length) },
      () => workerLoop(),
    );
    await Promise.all(workers);
    await flushChain;

    if (workerError) throw workerError;

    if (isCancelled()) {
      await safeAbort(writer);
      return { fetched, cancelled: true, streamed: !!writer };
    }

    await writeChunk(serializer.postamble());

    if (writer) {
      await writer.close();
    } else {
      downloadBlob(new Blob(parts, { type: serializer.mimeType }), filename);
    }
    return { fetched, cancelled: false, streamed: !!writer };
  } catch (err) {
    await safeAbort(writer);
    throw err;
  }
}

function pipelineEndsWithSort(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return false;
  const last = stages[stages.length - 1];
  return last && typeof last === 'object' && Object.prototype.hasOwnProperty.call(last, '$sort');
}

async function safeAbort(writer) {
  if (!writer || typeof writer.abort !== 'function') return;
  try { await writer.abort('cancelled'); } catch { /* writer may already be closed */ }
}

function defaultPickFile(suggestedName, types) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return Promise.resolve(null);
  }
  return window.showSaveFilePicker({ suggestedName, types });
}

function defaultDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run to verify pass (CSV tests + ALL existing JSON tests)**

Run: `npx vitest run tests/mdh-download-collection.test.js`
Expected: PASS — the new CSV tests AND every pre-existing JSON test (output parity, pagination, ordering, cancellation, Blob fallback, filename defaults, empty collection). The JSON serializer is the default and produces identical bytes.

- [ ] **Step 5: Whole suite + build**

Run: `npm test` → PASS. Run: `npm run build` → clean.

---

## Task 3: `CsvExportOptions` modal

**Files:**
- Create: `src/mdh/components/CsvExportOptions.jsx`
- Test: `tests/mdh-csv-export-options.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/mdh-csv-export-options.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { modalContent } from '../src/mdh/store.js';
import CsvExportOptions from '../src/mdh/components/CsvExportOptions.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}
beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });

describe('CsvExportOptions', () => {
  it('renders delimiter / header / BOM with defaults and downloads the chosen options', () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { onDownload }));
    expect(root.querySelector('[data-testid="csv-export-download"]')).toBeTruthy();
    // defaults: comma delimiter, header on, bom on
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, bom: true });
  });

  it('reflects changed options', () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { onDownload }));
    root.querySelector('[data-testid="csv-export-delim-semicolon"]').click();
    root.querySelector('[data-testid="csv-export-header"]').click();   // header -> false
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ';', header: false, bom: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-export-options.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/mdh/components/CsvExportOptions.jsx`**

```jsx
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
```

- [ ] **Step 4: Run to verify pass + build**

Run: `npx vitest run tests/mdh-csv-export-options.test.js` → PASS.
Run: `npm run build` → clean.

---

## Task 4: Two-section download menu + wiring + CSS

**Files:**
- Modify: `src/mdh/components/DownloadSplitButton.jsx`
- Modify: `src/mdh/components/RecordList.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-download-dropdown.test.js`

- [ ] **Step 1: Rewrite the dropdown test for the new API**

Replace the body of the `describe('DownloadSplitButton', ...)` block in `tests/mdh-download-dropdown.test.js` (keep the file header, `mount`, `flush`, `flushEffects`, `waitFor`, and `beforeEach`). The component now takes four callbacks and renders two sections:

```js
describe('DownloadSplitButton', () => {
  const handlers = () => ({ onAllJson: vi.fn(), onFilteredJson: vi.fn(), onAllCsv: vi.fn(), onFilteredCsv: vi.fn() });

  it('renders a single "Download" toggle button when closed', () => {
    const root = mount(handlers());
    const buttons = root.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('Download');
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('opens a menu with JSON and CSV sections and four items', async () => {
    const root = mount(handlers());
    root.querySelector('button').click();
    await flush();
    const menu = root.querySelector('.toolbar-more-menu');
    expect(menu).not.toBeNull();
    const sections = menu.querySelectorAll('.toolbar-menu-section');
    expect([...sections].map((s) => s.textContent)).toEqual(['JSON', 'CSV']);
    const items = menu.querySelectorAll('.toolbar-menu-item');
    expect(items.length).toBe(4);
    expect([...items].map((i) => i.textContent.trim())).toEqual([
      'Download all', 'Download filtered', 'Download all', 'Download filtered',
    ]);
  });

  it('fires the right callback for each item', async () => {
    const h4 = handlers();
    const root = mount(h4);
    const open = async () => { root.querySelector('button').click(); await flush(); };
    await open();
    root.querySelectorAll('.toolbar-menu-item')[0].click(); await flush();
    await open();
    root.querySelectorAll('.toolbar-menu-item')[1].click(); await flush();
    await open();
    root.querySelectorAll('.toolbar-menu-item')[2].click(); await flush();
    await open();
    root.querySelectorAll('.toolbar-menu-item')[3].click(); await flush();
    expect(h4.onAllJson).toHaveBeenCalledOnce();
    expect(h4.onFilteredJson).toHaveBeenCalledOnce();
    expect(h4.onAllCsv).toHaveBeenCalledOnce();
    expect(h4.onFilteredCsv).toHaveBeenCalledOnce();
  });

  it('toggles the menu shut when the toggle is clicked again', async () => {
    const root = mount(handlers());
    const btn = root.querySelector('button');
    btn.click(); await flush();
    expect(root.querySelector('.toolbar-more-menu')).not.toBeNull();
    btn.click(); await flush();
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });

  it('closes when a mousedown happens outside the dropdown', async () => {
    const root = mount(handlers());
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    root.querySelector('button').click();
    await waitFor(() => root.querySelector('.toolbar-more-menu'), 'menu to open');
    await waitFor(() => {
      if (root.querySelector('.toolbar-more-menu') === null) return true;
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return false;
    }, 'menu to close on outside mousedown');
    expect(root.querySelector('.toolbar-more-menu')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-download-dropdown.test.js`
Expected: FAIL — current component has 2 items / no sections / old props.

- [ ] **Step 3: Rewrite `DownloadSplitButton.jsx`**

```jsx
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// Toolbar dropdown for the four download modes — JSON vs CSV × whole-collection
// vs current-pipeline result. Caret-only toggle; all actions live in the menu.
export default function DownloadSplitButton({ onAllJson, onFilteredJson, onAllCsv, onFilteredCsv }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const pick = (fn) => { setOpen(false); fn(); };

  return (
    <div ref={rootRef} class="dropdown-btn">
      <button class="btn btn-sm" title="Download collection" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        Download {'▾'}
      </button>
      {open && (
        <div class="toolbar-more-menu">
          <div class="toolbar-menu-section">JSON</div>
          <button class="toolbar-menu-item" onClick={() => pick(onAllJson)}>Download all</button>
          <button class="toolbar-menu-item" onClick={() => pick(onFilteredJson)}>Download filtered</button>
          <div class="toolbar-menu-section">CSV</div>
          <button class="toolbar-menu-item" onClick={() => pick(onAllCsv)}>Download all</button>
          <button class="toolbar-menu-item" onClick={() => pick(onFilteredCsv)}>Download filtered</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update the `DownloadSplitButton` call in `RecordList.jsx`**

Replace the current usage (the `<DownloadSplitButton onAll={...} onFiltered={...} />` block, around lines 256–259) with:
```jsx
          <DownloadSplitButton
            onAllJson={() => onRefresh('download')}
            onFilteredJson={() => onRefresh('download-filtered')}
            onAllCsv={() => onRefresh('download-csv')}
            onFilteredCsv={() => onRefresh('download-filtered-csv')}
          />
```

- [ ] **Step 5: Add the `.toolbar-menu-section` style**

In `src/console/console.css`, add (near the other `.toolbar-menu-*` rules; search for `.toolbar-menu-item`):
```css
.toolbar-menu-section {
  padding: 6px 12px 2px; font-size: 10px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary);
}
```

- [ ] **Step 6: Run to verify pass + build**

Run: `npx vitest run tests/mdh-download-dropdown.test.js` → PASS.
Run: `npm run build` → clean.

---

## Task 5: DataPanel CSV download handlers

**Files:**
- Modify: `src/mdh/components/DataPanel.jsx`

- [ ] **Step 1: Add the `serializer` arg to `runDownloadJob` and import the CSV pieces**

In `src/mdh/components/DataPanel.jsx`:

Update the downloadCollection import (line 26) to also pull the serializer factory:
```jsx
import { downloadCollection as runDownload, buildCsvSerializer } from '../downloadCollection.js';
```
Add (near the other component imports, e.g. after the `InsertFileWizard`/`CsvImportWizard` imports):
```jsx
import CsvExportOptions from './CsvExportOptions.jsx';
```
And ensure `openModal` is imported from `./Modal.jsx` (it already imports `confirmModal`; add `openModal` if not present).

Change `runDownloadJob`'s signature and the `runDownload` call to forward an optional serializer:
```jsx
  async function runDownloadJob({ pipelineStages, filename, filtered, fetchCount, serializer }) {
    downloadCancelRef.current = false;
    setDownloadState({ count: 0, total: null, filtered });
    error.value = null;

    try {
      const col = collection;
      const result = await runDownload(col, {
        pipelineStages,
        filename,
        fetchCount,
        serializer,                         // undefined → JSON (default) for the existing callers
        isCancelled: () => downloadCancelRef.current,
        onProgress: ({ fetched, total }) => setDownloadState({ count: fetched, total, filtered }),
      });
      // …rest of the function is unchanged…
```
(Only the destructured `serializer` and the `serializer,` line are added; the existing JSON callers omit it and keep JSON behavior.)

- [ ] **Step 2: Add the CSV handlers**

Add these two functions next to `downloadAll`/`downloadFiltered` in `DataPanel.jsx`:
```jsx
  function downloadAllCsv() {
    const col = collection;
    openModal('Export CSV', () => (
      <CsvExportOptions onDownload={async (opts) => {
        const tc = pagination.totalCount.value;
        if (tc !== null && tc > 10_000) {
          const proceed = await confirmModal(
            'Large collection',
            `This collection has ${tc.toLocaleString()} documents. Exporting may take a while and use significant memory. Continue?`,
          );
          if (!proceed) return;
        }
        await runDownloadJob({
          pipelineStages: [{ $match: {} }],
          filename: `${col}.csv`,
          filtered: false,
          fetchCount: async () => {
            if (pagination.totalCount.value !== null) return pagination.totalCount.value;
            const r = await api.aggregate(col, [{ $count: 'total' }]);
            return r.result?.[0]?.total ?? 0;
          },
          serializer: buildCsvSerializer({ dialect: { delimiter: opts.delimiter }, header: opts.header, bom: opts.bom }),
        });
      }} />
    ));
  }

  function downloadFilteredCsv() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substitutePlaceholders(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot export filtered: ${err.message}` };
      return;
    }
    const col = collection;
    openModal('Export CSV', () => (
      <CsvExportOptions onDownload={async (opts) => {
        // Pre-count for the progress total + >10k gate (cancellable).
        downloadCancelRef.current = false;
        error.value = null;
        setDownloadState({ counting: true, filtered: true });
        const ac = new AbortController();
        downloadCountAbortRef.current = ac;
        let filteredCount;
        try {
          const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
          filteredCount = r.result?.[0]?.total ?? 0;
        } catch (err) {
          downloadCountAbortRef.current = null;
          if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
          error.value = { message: `Cannot export filtered: ${err.message}` };
          setDownloadState(null);
          return;
        }
        downloadCountAbortRef.current = null;
        if (downloadCancelRef.current) { setDownloadState(null); return; }
        if (filteredCount > 10_000) {
          setDownloadState(null);
          const proceed = await confirmModal(
            'Large export',
            `This filter matches ${filteredCount.toLocaleString()} documents. Exporting may take a while and use significant memory. Continue?`,
          );
          if (!proceed) return;
        }
        await runDownloadJob({
          pipelineStages,
          filename: `${col}-filtered.csv`,
          filtered: true,
          fetchCount: async () => filteredCount,
          serializer: buildCsvSerializer({ dialect: { delimiter: opts.delimiter }, header: opts.header, bom: opts.bom }),
        });
      }} />
    ));
  }
```

- [ ] **Step 3: Route the new actions in `handleToolbarAction`**

In `handleToolbarAction`, add two branches after the existing `download-filtered` one:
```jsx
    } else if (action === 'download-filtered') {
      downloadFiltered();
    } else if (action === 'download-csv') {
      downloadAllCsv();
    } else if (action === 'download-filtered-csv') {
      downloadFilteredCsv();
    } else if (action === 'insert') {
```
(Insert the two `else if`s; keep the rest of the chain intact.)

- [ ] **Step 4: Build + full suite**

Run: `npm run build`
Expected: clean (catches any missing import / JSX issue). 
Run: `npm test`
Expected: full suite PASS (no test drives these DataPanel handlers directly; their pieces are covered by Tasks 1–4 + the existing JSON-download tests, and the end-to-end behavior is checked in manual QA, Task 6).

> Note: `DataPanel`'s download handlers are integration glue (modal + picker + aggregate) with no isolated test seam — like the existing `downloadAll`/`downloadFiltered`, which also have no unit test. Coverage is: `csv.js` (Task 1), the exporter incl. `buildCsvSerializer` (Task 2), the options modal (Task 3), the menu (Task 4), and the manual QA below.

---

## Task 6: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture the `Test Files N passed` line). Run: `npm run build` → clean.

- [ ] **Step 2: CSP sanity**

Run: `grep -c 'new Function\|eval(' dist/console/console.js` → expect `0` (no dynamic codegen introduced).

- [ ] **Step 3: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection. Click **Download ▾** → confirm two sections (JSON / CSV), each with "Download all" / "Download filtered", **no ellipsis**.
- **CSV → Download all:** the options modal appears (Delimiter pills, Header toggle, Excel-BOM toggle). Click Download → save dialog → open the file: header row present, `_id` first then alphabetical columns, nested objects appear as JSON strings in one cell, booleans as `true`/`false`, empties blank. Open in Excel and confirm accented characters render (BOM on).
- Try **semicolon** delimiter and **header off**; re-export and verify.
- **CSV → Download filtered:** set a pipeline filter, export, confirm only filtered rows and the >10k confirm behaves (use a large collection if available).
- **JSON → Download all / filtered:** confirm the JSON download is unchanged (file is identical to before).
- Cancel the save dialog and cancel mid-download; confirm clean state.

- [ ] **Step 4: Report**

Summarize suite + build results and the manual-QA outcome (which collection, row counts, CSV opened correctly in a spreadsheet, JSON unchanged). Do not claim done without the manual check.

---

## Self-Review (completed during planning)

- **Spec coverage:** pluggable serializer + JSON default identical (Task 2) ✓; pre-pass exact-union columns + `_id`-first-alphabetical (Tasks 1–2) ✓; JSON-encoded nested / null→empty / bool→true-false / RFC-4180 quoting / CRLF (Task 1) ✓; BOM + header + delimiter options (Tasks 2–3) ✓; options modal reusing Segmented/Toggle (Task 3) ✓; two-section menu, no ellipsis (Task 4) ✓; both all + filtered, >10k confirm + progress reused (Task 5) ✓; tests for helpers/exporter/modal/menu + JSON-unchanged guard ✓.
- **Placeholder scan:** none — every step has concrete code/commands. (Task 5 Step 1's "rest unchanged" refers to the already-shown existing function body, not a placeholder.)
- **Type/name consistency:** serializer shape `{ext, mimeType, pickerTypes, init?, preamble, item, separator, postamble}` used identically in `buildJsonSerializer`/`buildCsvSerializer` and the engine; `buildCsvSerializer({dialect, header, bom, columns})` matches every call site (Tasks 2 & 5); `runDownloadJob({..., serializer})` matches the CSV callers and the JSON callers omit it (default JSON); `csvCell/csvRow/csvHeader/orderColumns/buildColumnDiscoveryPipeline` signatures match between `csv.js`, the serializer, and the tests; menu actions `download-csv`/`download-filtered-csv` match between `RecordList` and `handleToolbarAction`; `CsvExportOptions` `onDownload({delimiter, header, bom})` matches the DataPanel handlers and the modal test.
- **No silent caps / behavior change:** the JSON path is the default serializer with byte-identical output (guarded by the existing test suite + an explicit "JSON unchanged" test).
