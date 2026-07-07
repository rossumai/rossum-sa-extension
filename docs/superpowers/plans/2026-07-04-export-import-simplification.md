# Export/Import Wizard Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** executed as written (7 tasks). A follow-up refinement pass (2026-07-07) then moved the source strip into the modal title, made the parsing options inline-by-default (removing the summary + `Change ▾` toggle and the `summarizeOpts` helper this plan added), turned the shape override into an in-card checkbox that keeps the error visible, and capped the tabular preview at 5 rows. The **spec's changelog** is the source of truth for the final delivered design; where this plan and the spec differ, the spec wins.

**Goal:** De-noise the MDH export/import wizards: one summary sentence + collapsed Details expander replaces the "What will happen" blocks, the import Configure step merges into one Decide screen, and the shape check goes silent-pass/loud-fail — with zero semantic/engine/storage changes.

**Architecture:** A new shared `PlanSummary` presentational component wraps the existing verified bullet lists behind a `Details ▾` toggle. `ImportWizard` drops its CONFIGURE stage (`PICK → DECIDE → IMPORTING → DONE`); format descriptors gain a pure `summarizeOpts()` used by a new parsing strip on the Decide screen. `ImportConfirm` becomes the Decide screen's decision zone (mode/keys/summary/shape/actions); shape-check UI is rebuilt as silent-pass/loud-fail with an in-card "Import anyway" override.

**Tech Stack:** Preact + @preact/signals, esbuild, Vitest (jsdom), plain CSS (`src/console/console.css`).

**Spec:** `docs/superpowers/specs/2026-07-04-export-import-simplification-design.md`

## Global Constraints

