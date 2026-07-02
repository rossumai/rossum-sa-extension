# Import Source Toggle (File / Clipboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse all import entry points under one plain `Import` button that opens a modal with a `File | Clipboard` source toggle (File default): File accepts any supported type with format auto-detection; Clipboard is a JSON/JSONL editor — both feed the existing unified Insert/Update/Replace pipeline.

**Architecture:** Add `detectFormat` + `ALL_ACCEPT` to the format registry. Rework `ImportWizard` so format is detected (not a prop) and the PICK stage carries a source toggle (file drop-area vs. `JsonEditor`); everything from CONFIGURE onward is reused unchanged. Switch the toolbar to a single button, route one `import` action to `openImport`, and retire the inline paste path (`openDataOperations`/`InsertPanel`) and the now-unused `SplitButton`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom, Rossum Data Storage REST API.

## Global Constraints

- **Build:** esbuild only, classic JSX pragma `h` / `Fragment`. Run `npm run build` after UI changes.
- **Tests:** Vitest, files in `tests/**/*.test.js`; DOM tests start `// @vitest-environment jsdom`; mock API with `vi.mock('../src/mdh/api.js')`; mount via `h(Component, props)` + Preact `render`; condition-based `waitFor`, never fixed sleeps. Run one file: `npx vitest run tests/<name>.test.js`; full: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attributes — use `{'…'}`/literal char/entity. Fine inside JS strings/template literals.
- **Reuse, don't rebuild:** the downstream stages (`ImportConfirm`, `ImportStages`, `importPlan.js`, `runImport.js`) and per-format parsers/ConfigureControls are unchanged. Do not modify them.
- **Clipboard = JSON/JSONL only**, via the existing `JsonEditor`, parsed from `editorRef.getValue()` raw text through `getFormat('json').parse()` (JSON→NDJSON fallback). Excel/CSV/XML are file-only.
- **Unknown file extension → reject** with a clear message (no content sniffing).
- **Backward compatibility:** every current capability stays reachable; only the route changes. No storage-key changes. Update the sole caller when a signature changes — leave no dangling references.
- **Customer-data safety:** never write to a real/customer collection; never log customer data/names.
- **Commits:** the project owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless explicitly asked. Stay on `master`; no branches/worktrees.

---

## File Structure

**Modified:**
- `src/mdh/formats/index.js` — add `detectFormat(filename)` + `ALL_ACCEPT`.
- `src/mdh/components/ImportWizard.jsx` — source toggle, format-as-state, detection, clipboard tab; drop the `format`/`mode` props.
- `src/mdh/components/DataOperations.jsx` — `openImport(onSuccess, fieldsFn)` (no format); remove `IMPORT_TITLES`, `openDataOperations`, `InsertPanel`.
- `src/mdh/components/DataPanel.jsx` — single `import` action.
- `src/mdh/components/RecordList.jsx` — plain `Import` button; delete `SplitButton`.

**Tests:** add `detectFormat`/`ALL_ACCEPT` cases to `tests/mdh-formats.test.js`; rewrite `tests/mdh-import-wizard.test.js`; update `tests/mdh-file-drop.test.js`; rewrite `tests/mdh-csv-routing.test.js`. Untouched: `mdh-import-plan`, `mdh-run-import`, `mdh-import-confirm`, `mdh-import-stages`, parser tests.

---

## Task 1: `detectFormat` + `ALL_ACCEPT`

**Files:**
- Modify: `src/mdh/formats/index.js`
- Test: `tests/mdh-formats.test.js`

