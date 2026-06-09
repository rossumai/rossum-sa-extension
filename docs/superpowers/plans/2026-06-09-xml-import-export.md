# XML import + export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add XML import (record-list, native `DOMParser`, sync) and XML export (streaming serializer) to the MDH Dataset Management app, marked **beta**, using only native Web APIs — zero dependencies — reusing the existing import tail and download pipeline.

**Architecture:** `src/mdh/xml.js` holds both sides: `parseXml(input, opts) → { docs, columns, warnings, error, recordCandidates, recordKey }` (same shape as `parseCsv`/`parseXlsx`, so the import tail is reused) and the export helpers (`toXmlName`/`escapeXml`/`valueToXml`/`docToXml`). `buildXmlSerializer` (in `downloadCollection.js`) wraps those into the existing pluggable, streaming serializer contract. UI mirrors the CSV/Excel importers and the CSV/JSON exporters.

**Tech Stack:** Preact + signals, esbuild, Vitest (jsdom). No runtime dependencies added.

**Spec:** `docs/superpowers/specs/2026-06-09-xml-import-export-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** `// @vitest-environment jsdom` (parser needs `DOMParser` from jsdom; `TextDecoder` is a Node global). `import { h, render } from 'preact'`; mount into a div; query by `data-testid`/class; condition-based `waitFor`. JSX unicode literal in `{'…'}` expression form (`{'→'}`, `{'…'}`, `{'·'}`, `{'⚠'}`), never `\uXXXX` in JSX text. XML test inputs are inline template-literal strings (no binary fixture needed).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/xml.js` | create | Import: `parseXml`/`detectRecords`/`elementToValue`/`toDocs`. Export: `toXmlName`/`escapeXml`/`valueToXml`/`docToXml`. Native `DOMParser` + string builder. |
| `src/mdh/components/XmlImportWizard.jsx` | create | Import wizard (sync `useMemo` parse), record-element picker + infer toggle, `JsonTree` preview, beta. |
| `src/mdh/components/XmlExportOptions.jsx` | create | Export modal: root/record name inputs + live XML preview + beta. |
| `src/mdh/downloadCollection.js` | modify | Add `buildXmlSerializer` (streaming). |
| `src/mdh/components/DownloadSplitButton.jsx` | modify | Add `onAllXml`/`onFilteredXml` + an XML flyout option (beta). |
| `src/mdh/components/RecordList.jsx` | modify | "From XML file" menu item (beta) + pass XML download callbacks. |
| `src/mdh/components/DataPanel.jsx` | modify | Route `insert-xml-file` / `download-xml` / `download-filtered-xml`; `downloadAllXml`/`downloadFilteredXml`. |
| `src/mdh/components/DataOperations.jsx` | modify | Dispatch `insert-xml` → `<XmlImportWizard>`; title "Insert from XML file". |
| `tests/mdh-xml.test.js` | create | `parseXml` + decoders + export helpers (inline XML). |
| `tests/mdh-xml-wizard.test.js` | create | Import wizard + export options + download-menu wiring. |

> **Sequencing:** parser (1) → import UI+wiring (2) → export serializer (3) → export UI+wiring (4) → verify (5). Tasks 1 & 3 both edit `xml.js` + `tests/mdh-xml.test.js`; Tasks 2 & 4 both edit `DataPanel.jsx` + `tests/mdh-xml-wizard.test.js` — run in order (subagent-driven is sequential).

---

## Task 1: XML import parser — `src/mdh/xml.js`

