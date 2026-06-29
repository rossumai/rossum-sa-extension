# MDH Open Collection in a New Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open an MDH collection in a new browser tab (pre-focused on that collection, restoring its last-used pipeline) via a sidebar kebab item and Cmd/Ctrl/middle-click.

**Architecture:** A new deps-injected `src/mdh/openCollectionTab.js` stages a single-use `consoleAuth_<uuid>` carrying `pendingCollection` and opens `console/console.html?authId=<uuid>` with `chrome.tabs.create` — reusing the exact tab-open + boot path the popup already uses. `Sidebar.jsx` gains a kebab "Open in new tab" item and Cmd/Ctrl/middle-click row gestures, both calling the helper. No new pipeline is staged; the new tab's `initMdh` restores the collection's `mdhLastPipeline::<scope>::<collection>` on its own.

**Tech Stack:** Preact + @preact/signals, Chrome MV3 (`chrome.storage.local`, `chrome.tabs`, `chrome.runtime`), esbuild, vitest (jsdom).

## Global Constraints

- **No git commits during this run** (user standing preference): stay on `master`, no branches/worktrees. Each task ends with a **verification checkpoint** (targeted test + full suite) instead of a commit. Do NOT run `git commit`/`git add`.
- **Backward-compatible / additive only:** no manifest or permission change, no `web_accessible_resources`, no new storage keys. Reuse the existing `pendingCollection` staging field and `consoleAuth_<uuid>` lifecycle. Plain-click selection and existing kebab actions stay unchanged.
- **No pipeline is staged.** The new tab restores the collection's last-used pipeline via the existing boot path (`mdhLastPipeline::<scope>::<collection>`). Do NOT stage `pendingPipeline`.
- **Staging entry shape (verbatim):** key `consoleAuth_<uuid>`; value `{ token, domain, app: 'mdh', pendingCollection: <collection>, createdAt: <now> }`; URL `console/console.html?authId=<uuid>`.
- **Test environment:** vitest default is `node`. Tests that render components or use DOM/`sessionStorage` MUST begin with `// @vitest-environment jsdom`. Tests live flat in `tests/*.test.js`, import from `../src/...`, render via `render(h(Component, null), root)`, mock `chrome` by assigning `globalThis.chrome`, and mock modules via `vi.mock`.
- **JSX unicode rule:** raw `\uXXXX` in JSX text renders literally. Render the `↗` glyph as a JS-expression string `{'↗'}` (or `{'↗'}`), never as bare `↗` in JSX text.

---

### Task 1: `openCollectionTab.js` helper

**Files:**
- Create: `src/mdh/openCollectionTab.js`
- Test: `tests/mdh-open-collection-tab.test.js`

**Interfaces:**
- Consumes: `token`, `domain` signals from `src/mdh/store.js`.
- Produces:
  - `buildOpenTabRequest({ token, domain, collection, uuid, now }) => { authKey, authEntry, url }` — pure.
  - `openCollectionTab(collection, deps?) => Promise<void>` — stages the entry and opens the tab; no-ops when `collection`/`token`/`domain` are falsy. `deps` defaults to a real-chrome implementation; tests pass a stub.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-open-collection-tab.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildOpenTabRequest, openCollectionTab } from '../src/mdh/openCollectionTab.js';
import * as store from '../src/mdh/store.js';

beforeEach(() => {
  store.token.value = 'tok';
  store.domain.value = 'https://x.rossum.app';
});

describe('buildOpenTabRequest', () => {
  it('builds the consoleAuth staging key, entry, and console URL', () => {
    const req = buildOpenTabRequest({
      token: 'tok', domain: 'https://x.rossum.app', collection: 'vendors', uuid: 'u1', now: 123,
    });
    expect(req).toEqual({
      authKey: 'consoleAuth_u1',
      authEntry: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', pendingCollection: 'vendors', createdAt: 123 },
      url: 'console/console.html?authId=u1',
    });
  });
});

function stubDeps(overrides = {}) {
  return {
    uuid: () => 'u1',
    now: () => 123,
    getURL: (p) => 'chrome-extension://abc/' + p,
    storageSet: vi.fn(() => Promise.resolve()),
    getCurrentTab: () => Promise.resolve({ index: 3, windowId: 7 }),
    tabsCreate: vi.fn(),
    ...overrides,
  };
}