- **NO git commits during the run** (owner rule, overrides this skill's commit steps — work stays uncommitted on `master`; the owner commits). Every task ends with a green test run instead of a commit.
- Tests are `.test.js` files rendering via `h(Component, props)` — **no raw JSX in test files** (breaks oxc). Use condition-based `waitFor` polling, never fixed `setTimeout` flushes.
- In JSX raw text, `\uXXXX` escapes DO NOT work — wrap in a JS expression: `{'—'}`. Inside plain JS strings they work normally.
- **Engine untouched:** `downloadCollection.js`, `runChunkedInsert`, `api.datasetUpdate/datasetReplace/waitForDatasetOperation`, `buildExportJob` call shapes stay byte-identical.
- **Zero storage changes:** no chrome.storage/sessionStorage keys added, removed, or renamed.
- Summary-sentence copy must match the spec **verbatim** (it encodes verified semantics). The Details bullets are the existing "What will happen" bullets moved, not rewritten.
- No customer names or customer data in fixtures/copy — placeholder values only (`customers.csv`, `sku`, `vendors`).
- Focused test runs: `npx vitest run tests/<file>`. Full suite: `npm test`. Final gate: `npm run build && npm test` (the loaded extension runs `dist/`, so remind the owner to reload the extension).

---

### Task 1: `PlanSummary` shared component

**Files:**
- Create: `src/mdh/components/PlanSummary.jsx`
- Test: `tests/mdh-plan-summary.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: default export `PlanSummary({ summary, summaryTestid, children })` — `summary` is a string or vnode rendered as the always-visible sentence (testid `summaryTestid`); `children` (the caller's `<ul>` of verified bullets) render inside a `.import-steps` div only while expanded; the toggle button gets testid `` `${summaryTestid}-toggle` ``. Collapsed on every mount; no persistence.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import PlanSummary from '../src/mdh/components/PlanSummary.jsx';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
function waitFor(fn, { timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let v; try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 10);
    })();
  });
}

describe('PlanSummary', () => {
  it('shows the summary sentence and hides details by default', () => {
    const root = mount(h(PlanSummary, { summary: 'Adds 3 new records.', summaryTestid: 'sum' },
      h('ul', null, h('li', null, 'bullet one'))));
    expect(root.querySelector('[data-testid="sum"]').textContent).toBe('Adds 3 new records.');
    expect(root.textContent).not.toContain('bullet one');
    const toggle = root.querySelector('[data-testid="sum-toggle"]');
    expect(toggle.textContent).toContain('Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands and collapses the bullets via the toggle', async () => {
    const root = mount(h(PlanSummary, { summary: 's', summaryTestid: 'sum' },
      h('ul', { 'data-testid': 'bullets' }, h('li', null, 'bullet one'))));
    root.querySelector('[data-testid="sum-toggle"]').click();
    await waitFor(() => root.querySelector('[data-testid="bullets"]'));
    expect(root.textContent).toContain('bullet one');
    expect(root.querySelector('[data-testid="sum-toggle"]').textContent).toContain('Hide');
    root.querySelector('[data-testid="sum-toggle"]').click();
    await waitFor(() => !root.querySelector('[data-testid="bullets"]'));
  });

  it('renders no toggle when there are no children', () => {
    const root = mount(h(PlanSummary, { summary: 'just a sentence', summaryTestid: 'sum' }));
    expect(root.querySelector('[data-testid="sum-toggle"]')).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-plan-summary.test.js`
Expected: FAIL — cannot resolve `../src/mdh/components/PlanSummary.jsx`.

- [ ] **Step 3: Write the implementation**

`src/mdh/components/PlanSummary.jsx`:

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';

// One-sentence outcome+risk summary with a collapsed "Details" expander that
// holds the full verified bullet list (the caller passes the <ul>). Replaces
// the always-visible "What will happen" blocks in the import/export wizards.
// Collapsed on every mount; expansion is never persisted.
export default function PlanSummary({ summary, summaryTestid, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="plan-summary">
      <div class="plan-summary-line">
        <span class="plan-summary-text" data-testid={summaryTestid}>{summary}</span>
        {children && (
          <button
            type="button"
            class="plan-summary-toggle"
            aria-expanded={open}
            data-testid={summaryTestid ? `${summaryTestid}-toggle` : undefined}
            onClick={() => setOpen(!open)}
          >{open ? 'Hide ▴' : 'Details ▾'}</button>
        )}
      </div>
      {open && <div class="import-steps">{children}</div>}
    </div>
  );
}
```

Note: `children` is falsy when the caller passes none — Preact passes `undefined`. An empty-array edge (`children={[]}`) does not occur in our two call sites.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-plan-summary.test.js`
Expected: 3 passed.

---

### Task 2: `summarizeOpts` on the CSV/Excel/XML format descriptors

**Files:**
- Modify: `src/mdh/formats/csv.jsx` (add function + export in default object)
- Modify: `src/mdh/formats/xlsx.jsx` (same)
- Modify: `src/mdh/formats/xml.jsx` (same)
- Test: `tests/mdh-format-summaries.test.js`

**Interfaces:**
- Consumes: each descriptor's existing `defaultOpts` shapes (csv: `{delimiter, hasHeader, inferTypes, encoding, emptyMode, trim, …}`; xlsx: `{sheet, hasHeader, emptyMode, trim}`; xml: `{recordKey, inferTypes}`) and `parsed` extras (`parsed.sheets` for xlsx, `parsed.recordCandidates`/`parsed.recordKey` for xml).
- Produces: `descriptor.summarizeOpts(opts, parsed) → string` — the one-line parsing-strip summary. JSON/JSONL descriptors deliberately do NOT get one (no ConfigureControls → no strip).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import csv from '../src/mdh/formats/csv.jsx';
import xlsx from '../src/mdh/formats/xlsx.jsx';
import xml from '../src/mdh/formats/xml.jsx';

describe('format summarizeOpts', () => {
  it('csv: defaults read comma / header row / text-only', () => {
    expect(csv.summarizeOpts(csv.defaultOpts, null)).toBe('comma · header row · text-only');
  });

  it('csv: non-default advanced opts are appended', () => {
    const opts = { ...csv.defaultOpts, delimiter: ';', hasHeader: false, inferTypes: true, encoding: 'windows-1252', emptyMode: 'null', trim: true };
    expect(csv.summarizeOpts(opts, null)).toBe('semicolon · no header · types inferred · windows-1252 · empty → null · trimmed');
  });

  it('xlsx: single-sheet default omits the sheet name', () => {
    expect(xlsx.summarizeOpts(xlsx.defaultOpts, { sheets: ['Sheet1'] })).toBe('header row · empty → null');
  });

  it('xlsx: multi-sheet shows the active sheet (opts.sheet ?? first)', () => {
    expect(xlsx.summarizeOpts(xlsx.defaultOpts, { sheets: ['Data', 'Other'] })).toBe('Data · header row · empty → null');
    expect(xlsx.summarizeOpts({ ...xlsx.defaultOpts, sheet: 'Other', trim: true }, { sheets: ['Data', 'Other'] }))
      .toBe('Other · header row · empty → null · trimmed');
  });

  it('xml: single record candidate omits the record element', () => {
    expect(xml.summarizeOpts(xml.defaultOpts, { recordCandidates: [{ key: 'item', label: 'item' }], recordKey: 'item' })).toBe('text-only');
  });

  it('xml: multiple candidates show the active record element', () => {
    const parsed = { recordCandidates: [{ key: 'item', label: 'item' }, { key: 'row', label: 'row' }], recordKey: 'item' };
    expect(xml.summarizeOpts({ ...xml.defaultOpts, inferTypes: true }, parsed)).toBe('record: item · types inferred');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-format-summaries.test.js`
Expected: FAIL — `summarizeOpts is not a function`.

- [ ] **Step 3: Implement**

In `src/mdh/formats/csv.jsx`, above the default export add:

```js
const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };
const EMPTY_LABELS = { empty: 'empty → ""', null: 'empty → null', omit: 'empty → omit' };

// One-line summary of the active parsing options for the Decide screen's
// parsing strip. The three primary opts are always stated; advanced opts
// appear only when they differ from the default.
function summarizeOpts(opts) {
  const parts = [
    DELIM_NAMES[opts.delimiter] || JSON.stringify(opts.delimiter),
    opts.hasHeader ? 'header row' : 'no header',
    opts.inferTypes ? 'types inferred' : 'text-only',
  ];
  if (opts.encoding !== 'utf-8') parts.push(opts.encoding);
  if (opts.emptyMode !== 'empty') parts.push(EMPTY_LABELS[opts.emptyMode]);
  if (opts.trim) parts.push('trimmed');
  return parts.join(' · ');
}
```

and change the default export to include it:

```js
export default { id: 'csv', label: 'CSV', accept: '.csv,text/csv', read: 'arrayBuffer', defaultOpts: DEFAULT_OPTS, parse, detectOpts, ConfigureControls, summarizeOpts };
```

In `src/mdh/formats/xlsx.jsx`:

```js
// Parsing-strip summary. Sheet name only when the workbook offers a choice
// (mirrors the ConfigureControls select's visibility).
function summarizeOpts(opts, parsed) {
  const sheets = parsed?.sheets || [];
  const parts = [];
  if (sheets.length > 1) parts.push(opts.sheet ?? sheets[0]);
  parts.push(opts.hasHeader ? 'header row' : 'no header');
  parts.push(`empty → ${opts.emptyMode === 'empty' ? '""' : opts.emptyMode}`);
  if (opts.trim) parts.push('trimmed');
  return parts.join(' · ');
}

export default { id: 'xlsx', label: 'Excel', accept: '.xlsx', read: 'arrayBuffer', defaultOpts, parse, ConfigureControls, summarizeOpts };
```

In `src/mdh/formats/xml.jsx`:

```js
// Parsing-strip summary. Record element only when there was a choice
// (mirrors the ConfigureControls select's visibility).
function summarizeOpts(opts, parsed) {
  const candidates = parsed?.recordCandidates || [];
  const parts = [];
  if (candidates.length > 1 && parsed?.recordKey) parts.push(`record: ${parsed.recordKey}`);
  parts.push(opts.inferTypes ? 'types inferred' : 'text-only');
  return parts.join(' · ');
}

export default { id: 'xml', label: 'XML', accept: '.xml,text/xml,application/xml', read: 'text', defaultOpts, parse, ConfigureControls, summarizeOpts };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-format-summaries.test.js`
Expected: 6 passed.

---

### Task 3: ExportWizard — merge count line + plan block into `PlanSummary`

**Files:**
- Modify: `src/mdh/components/ExportWizard.jsx:174-198` (the `.export-count` div and `.import-steps` block)
- Test: `tests/mdh-export-wizard.test.js` (update assertions)

**Interfaces:**
- Consumes: Task 1's `PlanSummary({ summary, summaryTestid, children })`.
- Produces: testid contract — the sentence keeps `data-testid="export-count"`, the toggle is `export-count-toggle`, the bullets `<ul>` keeps `data-testid="export-plan"` (now only present while expanded). `onExport` config object unchanged.

- [ ] **Step 1: Update the tests first (they encode the new copy)**

In `tests/mdh-export-wizard.test.js`:

1. Everywhere a test asserts on `[data-testid="export-plan"]` (lines ~73, ~81–82, ~116, ~122), first expand the details, e.g. replace:

```js
const steps = await waitFor(() => root.querySelector('[data-testid="export-plan"]'));
```

with:

```js
(await waitFor(() => root.querySelector('[data-testid="export-count-toggle"]'))).click();
const steps = await waitFor(() => root.querySelector('[data-testid="export-plan"]'));
```

(For the test at ~line 81 that switches scope and re-asserts: the expander survives scope switches — one click per mounted wizard is enough; do not click twice in one test unless the wizard was re-mounted.)

2. Update the copy regexes: `/Exports 3 documents to vendors\.json/` → `/Exports 3 records to vendors\.json/`, `/Exports 7 documents/` → `/Exports 7 records/`. Also any assertion matching `streamed to a file you choose` becomes `streamed to the file you pick`.

- [ ] **Step 2: Run to verify the updated tests fail**

Run: `npx vitest run tests/mdh-export-wizard.test.js`
Expected: FAIL — no `export-count-toggle`, copy still says "documents".

- [ ] **Step 3: Implement**

In `src/mdh/components/ExportWizard.jsx`, add the import:

```js
import PlanSummary from './PlanSummary.jsx';
```

Replace the two blocks (the `export-count` div, lines 174–182, and the `import-steps` div, lines 184–198) with:

```jsx
      <PlanSummary
        summaryTestid="export-count"
        summary={
          count.loading ? <span>Counting documents{'…'}</span>
          : count.value !== null ? (
            <span>
              Exports {count.value.toLocaleString()} record{count.value === 1 ? '' : 's'} to <code>{filename}</code> {'—'} streamed to the file you pick; the collection is never modified.
              {isLarge ? <span> Large export {'—'} may take a while.</span> : null}
            </span>
          ) : (
            <span>Exports to <code>{filename}</code> {'—'} streamed to the file you pick; read-only.</span>
          )
        }
      >
        <ul data-testid="export-plan">
          {scope === 'all'
            ? <li>Every record in the collection is exported {'—'} the pipeline editor is ignored.</li>
            : <li>Only records matching the current pipeline are exported; trailing paging stages (<code>$skip</code>/<code>$limit</code>) are removed, so the whole result set is exported {'—'} not just the visible page.</li>}
          <li>Downloads in 1,000-record batches (10 in parallel) and streams to the file you pick; if the browser can{'’'}t stream, the file downloads normally when complete.</li>
          {scope === 'all'
            ? <li>Records are exported in a stable order {'—'} by <code>_id</code>.</li>
            : <li>Records are exported in a stable order {'—'} your filter{'’'}s final sort if it has one, otherwise by <code>_id</code>.</li>}
          {fmt.needsColumns && <li>Columns are the union of fields across the exported records, in table order.</li>}
          <li>Cancelling discards the partial file {'—'} nothing is saved.</li>
          <li>The export is read-only {'—'} the collection is never modified.</li>
        </ul>
      </PlanSummary>
```

The `isLarge` const (line 116) stays. Delete nothing else — Scope/Format/options/preview/actions are untouched. The `Download …` button label is untouched.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mdh-export-wizard.test.js tests/mdh-export-wire.test.js tests/mdh-export-formats.test.js`
Expected: all pass.

---

### Task 4: ImportConfirm — summary sentence + Details expander

**Files:**
- Modify: `src/mdh/components/ImportConfirm.jsx`
- Test: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: Task 1's `PlanSummary`; existing `analyzeDocs` (fields: `total`, `uniqueIdCount`, `withoutId`).
- Produces: testid contract — sentence `import-summary`, toggle `import-summary-toggle`, bullets `<ul>` keeps `import-plan` (present only while expanded). Props: `fileMeta` is REMOVED from the destructured props and the file-meta header block is deleted (the wizard re-adds a source strip in Task 6 — interim builds show no file name on the confirm screen, which is acceptable and temporary). Everything else (mode/keys/shape props, `onImport/onCancel/onBack`, gating, guard, `goLabel`) unchanged in this task.

- [ ] **Step 1: Update tests**

In `tests/mdh-import-confirm.test.js`:

1. Add the `waitFor` helper from Task 1 next to `mount`, and drop `fileMeta` from `base`.
2. Add an async expander helper and use it in every test that reads `[data-testid="import-plan"]` (tests at lines ~13, ~24 (the `withKeys` assertion), ~32, ~43, ~53, ~58):

```js
async function openPlan(root) {
  (await waitFor(() => root.querySelector('[data-testid="import-summary-toggle"]'))).click();
  return waitFor(() => root.querySelector('[data-testid="import-plan"]'));
}
```

e.g. the first test becomes:

```js
it('insert step list explains verified insert behavior and enables Go', async () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
  await openPlan(root);
  const t = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(t).toMatch(/added as a new record/i);
  expect(t).toMatch(/never modified/i);
  expect(t).toMatch(/already exists in the collection is rejected/i);
  expect(t).toMatch(/cancelling keeps the rows already inserted/i);
});
```

Delete the `expect(t).toMatch(/What will happen/i)` assertion (the heading is retired). The no-keys test (~line 53) asserts the sentence instead: `expect(root.querySelector('[data-testid="import-summary"]').textContent).toMatch(/Pick one or more fields above/i);`

3. Add new sentence tests:

```js
it('summary sentence: insert states count and never-modified', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  expect(root.querySelector('[data-testid="import-summary"]').textContent)
    .toBe('Adds 2 new records — existing records are never modified.');
});

it('summary sentence: insert mentions dropped duplicate _id rows only when true', () => {
  const dup = [{ _id: 1, a: 1 }, { _id: 1, a: 2 }, { _id: 2, a: 3 }];
  const root = mount(h(ImportConfirm, { ...base, docs: dup, mode: 'insert' }));
  expect(root.querySelector('[data-testid="import-summary"]').textContent)
    .toBe('Adds 2 new records — existing records are never modified. (1 duplicate _id row dropped.)');
  const clean = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  expect(clean.querySelector('[data-testid="import-summary"]').textContent).not.toContain('duplicate');
});

it('summary sentence: update states keys, whole-row replace, server, no undo', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
  expect(root.querySelector('[data-testid="import-summary"]').textContent)
    .toBe('Upserts 2 rows matched by sku — matched records are replaced whole, unmatched rows are inserted. Runs on the server; can’t be undone.');
});

it('summary sentence: multi-key update appends (all must match)', () => {
  const root = mount(h(ImportConfirm, { ...base, docs: [{ sku: 'A', region: 'EU' }], mode: 'update', keys: ['sku', 'region'] }));
  expect(root.querySelector('[data-testid="import-summary"]').textContent).toContain('matched by sku + region (all must match)');
});

it('summary sentence: replace states wipe-and-load and no undo', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
  expect(root.querySelector('[data-testid="import-summary"]').textContent)
    .toBe('Deletes every existing record, then loads these 2 rows as the collection’s new contents. Can’t be undone.');
});
```

4. The red-hint assertion in the update-requires-keys test: keep the `import-go` disabled/enabled assertions; the `matched to existing records by sku` assertion moves behind `await openPlan(withKeys)`.

- [ ] **Step 2: Run to verify updated tests fail**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: FAIL — no `import-summary` testid yet.

- [ ] **Step 3: Implement**

In `src/mdh/components/ImportConfirm.jsx`:

1. Add import: `import PlanSummary from './PlanSummary.jsx';` Remove the now-unused `formatBytes` import.
2. Remove `fileMeta` from the destructured props and delete the whole `modal-count-info` div (lines 68–71).
3. After `insertCount`, add: `const dupesDropped = insertStats ? insertStats.total - insertCount : 0;`
4. Add above the component:

```js
// Mode-aware one-sentence outcome+risk summary (spec: exact copy).
function summarySentence({ mode, keys, docs, insertCount, dupesDropped }) {
  if (mode === 'insert') {
    return `Adds ${insertCount.toLocaleString()} new record${insertCount === 1 ? '' : 's'} — existing records are never modified.` +
      (dupesDropped > 0 ? ` (${dupesDropped.toLocaleString()} duplicate _id row${dupesDropped === 1 ? '' : 's'} dropped.)` : '');
  }
  if (mode === 'update') {
    if (keys.length === 0) return 'Pick one or more fields above to match existing records by.';
    const keyList = keys.join(' + ') + (keys.length > 1 ? ' (all must match)' : '');
    return `Upserts ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'} matched by ${keyList} — matched records are replaced whole, unmatched rows are inserted. Runs on the server; can’t be undone.`;
  }
  return `Deletes every existing record, then loads these ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'} as the collection’s new contents. Can’t be undone.`;
}
```

5. Delete the keys red hint line (`{keys.length === 0 && <div class="input-hint" …>Select at least one match field.</div>}`) — the sentence carries that state.
6. Replace the whole `import-steps` div (lines 138–167) with:

```jsx
      <PlanSummary
        summaryTestid="import-summary"
        summary={summarySentence({ mode, keys, docs, insertCount, dupesDropped })}
      >
        <ul data-testid="import-plan">
          {mode === 'insert' && (
            <Fragment>
              <li>Every row is added as a new record. Existing records are never modified.</li>
              <li>Rows keep their <code>_id</code> if they have one; rows without one get a server-assigned id. If several rows in the file share an <code>_id</code>, the first is kept and the rest are dropped before upload.</li>
              <li>A row whose <code>_id</code> already exists in the collection is rejected by the server; the other rows still import, and every rejection is reported at the end.</li>
              <li>Runs from this browser in batches of 1,000 {'—'} cancelling keeps the rows already inserted.</li>
            </Fragment>
          )}
          {isUpdate && keys.length === 0 && <li>Choose one or more fields to match existing records by.</li>}
          {isUpdate && keys.length > 0 && (
            <Fragment>
              <li>Each row is matched to existing records by <code>{keys.join(', ')}</code>{keys.length > 1 && <Fragment> {'—'} <strong>all</strong> of them must match at once (AND, not OR); a record equal in only some of these fields is not a match</Fragment>}.</li>
              <li>A matched record is <strong>replaced by the row entirely</strong> {'—'} fields the row doesn{'’'}t include are removed. The record keeps its <code>_id</code>.</li>
              <li>If several existing records share the same key value, only <strong>one</strong> of them is updated (which one is not guaranteed).</li>
              <li>Rows that match nothing are <strong>inserted</strong> as new records.</li>
              <li>Existing records not matched by any row are left untouched.</li>
              <li><code>_id</code> values and MDH{'’'}s internal <code>__digest_md5</code> in the file are ignored {'—'} records are identified only by the match keys, never by <code>_id</code>. A re-imported export can{'’'}t be matched by <code>_id</code>; pick a business key instead.</li>
              <li>Runs on the Rossum server as a single operation (typically 30{'–'}60 s, even for small files). Once started it can{'’'}t be recalled or undone.</li>
            </Fragment>
          )}
          {isReplace && (
            <Fragment>
              <li><strong>Deletes every existing record</strong>, then loads this file as the collection{'’'}s entire new contents.</li>
              <li>Custom indexes are kept. <code>_id</code> values and MDH{'’'}s internal <code>__digest_md5</code> in the file are ignored {'—'} the server assigns fresh ids, so record ids from an export are not preserved.</li>
              <li>Runs on the Rossum server (typically 30{'–'}60 s). Once started it can{'’'}t be recalled or undone.</li>
            </Fragment>
          )}
        </ul>
      </PlanSummary>
```

(The bullets are the existing ones verbatim, with `\uXXXX` escapes now written as `{'\uXXXX'}` expressions exactly as in the current file — copy them from the current file, do not retype.)

The shape zone, missing-key guard, and actions row stay exactly where they are in this task.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: all pass. (`tests/mdh-import-wizard.test.js` still passes — the wizard passes an extra `fileMeta`/`validateShape` prop, which Preact ignores.)

---

### Task 5: Shape check — silent pass, loud fail, in-card override

**Files:**
- Modify: `src/mdh/components/ImportConfirm.jsx` (shape zone)
- Modify: `src/mdh/components/ImportWizard.jsx` (state rename, `shapeError`)
- Test: `tests/mdh-import-confirm.test.js`, `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes: existing `validateAgainstShape(docs, shape)` and `deriveShape` from `src/mdh/shape.js` (unchanged).
- Produces: new ImportConfirm props contract (final): `{ docs, mode, setMode, keys, setKeys, shapeOverride, setShapeOverride, shape, shapeLoading, shapeError, shapeCount, shapeCoversAll, onImport, onCancel, onBack }`. `validateShape`/`setValidateShape` are gone. Testids: pass line `import-shape-ok`, fail card `import-shape-error` (kept), override button `shape-override`, overridden line `shape-overridden`, undo `shape-override-undo`, loading line `import-shape-loading`.

- [ ] **Step 1: Update tests**

In `tests/mdh-import-confirm.test.js`:

1. `base` fixture: replace `validateShape: false, setValidateShape() {}` with `shapeOverride: false, setShapeOverride() {}, shapeError: false`. Remove `validateShape: true` from every test that sets it (the check now always applies when `shape` is truthy).
2. Rewrite the pass-state tests (lines ~86–104): the ✓ is now a one-liner —

```js
it('shows a muted one-line pass state with the sample size', () => {
  const shape = deriveShape([{ sku: 'A1', price: 10 }]);
  const root = mount(h(ImportConfirm, { ...base, shape, shapeCount: 137, docs: [{ sku: 'B2', price: 20 }] }));
  const ok = root.querySelector('[data-testid="import-shape-ok"]');
  expect(ok.textContent).toMatch(/Shape matches/);
  expect(ok.textContent).toMatch(/checked against a 137-record random sample/i);
  expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
});

it('says "all N existing records" when the sample covered the whole collection', () => {
  const shape = deriveShape([{ sku: 'A1', price: 10 }]);
  const root = mount(h(ImportConfirm, { ...base, shape, shapeCount: 150, shapeCoversAll: true, docs: [{ sku: 'B2', price: 20 }] }));
  expect(root.querySelector('[data-testid="import-shape-ok"]').textContent).toMatch(/checked against all 150 existing records/i);
});
```

3. Empty-collection test (~line 110): `shape: null` now renders NO shape UI on screen; the note moved into Details —

```js
it('empty collection: no shape UI on screen, a skip note inside Details', async () => {
  const root = mount(h(ImportConfirm, { ...base, shape: null }));
  expect(root.querySelector('[data-testid="import-shape-ok"]')).toBe(null);
  expect(root.querySelector('[data-testid="import-shape-error"]')).toBe(null);
  await openPlan(root);
  expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/shape check skipped/i);
});

it('shape fetch failure: unavailable note inside Details', async () => {
  const root = mount(h(ImportConfirm, { ...base, shape: null, shapeError: true }));
  await openPlan(root);
  expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/Shape check unavailable/i);
});
```

4. Mismatch tests (~117–157) keep their assertions (error card, role=alert, `blocked`, field names, whitespace chips, sample note inside the card, Go disabled) — they no longer need `validateShape: true`. The uniformity test (~129) becomes: mismatching docs + non-uniform shape → the CARD contains `/may over-reject/i`; and a companion assertion that a PASSING non-uniform import shows only the ✓ line (no uniform warning).
5. Add the override flow:

```js
it('Import anyway overrides the mismatch and Undo restores it', async () => {
  const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]);
  let override = false;
  const setShapeOverride = (v) => { override = v; };
  const root = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, setShapeOverride }));
  root.querySelector('[data-testid="shape-override"]').click();
  expect(override).toBe(true);
  const over = mount(h(ImportConfirm, { ...base, mode: 'insert', shape, shapeOverride: true }));
  expect(over.querySelector('[data-testid="import-shape-error"]')).toBe(null);
  expect(over.querySelector('[data-testid="shape-overridden"]').textContent).toMatch(/overridden/i);
  expect(over.querySelector('[data-testid="import-go"]').disabled).toBe(false);
  expect(over.querySelector('[data-testid="shape-override-undo"]')).toBeTruthy();
});
```

In `tests/mdh-import-wizard.test.js`: delete the `shape-toggle` test (lines ~317–328); the always-on behavior is covered at the ImportConfirm level now.

- [ ] **Step 2: Run to verify updated tests fail**

Run: `npx vitest run tests/mdh-import-confirm.test.js`
Expected: FAIL — `shape-override` etc. missing.

- [ ] **Step 3: Implement ImportConfirm shape zone**

1. Props: replace `validateShape, setValidateShape` with `shapeOverride = false, setShapeOverride, shapeError = false`.
2. Replace the shapeCheck memo + `shapeOk`:

```js
  const shapeCheck = useMemo(() => (shape ? validateAgainstShape(docs, shape) : null), [shape, docs]);
  const shapeOk = !shapeCheck || shapeCheck.ok || shapeOverride;
```

(`canImport` expressions are untouched — they already use `shapeOk`.)

3. Add next to `sampleNote`:

```js
  const sampleNoteShort = shapeCoversAll
    ? `checked against all ${shapeCount.toLocaleString()} existing records`
    : `checked against a ${shapeCount.toLocaleString()}-record random sample`;
```

4. Delete the toggle `<label>` (lines 84–87) and the whole `import-shape` wrapper div, replacing them with:

```jsx
      {shapeLoading && <div class="import-shape-line" data-testid="import-shape-loading">Checking shape{'…'}</div>}
      {!shapeLoading && shapeCheck?.ok && (
        <div class="import-shape-line ok" data-testid="import-shape-ok">{'✓'} Shape matches {'·'} {sampleNoteShort}</div>
      )}
      {!shapeLoading && shapeCheck && !shapeCheck.ok && shapeOverride && (
        <div class="import-shape-line warn" data-testid="shape-overridden">
          Shape check overridden {'—'} importing anyway.{' '}
          <button type="button" class="plan-summary-toggle" data-testid="shape-override-undo" onClick={() => setShapeOverride(false)}>Undo</button>
        </div>
      )}
      {!shapeLoading && shapeCheck && !shapeCheck.ok && !shapeOverride && (
        <div class="import-error" data-testid="import-shape-error" role="alert">
          {/* keep the existing head, error-list (Whitespace/Missing/Unexpected/Wrong type) exactly as-is */}
          {shape && !shape.uniform && (
            <div class="import-shape-note">Existing records aren{'’'}t uniform (varying fields: <code>{shape.optionalPaths.slice(0, 6).join(', ') || 'mixed types'}</code>) {'—'} exact-shape validation may over-reject.</div>
          )}
          <div class="import-error-hint">
            {shapeCheck.whitespace.length > 0 && <span>Columns marked {'·'} differ only by leading/trailing whitespace. </span>}
            Fix the file to match, or{' '}
            <button type="button" class="plan-summary-toggle" data-testid="shape-override" onClick={() => setShapeOverride(true)}>import anyway {'—'} skip this check</button>.
          </div>
          <div class="import-shape-note">{sampleNote}</div>
        </div>
      )}
```

The standalone non-uniform warning block (old lines 92–97) and the big ✓ card (old lines 129–134) are deleted.

5. In the Details `<ul data-testid="import-plan">` (from Task 4), append as the last entry:

```jsx
          {!shapeLoading && !shape && (
            <li>{shapeError
              ? <Fragment>Shape check unavailable {'—'} the existing-records sample couldn{'’'}t be fetched.</Fragment>
              : <Fragment>New or empty collection {'—'} shape check skipped.</Fragment>}</li>
          )}
```

- [ ] **Step 4: Implement the ImportWizard side**

In `src/mdh/components/ImportWizard.jsx`:

1. Replace `const [validateShape, setValidateShape] = useState(true);` (and its owner-decision comment) with:

```js
  // Silent-pass/loud-fail: the shape check ALWAYS runs; a mismatch can be
  // overridden per-import from inside the error card. Never persisted
  // (owner decision 2026-07-04); the legacy `mdhImportValidateShape` key
  // stays orphaned.
  const [shapeOverride, setShapeOverride] = useState(false);
  const [shapeError, setShapeError] = useState(false);
```

2. In the shape-fetch effect, set `setShapeError(false); setShapeOverride(false);` right after `setShapeLoading(true)`, and in the `.catch` handler add `setShapeError(true);` before the existing resets.
3. In the `<ImportConfirm …>` call, replace `validateShape={validateShape} setValidateShape={setValidateShape}` with `shapeOverride={shapeOverride} setShapeOverride={setShapeOverride} shapeError={shapeError}`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mdh-import-confirm.test.js tests/mdh-import-wizard.test.js`
Expected: all pass.

---

### Task 6: ImportWizard — merge Configure into one Decide screen

**Files:**
- Modify: `src/mdh/components/ImportWizard.jsx` (stages, handleFile, re-parse effect, Pick copy, Decide render, `SourceStrip`/`ParsingStrip` local components)
- Modify: `src/mdh/components/ImportControls.jsx` (add `JsonPreview`)
- Test: `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes: Task 2's `fmt.summarizeOpts(opts, parsed)`; Task 5's ImportConfirm props contract; existing `CsvPreview`, `formatBytes` (from `ImportStages.jsx`), `getFormat`/`detectFormat`/`ALL_ACCEPT`.
- Produces: stage constant `STAGE = { PICK: 'pick', DECIDE: 'decide', IMPORTING: 'importing', DONE: 'done' }`. Testids: `source-strip`, `parse-strip`, `parse-strip-summary`, `parse-strip-change`, `json-preview`. Removed testids: `import-next`, `configure-back` (CONFIGURE is gone). `ImportControls.jsx` exports `JsonPreview({ docs })`.

- [ ] **Step 1: Update tests**

In `tests/mdh-import-wizard.test.js`, rewrite the navigation block (~lines 250–310):

1. **CSV goes straight to Decide**: after dropping/choosing a CSV file, the old flow waited for `import-next` and clicked it; now assert the Decide screen appears directly — `await waitFor(() => root.querySelector('[data-testid="parse-strip"]'))` and `await waitFor(() => root.querySelector('[data-testid="import-mode"]'))` in the same screen; `parse-strip-summary` text matches `/comma · header row · text-only/` (use `·` in the regex source). Delete every `import-next` / `configure-back` interaction.
2. **Back from Decide returns to Pick** (file case): click `import-back`, then `await waitFor(() => root.querySelector('[data-testid="import-file-input"]'))`.
3. **Clipboard flow**: unchanged entry (`clipboard-next` → Decide). Update its back-nav test: Back now goes straight to PICK with the editor text restored (already the old CONFIRM→PICK clipboard behavior — keep those assertions).
4. **Opts change re-parses and resets keys**: new test — CSV file with columns `sku,name`; on Decide switch mode to `update`, add key `sku` via the MatchKeyPicker input; then click `parse-strip-change`, toggle the header option (`[data-testid="csv-header"]`); assert via waitFor that the chips are gone (`root.querySelector('.match-key-chip') === null`) and the parse strip now says `no header`.
5. **JSON preview**: new test — clipboard-paste `[{"a":1},{"a":2}]`, click `clipboard-next`, assert `await waitFor(() => root.querySelector('[data-testid="json-preview"]'))` contains `{"a":1}` and no `csv-preview` element.

(Keep all IMPORTING/DONE tests untouched — those stages don't change.)

- [ ] **Step 2: Run to verify updated tests fail**

Run: `npx vitest run tests/mdh-import-wizard.test.js`
Expected: FAIL — CSV still lands on the Configure screen.

- [ ] **Step 3: Implement `JsonPreview`**

In `src/mdh/components/ImportControls.jsx` append:

```jsx
const JSON_PREVIEW_ROWS = 5;

// Compact preview for column-less imports (JSON / JSON-lines): the first few
// docs as single-line JSON, in the same preview chrome as the export modal.
export function JsonPreview({ docs }) {
  if (!docs.length) return null;
  const shown = docs.slice(0, JSON_PREVIEW_ROWS);
  return (
    <div class="csv-export-preview" data-testid="json-preview">
      <div class="csv-export-preview-caption">
        Preview {'·'} first {shown.length} of {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'}
      </div>
      <pre class="csv-export-preview-text">{shown.map((d) => JSON.stringify(d)).join('\n')}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Implement the wizard restructure**

In `src/mdh/components/ImportWizard.jsx`:

1. Imports: add `JsonPreview` to the `ImportControls.jsx` import; add `import { formatBytes } from './ImportStages.jsx';` — change the existing `ImportProgress, ImportSummary` import line accordingly.
2. `const STAGE = { PICK: 'pick', DECIDE: 'decide', IMPORTING: 'importing', DONE: 'done' };`
3. Add `const lastParsedOptsRef = useRef(null);` next to `parseToken`.
4. Replace `handleFile` with:

```js
  function handleFile(fileObj) {
    setErrorMsg(null);
    const id = detectFormat(fileObj.name);
    if (!id) { setErrorMsg('Unsupported file — expected JSON, JSONL, CSV, Excel, or XML.'); return; }
    const f = getFormat(id);
    setFormat(id);
    setFileMeta({ name: fileObj.name, size: fileObj.size });
    const read = f.read === 'arrayBuffer' ? fileObj.arrayBuffer() : fileObj.text();
    read.then(async (input) => {
      setRawInput(input);
      const initialOpts = f.detectOpts ? { ...f.defaultOpts, ...f.detectOpts(input) } : f.defaultOpts;
      setOpts(initialOpts);
      lastParsedOptsRef.current = JSON.stringify(initialOpts);
      const res = await Promise.resolve(f.parse(input, initialOpts));
      if (!f.ConfigureControls) {
        // No parsing options to fix on the Decide screen — errors stay here.
        if (res.error) { setErrorMsg(res.error.message); return; }
        if (!res.docs.length) { setErrorMsg('File contains no documents'); return; }
      }
      setParsed(res);
      setKeys([]);
      setShapeOverride(false);
      setStage(STAGE.DECIDE);
    }).catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }
```

5. Replace the CONFIGURE re-parse effect with (note: keys and the shape override reset on every opts-triggered re-parse — column sets can change):

```js
  // Re-parse on parsing-option change (Decide screen, configurable formats
  // only). The initial parse happens in handleFile; the ref-compare skips a
  // redundant duplicate parse on mount.
  useEffect(() => {
    if (stage !== STAGE.DECIDE || rawInput == null || !fmt?.ConfigureControls) return undefined;
    const optsKey = JSON.stringify(opts);
    if (optsKey === lastParsedOptsRef.current) return undefined;
    lastParsedOptsRef.current = optsKey;
    const token = ++parseToken.current;
    Promise.resolve(fmt.parse(rawInput, opts))
      .then((res) => { if (token === parseToken.current) { setParsed(res); setKeys([]); setShapeOverride(false); } })
      .catch((err) => { if (token === parseToken.current) setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message } }); });
    return undefined;
  }, [stage, rawInput, JSON.stringify(opts)]);