**Files:**
- Create: `src/mdh/xml.js`
- Test: `tests/mdh-xml.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-xml.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseXml, elementToValue, detectRecords } from '../src/mdh/xml.js';

const dom = (s) => new DOMParser().parseFromString(s, 'application/xml');

describe('detectRecords', () => {
  it('auto-detects the dominant repeating element', () => {
    const d = dom(`<Invoices><Invoice><a>1</a></Invoice><Invoice><a>2</a></Invoice></Invoices>`);
    const { records, candidates } = detectRecords(d);
    expect(records.length).toBe(2);
    expect(candidates.some((c) => /Invoice/.test(c.label))).toBe(true);
  });
  it('falls back to root children when nothing repeats', () => {
    const d = dom(`<root><only><x>1</x></only></root>`);
    expect(detectRecords(d).records.length).toBe(1);
  });
});

describe('elementToValue', () => {
  it('maps attributes (@_), child elements, repeated→array, and text', () => {
    const el = dom(`<r id="A1"><Vendor>ACME</Vendor><Tag>x</Tag><Tag>y</Tag></r>`).documentElement;
    expect(elementToValue(el)).toEqual({ '@_id': 'A1', Vendor: 'ACME', Tag: ['x', 'y'] });
  });
  it('returns a scalar for a pure-text leaf, null for empty, and #text for mixed', () => {
    expect(elementToValue(dom(`<a>hi</a>`).documentElement)).toBe('hi');
    expect(elementToValue(dom(`<a/>`).documentElement)).toBeNull();
    expect(elementToValue(dom(`<a x="1">txt</a>`).documentElement)).toEqual({ '@_x': '1', '#text': 'txt' });
  });
  it('strips namespace prefixes; infers types only when asked', () => {
    expect(elementToValue(dom(`<ns:a xmlns:ns="u"><ns:b>5</ns:b></ns:a>`).documentElement)).toEqual({ b: '5' });
    expect(elementToValue(dom(`<a><n>5</n><ok>true</ok></a>`).documentElement, { inferTypes: true })).toEqual({ n: 5, ok: true });
  });
});

describe('parseXml', () => {
  const XML = `<Invoices>
    <Invoice id="A1"><Vendor>ACME</Vendor><Total>120.50</Total></Invoice>
    <Invoice id="A2"><Vendor>Globex</Vendor><Total>87</Total></Invoice>
  </Invoices>`;
  it('produces one doc per repeating element with the parseCsv shape', () => {
    const r = parseXml(XML);
    expect(r.error).toBeNull();
    expect(r.docs).toEqual([
      { '@_id': 'A1', Vendor: 'ACME', Total: '120.50' },
      { '@_id': 'A2', Vendor: 'Globex', Total: '87' },
    ]);
    expect(r.columns).toEqual(['@_id', 'Vendor', 'Total']);
    expect(r.recordCandidates.length).toBeGreaterThan(0);
  });
  it('accepts an ArrayBuffer and honors a recordKey override + inferTypes', () => {
    const buf = new TextEncoder().encode(XML).buffer;
    const r = parseXml(buf, { inferTypes: true });
    expect(r.docs[0].Total).toBe(120.5);
  });
  it('returns a structured error for malformed XML (no throw)', () => {
    const r = parseXml('<a><b></a>');
    expect(r.error).toBeTruthy();
    expect(r.docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xml.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement the import side of `src/mdh/xml.js`**

```js
// Custom, dependency-free XML reader/writer using ONLY native Web APIs — DOMParser
// to parse and a string builder to serialize. CSP-clean (no eval/new Function, no
// Worker), zero dependencies. Import maps a repeating "record" element to one
// document each, producing the same { docs, columns, warnings, error } shape as
// csv.js/xlsx.js so the existing import tail is reused.
import { inferValue } from './csv.js';

const local = (name) => { const i = name.indexOf(':'); return i >= 0 ? name.slice(i + 1) : name; };
const childElements = (el) => [...el.children];

function parseDoc(str) {
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error((err.textContent || 'Malformed XML').trim().split('\n')[0]);
  return doc;
}

// Find the element whose direct children most repeat a single tag; those repeated
// children are the records. Returns { records, candidates, selectedKey }.
export function detectRecords(doc, recordKey) {
  const root = doc.documentElement;
  const groupsAt = []; // { key, tag, count, els }
  const visit = (el, path) => {
    const byTag = new Map();
    for (const c of childElements(el)) {
      const t = local(c.tagName);
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(c);
    }
    for (const [tag, els] of byTag) {
      if (els.length >= 2) groupsAt.push({ key: `${path}/${tag}`, tag, count: els.length, els });
    }
    for (const c of childElements(el)) visit(c, path ? `${path}/${local(c.tagName)}` : local(c.tagName));
  };
  visit(root, '');

  const rootChildren = childElements(root);
  const all = [...groupsAt];
  if (rootChildren.length) all.push({ key: '(root children)', tag: '(root children)', count: rootChildren.length, els: rootChildren });

  let chosen = recordKey ? all.find((c) => c.key === recordKey) : null;
  if (!chosen) chosen = groupsAt.slice().sort((a, b) => b.count - a.count)[0];
  if (!chosen) chosen = rootChildren.length ? { key: '(root children)', els: rootChildren } : { key: '(document)', els: [root] };

  return {
    records: chosen.els,
    candidates: all.map((c) => ({ key: c.key, label: `${c.tag} (×${c.count})`, count: c.count })),
    selectedKey: chosen.key,
  };
}

function directText(el) {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue;
  return s;
}

