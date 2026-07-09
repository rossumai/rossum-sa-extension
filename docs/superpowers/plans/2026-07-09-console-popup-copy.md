# Console-aware Popup Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the popup's active tab is the extension's own Console page, replace the "This tab isn't supported by the extension." lede with "You're on the Rossum Console." — keeping the rest of the panel (Rossum-tab switcher / static fallback) exactly as-is.

**Architecture:** Add an `isConsoleTab(url)` helper to `src/popup/utils.js`; compute it in `App.jsx` when there's no detected site and pass it to `UnsupportedSite`, which swaps only the lede line. `UnsupportedSite` is exported so it can be unit-tested.

**Tech Stack:** Preact, Vitest (jsdom).

## Global Constraints

- Lede for the Console, verbatim: **`You're on the Rossum Console.`** For any other unsupported tab, the lede stays **`This tab isn't supported by the extension.`**
- Copy-only: no new actions, buttons, or Console-specific UI. The tab switcher, the "It works on … Open one of these sites to get started." fallback, and the "Also works on NetSuite and Coupa." footnote are unchanged.
- No manifest change, no new permission (`activeTab` already exposes the active tab's URL on click), no new chrome.storage keys.
- Prop is named `isConsole` (not `console`) to avoid shadowing the global `console`.
- No git commits in this run (owner rule) — stay on `master`, leave changes uncommitted; each task's final step is a test gate. Per-task diffs are working-tree diffs scoped to the task's files.
- Tests: `// @vitest-environment jsdom`, `h(Component, props)` + preact `render`, `vi.mock`.

---

### Task 1: `isConsoleTab` helper

**Files:**
- Modify: `src/popup/utils.js` (add exported `isConsoleTab`)
- Test: `tests/popup-utils.test.js` (add an `isConsoleTab` describe block + import)

**Interfaces:**
- Produces: `isConsoleTab(url: string) => boolean` — true iff `url` starts with `chrome.runtime.getURL('console/console.html')`.

- [ ] **Step 1: Write the failing test**

In `tests/popup-utils.test.js`, add `isConsoleTab` to the existing import line:

```javascript
import { runInTab, openConsoleTab, detectSite, findRossumTabs, activateTab, isConsoleTab } from '../src/popup/utils.js';
```

Then add this describe block at the end of the file (before the final closing lines). The file's `beforeEach` already sets `chrome.runtime.getURL = (path) => \`chrome-extension://abc/${path}\``:

```javascript
describe('isConsoleTab', () => {
  it('matches this extension\'s Console page, with or without a query string', () => {
    expect(isConsoleTab('chrome-extension://abc/console/console.html')).toBe(true);
    expect(isConsoleTab('chrome-extension://abc/console/console.html?authId=x')).toBe(true);
  });

  it('rejects other extensions, other own-pages, sites, and empty input', () => {
    expect(isConsoleTab('chrome-extension://zzz/console/console.html')).toBe(false);
    expect(isConsoleTab('chrome-extension://abc/popup/popup.html')).toBe(false);
    expect(isConsoleTab('https://elis.rossum.ai/queues')).toBe(false);
    expect(isConsoleTab('')).toBe(false);
    expect(isConsoleTab(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/popup-utils.test.js`
Expected: FAIL — `isConsoleTab` is not exported (import resolves to `undefined`, so calling it throws / assertions fail).

- [ ] **Step 3: Add the helper**

In `src/popup/utils.js`, add immediately after the `detectSite` function (after its closing `}` near line 14):

```javascript
// True when the URL is this extension's own Console page. chrome.runtime.getURL
// embeds our extension id, so this matches only our Console — never another
// extension's pages or a real site. The Console URL carries a ?authId=... query,
// which startsWith tolerates.
export function isConsoleTab(url) {
  return !!url && url.startsWith(chrome.runtime.getURL('console/console.html'));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/popup-utils.test.js`
Expected: PASS (existing `detectSite`/`findRossumTabs`/etc. blocks plus the new `isConsoleTab` block).

- [ ] **Step 5: Verification gate (no commit)**

Run: `npx vitest run tests/popup-utils.test.js`
Expected: all green. Leave changes uncommitted on `master`.

---

### Task 2: Wire the Console lede into `App.jsx`

**Files:**
- Modify: `src/popup/components/App.jsx` (import `isConsoleTab`; compute `isConsole`; pass to `UnsupportedSite`; export `UnsupportedSite`; swap both ledes)
- Test: `tests/popup-unsupported-site.test.js` (new)

**Interfaces:**
- Consumes: `isConsoleTab` from `../utils.js` (Task 1).
- Produces: `export function UnsupportedSite({ tabs, isConsole })` from `src/popup/components/App.jsx`.

- [ ] **Step 1: Write the failing test**

Create `tests/popup-unsupported-site.test.js`. (App.jsx's import graph has no top-level `chrome.*`, so importing it in jsdom is safe; `UnsupportedSite` renders without calling `chrome` — `activateTab` only fires on click.)

```javascript
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { UnsupportedSite } from '../src/popup/components/App.jsx';

function mount(props) {
  const root = document.createElement('div');
  render(h(UnsupportedSite, props), root);
  return root;
}

const TABS = [{ id: 1, url: 'https://elis.rossum.ai/queues', title: 'Rossum', favIconUrl: '' }];

describe('UnsupportedSite', () => {
  it('shows the Console lede and keeps the tab switcher when on the Console with open Rossum tabs', () => {
    const root = mount({ tabs: TABS, isConsole: true });
    expect(root.textContent).toContain("You're on the Rossum Console.");
    expect(root.textContent).not.toContain("isn't supported");
    expect(root.querySelector('.rossum-tab-list')).toBeTruthy();
    expect(root.textContent).toContain('Switch to one of your open Rossum tabs');
  });

  it('shows the Console lede with the static fallback when on the Console with no Rossum tabs', () => {
    const root = mount({ tabs: [], isConsole: true });
    expect(root.textContent).toContain("You're on the Rossum Console.");
    expect(root.textContent).toContain('It works on');
    expect(root.querySelector('.rossum-tab-list')).toBeNull();
  });

  it('keeps the unsupported lede for a non-Console unsupported tab', () => {
    const root = mount({ tabs: [], isConsole: false });
    expect(root.textContent).toContain("This tab isn't supported by the extension.");
    expect(root.textContent).not.toContain('Rossum Console');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/popup-unsupported-site.test.js`
Expected: FAIL — `UnsupportedSite` is not exported from `App.jsx` yet (import is `undefined`), and the `isConsole` lede branch does not exist.

- [ ] **Step 3: Export `UnsupportedSite` and make its lede conditional**

In `src/popup/components/App.jsx`:

(a) Change the function declaration (line 57) from:

```jsx
function UnsupportedSite({ tabs }) {
```

to:

```jsx
export function UnsupportedSite({ tabs, isConsole }) {
```

(b) In the `hasTabs` branch, replace the lede (line 66):

```jsx
        <p class="unsupported-lede">This tab isn't supported by the extension.</p>
```

with:

```jsx
        <p class="unsupported-lede">{isConsole ? "You're on the Rossum Console." : "This tab isn't supported by the extension."}</p>
```

(c) In the no-tabs branch, replace the lede (line 92) with the identical conditional:

```jsx
      <p class="unsupported-lede">{isConsole ? "You're on the Rossum Console." : "This tab isn't supported by the extension."}</p>
```

- [ ] **Step 4: Wire `isConsole` in the `App` component**

In `src/popup/components/App.jsx`:

(a) Add `isConsoleTab` to the utils import (line 5):

```jsx
import { openConsoleTab, runInTab, detectSite, findRossumTabs, activateTab, isConsoleTab } from '../utils.js';
```

(b) Immediately after `const site = detectSite(tab?.url || '');` (line 105), add:

```jsx
  const isConsole = !site && isConsoleTab(tab?.url || '');
```

(c) Update the `UnsupportedSite` usage (line 232) from:

```jsx
        <UnsupportedSite tabs={rossumTabs} />
```

to:

```jsx
        <UnsupportedSite tabs={rossumTabs} isConsole={isConsole} />
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run tests/popup-unsupported-site.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite and rebuild**

Run: `npm test`
Expected: all tests green (new file + the `isConsoleTab` block from Task 1 + no regressions).

Run: `npm run build`
Expected: clean build into `dist/` (popup.js emits with no errors).

- [ ] **Step 7: Manual verification + handoff (no commit)**

Reload the unpacked extension, open the Console tab (`console/console.html`), and click the extension action: the popup lede reads "You're on the Rossum Console." (with the Rossum-tab switcher if any Rossum tabs are open, else the "It works on …" fallback). On a plain website the lede still reads "This tab isn't supported by the extension.". On a Rossum/NetSuite/Coupa tab the normal popup is unchanged. Leave uncommitted on `master`.

---

## Self-Review

**Spec coverage:**
- `isConsoleTab` helper (spec §Design) → Task 1. ✓
- Wire in `App.jsx` with `isConsole` prop (spec §Design) → Task 2 Step 4. ✓
- `UnsupportedSite` lede swap in both branches, exact wording (spec §Design) → Task 2 Step 3. ✓
- Export `UnsupportedSite` for testing (spec §Testing) → Task 2 Step 3(a). ✓
- `isConsoleTab` unit tests (spec §Testing) → Task 1 Step 1. ✓
- `UnsupportedSite` render tests, both branches + non-Console (spec §Testing) → Task 2 Step 1. ✓
- Backward compat (no manifest/permission/storage) → Global Constraints; no such changes in any task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**Type consistency:** `isConsoleTab(url) → boolean` defined in Task 1, imported/used in Task 2 Step 4, tested in both tasks. `UnsupportedSite({ tabs, isConsole })` exported in Task 2 Step 3, imported in the Task 2 test. Prop name `isConsole` used consistently. ✓
