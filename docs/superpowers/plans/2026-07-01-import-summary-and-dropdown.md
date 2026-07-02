# Import Summary Wording + Dropdown Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the import summary into a short explanatory block (how the mode works + this run's counts), and make the match-key dropdown a `position: fixed` popup that escapes the modal's clipping so users never scroll the modal to see suggestions.

**Architecture:** `ImportConfirm`'s `.import-summary` line gets fuller per-mode wording (mechanic sentence + "This run:" counts, flipping with upsert). `MatchKeyPicker`'s dropdown is anchored to the input's `getBoundingClientRect()` and rendered `position: fixed` (no portal — no modal ancestor traps fixed), with flip-up + capped max-height + reposition on scroll/resize.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom.

## Global Constraints

- **Build:** esbuild only, classic JSX pragma `h`/`Fragment`. Run `npm run build` after UI changes.
- **Tests:** Vitest, `tests/**/*.test.js`; DOM tests start `// @vitest-environment jsdom`; mount `h(Component, props)` + Preact `render`; condition-based `waitFor`, never fixed sleeps. One file: `npx vitest run tests/<name>.test.js`; full: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attrs — use `{'…'}`/`{'—'}`/literal char. Fine in JS strings.
- **Keep test anchors:** `.import-summary` keeps `data-testid="import-plan"`; MatchKeyPicker keeps `match-keys`/`match-key-input`/`match-key-suggest`/`.match-key-suggest-item`/`.match-key-chip*`/`.active`.
- **No new deps, no portal.** Fixed positioning is valid because no modal ancestor sets transform/filter/will-change/perspective/contain.
- **Backward compatibility:** component props unchanged; existing tests use substring/structural matches that must keep passing. No storage-key changes.
- **Commits:** the project owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless explicitly asked. Stay on `master`; no branches. (Layers on prior uncommitted import work.)

---

## File Structure
- `src/mdh/components/ImportConfirm.jsx` — expanded `.import-summary` copy (four branches).
- `src/mdh/components/MatchKeyPicker.jsx` — `inputRef` + `box` state + `useLayoutEffect` measure/reposition + inline-styled fixed dropdown.
- `src/console/console.css` — `.match-key-suggest` → `position: fixed; z-index: 250` (drop absolute offsets).

Tests: extend `tests/mdh-import-confirm.test.js`, `tests/mdh-match-key-picker.test.js`.

---

## Task 1: Expanded summary wording (ImportConfirm)

**Files:** Modify `src/mdh/components/ImportConfirm.jsx`; Test `tests/mdh-import-confirm.test.js`

**Interfaces:** No prop/signature change. `.import-summary` keeps `data-testid="import-plan"`.

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-import-confirm.test.js`:
```js
it('summary explains the update mechanic and shows this-run counts', () => {
  const plan = { blocked: false, ambiguous: [], inFileDupes: [], missingKey: [], counts: { willApply: 12, willInsert: 3, willSkip: 0, blocked: false } };
  const root = mount(h(ImportConfirm, { ...base, mode: 'update', upsert: true, keys: ['sku'], plan }));
  const s = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(s).toMatch(/matches each row/i);
  expect(s).toMatch(/overwrites/i);
  expect(s).toMatch(/sku/);
  expect(s).toMatch(/This run/i);
  expect(s).toMatch(/12/); expect(s).toMatch(/3/);
});
it('summary explains the replace mechanic (whole-document)', () => {
  const plan = { blocked: false, ambiguous: [], inFileDupes: [], missingKey: [], counts: { willApply: 5, willInsert: 0, willSkip: 2, blocked: false } };
  const root = mount(h(ImportConfirm, { ...base, mode: 'replace', upsert: false, keys: ['sku'], plan }));
  const s = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(s).toMatch(/replaces the whole document/i);
  expect(s).toMatch(/skipped/i);
  expect(s).toMatch(/5/); expect(s).toMatch(/2/);
});
it('summary explains insert and counts new documents', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  const s = root.querySelector('[data-testid="import-plan"]').textContent;
  expect(s).toMatch(/new document/i);
  expect(s).toMatch(/rejected/i);
});
```
(Existing summary tests use substring matches — `/update/i`, `/insert/i`, `/12/`, `/3/`, `/sku/`, `/new document/i` — which the expanded copy still satisfies; keep them.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-confirm.test.js`

