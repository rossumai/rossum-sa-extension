# Drag-and-drop file support for MDH file-pick modals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose a file by dragging it onto the dashed picker box in every MDH "Insert from XYZ file" wizard and the Update/Replace-from-file panels, in addition to clicking.

**Architecture:** Introduce one shared presentational component, `FileDropArea`, that owns the hidden file input, the dashed `.file-input-area` box, click-to-open, drag-over highlighting, and drop-time extension validation. The four wizard `*StagePick`s and the `FileInput` (Update/Replace) collapse to thin wrappers around it. A small `preventDefault` guard on the full-screen `.modal-overlay` stops a near-miss drop from making the browser open the file.

**Tech Stack:** Preact + `@preact/signals` (JSX via esbuild `jsxFactory: 'h'`), Vitest + jsdom for tests.

## Global Constraints

- **No git commits and no branches/worktrees during this work** (standing user preference). Work on `master`. End each task by running its tests and pausing for review — do **not** commit. The user commits when satisfied.
- **Backward compatibility is mandatory.** The click-to-select path must stay byte-for-byte behaviorally identical: same hidden `<input type="file">`, same `accept` values, same `data-testid`s (`csv-file-input`, `xml-file-input`, `xlsx-file-input`; none on the JSON/JSONL and Update/Replace inputs), same `change`-event → parse flow.
- **Extension validation runs on the DROP path only**, never on the click path.
- **Do not change any existing picker label/info copy.** Tests assert the exact strings `Click to select a CSV file`, `Click to select an XML`, `Click to select an Excel`. The existing label/info `<div>`s are passed through unchanged as `children`.
- **No new storage keys, no API changes, no new dependencies.**
- JSX unicode caveat: use `{'…'}`-style expressions or literal glyphs, never bare `\uXXXX` in JSX text/attributes (see CLAUDE.md).
- Validation is **extension-based** (lowercased suffix match); MIME tokens in `accept` are ignored for matching.
- The full existing test suite must stay green: `npm test`.

---

## File Structure

- **Create** `src/mdh/components/FileDropArea.jsx` — the shared picker box (input + dashed area + click + drag + drop validation). Default export the component; named-export the three pure helpers for unit testing.
- **Create** `tests/mdh-file-drop.test.js` — unit tests for `FileDropArea`, the pure helpers, and the overlay guard.
- **Modify** `src/console/console.css` — add the single `.file-input-area.drag-over` rule.
- **Modify** `src/mdh/components/Modal.jsx` — add `onDragOver`/`onDrop` `preventDefault` guard on `.modal-overlay`.
- **Modify** `src/mdh/components/InsertFileWizard.jsx` — `StagePick` wraps `FileDropArea`.
- **Modify** `src/mdh/components/CsvImportWizard.jsx` — `CsvStagePick` wraps `FileDropArea`.
- **Modify** `src/mdh/components/XmlImportWizard.jsx` — `XmlStagePick` wraps `FileDropArea`.
- **Modify** `src/mdh/components/XlsxImportWizard.jsx` — `XlsxStagePick` wraps `FileDropArea`.
- **Modify** `src/mdh/components/DataOperations.jsx` — `FileInput` wraps `FileDropArea`, gains an error line, is exported for testing.

---

## Task 1: `FileDropArea` component + helpers + CSS

**Files:**
- Create: `src/mdh/components/FileDropArea.jsx`
- Create: `tests/mdh-file-drop.test.js`
- Modify: `src/console/console.css` (after the `.file-input-area:hover` rule, ~line 1319)

**Interfaces:**
- Consumes: nothing (leaf component).
- Produces:
  - Default export `FileDropArea({ accept, onFile, onReject, inputTestid, children })`.
    - `onFile(file: File)` — called with the chosen file (click path: any file; drop path: only files passing the extension check).
    - `onReject(message: string)` — called on a drop whose extension fails the check.
    - `inputTestid?: string` — forwarded to the hidden input's `data-testid` (omitted when undefined).
  - Named exports `allowedExtensions(accept: string) => string[]`, `formatExpected(exts: string[]) => string`, `extensionMatches(name: string, exts: string[]) => boolean`.

- [ ] **Step 1: Write the failing tests**

