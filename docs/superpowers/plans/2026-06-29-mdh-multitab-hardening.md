# MDH Multi-Tab Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MDH/Console navigation state per-tab (so multiple tabs don't clobber each other on reload), scope the remembered pipeline by collection, and stop history writes from losing entries within a tab — all backward-compatible.

**Architecture:** A new `src/console/tabState.js` reads tab-scoped keys session-first (sessionStorage) with the existing `chrome.storage.local` value as a cross-session seed, and writes both. `initMdh` and the Console boot resolve/persist the navigation keys through it. `mdhLastPipeline` gains a per-collection key segment. `QueryHistory` writers run through a per-tab promise-chain mutex.

**Tech Stack:** Preact + `@preact/signals`, Chrome MV3 storage APIs (`chrome.storage.local`, `sessionStorage`), esbuild bundling, vitest (jsdom + node environments).

## Global Constraints

- **No git commits during this run** (user standing preference): stay on `master`, no branches/worktrees. Each task ends with a **verification checkpoint** (targeted test run + full suite) instead of a commit. Do NOT run `git commit`.
- **Backward compatibility is mandatory:** existing `chrome.storage.local` keys must keep working as the cross-session seed; no user migration step. Single-tab behavior must be unchanged.
- **Test environment:** the vitest default environment is `node`. Any test that uses `sessionStorage` or the DOM MUST start with the directive line `// @vitest-environment jsdom`. Tests that only use a mocked `chrome.storage.local` + plain objects stay in `node` (no directive).
- **Test convention:** tests live flat in `tests/*.test.js`, import from `../src/...`, render components via `h(Component, props)` (not raw JSX). Mock `chrome` by assigning `globalThis.chrome`.
- **Keys that stay GLOBAL (do not touch):** `mdhResultsView`, `mdhStagesAutoscroll`, `mdhStagesSampleSize`, `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`, `mdhOverviewChartsScale`. Only the five navigation keys below become per-tab.
- **Tab-scoped keys (become per-tab):** `consoleActiveApp`, `mdhActiveView`, `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch`.
- **Storage value asymmetry (by design):** `writeTabState` stores the value JSON-encoded in `sessionStorage` but lets `chrome.storage.local` store it natively. Reads mirror this: `sessionStorage` via `JSON.parse`, `chrome.storage.local` via the raw value. Keep these in sync.

---

### Task 1: `tabState.js` helper module

**Files:**
- Create: `src/console/tabState.js`
- Test: `tests/console-tab-state.test.js`

**Interfaces:**
- Consumes: nothing (leaf module; uses `sessionStorage` + `chrome.storage.local` globals).
- Produces:
  - `TAB_SCOPED_KEYS: string[]` — the five per-tab key names.
  - `resolveTabState(keys: string[], localValues: object) => object` — for each key, returns the `sessionStorage` value (JSON-parsed) if present, else `localValues[key]`.
  - `writeTabState(key: string, value: any) => void` — writes `sessionStorage[key]=JSON.stringify(value)` AND `chrome.storage.local.set({[key]: value})`; best-effort (never throws).

- [ ] **Step 1: Write the failing test**

