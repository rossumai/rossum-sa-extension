# Stages View: Substituted Stage Definition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the MDH Stages view, add an opt-in read-only block under each active stage's header that shows that stage's own definition object with pipeline variables already substituted (the concrete stage as sent to the Data Storage API).

**Architecture:** Purely additive. `StagesView` already receives fully variable-substituted stage objects (`entry.stage`, computed in `DataPanel.jsx` via `substituteWithTypes` before `parseEntries`). We render `JSON.stringify(entry.stage, null, 2)` in a styled `<pre>` per active stage, gated by a new global signal `stagesShowDef` (default OFF), surfaced as a "Definitions" checkbox in the Stages options strip and persisted to `chrome.storage.local` (`mdhStagesShowDef`) exactly like the existing `stagesAutoscroll`.

**Tech Stack:** Preact + `@preact/signals`, esbuild, Vitest (jsdom), CSS custom properties in `console.css`.

## Global Constraints

- **Never leak customer names or customer data.** Tests and any examples use neutral placeholder values only (e.g. `AB-12`, `vendors`).
- **Backward compatibility:** no changes to the API, pipeline/data flow, `entry.stage` shape, editor connector, auto-scroll, sample-size, or count logic; no changes to any existing storage key. New key `mdhStagesShowDef` absent → feature OFF; view byte-identical to today.
- **Class name:** use `pipeline-inspect-stagedef` for the new block. Do NOT reuse `pipeline-inspect-def` — that is the class of a *removed* per-stage query box and is asserted absent by an existing test (`tests/mdh-stages-view.test.js:174`).
- **No copy button** (owner decision). **Default OFF** (owner decision).
- **Tests are `.test.js` using `h(Component, null)`** — never raw JSX in tests (oxc breaks on it). Reset the new signal in `beforeEach`/`afterEach` like `hoveredStage`.
- **Build after UI changes:** tests run against `src/`, but the loaded extension runs the esbuild `dist/`. Run `npm run build` before claiming the browser behavior works.

---

### Task 1: `stagesShowDef` signal + per-stage definition block + toggle + CSS

**Files:**
- Modify: `src/mdh/store.js` (add signal near `stagesAutoscroll`/`stagesSampleSize`, ~line 83)
- Modify: `src/mdh/components/StagesView.jsx` (import signal; add options-strip checkbox; render block in active-stage sections)
- Modify: `src/console/console.css` (add `.pipeline-inspect-stagedef` after `.pipeline-inspect-section-head` block, ~line 1507)
- Modify: `tests/mdh-stages-view.test.js` (import + reset signal; add rendering tests)

**Interfaces:**
- Consumes: `StagesView({ collection, entries, onToggleStage, inspectTarget })` — unchanged prop shape; `entry.stage` is a substituted plain JS object.
- Produces: `stagesShowDef` — a `@preact/signals` `signal(false)` exported from `src/mdh/store.js`. New DOM: `<pre class="pipeline-inspect-stagedef">` inside each active `.pipeline-inspect-section`, between `.pipeline-inspect-section-head` and `.pipeline-inspect-body`, present only when `stagesShowDef.value === true`. New options-strip control: a checkbox labeled "Definitions" bound to `stagesShowDef`.

- [ ] **Step 1: Add the `stagesShowDef` signal to the store**

In `src/mdh/store.js`, immediately after the existing `stagesSampleSize` line (`export const stagesSampleSize = signal(10);`, ~line 83), add:

```js
// Whether the Stages view shows each active stage's substituted definition
// (the concrete stage object as sent to the Data Storage API) in a read-only
// block under the stage header. Opt-in — default OFF so the fixed-height stage
// sections keep their full sample-output space until the user asks for it.
// Persisted as mdhStagesShowDef, wired like mdhStagesAutoscroll in index.jsx.
export const stagesShowDef = signal(false);
```

- [ ] **Step 2: Add signal import + reset to the test file**

In `tests/mdh-stages-view.test.js`, extend the store import (line 14) and the reset hooks (lines 52-54) so the new signal is isolated per test:

```js
import { hoveredStage, stagesShowDef } from '../src/mdh/store.js';
```

