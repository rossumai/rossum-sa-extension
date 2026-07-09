# MDH State-Aware Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-shown "Select a collection to get started" empty state in the Dataset Management app with a state-aware one that reflects reality — a first-run "No collections yet" block with a Create action when the org has no collections, the (now truthful) select-a-collection line when collections exist, and nothing while loading / disconnected / errored.

**Architecture:** Extract the empty-state rendering out of `App.jsx` into a new focused `CollectionEmptyState` component that reads the `collections`/`loading`/`error` signals plus a `connected` prop and picks one of four renders. The Create button reuses the existing `showCreateModal` flow (exported from `Sidebar.jsx`, no logic moved). Styling is purely additive to `console.css`.

**Tech Stack:** Preact + `@preact/signals`, esbuild, Vitest (jsdom), CSS custom properties.

## Global Constraints

- **Copy names the product "Master Data Hub"** (not "Data Storage"). The entity noun stays **"collection"** (matches sidebar "Collections" / "New Collection" modal).
- **No new chrome.storage keys, no migration.** Auto-select behavior in `Sidebar.loadCollections()` stays untouched.
- **CSS is additive only** — do not modify the existing `.empty-state` rule (shared by Audit/Galaxy); add new classes.
- **No git commits during this run** (owner standing preference; stay on `master`, no branches/worktrees). Every task's final step is a build/test verification gate instead of a commit; the working tree is left uncommitted.
- **Tests follow the repo convention:** `tests/*.test.js`, `// @vitest-environment jsdom`, render via `h(Component, props)` + `preact`'s `render`, `vi.mock` for cross-module isolation (see `tests/mdh-placeholder-inputs-render.test.js`).
- **Rebuild `dist/` after UI changes** (`npm run build`) and tell the user to reload the extension — tests run against `src/` but the loaded extension runs the bundle.

---

### Task 1: `CollectionEmptyState` component (state-aware rendering)

**Files:**
- Create: `src/mdh/components/CollectionEmptyState.jsx`
- Modify: `src/mdh/components/Sidebar.jsx` (export `showCreateModal`)
- Test: `tests/mdh-empty-state.test.js`

**Interfaces:**
- Consumes: `showCreateModal` (named export added to `Sidebar.jsx`) — `() => void`, opens the New Collection prompt modal; the `collections` / `loading` / `error` signals from `src/mdh/store.js`.
- Produces: `default export CollectionEmptyState({ connected: boolean }) → VNode | null`.

- [ ] **Step 1: Export `showCreateModal` from `Sidebar.jsx`**

`showCreateModal` is currently a module-local `function` declaration in `src/mdh/components/Sidebar.jsx`. Add it to the existing named-export line so the new component can reuse it (no code moved — `Sidebar.jsx` already exports `loadCollections`/`performDrop` this way).

Find this line (currently near line 250):

```javascript
export { loadCollections, performDrop };
```

Replace it with:

```javascript
export { loadCollections, performDrop, showCreateModal };
```

- [ ] **Step 2: Write the failing test**

Create `tests/mdh-empty-state.test.js`. It sets the real store signals (singleton module) and mocks `Sidebar.jsx` so `showCreateModal` is a spy (and so importing the component does not pull in the full sidebar dependency graph or open real modals).

```javascript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

const showCreateModal = vi.fn();
vi.mock('../src/mdh/components/Sidebar.jsx', () => ({ showCreateModal }));

import CollectionEmptyState from '../src/mdh/components/CollectionEmptyState.jsx';
import { collections, loading, error } from '../src/mdh/store.js';

function mount(props = { connected: true }) {
  const root = document.createElement('div');
  render(h(CollectionEmptyState, props), root);
  return root;
}

describe('CollectionEmptyState', () => {
  beforeEach(() => {
    collections.value = [];
    loading.value = false;
    error.value = null;
    showCreateModal.mockClear();
  });

  it('shows the no-collections first-run block when loaded, connected, and empty', () => {
    const root = mount({ connected: true });
    expect(root.textContent).toContain('No collections yet');
    expect(root.textContent).toContain('Master Data Hub');
    const btn = root.querySelector('button.btn-success');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('Create collection');
    expect(root.textContent).not.toContain('Select a collection');
  });

  it('shows the select-a-collection line when collections exist (no button)', () => {
    collections.value = ['a'];
    const root = mount({ connected: true });
    expect(root.textContent).toContain('Select a collection to get started');
    expect(root.textContent).not.toContain('No collections yet');
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders nothing while loading (empty + connected)', () => {
    loading.value = true;
    expect(mount({ connected: true }).textContent).toBe('');
  });

  it('renders nothing when disconnected (empty + not loading)', () => {
    expect(mount({ connected: false }).textContent).toBe('');
  });

  it('renders nothing when an error is present (empty + connected)', () => {
    error.value = { message: 'boom' };
    expect(mount({ connected: true }).textContent).toBe('');
  });

  it('invokes the create flow when the button is clicked', () => {
    const btn = mount({ connected: true }).querySelector('button.btn-success');
    btn.click();
    expect(showCreateModal).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-empty-state.test.js`
Expected: FAIL — cannot resolve `../src/mdh/components/CollectionEmptyState.jsx` (file does not exist yet).

- [ ] **Step 4: Write the component**