Create `tests/console-tab-state.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TAB_SCOPED_KEYS, resolveTabState, writeTabState } from '../src/console/tabState.js';

let store;
beforeEach(() => {
  sessionStorage.clear();
  store = {};
  globalThis.chrome = {
    storage: { local: { set: vi.fn((obj) => { Object.assign(store, obj); return Promise.resolve(); }) } },
  };
});

describe('TAB_SCOPED_KEYS', () => {
  it('lists exactly the five navigation keys', () => {
    expect([...TAB_SCOPED_KEYS].sort()).toEqual(
      ['consoleActiveApp', 'mdhActivePanel', 'mdhActiveView', 'mdhOpsSearch', 'mdhSelectedCollection'],
    );
  });
});

describe('resolveTabState', () => {
  it('prefers the sessionStorage value over the local seed', () => {
    sessionStorage.setItem('mdhSelectedCollection', JSON.stringify('B'));
    const out = resolveTabState(['mdhSelectedCollection'], { mdhSelectedCollection: 'A' });
    expect(out.mdhSelectedCollection).toBe('B');
  });

  it('falls back to the local seed when no session value', () => {
    const out = resolveTabState(['mdhActiveView'], { mdhActiveView: 'overview' });
    expect(out.mdhActiveView).toBe('overview');
  });

  it('returns undefined when neither session nor local has the key', () => {
    const out = resolveTabState(['mdhActivePanel'], {});
    expect(out.mdhActivePanel).toBeUndefined();
  });

  it('falls back to local when the session value is corrupt JSON', () => {
    sessionStorage.setItem('mdhOpsSearch', '{not json');
    const out = resolveTabState(['mdhOpsSearch'], { mdhOpsSearch: 'seed' });
    expect(out.mdhOpsSearch).toBe('seed');
  });
});

describe('writeTabState', () => {
  it('writes the value to BOTH sessionStorage (JSON) and chrome.storage.local (native)', () => {
    writeTabState('consoleActiveApp', 'galaxy');
    expect(JSON.parse(sessionStorage.getItem('consoleActiveApp'))).toBe('galaxy');
    expect(store.consoleActiveApp).toBe('galaxy');
  });

  it('never throws when chrome.storage is unavailable', () => {
    delete globalThis.chrome;
    expect(() => writeTabState('mdhActiveView', 'collection')).not.toThrow();
    expect(JSON.parse(sessionStorage.getItem('mdhActiveView'))).toBe('collection');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/console-tab-state.test.js`
Expected: FAIL — `Failed to resolve import "../src/console/tabState.js"` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `src/console/tabState.js`:

```js
// src/console/tabState.js
//
// Per-tab navigation state for the Console. Each console.html tab is its own
// browsing context, so sessionStorage is per-tab while chrome.storage.local is
// shared across all tabs. We keep the navigation keys (which collection / view /
// panel / app the user is looking at, plus the ops-log search) per-tab in
// sessionStorage so tabs don't clobber each other on reload, while mirroring the
// value into chrome.storage.local as a cross-session SEED — a freshly-opened tab
// (empty sessionStorage) still resumes where the user last was. Genuine
// preferences (layout widths, results view, Stages options, chart scale) stay
// global in chrome.storage.local and are NOT handled here.
//
// Value asymmetry (by design): sessionStorage holds JSON-encoded values (it only
// stores strings); chrome.storage.local stores the value natively. resolveTabState
// reads each surface accordingly.

// The navigation keys that are per-tab. Everything else stays global.
export const TAB_SCOPED_KEYS = [
  'consoleActiveApp',
  'mdhActiveView',
  'mdhSelectedCollection',
  'mdhActivePanel',
  'mdhOpsSearch',
];

function readSession(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined; // missing sessionStorage or corrupt JSON → fall back to local
  }
}

// For each requested key, return this tab's sessionStorage value if present,
// otherwise the chrome.storage.local value already fetched by the caller.
// Pure given (keys, localValues) + the current sessionStorage — easy to test.
export function resolveTabState(keys, localValues) {
  const out = {};
  for (const key of keys) {
    const s = readSession(key);
    out[key] = s !== undefined ? s : localValues[key];
  }
  return out;
}

// Persist a per-tab value to BOTH surfaces. Best-effort: a storage hiccup must
// never break navigation, so each write is guarded independently.
export function writeTabState(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  try { chrome.storage.local.set({ [key]: value }); } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/console-tab-state.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npm test`
Expected: full suite green (the new file adds tests; nothing else changed).

---

### Task 2: Wire per-tab navigation state into Console boot + `initMdh`

**Files:**
- Modify: `src/console/index.jsx` (import; `persistedApp` resolution at ~line 103; write effect at line 145)
- Modify: `src/mdh/index.jsx` (import; nav-key reads at ~lines 129-140; four write effects at lines 192, 196, 199, 208)
- Test: `tests/mdh-tab-state-wiring.test.js`

**Interfaces:**
- Consumes: `resolveTabState`, `writeTabState` from `src/console/tabState.js` (Task 1).
- Produces: no new exports. Behavioral contract: after `initMdh()`, `store.selectedCollection` (and the other three MDH nav signals) reflect sessionStorage-over-local; changing any of them writes both surfaces. `consoleActiveApp` behaves the same in the Console shell.
- Note: this task LEAVES `lastPipelineKey()` and its `stored[lpKey]` usage exactly as-is (no-arg call). Task 3 changes that.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-tab-state-wiring.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// initMdh has heavy side effects; mock the API client so it doesn't hit the network.
vi.mock('../src/mdh/api.js', () => ({
  init: vi.fn(),
  getOrgId: vi.fn(() => Promise.resolve(1)),
  probeLlmChat: vi.fn(() => Promise.resolve(false)),
  healthz: vi.fn(() => Promise.resolve()),
}));