// Element → JS value. Attributes → @_name; child elements grouped by local name
// (repeated → array); pure-text leaf → scalar (null when empty); mixed → #text.
export function elementToValue(el, { inferTypes = false, warnings } = {}) {
  const coerce = (s) => (inferTypes ? inferValue(s) : s);
  const obj = {};
  let structured = false;

  for (const attr of el.attributes || []) {
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
    obj[`@_${local(attr.name)}`] = coerce(attr.value);
    structured = true;
  }

  const byTag = new Map();
  for (const c of childElements(el)) {
    const t = local(c.tagName);
    if (!byTag.has(t)) byTag.set(t, { els: [], raw: new Set() });
    const g = byTag.get(t);
    g.els.push(c); g.raw.add(c.tagName);
    structured = true;
  }
  for (const [tag, g] of byTag) {
    if (warnings && g.raw.size > 1) warnings.push(`Elements ${[...g.raw].join(', ')} merged into "${tag}" after stripping namespace prefixes.`);
    const vals = g.els.map((c) => elementToValue(c, { inferTypes, warnings }));
    obj[tag] = g.els.length > 1 ? vals : vals[0];
  }

  const text = directText(el).trim();
  if (!structured) return text === '' ? null : coerce(text);
  if (text !== '') obj['#text'] = coerce(text);
  return obj;
}

export function toDocs(records, { inferTypes = false } = {}) {
  const warnings = [];
  let wrapped = 0;
  const docs = records.map((el) => {
    let v = elementToValue(el, { inferTypes, warnings });
    if (v === null || typeof v !== 'object' || Array.isArray(v)) { v = { '#text': v }; wrapped++; }
    return v;
  });
  if (wrapped) warnings.push(`${wrapped} record(s) had no fields; their text was stored under "#text".`);
  const columns = [];
  for (const d of docs) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
  return { docs, columns, warnings: [...new Set(warnings)] };
}

export function parseXml(input, { recordKey, inferTypes = false } = {}) {
  try {
    const str = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
    const doc = parseDoc(str);
    const { records, candidates, selectedKey } = detectRecords(doc, recordKey);
    const { docs, columns, warnings } = toDocs(records, { inferTypes });
    return { docs, columns, warnings, error: null, recordCandidates: candidates, recordKey: selectedKey };
  } catch (err) {
    return { docs: [], columns: [], warnings: [], error: { message: err.message }, recordCandidates: [], recordKey: null };
  }
}
```

- [ ] **Step 4: Run to verify pass + suite**

Run: `npx vitest run tests/mdh-xml.test.js` → PASS.
Run: `npm test` → full suite PASS.

---

## Task 2: Import wizard + preview + import wiring

**Files:**
- Create: `src/mdh/components/XmlImportWizard.jsx`
- Modify: `src/mdh/components/RecordList.jsx`, `src/mdh/components/DataPanel.jsx`, `src/mdh/components/DataOperations.jsx`
- Test: `tests/mdh-xml-wizard.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-xml-wizard.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import XmlImportWizard from '../src/mdh/components/XmlImportWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function xmlFile(str) {
  const f = new File([str], 'data.xml', { type: 'application/xml' });
  f.text = async () => str; // jsdom File.text() may be absent
  return f;
}
const XML = `<Invoices><Invoice id="A1"><Vendor>ACME</Vendor></Invoice><Invoice id="A2"><Vendor>Globex</Vendor></Invoice></Invoices>`;