describe('openCollectionTab', () => {
  it('stages the entry and opens a tab next to the current one', async () => {
    const deps = stubDeps();
    await openCollectionTab('vendors', deps);
    expect(deps.storageSet).toHaveBeenCalledWith({
      consoleAuth_u1: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', pendingCollection: 'vendors', createdAt: 123 },
    });
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=u1', index: 4, windowId: 7,
    });
  });

  it('no-ops when not connected (no token/domain)', async () => {
    store.token.value = '';
    const deps = stubDeps();
    await openCollectionTab('vendors', deps);
    expect(deps.storageSet).not.toHaveBeenCalled();
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });

  it('no-ops when collection is falsy', async () => {
    const deps = stubDeps();
    await openCollectionTab('', deps);
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });

  it('still opens the tab (without positioning) when getCurrentTab rejects', async () => {
    const deps = stubDeps({ getCurrentTab: () => Promise.reject(new Error('no tab')) });
    await openCollectionTab('vendors', deps);
    expect(deps.tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://abc/console/console.html?authId=u1' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-open-collection-tab.test.js`
Expected: FAIL — `Failed to resolve import "../src/mdh/openCollectionTab.js"` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `src/mdh/openCollectionTab.js`:

```js
// src/mdh/openCollectionTab.js
//
// Open an MDH collection in a NEW Console tab. Reuses the existing single-use
// consoleAuth_<uuid> staging + the `pendingCollection` boot override in initMdh,
// so the new tab opens focused on the collection and restores ITS last-used
// pipeline (mdhLastPipeline::<scope>::<collection>) via the normal boot path —
// no pipeline is staged here. The Console page is an extension-page context, so
// chrome.tabs.create works without the "tabs" permission (the popup does the
// same). deps are injected so the chrome/crypto surface is mockable in tests.
import { token, domain } from './store.js';

// Pure + testable: the staging entry and target URL for opening `collection`.
export function buildOpenTabRequest({ token, domain, collection, uuid, now }) {
  return {
    authKey: `consoleAuth_${uuid}`,
    authEntry: { token, domain, app: 'mdh', pendingCollection: collection, createdAt: now },
    url: `console/console.html?authId=${uuid}`,
  };
}

const realDeps = {
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
  getURL: (p) => chrome.runtime.getURL(p),
  storageSet: (obj) => chrome.storage.local.set(obj),
  getCurrentTab: () => chrome.tabs.getCurrent(),
  tabsCreate: (opts) => chrome.tabs.create(opts),
};

// Stage single-use auth carrying the target collection, then open a new Console
// tab next to the current one. No-op when not connected. Positioning is
// best-effort; the staged entry is consumed on boot (or swept by the 24h purge).
export async function openCollectionTab(collection, deps = realDeps) {
  if (!collection || !token.value || !domain.value) return;
  const req = buildOpenTabRequest({
    token: token.value, domain: domain.value, collection,
    uuid: deps.uuid(), now: deps.now(),
  });
  await deps.storageSet({ [req.authKey]: req.authEntry });
  const opts = { url: deps.getURL(req.url) };
  try {
    const cur = await deps.getCurrentTab();
    if (cur && typeof cur.index === 'number') {
      opts.index = cur.index + 1;
      opts.windowId = cur.windowId;
    }
  } catch { /* positioning is optional */ }
  deps.tabsCreate(opts);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-open-collection-tab.test.js`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npm test`
Expected: full suite green (new file only adds tests).

---

### Task 2: Sidebar wiring + docs

**Files:**
- Modify: `src/mdh/components/Sidebar.jsx` (import; kebab item; row `onClick`/`onAuxClick`/`onMouseDown`)
- Modify: `CLAUDE.md` (one-sentence note in the MDH auth-flow paragraph)
- Test: `tests/mdh-sidebar-open-tab.test.js`

**Interfaces:**
- Consumes: `openCollectionTab(collection)` from `src/mdh/openCollectionTab.js` (Task 1).
- Produces: no new exports. Behavior: kebab "Open in new tab" item and Cmd/Ctrl/middle-click on a collection row call `openCollectionTab(name)`; plain click still calls `selectCollection(name)`.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-sidebar-open-tab.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/openCollectionTab.js', () => ({ openCollectionTab: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as store from '../src/mdh/store.js';
import { openCollectionTab } from '../src/mdh/openCollectionTab.js';
import Sidebar from '../src/mdh/components/Sidebar.jsx';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount() {
  const root = document.createElement('div');
  render(h(Sidebar, null), root);
  await tick(); // let loadCollections' useEffect settle
  return root;
}

function rowFor(root, name) {
  return Array.from(root.querySelectorAll('.collection-item'))
    .find((el) => el.querySelector('.collection-item-name')?.textContent === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listCollections.mockResolvedValue({ result: ['vendors', 'items'] });
  store.collections.value = ['vendors', 'items'];
  store.selectedCollection.value = null;
  store.activeView.value = 'collection';
});

describe('Sidebar open-in-new-tab', () => {
  it('plain click selects in the current tab (does NOT open a new tab)', async () => {
    const root = await mount();
    rowFor(root, 'vendors').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(store.selectedCollection.value).toBe('vendors');
    expect(openCollectionTab).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl-click opens a new tab and does NOT change the current selection', async () => {
    const root = await mount();
    rowFor(root, 'items').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('items');
    expect(store.selectedCollection.value).toBeNull();
  });

  it('middle-click (auxclick button 1) opens a new tab', async () => {
    const root = await mount();
    rowFor(root, 'vendors').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(openCollectionTab).toHaveBeenCalledWith('vendors');
  });

  it('kebab "Open in new tab" item opens a new tab', async () => {
    const root = await mount();
    const row = rowFor(root, 'vendors');
    row.querySelector('.collection-action-menu-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    const item = Array.from(root.querySelectorAll('.collection-action-menu .toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    expect(item).toBeTruthy();
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('vendors');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-sidebar-open-tab.test.js`
Expected: FAIL — Cmd/Ctrl-click case fails because the current row `onClick` always calls `selectCollection` (so `selectedCollection` becomes `'items'` and `openCollectionTab` is never called); the kebab case fails because no "Open in new tab" item exists yet.

- [ ] **Step 3: Add the import in `src/mdh/components/Sidebar.jsx`**

After the existing import block (the last import is `import { UNDO_LIMIT } from '../bulkOps.js';`), add:

```js
import { openCollectionTab } from '../openCollectionTab.js';
```

- [ ] **Step 4: Wire the row gestures**

In the `cols.map((name) => ( … ))` block, replace this exact line:

```jsx
            onClick={() => selectCollection(name)}
```

with:

```jsx
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) { e.preventDefault(); openCollectionTab(name); }
              else selectCollection(name);
            }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openCollectionTab(name); } }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
```

- [ ] **Step 5: Add the kebab menu item**

In the `menuOpenFor && menuPos && ( … )` block, the menu `<div class="collection-action-menu" …>` currently opens with the "Copy name" button. Insert this as the FIRST item, immediately before the `Copy name` button:

```jsx
          <button
            class="toolbar-menu-item"
            onClick={() => { const n = menuOpenFor; setMenuOpenFor(null); openCollectionTab(n); }}
          >Open in new tab {'↗'}</button>
```

- [ ] **Step 6: Run the wiring test to verify it passes**

Run: `npx vitest run tests/mdh-sidebar-open-tab.test.js`
Expected: PASS (all 4 cases).

- [ ] **Step 7: Add the CLAUDE.md note**

In `CLAUDE.md`, in the "### Dataset Management (MDH)" section, find the paragraph beginning "Auth flow: popup (or background worker) uses `chrome.scripting.executeScript`…". Append this sentence to the END of that paragraph (it reuses exactly that flow):

```
The MDH sidebar can also open a collection in a new Console tab (kebab "Open in new tab", or Cmd/Ctrl/middle-click a collection) — `src/mdh/openCollectionTab.js` stages the same single-use `consoleAuth_<uuid>` carrying `pendingCollection` and `chrome.tabs.create`s `console/console.html`, so the new tab opens focused on that collection and restores its last-used pipeline.
```

- [ ] **Step 8: Verify build + full suite (no commit)**

Run: `npm run build`
Expected: build succeeds (esbuild bundles `Sidebar.jsx` + `openCollectionTab.js` without import errors).

Run: `npm test`
Expected: full suite green. The existing `tests/mdh-sidebar-drop.test.js` still passes (it tests the unchanged `performDrop`).

- [ ] **Step 9: Manual browser verification (record the result)**

Per `CLAUDE.md` Browser Automation. In a connected Console, confirm that (a) the kebab "Open in new tab" item, (b) Cmd/Ctrl-click on a collection row, and (c) middle-click each open a NEW browser tab focused on that collection with its last-used pipeline, positioned next to the current tab; and that plain click still selects in the current tab. This is the one runtime unknown (`chrome.tabs.create`/`getCurrent` from the Console page) — if `chrome.tabs.create` does not work from the Console page, switch `realDeps.tabsCreate`/`getCurrentTab` to `window.open(getURL(url), '_blank')` (a same-origin extension-page open) and note it.

---

## Self-Review

**Spec coverage:**
- Part A (helper module, deps-injected, no pipeline staged, `pendingCollection` reuse) → Task 1. ✓
- Part B (kebab item + Cmd/Ctrl/middle-click, plain click unchanged) → Task 2 Steps 3-5. ✓
- Trigger decision (both routes → same helper) → Task 2 test asserts all routes call `openCollectionTab`. ✓
- New-tab query = last-used pipeline (no `pendingPipeline` staged) → Global Constraints + Task 1 entry shape (no pipeline field). ✓
- Error handling (no-op when not connected; positioning best-effort) → Task 1 tests (no-op + getCurrentTab-rejects). ✓
- Backward compatibility (no manifest/permission/key change) → Global Constraints; reuses existing staging. ✓
- Docs → Task 2 Step 7. ✓
- Runtime unknown (`chrome.tabs.create` from Console page) → Task 2 Step 9 manual check + `window.open` fallback. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows complete code. ✓

**Type/name consistency:** `buildOpenTabRequest({ token, domain, collection, uuid, now })`, `openCollectionTab(collection, deps)`, staging key `consoleAuth_<uuid>`, entry `{ token, domain, app:'mdh', pendingCollection, createdAt }`, URL `console/console.html?authId=<uuid>` — identical across Task 1 (definition + test) and Task 2 (consumer + test). Sidebar import path `'../openCollectionTab.js'` matches the file location `src/mdh/openCollectionTab.js`. ✓
