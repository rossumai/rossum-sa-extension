# CSV export preview + parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the CSV import/export modals to parity: drop the confusing JSON-style quotes (and add subtle gridlines) in the import preview, simplify the import Advanced panel, give Export a live CSV-text preview that reuses its discovered columns for the download, and never write a BOM.

**Architecture:** Presentation + wiring changes only — no parser or streaming-engine behavior change. `PreviewValue` renders import values as plain text (empty strings flagged); `CsvImportWizard` drops four Advanced controls (values stay in `DEFAULT_OPTS`); `CsvExportOptions` takes an injected `loadPreview()` and renders a monospace CSV preview, threading the discovered columns into `buildCsvSerializer` so the download skips re-scanning; `DataPanel` provides `loadPreview` and fixes `bom:false`.

**Tech Stack:** Preact + signals, esbuild, Vitest (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-csv-export-preview-parity-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** jsdom; `import { h, render } from 'preact'`; mount into a div; query by `data-testid`/class; condition-based `waitFor`/`flush` (never fixed sleeps for render races). JSX unicode literal in `{'…'}` expression form.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/components/CsvImportWizard.jsx` | modify | Import preview: plain-text strings + `(empty)` marker + legend (Task 1). Remove 4 Advanced controls (Task 2); `DEFAULT_OPTS` untouched. |
| `src/console/console.css` | modify | Import-preview cell outlines + `.csv-cell-empty`/`.csv-legend-str` (Task 1); `.csv-export-preview*` monospace block (Task 3). |
| `src/mdh/components/CsvExportOptions.jsx` | modify | `loadPreview`-driven CSV-text preview; remove BOM; thread `columns` to `onDownload` (Task 3). |
| `src/mdh/components/DataPanel.jsx` | modify | Pass `loadPreview`; `bom:false`; thread `columns`; import `buildColumnDiscoveryPipeline`/`orderColumns` (Task 4). |
| `tests/mdh-csv-wizard.test.js` | modify | String rendering (Task 1); 4 controls gone (Task 2). |
| `tests/mdh-csv-export-options.test.js` | rewrite | Preview renders; delimiter re-renders; Download passes `{delimiter,header,columns}`; no BOM; failure → `columns:null` (Task 3). |

> **Same-file note:** Tasks 1 and 2 both edit `CsvImportWizard.jsx` + `tests/mdh-csv-wizard.test.js`. Execute them in order (subagent-driven dispatches one task at a time, sequentially), so Task 2 sees Task 1's saved edits. Their changes don't overlap (Task 1 touches `PreviewValue`/legend + the "renders typed cells" test; Task 2 touches the Advanced panel + appends new describe blocks).

---

## Task 1: Import preview — plain-text strings, `(empty)` marker, cell outlines

**Files:**
- Modify: `src/mdh/components/CsvImportWizard.jsx` (`PreviewValue` ~lines 414-420; legend ~lines 386-388)
- Modify: `src/console/console.css` (`.csv-preview-table` borders ~1432-1434; add `.csv-cell-empty`, `.csv-legend-str`)
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Update the tests (make them fail)**

In `tests/mdh-csv-wizard.test.js`, replace the existing `it('renders typed cells: number unquoted, string quoted', …)` test (the first test in the `describe('CsvPreview', …)` block) with these two:
```js
  it('renders typed cells: number unquoted, string as plain text (no surrounding quotes)', () => {
    const parsed = { columns: ['name', 'age'], docs: [{ name: 'Alice', age: 30 }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-cell-number').textContent).toBe('30');
    expect(root.querySelector('.csv-cell-string').textContent).toBe('Alice');
  });

  it('renders an empty string as a muted (empty) marker, not a blank cell', () => {
    const parsed = { columns: ['note'], docs: [{ note: '' }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    const cell = root.querySelector('.csv-cell-empty');
    expect(cell).toBeTruthy();
    expect(cell.textContent).toBe('(empty)');
  });
```

Then in the `describe('CsvImportWizard — configure', …)` test, replace the block that currently reads:
```js
    // Default opts: strings. age renders as a quoted string.
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    expect(root.querySelector('.csv-cell-number')).toBeNull();
    expect(root.textContent).toContain('"30"');
```
with:
```js
    // Default opts: every value is a string, shown as plain text (no surrounding quotes).
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    expect(root.querySelector('.csv-cell-number')).toBeNull();
    expect(root.textContent).not.toContain('"30"');
    expect([...root.querySelectorAll('.csv-cell-string')].map((s) => s.textContent)).toContain('30');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: FAIL — current `PreviewValue` renders `"Alice"`/`"30"` (with quotes) and has no `.csv-cell-empty`.

- [ ] **Step 3: Rewrite `PreviewValue`**

In `src/mdh/components/CsvImportWizard.jsx`, replace the `PreviewValue` function with:
```jsx
function PreviewValue({ value, present }) {
  if (!present) return <span class="csv-cell-missing" title="field omitted">{'—'}</span>;
  if (value === null) return <span class="csv-cell-null">null</span>;
  if (typeof value === 'number') return <span class="csv-cell-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="csv-cell-bool">{String(value)}</span>;
  if (value === '') return <span class="csv-cell-empty" title="empty string">(empty)</span>;
  return <span class="csv-cell-string">{value}</span>;
}
```

- [ ] **Step 4: Update the legend**

In the same file, in `CsvPreview`, replace the legend span:
```jsx
          <span class="csv-preview-legend">
            <span class="csv-legend-num">123</span> number {'·'} <span class="csv-legend-null">null</span> {'·'} "text"
          </span>
```
with:
```jsx
          <span class="csv-preview-legend">
            <span class="csv-legend-num">123</span> number {'·'} <span class="csv-legend-str">text</span> {'·'} <span class="csv-legend-null">null</span>
          </span>
```

- [ ] **Step 5: Update the preview-table CSS (gridlines + new spans)**

In `src/console/console.css`, replace:
```css
.csv-preview-table th, .csv-preview-table td {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
```
with:
```css
.csv-preview-table th, .csv-preview-table td {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border); white-space: nowrap;
}
.csv-preview-table th:last-child, .csv-preview-table td:last-child { border-right: none; }
```
Then add these two rules next to the other `.csv-cell-*` rules (after `.csv-cell-missing`):
```css
.csv-cell-empty  { color: var(--text-secondary); font-style: italic; }
.csv-legend-str  { color: var(--text-primary); }
```

- [ ] **Step 6: Run to verify pass + suite + build**

Run: `npx vitest run tests/mdh-csv-wizard.test.js` → PASS (string plain-text, `(empty)` marker, plain `30` string cell).
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 2: Remove four import controls (keep as defaults)

**Files:**
- Modify: `src/mdh/components/CsvImportWizard.jsx`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-csv-wizard.test.js` (reuse the file's existing `mount`, `waitFor` helpers):
```js
describe('CsvImportWizard — trimmed Advanced options', () => {
  async function openAdvanced(root) {
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File(['a,b\n1,2'], 't.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
    root.querySelector('[data-testid="csv-advanced-toggle"]').click();
  }

  it('Advanced no longer offers Quote / Escape / Double-quote / Skip-empty-lines', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await openAdvanced(root);
    const adv = root.querySelector('[data-testid="csv-advanced"]');
    expect(adv).toBeTruthy();
    expect(adv.textContent).not.toMatch(/Quote/);        // removes Quote AND Double-quote
    expect(adv.textContent).not.toMatch(/Escape/);
    expect(adv.textContent).not.toMatch(/Skip empty/);
    expect(root.querySelector('[data-testid="csv-doublequote"]')).toBeNull();
    expect(root.querySelector('[data-testid="csv-skipempty"]')).toBeNull();
  });

  it('Advanced keeps Encoding / Empty-cell / Trim', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await openAdvanced(root);
    expect(root.querySelector('[data-testid="csv-encoding"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="csv-trim"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: FAIL — the Advanced panel still contains Quote/Escape/Double-quote/Skip-empty.

- [ ] **Step 3: Remove the four controls**

In `src/mdh/components/CsvImportWizard.jsx`, replace the entire Advanced-panel body (the `{advancedOpen && (<div class="csv-advanced" …> … </div>)}` block) so it contains ONLY Encoding, Empty-cell, and Trim:
```jsx
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
```
Do NOT touch `DEFAULT_OPTS` (it keeps `quoteChar:'"'`, `escapeChar:''`, `doubleQuote:true`, `skipEmptyLines:true`) and do NOT touch the `useMemo` parse call (`escapeChar: opts.escapeChar || null`) — the parser still receives these values, so RFC-4180 quoting, the `""` collapse, and blank-line skipping all still happen.

- [ ] **Step 4: Run to verify pass + whole suite + build**

Run: `npx vitest run tests/mdh-csv-wizard.test.js` → PASS (removed controls gone, kept ones present; Task 1's string/empty tests and the existing infer-reparse + delimiter tests still pass).
Run: `npm test` → full suite PASS (the `csv.js` parser tests are untouched; behavior unchanged).
Run: `npm run build` → clean.

---

## Task 3: Export modal — CSV-text preview + remove BOM

**Files:**
- Modify: `src/mdh/components/CsvExportOptions.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-csv-export-options.test.js`

- [ ] **Step 1: Rewrite the test**

Replace the body of `tests/mdh-csv-export-options.test.js` with:
```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { modalContent } from '../src/mdh/store.js';
import CsvExportOptions from '../src/mdh/components/CsvExportOptions.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });
const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn, timeout = 1000) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

const SAMPLE = {
  columns: ['_id', 'active', 'name'],
  sample: [
    { _id: 'V001', active: true, name: 'ACME s.r.o.' },
    { _id: 'V002', active: false, name: 'Globex' },
  ],
};

describe('CsvExportOptions', () => {
  it('renders a CSV-text preview (header + rows) and has no BOM control', async () => {
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    const text = root.querySelector('.csv-export-preview-text').textContent;
    expect(text).toContain('_id,active,name');        // header row
    expect(text).toContain('V001,true,ACME s.r.o.');  // first data row
    expect(root.querySelector('[data-testid="csv-export-bom"]')).toBeNull(); // BOM control removed
  });

  it('re-renders the preview when the delimiter changes', async () => {
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload: vi.fn() }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    root.querySelector('[data-testid="csv-export-delim-semicolon"]').click();
    await flush();
    expect(root.querySelector('.csv-export-preview-text').textContent).toContain('_id;active;name');
  });

  it('Download passes delimiter, header, and the discovered columns', async () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { loadPreview: async () => SAMPLE, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, columns: ['_id', 'active', 'name'] });
  });

  it('on preview failure shows a note and Download passes columns: null', async () => {
    const onDownload = vi.fn();
    const root = mount(h(CsvExportOptions, { loadPreview: async () => { throw new Error('boom'); }, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview-note'));
    expect(root.querySelector('.csv-export-preview').textContent).toContain('unavailable');
    root.querySelector('[data-testid="csv-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ delimiter: ',', header: true, columns: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-export-options.test.js`
Expected: FAIL — current modal has no preview, no `loadPreview`, still has the BOM control, and `onDownload` gets `bom` not `columns`.

- [ ] **Step 3: Rewrite `src/mdh/components/CsvExportOptions.jsx`**

```jsx
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Segmented, Toggle } from './CsvImportWizard.jsx';
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
```

- [ ] **Step 4: Add the preview CSS**

In `src/console/console.css`, near the other `.csv-*` rules, add:
```css
/* CSV export — live preview */
.csv-export-preview { margin: 10px 0; }
.csv-export-preview-caption { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.csv-export-preview-note { font-size: 12px; color: var(--text-secondary); padding: 8px 0; }
.csv-export-preview-text {
  margin: 0; max-height: 200px; overflow: auto; white-space: pre;
  font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
  background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 8px 10px; color: var(--text-primary);
}
```
(If `--bg-code` or `--radius` aren't defined in `console.css`, substitute the nearest existing token — e.g. `var(--bg-card)` and `6px` — matching the import preview's `.csv-preview-scroll`.)

- [ ] **Step 5: Run to verify pass + build**

Run: `npx vitest run tests/mdh-csv-export-options.test.js` → PASS (4 tests).
Run: `npm run build` → clean.
Run: `npm test` → full suite PASS.

---

## Task 4: DataPanel — wire loadPreview, drop BOM, thread columns

**Files:**
- Modify: `src/mdh/components/DataPanel.jsx`

- [ ] **Step 1: Import the discovery helpers**

In `src/mdh/components/DataPanel.jsx`, add to the `csv.js` imports (or add a new import line near the other `../` imports):
```jsx
import { buildColumnDiscoveryPipeline, orderColumns } from '../csv.js';
```

- [ ] **Step 2: Update `downloadAllCsv`'s `<CsvExportOptions>`**

Replace the `<CsvExportOptions onDownload={…} />` in `downloadAllCsv` with:
```jsx
      <CsvExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline([{ $match: {} }])),
            api.aggregate(col, [{ $match: {} }, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ delimiter, header, columns }) => {
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
            serializer: buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns }),
          });
        }}
      />
```
(Match the existing `downloadAllCsv` body — keep its current `fetchCount`/confirm logic if it differs; the only required changes are: add `loadPreview`, destructure `{ delimiter, header, columns }`, and call `buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns })`.)

- [ ] **Step 3: Update `downloadFilteredCsv`'s `<CsvExportOptions>`**

Add `loadPreview` and change the serializer call. Keep the existing filtered pre-count / >10k confirm body exactly as-is; only the destructure and `buildCsvSerializer` line change:
```jsx
      <CsvExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline(pipelineStages)),
            api.aggregate(col, [...pipelineStages, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ delimiter, header, columns }) => {
          // …existing filtered pre-count + >10k confirm body, UNCHANGED…
          await runDownloadJob({
            // …existing pipelineStages / filename / filtered / fetchCount …
            serializer: buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns }),
          });
        }}
      />
```

- [ ] **Step 4: Build + full suite**

Run: `npm run build` → clean (catches missing imports / JSX issues).
Run: `npm test` → full suite PASS. (No isolated DataPanel test for these handlers — coverage is the modal test (Task 3), the exporter tests, and manual QA. Do not add a brittle DataPanel test.)

---

## Task 5: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture the `Test Files N passed` line). Run: `npm run build` → clean.

- [ ] **Step 2: Confirm BOM is gone from the export path**

Run: `grep -rn "bom" src/mdh/components/CsvExportOptions.jsx` → expect no matches (no BOM state/control).
Run: `grep -n "bom:" src/mdh/components/DataPanel.jsx` → expect only `bom: false`.

- [ ] **Step 3: CSP guard (re-verify the build is clean)**

Run: `grep -nE "new Function|eval\(" dist/console/console.js` → expect no matches (no new dynamic-code introductions).

- [ ] **Step 4: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection.
- **Import preview:** Insert ▾ → Insert from CSV file → pick a file. Strings show as plain text (no surrounding quotes); a cell that's an empty string shows a muted `(empty)`; cells have subtle vertical gridlines; the legend reads `123 number · text · null`. Toggle Infer types → numbers turn accent/monospace. Advanced now shows only Encoding / Empty-cell / Trim. A file with quoted fields and a doubled `""` still parses correctly (defaults applied).
- **Export:** Download ▾ → CSV → Download all → the modal shows a spinner then a CSV-text preview (header + ~10 rows). Toggle the delimiter to `;` / Tab → the preview text updates. Turn Header off → the header row disappears from the preview. Click Download → the saved file matches the preview's columns, has **no BOM** (first bytes not `EF BB BF`), and the column set matches the preview. Repeat for **Download filtered** with a pipeline set.

- [ ] **Step 5: Report**

Summarize suite + build results and the manual-QA outcome (import preview: plain strings + `(empty)` + gridlines + trimmed Advanced; export preview updated live, file matched + no BOM). Don't claim done without the manual check.

---

## Self-Review (completed during planning)

- **Spec coverage:** import preview drops string quotes + `(empty)` marker + cell outlines + legend (Task 1, §5.1) ✓; import removes Quote/Escape/Double-quote/Skip-empty, keeps defaults (Task 2, §5) ✓; export CSV-text preview via injected `loadPreview` (Task 3, §4) ✓; exact-union columns reused for download (Task 4 threads `columns`, §6) ✓; BOM removed + never written (`bom:false`, Tasks 3/4, §4) ✓; loading + "unavailable" fallback + `columns:null` race fix (Task 3 component + test, §4) ✓; CSS (Tasks 1 & 3) ✓; tests for both sides ✓.
- **Placeholder scan:** none — every step has concrete code/commands. (Steps 4.2 / 4.3 carry "match the existing body" guards because those handlers' exact pre-count code lives in `DataPanel.jsx` and must not be rewritten — the *required* edits are spelled out in full.)
- **Type/name consistency:** `loadPreview()` resolves `{ columns, sample }` everywhere; `onDownload({ delimiter, header, columns })` matches between the component and both DataPanel handlers; `columns` flows component→`onDownload`→`buildCsvSerializer({…, columns})` (which already skips discovery when non-null); `bom: false` fixed at both call sites; `buildColumnDiscoveryPipeline`/`orderColumns`/`csvHeader`/`csvRow` are the real `csv.js` exports; `PreviewValue` keeps the existing `.csv-cell-*` classes and adds `.csv-cell-empty`/`.csv-legend-str` (both styled in Task 1's CSS step); the removed import controls' keys stay in `DEFAULT_OPTS` so `parseCsv` is unchanged.
