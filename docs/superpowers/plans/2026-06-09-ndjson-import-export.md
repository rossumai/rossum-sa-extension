# JSON Lines (NDJSON) import + export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JSON Lines / NDJSON support — **import merged into the existing JSON importer** (NDJSON fallback when whole-file `JSON.parse` fails) and **export as a sibling "JSON Lines" Download option** — using only native `JSON` (zero dependencies, CSP-clean), marked **beta**.

**Architecture:** New `src/mdh/ndjson.js` `parseNdjson(text) → { docs, warnings, error }` (pure) + `buildNdjsonSerializer()` in `downloadCollection.js` (streams). `InsertFileWizard.handleFile` calls `parseNdjson` only in its `JSON.parse` catch — existing array/object behavior is untouched. The Download submenu gains a streaming "JSON Lines" option.

**Tech Stack:** Preact + signals, esbuild, Vitest (jsdom). No runtime dependencies added.

**Spec:** `docs/superpowers/specs/2026-06-09-ndjson-import-export-design.md`

**Commits:** Repo commits manually — **do NOT `git commit`** during execution. End each task with the relevant tests (+ `npm run build` where noted). Stay on `master`.

**Test conventions:** `// @vitest-environment jsdom`; `import { h, render } from 'preact'`; query by `data-testid`/class; condition-based `waitFor`. JSX unicode literal in `{'…'}` form (`{'⚠'}`), never `\uXXXX` in JSX text.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/ndjson.js` | create | `parseNdjson(text)` — pure, native `JSON`, line-by-line. |
| `src/mdh/downloadCollection.js` | modify | `buildNdjsonSerializer()` (streaming). |
| `src/mdh/components/InsertFileWizard.jsx` | modify | NDJSON fallback in `handleFile`; warnings state + render on confirm; accept `.jsonl`/`.ndjson`. |
| `src/mdh/components/RecordList.jsx` | modify | Relabel the JSON import item to "From JSON/JSONL file" + beta; pass `onAllJsonl`/`onFilteredJsonl`. |
| `src/mdh/components/DataOperations.jsx` | modify | Title for the file-insert path → "Insert from JSON/JSONL file". |
| `src/mdh/components/DownloadSplitButton.jsx` | modify | `onAllJsonl`/`onFilteredJsonl` props + a "JSON Lines" flyout option (beta). |
| `src/mdh/components/DataPanel.jsx` | modify | `downloadAllJsonl`/`downloadFilteredJsonl` + routes + import `buildNdjsonSerializer`. |
| `tests/mdh-ndjson.test.js` | create | `parseNdjson` + `buildNdjsonSerializer`. |
| `tests/mdh-insert-file.test.js` | create | Merged importer (array/object still work; NDJSON works; warnings; junk error). |
| `tests/mdh-download-dropdown.test.js` | modify | The "JSON Lines" option. |

> **Sequencing:** Tasks 2 & 3 both edit `RecordList.jsx` + `DataPanel.jsx` — run in order (subagent-driven is sequential).

---

## Task 1: NDJSON core — `parseNdjson` + `buildNdjsonSerializer`

**Files:**
- Create: `src/mdh/ndjson.js`
- Modify: `src/mdh/downloadCollection.js`
- Test: `tests/mdh-ndjson.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-ndjson.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseNdjson } from '../src/mdh/ndjson.js';
import { buildNdjsonSerializer } from '../src/mdh/downloadCollection.js';

describe('parseNdjson', () => {
  it('parses one object per line, skipping blank lines', () => {
    const r = parseNdjson('{"a":1}\n\n{"a":2}\n');
    expect(r.error).toBeNull();
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r.warnings).toEqual([]);
  });
  it('handles CRLF line endings', () => {
    expect(parseNdjson('{"a":1}\r\n{"a":2}').docs).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('skips a malformed line with a warning but imports the rest', () => {
    const r = parseNdjson('{"a":1}\noops\n{"a":2}');
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Line 2/);
  });
  it('skips non-object lines (number / string / array) with warnings', () => {
    const r = parseNdjson('{"a":1}\n42\n"x"\n[1,2]');
    expect(r.docs).toEqual([{ a: 1 }]);
    expect(r.warnings).toHaveLength(3);
  });
  it('returns an error when nothing parses', () => {
    const r = parseNdjson('nope\nalso nope');
    expect(r.error).toBeTruthy();
    expect(r.docs).toEqual([]);
  });
});

