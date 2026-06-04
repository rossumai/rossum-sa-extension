# Console App Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two standalone extension pages (Dataset Management + Audit Log Viewer) into one `console` page with a Slack-style left rail that switches between them in place.

**Architecture:** A new thin shell (`src/console/`) owns a single boot: it resolves the shared Rossum auth, inits both app API clients, renders a left rail plus the active app's existing view, and lazily initializes each app the first time it becomes active. The Dataset Management (`src/mdh/`) and Audit (`src/audit/`) apps keep their components unchanged; their `index.jsx` boot bodies become exported `initMdh()` / `initAudit()` functions the shell calls. Audit drops its own stylesheet and adopts the unified `console.css`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE bundle), vitest (jsdom), Chrome MV3 extension APIs.

> **PROJECT CONVENTION — NO COMMITS:** Per the maintainer's standing instruction, do **not** run `git commit` during execution and do not branch. Use `git mv` / `git rm` (these only stage moves/removals, they do not commit) and leave all changes in the working tree for the maintainer to review and commit. Each task ends with a **Checkpoint** (run tests) instead of a commit.

---

## File structure

**New files:**
- `src/console/store.js` — `activeApp` signal (`'mdh' | 'audit'`).
- `src/console/boot.js` — pure boot helpers: `isValidApp`, `pickInitialApp`, `resolveBootAuth`, `computeStaleAuthRemovals`.
- `src/console/components/Rail.jsx` — the left switcher rail (icon + label per app).
- `src/console/components/Console.jsx` — renders `<Rail/>` + the active app's view (with a connecting state).
- `src/console/index.jsx` — shell boot glue (auth, api init, lazy app init, render).
- `src/console/console.html` — page shell.
- `src/console/console.css` — moved from `src/mdh/mdh.css`, with Audit-specific rules + rail rules folded in.
- Tests: `tests/console-store.test.js`, `tests/console-boot.test.js`, `tests/console-rail.test.js`.

**Modified files:**
- `src/mdh/store.js` — add `connected` tri-state signal.
- `src/mdh/index.jsx` — `boot()` → exported `initMdh()`; auth/api/render moved to shell; effects gated on `activeApp`.
- `src/audit/store.js` — add `connected` tri-state signal.
- `src/audit/index.jsx` — `boot()` → exported `initAudit()`; auth/api/render moved to shell; query effect gated on `activeApp`.
- `src/popup/utils.js` — replace `openMdhTab`/`openAuditTab` with `openConsoleTab(tab, authData, app)`.
- `src/popup/components/App.jsx` — re-point `onDataStorage`/`onAuditLogs`.
- `src/popup/components/MdhProvenancePanel.jsx` — re-point the pipeline-prefill open.
- `src/background/index.js` — stage `consoleAuth_`, open `console/console.html`, `app:'mdh'`.
- `build.js` — one `console` entry point + dirs + copies.
- `tests/popup-utils.test.js`, `tests/background.test.js` — updated key/URL/`app` assertions.
- `CLAUDE.md` — architecture, storage-keys, CSS-architecture, background sections.

**Removed files (via `git rm`):**
- `src/mdh/mdh.html`, `src/audit/audit.html`, `src/audit/audit.css`.
  (`src/mdh/mdh.css` is moved to `src/console/console.css` via `git mv`, not deleted.)

---

## Task 1: Console store

**Files:**
- Create: `src/console/store.js`
- Test: `tests/console-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { activeApp } from '../src/console/store.js';

describe('console store', () => {
  it('defaults to mdh', () => {
    expect(activeApp.value).toBe('mdh');
  });

  it('can switch to audit and back', () => {
    activeApp.value = 'audit';
    expect(activeApp.value).toBe('audit');
    activeApp.value = 'mdh';
    expect(activeApp.value).toBe('mdh');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-store.test.js`
Expected: FAIL — cannot resolve `../src/console/store.js`.

- [ ] **Step 3: Create the store**

```js
// src/console/store.js
import { signal } from '@preact/signals';

// Which app the console is currently showing.
export const activeApp = signal('mdh'); // 'mdh' | 'audit'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/console-store.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint** — `npx vitest run tests/console-store.test.js` green. Do not commit.

---

## Task 2: Pure boot helpers

**Files:**
- Create: `src/console/boot.js`
- Test: `tests/console-boot.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import {
  isValidApp,
  pickInitialApp,
  resolveBootAuth,
  computeStaleAuthRemovals,
} from '../src/console/boot.js';

describe('isValidApp', () => {
  it('accepts known apps only', () => {
    expect(isValidApp('mdh')).toBe(true);
    expect(isValidApp('audit')).toBe(true);
    expect(isValidApp('nope')).toBe(false);
    expect(isValidApp(undefined)).toBe(false);
  });
});

describe('pickInitialApp', () => {
  it('prefers a valid staging app (popup button wins)', () => {
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });
  it('falls back to the persisted app when no staging app', () => {
    expect(pickInitialApp({ persistedApp: 'audit' })).toBe('audit');
  });
  it('defaults to mdh when neither is valid', () => {
    expect(pickInitialApp({ stagingApp: 'x', persistedApp: 'y' })).toBe('mdh');
    expect(pickInitialApp({})).toBe('mdh');
  });
});

describe('resolveBootAuth', () => {
  it('consumes a staging entry and carries app + pipeline prefill', () => {
    const out = resolveBootAuth({
      entry: { token: 't', domain: 'd', app: 'audit', pendingCollection: 'invoices', pendingPipeline: '[]' },
      session: { token: null, domain: null },
    });
    expect(out).toEqual({
      token: 't',
      domain: 'd',
      stagingApp: 'audit',
      consumeKey: true,
      pendingCtx: { pendingCollection: 'invoices', pendingPipeline: '[]', pendingVariables: undefined },
    });
  });
  it('falls back to the session token/domain on reload', () => {
    const out = resolveBootAuth({
      entry: null,
      session: { token: 'st', domain: 'sd' },
    });
    expect(out).toEqual({
      token: 'st',
      domain: 'sd',
      stagingApp: undefined,
      consumeKey: false,
      pendingCtx: {},
    });
  });
});