```

6. Delete `configureNext` and `configureBack`. Replace `confirmBack` with:

```js
  function decideBack() {
    setErrorMsg(null);
    setKeys([]);
    setShapeOverride(false);
    resetFileInput();
    setStage(STAGE.PICK);
  }
```

7. `clipboardNext`: change `setStage(STAGE.CONFIRM)` to `setStage(STAGE.DECIDE)` and add `setShapeOverride(false);` next to `setKeys([]);`. In the shape effect, change the guard to `stage !== STAGE.DECIDE`.
8. Pick-screen copy: delete the `modal-field-label` line above `FileDropArea`; change the drop-area label text to `Drop a file here or click to choose`; change the clipboard label to `Paste JSON {'—'} array, object, or JSON-lines`.
9. Add local components above the default export:

```jsx
function SourceStrip({ fileMeta, parsed }) {
  const bits = [];
  if (fileMeta?.size != null) bits.push(formatBytes(fileMeta.size));
  bits.push(`${parsed.docs.length.toLocaleString()} row${parsed.docs.length === 1 ? '' : 's'}`);
  if ((parsed.columns || []).length > 0) bits.push(`${parsed.columns.length} column${parsed.columns.length === 1 ? '' : 's'}`);
  return (
    <div class="source-strip" data-testid="source-strip">
      <span class="source-strip-name">{fileMeta?.name}</span>
      <span>{bits.join(' · ')}</span>
    </div>
  );
}