Create `tests/mdh-file-drop.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import FileDropArea, {
  allowedExtensions,
  formatExpected,
  extensionMatches,
} from '../src/mdh/components/FileDropArea.jsx';

function mount(node) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  return root;
}

// jsdom's Event has no dataTransfer, so we attach one. `cancelable: true`
// lets preventDefault register on event.defaultPrevented.
function dragEvent(type, { files = [], types = ['Files'] } = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files, types, dropEffect: 'none' },
    configurable: true,
  });
  return ev;
}

async function waitFor(fn, { timeout = 1000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('FileDropArea helpers', () => {
  it('allowedExtensions keeps only the dotted tokens, lowercased', () => {
    expect(allowedExtensions('.csv,text/csv')).toEqual(['.csv']);
    expect(allowedExtensions('.jsonl,.ndjson,application/x-ndjson'))
      .toEqual(['.jsonl', '.ndjson']);
    expect(allowedExtensions('.XML,text/xml')).toEqual(['.xml']);
  });

  it('formatExpected reads naturally for 1, 2, and 3+ extensions', () => {
    expect(formatExpected(['.json'])).toBe('Expected a .json file');
    expect(formatExpected(['.jsonl', '.ndjson']))
      .toBe('Expected a .jsonl or .ndjson file');
    expect(formatExpected(['.a', '.b', '.c']))
      .toBe('Expected a .a, .b, or .c file');
  });

  it('extensionMatches is case-insensitive and permissive when no exts', () => {
    expect(extensionMatches('Data.CSV', ['.csv'])).toBe(true);
    expect(extensionMatches('data.txt', ['.csv'])).toBe(false);
    expect(extensionMatches('whatever', [])).toBe(true);
  });
});

describe('FileDropArea component', () => {
  it('drops a matching file → onFile, and prevents the browser default', () => {
    let got = null;
    const root = mount(h(FileDropArea, {
      accept: '.csv,text/csv', onFile: (f) => { got = f; }, onReject: () => {},
    }, h('div', { class: 'file-input-label' }, 'Click to select a CSV file')));
    const area = root.querySelector('.file-input-area');
    const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
    const ev = dragEvent('drop', { files: [file] });
    area.dispatchEvent(ev);
    expect(got).toBe(file);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('drops a wrong-extension file → onReject, not onFile', () => {
    let got = null; let rejected = null;
    const root = mount(h(FileDropArea, {
      accept: '.csv,text/csv', onFile: (f) => { got = f; }, onReject: (m) => { rejected = m; },
    }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    expect(got).toBeNull();
    expect(rejected).toBe('Expected a .csv file');
  });

  it('highlights on dragenter (Files) and clears on dragleave', async () => {
    const root = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    area.dispatchEvent(dragEvent('dragenter', { files: [] }));
    await waitFor(() => area.classList.contains('drag-over'));
    area.dispatchEvent(dragEvent('dragleave'));
    await waitFor(() => !area.classList.contains('drag-over'));
    expect(area.classList.contains('drag-over')).toBe(false);
  });

  it('ignores a drag that carries no files (e.g. dragging page content)', async () => {
    const root = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'pick')));
    const area = root.querySelector('.file-input-area');
    area.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }));
    await new Promise((r) => setTimeout(r, 40));
    expect(area.classList.contains('drag-over')).toBe(false);
  });

  it('click path forwards the file WITHOUT extension validation (back-compat)', () => {
    let got = null;
    const root = mount(h(FileDropArea, { accept: '.csv,text/csv', onFile: (f) => { got = f; } }, h('div', null, 'pick')));
    const input = root.querySelector('input[type="file"]');
    const file = new File(['x'], 'forced.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(got).toBe(file); // accepted despite .txt — click path is unchanged
  });

  it('forwards inputTestid, and omits data-testid when not given', () => {
    const a = mount(h(FileDropArea, { accept: '.csv', onFile: () => {}, inputTestid: 'demo-input' }, h('div', null, 'p')));
    expect(a.querySelector('[data-testid="demo-input"]')).toBeTruthy();
    const b = mount(h(FileDropArea, { accept: '.csv', onFile: () => {} }, h('div', null, 'p')));
    expect(b.querySelector('input[type="file"]').hasAttribute('data-testid')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-file-drop.test.js`