describe('computeStaleAuthRemovals', () => {
  const TTL = 24 * 60 * 60 * 1000;
  it('removes expired consoleAuth_ entries and keeps fresh ones', () => {
    const now = 1_000_000_000;
    const all = {
      consoleAuth_fresh: { createdAt: now - 1000 },
      consoleAuth_old: { createdAt: now - TTL - 1 },
      consoleAuth_bad: { token: 'x' }, // no createdAt
      consoleActiveApp: 'mdh',
    };
    expect(computeStaleAuthRemovals(all, now, TTL).sort()).toEqual(
      ['consoleAuth_bad', 'consoleAuth_old'],
    );
  });
  it('sweeps orphaned old-build keys', () => {
    const now = 1_000_000_000;
    const all = {
      mdhAuth_x: { token: 'a' },
      auditAuth_y: { token: 'b' },
      mdhToken: 'leaked',
      mdhDomain: 'leaked',
      consoleActiveApp: 'audit',
    };
    expect(computeStaleAuthRemovals(all, now, TTL).sort()).toEqual(
      ['auditAuth_y', 'mdhAuth_x', 'mdhDomain', 'mdhToken'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-boot.test.js`
Expected: FAIL — cannot resolve `../src/console/boot.js`.

- [ ] **Step 3: Create the helpers**

```js
// src/console/boot.js
// Pure helpers for the console shell boot. Kept side-effect-free so they can be
// unit-tested without chrome / DOM / sessionStorage.

export function isValidApp(v) {
  return v === 'mdh' || v === 'audit';
}

// Which app to show on boot. Precedence: staging entry (a popup button click)
// wins, then the persisted last-used app, then Dataset Management.
export function pickInitialApp({ stagingApp, persistedApp } = {}) {
  if (isValidApp(stagingApp)) return stagingApp;
  if (isValidApp(persistedApp)) return persistedApp;
  return 'mdh';
}

// Resolve token/domain from a single-use staging entry (initial open) or the
// session fallback (same-tab reload). When an entry is present it is single-use
// (consumeKey === true) and carries the initial app + DS pipeline prefill.
export function resolveBootAuth({ entry, session }) {
  if (entry?.token && entry?.domain) {
    return {
      token: entry.token,
      domain: entry.domain,
      stagingApp: entry.app,
      consumeKey: true,
      pendingCtx: {
        pendingCollection: entry.pendingCollection,
        pendingPipeline: entry.pendingPipeline,
        pendingVariables: entry.pendingVariables,
      },
    };
  }
  return {
    token: session.token,
    domain: session.domain,
    stagingApp: undefined,
    consumeKey: false,
    pendingCtx: {},
  };
}

// Keys to purge from chrome.storage.local: stale (or malformed) consoleAuth_
// staging entries past the TTL, plus any orphaned keys left by pre-console
// builds (mdhAuth_/auditAuth_ staging, and mdhToken/mdhDomain at-rest creds).
export function computeStaleAuthRemovals(all, now, ttl) {
  const toRemove = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('consoleAuth_')) {
      const createdAt = value?.createdAt;
      if (typeof createdAt !== 'number' || now - createdAt > ttl) toRemove.push(key);
    } else if (
      key.startsWith('mdhAuth_') ||
      key.startsWith('auditAuth_') ||
      key === 'mdhToken' ||
      key === 'mdhDomain'
    ) {
      toRemove.push(key);
    }
  }
  return toRemove;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/console-boot.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 3: Refactor MDH boot into `initMdh()`

**Files:**
- Modify: `src/mdh/store.js` (add `connected` signal)
- Modify: `src/mdh/index.jsx` (full rewrite below)

This moves auth resolution, `api.init`, and `render` out to the shell, exports
`initMdh()`, sets a `connected` signal instead of rendering, and gates the
operations-polling and prefetch effects on `activeApp === 'mdh'`. The polling
helpers and `pollOperations` logic are unchanged.

- [ ] **Step 1: Add the `connected` signal to the MDH store**

In `src/mdh/store.js`, add after the existing `error`/`modalContent` signals:

```js
// Connection state for the Dataset Management app. null = not yet checked
// (shell shows a connecting state), true/false after the healthz probe. The
// shell passes this to <App connected={...}/>.
export const connected = signal(null);
```

- [ ] **Step 2: Rewrite `src/mdh/index.jsx`**

Replace the entire file with:

```jsx
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { prefetchForPanel, prefetchAll } from './prefetch.js';
import { LAST_PIPELINE_KEY, bootPrefillFor } from './lastPipeline.js';

const POLL_DELAY_VISIBLE = 5_000;
const POLL_DELAY_HIDDEN = 60_000;

let pollTimer = null;
let pollInFlight = false;

function shouldPoll() {
  return activeApp.value === 'mdh' && store.activeView.value === 'operations';
}

function currentPollDelay() {
  return document.visibilityState === 'hidden' ? POLL_DELAY_HIDDEN : POLL_DELAY_VISIBLE;
}

async function pollTick() {
  if (!shouldPoll()) return;
  pollInFlight = true;
  try { await pollOperations(); } catch {}
  pollInFlight = false;
  schedulePoll();
}

function schedulePoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollInFlight || !shouldPoll()) return;
  pollTimer = setTimeout(pollTick, currentPollDelay());
}

function onVisibilityChange() {
  if (!shouldPoll()) return;
  if (document.visibilityState === 'visible') {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!pollInFlight) pollTick();
  } else {
    schedulePoll();
  }
}

const STRUCTURAL_FIELDS = ['status', 'error_type', 'message', 'dataset_name', 'type'];

function hasStructuralChange(prev, next) {
  for (const key of STRUCTURAL_FIELDS) {
    if ((prev[key] || '') !== (next[key] || '')) return true;
  }
  return false;
}

async function pollOperations() {
  try {
    const res = await api.listOperations();
    const newOps = res.operations || [];
    if (!store.operationsLoaded.value) {
      store.operations.value = newOps;
      store.operationsLoaded.value = true;
      return;
    }
    const prevById = new Map(store.operations.value.map((o) => [o._id, o]));
    const newById = new Map(newOps.map((o) => [o._id, o]));

    const changedOps = [];
    for (const nextOp of newOps) {
      const prevOp = prevById.get(nextOp._id);
      if (!prevOp || hasStructuralChange(prevOp, nextOp)) changedOps.push(nextOp);
    }

    store.operations.value = store.operations.value.map((prevOp) => {
      const nextOp = newById.get(prevOp._id);
      if (!nextOp) return prevOp;
      return {
        ...prevOp,
        metadata: nextOp.metadata,
        started: nextOp.started,
        updated: nextOp.updated,
      };
    });

    if (changedOps.length === 0) return;
    store.pendingOperations.value = { ops: newOps, changedOps };
  } catch {
    // Silent — polling errors shouldn't disrupt the UI.
  }
}

// Post-auth setup for the Dataset Management app. The shell has already resolved
// auth, set store.domain/token, and called api.init. This restores persisted
// view state, applies any pipeline prefill, probes the connection, and registers
// the app's effects. Runs once (the shell memoizes per app).
export async function initMdh({ pendingCollection, pendingPipeline, pendingVariables } = {}) {
  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch', LAST_PIPELINE_KEY,
  ]);

  if (stored.mdhActiveView === 'operations' || stored.mdhActiveView === 'overview') {
    store.activeView.value = stored.mdhActiveView;
  }
  if (stored.mdhSelectedCollection) {
    store.selectedCollection.value = stored.mdhSelectedCollection;
  }
  if (stored.mdhActivePanel) {
    store.activePanel.value = stored.mdhActivePanel;
  }
  if (typeof stored.mdhOpsSearch === 'string') {
    store.opsSearch.value = stored.mdhOpsSearch;
  }

  if (pendingCollection) {
    store.activeView.value = 'collection';
    store.selectedCollection.value = pendingCollection;
    store.activePanel.value = 'data';
    if (pendingPipeline) {
      store.pendingPipelineLoad.value = {
        collection: pendingCollection,
        pipelineText: pendingPipeline,
        variables: pendingVariables || undefined,
      };
    }
  }

  const restoredPipeline = bootPrefillFor(
    stored[LAST_PIPELINE_KEY],
    store.selectedCollection.value,
    !!store.pendingPipelineLoad.value,
  );
  if (restoredPipeline) store.pendingPipelineLoad.value = restoredPipeline;

  let connected = false;
  try {
    await api.healthz();
    connected = true;
  } catch {
    connected = false;
  }
  store.connected.value = connected;

  if (connected) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    effect(() => {
      const view = store.activeView.value;
      const app = activeApp.value;
      if (app === 'mdh' && view === 'operations') {
        if (!pollInFlight && !pollTimer) pollTick();
      } else if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    });
  }

  effect(() => {
    chrome.storage.local.set({ mdhActiveView: store.activeView.value });
  });
  effect(() => {
    const v = store.selectedCollection.value;
    if (v) chrome.storage.local.set({ mdhSelectedCollection: v });
  });
  effect(() => {
    chrome.storage.local.set({ mdhActivePanel: store.activePanel.value });
  });
  effect(() => {
    chrome.storage.local.set({ mdhOpsSearch: store.opsSearch.value });
  });

  let bgController = null;
  effect(() => {
    const selected = store.selectedCollection.value;
    if (activeApp.value !== 'mdh') return;
    if (!selected || store.collections.value.length === 0) return;

    if (bgController) bgController.abort();
    bgController = new AbortController();
    const signal = bgController.signal;

    const panel = store.activePanel.value;

    (async () => {
      await prefetchForPanel(selected, panel, { signal });
      if (signal.aborted) return;
      await prefetchAll(selected, { signal });
    })();
  });
}
```

(Removed from the old file: `import { h, render }`, `import App`, `AUTH_TTL_MS`,
`purgeStaleAuthEntries`, `resolveAuthId`, the auth-resolution block, `api.init`,
`store.domain/token` assignment, the `render(<App/>)` calls, and the trailing
`boot()` call. Those responsibilities now live in the shell.)

- [ ] **Step 3: Run the existing MDH suite to confirm no regressions**

Run: `npx vitest run tests/mdh-flow.test.js tests/mdh-tabbar.test.js tests/mdh-prefetch.test.js`
Expected: PASS (these don't import the boot; the refactor is import-compatible). If any test imported `src/mdh/index.jsx` for a side-effect boot, update it to call `initMdh()` — none currently do.

- [ ] **Step 4: Checkpoint** — `npx vitest run` (full suite) still green except for the not-yet-touched popup/background tests (handled in Tasks 9–10). Do not commit.

---

## Task 4: Refactor Audit boot into `initAudit()`

**Files:**
- Modify: `src/audit/store.js` (add `connected` signal)
- Modify: `src/audit/index.jsx` (full rewrite below)

- [ ] **Step 1: Add the `connected` signal to the Audit store**

In `src/audit/store.js`, add after the existing `loading`/`error` signals:

```js
// Connection state for the Audit app. null = not yet checked (shell shows a
// connecting state), true/false after the whoami probe.
export const connected = signal(null);
```

- [ ] **Step 2: Rewrite `src/audit/index.jsx`**

Replace the entire file with:

```jsx
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { fetchPage } from './query.js';

// Post-auth setup for the Audit Log Viewer. The shell has already resolved auth,
// set store.domain/token, and called api.init. This restores persisted filters,
// probes the session, and registers the persist + query effects (the query
// effect is gated on the audit app being active). Runs once per session.
export async function initAudit() {
  const stored = await chrome.storage.local.get(['auditFilters', 'auditPageSize']);

  if (stored.auditFilters && typeof stored.auditFilters === 'object') {
    const sf = stored.auditFilters;
    store.filters.value = {
      object_type: typeof sf.object_type === 'string' && sf.object_type
        ? sf.object_type
        : store.filters.value.object_type,
      action: typeof sf.action === 'string' ? sf.action : '',
    };
  }
  if (Number.isFinite(stored.auditPageSize)) {
    store.pageSize.value = stored.auditPageSize;
  }

  let connected = false;
  try {
    await api.whoami();
    connected = true;
  } catch (err) {
    connected = false;
    store.error.value = err.message || 'Failed to verify session';
  }
  store.connected.value = connected;

  if (!connected) return;

  effect(() => {
    chrome.storage.local.set({ auditFilters: store.filters.value });
  });
  effect(() => {
    chrome.storage.local.set({ auditPageSize: store.pageSize.value });
  });

  let queryController = null;
  effect(() => {
    // Touch reactive deps so the effect re-runs when any of them change, and so
    // it re-runs (and fetches) when the user switches back to the audit app.
    const _f = store.filters.value;
    const _p = store.page.value;
    const _ps = store.pageSize.value;
    const _app = activeApp.value;
    if (activeApp.value !== 'audit') return;
    if (queryController) queryController.abort();
    queryController = new AbortController();
    fetchPage({ signal: queryController.signal });
  });
}
```

(Removed: auth resolution, `purgeStaleAuthEntries`, `resolveAuthId`,
`store.domain/token` assignment, `api.init`, the `render(<App/>)` calls, and the
trailing `boot()` call.)

- [ ] **Step 3: Run the Audit suite**

Run: `npx vitest run tests/audit-query.test.js tests/audit-api.test.js`
Expected: PASS (these don't import the boot).

- [ ] **Step 4: Checkpoint** — green. Do not commit.

---

## Task 5: Rail component

**Files:**
- Create: `src/console/components/Rail.jsx`
- Test: `tests/console-rail.test.js`

> Mirror the JSX/preact-render conventions of an existing component test such as
> `tests/mdh-tabbar.test.js` (same `@vitest-environment jsdom` + `h`/`render`
> imports the repo already uses).

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import Rail from '../src/console/components/Rail.jsx';
import { activeApp } from '../src/console/store.js';

describe('Rail', () => {
  let root;
  beforeEach(() => {
    activeApp.value = 'mdh';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('renders one button per app', () => {
    render(<Rail />, root);
    expect(root.querySelectorAll('.app-rail-item').length).toBe(2);
  });

  it('marks the active app with its full name as the tooltip', () => {
    render(<Rail />, root);
    const active = root.querySelector('.app-rail-item.active');
    expect(active.getAttribute('title')).toBe('Dataset Management');
  });

  it('clicking the Audit button sets activeApp to audit', () => {
    render(<Rail />, root);
    const auditBtn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Audit Log Viewer');
    auditBtn.click();
    expect(activeApp.value).toBe('audit');
  });

  it('re-renders the active marker after activeApp changes', () => {
    render(<Rail />, root);
    activeApp.value = 'audit';
    render(<Rail />, root);
    expect(root.querySelector('.app-rail-item.active').getAttribute('title')).toBe('Audit Log Viewer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-rail.test.js`
Expected: FAIL — cannot resolve `../src/console/components/Rail.jsx`.

- [ ] **Step 3: Create the component**

```jsx
// src/console/components/Rail.jsx
import { h } from 'preact';
import { activeApp } from '../store.js';

const DATA_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
  </svg>
);

const AUDIT_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const APPS = [
  { id: 'mdh', label: 'Data', title: 'Dataset Management', icon: DATA_ICON },
  { id: 'audit', label: 'Audit', title: 'Audit Log Viewer', icon: AUDIT_ICON },
];

export default function Rail() {
  const active = activeApp.value;
  return (
    <nav class="app-rail" aria-label="Application switcher">
      {APPS.map((a) => (
        <button
          type="button"
          class={'app-rail-item' + (active === a.id ? ' active' : '')}
          title={a.title}
          aria-current={active === a.id ? 'page' : undefined}
          onClick={() => { activeApp.value = a.id; }}
        >
          <span class="app-rail-icon">{a.icon}</span>
          <span class="app-rail-label">{a.label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/console-rail.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 6: Console shell component

**Files:**
- Create: `src/console/components/Console.jsx`

No standalone test (it's thin glue verified by the build + smoke test in Task 12);
the per-app `connected` tri-state and rail are already covered.

- [ ] **Step 1: Create the component**

```jsx
// src/console/components/Console.jsx
import { h, Fragment } from 'preact';
import { activeApp } from '../store.js';
import Rail from './Rail.jsx';
import MdhApp from '../../mdh/components/App.jsx';
import AuditApp from '../../audit/components/App.jsx';
import * as mdhStore from '../../mdh/store.js';
import * as auditStore from '../../audit/store.js';

function Connecting() {
  return (
    <div class="app-root">
      <div class="empty-state">Connecting{'…'}</div>
    </div>
  );
}

export default function Console() {
  const app = activeApp.value;

  let view;
  if (app === 'mdh') {
    const c = mdhStore.connected.value;
    view = c === null ? <Connecting /> : <MdhApp connected={c} />;
  } else {
    const c = auditStore.connected.value;
    view = c === null ? <Connecting /> : <AuditApp connected={c} />;
  }

  return (
    <Fragment>
      <Rail />
      {view}
    </Fragment>
  );
}
```

- [ ] **Step 2: Checkpoint** — `npx vitest run` still green (no new test; nothing imports this yet). Do not commit.

---

## Task 7: Shell boot glue + HTML

**Files:**
- Create: `src/console/index.jsx`
- Create: `src/console/console.html`

- [ ] **Step 1: Create `src/console/index.jsx`**

```jsx
import { h, render } from 'preact';
import { effect } from '@preact/signals';
import { activeApp } from './store.js';
import {
  pickInitialApp,
  resolveBootAuth,
  computeStaleAuthRemovals,
} from './boot.js';
import Console from './components/Console.jsx';
import * as mdhApi from '../mdh/api.js';
import * as mdhStore from '../mdh/store.js';
import { initMdh } from '../mdh/index.jsx';
import * as auditApi from '../audit/api.js';
import * as auditStore from '../audit/store.js';
import { initAudit } from '../audit/index.jsx';

const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const TITLES = {
  mdh: 'Dataset Management — Rossum SA',
  audit: 'Audit Logs — Rossum SA',
};

async function purgeStaleAuthEntries() {
  const all = await chrome.storage.local.get(null);
  const toRemove = computeStaleAuthRemovals(all, Date.now(), AUTH_TTL_MS);
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

function resolveAuthId() {
  const fromUrl = new URLSearchParams(location.search).get('authId');
  if (fromUrl) {
    sessionStorage.setItem('consoleAuthId', fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem('consoleAuthId');
}

let mdhInited = false;
let auditInited = false;
let pendingCtx = {};

function ensureInited(app) {
  if (app === 'mdh' && !mdhInited) {
    mdhInited = true;
    return initMdh(pendingCtx);
  }
  if (app === 'audit' && !auditInited) {
    auditInited = true;
    return initAudit();
  }
  return Promise.resolve();
}

async function boot() {
  const authId = resolveAuthId();
  const authKey = authId ? `consoleAuth_${authId}` : null;

  const stored = await chrome.storage.local.get([
    ...(authKey ? [authKey] : []),
    'consoleActiveApp',
  ]);
  const entry = authKey ? stored[authKey] : null;

  purgeStaleAuthEntries().catch(() => {});

  const { token, domain, stagingApp, consumeKey, pendingCtx: ctx } = resolveBootAuth({
    entry,
    session: {
      token: sessionStorage.getItem('consoleToken'),
      domain: sessionStorage.getItem('consoleDomain'),
    },
  });
  pendingCtx = ctx;

  if (consumeKey) {
    chrome.storage.local.remove(authKey);
    sessionStorage.setItem('consoleToken', token);
    sessionStorage.setItem('consoleDomain', domain);
  }

  const initial = pickInitialApp({ stagingApp, persistedApp: stored.consoleActiveApp });
  activeApp.value = initial;

  if (!token || !domain) {
    // No credentials: let each app render its own not-connected message instead
    // of a spinner that never resolves.
    mdhStore.connected.value = false;
    auditStore.connected.value = false;
    render(<Console />, document.getElementById('app'));
    return;
  }

  mdhStore.domain.value = domain;
  mdhStore.token.value = token;
  mdhApi.init(domain, token);

  auditStore.domain.value = domain;
  auditStore.token.value = token;
  auditApi.init(domain, token);

  effect(() => {
    chrome.storage.local.set({ consoleActiveApp: activeApp.value });
  });
  effect(() => {
    document.title = TITLES[activeApp.value] || 'Rossum SA';
  });

  // Initialize the initially-active app (and await its connection probe) before
  // first paint, so there's no not-connected flash. The other app initializes
  // lazily the first time it's activated.
  await ensureInited(initial);
  render(<Console />, document.getElementById('app'));
  effect(() => { ensureInited(activeApp.value); });
}

boot();
```

- [ ] **Step 2: Create `src/console/console.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rossum SA</title>
  <link href="console.css" rel="stylesheet" />
</head>
<body>
  <div id="app"></div>
  <script src="console.js"></script>
</body>
</html>
```

- [ ] **Step 3: Checkpoint** — `npx vitest run` green (still no bundle; integration verified in Task 12). Do not commit.

---

## Task 8: Move + extend the stylesheet → `console.css`

**Files:**
- Move: `src/mdh/mdh.css` → `src/console/console.css` (via `git mv`)
- Modify: `src/console/console.css` (add type tokens; append Audit + rail sections)
- Remove: `src/audit/audit.css` (via `git rm`)

- [ ] **Step 1: Move the stylesheet (preserves history, no commit)**

Run:
```bash
git mv src/mdh/mdh.css src/console/console.css
```

- [ ] **Step 2: Add Audit's type-badge tokens to both `:root` blocks**

In `src/console/console.css`, in the light `:root` block, add after the
`--danger-border: #fecaca;` line:

```css
  --type-doc-bg: #e0f2fe;
  --type-doc-fg: #075985;
  --type-ann-bg: #fef3c7;
  --type-ann-fg: #92400e;
  --type-user-bg: #ede9fe;
  --type-user-fg: #5b21b6;
```

In the dark `@media (prefers-color-scheme: dark) :root` block, add after the
dark `--danger-border: #4a2020;` line:

```css
    --type-doc-bg: #0c2535;
    --type-doc-fg: #7dd3fc;
    --type-ann-bg: #3a2f10;
    --type-ann-fg: #fcd34d;
    --type-user-bg: #2a1f4a;
    --type-user-fg: #c4b5fd;
```

- [ ] **Step 3: Append the rail + Audit-only sections to the end of `console.css`**

Append verbatim (these selectors do not exist in the moved stylesheet — the
shared rules `.btn*`, `.input*`, `.pagination*`, `.json-tree` base, `:root`,
`body`, `.app-root`, `.connection-bar`, `.connection-dot`, `.empty-state`,
`.error-banner` are intentionally NOT repeated; Audit's tree inherits the shared
`.json-tree` base):

```css
/* ===================================================================== */
/* App switcher rail                                                     */
/* ===================================================================== */

.app-rail {
  flex: none;
  width: 76px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; padding: 12px 0;
}

.app-rail-item {
  width: 60px;
  background: none; border: none; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 6px 0; border-radius: var(--radius);
  color: var(--text-secondary);
  font-family: var(--font-sans);
}

.app-rail-item:hover { background: var(--bg-hover); color: var(--text-primary); }

.app-rail-icon {
  width: 42px; height: 42px; border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-hover); color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
}

.app-rail-label { font-size: 10px; font-weight: 600; }

.app-rail-item.active { color: var(--text-primary); }
.app-rail-item.active .app-rail-icon { background: var(--accent); color: #fff; }

/* ===================================================================== */
/* Audit Log Viewer                                                      */
/* ===================================================================== */

.connection-meta { margin-left: auto; font-size: 10px; opacity: 0.5; }

.connection-dot.busy {
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Feature-unavailable view (audit endpoint refused with 403/404) */
.unavailable-panel { flex: 1; overflow: auto; padding: 32px 24px; max-width: 720px; margin: 0 auto; }
.unavailable-title { font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 10px; }
.unavailable-lead { color: var(--text-secondary); font-size: 13px; margin-bottom: 16px; }
.unavailable-causes { list-style: none; padding: 0; margin: 0 0 18px; display: flex; flex-direction: column; gap: 8px; }
.unavailable-causes li { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; font-size: 12px; color: var(--text-primary); }
.unavailable-causes strong { color: var(--accent); font-weight: 600; margin-right: 4px; }
.unavailable-raw { background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 16px; }
.unavailable-raw-label { display: block; font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 6px; }
.unavailable-raw code { font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); word-break: break-word; }
.unavailable-foot { color: var(--text-secondary); font-size: 12px; }

/* Filters bar */
.filters { background: var(--bg-card); border-bottom: 1px solid var(--border); padding: 10px 16px; flex-shrink: 0; }
.filters-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.filter { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.filter-grow { flex: 1; min-width: 220px; }
.filter-compact { min-width: 110px; }
.filter-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-family: var(--font-mono); display: flex; align-items: center; gap: 6px; }
.hint-tag { font-weight: 400; text-transform: none; letter-spacing: normal; font-size: 10px; color: var(--text-secondary); opacity: 0.7; }
.filters-actions { display: flex; gap: 6px; align-items: center; margin-left: auto; }

/* Results table */
.results-wrap { flex: 1; overflow: auto; padding: 0 16px; background: var(--bg-base); }
.results-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 12px; padding: 60px 16px; text-align: center; }
.results-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; margin-top: 8px; }
.results-table thead th { position: sticky; top: 0; background: var(--bg-base); text-align: left; font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 10px; border-bottom: 1px solid var(--border); z-index: 1; font-family: var(--font-mono); }
.results-table tbody td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; font-size: 12px; }
.result-row { cursor: pointer; background: var(--bg-card); transition: background 0.1s; }
.result-row:hover { background: var(--bg-hover); }
.result-row.expanded { background: var(--bg-hover); }
.col-time { width: 158px; white-space: nowrap; color: var(--text-secondary); }
.col-user { width: 200px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-type { width: 110px; }
.col-action { width: 140px; }
.col-id { width: 100px; text-align: right; }
.col-method { width: 70px; }
.col-status { width: 70px; text-align: right; }
.col-path { max-width: 0; }
.path-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--text-secondary); }
.mono { font-family: var(--font-mono); }
.muted { color: var(--text-secondary); opacity: 0.5; }
.type-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; font-family: var(--font-mono); background: var(--bg-hover); color: var(--text-secondary); }
.type-document { background: var(--type-doc-bg); color: var(--type-doc-fg); }
.type-annotation { background: var(--type-ann-bg); color: var(--type-ann-fg); }
.type-user { background: var(--type-user-bg); color: var(--type-user-fg); }
.status-2xx { color: var(--success); }
.status-3xx { color: var(--accent); }
.status-4xx { color: var(--warning); }
.status-5xx { color: var(--danger); font-weight: 600; }

/* Inline detail row */
.detail-row td { background: var(--bg-base); padding: 0 !important; border-bottom: 1px solid var(--border) !important; }
.record-detail { padding: 12px 16px 16px; }
.record-detail-meta { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: 11px; }
.meta-item { display: flex; gap: 6px; align-items: baseline; }
.meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); }
.meta-value { color: var(--text-primary); }
.meta-link { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; font-size: 11px; margin-left: auto; }
.meta-link:hover { color: var(--accent-hover); text-decoration: underline; }
.detail-section { margin-bottom: 6px; }
.detail-summary { cursor: pointer; padding: 3px 0; font-weight: 600; font-size: 11px; color: var(--text-primary); user-select: none; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.5px; }
.detail-summary:hover { color: var(--accent); }
.detail-body { padding: 6px 0 6px 14px; }

/* Audit JSON tree leaves (inherits the shared .json-tree base) */
.json-row { padding: 1px 0; line-height: 1.6; }
.json-key { color: var(--accent); }
.json-sep { color: var(--text-secondary); }
.json-index { color: var(--text-secondary); opacity: 0.6; }
.json-toggle { color: var(--text-secondary); cursor: pointer; user-select: none; }
.json-toggle:hover { color: var(--accent); }
.json-nested { padding-left: 14px; border-left: 1px dashed var(--border); margin-left: 2px; }
.json-leaf { color: var(--text-code); }
.json-string { color: var(--success-fg); }
.json-number { color: var(--accent); }
.json-bool { color: var(--warning); font-weight: 600; }
.json-null { color: var(--text-secondary); opacity: 0.7; font-style: italic; }
.json-empty { color: var(--text-secondary); opacity: 0.7; }

@media (prefers-color-scheme: dark) {
  .json-string { color: #86efac; }
}
```

- [ ] **Step 4: Remove the Audit stylesheet**

Run:
```bash
git rm src/audit/audit.css
```

- [ ] **Step 5: Checkpoint** — no test runs here (CSS); confirm `git status` shows the move + removal. Do not commit.

---

## Task 9: Popup launch wiring

**Files:**
- Modify: `src/popup/utils.js`
- Modify: `src/popup/components/App.jsx`
- Modify: `src/popup/components/MdhProvenancePanel.jsx`
- Test: `tests/popup-utils.test.js`

- [ ] **Step 1: Update the failing test first**

In `tests/popup-utils.test.js`, change the import line:

```js
import { runInTab, openConsoleTab, detectSite, findRossumTabs, activateTab } from '../src/popup/utils.js';
```

Replace the entire `describe('openMdhTab', ...)` and `describe('openAuditTab', ...)`
blocks with:

```js
describe('openConsoleTab', () => {
  it('stages consoleAuth_<uuid> with the app and opens the console tab', () => {
    const tab = { id: 99, index: 4 };
    const auth = { token: 'tok', domain: 'https://x.rossum.ai' };

    openConsoleTab(tab, auth, 'mdh');

    expect(storageSetMock).toHaveBeenCalledTimes(1);
    const [storageObj] = storageSetMock.mock.calls[0];
    expect(Object.keys(storageObj)).toEqual(['consoleAuth_uuid-1']);
    const entry = storageObj['consoleAuth_uuid-1'];
    expect(entry.token).toBe('tok');
    expect(entry.domain).toBe('https://x.rossum.ai');
    expect(entry.app).toBe('mdh');
    expect(typeof entry.createdAt).toBe('number');

    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=uuid-1',
      index: 5,
    });
  });

  it('stages app:"audit" when opened for the Audit Log Viewer', () => {
    openConsoleTab({ id: 7, index: 2 }, { token: 'a', domain: 'https://x.rossum.app' }, 'audit');
    const entry = storageSetMock.mock.calls[0][0]['consoleAuth_uuid-1'];
    expect(entry.app).toBe('audit');
    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=uuid-1',
      index: 3,
    });
  });

  it('passes through pendingCollection / pendingPipeline metadata', () => {
    openConsoleTab(
      { id: 1, index: 0 },
      { token: 't', domain: 'd', pendingCollection: 'invoices', pendingPipeline: '[]' },
      'mdh',
    );
    const entry = storageSetMock.mock.calls[0][0]['consoleAuth_uuid-1'];
    expect(entry.pendingCollection).toBe('invoices');
    expect(entry.pendingPipeline).toBe('[]');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/popup-utils.test.js`
Expected: FAIL — `openConsoleTab` is not exported.

- [ ] **Step 3: Replace `openMdhTab`/`openAuditTab` in `src/popup/utils.js`**

Delete the `openMdhTab` and `openAuditTab` functions (lines ~54–84) and add:

```js
// Stages the auth payload under a single-use consoleAuth_<uuid> key (carrying
// the initial app), then opens the unified console page pointing at it. The
// console reads consoleAuth_<uuid> on boot and consumes it; pending* pipeline
// prefill fields ride along inside authData. Cleaned up by the console's
// purgeStaleAuthEntries on subsequent boots.
export function openConsoleTab(tab, authData, app) {
  const authId = crypto.randomUUID();
  chrome.storage.local.set(
    { [`consoleAuth_${authId}`]: { ...authData, app, createdAt: Date.now() } },
    () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`console/console.html?authId=${authId}`),
        index: tab.index + 1,
      });
    },
  );
}
```

- [ ] **Step 4: Re-point the popup root (`src/popup/components/App.jsx`)**

Change the import on line 5 from:

```js
import { openMdhTab, openAuditTab, runInTab, detectSite, findRossumTabs, activateTab } from '../utils.js';
```

to:

```js
import { openConsoleTab, runInTab, detectSite, findRossumTabs, activateTab } from '../utils.js';
```

Change lines 171–172 from:

```js
  const onDataStorage = () => fetchAuthAndOpen(openMdhTab);
  const onAuditLogs = () => fetchAuthAndOpen(openAuditTab);
```

to:

```js
  const onDataStorage = () => fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth, 'mdh'));
  const onAuditLogs = () => fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth, 'audit'));
```

- [ ] **Step 5: Re-point the provenance panel (`src/popup/components/MdhProvenancePanel.jsx`)**

Change the import on line 20 from `import { openMdhTab, runInTab } from '../utils.js';`
to `import { openConsoleTab, runInTab } from '../utils.js';`

Change the call on line ~294 from `openMdhTab(tab, {` to `openConsoleTab(tab, {`
and add `, 'mdh'` as the trailing argument after the object literal's closing `)`.
(The object passed — with `pendingCollection`/`pendingPipeline` — is unchanged.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/popup-utils.test.js`
Expected: PASS.

- [ ] **Step 7: Checkpoint** — green. Do not commit.

---

## Task 10: Background worker

**Files:**
- Modify: `src/background/index.js`
- Test: `tests/background.test.js`

- [ ] **Step 1: Update the failing test first**

In `tests/background.test.js`, replace the two assertion-bearing `it(...)` bodies
that reference `mdhAuth_UUID` / `mdh/mdh.html` with:

```js
  it('stages a single-use consoleAuth entry with the token + domain + app', () => {
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.storageSet).toHaveBeenCalledWith(
      { consoleAuth_UUID: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', createdAt: 1234 } },
      expect.any(Function),
    );
  });

  it('opens console.html right next to the requesting tab (after the stage completes)', () => {
    openDatasetManagement(
      { token: 'tok', domain: 'https://x.rossum.app', openerTab: { index: 3, windowId: 7 } },
      deps,
    );
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://self/console/console.html?authId=UUID',
      index: 4,
      windowId: 7,
    });
  });

  it('opens without a position when there is no opener tab', () => {
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://self/console/console.html?authId=UUID',
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/background.test.js`
Expected: FAIL — still stages `mdhAuth_UUID` / opens `mdh/mdh.html`.

- [ ] **Step 3: Update `src/background/index.js`**

In `openDatasetManagement`, change the URL and the staged key:

```js
  const opts = { url: getURL(`console/console.html?authId=${authId}`) };
```

```js
  storageSet(
    { [`consoleAuth_${authId}`]: { token: msg.token, domain: msg.domain, app: 'mdh', createdAt: now() } },
    () => tabsCreate(opts),
  );
```

(Update the top comment's `mdh.html`/`mdhAuth_<uuid>` references to
`console/console.html`/`consoleAuth_<uuid>`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/background.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 11: Build wiring

**Files:**
- Modify: `build.js`

- [ ] **Step 1: Update the output dirs**

Change the `for (const dir of [...])` line from:

```js
for (const dir of ['dist/popup', 'dist/icons', 'dist/mdh', 'dist/audit']) {
```

to:

```js
for (const dir of ['dist/popup', 'dist/icons', 'dist/console']) {
```

- [ ] **Step 2: Update the static-asset copies**

Replace these four lines:

```js
cpSync('src/mdh/mdh.html', 'dist/mdh/mdh.html');
cpSync('src/mdh/mdh.css', 'dist/mdh/mdh.css');
cpSync('src/audit/audit.html', 'dist/audit/audit.html');
cpSync('src/audit/audit.css', 'dist/audit/audit.css');
```

with:

```js
cpSync('src/console/console.html', 'dist/console/console.html');
cpSync('src/console/console.css', 'dist/console/console.css');
```

- [ ] **Step 3: Update the entry points**

In `options.entryPoints`, remove the `'mdh/mdh'` and `'audit/audit'` lines and add
one console entry, so the object reads:

```js
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'scripts/coupa': 'src/coupa/index.js',
    'popup/popup': 'src/popup/popup.jsx',
    'console/console': 'src/console/index.jsx',
    'background': 'src/background/index.js',
  },
```

- [ ] **Step 4: Verify the build succeeds**

Run: `npm run build`
Expected: builds with no errors; `dist/console/console.js`, `dist/console/console.html`,
`dist/console/console.css` exist; no `dist/mdh` or `dist/audit` directories.
Verify: `ls dist/console && test ! -d dist/mdh && test ! -d dist/audit && echo OK`

- [ ] **Step 5: Checkpoint** — build clean. Do not commit.

---

## Task 12: Full suite + manual smoke

**Files:** none (verification)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS (vitest run). Fix any failure before proceeding.

- [ ] **Step 2: Remove the now-dead HTML shells**

Run:
```bash
git rm src/mdh/mdh.html src/audit/audit.html
```

- [ ] **Step 3: Rebuild and confirm**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Manual smoke (load unpacked `dist/` in Chrome)**

Verify each, in a real Rossum tab:
- Popup → **Data Storage** opens `console/console.html` on the rail's **Data** app; Dataset Management looks/behaves as before (collections sidebar, panels, operations polling).
- Popup → **Audit Logs** opens the same page on the **Audit** app, styled like Dataset Management (filters bar, results table, type pills, pagination), light + dark mode.
- Clicking the rail switches apps in place with no reload; the rail highlights the active app; the browser tab title updates.
- Reload the tab → it returns to the last-used app (token/domain persist via sessionStorage).
- Legacy MDH web app banner → **Open Dataset Management** opens the console on the Data app (background worker path).
- Audit on a tenant without the audit feature still shows the "unavailable" panel.

- [ ] **Step 5: Checkpoint** — full suite green + smoke verified. Do not commit (leave for the maintainer).

---

## Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Architecture / entry-points section**

- Change "Seven esbuild entry points" to "Six esbuild entry points" and replace
  the separate `src/mdh/index.jsx → mdh.html` and `src/audit/index.jsx → audit.html`
  bullets with a single bullet: `src/console/index.jsx` → unified Console page
  (`console.html`, opened via `chrome.tabs.create`) hosting a left app-switcher
  rail over two apps — Dataset Management (`src/mdh/`) and Audit Log Viewer
  (`src/audit/`).
- In the background-worker paragraph, change `mdh.html` to `console/console.html`
  and `mdhAuth_<uuid>` to `consoleAuth_<uuid>` (with `app:'mdh'`).
- Update the MDH/Audit auth-flow paragraphs to describe the single
  `consoleAuth_<uuid>` staging key (carrying `app`), shared `consoleToken`/
  `consoleDomain`/`consoleAuthId` in sessionStorage, and lazy per-app init.

- [ ] **Step 2: Update the Chrome Storage Keys section**

- Replace the `mdhAuth_<uuid>` and `auditAuth_<uuid>` staging-key bullets with a
  single `consoleAuth_<uuid>` bullet (single-use, 24h TTL, carries `app` +
  optional DS pipeline prefill).
- Add `consoleActiveApp` to the state keys.

- [ ] **Step 3: Update the CSS Architecture section**

- Rename `mdh.css` references to `console.css`; note `audit.css` is removed and
  Audit now uses the unified stylesheet; mention the `.app-rail*` rules.

- [ ] **Step 4: Checkpoint** — docs updated. Do not commit.

---

## Self-review notes (author)

- **Spec coverage:** §2 module layout → Tasks 1,2,5,6,7,8; §3 boot/auth → Tasks 2,7;
  §4 switching/init/gating → Tasks 3,4,7; §5 rail → Task 5; §6 popup/background →
  Tasks 9,10; §7 CSS → Task 8; §build → Task 11; §tests → Tasks 1,2,5,9,10,12;
  §docs → Task 13. All sections mapped.
- **Type consistency:** `activeApp` values `'mdh'`/`'audit'` used uniformly;
  `connected` tri-state (`null`/`true`/`false`) consistent across mdh/audit stores,
  `initMdh`/`initAudit`, and `Console`; `pendingCtx` shape
  (`pendingCollection`/`pendingPipeline`/`pendingVariables`) matches `resolveBootAuth`,
  `initMdh`, and `openConsoleTab` passthrough; `consoleAuth_`/`consoleActiveApp`/
  `consoleToken`/`consoleDomain`/`consoleAuthId` names consistent across boot.js,
  index.jsx, popup utils, and background.
- **No placeholders:** every code step contains full code; every command has an
  expected result.