function ParsingStrip({ fmt, opts, setOpt, parsed }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="parse-strip-wrap">
      <div class="parse-strip" data-testid="parse-strip">
        <span class="parse-strip-k">Parsing</span>
        <span class="parse-strip-summary" data-testid="parse-strip-summary">{fmt.summarizeOpts(opts, parsed)}</span>
        <button type="button" class="plan-summary-toggle" aria-expanded={open} data-testid="parse-strip-change" onClick={() => setOpen(!open)}>
          {open ? 'Hide ▴' : 'Change ▾'}
        </button>
      </div>
      {open && <fmt.ConfigureControls opts={opts} setOpt={setOpt} parsed={parsed} />}
    </div>
  );
}
```

10. Replace BOTH the `STAGE.CONFIGURE` and `STAGE.CONFIRM` render blocks with one:

```jsx
      {stage === STAGE.DECIDE && parsed && (
        <Fragment>
          <SourceStrip fileMeta={fileMeta} parsed={parsed} />
          {fmt?.ConfigureControls && <ParsingStrip fmt={fmt} opts={opts} setOpt={setOpt} parsed={parsed} />}
          {(parsed.error || (parsed.columns || []).length > 0)
            ? <CsvPreview parsed={parsed} />
            : <JsonPreview docs={parsed.docs} />}
          {(parsed.error || !parsed.docs.length) ? (
            <div class="modal-actions">
              <button class="btn btn-secondary" style="margin-right:auto" data-testid="import-back" onClick={decideBack}>{'←'} Back</button>
              <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
            </div>
          ) : (
            <ImportConfirm
              docs={parsed.docs}
              mode={mode} setMode={setMode}
              keys={keys} setKeys={setKeys}
              shapeOverride={shapeOverride} setShapeOverride={setShapeOverride}
              shape={shape} shapeLoading={shapeLoading} shapeError={shapeError}
              shapeCount={shapeCount} shapeCoversAll={shapeCoversAll}
              onImport={startImport} onCancel={closeModal} onBack={decideBack}
            />
          )}
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
        </Fragment>
      )}