import { initMdh } from '../src/mdh/index.jsx';
import * as store from '../src/mdh/store.js';
import { activeApp } from '../src/console/store.js';

function stubStorage(seed = {}) {
  const data = { ...seed };
  globalThis.chrome = {
    storage: { local: {
      get: vi.fn((keys) => {
        if (typeof keys === 'string') return Promise.resolve(keys in data ? { [keys]: data[keys] } : {});
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return Promise.resolve(out);
      }),
      set: vi.fn((obj) => { Object.assign(data, obj); return Promise.resolve(); }),
      remove: vi.fn((k) => { delete data[k]; return Promise.resolve(); }),
    } },
  };
  return data;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sessionStorage.clear();
  store.selectedCollection.value = null;
  store.activeView.value = 'collection';
  store.activePanel.value = 'data';
  store.collections.value = [];
  store.connected.value = null;
  activeApp.value = 'mdh';
});

describe('initMdh per-tab navigation state', () => {
  it('prefers the sessionStorage collection over the chrome.storage.local seed', async () => {
    stubStorage({ mdhSelectedCollection: 'A' });
    sessionStorage.setItem('mdhSelectedCollection', JSON.stringify('B'));
    await initMdh();
    expect(store.selectedCollection.value).toBe('B');
  });

  it('falls back to the chrome.storage.local seed when this tab has no session value', async () => {
    stubStorage({ mdhSelectedCollection: 'A' });
    await initMdh();
    expect(store.selectedCollection.value).toBe('A');
  });

  it('writes a collection change to BOTH sessionStorage and chrome.storage.local', async () => {
    const data = stubStorage();
    await initMdh();
    store.selectedCollection.value = 'C';
    await flush();
    expect(JSON.parse(sessionStorage.getItem('mdhSelectedCollection'))).toBe('C');
    expect(data.mdhSelectedCollection).toBe('C');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-tab-state-wiring.test.js`
Expected: FAIL — test 1 fails because `initMdh` currently reads `stored.mdhSelectedCollection` directly (returns `'A'`, not `'B'`); test 3 fails because the write effect only writes `chrome.storage.local`, so `sessionStorage` is empty.

- [ ] **Step 3: Modify `src/mdh/index.jsx` — reads**

Add the import near the top (after the existing `lastPipeline` import on line 6):

```js
import { resolveTabState, writeTabState } from '../console/tabState.js';
```

Replace the read block (current lines 129-140, the four `if (stored.mdh*)` navigation reads) so the four navigation keys resolve session-first. Leave the two Stages-option reads (`mdhStagesAutoscroll`, `mdhStagesSampleSize`) reading from `stored` unchanged, and leave the `lpKey` fetch unchanged for this task. The block becomes:

```js
  // Navigation state is per-tab: prefer this tab's sessionStorage, fall back to
  // the chrome.storage.local seed (already in `stored`). Stages options stay global.
  const tab = resolveTabState(
    ['mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch'],
    stored,
  );

  if (tab.mdhActiveView === 'operations' || tab.mdhActiveView === 'overview') {
    store.activeView.value = tab.mdhActiveView;
  }
  if (tab.mdhSelectedCollection) {
    store.selectedCollection.value = tab.mdhSelectedCollection;
  }
  if (tab.mdhActivePanel) {
    store.activePanel.value = tab.mdhActivePanel;
  }
  if (typeof tab.mdhOpsSearch === 'string') {
    store.opsSearch.value = tab.mdhOpsSearch;
  }
  if (typeof stored.mdhStagesAutoscroll === 'boolean') {
    store.stagesAutoscroll.value = stored.mdhStagesAutoscroll;
  }
  if (stored.mdhStagesSampleSize != null) {
    store.stagesSampleSize.value = store.coerceStageSampleSize(stored.mdhStagesSampleSize);
  }
```

- [ ] **Step 4: Modify `src/mdh/index.jsx` — write effects**

Change the four navigation write effects (currently lines 191-209) from `chrome.storage.local.set({...})` to `writeTabState(...)`. Leave the two Stages-option effects as `chrome.storage.local.set`. Final form of these effects:

```js
  effect(() => {
    writeTabState('mdhActiveView', store.activeView.value);
  });
  effect(() => {
    const v = store.selectedCollection.value;
    if (v) writeTabState('mdhSelectedCollection', v);
  });
  effect(() => {
    writeTabState('mdhActivePanel', store.activePanel.value);
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesAutoscroll: store.stagesAutoscroll.value });
  });
  effect(() => {
    chrome.storage.local.set({ mdhStagesSampleSize: store.stagesSampleSize.value });
  });
  effect(() => {
    writeTabState('mdhOpsSearch', store.opsSearch.value);
  });
```

- [ ] **Step 5: Run the wiring test to verify it passes**

Run: `npx vitest run tests/mdh-tab-state-wiring.test.js`
Expected: PASS (all three cases).

- [ ] **Step 6: Modify `src/console/index.jsx` — consoleActiveApp**

Add the import (after the `boot.js` import block, around line 8):

```js
import { resolveTabState, writeTabState } from './tabState.js';
```

Change the `pickInitialApp` call (line 103) to resolve `consoleActiveApp` session-first:

```js
  const persistedApp = resolveTabState(['consoleActiveApp'], stored).consoleActiveApp;
  const initial = pickInitialApp({ stagingApp, persistedApp });
  activeApp.value = initial;
```

Change the write effect (line 145) inside the authenticated branch:

```js
  effect(() => {
    writeTabState('consoleActiveApp', activeApp.value);
  });
```

- [ ] **Step 7: Verify build + full suite (no commit)**

Run: `npm run build`
Expected: build succeeds (esbuild bundles `console/index.jsx` and `mdh/index.jsx` without import errors).

Run: `npm test`
Expected: full suite green. In particular `tests/console-boot.test.js` and `tests/mdh-init-ai-probe.test.js` still pass (neither exercises the changed code paths).

- [ ] **Step 8: Manual browser verification (record the result)**

Per `CLAUDE.md` Browser Automation. Open the Console twice (two tabs) against the same org via the popup's "Open in Dataset Management", select a different collection in each, then reload tab 1. Confirm tab 1 still shows ITS collection (not tab 2's). Note the outcome in the task hand-off; this covers the effect wiring that unit tests approximate.

---

### Task 3: Collection-scoped `mdhLastPipeline`

**Files:**
- Modify: `src/mdh/lastPipeline.js` (`lastPipelineKey` + `saveLastPipeline` signatures)
- Modify: `src/mdh/components/DataPanel.jsx:369` (pass `collection`)
- Modify: `src/mdh/index.jsx` (compute `lpKey` after collection resolved; separate `get`)
- Test: `tests/mdh-last-pipeline.test.js` (update to new signatures + add collection-distinctness case)

**Interfaces:**
- Consumes: `scopeSuffix()` from `src/mdh/store.js` (unchanged).
- Produces:
  - `lastPipelineKey(collection: string) => string` — `mdhLastPipeline::<scope>::<collection || ''>`.
  - `saveLastPipeline(collection: string, pipelineText: string, variables?: object, placeholderTypes?: object) => void`.
  - `bootPrefillFor` — unchanged signature `(stored, selectedCollection, hasPendingPrefill)`.

- [ ] **Step 1: Update the failing tests**

Edit `tests/mdh-last-pipeline.test.js`. Replace the whole `describe('lastPipeline persistence', …)` block (lines 23-52) with the collection-aware version below (the `bootPrefillFor` block beneath it stays unchanged):

```js
describe('lastPipeline persistence', () => {
  it('writes text + variables under the org+collection-scoped key', () => {
    saveLastPipeline('vendors', '[{"$match":{"v":"{vendor}"}}]', { vendor: 'ACME' });
    expect(lastPipelineKey('vendors')).toBe('mdhLastPipeline::org:7::vendors');
    expect(store[lastPipelineKey('vendors')]).toEqual({
      pipelineText: '[{"$match":{"v":"{vendor}"}}]',
      variables: { vendor: 'ACME' },
      placeholderTypes: {},
    });
  });

  it('keys different collections separately', () => {
    saveLastPipeline('vendors', '[{"$limit":1}]');
    saveLastPipeline('items', '[{"$limit":2}]');
    expect(store['mdhLastPipeline::org:7::vendors'].pipelineText).toBe('[{"$limit":1}]');
    expect(store['mdhLastPipeline::org:7::items'].pipelineText).toBe('[{"$limit":2}]');
  });

  it('copies variables (later mutation of the source does not leak in)', () => {
    const vars = { a: '1' };
    saveLastPipeline('vendors', '[]', vars);
    vars.a = 'mutated';
    expect(store[lastPipelineKey('vendors')].variables).toEqual({ a: '1' });
  });

  it('tolerates missing variables', () => {
    saveLastPipeline('vendors', '[]');
    expect(store[lastPipelineKey('vendors')]).toEqual({ pipelineText: '[]', variables: {}, placeholderTypes: {} });
  });

  it('falls back to a domain-scoped key when org id is null', () => {
    orgId.value = null;
    saveLastPipeline('vendors', '[]');
    expect(lastPipelineKey('vendors')).toBe('mdhLastPipeline::domain:https://x.rossum.app::vendors');
    expect(store['mdhLastPipeline::domain:https://x.rossum.app::vendors']).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-last-pipeline.test.js`
Expected: FAIL — `lastPipelineKey('vendors')` ignores the argument and returns `mdhLastPipeline::org:7`; `saveLastPipeline('vendors', …)` writes under the wrong key (the first arg is treated as `pipelineText`).

- [ ] **Step 3: Modify `src/mdh/lastPipeline.js`**

Replace `lastPipelineKey` and `saveLastPipeline` (lines 6-22) with:

```js
export function lastPipelineKey(collection) {
  return `mdhLastPipeline::${scopeSuffix()}::${collection || ''}`;
}

// Persist the current editor text + placeholder variables for a specific
// collection. Best-effort: a storage hiccup must never break editing.
export function saveLastPipeline(collection, pipelineText, variables, placeholderTypes) {
  try {
    chrome.storage.local.set({
      [lastPipelineKey(collection)]: {
        pipelineText,
        variables: { ...(variables || {}) },
        placeholderTypes: { ...(placeholderTypes || {}) },
      },
    });
  } catch { /* storage unavailable — non-fatal */ }
}
```

(Leave `bootPrefillFor` below it unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-last-pipeline.test.js`
Expected: PASS (all cases, including the two `bootPrefillFor` describes which are unchanged).

- [ ] **Step 5: Modify the `DataPanel.jsx` call site**

In `src/mdh/components/DataPanel.jsx`, inside `persistLastPipeline` (line 369), pass the collection (already in scope as `const collection = selectedCollection.value;` at line 55):

```js
      saveLastPipeline(collection, editorRef.current.getValue(), pipeline.placeholderValues.value, pipeline.placeholderTypes.value);
```

- [ ] **Step 6: Modify `src/mdh/index.jsx` — fetch the per-collection pipeline after the collection is resolved**

Remove `lpKey` from the bulk `chrome.storage.local.get([...])` call (it must no longer be computed up-front). The get array becomes exactly:

```js
  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch',
    'mdhStagesAutoscroll', 'mdhStagesSampleSize',
  ]);
```

Delete the now-unused `const lpKey = lastPipelineKey();` line (currently line 123). Then replace the `restoredPipeline` block (currently lines 161-166) — which runs AFTER the `if (pendingCollection) {…}` override — with a version that resolves the key from the now-final collection and fetches it separately:

```js
  // The last pipeline is keyed per-collection, so resolve the collection first
  // (including any pendingCollection override above), then fetch that key.
  const lpKey = lastPipelineKey(store.selectedCollection.value);
  const lpStored = await chrome.storage.local.get(lpKey);
  const restoredPipeline = bootPrefillFor(
    lpStored[lpKey],
    store.selectedCollection.value,
    !!store.pendingPipelineLoad.value,
  );
  if (restoredPipeline) store.pendingPipelineLoad.value = restoredPipeline;
```

(The `import { lastPipelineKey, bootPrefillFor } from './lastPipeline.js';` on line 6 stays — both are still used.)

- [ ] **Step 7: Verify build + full suite (no commit)**

Run: `npm run build`
Expected: build succeeds.

Run: `npm test`
Expected: full suite green.

- [ ] **Step 8: Manual browser verification (record the result)**

In one org, open collection A in tab 1 and collection B in tab 2; edit each tab's pipeline; reload tab 1. Confirm tab 1 restores collection A with A's pipeline (not B's). This is the §3(b) mismatch the change removes.

---

### Task 4: Serialize history writes within a tab

**Files:**
- Modify: `src/mdh/components/QueryHistory.jsx` (add `serialize`; wrap `addToHistory`, `saveQuery`, `unsaveQuery`)
- Test: `tests/mdh-query-history.test.js` (add a concurrency case)

**Interfaces:**
- Consumes: nothing new.
- Produces: same exports (`addToHistory`, `saveQuery`, `unsaveQuery`, `isSaved`, `LibraryPanel`) with identical signatures and return types (still `Promise`). Behavior change: the three writers serialize against each other within the tab.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-query-history.test.js` a new describe block. Note the deliberately slow `get`/`set` that exposes the read-modify-write race:

```js
describe('QueryHistory write serialization', () => {
  function stubSlowStorage() {
    const data = {};
    globalThis.chrome = {
      storage: { local: {
        get: (key) => new Promise((r) => setTimeout(() => r(key in data ? { [key]: data[key] } : {}), 5)),
        set: (obj) => new Promise((r) => setTimeout(() => { Object.assign(data, obj); r(); }, 5)),
        remove: (key) => new Promise((r) => setTimeout(() => { delete data[key]; r(); }, 5)),
      }, sync: { get: () => Promise.resolve({}), remove: () => Promise.resolve() } },
    };
    return data;
  }

  it('does not lose entries when two addToHistory calls overlap', async () => {
    const data = stubSlowStorage();
    orgId.value = 1; domain.value = 'https://x.rossum.app';
    await Promise.all([
      addToHistory('vendors', '[{"$limit":1}]', {}),
      addToHistory('vendors', '[{"$limit":2}]', {}),
    ]);
    expect(data['queryHistory::org:1']).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-query-history.test.js -t "do not lose entries"`
Expected: FAIL — `expected length 2, received 1`. Both calls read the empty list before either writes, so the second write clobbers the first (lost update).

- [ ] **Step 3: Add the mutex and wrap the writers in `src/mdh/components/QueryHistory.jsx`**

Add this just below the `writeList` function (after line 19):

```js
// All history/saved writes are read-modify-write on a per-org array. Run them
// through a per-tab promise chain so overlapping writes within this tab can't
// lose an entry. (Cross-tab simultaneous writes remain a low-probability,
// accepted residual — see docs/superpowers/specs/2026-06-29-mdh-multitab-hardening-design.md.)
let writeChain = Promise.resolve();
function serialize(task) {
  const run = writeChain.then(task, task); // run regardless of the prior outcome
  writeChain = run.catch(() => {});
  return run;
}
```

Wrap the body of each of the three writers so the entire read-modify-write runs inside `serialize`. `addToHistory` becomes:

```js
export async function addToHistory(collection, pipeline, variables, placeholderTypes) {
  return serialize(async () => {
    const queryHistory = await readList('queryHistory');
    const key = dedupKey(collection, pipeline);
    const filtered = queryHistory.filter((e) => dedupKey(e.collection, e.pipeline) !== key);
    const entry = { collection, pipeline, ts: Date.now() };
    if (variables && Object.keys(variables).length > 0) entry.variables = variables;
    if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
    filtered.unshift(entry);
    await writeList('queryHistory', filtered.slice(0, MAX_HISTORY));
  });
}
```

`saveQuery` becomes:

```js
export async function saveQuery(collection, pipeline, name, variables, placeholderTypes) {
  return serialize(async () => {
    const savedQueries = await readList('savedQueries');
    const entry = { collection, pipeline, name, ts: Date.now() };
    if (variables && Object.keys(variables).length > 0) entry.variables = variables;
    if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
    savedQueries.push(entry);
    await writeList('savedQueries', savedQueries);
  });
}
```

`unsaveQuery` becomes:

```js
export async function unsaveQuery(collection, pipeline) {
  return serialize(async () => {
    const savedQueries = await readList('savedQueries');
    const key = dedupKey(collection, pipeline);
    await writeList('savedQueries', savedQueries.filter((q) => dedupKey(q.collection, q.pipeline) !== key));
  });
}
```

(Leave `isSaved` unchanged — it is read-only and must not block on the write chain.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: PASS, including the existing per-org and disable-aware dedup cases and the new concurrency case.

- [ ] **Step 5: Verify build + full suite (no commit)**

Run: `npm run build`
Expected: build succeeds.

Run: `npm test`
Expected: full suite green.

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "Chrome Storage Keys" section; the auth/boot description in the Dataset Management section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the Chrome Storage Keys section**

In `CLAUDE.md`, in the "## Chrome Storage Keys" section, update the MDH state bullet so it states which keys are per-tab. Replace the existing "MDH state:" line with text conveying exactly this (keep the surrounding bullets intact):

> - MDH state: `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`, `mdhOverviewChartsScale`, `mdhResultsView`, `mdhStagesAutoscroll`, `mdhStagesSampleSize` are **global** (shared across tabs, persisted in `chrome.storage.local`). The **navigation** keys `mdhActiveView`, `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch` (and the Console-level `consoleActiveApp`) are **per-tab**: read session-first from `sessionStorage`, written to BOTH `sessionStorage` (this tab's truth on reload) and `chrome.storage.local` (cross-session seed for a freshly-opened tab), via `src/console/tabState.js`. `mdhLastPipeline::<scope>::<collection>` is keyed per-org **and per-collection** (legacy un-collection-scoped `mdhLastPipeline::<scope>` entries from older builds are orphaned, not migrated).

- [ ] **Step 2: Update the boot description**

In the "### Dataset Management (MDH)" section's auth-flow paragraph (the one describing `sessionStorage` `consoleToken`/`consoleDomain`/`consoleAuthId`), add one sentence noting that navigation state is also per-tab via `sessionStorage` with a `chrome.storage.local` seed (see `src/console/tabState.js`), so multiple Console tabs don't clobber each other's working context on reload.

- [ ] **Step 3: Verify (no commit)**

Run: `npm test`
Expected: full suite green (docs change doesn't affect tests; this is the final regression gate).

Confirm the working tree contains exactly: `src/console/tabState.js` (new), `tests/console-tab-state.test.js` (new), `tests/mdh-tab-state-wiring.test.js` (new), and modifications to `src/console/index.jsx`, `src/mdh/index.jsx`, `src/mdh/lastPipeline.js`, `src/mdh/components/DataPanel.jsx`, `src/mdh/components/QueryHistory.jsx`, `tests/mdh-last-pipeline.test.js`, `tests/mdh-query-history.test.js`, `CLAUDE.md`. Report the final test count. Do not commit (user preference).

---

## Self-Review

**Spec coverage:**
- Part A (per-tab navigation state, session-first + local-seed) → Task 1 (helper) + Task 2 (wiring). ✓
- "Navigation only" key split (the five nav keys per-tab; widths/results-view/stages-opts/charts-scale stay global) → Global Constraints + Task 2 (Stages-option effects left as `chrome.storage.local.set`). ✓
- Part B (collection-scoped `mdhLastPipeline`, legacy key orphaned) → Task 3 + Task 5 doc note. ✓
- Part C (in-page serialized history writes; cross-tab residual documented) → Task 4 (+ comment referencing the spec). ✓
- Backward compatibility (existing keys as seed; single-tab unchanged) → Global Constraints; Task 2 fallback path tested. ✓
- `Sidebar.loadCollections` guard for cross-org stale collection → already in place, no task needed (noted in spec). ✓
- Testing (resolveTabState, lastPipelineKey, serialize) → Tasks 1, 3, 4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full code. ✓

**Type/name consistency:** `resolveTabState(keys, localValues)`, `writeTabState(key, value)`, `TAB_SCOPED_KEYS`, `lastPipelineKey(collection)`, `saveLastPipeline(collection, pipelineText, variables, placeholderTypes)`, `serialize(task)` — names/signatures match across Tasks 1→2 (helper consumed by `index.jsx`), 3 (call site passes `collection` first), and 4. `bootPrefillFor` signature unchanged everywhere. ✓