Expected: FAIL — `Cannot find module '../src/mdh/components/FileDropArea.jsx'`.

- [ ] **Step 3: Create the component**

Create `src/mdh/components/FileDropArea.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { useState, useRef } from 'preact/hooks';

// Shared picker box for the MDH file-import modals. Renders the hidden file
// input + the dashed `.file-input-area`, owns click-to-open, drag-over
// highlighting, and drop-time extension validation. The click path is
// intentionally NOT validated (the OS dialog already filters by `accept`);
// only the drop path checks the extension.

// The dotted tokens of an `accept` string (".csv,text/csv" -> [".csv"]),
// lowercased. MIME tokens are ignored for matching.
export function allowedExtensions(accept) {
  return (accept || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.startsWith('.'));
}

// Human-readable rejection message for a wrong-type drop.
export function formatExpected(exts) {
  if (exts.length === 0) return 'Unsupported file type';
  if (exts.length === 1) return `Expected a ${exts[0]} file`;
  if (exts.length === 2) return `Expected a ${exts[0]} or ${exts[1]} file`;
  return `Expected a ${exts.slice(0, -1).join(', ')}, or ${exts[exts.length - 1]} file`;
}

// True if `name` ends with one of `exts` (case-insensitive). No exts -> accept.
export function extensionMatches(name, exts) {
  if (exts.length === 0) return true;
  const lower = (name || '').toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

export default function FileDropArea({ accept, onFile, onReject, inputTestid, children }) {
  const inputRef = useRef(null);
  const dragDepth = useRef(0); // nested enter/leave counter — avoids flicker
  const [dragging, setDragging] = useState(false);
  const exts = allowedExtensions(accept);

  // Only react to drags that actually carry files (not page-element drags).
  function hasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  // Click path: unchanged — forward the first file with no validation.
  function pick(e) {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
  }

  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // handled once; never reaches the overlay guard
    dragDepth.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!extensionMatches(f.name, exts)) {
      if (onReject) onReject(formatExpected(exts));
      return;
    }
    onFile(f);
  }

  return (
    <Fragment>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style="display:none"
        onChange={pick}
        data-testid={inputTestid}
      />
      <div
        class={`file-input-area${dragging ? ' drag-over' : ''}`}
        onClick={() => inputRef.current && inputRef.current.click()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {children}
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 4: Add the drag-over CSS**

In `src/console/console.css`, immediately after the `.file-input-area:hover { … }` line (~1319):

```css
.file-input-area.drag-over {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-bg);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/mdh-file-drop.test.js`
Expected: PASS (all helper + component tests).

- [ ] **Step 6: Pause for review** (no commit — see Global Constraints).

---

## Task 2: Overlay mis-drop guard in `Modal.jsx`

**Files:**
- Modify: `src/mdh/components/Modal.jsx:166` (the `.modal-overlay` element)
- Test: append to `tests/mdh-file-drop.test.js`

**Interfaces:**
- Consumes: `openModal`, default `Modal` from `./Modal.jsx` (already exported; `Modal` is the default export, `Modal.jsx:111`).
- Produces: nothing new — adds inert `onDragOver`/`onDrop` handlers to the existing overlay.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-file-drop.test.js`:

```js
import Modal, { openModal, closeModal } from '../src/mdh/components/Modal.jsx';

describe('Modal overlay mis-drop guard', () => {
  it('swallows a file drop on the overlay so the browser never opens the file', () => {
    openModal('Drag test', () => h('div', { class: 'inner' }, 'body'));
    const root = mount(h(Modal, null));
    const overlay = root.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    const ev = dragEvent('drop', { files: [], types: ['Files'] });
    overlay.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    closeModal();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-file-drop.test.js -t "overlay mis-drop"`
Expected: FAIL — `expect(ev.defaultPrevented).toBe(true)` is `false` (no handler yet).

- [ ] **Step 3: Add the guard**

In `src/mdh/components/Modal.jsx`, change the overlay opening tag (line 166) from:

```jsx
    <div class="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
```

to:

```jsx
    <div
      class="modal-overlay visible"
      onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-file-drop.test.js -t "overlay mis-drop"`