describe('buildNdjsonSerializer', () => {
  it('emits one compact JSON object per line and streams (empty pre/postamble)', () => {
    const s = buildNdjsonSerializer();
    expect(s.ext).toBe('jsonl');
    expect(s.mimeType).toBe('application/x-ndjson');
    expect(s.preamble()).toBe('');
    expect(s.postamble()).toBe('');
    expect(s.separator).toBe('\n');
    expect(s.item({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
  it('preserves EJSON shapes and round-trips through parseNdjson', () => {
    const s = buildNdjsonSerializer();
    const docs = [{ _id: { $oid: 'abc' }, n: 1 }, { _id: { $oid: 'def' }, n: 2 }];
    const text = docs.map((d) => s.item(d)).join(s.separator);
    expect(parseNdjson(text).docs).toEqual(docs);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-ndjson.test.js` → FAIL (modules/exports missing).

- [ ] **Step 3: Create `src/mdh/ndjson.js`**

```js
// JSON Lines / NDJSON — pure, native JSON only (no dependency, CSP-clean). Used as
// a fallback by the JSON file importer when a whole-file JSON.parse fails (i.e. the
// file is line-delimited JSON objects rather than one JSON value). Returns the same
// docs/warnings/error shape the import tail expects.
export function parseNdjson(text) {
  const warnings = [];
  const docs = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip blank lines (incl. trailing newline)
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      warnings.push(`Line ${i + 1}: invalid JSON, skipped`);
      continue;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      warnings.push(`Line ${i + 1}: not a JSON object, skipped`);
      continue;
    }
    docs.push(v);
  }
  if (docs.length === 0) return { docs: [], warnings, error: { message: 'No JSON or JSON Lines documents found' } };
  return { docs, warnings, error: null };
}
```

- [ ] **Step 4: Add `buildNdjsonSerializer` to `downloadCollection.js`**

Next to `buildCsvSerializer`/`buildJsonSerializer`:
```js
// NDJSON / JSON Lines serializer — one compact JSON object per line. Streams
// incrementally like JSON/CSV; preserves EJSON shapes ($oid/$date) as literal JSON.
export function buildNdjsonSerializer() {
  return {
    ext: 'jsonl',
    mimeType: 'application/x-ndjson',
    pickerTypes: [{ description: 'JSON Lines file', accept: { 'application/x-ndjson': ['.jsonl', '.ndjson'] } }],
    preamble: () => '',
    item: (doc) => JSON.stringify(doc),
    separator: '\n',
    postamble: () => '',
  };
}
```

- [ ] **Step 5: Run to verify pass + suite**

Run: `npx vitest run tests/mdh-ndjson.test.js` → PASS.
Run: `npm test` → full suite PASS.

---

## Task 2: Merge NDJSON into the JSON importer

**Files:**
- Modify: `src/mdh/components/InsertFileWizard.jsx`, `src/mdh/components/RecordList.jsx`, `src/mdh/components/DataOperations.jsx`
- Test: `tests/mdh-insert-file.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-insert-file.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import InsertFileWizard from '../src/mdh/components/InsertFileWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function file(str, name = 'data.json') { const f = new File([str], name, { type: 'application/json' }); f.text = async () => str; return f; }
function load(root, f) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('InsertFileWizard — JSON + JSONL', () => {
  it('still imports a JSON array (unchanged)', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('[{"a":1},{"a":2}]'));
    await waitFor(() => root.querySelector('.import-mode-group')); // reached CONFIRM
    expect(root.querySelector('[data-testid="import-warnings"]')).toBeNull();
  });
  it('still imports a single JSON object', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"a":1}'));
    await waitFor(() => root.querySelector('.import-mode-group'));
  });
  it('now imports an NDJSON file (was a parse error before)', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"a":1}\n{"a":2}\n{"a":3}', 'data.jsonl'));
    await waitFor(() => root.querySelector('.import-mode-group'));
  });
  it('shows skipped-line warnings on confirm and still proceeds', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('{"a":1}\ngarbage\n{"a":2}', 'data.jsonl'));
    await waitFor(() => root.querySelector('.import-mode-group'));
    const warn = root.querySelector('[data-testid="import-warnings"]');
    expect(warn).toBeTruthy();
    expect(warn.textContent).toMatch(/Line 2/);
  });
  it('accepts .jsonl / .ndjson in the file picker', () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    const accept = root.querySelector('input[type="file"]').accept;
    expect(accept).toContain('.jsonl');
    expect(accept).toContain('.ndjson');
  });
  it('errors on a file that is neither JSON nor JSON Lines', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {} }));
    load(root, file('not json at all\nstill not'));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.import-mode-group')).toBeNull(); // stayed on pick
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-insert-file.test.js` → FAIL (NDJSON file errors; no warnings; `.jsonl` not accepted).

- [ ] **Step 3: Add the NDJSON fallback + warnings to `InsertFileWizard.jsx`**

Add the import (next to the `importFile.js` import):
```js
import { parseNdjson } from '../ndjson.js';
```
Add warnings state (next to the other `useState`s):
```js
  const [warnings, setWarnings] = useState([]);