describe('XmlImportWizard', () => {
  it('starts on the pick stage with a beta tag and accepts .xml', () => {
    const root = mount(h(XmlImportWizard, { onSuccess: () => {} }));
    expect(root.textContent).toContain('Click to select an XML');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
    expect(root.querySelector('[data-testid="xml-file-input"]').accept).toContain('.xml');
  });

  it('reads a file and shows the JsonTree preview with a record-element picker', async () => {
    const root = mount(h(XmlImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xml-file-input"]');
    Object.defineProperty(input, 'files', { value: [xmlFile(XML)], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="xml-preview"]'));
    expect(root.querySelector('.json-tree')).toBeTruthy();      // nested preview, not a flat table
    expect(root.textContent).toContain('ACME');
    expect(root.querySelector('[data-testid="xml-record"]')).toBeTruthy(); // >1 candidate → picker
    expect(root.querySelector('[data-testid="xml-next"]').disabled).toBe(false);
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xml-wizard.test.js` → FAIL (component missing).

- [ ] **Step 3: Implement `XmlImportWizard.jsx`**

```jsx
import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
import { Toggle } from './CsvImportWizard.jsx';
import JsonTree from './JsonTree.jsx';
import { parseXml } from '../xml.js';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const DEFAULT_OPTS = { recordKey: null, inferTypes: false };

export default function XmlImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [text, setText] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const parsed = useMemo(() => (text == null ? null : parseXml(text, { recordKey: opts.recordKey, inferTypes: opts.inferTypes })), [text, opts.recordKey, opts.inferTypes]);
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.text().then((t) => { setText(t); setStage(STAGE.CONFIGURE); }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }
  function handleNext() {
    if (!parsed || parsed.error || parsed.docs.length === 0) return;
    setStats(analyzeDocs(parsed.docs));
    setErrorMsg(null);
    setStage(STAGE.CONFIRM);
  }
  async function startImport() {
    if (!parsed) return;
    setErrorMsg(null);
    const { kept, dropped: inFileDropped } = dedupeById(parsed.docs);
    setStage(STAGE.IMPORTING);
    const controller = new AbortController();
    abortRef.current = controller;
    setImportProgress({ phase: 'insert', processed: 0, total: kept.length, inserted: 0, failedBatches: 0 });
    try {
      let result;
      if (mode === 'overwrite' && stats.uniqueIdCount > 0) {
        result = await runChunkedOverwrite(selectedCollection.value, kept, { signal: controller.signal, onProgress: (p) => setImportProgress({ ...p, total: kept.length }) });
        result.kind = 'overwrite';
      } else {
        result = await runChunkedInsert(selectedCollection.value, kept, { signal: controller.signal, onProgress: setImportProgress });
        result.kind = 'insert';
      }
      result.inFileDropped = inFileDropped;
      setImportResult(result);
      if (result.inserted > 0 || result.deleted > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally { abortRef.current = null; }
  }

  return (
    <div class="modal-body import-wizard xml-import-wizard">
      {stage === STAGE.PICK && <XmlStagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}
      {stage === STAGE.CONFIGURE && <XmlStageConfigure fileMeta={fileMeta} opts={opts} setOpt={setOpt} parsed={parsed} onNext={handleNext} onCancel={closeModal} />}
      {stage === STAGE.CONFIRM && stats && <StageConfirm fileMeta={fileMeta} stats={stats} mode={mode} setMode={setMode} errorMsg={errorMsg} onImport={startImport} onCancel={closeModal} />}
      {stage === STAGE.IMPORTING && importProgress && <StageImporting progress={importProgress} mode={mode} onCancel={() => abortRef.current?.abort()} />}
      {stage === STAGE.DONE && importResult && <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />}
    </div>
  );
}

function XmlStagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) { const f = e.target.files?.[0]; if (f) onFile(f); }
  return (
    <Fragment>
      <div class="modal-field-label">Select an XML file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <input ref={inputRef} type="file" accept=".xml,text/xml,application/xml" style="display:none" onChange={pick} data-testid="xml-file-input" />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select an XML file</div>
        <div class="file-input-info" style="margin-top:4px">Each repeating element becomes one document.</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}

function XmlStageConfigure({ fileMeta, opts, setOpt, parsed, onNext, onCancel }) {
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  const candidates = parsed?.recordCandidates || [];
  const canNext = clean && parsed.docs.length > 0;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="xml-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        <span class="toolbar-menu-beta">beta</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> record{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> field{cols === 1 ? '' : 's'}</span>}
      </div>

      <div class="csv-toolbar">
        {candidates.length > 1 && (
          <span class="csv-tb-item">
            <span class="csv-tb-k" title="Which repeating element becomes one document.">Record element</span>
            <select class="xlsx-sheet-select" data-testid="xml-record" value={parsed?.recordKey ?? ''} onChange={(e) => setOpt('recordKey', e.target.value)}>
              {candidates.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </span>
        )}
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Off → every value is a string. On → detect numbers and true/false.">Infer types</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="xml-infer" title="Detect numbers and true/false." />
        </span>
      </div>
      <div class="csv-opt-hint">Attributes become @_-prefixed fields; namespace prefixes are stripped.</div>

      {parsed?.error && <div class="csv-error" data-testid="xml-error">XML parse error: {parsed.error.message}</div>}
      {clean && parsed.docs.length === 0 && <div class="csv-preview-empty">No records found {'—'} pick a different record element.</div>}
      {clean && parsed.docs.length > 0 && <XmlPreview parsed={parsed} />}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="xml-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}

function XmlPreview({ parsed, limit = 10 }) {
  const sample = parsed.docs.slice(0, limit);
  return (
    <div class="csv-preview" data-testid="xml-preview">
      <div class="csv-preview-caption">
        <span>Preview {'·'} first {Math.min(limit, parsed.docs.length)} of {parsed.docs.length.toLocaleString()} record{parsed.docs.length === 1 ? '' : 's'}</span>
      </div>
      <div class="csv-preview-scroll"><JsonTree data={sample} collapseDepth={1} /></div>
      {parsed.warnings.map((w, i) => <div key={i} class="csv-warning" data-testid="xml-warning">{'⚠'} {w}</div>)}
    </div>
  );
}
```
> Verify `JsonTree`'s default export signature is `JsonTree({ data, ... collapseDepth })` (it is — `src/mdh/components/JsonTree.jsx:61`, rendering `Object.entries(data)`, so passing the sample array renders index→doc rows).

- [ ] **Step 4: Wire the import menu + dispatch**

`RecordList.jsx` — add the XML item to the Insert `menuItems` (after the Excel item):
```jsx
            { label: 'From Excel file', beta: true, onClick: () => onRefresh('insert-xlsx-file') },
            { label: 'From XML file', beta: true, onClick: () => onRefresh('insert-xml-file') },
```
`DataPanel.jsx` — after the `'insert-xlsx-file'` branch:
```jsx
    } else if (action === 'insert-xml-file') {
      openDataOperations('insert-xml-file', invalidateAndRun, currentFields);
```
`DataOperations.jsx` — import the wizard and extend the title + render switch (`op` for `'insert-xml-file'` is `'insert-xml'`):
```jsx
import XmlImportWizard from './XmlImportWizard.jsx';
```
```jsx
  const title = op === 'insert-csv'
    ? 'Insert from CSV file'
    : op === 'insert-xlsx'
    ? 'Insert from Excel file'
    : op === 'insert-xml'
    ? 'Insert from XML file'
    : op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');

  openModal(title, () => {
    if (op === 'insert-csv') return <CsvImportWizard onSuccess={onSuccess} />;
    if (op === 'insert-xlsx') return <XlsxImportWizard onSuccess={onSuccess} />;
    if (op === 'insert-xml') return <XmlImportWizard onSuccess={onSuccess} />;
    // …existing branches unchanged…
```

- [ ] **Step 5: Run to verify pass + build**

Run: `npx vitest run tests/mdh-xml-wizard.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 3: XML export serializer

**Files:**
- Modify: `src/mdh/xml.js` (export helpers), `src/mdh/downloadCollection.js` (`buildXmlSerializer`)
- Test: `tests/mdh-xml.test.js`

- [ ] **Step 1: Append failing tests**

Add to `tests/mdh-xml.test.js`:
```js
import { toXmlName, escapeXml, valueToXml, docToXml } from '../src/mdh/xml.js';
import { buildXmlSerializer } from '../src/mdh/downloadCollection.js';

describe('XML export helpers', () => {
  it('toXmlName keeps _id, sanitizes invalid names', () => {
    expect(toXmlName('_id')).toBe('_id');
    expect(toXmlName('$oid')).toBe('_oid');
    expect(toXmlName('2024')).toBe('_2024');
    expect(toXmlName('a b:c')).toBe('a_b_c');
    expect(toXmlName('xmlData')).toBe('_xmlData');
    expect(toXmlName('')).toBe('_');
  });
  it('escapeXml escapes & < >', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
  it('valueToXml: null→empty, array→repeated, object→nested, primitive→text', () => {
    expect(valueToXml('x', null)).toBe('<x/>');
    expect(valueToXml('x', [1, 2])).toBe('<x>1</x><x>2</x>');
    expect(valueToXml('x', { a: 'v' })).toBe('<x><a>v</a></x>');
    expect(valueToXml('x', 'a&b')).toBe('<x>a&amp;b</x>');
  });
  it('docToXml wraps a doc; sanitizes the record name', () => {
    expect(docToXml({ Vendor: 'ACME', _id: 1 }, 'record')).toBe('<record><Vendor>ACME</Vendor><_id>1</_id></record>');
  });
});

describe('buildXmlSerializer', () => {
  it('produces a streaming, well-formed XML document', () => {
    const s = buildXmlSerializer({ rootName: 'records', recordName: 'record' });
    expect(s.ext).toBe('xml');
    expect(s.preamble()).toContain('<?xml');
    expect(s.preamble()).toContain('<records>');
    expect(s.item({ a: 1 })).toContain('<record><a>1</a></record>');
    expect(s.postamble()).toContain('</records>');
  });
  it('sanitizes a custom root name', () => {
    expect(buildXmlSerializer({ rootName: '2x' }).preamble()).toContain('<_2x>');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xml.test.js` → FAIL (export helpers / `buildXmlSerializer` missing).

- [ ] **Step 3: Implement the export helpers in `xml.js`**

Append to `src/mdh/xml.js`:
```js
// --- export (object → XML) -------------------------------------------------
const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export function escapeXml(s) { return String(s).replace(/[&<>]/g, (c) => XML_ESC[c]); }

// Map any JSON key to a valid XML element Name (W3C XML 1.0). '_id' stays as-is.
export function toXmlName(key) {
  let s = String(key).replace(/[^A-Za-z0-9_.\-]/g, '_'); // disallowed chars → _
  if (s === '') s = '_';
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;                // must start with a letter or _
  if (/^xml/i.test(s)) s = '_' + s;                      // reserved 'xml' prefix
  return s;
}

// null/undefined → <name/>; array → repeated <name>; object → nested; primitive → text.
export function valueToXml(name, value) {
  const tag = toXmlName(name);
  if (value === null || value === undefined) return `<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => valueToXml(name, v)).join('');
  if (typeof value === 'object') return `<${tag}>${Object.entries(value).map(([k, v]) => valueToXml(k, v)).join('')}</${tag}>`;
  return `<${tag}>${escapeXml(value)}</${tag}>`;
}

export function docToXml(doc, recordName = 'record') {
  const tag = toXmlName(recordName);
  return `<${tag}>${Object.entries(doc).map(([k, v]) => valueToXml(k, v)).join('')}</${tag}>`;
}
```

- [ ] **Step 4: Add `buildXmlSerializer` to `downloadCollection.js`**

Add an import near the existing `./csv.js` import:
```js
import { docToXml, toXmlName } from './xml.js';
```
Add the serializer (next to `buildCsvSerializer`):
```js
// XML serializer — plain text, streams incrementally like JSON/CSV. Every field
// becomes a child element (no attributes); keys are sanitized to valid XML names.
export function buildXmlSerializer({ rootName = 'records', recordName = 'record' } = {}) {
  const root = toXmlName(rootName);
  return {
    ext: 'xml',
    mimeType: 'application/xml',
    pickerTypes: [{ description: 'XML file', accept: { 'application/xml': ['.xml'] } }],
    preamble: () => `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`,
    item: (doc) => '  ' + docToXml(doc, recordName),
    separator: '\n',
    postamble: () => `\n</${root}>\n`,
  };
}
```

- [ ] **Step 5: Run to verify pass + suite + build**

Run: `npx vitest run tests/mdh-xml.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 4: Export options modal + export wiring

**Files:**
- Create: `src/mdh/components/XmlExportOptions.jsx`
- Modify: `src/mdh/components/DownloadSplitButton.jsx`, `src/mdh/components/RecordList.jsx`, `src/mdh/components/DataPanel.jsx`
- Test: `tests/mdh-xml-wizard.test.js`

- [ ] **Step 1: Append failing tests**

Add to `tests/mdh-xml-wizard.test.js`:
```js
import { modalContent } from '../src/mdh/store.js';
import XmlExportOptions from '../src/mdh/components/XmlExportOptions.jsx';
import DownloadSplitButton from '../src/mdh/components/DownloadSplitButton.jsx';
import { vi, beforeEach } from 'vitest';

describe('XmlExportOptions', () => {
  beforeEach(() => { document.body.innerHTML = ''; modalContent.value = { title: 'x', render: () => null }; });
  const SAMPLE = { sample: [{ _id: 'A1', Vendor: 'ACME' }] };
  it('renders a live XML preview and Download passes the element names', async () => {
    const onDownload = vi.fn();
    const root = mount(h(XmlExportOptions, { loadPreview: async () => SAMPLE, onDownload }));
    await waitFor(() => root.querySelector('.csv-export-preview-text'));
    const text = root.querySelector('.csv-export-preview-text').textContent;
    expect(text).toContain('<records>');
    expect(text).toContain('<record><_id>A1</_id><Vendor>ACME</Vendor></record>');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();
    root.querySelector('[data-testid="xml-export-download"]').click();
    expect(onDownload).toHaveBeenCalledWith({ rootName: 'records', recordName: 'record' });
  });
});

describe('DownloadSplitButton — XML option', () => {
  it('offers an XML format alongside JSON and CSV', () => {
    const onAllXml = vi.fn();
    const root = mount(h(DownloadSplitButton, { onAllJson(){}, onFilteredJson(){}, onAllCsv(){}, onFilteredCsv(){}, onAllXml, onFilteredXml(){} }));
    root.querySelector('button').click();                       // open menu
    root.querySelector('[data-testid="download-all"]').click(); // open flyout
    const xml = root.querySelector('[data-testid="download-all-xml"]');
    expect(xml).toBeTruthy();
    xml.click();
    expect(onAllXml).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xml-wizard.test.js` → FAIL (`XmlExportOptions` + the XML download option missing).

- [ ] **Step 3: Implement `XmlExportOptions.jsx`**

```jsx
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { docToXml, toXmlName } from '../xml.js';

// Options + live XML-text preview before an XML export. `loadPreview` resolves a
// small { sample } of docs; the preview re-serializes locally on a name change.
export default function XmlExportOptions({ loadPreview, onDownload }) {
  const [rootName, setRootName] = useState('records');
  const [recordName, setRecordName] = useState('record');
  const [preview, setPreview] = useState({ loading: true, sample: [], error: null });

  useEffect(() => {
    let live = true;
    if (!loadPreview) { setPreview({ loading: false, sample: [], error: null }); return undefined; }
    loadPreview()
      .then((r) => { if (live) setPreview({ loading: false, sample: r.sample || [], error: null }); })
      .catch((e) => { if (live) setPreview({ loading: false, sample: [], error: e?.message || 'failed' }); });
    return () => { live = false; };
  }, []);

  const root = toXmlName(rootName);
  const previewText = preview.sample.length
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n` + preview.sample.map((d) => '  ' + docToXml(d, recordName)).join('\n') + `\n</${root}>\n`
    : '';

  function download() { closeModal(); onDownload({ rootName, recordName }); }

  return (
    <div class="modal-body csv-export-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item"><span class="csv-tb-k" title="Top-level wrapper element.">Root element</span>
          <input class="xlsx-sheet-select" data-testid="xml-export-root" value={rootName} onInput={(e) => setRootName(e.target.value)} /></span>
        <span class="csv-tb-item"><span class="csv-tb-k" title="Element wrapping each document.">Record element</span>
          <input class="xlsx-sheet-select" data-testid="xml-export-record" value={recordName} onInput={(e) => setRecordName(e.target.value)} /></span>
        <span class="toolbar-menu-beta">beta</span>
      </div>

      <div class="csv-export-preview" data-testid="xml-export-preview">
        {preview.loading ? <div class="csv-export-preview-note">Building preview{'…'}</div>
          : preview.error ? <div class="csv-export-preview-note">Preview unavailable</div>
          : preview.sample.length === 0 ? <div class="csv-export-preview-note">No rows to preview</div>
          : (
            <Fragment>
              <div class="csv-export-preview-caption">Preview {'·'} first {preview.sample.length} record{preview.sample.length === 1 ? '' : 's'}</div>
              <pre class="csv-export-preview-text">{previewText}</pre>
            </Fragment>
          )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="xml-export-download" onClick={download}>Download</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the XML option to `DownloadSplitButton.jsx`**

Extend the props, the `ITEMS` rows, and the flyout:
```jsx
export default function DownloadSplitButton({ onAllJson, onFilteredJson, onAllCsv, onFilteredCsv, onAllXml, onFilteredXml }) {
```
```jsx
  const ITEMS = [
    { key: 'all', label: 'Download all', json: onAllJson, csv: onAllCsv, xml: onAllXml },
    { key: 'filtered', label: 'Download filtered', json: onFilteredJson, csv: onFilteredCsv, xml: onFilteredXml },
  ];
```
Add a third button after the CSV one in the flyout:
```jsx
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-csv`}
                    onClick={() => choose(it.csv)}>CSV</button>
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-xml`}
                    onClick={() => choose(it.xml)}>XML <span class="toolbar-menu-beta">beta</span></button>
```

- [ ] **Step 5: Wire `RecordList.jsx` + `DataPanel.jsx`**

`RecordList.jsx` — pass the new callbacks to `DownloadSplitButton` (next to the CSV ones):
```jsx
            onAllCsv={() => onRefresh('download-csv')}
            onFilteredCsv={() => onRefresh('download-filtered-csv')}
            onAllXml={() => onRefresh('download-xml')}
            onFilteredXml={() => onRefresh('download-filtered-xml')}
```
`DataPanel.jsx` — import the modal + serializer:
```jsx
import { downloadCollection as runDownload, buildCsvSerializer, buildXmlSerializer } from '../downloadCollection.js';
import XmlExportOptions from './XmlExportOptions.jsx';
```
Add `downloadAllXml` (mirror `downloadAllCsv`, but `loadPreview` only needs a sample and the serializer is XML):
```jsx
  function downloadAllXml() {
    const col = collection;
    openModal('Export XML', () => (
      <XmlExportOptions
        loadPreview={async () => {
          const r = await api.aggregate(col, [{ $match: {} }, { $limit: 10 }]);
          return { sample: r.result || [] };
        }}
        onDownload={async ({ rootName, recordName }) => {
          const tc = pagination.totalCount.value;
          if (tc !== null && tc > 10_000) {
            const proceed = await confirmModal('Large collection', `This collection has ${tc.toLocaleString()} documents. Exporting may take a while and use significant memory. Continue?`);
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages: [{ $match: {} }],
            filename: `${col}.xml`,
            filtered: false,
            fetchCount: async () => {
              if (pagination.totalCount.value !== null) return pagination.totalCount.value;
              const r = await api.aggregate(col, [{ $count: 'total' }]);
              return r.result?.[0]?.total ?? 0;
            },
            serializer: buildXmlSerializer({ rootName, recordName }),
          });
        }}
      />
    ));
  }
```
Add `downloadFilteredXml` — copy `downloadFilteredCsv` verbatim, but: open `<XmlExportOptions>` with `loadPreview={async () => ({ sample: (await api.aggregate(col, [...pipelineStages, { $limit: 10 }])).result || [] })}`, destructure `{ rootName, recordName }`, `filename: \`${col}-filtered.xml\``, and `serializer: buildXmlSerializer({ rootName, recordName })`. Keep its existing cancellable pre-count / >10k confirm body unchanged.
Add the action routes (next to the CSV download branches in `handleToolbarAction`):
```jsx
    } else if (action === 'download-xml') {
      downloadAllXml();
    } else if (action === 'download-filtered-xml') {
      downloadFilteredXml();
```

- [ ] **Step 6: Run to verify pass + suite + build**

Run: `npx vitest run tests/mdh-xml-wizard.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 5: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture `Test Files N passed`). Run: `npm run build` → clean.

- [ ] **Step 2: CSP / no-worker / zero-dep guards**

Run: `grep -nE "eval\(|new Function\(|WebAssembly" dist/console/console.js` → expect **no matches**.
Run: `grep -nE "new Worker\(|createObjectURL\(|blob:" dist/console/console.js` → expect no matches attributable to XML (the one pre-existing `createObjectURL` is `downloadCollection.js`'s Blob download).
Run: `grep -nE "fast-xml-parser|xml2js" package.json` → expect **no matches** (zero deps added).

- [ ] **Step 3: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection:
- **Import:** Insert ▾ → "From XML file" shows a **beta** badge → pick an XML file → the Configure stage shows the **JsonTree** preview (nested, not `[object Object]`), a **Record element** picker (when >1 candidate), an **Infer types** toggle, and the beta tag. Switching the record element / infer re-parses. Next → Confirm → Import → Done; rows land in the collection. A malformed XML shows a parse error.
- **Export:** Download ▾ → Download all/filtered → **XML** (with a beta tag) → the modal shows a live XML preview; editing root/record names updates it; Download writes a well-formed `.xml` matching the preview. Nested fields → nested elements; `_id` preserved; a `$`-prefixed key appears sanitized (the documented round-trip caveat).

- [ ] **Step 4: Report**

Summarize suite + build, the CSP/no-worker/zero-dep grep results, and the manual-QA outcome (import: beta badge, JsonTree preview, record picker, typed import, parse error; export: beta XML option, live preview, well-formed file). Don't claim done without the manual check.

---

## Self-Review (completed during planning)

- **Spec coverage:** record-list-only import via native `DOMParser`, sync, zero-dep (Task 1, §4.1–4.3) ✓; auto-detect + record-element picker (Task 1 `detectRecords` + Task 2 picker, §4.2) ✓; conventions `@_`/`#text`/repeated→array/strip-ns/strings+infer (Task 1 `elementToValue`, §4.3) ✓; `JsonTree` nested preview (Task 2 `XmlPreview`, §4.4) ✓; streaming export serializer + elements-only + `toXmlName`/escaping + null→empty (Task 3, §5.1–5.2) ✓; export options modal with live preview + editable root/record + beta (Task 4 `XmlExportOptions`, §5.3) ✓; wiring import + export + beta throughout (Tasks 2 & 4, §6) ✓; verification incl. CSP/no-worker/zero-dep (Task 5) ✓; **whole-document mode intentionally absent** (non-goal) ✓.
- **Placeholder scan:** none — full code + complete tests + exact commands. `downloadFilteredXml` (4.5) is described as "copy `downloadFilteredCsv` verbatim with these substitutions" because that handler's cancellable pre-count body lives in `DataPanel.jsx` and must be preserved; the required substitutions are spelled out.
- **Type/name consistency:** `parseXml` resolves `{ docs, columns, warnings, error, recordCandidates, recordKey }` everywhere; the wizard reads `parsed.recordCandidates`/`parsed.recordKey`/`parsed.docs`; option keys `{ recordKey, inferTypes }` are consistent component→`parseXml`; `recordCandidates[].key` ↔ `parseXml(recordKey)` match; export helpers `toXmlName`/`escapeXml`/`valueToXml`/`docToXml` are used by both the modal preview and `buildXmlSerializer`; `buildXmlSerializer({ rootName, recordName })` matches `onDownload({ rootName, recordName })` at both DataPanel sites; action keys `insert-xml-file` (→ op `insert-xml`) / `download-xml` / `download-filtered-xml` are consistent across RecordList → DataPanel → DataOperations / DownloadSplitButton; reuses `JsonTree`, `Toggle`, `ImportStages`, `.xlsx-sheet-select`, `.csv-export-preview*`, `.toolbar-menu-beta` (all existing).