Create `src/mdh/components/CollectionEmptyState.jsx`:

```jsx
import { h } from 'preact';
import { collections, loading, error } from '../store.js';
import { showCreateModal } from './Sidebar.jsx';

// State-aware empty state for the Dataset Management main pane, shown when no
// collection is selected in the default (collection) view. Because
// Sidebar.loadCollections() auto-selects the first collection whenever any
// exist, the persistent case here is a genuinely empty org — so this renders a
// first-run "No collections yet" block with a create action, and falls back to
// the (now truthful) "Select a collection" line only during the brief window
// where collections exist but none is selected yet. While loading, or when the
// connection/error bars already explain the state, it renders nothing so it
// never asserts "no collections" prematurely or contradicts those bars.
export default function CollectionEmptyState({ connected }) {
  if (collections.value.length > 0) {
    return <div class="empty-state"><p>Select a collection to get started</p></div>;
  }
  if (loading.value || !connected || error.value) return null;
  return (
    <div class="empty-state">
      <div class="empty-state-card">
        <div class="empty-state-title">No collections yet</div>
        <p class="empty-state-body">
          Master Data Hub keeps your reference data in collections you can
          browse and query. This organization doesn't have any yet.
        </p>
        <button class="btn btn-success" onClick={showCreateModal}>Create collection</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-empty-state.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Verification gate (no commit)**

Run: `npx vitest run tests/mdh-empty-state.test.js`
Expected: all green. Leave changes uncommitted on `master` per the global constraints.

---

### Task 2: Wire into `App.jsx` and add styling

**Files:**
- Modify: `src/mdh/components/App.jsx` (imports + replace inline empty-state at line ~46-48)
- Modify: `src/console/console.css` (add `.empty-state-card` / `.empty-state-title` / `.empty-state-body`)

**Interfaces:**
- Consumes: `CollectionEmptyState({ connected })` from Task 1.
- Produces: no new exported symbols.

- [ ] **Step 1: Import the component in `App.jsx`**

In `src/mdh/components/App.jsx`, add the import alongside the other component imports (after the `UndoToast` import line):

```jsx
import UndoToast from './UndoToast.jsx';
import CollectionEmptyState from './CollectionEmptyState.jsx';
```

- [ ] **Step 2: Replace the inline empty state**

In `src/mdh/components/App.jsx`, find the fallback branch (currently line 46-48):

```jsx
        ) : (
          <div class="empty-state"><p>Select a collection to get started</p></div>
        )}
```

Replace it with:

```jsx
        ) : (
          <CollectionEmptyState connected={connected} />
        )}
```

(`connected` is already the prop passed to `App({ connected })` — no signature change.)

- [ ] **Step 3: Add additive CSS**

In `src/console/console.css`, immediately after the existing `.empty-state { ... }` rule (ends at line ~333, before `.tab-bar`), add:

```css
.empty-state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  max-width: 380px;
}

.empty-state-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-state-body {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}
```

Do **not** modify the existing `.empty-state` rule — the outer `.empty-state` still centers the card; the card handles vertical stacking. This keeps Audit/Galaxy single-line uses unaffected.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (the new `tests/mdh-empty-state.test.js` plus the pre-existing suite; no regressions).

- [ ] **Step 5: Rebuild the extension bundle**

Run: `npm run build`
Expected: clean build into `dist/` with no errors.

- [ ] **Step 6: Manual verification + handoff (no commit)**

Reload the unpacked extension in Chrome (`chrome://extensions` → reload), then reload a Rossum tab and open Dataset Management. Verify against an org with **no** Data Storage collections:
- The pane shows "No collections yet", the Master Data Hub explanation, and a green **Create collection** button.
- Clicking it opens the existing New Collection modal; creating a collection lands you inside it (the per-collection "No records" + Import state).
- On an org **with** collections, the first is auto-selected as before (you never see the empty pane except a possible sub-second boot flash).
- While connecting / disconnected, the connection bar carries the message and the pane stays blank (no false "No collections yet").

Leave all changes uncommitted on `master` per the global constraints. Tell the user the build is refreshed and to reload the extension.

---

## Self-Review

**Spec coverage:**
- New `CollectionEmptyState.jsx` replacing the inline empty state → Task 1 (create) + Task 2 (wire). ✓
- Four-way state table (collections>0 / loading / disconnected|error / empty) → Task 1 Step 4 component + Task 1 Step 2 tests. ✓
- No-collections copy with "Master Data Hub" + Create button → Task 1 Step 4; asserted in Task 1 Step 2. ✓
- Reuse create flow via exported `showCreateModal` → Task 1 Step 1. ✓
- Additive CSS (`.empty-state-card`/`-title`/`-body`, `.empty-state` untouched) → Task 2 Step 3. ✓
- Tests per convention → Task 1 Step 2. ✓
- Backward compatibility (no storage keys, auto-select untouched, class preserved) → Global Constraints + Task 2 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**Type consistency:** `showCreateModal` (`() => void`) exported in Task 1 Step 1, imported/used in Task 1 Step 4, mocked in Task 1 Step 2. `CollectionEmptyState({ connected })` defined in Task 1 Step 4, imported/used in Task 2 Steps 1-2. Signal names `collections`/`loading`/`error` match `src/mdh/store.js`. ✓