```
Replace `handleFile` with:
```js
  function handleFile(file) {
    setErrorMsg(null);
    setWarnings([]);
    setFileMeta({ name: file.name, size: file.size });
    file.text().then((text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) parsed = [parsed];
      } catch (jsonErr) {
        // Not a single JSON value — try JSON Lines (NDJSON).
        const nd = parseNdjson(text);
        if (nd.error) { setErrorMsg(`Couldn't parse as JSON or JSON Lines: ${jsonErr.message}`); return; }
        parsed = nd.docs;
        setWarnings(nd.warnings);
      }
      if (parsed.length === 0) { setErrorMsg('File contains no documents'); return; }
      setDocs(parsed);
      setStats(analyzeDocs(parsed));
      setStage(STAGE.CONFIRM);
    }).catch((err) => {
      setErrorMsg(`Couldn't read file: ${err.message}`);
    });
  }
```
Render the warnings on the CONFIRM stage — replace the confirm block:
```jsx
      {stage === STAGE.CONFIRM && stats && (
        <Fragment>
          {warnings.length > 0 && (
            <div class="csv-preview" data-testid="import-warnings">
              {warnings.map((w, i) => <div key={i} class="csv-warning">{'⚠'} {w}</div>)}
            </div>
          )}
          <StageConfirm
            fileMeta={fileMeta}
            stats={stats}
            mode={mode}
            setMode={setMode}
            errorMsg={errorMsg}
            onImport={startImport}
            onCancel={closeModal}
          />
        </Fragment>
      )}
```
Update `StagePick` (the label, accept, and hint):
```jsx
      <div class="modal-field-label">Select a JSON or JSONL file with documents to insert:</div>
      <input ref={inputRef} type="file" accept=".json,.jsonl,.ndjson,application/json,application/x-ndjson" style="display:none" onChange={pick} />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select a JSON or JSONL file</div>
        <div class="file-input-info" style="margin-top:4px">JSON array, a single object, or JSON Lines (one object per line)</div>
      </div>
```
(`Fragment` is already imported in this file.)

- [ ] **Step 4: Relabel the menu item (`RecordList.jsx`) + title (`DataOperations.jsx`)**

`RecordList.jsx` — the JSON import menu item:
```jsx
            { label: 'From JSON/JSONL file', beta: true, onClick: () => onRefresh('insert-file') },
```
`DataOperations.jsx` — extend the title chain so the file-insert path is named:
```jsx
  const title = op === 'insert-csv'
    ? 'Insert from CSV file'
    : op === 'insert-xlsx'
    ? 'Insert from Excel file'
    : op === 'insert-xml'
    ? 'Insert from XML file'
    : (op === 'insert' && isFile)
    ? 'Insert from JSON/JSONL file'
    : op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');
```

- [ ] **Step 5: Run to verify pass + suite + build**

Run: `npx vitest run tests/mdh-insert-file.test.js` → PASS.
Run: `npm test` → full suite PASS (the `mdh-csv-routing` test that checks the `insert-file` modal title may assert "Insert from File" — if so, update its expectation to "Insert from JSON/JSONL file").
Run: `npm run build` → clean.

---

## Task 3: Export — "JSON Lines" download option

**Files:**
- Modify: `src/mdh/components/DownloadSplitButton.jsx`, `src/mdh/components/RecordList.jsx`, `src/mdh/components/DataPanel.jsx`
- Test: `tests/mdh-download-dropdown.test.js`

- [ ] **Step 1: Update the download-dropdown test**

In `tests/mdh-download-dropdown.test.js`, extend the `handlers()` helper to include the new (and the XML) callbacks, and add a JSON Lines test:
```js
  const handlers = () => ({ onAllJson: vi.fn(), onFilteredJson: vi.fn(), onAllCsv: vi.fn(), onFilteredCsv: vi.fn(), onAllXml: vi.fn(), onFilteredXml: vi.fn(), onAllJsonl: vi.fn(), onFilteredJsonl: vi.fn() });