```

(When the parse is broken there is no Go button at all — Back/Cancel only. `fieldsFn` and the IMPORTING/DONE blocks are untouched. `fileMeta` stays in wizard state — `ImportSummary` on DONE still uses it.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mdh-import-wizard.test.js tests/mdh-import-confirm.test.js`
Expected: all pass.

---

### Task 7: Copy/CSS cleanup + full verification

**Files:**
- Modify: `src/mdh/components/ImportStages.jsx` (heartbeat hint copy)
- Modify: `src/console/console.css` (new rules; retire orphaned ones)
- Test: full suite + build

**Interfaces:**
- Consumes: class names used by Tasks 1–6: `.plan-summary*`, `.source-strip*`, `.parse-strip*`, `.import-shape-line` (+ `.ok`/`.warn`).
- Produces: nothing new — final polish.

- [ ] **Step 1: Heartbeat copy**

In `src/mdh/components/ImportStages.jsx` replace the hint line

```jsx
<div class="input-hint">The server is still working {'—'} this can take a minute or two for large files. You can close this window and check the outcome later in <strong>Operation Logs</strong>.</div>
```

with:

```jsx
<div class="input-hint">Typically 30{'–'}60 s. You can close this {'—'} the outcome appears in <strong>Operation Logs</strong>.</div>
```