```js
afterEach(() => {
  if (currentRoot) { render(null, currentRoot); currentRoot = null; }
  document.body.innerHTML = '';
  hoveredStage.value = null;
  stagesShowDef.value = false;
});
beforeEach(() => { vi.clearAllMocks(); hoveredStage.value = null; stagesShowDef.value = false; });
```

- [ ] **Step 3: Write the failing tests**

Add these tests inside the `describe('StagesView', ...)` block in `tests/mdh-stages-view.test.js` (e.g. after the existing `'no longer renders the per-stage query box'` test):

```js
it('renders each active stage\'s substituted definition when Definitions is on', async () => {
  stagesShowDef.value = true;
  const entries = [
    { disabled: false, stage: { $match: { code: 'AB-12', qty: 100 } } },
    { disabled: false, stage: { $limit: 50 } },
  ];
  api.aggregate.mockResolvedValue({ result: [] });
  const root = mount({ collection: 'vendors', entries });
  await waitFor(() => root.querySelectorAll('.pipeline-inspect-stagedef').length === 2, 'two definition blocks');
  const defs = [...root.querySelectorAll('.pipeline-inspect-stagedef')].map((el) => el.textContent);
  // Faithful pretty-printed substituted stage object (values already resolved upstream).
  expect(defs[0]).toBe(JSON.stringify({ $match: { code: 'AB-12', qty: 100 } }, null, 2));
  expect(defs[0]).toContain('"code": "AB-12"');
  expect(defs[0]).toContain('"qty": 100');
  expect(defs[1]).toBe(JSON.stringify({ $limit: 50 }, null, 2));
});

it('renders no definition block when Definitions is off (default)', async () => {
  const entries = [{ disabled: false, stage: { $match: { x: 1 } } }];
  api.aggregate.mockResolvedValue({ result: [] });
  const root = mount({ collection: 'vendors', entries });
  await waitFor(() => root.querySelector('.pipeline-inspect-section'), 'section rendered');
  expect(root.querySelector('.pipeline-inspect-stagedef')).toBeNull();
});

it('renders no definition block for the input section or disabled stages', async () => {
  stagesShowDef.value = true;
  const entries = [
    { disabled: false, stage: { $match: { x: 1 } } },
    { disabled: true, stage: { $sort: { a: -1 } } },
  ];
  api.aggregate.mockResolvedValue({ result: [] });
  const root = mount({ collection: 'vendors', entries });
  await waitFor(() => root.querySelectorAll('.pipeline-inspect-stagedef').length === 1, 'exactly one def block');
  // Only the single active $match stage has a block: input (data-idx="-1") and the
  // disabled $sort do not.
  const inputSection = root.querySelector('.pipeline-inspect-section[data-idx="-1"]');
  expect(inputSection.querySelector('.pipeline-inspect-stagedef')).toBeNull();
  expect(root.querySelector('.pipeline-inspect-disabled .pipeline-inspect-stagedef')).toBeNull();
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `npx vitest run tests/mdh-stages-view.test.js -t "definition"`
Expected: the three new tests FAIL (`.pipeline-inspect-stagedef` not found → `querySelectorAll(...).length` never reaches the expected count, `waitFor` times out). The default-off test also currently passes trivially, but the on/exclusion tests fail.

- [ ] **Step 5: Import the signal and render the block in `StagesView.jsx`**

In `src/mdh/components/StagesView.jsx`, add `stagesShowDef` to the store import (line 7):

```js
import { hoveredStage, stagesAutoscroll, stagesSampleSize, STAGE_SAMPLE_SIZES, stagesShowDef } from '../store.js';
```

Read it alongside the other options (after `const autoscroll = stagesAutoscroll.value;`, ~line 82):

```js
  const showDef = stagesShowDef.value;