**Interfaces:**
- Produces: `detectFormat(filename) -> 'json'|'jsonl'|'csv'|'xlsx'|'xml'|null` (by extension, case-insensitive; `.ndjson`→`jsonl`); `ALL_ACCEPT` (string: comma-joined union of every format's `accept`).

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-formats.test.js`, and update its top import to include the new names:

```js
// change the existing import line to:
import { FORMATS, getFormat, detectFormat, ALL_ACCEPT } from '../src/mdh/formats/index.js';
```

```js
describe('detectFormat', () => {
  it('maps extensions to format ids', () => {
    expect(detectFormat('vendors.json')).toBe('json');
    expect(detectFormat('data.jsonl')).toBe('jsonl');
    expect(detectFormat('data.ndjson')).toBe('jsonl');
    expect(detectFormat('rows.csv')).toBe('csv');
    expect(detectFormat('book.xlsx')).toBe('xlsx');
    expect(detectFormat('feed.xml')).toBe('xml');
  });
  it('is case-insensitive', () => {
    expect(detectFormat('DATA.CSV')).toBe('csv');
    expect(detectFormat('Book.XLSX')).toBe('xlsx');
  });
  it('returns null for unknown / missing extensions', () => {
    expect(detectFormat('notes.txt')).toBeNull();
    expect(detectFormat('noext')).toBeNull();
    expect(detectFormat('')).toBeNull();
    expect(detectFormat(null)).toBeNull();
  });
});

describe('ALL_ACCEPT', () => {
  it('includes every format extension token', () => {
    for (const ext of ['.json', '.jsonl', '.ndjson', '.csv', '.xlsx', '.xml']) {
      expect(ALL_ACCEPT).toContain(ext);
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-formats.test.js` (detectFormat/ALL_ACCEPT undefined).

- [ ] **Step 3: Implement** — append to `src/mdh/formats/index.js` (after the existing exports):

```js
// Union of every format's `accept` — used by the file drop area so ONE picker
// accepts any supported type.
export const ALL_ACCEPT = Object.values(FORMATS).map((f) => f.accept).join(',');

// Map a filename to a format id by its extension (case-insensitive). `.ndjson`
// and `.jsonl` both map to jsonl. Returns null for an unsupported extension.
const EXT_TO_FORMAT = { json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', csv: 'csv', xlsx: 'xlsx', xml: 'xml' };
export function detectFormat(filename) {
  const m = /\.([^.]+)$/.exec(String(filename || '').toLowerCase());
  if (!m) return null;
  return EXT_TO_FORMAT[m[1]] || null;
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-formats.test.js`

- [ ] **Step 5: Commit** (checkpoint)

```bash
git add src/mdh/formats/index.js tests/mdh-formats.test.js
git commit -m "feat(mdh): detectFormat + ALL_ACCEPT in format registry"
```

---

## Task 2: Rework `ImportWizard` — source toggle, detection, clipboard

**Files:**
- Modify: `src/mdh/components/ImportWizard.jsx` (full rewrite of the component)
- Test: `tests/mdh-import-wizard.test.js` (rewrite), `tests/mdh-file-drop.test.js` (update the wizard-drop cases)

**Interfaces:**
- Consumes: `detectFormat`, `ALL_ACCEPT`, `getFormat` from `../formats/index.js`; `Segmented`, `CsvPreview` from `./ImportControls.jsx`; `JsonEditor` from `./JsonEditor.jsx` (imperative `editorRef.getValue()`); `ImportConfirm`+`defaultKeysFor`; `ImportProgress`/`ImportSummary`; `probeCollection`/`executeImport`; `computePlan`; `api.listIndexes`.
- Produces: default `ImportWizard({ onSuccess, fieldsFn })` — no `format`/`mode` props. Opens at PICK with `source='file'`; mode defaults to `'insert'` and is chosen on the CONFIRM stage.

- [ ] **Step 1: Write the failing tests** — replace the entire contents of `tests/mdh-import-wizard.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { h, render } from 'preact';
import { selectedCollection } from '../src/mdh/store.js';
import ImportWizard from '../src/mdh/components/ImportWizard.jsx';

function mount(node) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const s = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout'); await new Promise((r) => setTimeout(r, interval)); }
}
function file(str, name) { const f = new File([str], name); f.text = async () => str; f.arrayBuffer = async () => new TextEncoder().encode(str).buffer; return f; }
function pick(root, f) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => { vi.clearAllMocks(); selectedCollection.value = 'vendors'; api.listIndexes.mockResolvedValue({ result: [] }); });

describe('ImportWizard — source toggle + detection', () => {
  it('defaults to the File source and shows the source toggle', () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    expect(root.querySelector('[data-testid="import-source"]')).toBeTruthy();
    expect(root.querySelector('.file-input-area')).toBeTruthy();
  });

  it('detects a selected JSON file and reaches confirm', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('[{"_id":"1","a":1}]', 'd.json'));
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
  });

  it('detects a selected CSV file and reaches the configure stage', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('a,b\n1,2\n', 'rows.csv'));
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
  });

  it('rejects an unsupported file type via the click path', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    pick(root, file('x', 'notes.txt'));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toMatch(/Unsupported file/i);
  });

  it('switches to Clipboard, shows the JSON editor + Next, and blocks empty input', async () => {
    const root = mount(h(ImportWizard, { onSuccess() {} }));
    const clip = [...root.querySelectorAll('.csv-seg-opt')].find((b) => b.textContent.trim() === 'Clipboard');
    clip.click();
    const next = await waitFor(() => root.querySelector('[data-testid="clipboard-next"]'));
    next.click();
    await waitFor(() => {
      const hint = root.querySelector('.input-hint');
      return hint && /document/i.test(hint.textContent) ? hint : null;
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-wizard.test.js` (old wizard shape / no source toggle).

- [ ] **Step 3: Implement** — replace the entire contents of `src/mdh/components/ImportWizard.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import FileDropArea from './FileDropArea.jsx';
import JsonEditor from './JsonEditor.jsx';
import { CsvPreview, Segmented } from './ImportControls.jsx';
import ImportConfirm, { defaultKeysFor } from './ImportConfirm.jsx';
import { ImportProgress, ImportSummary } from './ImportStages.jsx';
import { getFormat, detectFormat, ALL_ACCEPT } from '../formats/index.js';
import { probeCollection, executeImport } from '../runImport.js';
import { computePlan } from '../importPlan.js';
import * as api from '../api.js';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const SOURCE_SEG = [
  { value: 'file', label: 'File' },
  { value: 'clipboard', label: 'Clipboard' },
];

export default function ImportWizard({ onSuccess, fieldsFn }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [source, setSource] = useState('file');
  const [format, setFormat] = useState(null);
  const [fileMeta, setFileMeta] = useState(null);
  const [rawInput, setRawInput] = useState(null);
  const [opts, setOpts] = useState({});
  const [parsed, setParsed] = useState(null);
  const [mode, setMode] = useState('insert');
  const [keys, setKeys] = useState([]);
  const [upsert, setUpsert] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [indexedFields, setIndexedFields] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const parseToken = useRef(0);
  const abortRef = useRef(null);
  const editorRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const fmt = format ? getFormat(format) : null;
  const isMatch = mode === 'update' || mode === 'replace';
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  // ---- file pick (drop or click) ----
  function handleFile(fileObj) {
    setErrorMsg(null);
    const id = detectFormat(fileObj.name);
    if (!id) { setErrorMsg('Unsupported file — expected JSON, JSONL, CSV, Excel, or XML.'); return; }
    const f = getFormat(id);
    setFormat(id);
    setOpts(f.defaultOpts);
    setFileMeta({ name: fileObj.name, size: fileObj.size });
    const read = f.read === 'arrayBuffer' ? fileObj.arrayBuffer() : fileObj.text();
    read.then(async (input) => {
      setRawInput(input);
      if (f.ConfigureControls) { setStage(STAGE.CONFIGURE); return; }
      const res = await Promise.resolve(f.parse(input, f.defaultOpts));
      if (res.error) { setErrorMsg(res.error.message); return; }
      if (!res.docs.length) { setErrorMsg('File contains no documents'); return; }
      setParsed(res);
      setKeys(defaultKeysFor(res.docs));
      setStage(STAGE.CONFIRM);
    }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }

  // ---- clipboard next: parse the editor's raw text as JSON / JSON-lines ----
  function clipboardNext() {
    setErrorMsg(null);
    const text = editorRef.current?.getValue?.() ?? '';
    const res = getFormat('json').parse(text);
    if (res.error) { setErrorMsg(res.error.message); return; }
    if (!res.docs.length) { setErrorMsg('No documents to import'); return; }
    setFormat('json');
    setFileMeta({ name: 'Pasted data', size: null });
    setParsed(res);
    setKeys(defaultKeysFor(res.docs));
    setStage(STAGE.CONFIRM);
  }

  // ---- configure: (re)parse on opts change, race-guarded ----
  useEffect(() => {
    if (stage !== STAGE.CONFIGURE || rawInput == null || !fmt) return undefined;
    const token = ++parseToken.current;
    Promise.resolve(fmt.parse(rawInput, opts))
      .then((res) => { if (token === parseToken.current) setParsed(res); })
      .catch((err) => { if (token === parseToken.current) setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message } }); });
    return undefined;
  }, [stage, rawInput, JSON.stringify(opts)]);

  function configureNext() {
    if (!parsed || parsed.error || !parsed.docs.length) return;
    setKeys(defaultKeysFor(parsed.docs));
    setStage(STAGE.CONFIRM);
  }

  // ---- confirm: load indexes once ----
  useEffect(() => {
    if (stage !== STAGE.CONFIRM) return undefined;
    let alive = true;
    api.listIndexes(selectedCollection.value).then((res) => {
      if (!alive) return;
      const fields = new Set();
      for (const idx of (res?.result || [])) for (const f of Object.keys(idx.key || {})) fields.add(f);
      setIndexedFields(fields);
    }).catch(() => { if (alive) setIndexedFields(new Set()); });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);

  // ---- confirm: debounced, abortable plan recompute ----
  const keysKey = keys.join(' ');
  useEffect(() => {
    if (stage !== STAGE.CONFIRM || !isMatch || keys.length === 0 || !parsed) {
      setPlan(null); setPlanLoading(false);
      return undefined;
    }
    setPlanLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const groups = await probeCollection(selectedCollection.value, parsed.docs, keys, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setPlan(computePlan({ docs: parsed.docs, keys, groups, upsert }));
        setPlanLoading(false);
      } catch (err) {
        if (!ctrl.signal.aborted) { setPlanLoading(false); setErrorMsg(err.message); }
      }
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [stage, mode, keysKey, upsert, parsed]);

  const indexWarning = (() => {
    if (!isMatch || !indexedFields || keys.length === 0) return null;
    const uncovered = keys.filter((k) => k !== '_id' && !indexedFields.has(k));
    if (uncovered.length === 0) return null;
    return `Match field${uncovered.length === 1 ? '' : 's'} ${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} not indexed — matching may be slow on large collections.`;
  })();

  // ---- import ----
  async function startImport() {
    setErrorMsg(null);
    setStage(STAGE.IMPORTING);
    const total = isMatch ? (plan?.matched?.length ?? parsed.docs.length) : parsed.docs.length;
    setImportProgress({ phase: isMatch ? mode : 'insert', processed: 0, total });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const result = await executeImport(selectedCollection.value, {
        mode, keys, upsert, docs: parsed.docs, plan, signal: ctrl.signal,
        onProgress: setImportProgress,
      });
      setImportResult(result);
      if ((result.applied + result.inserted + result.deleted) > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally {
      abortRef.current = null;
    }
  }

  function switchSource(v) { setErrorMsg(null); setSource(v); }

  // ---- render ----
  return (
    <div class="modal-body import-wizard">
      {stage === STAGE.PICK && (
        <Fragment>
          <Segmented value={source} options={SOURCE_SEG} onChange={switchSource} ariaLabel="Import source" testid="import-source" />
          {source === 'file' ? (
            <Fragment>
              <div class="modal-field-label" style="margin-top:10px">Drop a file or click to choose:</div>
              <FileDropArea accept={ALL_ACCEPT} onFile={handleFile} onReject={setErrorMsg} inputTestid="import-file-input">
                <div class="file-input-label">Click to select a file</div>
                <div class="file-input-info" style="margin-top:4px">JSON {'·'} JSONL {'·'} CSV {'·'} Excel {'·'} XML</div>
              </FileDropArea>
            </Fragment>
          ) : (
            <Fragment>
              <div class="modal-field-label" style="margin-top:10px">Paste or type JSON (array, object, or JSON-lines):</div>
              <JsonEditor value={'[\n  \n]'} minHeight="200px" fields={fieldsFn} editorRef={editorRef} />
            </Fragment>
          )}
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
          <div class="modal-actions">
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            {source === 'clipboard' && (
              <button class="btn btn-primary" data-testid="clipboard-next" onClick={clipboardNext}>Next {'→'}</button>
            )}
          </div>
        </Fragment>
      )}

      {stage === STAGE.CONFIGURE && fmt && fmt.ConfigureControls && (
        <Fragment>
          <fmt.ConfigureControls opts={opts} setOpt={setOpt} parsed={parsed} />
          <CsvPreview parsed={parsed} />
          <div class="modal-actions">
            <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button class="btn btn-primary" data-testid="import-next" disabled={!parsed || !!parsed.error || !parsed.docs.length} onClick={configureNext}>Next {'→'}</button>
          </div>
        </Fragment>
      )}

      {stage === STAGE.CONFIRM && parsed && (
        <Fragment>
          <ImportConfirm
            fileMeta={fileMeta}
            docs={parsed.docs}
            columns={parsed.columns && parsed.columns.length ? parsed.columns : Object.keys(parsed.docs[0] || {})}
            mode={mode} setMode={setMode}
            keys={keys} setKeys={setKeys}
            upsert={upsert} setUpsert={setUpsert}
            plan={plan} planLoading={planLoading} indexWarning={indexWarning}
            onImport={startImport} onCancel={closeModal}
          />
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
        </Fragment>
      )}

      {stage === STAGE.IMPORTING && importProgress && (
        <ImportProgress progress={importProgress} onCancel={() => abortRef.current?.abort()} />
      )}

      {stage === STAGE.DONE && importResult && (
        <ImportSummary result={importResult} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the wizard tests, expect PASS** — `npx vitest run tests/mdh-import-wizard.test.js`

- [ ] **Step 5: Update `tests/mdh-file-drop.test.js`** — the `describe('Import wizards accept dropped files', …)` block currently mounts `ImportWizard` with `format='csv'`/`format='json'`. Change both mounts to no `format` prop, and fix the JSON reject assertion (the accept is now the union, so the message lists all types):

```js
  it('CSV wizard: dropping a .csv advances past the pick stage', async () => {
    const root = mount(h(ImportWizard, { onSuccess: () => {} }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['name,age\nAlice,30'], 'people.csv', { type: 'text/csv' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
    expect(root.querySelector('[data-testid="csv-options"]')).toBeTruthy();
  });

  it('wizard: dropping a wrong-type file shows a friendly rejection', async () => {
    const root = mount(h(ImportWizard, { onSuccess: () => {} }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['<svg/>'], 'logo.png', { type: 'image/png' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toMatch(/Expected a/);
  });
```

(Leave the `FileDropArea helpers`, `FileDropArea component`, and `Modal overlay mis-drop guard` blocks unchanged. The `dragEvent`/`waitFor`/`mount` helpers already exist in that file.)

- [ ] **Step 6: Run the full suite** — `npm test`
Expected: green. If ONLY `mdh-datapanel-variables` fails, re-run it alone (`npx vitest run tests/mdh-datapanel-variables.test.js`) — known pre-existing flaky, not a regression.

- [ ] **Step 7: Commit** (checkpoint)

```bash
git add src/mdh/components/ImportWizard.jsx tests/mdh-import-wizard.test.js tests/mdh-file-drop.test.js
git commit -m "feat(mdh): ImportWizard source toggle (file/clipboard) + format detection"
```

---

## Task 3: Switchover — single `Import` button, retire inline paste + SplitButton

**Files:**
- Modify: `src/mdh/components/DataOperations.jsx`, `src/mdh/components/DataPanel.jsx`, `src/mdh/components/RecordList.jsx`
- Test: `tests/mdh-csv-routing.test.js` (rewrite)

**Interfaces:**
- Produces: `openImport(onSuccess, fieldsFn)` — opens `<ImportWizard onSuccess fieldsFn/>` in a modal titled `"Import"`. `openDataOperations`/`InsertPanel` removed.
- Consumes (RecordList→DataPanel): the single toolbar action string `'import'`.

- [ ] **Step 1: Rewrite `src/mdh/components/DataOperations.jsx`** to exactly:

```jsx
import { h } from 'preact';
import { openModal } from './Modal.jsx';
import ImportWizard from './ImportWizard.jsx';

// Open the unified import wizard. Source (file / clipboard) and mode
// (insert / update / replace) are chosen inside the wizard.
export function openImport(onSuccess, fieldsFn) {
  openModal('Import', () => <ImportWizard onSuccess={onSuccess} fieldsFn={fieldsFn} />);
}
```

- [ ] **Step 2: Update `src/mdh/components/DataPanel.jsx`**
- Change the import line `import { openDataOperations, openImport } from './DataOperations.jsx';` to `import { openImport } from './DataOperations.jsx';`
- In `handleRefresh`, replace the whole block of `insert` + `import-json`/`import-jsonl`/`import-csv`/`import-xlsx`/`import-xml` branches with a single branch:

```js
    } else if (action === 'import') {
      openImport(invalidateAndRun, currentFields);
    }
```

- [ ] **Step 3: Update `src/mdh/components/RecordList.jsx`**
- Replace the `<SplitButton label="Import" … />` element (in `DefaultToolbar`) with:

```jsx
        <button class="btn btn-sm btn-success" onClick={() => onRefresh('import')}>Import</button>
```

- Delete the now-unused `function SplitButton({ label, cls, onMain, menuItems = [] }) { … }` definition. (Do NOT remove the `useState`/`useRef`/`useEffect` imports — `BulkSplitButton` still uses them.)

- [ ] **Step 4: Rewrite `tests/mdh-csv-routing.test.js`** to exactly:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { openImport } from '../src/mdh/components/DataOperations.jsx';
import { modalContent } from '../src/mdh/store.js';

beforeEach(() => { modalContent.value = null; });

describe('import routing', () => {
  it('openImport opens the "Import" modal and mounts the wizard', () => {
    openImport(() => {}, () => []);
    expect(modalContent.value).toBeTruthy();
    expect(modalContent.value.title).toBe('Import');
    expect(modalContent.value.render()).toBeTruthy();
  });
});
```

- [ ] **Step 5: Verify no dangling references, build, full suite**

```
grep -rn "openDataOperations\|InsertPanel\|SplitButton\|import-json\|import-csv\|import-xlsx\|import-xml\|import-jsonl\|IMPORT_TITLES" src/ tests/
```
Expected: only `BulkSplitButton`/`DownloadSplitButton` matches (unrelated) and no `openDataOperations`/`InsertPanel`/`IMPORT_TITLES`/`import-<fmt>` matches remain. Then:
```
npm run build      # must succeed (no broken imports)
npm test           # green (known flaky mdh-datapanel-variables excepted; re-run alone if it appears)
```

- [ ] **Step 6: Commit** (checkpoint)

```bash
git add -A
git commit -m "feat(mdh): single Import button; retire inline paste + SplitButton"
```

---

## Self-Review

**Spec coverage**
- One plain `Import` button → Task 3 (RecordList). ✓
- `File | Clipboard` toggle, File default → Task 2 (`Segmented`, `source` state). ✓
- File = any type + auto-detect → Task 1 (`detectFormat`/`ALL_ACCEPT`) + Task 2 (`handleFile`). ✓
- Clipboard = JSON/JSONL rich editor, raw-text parse, full pipeline → Task 2 (`clipboardNext`, `JsonEditor`, `getFormat('json').parse`). ✓
- Unknown extension rejected → Task 2 (`handleFile` null branch) + Task 1 (`detectFormat`→null). ✓
- Downstream reused unchanged → Task 2 keeps CONFIGURE/CONFIRM/IMPORTING/DONE identical. ✓
- Retire `openDataOperations`/`InsertPanel`/`SplitButton`; `openImport(onSuccess, fieldsFn)` → Task 3. ✓
- Single caller updated, no dangling refs → Task 3 Step 5 grep. ✓
- Tests: detection (Task 1), wizard+drop (Task 2), routing (Task 3). ✓
- No storage-key changes; build+suite green → Task 3. ✓

**Placeholder scan:** every code step contains complete code; no TBD/"handle errors"/vague steps. ✓

**Type consistency:** `openImport(onSuccess, fieldsFn)` (Task 3) matches DataPanel's `openImport(invalidateAndRun, currentFields)` call and `ImportWizard({onSuccess, fieldsFn})` (Task 2). `detectFormat`/`ALL_ACCEPT` names identical across Tasks 1–2. Action string `'import'` identical in RecordList (emit) and DataPanel (handle). ✓
