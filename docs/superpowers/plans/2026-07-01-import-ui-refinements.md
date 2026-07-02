# Import UI Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preselect the CSV delimiter, replace the messy import summary with one tight sentence, drop the redundant "Mode" label, and turn the match-key picker into a focus-combobox with an overlay dropdown + keyboard navigation.

**Architecture:** A pure `detectDelimiter` in `csv.js` + an optional per-format `detectOpts(input)` hook the wizard calls once on file load; a one-line `.import-summary` in `ImportConfirm` (replacing `ModeHelp` + the callout box) and removal of the "Mode" label; and a combobox rewrite of `MatchKeyPicker` (focus-open, absolute overlay, arrow/Enter/Esc). Parsers, the mode/plan/execute pipeline, and match semantics are unchanged.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom.

## Global Constraints

- **Build:** esbuild only, classic JSX pragma `h`/`Fragment`. Run `npm run build` after UI changes.
- **Tests:** Vitest, `tests/**/*.test.js`; DOM tests start `// @vitest-environment jsdom`; mock API via `vi.mock('../src/mdh/api.js')`; mount `h(Component, props)` + Preact `render`; condition-based `waitFor`, never fixed sleeps. One file: `npx vitest run tests/<name>.test.js`; full: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attrs — use `{'…'}`/literal char/entity. Fine in JS strings.
- **Delimiter detection only seeds the initial UI value** — the parse still uses the current `opts`; the user can override the pill. `detectOpts` is OPTIONAL per format (only CSV provides it).
- **Keep test-facing anchors:** `data-testid="import-plan"` stays on the summary line; MatchKeyPicker keeps `match-keys`/`match-key-input`/`match-key-suggest`/`.match-key-suggest-item`/`.match-key-chip*`; CSV delimiter buttons keep `csv-delim-comma|semicolon|tab`.
- **Backward compatibility:** MatchKeyPicker stays controlled (`paths`,`keys`,`setKeys`); `ImportConfirm` keeps its props/`plan.counts` contract. No storage-key changes.
- **Commits:** the project owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless explicitly asked. Stay on `master`; no branches. (Layers on prior uncommitted import work in the same tree.)

---

## File Structure
- `src/mdh/csv.js` — add `detectDelimiter(text)`.
- `src/mdh/formats/csv.jsx` — add `detectOpts(arrayBuffer)`; export it on the format.
- `src/mdh/components/ImportWizard.jsx` — seed initial opts via `detectOpts` in `handleFile`.
- `src/mdh/components/ImportConfirm.jsx` — remove "Mode" label + `ModeHelp`; render the tight `.import-summary` sentence.
- `src/mdh/components/MatchKeyPicker.jsx` — focus-combobox + keyboard nav.
- `src/console/console.css` — `.import-summary`; overlay `.match-key-suggest` + `.active`; remove dead callout/mode-help rules.

Tests: extend `tests/mdh-csv.test.js`, `tests/mdh-formats.test.js`, `tests/mdh-import-wizard.test.js`, `tests/mdh-import-confirm.test.js`; rewrite `tests/mdh-match-key-picker.test.js`.

---

## Task 1: `detectDelimiter` (csv.js)

**Files:** Modify `src/mdh/csv.js`; Test `tests/mdh-csv.test.js`