```

In the active-stage `return (...)` (the branch after `activeIdx += 1;`, ~lines 175-189), insert the definition block between `<StageHeader .../>` and `<div class="pipeline-inspect-body">`:

```jsx
              <StageHeader
                toggle={<StageToggle entryIndex={entryIndex} disabled={false} onToggle={onToggleStage} />}
                num={`${myIdx + 1}`} label={stageKey} prevCount={prevCount} count={counts[myIdx]?.count} ms={counts[myIdx]?.ms}
              />
              {showDef && (
                <pre class="pipeline-inspect-stagedef">{JSON.stringify(stage, null, 2)}</pre>
              )}
              <div class="pipeline-inspect-body">
                <div class="pipeline-inspect-output"><StageOutput info={previews[myIdx]} /></div>
              </div>
```

(`stage` is already declared as `const stage = entry.stage || {};` at the top of the `.map` callback; the input section and the disabled-stage branch are untouched, so neither gets a block.)

- [ ] **Step 6: Add the "Definitions" checkbox to the options strip**

In `src/mdh/components/StagesView.jsx`, in `.pipeline-inspect-opts`, add a checkbox after the existing Auto-scroll label (after the closing `</label>` at ~line 144):

```jsx
        <label class="pipeline-inspect-opt pipeline-inspect-autoscroll" title="Show each stage's query with variables substituted (as sent to the Data Storage API)">
          <input type="checkbox" checked={showDef} onChange={(e) => { stagesShowDef.value = e.currentTarget.checked; }} />
          <span>Definitions</span>
        </label>
```

(Reuses `.pipeline-inspect-autoscroll` for the generic checkbox-label ergonomics — cursor/user-select — matching the sibling toggle.)

- [ ] **Step 7: Add the `.pipeline-inspect-stagedef` CSS**

In `src/console/console.css`, after the `.pipeline-inspect-time-slow` rule (~line 1507, before the `.pipeline-inspect-body` comment block), add:

```css
/* Opt-in read-only block under an active stage's header: the stage's own
   definition with variables substituted (as sent to the DS API). Mono code
   block mirroring .inspector-code-block; capped + scrollable so a large stage
   never pushes the sample output out of the fixed-height section. */
.pipeline-inspect-stagedef {
  flex-shrink: 0; margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono); font-size: 12px;
  line-height: 1.4;
  background: var(--bg-code); color: var(--text-code);
  border-bottom: 1px solid var(--border);
  max-height: 160px; overflow: auto; overscroll-behavior: none;
  white-space: pre;
}
```

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `npx vitest run tests/mdh-stages-view.test.js`
Expected: all StagesView tests PASS, including the three new ones and the untouched `'no longer renders the per-stage query box'` test (it asserts the *old* `.pipeline-inspect-def` class is absent — still true, since our class is `.pipeline-inspect-stagedef`).

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 10: Build**

Run: `npm run build`
Expected: clean build into `dist/` (no errors).

---

### Task 2: Persist the toggle across reloads (`mdhStagesShowDef`)

**Files:**
- Modify: `src/mdh/index.jsx` (add key to the `chrome.storage.local.get` list; seed the signal on boot; add a persisting `effect`)
- Modify: `CLAUDE.md` (document the new global storage key)

**Interfaces:**
- Consumes: `store.stagesShowDef` (from Task 1).
- Produces: `chrome.storage.local` key `mdhStagesShowDef` (boolean). Seeded into `store.stagesShowDef` on MDH boot; written back whenever the signal changes. Absent/non-boolean → signal stays at its `false` default.

- [ ] **Step 1: Add the key to the boot read**

In `src/mdh/index.jsx`, add `'mdhStagesShowDef'` to the `chrome.storage.local.get([...])` array (currently line 126):

```js
  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch',
    'mdhStagesAutoscroll', 'mdhStagesSampleSize', 'mdhStagesShowDef',
  ]);
```

- [ ] **Step 2: Seed the signal from the stored value**

In `src/mdh/index.jsx`, after the `mdhStagesSampleSize` seed block (currently lines 151-153), add:

```js
  if (typeof stored.mdhStagesShowDef === 'boolean') {
    store.stagesShowDef.value = stored.mdhStagesShowDef;
  }
```

- [ ] **Step 3: Persist the signal on change**

In `src/mdh/index.jsx`, after the `mdhStagesSampleSize` persisting effect (currently lines 216-218), add:

```js
  effect(() => {
    chrome.storage.local.set({ mdhStagesShowDef: store.stagesShowDef.value });
  });