- [ ] **Step 3: Implement** — replace the `<div class="import-summary" data-testid="import-plan"> … </div>` block in `src/mdh/components/ImportConfirm.jsx` with:
```jsx
      <div class="import-summary" data-testid="import-plan">
        {!isMatch && (
          <span>Adds every row as a new document. If a row's <code>_id</code> already exists the insert is rejected and reported afterward {'—'} nothing already in the collection is changed. <strong>This file adds {insertCount.toLocaleString()} new document{insertCount === 1 ? '' : 's'}.</strong>
            {insertStats.inFileDupeCount > 0 && (
              <span> {insertStats.inFileDupeCount.toLocaleString()} in-file duplicate <code>_id</code>{insertStats.inFileDupeCount === 1 ? '' : 's'} are collapsed first.</span>
            )}
          </span>
        )}
        {isMatch && keys.length === 0 && <span>Choose one or more fields to match existing records by.</span>}
        {isMatch && keys.length > 0 && (planLoading || !plan) && <span>Analyzing{'…'}</span>}
        {isMatch && keys.length > 0 && !planLoading && plan && (
          <span>
            Matches each row to an existing record by <code>{keys.join(', ')}</code>, then{' '}
            {mode === 'replace'
              ? <Fragment>replaces the whole document with the row (anything not in the row is removed; <code>_id</code> is kept)</Fragment>
              : <Fragment>overwrites that record's fields with the row's values (fields not in the file stay as they are)</Fragment>}.
            {' '}Rows that match nothing are {upsert ? 'added as new documents' : 'skipped'}.{' '}
            <strong>This run: {plan.counts.willApply.toLocaleString()} {mode === 'replace' ? 'replaced' : 'updated'},{' '}
            {upsert
              ? <Fragment>{plan.counts.willInsert.toLocaleString()} inserted</Fragment>
              : <Fragment>{plan.counts.willSkip.toLocaleString()} skipped</Fragment>}.</strong>
          </span>
        )}
      </div>
```
(`Fragment`, `verb`, `insertStats`, `insertCount`, `plan` already exist in the component. Note `verb` is no longer referenced in this block — that's fine, it's still used for `goLabel` above. Leave everything else in the component unchanged.)

- [ ] **Step 4: Run, expect PASS + build** — `npx vitest run tests/mdh-import-confirm.test.js` then `npm run build`
- [ ] **Step 5: Commit** — `git add src/mdh/components/ImportConfirm.jsx tests/mdh-import-confirm.test.js && git commit -m "feat(mdh): expand import summary wording (mechanic + this-run counts)"`

---

## Task 2: Fixed-position match-key dropdown (escape modal clip)

**Files:** Modify `src/mdh/components/MatchKeyPicker.jsx`, `src/console/console.css`; Test `tests/mdh-match-key-picker.test.js`

**Interfaces:** `MatchKeyPicker({ paths, keys, setKeys })` unchanged. Dropdown is now `position: fixed`, anchored to the input rect, with flip-up + capped height + reposition.