```
Add (mirroring the existing CSV-click test — open the menu, open the "all" flyout, click the JSON Lines button):
```js
  it('offers a JSON Lines option that fires onAllJsonl', async () => {
    const h2 = handlers();
    const root = mount(h(DownloadSplitButton, h2));
    root.querySelector('button').click();                                  // open menu
    root.querySelector('[data-testid="download-all"]').click();            // open flyout
    const jsonl = await waitFor(() => root.querySelector('[data-testid="download-all-jsonl"]'));
    expect(jsonl.querySelector('.toolbar-menu-beta')).toBeTruthy();        // beta badge
    jsonl.click();
    expect(h2.onAllJsonl).toHaveBeenCalledTimes(1);
  });
```
(If the file lacks a `waitFor`, reuse its existing render-flush helper; match the sibling CSV test's interaction pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-download-dropdown.test.js` → FAIL (no `download-all-jsonl`).

- [ ] **Step 3: Add the option to `DownloadSplitButton.jsx`**

Extend the props + `ITEMS` + the flyout (insert JSON Lines right after the JSON button so the JSON family groups together):
```jsx
export default function DownloadSplitButton({ onAllJson, onFilteredJson, onAllCsv, onFilteredCsv, onAllXml, onFilteredXml, onAllJsonl, onFilteredJsonl }) {
```
```jsx
  const ITEMS = [
    { key: 'all', label: 'Download all', json: onAllJson, csv: onAllCsv, xml: onAllXml, jsonl: onAllJsonl },
    { key: 'filtered', label: 'Download filtered', json: onFilteredJson, csv: onFilteredCsv, xml: onFilteredXml, jsonl: onFilteredJsonl },
  ];
```
```jsx
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-json`}
                    onClick={() => choose(it.json)}>JSON</button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-jsonl`}
                    onClick={() => choose(it.jsonl)}>JSON Lines <span class="toolbar-menu-beta">beta</span></button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-csv`}
                    onClick={() => choose(it.csv)}>CSV <span class="toolbar-menu-beta">beta</span></button>
```

- [ ] **Step 4: Wire `RecordList.jsx` + `DataPanel.jsx`**

`RecordList.jsx` — pass the callbacks to `DownloadSplitButton` (next to the CSV/XML ones):
```jsx
            onAllXml={() => onRefresh('download-xml')}
            onFilteredXml={() => onRefresh('download-filtered-xml')}
            onAllJsonl={() => onRefresh('download-jsonl')}
            onFilteredJsonl={() => onRefresh('download-filtered-jsonl')}