```

- [ ] **Step 4: Verify `store` and `effect` are already imported**

Run: `grep -n "import \* as store\|import { effect\|from '@preact/signals'" src/mdh/index.jsx`
Expected: `effect` is already imported (it backs the existing `mdhStagesAutoscroll`/`mdhStagesSampleSize` effects) and `store` is the namespace used above (`store.stagesShowDef`). No new imports needed. If `effect` is NOT listed, add it to the existing `@preact/signals` import.

- [ ] **Step 5: Document the storage key in CLAUDE.md**

In `CLAUDE.md`, in the "Chrome Storage Keys" → MDH state bullet, add `mdhStagesShowDef` to the list of **global** Stages options (alongside `mdhStagesAutoscroll`, `mdhStagesSampleSize`). Change:

```
`mdhStagesAutoscroll`, `mdhStagesSampleSize` are **global**
```

to:

```
`mdhStagesAutoscroll`, `mdhStagesSampleSize`, `mdhStagesShowDef` are **global**
```

Also update the StagesView description paragraph in CLAUDE.md's MDH section to mention the new option: after the sentence describing the options strip (**Records per stage** and **Auto-scroll**), add a sentence noting a **Definitions** checkbox (`store.stagesShowDef` → `mdhStagesShowDef`, default off) that shows each active stage's substituted definition (`JSON.stringify(entry.stage, null, 2)` in a `.pipeline-inspect-stagedef` block) — the concrete stage as sent to the DS API.

- [ ] **Step 6: Build and run the full suite**

Run: `npm run build && npm test`
Expected: clean build; all tests PASS.

- [ ] **Step 7: Manual browser verification**

Load `dist/` in Chrome (reload the extension), open the Console → Dataset Management, pick a collection, open the pipeline editor, add a stage referencing a variable (e.g. `{ "$match": { "code": "{code}" } }`), fill the variable, switch the results view to **Stages**, and:
1. Confirm the "Definitions" checkbox appears in the options strip and is **off** by default.
2. Turn it on → each active stage shows a `.pipeline-inspect-stagedef` block with the variable substituted to its concrete value (e.g. `"code": "AB-12"`); the input section and any disabled stage show none.
3. Reload the Console tab → the checkbox state is preserved.

---

## Self-Review

**Spec coverage:**
- Per-section substituted-definition block (spec §1) → Task 1 Steps 5, 7.
- Content = `JSON.stringify(entry.stage, null, 2)`, styled `<pre>`, capped/scroll, no copy button → Task 1 Steps 5, 7.
- "Definitions" toggle, default OFF, options strip, persisted `mdhStagesShowDef` (spec §2) → Task 1 Steps 1, 6; Task 2 Steps 1-3.
- Input stage: no block → Task 1 Step 5 (input branch untouched) + test Step 3.
- Disabled stages: no block → Task 1 Step 5 (disabled branch untouched) + test Step 3.
- Unfilled vars show `""` → inherent (renders `entry.stage` verbatim; substitution upstream) — no special code; covered by faithful-render tests.
- Backward compatibility (no existing-key/API/flow changes) → confirmed additive; default OFF keeps view identical.
- Privacy → tests use neutral values (`AB-12`, `vendors`); nothing persisted/logged/sent.
- Testing section of spec → Task 1 Step 3 (on/off/input/disabled) + full suite Step 9.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps — every code step shows exact code and every command shows expected output.

**Type consistency:** Signal named `stagesShowDef` everywhere (store export, StagesView import, index.jsx seed/effect, tests). Class named `pipeline-inspect-stagedef` everywhere (CSS, render, tests). Storage key `mdhStagesShowDef` everywhere (get list, seed, effect, CLAUDE.md). Local `showDef` used only inside StagesView.

**Note:** Substitution itself (raw `{var}` → typed value) happens upstream in `DataPanel.jsx` (`substituteWithTypes`) and is already covered by placeholder-type-inference tests; `StagesView` only renders the already-substituted `entry.stage`, so its tests assert faithful rendering of a concrete stage object.