- [ ] **Step 1: Write failing test** — append to `tests/mdh-match-key-picker.test.js`:
```js
it('positions the open dropdown as an anchored popup (escapes modal clip)', async () => {
  const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys() {} }));
  focus(root.querySelector('[data-testid="match-key-input"]'));
  const sugg = await waitFor(() => root.querySelector('[data-testid="match-key-suggest"]'));
  const style = sugg.getAttribute('style') || '';
  expect(style).toMatch(/max-height:/);
  expect(/top:|bottom:/.test(style)).toBe(true);
  expect(style).toMatch(/width:/);
});
```
(`focus`/`keydown`/`waitFor`/`PATHS` already exist in this file from the previous combobox task.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-match-key-picker.test.js`

- [ ] **Step 3: Implement** — replace the entire contents of `src/mdh/components/MatchKeyPicker.jsx`:
```jsx
import { h } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';

const PAD = 8, GAP = 4, MIN_DROP = 180, MAX_DROP = 260;

// Controlled match-key combobox. The suggestion list is a position:fixed popup
// anchored to the input's on-screen rect, so it escapes the modal's overflow
// clipping (no modal ancestor establishes a fixed containing block). It flips
// above the input when there isn't room below, caps its height to the viewport,
// and re-anchors on scroll/resize while open.
export default function MatchKeyPicker({ paths, keys, setKeys }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [box, setBox] = useState(null);
  const inputRef = useRef(null);

  const q = query.trim().toLowerCase();
  const available = paths.filter((p) => !keys.includes(p));
  const suggestions = (q ? available.filter((p) => p.toLowerCase().includes(q)) : available).slice(0, 50);
  const open = focused && suggestions.length > 0;
  const active = Math.min(activeIndex, suggestions.length - 1);

  useLayoutEffect(() => {
    if (!open) { setBox(null); return undefined; }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - PAD;
      const above = r.top - PAD;
      const flip = below < MIN_DROP && above > below;
      const maxHeight = Math.max(80, Math.min(MAX_DROP, (flip ? above : below) - GAP));
      setBox({
        left: r.left,
        width: r.width,
        maxHeight,
        ...(flip ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

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

  const boxStyle = box
    ? `left:${box.left}px;width:${box.width}px;max-height:${box.maxHeight}px;${box.top != null ? `top:${box.top}px` : `bottom:${box.bottom}px`}`
    : '';

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
          ref={inputRef}
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
      {open && box && (
        <div class="match-key-suggest" data-testid="match-key-suggest" style={boxStyle}>
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

- [ ] **Step 4: Update CSS** — in `src/console/console.css`, REPLACE the `.match-key-suggest { … }` rule with the fixed version (keep `.match-key-picker`, `.match-key-suggest-item`, `.active` as-is):
```css
.match-key-suggest {
  position: fixed; z-index: 250; overflow: auto;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-card);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
```
(The `left`/`width`/`top`/`bottom`/`max-height` come from the inline style; `z-index: 250` sits above the `.modal-overlay` z-index 200. The old `top:100%; left:0; right:0; margin-top:4px; max-height:220px` are removed.)

- [ ] **Step 5: Run, expect PASS + build** — `npx vitest run tests/mdh-match-key-picker.test.js` then `npm run build`, then `npm test` (full suite green; a known pre-existing flaky may appear under full-suite load — re-run it alone).
- [ ] **Step 6: Commit** — `git add src/mdh/components/MatchKeyPicker.jsx src/console/console.css tests/mdh-match-key-picker.test.js && git commit -m "feat(mdh): fixed-position match-key dropdown (escapes modal clip)"`

---

## Self-Review

**Spec coverage:** expanded summary → Task 1; fixed-position dropdown (flip-up, capped height, reposition, z-index, no portal) → Task 2. ✓

**Placeholder scan:** every code step has complete code / exact replace targets; no TBD/"handle edge cases". ✓

**Type consistency:** Task 1 keeps `data-testid="import-plan"` (asserted by both new and existing tests) and reuses existing `insertCount`/`insertStats`/`plan.counts`/`verb`; Task 2 keeps `MatchKeyPicker({ paths, keys, setKeys })` + all testids/classes; `.match-key-suggest` CSS `position: fixed` pairs with the inline `left/width/max-height/top|bottom` the component emits; `box` shape (`{left,width,maxHeight,top?|bottom?}`) matches `boxStyle`. ✓