Expected: PASS.

- [ ] **Step 5: Pause for review** (no commit).

---

## Task 3: Wire the four Insert wizards to `FileDropArea`

**Files:**
- Modify: `src/mdh/components/InsertFileWizard.jsx` (`StagePick`, ~lines 116 & 150-171)
- Modify: `src/mdh/components/CsvImportWizard.jsx` (`CsvStagePick`, ~lines 116 & 152-172)
- Modify: `src/mdh/components/XmlImportWizard.jsx` (`XmlStagePick`, ~lines 70 & 79-94)
- Modify: `src/mdh/components/XlsxImportWizard.jsx` (`XlsxStagePick`, ~lines 90 & 107-122)
- Test: append integration tests to `tests/mdh-file-drop.test.js`

**Interfaces:**
- Consumes: default `FileDropArea` from `./FileDropArea.jsx`.
- Produces: no API change — each `*StagePick` now also accepts dropped files.

Each wizard already imports `Fragment` and has `setErrorMsg` in scope at the `*StagePick` render site (verified). The edits are the same shape in all four: add the import, pass `onReject={setErrorMsg}` at the render site, and replace the hidden `<input>` + `.file-input-area` `<div>` with a `<FileDropArea>` that keeps the **exact** existing label/info `<div>`s as children.

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/mdh-file-drop.test.js`:

```js
import CsvImportWizard from '../src/mdh/components/CsvImportWizard.jsx';
import InsertFileWizard from '../src/mdh/components/InsertFileWizard.jsx';