(`npx vitest run tests/mdh-import-stages.test.js` — no test asserts this copy; verify it stays green.)

- [ ] **Step 2: CSS additions**

In `src/console/console.css`, next to the existing `.import-steps` rules (~line 1607), add:

```css
/* Plan summary (shared import/export): one-line outcome + Details expander */
.plan-summary { margin-top: 12px; }
.plan-summary-line { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.plan-summary-text { flex: 1; }
.plan-summary-text code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-primary); }
.plan-summary-toggle { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: 12px; white-space: nowrap; }
.plan-summary-toggle:hover { text-decoration: underline; }
.plan-summary .import-steps { margin-top: 8px; }

/* Import Decide screen strips */
.source-strip { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--text-secondary); }
.source-strip-name { font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); }
.parse-strip-wrap { margin-bottom: 8px; }
.parse-strip { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.parse-strip-k { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-primary); }
.parse-strip-summary { flex: 1; }

/* Shape status lines (silent pass, loud fail) */
.import-shape-line { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.import-shape-line.ok { color: var(--success); }
.import-shape-line.warn { color: var(--warning); }
```

- [ ] **Step 3: Retire orphaned CSS — verify before deleting**

For each candidate, `grep -rn "<class>" src/ --include="*.jsx"` and delete the CSS rule ONLY if there are zero remaining usages:
- `.import-steps-head` (both usages were removed in Tasks 3–4)
- `.export-count` (+ its `code` and `.import-warn` variants at ~4111–4113)
- `.modal-count-info` (sole usage was ImportConfirm)
- `.import-shape`, `.import-ok`, `.import-ok-icon` (the ✓ card is gone; **keep** `.import-shape-note`, `.import-shape-neutral` if still referenced — `ExportWizard.jsx:133` uses `.import-shape-neutral`)

