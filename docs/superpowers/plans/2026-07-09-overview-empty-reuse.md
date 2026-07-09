# Overview Empty-State Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview panel's bare `<div class="stats-empty">No collections</div>` with the shared `CollectionEmptyState` component, so an empty org shows the same "No collections yet" + Create-collection card as the collection view.

**Architecture:** `OverviewPanel` already renders its empty branch exactly when `collections.value.length === 0`, which is the condition `CollectionEmptyState` handles. Reuse the component directly, passing the `connected` signal's value.

**Tech Stack:** Preact + @preact/signals, Vitest (jsdom).

## Global Constraints

- Reuse `CollectionEmptyState` as-is; do NOT modify it.
- The empty branch fires only when `totalCount === collections.value.length === 0`, so `CollectionEmptyState`'s `collections.length > 0` ("Select a collection") branch is unreachable here — correct by construction.
- No new chrome.storage keys, no migration. The populated Overview (table, charts, sorting, totals) is untouched.
- Leave the `.stats-empty` CSS rule in place (still used by `StatsPanel.jsx:180-181`).
- No git commits in this run (owner rule) — stay on `master`, leave changes uncommitted; the final step is a test/build gate. The per-task diff is a working-tree diff scoped to the task's files.
- Tests: `// @vitest-environment jsdom`, `h(Component, null)` + preact `render`, `vi.mock`.

---

### Task 1: Reuse `CollectionEmptyState` in the Overview

**Files:**
- Modify: `src/mdh/components/OverviewPanel.jsx` (store import + component import + empty-branch swap)
- Test: `tests/mdh-overview-empty.test.js` (new)

**Interfaces:**
- Consumes: `CollectionEmptyState({ connected })` (default export of `src/mdh/components/CollectionEmptyState.jsx`, shipped in `ae66019`); the `connected` signal from `src/mdh/store.js`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-overview-empty.test.js`. An empty Overview is inert (the initial-load effect calls `streamStats([])` → zero workers → no API calls; the live-poll effect early-returns on empty `cols`, so no timers/listeners; `OverviewPanel` uses no `chrome.*`). Mock `api.js` defensively and mock `Sidebar.jsx`'s `showCreateModal` (imported transitively by `CollectionEmptyState`), mirroring `tests/mdh-empty-state.test.js`.

```javascript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/components/Sidebar.jsx', () => ({ showCreateModal: vi.fn() }));

import OverviewPanel from '../src/mdh/components/OverviewPanel.jsx';
import { collections, connected, loading, error } from '../src/mdh/store.js';

function mount() {
  const root = document.createElement('div');
  render(h(OverviewPanel, null), root);
  return root;
}

describe('OverviewPanel empty state', () => {
  beforeEach(() => {
    collections.value = [];
    connected.value = true;
    loading.value = false;
    error.value = null;
  });

  it('reuses the shared no-collections empty state instead of bare text', () => {
    const root = mount();
    expect(root.textContent).toContain('No collections yet');
    expect(root.querySelector('button.btn-success')).toBeTruthy();
    // the old bare "No collections" .stats-empty div is gone
    expect(root.querySelector('.stats-empty')).toBeNull();
    // no stats table when empty
    expect(root.querySelector('table.stats-table')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-overview-empty.test.js`
Expected: FAIL — the panel still renders `<div class="stats-empty">No collections</div>`, so `.stats-empty` is present, "No collections yet" is absent, and there is no `button.btn-success`.

- [ ] **Step 3: Import the store signal and the component**

In `src/mdh/components/OverviewPanel.jsx`:

(a) Add `connected` to the store import (line 3), changing:

```jsx
import { collections, selectedCollection, activeView } from '../store.js';
```

to:

```jsx
import { collections, selectedCollection, activeView, connected } from '../store.js';
```

(b) Add the component import after the existing `OverviewCharts` import (line 8):

```jsx
import CollectionEmptyState from './CollectionEmptyState.jsx';
```

- [ ] **Step 4: Swap the empty branch**

In `src/mdh/components/OverviewPanel.jsx`, replace (lines 308-310):

```jsx
        {totalCount === 0 ? (
          <div class="stats-empty">No collections</div>
        ) : (
```

with:

```jsx
        {totalCount === 0 ? (
          <CollectionEmptyState connected={connected.value} />
        ) : (
```

(Leave the rest of the ternary — the `<table>` branch — unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-overview-empty.test.js`
Expected: PASS (1 test).

- [ ] **Step 6: Run the full suite and rebuild**

Run: `npm test`
Expected: all tests green (new file + no regressions).

Run: `npm run build`
Expected: clean build into `dist/` (console.js emits with no errors).

- [ ] **Step 7: Manual verification + handoff (no commit)**

Reload the extension, open the Console → Dataset Management on an org with **no** collections, click **Overview**: it shows the "No collections yet" card + Create-collection button (was: bare "No collections"). On an org **with** collections the Overview table renders as before. Leave uncommitted on `master`.

---

## Self-Review

**Spec coverage:**
- Import `connected` + `CollectionEmptyState`, swap the empty branch (spec §Design) → Task 1 Steps 3-4. ✓
- Reuse component unchanged; unreachable "Select a collection" branch (spec §facts 1-2) → Task 1 Step 4 + Global Constraints. ✓
- Layout fit via `.stats-scroll` flex column (spec §fact 3) → relied on, no code needed. ✓
- Inert empty Overview / no chrome / no timers (spec §fact 4) → Task 1 Step 1 test rationale. ✓
- `.stats-empty` left in place (spec §Design, still used by StatsPanel) → Global Constraints; no CSS change in the task. ✓
- Test asserts card + button, absence of `.stats-empty` and table (spec §Testing) → Task 1 Step 1. ✓
- Backward compat (no storage, populated Overview untouched) → Global Constraints; only the empty branch changes. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**Type consistency:** `CollectionEmptyState({ connected })` consumed with `connected={connected.value}` (a boolean/null from the signal), matching its prop contract. Store signals `collections`/`connected`/`loading`/`error` match `src/mdh/store.js` exports. ✓