describe('Import wizards accept dropped files', () => {
  it('CSV wizard: dropping a .csv advances past the pick stage', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['name,age\nAlice,30'], 'people.csv', { type: 'text/csv' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    // Configure stage shows the CSV options panel once the file is read.
    await waitFor(() => root.querySelector('[data-testid="csv-options"]'));
    expect(root.querySelector('[data-testid="csv-options"]')).toBeTruthy();
  });

  it('JSON wizard: dropping a wrong-type file shows a friendly rejection', async () => {
    const root = mount(h(InsertFileWizard, { onSuccess: () => {}, format: 'json' }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['<svg/>'], 'logo.png', { type: 'image/png' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toContain('Expected a .json file');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-file-drop.test.js -t "accept dropped files"`
Expected: FAIL — `.file-input-area` has no drop handler yet (the drop is a no-op; `waitFor` times out).

- [ ] **Step 3: Edit `InsertFileWizard.jsx`**

Add to the imports (after line 12, `import { parseNdjson } …`):

```jsx
import FileDropArea from './FileDropArea.jsx';
```

At the pick render (line 116) add `onReject`:

```jsx
      {stage === STAGE.PICK && <StagePick onFile={handleFile} onReject={setErrorMsg} errorMsg={errorMsg} onCancel={closeModal} format={format} />}
```

Replace the whole `StagePick` function (lines 150-171) with:

```jsx
function StagePick({ onFile, onReject, errorMsg, onCancel, format = 'json' }) {
  const isJsonl = format === 'jsonl';
  return (
    <Fragment>
      <div class="modal-field-label">{isJsonl ? 'Select a JSONL file to insert:' : 'Select a JSON file with documents to insert:'}</div>
      <FileDropArea
        accept={isJsonl ? '.jsonl,.ndjson,application/x-ndjson' : '.json,application/json'}
        onFile={onFile}
        onReject={onReject}
      >
        <div class="file-input-label">{isJsonl ? 'Click to select a JSONL file' : 'Click to select a JSON file'}</div>
        <div class="file-input-info" style="margin-top:4px">{isJsonl ? 'One JSON object per line (.jsonl / .ndjson)' : 'JSON array, or a single document'}</div>
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}
```

(The now-unused `useRef` import in this file stays — it is still used elsewhere in the wizard.)

- [ ] **Step 4: Edit `CsvImportWizard.jsx`**

Add after the `import { parseCsv } …` line (line 7):

```jsx
import FileDropArea from './FileDropArea.jsx';
```

At the pick render (line 116) add `onReject`:

```jsx
      {stage === STAGE.PICK && <CsvStagePick onFile={handleFile} onReject={setErrorMsg} errorMsg={errorMsg} onCancel={closeModal} />}
```

Replace the whole `CsvStagePick` function (lines 152-172) with:

```jsx
function CsvStagePick({ onFile, onReject, errorMsg, onCancel }) {
  return (
    <Fragment>
      <div class="modal-field-label">Select a CSV file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <FileDropArea accept=".csv,text/csv" onFile={onFile} onReject={onReject} inputTestid="csv-file-input">
        <div class="file-input-label">Click to select a CSV file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document in the selected collection</div>
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 5: Edit `XmlImportWizard.jsx`**

Add `import FileDropArea from './FileDropArea.jsx';` to the imports (after the existing component/helper imports near the top).

At the pick render (line 70) add `onReject`:

```jsx
      {stage === STAGE.PICK && <XmlStagePick onFile={handleFile} onReject={setErrorMsg} errorMsg={errorMsg} onCancel={closeModal} />}
```

Replace the whole `XmlStagePick` function (lines 79-94) with:

```jsx
function XmlStagePick({ onFile, onReject, errorMsg, onCancel }) {
  return (
    <Fragment>
      <div class="modal-field-label">Select an XML file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <FileDropArea accept=".xml,text/xml,application/xml" onFile={onFile} onReject={onReject} inputTestid="xml-file-input">
        <div class="file-input-label">Click to select an XML file</div>
        <div class="file-input-info" style="margin-top:4px">Each repeating element becomes one document.</div>
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}
```

- [ ] **Step 6: Edit `XlsxImportWizard.jsx`**

Add `import FileDropArea from './FileDropArea.jsx';` to the imports.

At the pick render (line 90) add `onReject`:

```jsx
      {stage === STAGE.PICK && <XlsxStagePick onFile={handleFile} onReject={setErrorMsg} errorMsg={errorMsg} onCancel={closeModal} />}
```

Replace the whole `XlsxStagePick` function (lines 107-122) with:

```jsx
function XlsxStagePick({ onFile, onReject, errorMsg, onCancel }) {
  return (
    <Fragment>
      <div class="modal-field-label">Select an Excel file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <FileDropArea accept=".xlsx" onFile={onFile} onReject={onReject} inputTestid="xlsx-file-input">
        <div class="file-input-label">Click to select an Excel (.xlsx) file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document. Date cells import as their Excel serial number.</div>
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}
```

- [ ] **Step 7: Run the integration tests + the existing wizard suites**

Run: `npx vitest run tests/mdh-file-drop.test.js tests/mdh-csv-wizard.test.js tests/mdh-xml-wizard.test.js tests/mdh-xlsx-wizard.test.js tests/mdh-insert-file.test.js`
Expected: PASS — drop tests pass; existing wizard tests (label text, `accept`, `data-testid`, `change`-event path) still pass unchanged.

- [ ] **Step 8: Pause for review** (no commit).

---

## Task 4: Wire the Update/Replace `FileInput` to `FileDropArea`

**Files:**
- Modify: `src/mdh/components/DataOperations.jsx` (imports + `FileInput`, lines 1-2 and 12-42)
- Test: append to `tests/mdh-file-drop.test.js`

**Interfaces:**
- Consumes: default `FileDropArea` from `./FileDropArea.jsx`.
- Produces: `export function FileInput({ onParsed })` — now exported for testing; same `onParsed(docs | null)` contract, plus drop support and an inline error line.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-file-drop.test.js`:

```js
import { FileInput } from '../src/mdh/components/DataOperations.jsx';

describe('Update/Replace FileInput drop support', () => {
  it('drops a .json file → onParsed gets the documents', async () => {
    let docs = null;
    const root = mount(h(FileInput, { onParsed: (d) => { docs = d; } }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['[{"a":1},{"a":2}]'], 'rows.json', { type: 'application/json' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => docs !== null);
    expect(docs).toHaveLength(2);
    expect(root.textContent).toContain('2 documents');
  });

  it('drops a wrong-type file → friendly error, onParsed not called with docs', async () => {
    let docs = null;
    const root = mount(h(FileInput, { onParsed: (d) => { docs = d; } }));
    const area = root.querySelector('.file-input-area');
    const file = new File(['x'], 'data.csv', { type: 'text/csv' });
    area.dispatchEvent(dragEvent('drop', { files: [file] }));
    await waitFor(() => root.querySelector('.input-hint'));
    expect(root.querySelector('.input-hint').textContent).toContain('Expected a .json file');
    expect(docs).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-file-drop.test.js -t "FileInput drop support"`
Expected: FAIL — `FileInput` is not exported (`import` resolves to `undefined`) → render throws / `area` is null.

- [ ] **Step 3: Edit `DataOperations.jsx`**

Change line 1 from `import { h } from 'preact';` to:

```jsx
import { h, Fragment } from 'preact';
```

Add after the existing component imports (after line 9, `import XmlImportWizard …`):

```jsx
import FileDropArea from './FileDropArea.jsx';
```

Replace the whole `FileInput` function (lines 12-42) with:

```jsx
export function FileInput({ onParsed }) {
  const [fileName, setFileName] = useState(null);
  const [docCount, setDocCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState(null);

  function readFile(file) {
    setErrorMsg(null);
    file.text().then((text) => {
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) parsed = [parsed];
      setFileName(file.name);
      setDocCount(parsed.length);
      if (onParsed) onParsed(parsed);
    }).catch((err) => {
      setFileName(null);
      setDocCount(0);
      setErrorMsg('Error: ' + err.message);
      if (onParsed) onParsed(null);
    });
  }

  return (
    <Fragment>
      <FileDropArea accept=".json" onFile={readFile} onReject={setErrorMsg}>
        <div class="file-input-label">{fileName || 'Click to select a JSON file'}</div>
        {fileName && docCount > 0 && <div class="file-input-info">{docCount} document{docCount !== 1 ? 's' : ''}</div>}
      </FileDropArea>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
    </Fragment>
  );
}
```

Notes: this drops the unused `parsedRef` and the dead `_fileInput` ref (set but never read anywhere — verified). The whole dashed box is now clickable (previously only the label was), which is an improvement and back-compatible. On a read failure `onParsed(null)` is now called so the host's `fileDocs` resets — previously the error was shown only by mutating the label; `UpdatePanel`/`ReplacePanel` already guard on `!fileDocs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-file-drop.test.js -t "FileInput drop support"`
Expected: PASS.

- [ ] **Step 5: Pause for review** (no commit).

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all suites green, including the pre-existing wizard, routing, and import suites.

- [ ] **Step 2: Clean production build**

Run: `npm run build`
Expected: build succeeds; `dist/` is produced (this confirms the new component bundles and the CSS rule is copied).

- [ ] **Step 3: Manual smoke test (browser)**

Load `dist/` as an unpacked extension, open the Console → Dataset Management, select a collection, and for each of: Insert from JSON, JSONL, CSV, XML, Excel, plus Update-from-file and Replace-from-file:
- Drag a correct file onto the dashed box → it highlights on drag-over and the wizard advances / shows the doc count.
- Drag a wrong-type file → friendly "Expected a …" message, no advance.
- Drop a file just outside the box but on the modal → nothing happens (no browser navigation).
- Click the box (no drag) → OS dialog opens as before.

- [ ] **Step 4: Report results and pause for review** (no commit; the user commits when satisfied).

---

## Self-Review (completed by plan author)

- **Spec coverage:** §FileDropArea contract → Task 1; §extension validation → Task 1 (helpers) + Tasks 3/4 (wired); §overlay guard → Task 2; §wiring 5 surfaces → Tasks 3 (4 wizards) + 4 (FileInput); §CSS → Task 1 Step 4; §error handling/edge cases → Task 1 tests + Tasks 3/4 reject tests; §testing → `tests/mdh-file-drop.test.js` across tasks; §backward compatibility → Global Constraints + Task 1 click-path test + preserved testids/labels; §out-of-scope (multi-file, a11y) → not implemented, as intended.
- **Placeholder scan:** none — every code/CSS/command step is concrete.
- **Type/name consistency:** `FileDropArea({ accept, onFile, onReject, inputTestid, children })`, `allowedExtensions`/`formatExpected`/`extensionMatches`, and `FileInput({ onParsed })` are used identically across Tasks 1, 3, 4, and the tests.
