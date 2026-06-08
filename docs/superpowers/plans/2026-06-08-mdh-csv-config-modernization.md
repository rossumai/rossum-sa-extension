# Modernize the CSV "Configure" stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the CSV import wizard's Configure stage into "Direction C" — a meta bar (`filename · rows · KB · columns`), a slim toolbar (Delimiter / Header / Infer types + an inline-expanding Advanced section), and a hero preview with a type legend — using modern segmented-pill and toggle-switch controls.

**Architecture:** Presentation-only rework of `src/mdh/components/CsvImportWizard.jsx` (Configure stage + new `Segmented`/`Toggle` helpers) and `src/console/console.css` (`.csv-*` control styles). The parser (`csv.js`), the shared `ImportStages.jsx`, the JSON wizard, all option keys, the `parseCsv` live-reparse, and the Next-gating logic are unchanged.

**Tech Stack:** Preact (`h`/`Fragment`/`useState`), esbuild, Vitest (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-mdh-csv-config-modernization-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** jsdom; `import { h, render } from 'preact'`; mount into a `document.createElement('div')`; query by `data-testid`/class; drive via `.click()` / `dispatchEvent`. JSX unicode must stay literal in `{'…'}` form (never `\uXXXX`). `npm test` = whole suite; single file `npx vitest run tests/mdh-csv-wizard.test.js`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/components/CsvImportWizard.jsx` | modify | New `Segmented`/`Toggle` helpers; rework `CsvOptions` into toolbar + inline Advanced; add meta bar to `CsvStageConfigure`; add legend to `CsvPreview`. |
| `src/mdh/components/ImportStages.jsx` | modify | Export the existing `formatBytes` helper (1-word change) so the meta bar can reuse it (DRY). |
| `src/console/console.css` | modify | Replace `.csv-config`/`.csv-opt*` rules with `.csv-meta`/`.csv-toolbar`/`.csv-seg*`/`.csv-switch*`/`.csv-chip`/`.csv-advanced`/`.csv-adv-toggle`/`.csv-preview-legend`; make `.csv-preview-caption` a flex row. Keep `.csv-opt-hint`, all `.csv-preview*`/`.csv-cell-*`, and the `:has(.csv-import-wizard)` width rule. |
| `tests/mdh-csv-wizard.test.js` | modify | Keep the infer-reparse test; add advanced-collapsed, delimiter-segmented, meta-bar, and legend tests. |

`csv.js`, the shared stages, and the JSON wizard are untouched.

---

## Task 1: `Segmented` + `Toggle` helper components (+ their CSS)

**Files:**
- Modify: `src/mdh/components/CsvImportWizard.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/mdh-csv-wizard.test.js` (after the imports; update the import line to pull the new named exports):

Change line 4 from:
```js
import CsvImportWizard, { CsvPreview } from '../src/mdh/components/CsvImportWizard.jsx';
```
to:
```js
import CsvImportWizard, { CsvPreview, Segmented, Toggle } from '../src/mdh/components/CsvImportWizard.jsx';
```

Append this describe block:
```js
describe('Segmented', () => {
  it('marks the active option and reports clicks', () => {
    const picked = [];
    const opts = [
      { value: 'a', label: 'A', testid: 'seg-a' },
      { value: 'b', label: 'B', testid: 'seg-b' },
    ];
    const root = mount(h(Segmented, { value: 'a', options: opts, onChange: (v) => picked.push(v) }));
    const a = root.querySelector('[data-testid="seg-a"]');
    const b = root.querySelector('[data-testid="seg-b"]');
    expect(a.classList.contains('on')).toBe(true);
    expect(b.classList.contains('on')).toBe(false);
    b.click();
    expect(picked).toEqual(['b']);
  });
});

describe('Toggle', () => {
  it('renders a switch and flips on click', () => {
    let val = false;
    const root = mount(h(Toggle, { checked: false, onChange: (v) => { val = v; }, testid: 'tg' }));
    const btn = root.querySelector('[data-testid="tg"]');
    expect(btn.getAttribute('role')).toBe('switch');
    expect(btn.getAttribute('aria-checked')).toBe('false');
    btn.click();
    expect(val).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: FAIL — `Segmented`/`Toggle` are not exported.

- [ ] **Step 3: Add the helpers**

In `src/mdh/components/CsvImportWizard.jsx`, add these two exported components (e.g. just above `export function CsvPreview`):

```jsx
// Segmented pill group. options: [{ value, label, title?, testid? }].
// `testid` (on the wrapper) is optional; per-option `testid` lands on each button.
export function Segmented({ value, options, onChange, testid }) {
  return (
    <span class="csv-seg" role="group" data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={`csv-seg-opt${o.value === value ? ' on' : ''}`}
          title={o.title}
          data-testid={o.testid}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >{o.label}</button>
      ))}
    </span>
  );
}

// Toggle switch backed by an accessible button. Forwards `testid` to the button.
export function Toggle({ checked, onChange, title, testid }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      data-testid={testid}
      class={`csv-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span class="csv-switch-knob"></span>
    </button>
  );
}
```

- [ ] **Step 4: Add the control-atom CSS**

In `src/console/console.css`, replace the old config-grid rules (currently lines 1350–1361, from `.csv-config { ... }` through `.csv-opt-hint { ... }`) with the following. **Keep** `.csv-opt-hint` (reused by the Advanced panel). Leave the `.modal-card:has(.csv-import-wizard)` rule (line 1349) and everything from `.csv-preview` onward intact for now.

```css
/* Segmented pill group */
.csv-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.csv-seg-opt {
  padding: 4px 9px; font-size: 11px; font-family: inherit; line-height: 1.4;
  border: none; border-right: 1px solid var(--border);
  background: var(--bg-card); color: var(--text-secondary); cursor: pointer;
}
.csv-seg-opt:last-child { border-right: none; }
.csv-seg-opt.on { background: var(--accent); color: #fff; }

/* Toggle switch */
.csv-switch {
  position: relative; width: 30px; height: 18px; flex: none; padding: 0;
  border: none; border-radius: 9px; background: var(--border); cursor: pointer;
  transition: background 0.15s;
}
.csv-switch.on { background: var(--accent); }
.csv-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: left 0.15s;
}
.csv-switch.on .csv-switch-knob { left: 14px; }

/* Mono char input (quote / escape / custom delimiter) */
.csv-chip {
  width: 44px; text-align: center; font-family: var(--font-mono); font-size: 11px;
  border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px;
  background: var(--bg-input); color: var(--text-primary);
}

/* Inline hint text, reused in the Advanced panel */
.csv-opt-hint { font-size: 11px; color: var(--text-secondary); margin: 2px 0 0 0; }
```

- [ ] **Step 5: Run to verify pass + build**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: PASS (Segmented + Toggle tests green; existing tests still pass — the wizard markup is unchanged so far, and removing the old CSS rules doesn't affect rendering correctness in jsdom).
Run: `npm run build`
Expected: clean.

---

## Task 2: Rework `CsvOptions` into toolbar + inline Advanced

**Files:**
- Modify: `src/mdh/components/CsvImportWizard.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-csv-wizard.test.js` (the `waitFor` helper defined earlier in the file is reused):

```js
describe('CsvImportWizard — toolbar & advanced', () => {
  async function loadFile(root, text, name = 't.csv') {
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File([text], name, { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));
  }

  it('keeps the Advanced options collapsed until the disclosure is clicked', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    await loadFile(root, 'name,age\nAlice,30');
    // Empty-cell control lives in Advanced — absent while collapsed.
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeNull();
    root.querySelector('[data-testid="csv-advanced-toggle"]').click();
    expect(root.querySelector('[data-testid="csv-empty"]')).toBeTruthy();
  });

  it('changes the parse when a different delimiter pill is clicked', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    // Semicolon-delimited; with the default comma delimiter this is one column.
    await loadFile(root, 'a;b;c\n1;2;3');
    expect(root.querySelectorAll('.csv-preview-table th').length).toBe(1);
    root.querySelector('[data-testid="csv-delim-semicolon"]').click();
    await waitFor(() => root.querySelectorAll('.csv-preview-table th').length === 3);
    expect(root.querySelectorAll('.csv-preview-table th').length).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: FAIL — no `csv-advanced-toggle` / `csv-delim-semicolon`; `csv-empty` is always present (current dropdown).

- [ ] **Step 3: Replace `CsvOptions` and the `DELIMITER_PRESETS` constant**

In `src/mdh/components/CsvImportWizard.jsx`, replace the `DELIMITER_PRESETS` constant (currently lines 174–179) and the entire `CsvOptions` function (currently lines 181–277) with:

```jsx
// Delimiter pills. '__custom__' reveals a 1-char input (delimiter set to '').
const DELIM_SEG = [
  { value: ',', label: ',', title: 'Comma', testid: 'csv-delim-comma' },
  { value: ';', label: ';', title: 'Semicolon', testid: 'csv-delim-semicolon' },
  { value: '\t', label: 'Tab', title: 'Tab', testid: 'csv-delim-tab' },
  { value: '|', label: '|', title: 'Pipe', testid: 'csv-delim-pipe' },
  { value: '__custom__', label: '⋯', title: 'Custom character', testid: 'csv-delim-custom' },
];
const DELIM_PRESET_VALUES = [',', ';', '\t', '|'];

const ENCODING_SEG = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1252', label: '1252' },
  { value: 'iso-8859-1', label: 'Latin-1' },
  { value: 'utf-16le', label: 'UTF-16' },
];

const EMPTY_SEG = [
  { value: 'empty', label: '""', title: 'Empty string' },
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

function CsvOptions({ opts, setOpt }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const delimiterIsCustom = !DELIM_PRESET_VALUES.includes(opts.delimiter);

  return (
    <div data-testid="csv-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Character between fields.">Delimiter</span>
          <Segmented
            value={delimiterIsCustom ? '__custom__' : opts.delimiter}
            options={DELIM_SEG}
            onChange={(v) => setOpt('delimiter', v === '__custom__' ? '' : v)}
          />
          {delimiterIsCustom && (
            <input type="text" maxLength={1} class="csv-chip" value={opts.delimiter}
              data-testid="csv-delim-input" placeholder="?"
              onInput={(e) => setOpt('delimiter', e.target.value)} />
          )}
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Use row 1 as field names. Off → fields named column_1, column_2, …">First row is a header</span>
          <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="csv-header"
            title="Use row 1 as field names." />
        </span>

        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Off → every value is a string (keeps leading zeros / IDs). On → detect numbers and true/false.">Infer types</span>
          <Toggle checked={opts.inferTypes} onChange={(v) => setOpt('inferTypes', v)} testid="csv-infer"
            title="Detect numbers and true/false." />
        </span>

        <button type="button" class="csv-adv-toggle" data-testid="csv-advanced-toggle"
          aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
          Advanced {advancedOpen ? '▴' : '▾'}
        </button>
      </div>

      {advancedOpen && (
        <div class="csv-advanced" data-testid="csv-advanced">
          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Quote</span>
              <input type="text" maxLength={1} class="csv-chip" value={opts.quoteChar}
                onInput={(e) => setOpt('quoteChar', e.target.value || '"')} />
            </span>
            <div class="csv-opt-hint">Wraps fields containing the delimiter, quotes, or line breaks.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Escape</span>
              <input type="text" maxLength={1} class="csv-chip" value={opts.escapeChar}
                onInput={(e) => setOpt('escapeChar', e.target.value)} placeholder="none" />
            </span>
            <div class="csv-opt-hint">If set (e.g. \), the next character inside a quoted field is taken literally.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Double-quote</span>
              <Toggle checked={opts.doubleQuote} onChange={(v) => setOpt('doubleQuote', v)} testid="csv-doublequote" />
            </span>
            <div class="csv-opt-hint">A doubled quote (<code>""</code>) inside a quoted field means one literal quote (RFC 4180).</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Encoding</span>
              <Segmented value={opts.encoding} options={ENCODING_SEG} testid="csv-encoding"
                onChange={(v) => setOpt('encoding', v)} />
            </span>
            <div class="csv-opt-hint">Pick a legacy encoding if accented characters look garbled.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Empty cell {'→'}</span>
              <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="csv-empty"
                onChange={(v) => setOpt('emptyMode', v)} />
            </span>
            <div class="csv-opt-hint">What an empty cell becomes in the document.</div>
          </div>

          <div class="csv-adv-item">
            <span class="csv-tb-item">
              <span class="csv-tb-k">Skip empty lines</span>
              <Toggle checked={opts.skipEmptyLines} onChange={(v) => setOpt('skipEmptyLines', v)} testid="csv-skipempty" />
            </span>
            <div class="csv-opt-hint">Ignore blank lines in the file.</div>
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
    </div>
  );
}
```

(`useState` is already imported at the top of the file. `Segmented`/`Toggle` are defined in the same module from Task 1.)

- [ ] **Step 4: Add the toolbar + advanced CSS**

In `src/console/console.css`, immediately after the `.csv-chip` rule added in Task 1, add:

```css
/* Configure-stage toolbar + advanced panel */
.csv-toolbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  margin: 10px 0 0; padding: 9px 11px;
  background: var(--bg-base); border: 1px solid var(--border); border-radius: 9px;
}
.csv-tb-item { display: flex; align-items: center; gap: 7px; }
.csv-tb-k { font-size: 11px; color: var(--text-secondary); }
.csv-adv-toggle {
  margin-left: auto; border: none; background: none; cursor: pointer;
  color: var(--accent); font-weight: 600; font-size: 11px; font-family: inherit;
}
.csv-advanced {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 20px;
  margin-top: 9px; padding: 12px; border: 1px dashed var(--border); border-radius: 9px;
}
```

- [ ] **Step 5: Run to verify pass + build**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: PASS — advanced-collapsed and delimiter-segmented tests green; the existing infer-reparse test still passes (the `csv-infer` Toggle button click flips `inferTypes`).
Run: `npm run build`
Expected: clean.
Run: `npm test`
Expected: full suite PASS.

---

## Task 3: Meta bar + preview legend

**Files:**
- Modify: `src/mdh/components/ImportStages.jsx`
- Modify: `src/mdh/components/CsvImportWizard.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-csv-wizard.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-csv-wizard.test.js`:

```js
describe('CsvImportWizard — meta bar', () => {
  it('shows the row count and a formatted file size', async () => {
    const root = mount(h(CsvImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="csv-file-input"]');
    const file = new File(['name,age\nAlice,30\nBob,25'], 'people.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('[data-testid="csv-meta"]'));
    const meta = root.querySelector('[data-testid="csv-meta"]').textContent;
    expect(meta).toContain('people.csv');
    expect(meta).toMatch(/\b2\b/);          // 2 data rows
    expect(meta).toMatch(/\d+\s?(B|KB)/);   // a formatted size token
  });
});
```

And add a legend assertion to the existing `CsvPreview` "renders typed cells" test (or as a new `it`):
```js
  it('renders a type legend in the caption', () => {
    const parsed = { columns: ['a'], docs: [{ a: '1' }], warnings: [], error: null };
    const root = mount(h(CsvPreview, { parsed }));
    expect(root.querySelector('.csv-preview-legend')).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: FAIL — no `csv-meta` element; no `.csv-preview-legend`.

- [ ] **Step 3a: Export `formatBytes` from `ImportStages.jsx`**

In `src/mdh/components/ImportStages.jsx`, change the helper declaration from:
```js
function formatBytes(n) {
```
to:
```js
export function formatBytes(n) {
```
(No other change; the JSON wizard's internal use is unaffected.)

- [ ] **Step 3b: Add the meta bar + import `formatBytes` (CsvImportWizard.jsx)**

Update the `ImportStages` import (currently `import { StageConfirm, StageImporting, StageDone } from './ImportStages.jsx';`) to:
```jsx
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
```

Replace `CsvStageConfigure` (currently lines 282–300) with:
```jsx
function CsvStageConfigure({ fileMeta, opts, setOpt, parsed, onNext, onCancel }) {
  const canNext = parsed && !parsed.error && parsed.docs.length > 0 && opts.delimiter !== '';
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="csv-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> row{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> column{cols === 1 ? '' : 's'}</span>}
      </div>

      <CsvOptions opts={opts} setOpt={setOpt} />

      <CsvPreview parsed={parsed} />

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="csv-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 3c: Add the legend to `CsvPreview` (CsvImportWizard.jsx)**

Replace the `.csv-preview-caption` block inside `CsvPreview` (currently lines 315–317) with:
```jsx
      <div class="csv-preview-caption">
        <span>Preview {'·'} first {Math.min(limit, docs.length)} of {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} {'·'} {columns.length} column{columns.length === 1 ? '' : 's'}</span>
        <span class="csv-preview-legend">
          <span class="csv-legend-num">123</span> number {'·'} <span class="csv-legend-null">null</span> {'·'} "text"
        </span>
      </div>
```
**Important:** the legend uses `.csv-legend-num` / `.csv-legend-null` — NOT `.csv-cell-*` — so it does not collide with the existing `CsvPreview` tests that query `.csv-cell-number` / `.csv-cell-string` inside the table.

- [ ] **Step 3d: Add the meta + legend CSS**

In `src/console/console.css`, add (after the `.csv-advanced` rule from Task 2):
```css
/* Configure-stage meta bar */
.csv-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 2px; }
.csv-meta-fn { font-family: var(--font-mono); font-weight: 600; font-size: 12px; }
.csv-meta-m { font-size: 11px; color: var(--text-secondary); }
.csv-meta-m b { color: var(--text-primary); font-weight: 600; }
```
And change the existing `.csv-preview-caption` rule (currently `.csv-preview-caption { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }`) to a flex row, and add the legend rules right after it:
```css
.csv-preview-caption { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.csv-preview-legend { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.csv-legend-num { color: var(--accent); font-family: var(--font-mono); }
.csv-legend-null { color: var(--text-secondary); font-style: italic; }
```

- [ ] **Step 4: Run to verify pass + build + full suite**

Run: `npx vitest run tests/mdh-csv-wizard.test.js`
Expected: PASS — meta-bar and legend tests green; all earlier tests still pass.
Run: `npm run build`
Expected: clean.
Run: `npm test`
Expected: full suite PASS.

---

## Task 4: Verification + manual QA

**Files:** none (verification only)

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture the `Test Files N passed` line).
Run: `npm run build` → clean.

- [ ] **Step 2: Confirm the styles ship and no stale classes remain**

Run: `grep -c 'csv-toolbar\|csv-switch\|csv-seg-opt\|csv-meta' dist/console/console.css` → expect a positive count.
Run: `grep -c 'csv-config\|csv-opt-group\|csv-opt-char' dist/console/console.css` → expect `0` (the old grid classes are gone).

- [ ] **Step 3: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection, **Insert ▾ → Insert from CSV file**, pick a CSV. Verify:
- Meta bar shows `filename · N rows · KB · columns`.
- Toolbar: delimiter pills switch the parse; Header and Infer-types are toggle switches; toggling Infer types unquotes numbers/booleans in the preview live.
- **Advanced ▾** is collapsed by default; clicking it expands the panel inline (Quote, Escape, Double-quote, Encoding, Empty-cell, Skip-empty-lines, Trim, each with a hint); clicking again collapses it.
- Hover a toolbar label → tooltip appears.
- Preview shows the type legend; sticky header; warnings; a malformed file shows the parse-error banner and disables Next.
- Light + dark mode both look right (toggle OS appearance).
- The JSON importer (**Insert from JSON file**) is visually unchanged (regression check on the shared `formatBytes` export).

- [ ] **Step 4: Report**

Summarize suite + build results and the manual-QA outcome. Do not claim done without the manual check (CSS/visual correctness can't be asserted by the unit tests).

---

## Self-Review (completed during planning)

- **Spec coverage:** meta bar with rows/KB/columns (Task 3) ✓; toolbar Delimiter/Header/Infer (Task 2) ✓; inline Advanced collapsed-by-default with the other 7 options + visible hints (Task 2) ✓; Segmented/Toggle/chip controls (Task 1) ✓; tooltips on toolbar + hints in Advanced (Task 2) ✓; hero preview + type legend (Task 3) ✓; CSS add/remove + keep `:has` width + keep `.csv-cell-*` (Tasks 1–3) ✓; `formatBytes` exported, not duplicated (Task 3a) ✓; presentation-only, shared stages/parser/JSON wizard untouched ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type/name consistency:** `Segmented({value, options, onChange, testid})` and `Toggle({checked, onChange, title, testid})` signatures match every call site; option keys (`delimiter`/`quoteChar`/`escapeChar`/`doubleQuote`/`encoding`/`hasHeader`/`inferTypes`/`emptyMode`/`skipEmptyLines`/`trim`) unchanged from `DEFAULT_OPTS`; `data-testid="csv-infer"` preserved so the existing reparse test keeps working; legend uses `.csv-legend-*` (not `.csv-cell-*`) to avoid colliding with existing preview tests; `delimiterIsCustom` uses `DELIM_PRESET_VALUES` (the 4 real delimiters, excluding `__custom__`).