Keep `.import-error*`, `.import-steps`, `.csv-*` — all still used.

- [ ] **Step 4: Full verification**

```bash
npm test
npm run build
```

Expected: full suite green; build completes. Then tell the owner: **reload the extension** (`dist/` is what runs) before eyeballing, and walk the four flows once in the browser — export (JSON + CSV with details expanded), import insert (JSON clipboard), import update (CSV with a key + a deliberate shape mismatch → Import anyway), import replace.

---

## Self-review notes (done at plan-writing time)

- **Spec coverage:** pick-screen copy (T6.8), parsing strip + summaries (T2, T6), JSON preview (T6.3), summary sentences (T4), Details verbatim bullets (T3, T4), silent-pass/loud-fail + override + unavailable note (T5), export merge (T3), heartbeat copy (T7.1), CSS (T7.2–3), zero-storage/backward-compat (no task touches storage or engine files). Gap check: spec's "uniformity caveat only inside the fail card" — T5 step 3.4; "keys reset on re-parse" — T6 step 4.5 + test T6.1.4. Covered.
- **Type consistency:** `PlanSummary({ summary, summaryTestid, children })` used identically in T3/T4; ImportConfirm props contract stated in T5 matches the call in T6.10; `summarizeOpts(opts, parsed)` signature consistent across T2 and T6.9.
- **Placeholders:** none — every step carries the actual code/copy. The one deliberate reference ("keep the existing head, error-list exactly as-is" in T5.3.4) points at code that must NOT change, with its location.