**Interfaces:** Produces `detectDelimiter(text) -> ',' | ';' | '\t'`.

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-csv.test.js` (add `detectDelimiter` to its import from `../src/mdh/csv.js`):
```js
describe('detectDelimiter', () => {
  it('detects comma, semicolon, and tab', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('picks the most frequent across the first non-empty lines', () => {
    // semicolons: 3 (one per line); commas: 1 (inside a value) -> semicolon wins
    expect(detectDelimiter('name;note\nAlice;hello, world\nBob;hi')).toBe(';');
  });
  it('defaults to comma on ties or when no delimiter is present', () => {
    expect(detectDelimiter('singlecolumn\nvalue')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-csv.test.js`

- [ ] **Step 3: Implement** — add to `src/mdh/csv.js` (export near the other exports):
```js
// Guess the delimiter for preselection: count raw occurrences of each candidate
// across the first few non-empty lines; the most frequent (>0) wins, else comma.
// Comma is preferred on a tie (it is the first candidate). Detection only seeds
// the UI — the user can override, and the parse honors the chosen delimiter.
export function detectDelimiter(text) {
  const CANDIDATES = [',', ';', '\t'];
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5);
  let best = ',';
  let bestCount = 0;
  for (const cand of CANDIDATES) {
    let count = 0;
    for (const line of lines) count += line.split(cand).length - 1;
    if (count > bestCount) { bestCount = count; best = cand; }
  }
  return best;
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-csv.test.js`
- [ ] **Step 5: Commit** — `git add src/mdh/csv.js tests/mdh-csv.test.js && git commit -m "feat(mdh): detectDelimiter for CSV preselection"`

---

## Task 2: `detectOpts` on the CSV format + wizard seeding

**Files:** Modify `src/mdh/formats/csv.jsx`, `src/mdh/components/ImportWizard.jsx`; Test `tests/mdh-formats.test.js`, `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes `detectDelimiter` from `../csv.js`.
- Produces `csv` format `detectOpts(arrayBuffer) -> { delimiter }`. `ImportWizard.handleFile` seeds `opts = { ...f.defaultOpts, ...f.detectOpts(input) }` when `f.detectOpts` exists.

- [ ] **Step 1: Write failing tests.**
Append to `tests/mdh-formats.test.js`:
```js
describe('csv detectOpts', () => {
  it('autodetects the delimiter from an ArrayBuffer sample', () => {
    const buf = new TextEncoder().encode('a;b\n1;2\n').buffer;
    expect(getFormat('csv').detectOpts(buf)).toEqual({ delimiter: ';' });
  });
  it('only CSV provides detectOpts', () => {
    expect(typeof getFormat('csv').detectOpts).toBe('function');
    expect(getFormat('json').detectOpts).toBeUndefined();
    expect(getFormat('xlsx').detectOpts).toBeUndefined();
    expect(getFormat('xml').detectOpts).toBeUndefined();
  });
});
```
Append to `tests/mdh-import-wizard.test.js` (it has `mount`, `waitFor`, `file`, `pick`, and mocks api):
```js
it('preselects the detected delimiter for a semicolon CSV', async () => {
  const root = mount(h(ImportWizard, { onSuccess() {} }));
  pick(root, file('a;b\n1;2\n', 'rows.csv'));
  const semi = await waitFor(() => root.querySelector('[data-testid="csv-delim-semicolon"]'));
  expect(semi.getAttribute('aria-pressed')).toBe('true');
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-formats.test.js tests/mdh-import-wizard.test.js`

- [ ] **Step 3: Implement.**
In `src/mdh/formats/csv.jsx`: change the import and add `detectOpts`, then export it:
```jsx
import { parseCsv, detectDelimiter } from '../csv.js';
```
```jsx
// Sniff initial options from the raw file (decode a UTF-8 sample) so the
// Delimiter pill is preselected. Best-effort: any failure returns {}.
function detectOpts(arrayBuffer) {
  try {
    const sample = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer).subarray(0, 65536));
    return { delimiter: detectDelimiter(sample) };
  } catch {
    return {};
  }
}

export default { id: 'csv', label: 'CSV', accept: '.csv,text/csv', read: 'arrayBuffer', defaultOpts: DEFAULT_OPTS, parse, detectOpts, ConfigureControls };
```
In `src/mdh/components/ImportWizard.jsx` `handleFile`, REMOVE the pre-read `setOpts(f.defaultOpts);` line, and inside the `read.then((input) => …)` callback seed detected opts and parse with them. Replace:
```js
    read.then(async (input) => {
      setRawInput(input);
      if (f.ConfigureControls) { setStage(STAGE.CONFIGURE); return; }
      const res = await Promise.resolve(f.parse(input, f.defaultOpts));
```
with:
```js
    read.then(async (input) => {
      setRawInput(input);
      const initialOpts = f.detectOpts ? { ...f.defaultOpts, ...f.detectOpts(input) } : f.defaultOpts;
      setOpts(initialOpts);
      if (f.ConfigureControls) { setStage(STAGE.CONFIGURE); return; }
      const res = await Promise.resolve(f.parse(input, initialOpts));
```
(Leave the rest of the `.then` — the `res.error`/`!res.docs.length`/`setParsed`/`setKeys`/`setStage(CONFIRM)` lines — unchanged. Ensure the standalone `setOpts(f.defaultOpts);` that ran before `setFileMeta`/`read` is deleted so the detected value isn't overwritten.)

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-formats.test.js tests/mdh-import-wizard.test.js`
- [ ] **Step 5: Commit** — `git add src/mdh/formats/csv.jsx src/mdh/components/ImportWizard.jsx tests/mdh-formats.test.js tests/mdh-import-wizard.test.js && git commit -m "feat(mdh): preselect autodetected CSV delimiter"`

---

## Task 3: Match-key picker → focus-combobox with overlay + keyboard nav

**Files:** Modify `src/mdh/components/MatchKeyPicker.jsx`, `src/console/console.css`; Test `tests/mdh-match-key-picker.test.js` (rewrite)

**Interfaces:** `MatchKeyPicker({ paths, keys, setKeys })` unchanged signature. New behavior: suggestions open on focus; overlay dropdown; ArrowUp/Down move an `.active` item; Enter adds the active item; Escape closes; Backspace-empty removes last chip; click uses mousedown-preventDefault.

- [ ] **Step 1: Rewrite the test** — replace the entire contents of `tests/mdh-match-key-picker.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import MatchKeyPicker from '../src/mdh/components/MatchKeyPicker.jsx';

function mount(node) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const s = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout'); await new Promise((r) => setTimeout(r, interval)); }
}
const PATHS = ['_id', 'sku', 'address.zip', 'address.country', 'vendor.id'];
const focus = (el) => el.dispatchEvent(new Event('focus', { bubbles: true }));
const keydown = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('MatchKeyPicker', () => {
  it('renders selected keys as chips', () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id'], setKeys() {} }));
    expect(root.querySelector('[data-testid="match-keys"]')).toBeTruthy();
    expect([...root.querySelectorAll('.match-key-chip')].some((c) => c.textContent.includes('_id'))).toBe(true);
  });

  it('shows all available suggestions on focus, before typing', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
    focus(root.querySelector('[data-testid="match-key-input"]'));
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    expect([...root.querySelectorAll('.match-key-suggest-item')].map((b) => b.textContent)).toEqual(PATHS);
  });

  it('excludes already-selected paths', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['sku'], setKeys() {} }));
    focus(root.querySelector('[data-testid="match-key-input"]'));
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    expect([...root.querySelectorAll('.match-key-suggest-item')].map((b) => b.textContent)).not.toContain('sku');
  });

  it('ArrowDown moves the active option and Enter adds it', async () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    focus(input);
    await waitFor(() => root.querySelector('.match-key-suggest-item.active'));
    keydown(input, 'ArrowDown');
    await waitFor(() => { const items = [...root.querySelectorAll('.match-key-suggest-item')]; return items[1]?.classList.contains('active'); });
    keydown(input, 'Enter');
    expect(setKeys).toHaveBeenCalledWith([PATHS[1]]); // 'sku'
  });

  it('Escape closes the dropdown', async () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    focus(input);
    await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
    keydown(input, 'Escape');
    await waitFor(() => !root.querySelector('[data-testid="match-key-suggest"]'));
    expect(root.querySelector('[data-testid="match-key-suggest"]')).toBeNull();
  });

  it('filters by query and clicking a suggestion adds it (mousedown-safe)', async () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id'], setKeys }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    input.value = 'address'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => root.querySelectorAll('.match-key-suggest-item').length >= 2);
    const first = root.querySelector('.match-key-suggest-item');
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    first.click();
    expect(setKeys).toHaveBeenCalledWith(['_id', 'address.zip']);
  });

  it('Backspace on empty input removes the last chip', () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id', 'sku'], setKeys }));
    keydown(root.querySelector('[data-testid="match-key-input"]'), 'Backspace');
    expect(setKeys).toHaveBeenCalledWith(['_id']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-match-key-picker.test.js`

- [ ] **Step 3: Implement** — replace the entire contents of `src/mdh/components/MatchKeyPicker.jsx`:
```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';

// Controlled match-key combobox: selected keys as chips + a filter input that
// opens an overlay suggestion list on focus. Keyboard: Arrow up/down move the
// active option, Enter adds it, Escape closes, Backspace on an empty input
// removes the last chip. `paths` arrive pre-sorted; order is preserved.
export default function MatchKeyPicker({ paths, keys, setKeys }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const q = query.trim().toLowerCase();
  const available = paths.filter((p) => !keys.includes(p));
  const suggestions = (q ? available.filter((p) => p.toLowerCase().includes(q)) : available).slice(0, 50);
  const open = focused && suggestions.length > 0;
  const active = Math.min(activeIndex, suggestions.length - 1);

  function add(p) {
    if (!keys.includes(p)) setKeys([...keys, p]);
    setQuery('');
    setActiveIndex(0);
  }
  function remove(p) { setKeys(keys.filter((k) => k !== p)); }
  function onInput(e) { setQuery(e.target.value); setActiveIndex(0); setFocused(true); }
  function onKeyDown(e) {
    if (open && e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(Math.min(active + 1, suggestions.length - 1)); }
    else if (open && e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(Math.max(active - 1, 0)); }
    else if (open && e.key === 'Enter') { e.preventDefault(); add(suggestions[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setFocused(false); }
    else if (e.key === 'Backspace' && query === '' && keys.length > 0) { remove(keys[keys.length - 1]); }
  }

  return (
    <div class="match-key-picker" data-testid="match-keys">
      <div class="match-key-chips">
        {keys.map((k) => (
          <span class="match-key-chip" key={k}>
            {k}
            <button type="button" class="match-key-chip-x" aria-label={`Remove ${k}`} onClick={() => remove(k)}>{'✕'}</button>
          </span>
        ))}
        <input
          class="match-key-input"
          type="text"
          value={query}
          placeholder={keys.length ? 'Add another field…' : 'Type or pick a field…'}
          data-testid="match-key-input"
          onInput={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); setActiveIndex(0); }}
          onBlur={() => setFocused(false)}
        />
      </div>
      {open && (
        <div class="match-key-suggest" data-testid="match-key-suggest">
          {suggestions.map((p, i) => (
            <button
              type="button"
              class={`match-key-suggest-item${i === active ? ' active' : ''}`}
              key={p}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(p)}
            >{p}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update CSS** — in `src/console/console.css`, REPLACE the existing `.match-key-picker { … }` and `.match-key-suggest { … }` rules with the overlay versions, and add `.active`:
```css
.match-key-picker { position: relative; margin-top: 4px; }
.match-key-suggest {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 20; margin-top: 4px;
  max-height: 220px; overflow: auto;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-card);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.match-key-suggest-item.active { background: var(--bg-hover); }
```
(Leave `.match-key-chips`, `.match-key-chip`, `.match-key-chip-x`, `.match-key-input`, `.match-key-suggest-item` base rules as-is.)

- [ ] **Step 5: Run, expect PASS + build** — `npx vitest run tests/mdh-match-key-picker.test.js` then `npm run build`
- [ ] **Step 6: Commit** — `git add src/mdh/components/MatchKeyPicker.jsx src/console/console.css tests/mdh-match-key-picker.test.js && git commit -m "feat(mdh): match-key combobox (focus-open, overlay, keyboard nav)"`

---

## Task 4: Tight summary sentence + remove "Mode" label (ImportConfirm)

**Files:** Modify `src/mdh/components/ImportConfirm.jsx`, `src/console/console.css`; Test `tests/mdh-import-confirm.test.js`

**Interfaces:** `ImportConfirm` props unchanged. The `.import-summary` line carries `data-testid="import-plan"`.

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-import-confirm.test.js`:
```js
it('has no "Mode" field label above the tabs', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'update' }));
  expect([...root.querySelectorAll('.modal-field-label')].some((e) => e.textContent.trim() === 'Mode')).toBe(false);
});
it('renders no separate mode-help paragraph', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'update' }));
  expect(root.querySelector('[data-testid="mode-help"]')).toBeNull();
});
it('summary is one sentence for an update+upsert plan', () => {
  const plan = { blocked: false, ambiguous: [], inFileDupes: [], missingKey: [], counts: { willApply: 12, willInsert: 3, willSkip: 0, blocked: false } };
  const root = mount(h(ImportConfirm, { ...base, mode: 'update', upsert: true, keys: ['sku'], plan }));
  const s = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(s).toMatch(/update/i); expect(s).toMatch(/12/); expect(s).toMatch(/insert/i); expect(s).toMatch(/3/); expect(s).toMatch(/sku/);
});
it('summary for insert mode reads as a new-documents sentence', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  const s = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(s).toMatch(/insert/i); expect(s).toMatch(/new document/i);
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-confirm.test.js`

- [ ] **Step 3: Implement** in `src/mdh/components/ImportConfirm.jsx`:
1. DELETE the `function ModeHelp({ mode, upsert }) { … }` definition entirely (and its `tail` local).
2. DELETE the `<div class="modal-field-label">Mode</div>` line (leave the `<Segmented … testid="import-mode" tabs />` immediately after).
3. REPLACE the whole `<div class="import-summary-callout">…</div>` block with this single line (same position — after the warnings, before `<div class="modal-actions">`):
```jsx
      <div class="import-summary" data-testid="import-plan">
        {!isMatch && (
          <span>Will insert <strong>{insertCount.toLocaleString()}</strong> new document{insertCount === 1 ? '' : 's'}.
            {insertStats.inFileDupeCount > 0 && (
              <span> {'·'} <strong>{insertStats.inFileDupeCount.toLocaleString()}</strong> in-file duplicate _id{insertStats.inFileDupeCount === 1 ? '' : 's'} collapsed</span>
            )}
          </span>
        )}
        {isMatch && keys.length === 0 && <span>Select a match field to preview what will happen.</span>}
        {isMatch && keys.length > 0 && (planLoading || !plan) && <span>Analyzing{'…'}</span>}
        {isMatch && keys.length > 0 && !planLoading && plan && (
          <span>Will <strong>{verb.toLowerCase()}</strong> <strong>{plan.counts.willApply.toLocaleString()}</strong> record{plan.counts.willApply === 1 ? '' : 's'} matched by <code>{keys.join(', ')}</code>, insert <strong>{plan.counts.willInsert.toLocaleString()}</strong> new, skip <strong>{plan.counts.willSkip.toLocaleString()}</strong>.</span>
        )}
      </div>
```
(`verb` and `insertStats`/`insertCount` already exist in the component. `Fragment` stays imported — still used by the match-key/upsert block.)

- [ ] **Step 4: Update CSS** — in `src/console/console.css`, ADD:
```css
.import-summary { margin-top: 14px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.import-summary strong { color: var(--text-primary); }
.import-summary code { font-family: var(--font-mono); font-size: 11px; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-primary); }
```
And REMOVE the now-unused rules: `.import-summary-callout`, `.import-summary-callout .import-mode-help`, `.import-summary-plan`, `.import-summary-plan strong`, `.import-mode-help`, `.import-mode-help code`.

- [ ] **Step 5: Run, expect PASS + build** — `npx vitest run tests/mdh-import-confirm.test.js` then `npm run build`, then `npm test` (full suite green; a known pre-existing flaky may appear under full-suite load — re-run it alone).
- [ ] **Step 6: Commit** — `git add src/mdh/components/ImportConfirm.jsx src/console/console.css tests/mdh-import-confirm.test.js && git commit -m "feat(mdh): one-line import summary; drop Mode label + ModeHelp"`

---

## Self-Review

**Spec coverage:** delimiter autodetect → Tasks 1+2; summary redesign → Task 4; remove Mode label → Task 4; default options on focus → Task 3; overlay + keyboard nav → Task 3. ✓

**Placeholder scan:** every code step has complete code / exact replace targets; no TBD/"handle edge cases". ✓

**Type consistency:** `detectDelimiter` (Task 1) consumed by `detectOpts` (Task 2); `detectOpts(input)` shape `{ delimiter }` matches the wizard's `{ ...f.defaultOpts, ...f.detectOpts(input) }` spread; MatchKeyPicker keeps `{ paths, keys, setKeys }` + all testids; `.import-summary` keeps `data-testid="import-plan"` consumed by the Task-4 tests; `verb`/`insertStats`/`plan.counts` names match the existing component. ✓