```
`DataPanel.jsx` — import the serializer:
```jsx
import { downloadCollection as runDownload, buildCsvSerializer, buildXmlSerializer, buildNdjsonSerializer } from '../downloadCollection.js';
```
Add the two handlers (mirror the modal-less JSON `downloadAll`/`downloadFiltered`, with a `.jsonl` filename + the serializer):
```jsx
  async function downloadAllJsonl() {
    const tc = pagination.totalCount.value;
    if (tc !== null && tc > 10_000) {
      const proceed = await confirmModal('Large collection', `This collection has ${tc.toLocaleString()} documents. Downloading may take a while and use significant memory. Continue?`);
      if (!proceed) return;
    }
    const col = collection;
    await runDownloadJob({
      pipelineStages: [{ $match: {} }],
      filename: `${col}.jsonl`,
      filtered: false,
      fetchCount: async () => {
        if (pagination.totalCount.value !== null) return pagination.totalCount.value;
        const r = await api.aggregate(col, [{ $count: 'total' }]);
        return r.result?.[0]?.total ?? 0;
      },
      serializer: buildNdjsonSerializer(),
    });
  }

  async function downloadFilteredJsonl() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substitutePlaceholders(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot download filtered: ${err.message}` };
      return;
    }
    downloadCancelRef.current = false;
    error.value = null;
    setDownloadState({ counting: true, filtered: true });
    const ac = new AbortController();
    downloadCountAbortRef.current = ac;
    const col = collection;
    let filteredCount;
    try {
      const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
      filteredCount = r.result?.[0]?.total ?? 0;
    } catch (err) {
      downloadCountAbortRef.current = null;
      if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
      error.value = { message: `Cannot download filtered: ${err.message}` };
      setDownloadState(null);
      return;
    }
    downloadCountAbortRef.current = null;
    if (downloadCancelRef.current) { setDownloadState(null); return; }
    if (filteredCount > 10_000) {
      setDownloadState(null);
      const proceed = await confirmModal('Large download', `This filter matches ${filteredCount.toLocaleString()} documents. Downloading may take a while and use significant memory. Continue?`);
      if (!proceed) return;
    }
    await runDownloadJob({
      pipelineStages,
      filename: `${col}-filtered.jsonl`,
      filtered: true,
      fetchCount: async () => filteredCount,
      serializer: buildNdjsonSerializer(),
    });
  }
```
Add the routes in `handleToolbarAction` (next to the CSV/XML download branches):
```jsx
    } else if (action === 'download-jsonl') {
      downloadAllJsonl();
    } else if (action === 'download-filtered-jsonl') {
      downloadFilteredJsonl();
```

- [ ] **Step 5: Run to verify pass + suite + build**

Run: `npx vitest run tests/mdh-download-dropdown.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 4: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all PASS (capture `Test Files N passed`). Run: `npm run build` → clean.

- [ ] **Step 2: Zero-dep / CSP guards**

Run: `grep -nE "eval\(|new Function\(|WebAssembly" dist/console/console.js` → no matches.
Run: `git diff --stat package.json` → no change (no dependency added).

- [ ] **Step 3: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection:
- **Import:** Insert ▾ → "From JSON/JSONL file" (beta) → load a `.jsonl` (one object per line) → reaches confirm and imports; a file with a junk line shows a "⚠ Line N…" warning on confirm but still imports the good docs; a JSON **array** file and a single JSON **object** still import as before; a truly non-JSON file shows the combined parse error.
- **Export:** Download ▾ → Download all / filtered → **JSON Lines** (beta) → downloads a `.jsonl` with one compact object per line (open it: each line is a standalone JSON doc; `_id` `$oid` preserved). Re-import that file via "From JSON/JSONL file" → round-trips.

- [ ] **Step 4: Report**

Summarize suite + build + the zero-dep/CSP grep, and the manual round-trip (NDJSON import incl. warnings + the JSON Lines export). Don't claim done without the manual check.

---

## Self-Review (completed during planning)

- **Spec coverage:** `parseNdjson` (pure, native, skip+warn, error-if-empty) §4 ✓; merged into `InsertFileWizard` via the `JSON.parse` catch — array/object behavior untouched §4 ✓; warnings surfaced on confirm §4 ✓; `.jsonl`/`.ndjson` accepted §4 ✓; menu relabel "From JSON/JSONL file" + beta + title §2/§4 ✓; `buildNdjsonSerializer` streaming, EJSON-preserving §5 ✓; sibling "JSON Lines" Download option (beta) + RecordList/DataPanel wiring (modal-less, mirrors JSON) §5 ✓; verification incl. zero-dep/CSP §6 ✓; no NDJSON import options, no JSON-array behavior change (non-goals) ✓.
- **Placeholder scan:** none — full code + complete tests + exact commands. The `mdh-csv-routing` title-expectation tweak (Task 2 Step 5) is conditional-but-explicit (update only if it asserts the old "Insert from File").
- **Type/name consistency:** `parseNdjson(text) → { docs, warnings, error }` consistent (ndjson.js, InsertFileWizard, tests); `buildNdjsonSerializer()` shape matches the serializer contract + used by `downloadAllJsonl`/`downloadFilteredJsonl`; action keys `download-jsonl`/`download-filtered-jsonl` consistent RecordList→DataPanel; `onAllJsonl`/`onFilteredJsonl` consistent RecordList↔DownloadSplitButton; `data-testid="download-<key>-jsonl"`; import action key stays `insert-file` (merge — no new dispatch); reuses `.toolbar-menu-beta`, `.csv-warning`, `.import-mode-group`, `Fragment` (all existing).
