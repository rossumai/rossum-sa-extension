# Galaxy — 3D Org Birdview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commits:** The maintainer's standing preference is **no git commits during a run — stay on `master`, no branches/worktrees.** This plan therefore ends each task with a **Checkpoint** (run the relevant tests, and the build where noted) instead of a commit. Do not `git commit`, `git checkout -b`, or create worktrees unless the maintainer explicitly asks.

> **Implemented (2026-06-05) — deviations from this plan:** the scene was rebuilt on **raw three.js + d3-force-3d** instead of `3d-force-graph` (CSP/bundle reasons — see the design spec §0); **`connector` and `run_after` were dropped**; engines are fetched + named via `/engines` and the queue→engine ref uses the unified **`queue.engine`** field (verified live); and several UX features were added by maintainer request (light theme + rainbow palette, no auto-rotate, fit-on-open, click-to-pin dim, click-vs-drag, type-visibility filters with layout reflow, loading counter, curated detail panel). The task-by-task TDD structure below is preserved as the historical build record. Final suite: **726 tests green**.

**Goal:** Add a new Console app, "Galaxy", that fetches the live Rossum organization over REST and renders it as a rotating, explorable 3D force-directed network of resources (organization → workspaces → queues, plus hooks, connectors, engines and the `run_after` pipeline edges).

**Architecture:** A self-contained `src/galaxy/` module following the established MDH/Audit per-app pattern (a `store.js` of `@preact/signals`, an `api.js` REST client modeled on `src/audit/api.js`, a **pure** `graph.js` transform, an imperative `scene.js` wrapper around the `3d-force-graph` library, and Preact components). The Console shell hands the app its shared `domain`/`token` and lazily runs `initGalaxy()` on first activation. Three hardcoded rail switch-points learn the new `galaxy` id.

**Tech Stack:** Preact + `@preact/signals`, `3d-force-graph` (on `three.js`) with an `UnrealBloomPass`, esbuild (IIFE, minify, `jsxFactory: 'h'`), Vitest (jsdom).

---

## File Structure

**New files (`src/galaxy/`):**
- `store.js` — `@preact/signals`: `domain`, `token`, `connected`, `graph`, `loading`, `error`, `selectedNodeId`, `hoveredNodeId`.
- `api.js` — `init`, `get`, `buildQuery`, `listAll` (paginate), `fetchOrgResources` (raw bundle). Modeled on `src/audit/api.js`.
- `graph.js` — **pure** `buildGraph(raw) → {nodes, links}` + `idFromUrl(url)`. No DOM, no three.js. Fully unit-tested.
- `scene.js` — imperative `createScene(container) → { setData, onHover, onClick, focus, setIdleSpin, destroy }` wrapping `3d-force-graph` + bloom. Kept thin; hand-verified in the browser.
- `index.jsx` — `initGalaxy()`: connection probe (`whoami`), fetch + build graph into the store. Run-once (memoized by the shell).
- `components/App.jsx` — `default function App({ connected })`: renders the scene container + overlays, bridges signals ↔ `scene.js` via `preact/hooks`.
- `components/Legend.jsx` — color → resource-type legend overlay.
- `components/DetailCard.jsx` — focused-node facts + "Open in Rossum" (via existing `buildDeeplink`).

**New tests (`tests/`):**
- `galaxy-graph.test.js`, `galaxy-api.test.js`, `galaxy-scene.test.js`, `galaxy-detailcard.test.js`, `galaxy-app.test.js`, `galaxy-init.test.js`.

**Modified files (Console wiring):**
- `src/console/components/Rail.jsx` — icon + `APPS` entry.
- `src/console/components/Console.jsx` — three-way render switch.
- `src/console/boot.js` — `isValidApp` accepts `'galaxy'`.
- `src/console/index.jsx` — imports, `TITLES`, no-cred + connected branches, `ensureInited`.
- `tests/console-rail.test.js`, `tests/console-boot.test.js` — updated expectations.
- `console.css` — `.galaxy-*` styles.
- `CLAUDE.md` — architecture + storage-keys + dependency notes.
- (Optional) `src/popup/components/App.jsx` — a "Galaxy" launch button.

**Node/edge model (reference for all tasks):**

```js
// node:  { id: `${type}:${rawId}`, type, name, rawId, color, val }
// link:  { source: nodeId, target: nodeId, kind: 'containment' | 'reference' | 'run_after' }
// types: 'organization' | 'workspace' | 'queue' | 'hook' | 'connector' | 'engine'
```

```js
// Shared visual constants (define once in graph.js, re-export for scene/legend):
export const NODE_STYLE = {
  organization: { color: '#ffb648', val: 14 },
  workspace:    { color: '#5b9bff', val: 9 },
  queue:        { color: '#29d4c5', val: 5 },
  hook:         { color: '#b48cff', val: 6 },
  connector:    { color: '#3ddc91', val: 6 },
  engine:       { color: '#ff7eb6', val: 6 },
};
export const LINK_STYLE = {
  containment: { color: 'rgba(150,180,255,0.55)', width: 1.4 },
  reference:   { color: 'rgba(120,140,200,0.28)', width: 0.6 },
  run_after:   { color: 'rgba(180,140,255,0.50)', width: 1.0 },
};
```

---

## Task 1: Add the `3d-force-graph` dependency and confirm it bundles CSP-clean

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install the library**

Run:
```bash
npm install 3d-force-graph
```
Expected: `package.json` `dependencies` gains `3d-force-graph` (and the lockfile resolves `three`, `three-forcegraph`, `three-render-objects`, `kapsule`, `accessor-fn`). No peer-dep errors that block install.

- [ ] **Step 2: Confirm the existing build still succeeds**

Run:
```bash
npm run build
```
Expected: build completes; `dist/console/console.js` is produced.

- [ ] **Step 3: Confirm the bundled output is CSP-safe (no `eval`/`new Function`/`wasm`)**

Run:
```bash
grep -c -E "eval\(|new Function\(|WebAssembly" dist/console/console.js || echo "CLEAN"
```
Expected: prints `CLEAN` (or `0`). If it prints a non-zero count, STOP — something pulled in the `ngraph` engine path; ensure `scene.js` (Task 6) never calls `.forceEngine('ngraph')` and re-run. (Default `d3` engine is codegen-free.)

- [ ] **Step 4: Checkpoint**

Run:
```bash
npm test
```
Expected: the full suite still passes (no behavior changed yet).

---

## Task 2: `galaxy/store.js` — signals

**Files:**
- Create: `src/galaxy/store.js`
- Test: `tests/galaxy-app.test.js` (store defaults are asserted alongside App tests in Task 9; this task has a tiny inline default check)

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-store.test.js`:
```js
import { describe, it, expect } from 'vitest';
import * as store from '../src/galaxy/store.js';

describe('galaxy store', () => {
  it('exposes the shell-driven connection signals with safe defaults', () => {
    expect(store.domain.value).toBe('');
    expect(store.token.value).toBe('');
    expect(store.connected.value).toBe(null); // tri-state: null = not yet probed
  });
  it('starts with an empty graph and idle UI state', () => {
    expect(store.graph.value).toEqual({ nodes: [], links: [] });
    expect(store.loading.value).toBe(false);
    expect(store.error.value).toBe(null);
    expect(store.selectedNodeId.value).toBe(null);
    expect(store.hoveredNodeId.value).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-store.test.js`
Expected: FAIL — cannot resolve `../src/galaxy/store.js`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/store.js`:
```js
import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initGalaxy runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = not yet probed; true/false after whoami

// The org graph, built once by initGalaxy from the REST resources.
export const graph = signal({ nodes: [], links: [] });

// UI state.
export const loading = signal(false);
export const error = signal(null);
export const selectedNodeId = signal(null); // node.id of the focused node, or null
export const hoveredNodeId = signal(null);   // node.id under the cursor, or null
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-store.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-store.test.js` — PASS.

---

## Task 3: `galaxy/api.js` — REST client + pagination

**Files:**
- Create: `src/galaxy/api.js`
- Test: `tests/galaxy-api.test.js`

The `get`/`buildQuery`/timeout/401/403 behavior is copied from `src/audit/api.js` (the verified template). New here: `listAll` (follow `pagination.next` until exhausted) and `fetchOrgResources` (per-resource, with a 403/404→`[]` "partial galaxy" fallback so one forbidden collection never fails the whole load).

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-api.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/galaxy/api.js';

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api.init('https://x.rossum.ai', 'tok-123');
});
function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe('get headers + 401/403', () => {
  it('sends the Bearer token and Accept header', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));
    await api.get('/api/v1/queues/?page_size=100');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.rossum.ai/api/v1/queues/?page_size=100');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers.Accept).toBe('application/json');
  });
  it('throws a 401 session-expired error', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'x' }, { ok: false, status: 401 }));
    await expect(api.get('/api/v1/queues/')).rejects.toMatchObject({ status: 401 });
  });
  it('marks 403 as featureUnavailable', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'no' }, { ok: false, status: 403 }));
    await expect(api.get('/api/v1/queues/')).rejects.toMatchObject({ status: 403, featureUnavailable: true });
  });
});

describe('listAll', () => {
  it('concatenates results across pagination.next pages', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 1 }, { id: 2 }], pagination: { next: 'https://x.rossum.ai/api/v1/queues/?page=2' } }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 3 }], pagination: { next: null } }));
    const all = await api.listAll('/api/v1/queues/?page_size=2');
    expect(all.map((r) => r.id)).toEqual([1, 2, 3]);
    // second call uses the absolute next URL, made relative to baseDomain:
    expect(fetchMock.mock.calls[1][0]).toBe('https://x.rossum.ai/api/v1/queues/?page=2');
  });
  it('returns [] for an empty collection', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [], pagination: { next: null } }));
    expect(await api.listAll('/api/v1/connectors/')).toEqual([]);
  });
});

describe('fetchOrgResources', () => {
  it('assembles the raw bundle and tolerates a 403 on one collection', async () => {
    fetchMock.mockImplementation((url) => {
      if (url.includes('/organizations/')) return Promise.resolve(jsonRes({ results: [{ id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme' }], pagination: { next: null } }));
      if (url.includes('/workspaces/')) return Promise.resolve(jsonRes({ results: [{ id: 10 }], pagination: { next: null } }));
      if (url.includes('/queues/')) return Promise.resolve(jsonRes({ results: [{ id: 100 }], pagination: { next: null } }));
      if (url.includes('/hooks/')) return Promise.resolve(jsonRes({ detail: 'forbidden' }, { ok: false, status: 403 })); // forbidden → []
      if (url.includes('/connectors/')) return Promise.resolve(jsonRes({ results: [{ id: 5 }], pagination: { next: null } }));
      return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
    });
    const raw = await api.fetchOrgResources({});
    expect(raw.organization).toMatchObject({ id: 1, name: 'Acme' });
    expect(raw.workspaces).toEqual([{ id: 10 }]);
    expect(raw.queues).toEqual([{ id: 100 }]);
    expect(raw.hooks).toEqual([]); // 403 degraded to empty, not a throw
    expect(raw.connectors).toEqual([{ id: 5 }]);
  });
  it('rethrows a 401 (session expired) instead of swallowing it', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'x' }, { ok: false, status: 401 }));
    await expect(api.fetchOrgResources({})).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-api.test.js`
Expected: FAIL — cannot resolve `../src/galaxy/api.js`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/api.js`:
```js
// REST client for the Galaxy app. Mirrors src/audit/api.js (Bearer auth, 30s
// timeout, 401 -> session expired, 403 -> featureUnavailable) and adds full
// collection enumeration (listAll) plus a per-resource bundle fetch that
// degrades a forbidden collection to [] (a "partial galaxy", never a hard fail).
let baseDomain = '';
let authHeader = '';

export function init(domain, token) {
  baseDomain = domain;
  authHeader = `Bearer ${token}`;
}

const REQUEST_TIMEOUT = 30_000;

function combinedSignal(externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  if (externalSignal) {
    if (externalSignal.aborted) clearTimeout(timer);
    else externalSignal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return { signal, timer, externalSignal };
}

function apiError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Accepts either a path ('/api/v1/queues/') or an absolute URL (the pagination
// `next` link). Absolute URLs are passed through; paths are joined to baseDomain.
function toUrl(pathOrUrl) {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${baseDomain}${pathOrUrl}`;
}

export async function get(pathOrUrl, { signal: externalSignal } = {}) {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(toUrl(pathOrUrl), {
      headers: { Authorization: authHeader, Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (ext?.aborted) throw err;
      throw apiError('Request timed out after 30s', 0);
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Galaxy again to reconnect.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
    if (res.status === 403) err.featureUnavailable = true;
    throw err;
  }
  return data;
}

export function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

// Fully enumerate a Rossum collection by following pagination.next.
export async function listAll(pathOrUrl, { signal } = {}) {
  const out = [];
  let next = pathOrUrl;
  while (next) {
    const page = await get(next, { signal });
    if (Array.isArray(page?.results)) out.push(...page.results);
    next = page?.pagination?.next || null;
  }
  return out;
}

// listAll, but a 403/404 on the collection degrades to [] (partial galaxy).
// 401 still propagates (session expired must reach the shell).
async function safeListAll(pathOrUrl, opts) {
  try {
    return await listAll(pathOrUrl, opts);
  } catch (err) {
    if (err.status === 403 || err.status === 404) return [];
    throw err;
  }
}

// Fetch the raw resource bundle the graph builder needs. Engines are NOT fetched
// here — they are derived in graph.js from distinct queue engine references
// (see plan §12 / graph.js).
export async function fetchOrgResources({ signal } = {}) {
  const q = buildQuery({ page_size: 100 });
  const [orgs, workspaces, queues, hooks, connectors] = await Promise.all([
    safeListAll(`/api/v1/organizations/?${q}`, { signal }),
    safeListAll(`/api/v1/workspaces/?${q}`, { signal }),
    safeListAll(`/api/v1/queues/?${q}`, { signal }),
    safeListAll(`/api/v1/hooks/?${q}`, { signal }),
    safeListAll(`/api/v1/connectors/?${q}`, { signal }),
  ]);
  return {
    organization: orgs[0] || null,
    workspaces,
    queues,
    hooks,
    connectors,
  };
}

export function whoami({ signal } = {}) {
  return get('/api/v1/auth/user/', { signal });
}
```

> Note: `Promise.all` means a 401 from any one collection rejects the whole bundle (correct — session expired). 403/404 on a single collection is swallowed to `[]` by `safeListAll` before `Promise.all` sees it.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-api.test.js`
Expected: PASS (all blocks).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-api.test.js` — PASS.

---

## Task 4: `galaxy/graph.js` — the pure graph builder (core logic)

**Files:**
- Create: `src/galaxy/graph.js`
- Test: `tests/galaxy-graph.test.js`

This is the heart of the feature. `buildGraph(raw)` turns the REST bundle into `{nodes, links}`: it parses ids out of Rossum's hyperlinked URL refs, derives engine nodes from queue references, inverts `hook.queues[]` into queue→hook edges, turns `hook.run_after[]` into hook→hook edges, and tolerates any missing/renamed ref by simply omitting that edge.

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-graph.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { buildGraph, idFromUrl } from '../src/galaxy/graph.js';

describe('idFromUrl', () => {
  it('parses the trailing numeric id', () => {
    expect(idFromUrl('https://x/api/v1/queues/123')).toBe('123');
    expect(idFromUrl('https://x/api/v1/queues/123/')).toBe('123');
    expect(idFromUrl('https://x/api/v1/queues/123?foo=1')).toBe('123');
  });
  it('returns null for non-strings / no id', () => {
    expect(idFromUrl(null)).toBe(null);
    expect(idFromUrl('https://x/api/v1/queues/')).toBe(null);
    expect(idFromUrl(42)).toBe(null);
  });
});

const RAW = {
  organization: { id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme' },
  workspaces: [
    { id: 10, url: 'https://x/api/v1/workspaces/10', name: 'WS A', organization: 'https://x/api/v1/organizations/1' },
  ],
  queues: [
    { id: 100, url: 'https://x/api/v1/queues/100', name: 'Invoices', workspace: 'https://x/api/v1/workspaces/10', connector: 'https://x/api/v1/connectors/5', dedicated_engine: 'https://x/api/v1/engines/7' },
    { id: 101, url: 'https://x/api/v1/queues/101', name: 'Receipts', workspace: 'https://x/api/v1/workspaces/10', connector: null, generic_engine: 'https://x/api/v1/engines/8' },
    { id: 102, url: 'https://x/api/v1/queues/102', name: 'Orphan', workspace: 'https://x/api/v1/workspaces/999' }, // ws missing -> no containment link
  ],
  hooks: [
    { id: 200, url: 'https://x/api/v1/hooks/200', name: 'Validate', queues: ['https://x/api/v1/queues/100'], run_after: [] },
    { id: 201, url: 'https://x/api/v1/hooks/201', name: 'Export', queues: ['https://x/api/v1/queues/100', 'https://x/api/v1/queues/101', 'https://x/api/v1/queues/777'], run_after: ['https://x/api/v1/hooks/200'] },
  ],
  connectors: [{ id: 5, url: 'https://x/api/v1/connectors/5', name: 'NetSuite' }],
};

describe('buildGraph', () => {
  const g = buildGraph(RAW);
  const ids = g.nodes.map((n) => n.id).sort();
  const has = (s, t, kind) => g.links.some((l) => l.source === s && l.target === t && l.kind === kind);

  it('creates one node per resource plus engines derived from queue refs', () => {
    expect(ids).toEqual([
      'connector:5', 'engine:7', 'engine:8',
      'hook:200', 'hook:201',
      'organization:1',
      'queue:100', 'queue:101', 'queue:102',
      'workspace:10',
    ]);
  });
  it('tags nodes with type, name, rawId and a color', () => {
    const org = g.nodes.find((n) => n.id === 'organization:1');
    expect(org).toMatchObject({ type: 'organization', name: 'Acme', rawId: '1' });
    expect(typeof org.color).toBe('string');
    expect(org.val).toBeGreaterThan(0);
  });
  it('links org -> workspace -> queue (containment)', () => {
    expect(has('organization:1', 'workspace:10', 'containment')).toBe(true);
    expect(has('workspace:10', 'queue:100', 'containment')).toBe(true);
    expect(has('workspace:10', 'queue:101', 'containment')).toBe(true);
  });
  it('omits a containment link when the referenced workspace is missing', () => {
    expect(g.links.some((l) => l.target === 'queue:102' && l.kind === 'containment')).toBe(false);
  });
  it('inverts hook.queues[] into queue -> hook reference links and skips unknown queues', () => {
    expect(has('queue:100', 'hook:200', 'reference')).toBe(true);
    expect(has('queue:100', 'hook:201', 'reference')).toBe(true);
    expect(has('queue:101', 'hook:201', 'reference')).toBe(true);
    expect(g.links.some((l) => l.source === 'queue:777')).toBe(false); // 777 not a node
  });
  it('turns run_after into a hook -> hook edge (predecessor -> successor)', () => {
    expect(has('hook:200', 'hook:201', 'run_after')).toBe(true);
  });
  it('links queue -> connector and queue -> derived engine', () => {
    expect(has('queue:100', 'connector:5', 'reference')).toBe(true);
    expect(has('queue:100', 'engine:7', 'reference')).toBe(true);
    expect(has('queue:101', 'engine:8', 'reference')).toBe(true);
  });
  it('never throws on an empty bundle', () => {
    expect(buildGraph({ organization: null, workspaces: [], queues: [], hooks: [], connectors: [] }))
      .toEqual({ nodes: [], links: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-graph.test.js`
Expected: FAIL — cannot resolve `../src/galaxy/graph.js`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/graph.js`:
```js
// Pure transform: REST resource bundle -> { nodes, links } for 3d-force-graph.
// No DOM, no three.js. Tolerates missing/renamed refs by omitting edges.

export const NODE_STYLE = {
  organization: { color: '#ffb648', val: 14 },
  workspace:    { color: '#5b9bff', val: 9 },
  queue:        { color: '#29d4c5', val: 5 },
  hook:         { color: '#b48cff', val: 6 },
  connector:    { color: '#3ddc91', val: 6 },
  engine:       { color: '#ff7eb6', val: 6 },
};
export const LINK_STYLE = {
  containment: { color: 'rgba(150,180,255,0.55)', width: 1.4 },
  reference:   { color: 'rgba(120,140,200,0.28)', width: 0.6 },
  run_after:   { color: 'rgba(180,140,255,0.50)', width: 1.0 },
};

// Trailing numeric id out of a Rossum hyperlinked URL ('.../queues/123' -> '123').
export function idFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

function nodeId(type, rawId) {
  return `${type}:${rawId}`;
}

export function buildGraph(raw) {
  const nodes = [];
  const links = [];
  const present = new Set(); // node ids that exist, so we never link to a missing node

  function addNode(type, rawId, name) {
    if (rawId == null) return null;
    const id = nodeId(type, String(rawId));
    if (present.has(id)) return id;
    present.add(id);
    const style = NODE_STYLE[type] || { color: '#ffffff', val: 5 };
    nodes.push({ id, type, rawId: String(rawId), name: name || `${type} ${rawId}`, color: style.color, val: style.val });
    return id;
  }
  function addLink(sourceId, targetId, kind) {
    if (!sourceId || !targetId) return;
    if (!present.has(sourceId) || !present.has(targetId)) return;
    links.push({ source: sourceId, target: targetId, kind });
  }

  // Organization (single root).
  const orgId = raw?.organization ? addNode('organization', raw.organization.id ?? idFromUrl(raw.organization.url), raw.organization.name) : null;

  // Workspaces.
  for (const ws of raw?.workspaces || []) {
    addNode('workspace', ws.id ?? idFromUrl(ws.url), ws.name);
  }
  // Queues (+ engines derived from queue refs).
  for (const q of raw?.queues || []) {
    addNode('queue', q.id ?? idFromUrl(q.url), q.name);
    const engUrl = q.dedicated_engine || q.generic_engine;
    const engId = idFromUrl(engUrl);
    if (engId) addNode('engine', engId, `Engine ${engId}`);
  }
  // Connectors.
  for (const c of raw?.connectors || []) {
    addNode('connector', c.id ?? idFromUrl(c.url), c.name);
  }
  // Hooks.
  for (const hk of raw?.hooks || []) {
    addNode('hook', hk.id ?? idFromUrl(hk.url), hk.name);
  }

  // Containment: org -> workspace.
  for (const ws of raw?.workspaces || []) {
    const wsId = nodeId('workspace', ws.id ?? idFromUrl(ws.url));
    const parent = orgId || (ws.organization ? nodeId('organization', idFromUrl(ws.organization)) : null);
    addLink(parent, wsId, 'containment');
  }
  // Containment: workspace -> queue. References: queue -> connector / engine.
  for (const q of raw?.queues || []) {
    const qId = nodeId('queue', q.id ?? idFromUrl(q.url));
    const wsRef = idFromUrl(q.workspace);
    if (wsRef) addLink(nodeId('workspace', wsRef), qId, 'containment');
    const connRef = idFromUrl(q.connector);
    if (connRef) addLink(qId, nodeId('connector', connRef), 'reference');
    const engRef = idFromUrl(q.dedicated_engine || q.generic_engine);
    if (engRef) addLink(qId, nodeId('engine', engRef), 'reference');
  }
  // Reference: queue -> hook (invert hook.queues[]). Ordering: hook -> hook (run_after).
  for (const hk of raw?.hooks || []) {
    const hkId = nodeId('hook', hk.id ?? idFromUrl(hk.url));
    for (const qUrl of hk.queues || []) {
      const qRef = idFromUrl(qUrl);
      if (qRef) addLink(nodeId('queue', qRef), hkId, 'reference');
    }
    for (const predUrl of hk.run_after || []) {
      const predRef = idFromUrl(predUrl);
      if (predRef) addLink(nodeId('hook', predRef), hkId, 'run_after'); // predecessor -> this hook
    }
  }

  return { nodes, links };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-graph.test.js`
Expected: PASS (every block).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-graph.test.js` — PASS.

---

## Task 5: `galaxy/scene.js` — imperative `3d-force-graph` wrapper

**Files:**
- Create: `src/galaxy/scene.js`
- Test: `tests/galaxy-scene.test.js`

`scene.js` is the one module that cannot run under jsdom (it needs WebGL). Keep it thin: it is mostly configuration of `3d-force-graph`. The unit test **mocks** `3d-force-graph` and `three` and asserts the wiring (data passthrough, hover/click registration, idle-spin toggle, destroy). The visuals are verified by hand in Task 12.

Interface: `createScene(container) → { setData, onHover, onClick, focus, setIdleSpin, destroy }`.

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-scene.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A chainable fake of the 3d-force-graph instance: every config method returns
// `this`, and we capture the callbacks/data the scene wires up.
const captured = {};
function makeFakeGraph() {
  const g = {};
  const chain = (name) => (arg) => { captured[name] = arg; return g; };
  for (const m of ['graphData', 'backgroundColor', 'nodeId', 'nodeVal', 'nodeColor', 'nodeLabel',
                    'nodeThreeObject', 'linkColor', 'linkWidth', 'linkDirectionalParticles',
                    'onNodeHover', 'onNodeClick', 'onBackgroundClick', 'cooldownTicks',
                    'onEngineStop', 'width', 'height', 'showNavInfo', 'd3VelocityDecay']) {
    g[m] = chain(m);
  }
  g.controls = () => ({ autoRotate: false, autoRotateSpeed: 0, addEventListener: vi.fn() });
  g.postProcessingComposer = () => ({ addPass: vi.fn() });
  g.cameraPosition = vi.fn();
  g.scene = () => ({});
  g._destructor = vi.fn();
  return g;
}

vi.mock('3d-force-graph', () => ({
  default: () => () => makeFakeGraph(), // ForceGraph3D()(container) -> instance
}));
vi.mock('three', () => ({
  Mesh: class {}, SphereGeometry: class {}, MeshBasicMaterial: class {},
  Sprite: class { constructor() { this.scale = { set: () => {} }; } },
  SpriteMaterial: class {}, CanvasTexture: class {}, Color: class {},
  Vector2: class { constructor() {} },
}));
vi.mock('three/addons/postprocessing/UnrealBloomPass.js', () => ({ UnrealBloomPass: class {} }));

import { createScene } from '../src/galaxy/scene.js';

describe('createScene', () => {
  let container, scene;
  beforeEach(() => {
    for (const k of Object.keys(captured)) delete captured[k];
    container = document.createElement('div');
    document.body.appendChild(container);
    scene = createScene(container);
  });

  it('pushes graph data through to graphData()', () => {
    const data = { nodes: [{ id: 'queue:1', type: 'queue' }], links: [] };
    scene.setData(data);
    expect(captured.graphData).toEqual(data);
  });
  it('registers a hover callback that reports node id (or null)', () => {
    const seen = [];
    scene.onHover((id) => seen.push(id));
    captured.onNodeHover({ id: 'hook:9' });
    captured.onNodeHover(null);
    expect(seen).toEqual(['hook:9', null]);
  });
  it('registers a click callback that reports node id', () => {
    const seen = [];
    scene.onClick((id) => seen.push(id));
    captured.onNodeClick({ id: 'workspace:3' });
    expect(seen).toEqual(['workspace:3']);
  });
  it('exposes setIdleSpin and destroy without throwing', () => {
    expect(() => scene.setIdleSpin(true)).not.toThrow();
    expect(() => scene.destroy()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-scene.test.js`
Expected: FAIL — cannot resolve `../src/galaxy/scene.js`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/scene.js`:
```js
// Imperative wrapper around 3d-force-graph. Thin on purpose: configuration only.
// Hand-verified in the browser (no WebGL under jsdom); unit-tested via a mock.
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { NODE_STYLE, LINK_STYLE } from './graph.js';

// A small canvas-texture label sprite (used for always-on org/workspace names).
function labelSprite(text, color) {
  const pad = 8, font = 28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width;
  canvas.width = w + pad * 2; canvas.height = font + pad * 2;
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthWrite: false, transparent: true }));
  sprite.scale.set(canvas.width / 6, canvas.height / 6, 1);
  return sprite;
}

export function createScene(container) {
  const graph = ForceGraph3D()(container);

  // Highlight state for hover (a node + its direct neighbors).
  const highlightNodes = new Set();
  const adjacency = new Map(); // nodeId -> Set(neighborId)
  let hoverCb = () => {};
  let clickCb = () => {};
  let idleTimer = null;

  function rebuildAdjacency(links) {
    adjacency.clear();
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s).add(t);
      adjacency.get(t).add(s);
    }
  }

  const dim = (rgba, on) => (on ? rgba : rgba.replace(/[\d.]+\)$/, '0.05)'));

  graph
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .nodeId('id')
    .nodeVal((n) => n.val)
    .nodeLabel((n) => n.name)               // built-in hover tooltip
    .d3VelocityDecay(0.3)
    .nodeColor((n) => (highlightNodes.size && !highlightNodes.has(n.id)) ? 'rgba(120,140,200,0.15)' : n.color)
    .nodeThreeObject((n) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(n.val), new THREE.MeshBasicMaterial({ color: n.color }));
      if (n.type === 'organization' || n.type === 'workspace') {
        const sprite = labelSprite(n.name, '#e8edff');
        sprite.position.set(0, n.val + 4, 0);
        mesh.add(sprite);
      }
      return mesh;
    })
    .nodeThreeObjectExtend(true)
    .linkColor((l) => dim(LINK_STYLE[l.kind]?.color || 'rgba(150,150,150,0.3)', !highlightNodes.size))
    .linkWidth((l) => LINK_STYLE[l.kind]?.width || 0.5)
    .linkDirectionalParticles((l) => (l.kind === 'run_after' ? 2 : 0))
    .cooldownTicks(120)
    .onNodeHover((node) => {
      highlightNodes.clear();
      if (node) {
        highlightNodes.add(node.id);
        for (const nb of adjacency.get(node.id) || []) highlightNodes.add(nb);
      }
      graph.nodeColor(graph.nodeColor()).linkColor(graph.linkColor()); // re-apply accessors to refresh
      hoverCb(node ? node.id : null);
    })
    .onNodeClick((node) => {
      // Ease the camera toward the node.
      const dist = 90;
      const r = Math.hypot(node.x || 0, node.y || 0, node.z || 0) || 1;
      graph.cameraPosition(
        { x: (node.x || 0) * (1 + dist / r), y: (node.y || 0) * (1 + dist / r), z: (node.z || 0) * (1 + dist / r) },
        node, 1200,
      );
      clickCb(node ? node.id : null);
    })
    .onBackgroundClick(() => clickCb(null));

  // Bloom for the neon glow.
  const bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth || 800, container.clientHeight || 600), 1.1, 0.6, 0.1);
  graph.postProcessingComposer().addPass(bloom);

  // Idle auto-rotate: spin once the layout settles; pause on user interaction.
  const controls = graph.controls();
  controls.autoRotateSpeed = 0.6;
  graph.onEngineStop(() => { controls.autoRotate = true; });
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    if (idleTimer) clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { controls.autoRotate = true; }, 4000);
  });

  function resize() { graph.width(container.clientWidth).height(container.clientHeight); }
  resize();
  window.addEventListener('resize', resize);

  return {
    setData(data) {
      // Seed initial positions by depth so the settled layout reads hierarchically.
      const depth = { organization: 0, workspace: 1, queue: 2, connector: 3, engine: 3, hook: 3 };
      for (const n of data.nodes) {
        const d = depth[n.type] ?? 2;
        const a = (parseInt(n.rawId, 10) || 0) * 2.4;
        const radius = d * 80;
        n.x = Math.cos(a) * radius;
        n.y = (d - 1) * 60;
        n.z = Math.sin(a) * radius;
      }
      rebuildAdjacency(data.links);
      graph.graphData(data);
    },
    onHover(cb) { hoverCb = cb || (() => {}); },
    onClick(cb) { clickCb = cb || (() => {}); },
    focus(nodeId) {
      const node = graph.graphData().nodes.find((n) => n.id === nodeId);
      if (node) graph.onNodeClick()(node);
    },
    setIdleSpin(on) { graph.controls().autoRotate = !!on; },
    destroy() {
      window.removeEventListener('resize', resize);
      if (idleTimer) clearTimeout(idleTimer);
      try { graph._destructor && graph._destructor(); } catch { /* noop */ }
      container.innerHTML = '';
    },
  };
}
```

> If the `grep` from Task 1 Step 3 ever reports non-zero after this task, it is a regression here — re-confirm no `.forceEngine('ngraph')` exists (it does not in this code).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-scene.test.js`
Expected: PASS (data passthrough, hover, click, idle/destroy).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-scene.test.js` — PASS.

---

## Task 6: `galaxy/components/Legend.jsx`

**Files:**
- Create: `src/galaxy/components/Legend.jsx`
- Test: `tests/galaxy-app.test.js` covers it indirectly; add a focused check here.

- [ ] **Step 1: Write the failing test**

Append to a new file `tests/galaxy-legend.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import Legend from '../src/galaxy/components/Legend.jsx';

describe('Legend', () => {
  it('renders one swatch per resource type', () => {
    const root = document.createElement('div');
    render(h(Legend, null), root);
    expect(root.querySelectorAll('.galaxy-legend-item').length).toBe(6);
    expect(root.textContent).toContain('Organization');
    expect(root.textContent).toContain('Queue');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-legend.test.js`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/components/Legend.jsx`:
```jsx
import { h } from 'preact';
import { NODE_STYLE } from '../graph.js';

const LABELS = {
  organization: 'Organization', workspace: 'Workspace', queue: 'Queue',
  hook: 'Hook', connector: 'Connector', engine: 'Engine',
};

export default function Legend() {
  return (
    <div class="galaxy-legend">
      {Object.keys(LABELS).map((type) => (
        <span class="galaxy-legend-item">
          <i class="galaxy-legend-dot" style={`background:${NODE_STYLE[type].color}`}></i>
          {LABELS[type]}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-legend.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-legend.test.js` — PASS.

---

## Task 7: `galaxy/components/DetailCard.jsx` + deep-link consumption

**Files:**
- Create: `src/galaxy/components/DetailCard.jsx`
- Test: `tests/galaxy-detailcard.test.js`

The card reads `selectedNodeId` + `graph` from the store, finds the node, shows its facts, and renders an "Open in Rossum" link via the existing `buildDeeplink(origin, type, rawId)`. Per the "correctness over guessing" rule, only node types with a known route (`queue`, `hook`) get a link in v1; others hide the button (the existing `buildDeeplink` returns `null` for unknown types). Task 11 adds the remaining routes after live verification.

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-detailcard.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import DetailCard from '../src/galaxy/components/DetailCard.jsx';
import * as store from '../src/galaxy/store.js';

beforeEach(() => {
  store.domain.value = 'https://acme.rossum.app';
  store.graph.value = {
    nodes: [
      { id: 'queue:100', type: 'queue', rawId: '100', name: 'Invoices', color: '#29d4c5' },
      { id: 'workspace:10', type: 'workspace', rawId: '10', name: 'WS A', color: '#5b9bff' },
    ],
    links: [],
  };
  store.selectedNodeId.value = null;
});
function mount() {
  const root = document.createElement('div');
  render(h(DetailCard, null), root);
  return root;
}

describe('DetailCard', () => {
  it('renders nothing when no node is selected', () => {
    store.selectedNodeId.value = null;
    expect(mount().querySelector('.galaxy-detail-card')).toBe(null);
  });
  it('shows the selected node name + type and a working Rossum link for a queue', () => {
    store.selectedNodeId.value = 'queue:100';
    const root = mount();
    expect(root.querySelector('.galaxy-detail-card').textContent).toContain('Invoices');
    const link = root.querySelector('a.galaxy-detail-link');
    expect(link.getAttribute('href')).toBe('https://acme.rossum.app/queues/100');
  });
  it('hides the Rossum link for a type without a known route (workspace, v1)', () => {
    store.selectedNodeId.value = 'workspace:10';
    const root = mount();
    expect(root.querySelector('.galaxy-detail-card').textContent).toContain('WS A');
    expect(root.querySelector('a.galaxy-detail-link')).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-detailcard.test.js`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/components/DetailCard.jsx`:
```jsx
import { h } from 'preact';
import { selectedNodeId, graph, domain } from '../store.js';
import { buildDeeplink } from '../../audit/deeplink.js';

const TYPE_LABEL = {
  organization: 'Organization', workspace: 'Workspace', queue: 'Queue',
  hook: 'Hook', connector: 'Connector', engine: 'Engine',
};

function facts(node, g) {
  if (node.type !== 'queue') return [];
  const out = [];
  const refs = g.links.filter((l) => (l.source.id || l.source) === node.id);
  const hooks = refs.filter((l) => String(l.target.id || l.target).startsWith('hook:')).length;
  const conn = refs.find((l) => String(l.target.id || l.target).startsWith('connector:'));
  const eng = refs.find((l) => String(l.target.id || l.target).startsWith('engine:'));
  out.push(['Attached hooks', String(hooks)]);
  if (conn) out.push(['Connector', String(conn.target.id || conn.target).split(':')[1]]);
  if (eng) out.push(['Engine', String(eng.target.id || eng.target).split(':')[1]]);
  return out;
}

export default function DetailCard() {
  const id = selectedNodeId.value;
  if (!id) return null;
  const g = graph.value;
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return null;

  const href = buildDeeplink(domain.value, node.type, node.rawId);
  const rows = facts(node, g);

  return (
    <div class="galaxy-detail-card">
      <button type="button" class="galaxy-detail-close" title="Close" onClick={() => { selectedNodeId.value = null; }}>×</button>
      <div class="galaxy-detail-type" style={`color:${node.color}`}>{TYPE_LABEL[node.type] || node.type}</div>
      <div class="galaxy-detail-name">{node.name}</div>
      {rows.length > 0 && (
        <dl class="galaxy-detail-facts">
          {rows.map(([k, v]) => (<div><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>
      )}
      {href && (
        <a class="galaxy-detail-link" href={href} target="_blank" rel="noopener noreferrer">Open in Rossum</a>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-detailcard.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-detailcard.test.js` — PASS.

---

## Task 8: `galaxy/components/App.jsx` — root + scene bridge

**Files:**
- Create: `src/galaxy/components/App.jsx`
- Test: `tests/galaxy-app.test.js` (mocks `scene.js`)

`App.jsx` renders the not-connected / loading / error states and, when connected, mounts `scene.js` into a ref'd container and bridges store signals to the scene via `preact/hooks` effects. The scene module is mocked in the test.

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-app.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

const sceneCalls = { created: 0, lastData: null, destroyed: 0 };
vi.mock('../src/galaxy/scene.js', () => ({
  createScene: () => {
    sceneCalls.created++;
    return {
      setData: (d) => { sceneCalls.lastData = d; },
      onHover: () => {}, onClick: () => {}, focus: () => {},
      setIdleSpin: () => {}, destroy: () => { sceneCalls.destroyed++; },
    };
  },
}));

import App from '../src/galaxy/components/App.jsx';
import * as store from '../src/galaxy/store.js';

function mount(connected) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(App, { connected }), root);
  return root;
}

beforeEach(() => {
  sceneCalls.created = 0; sceneCalls.lastData = null; sceneCalls.destroyed = 0;
  store.graph.value = { nodes: [], links: [] };
  store.loading.value = false;
  store.error.value = null;
});

describe('Galaxy App', () => {
  it('shows a not-connected message when connected=false', () => {
    const root = mount(false);
    expect(root.querySelector('.empty-state')).not.toBe(null);
    expect(root.textContent).toMatch(/not connected/i);
    expect(sceneCalls.created).toBe(0);
  });
  it('mounts the scene and pushes graph data when connected', async () => {
    store.graph.value = { nodes: [{ id: 'queue:1', type: 'queue', rawId: '1', name: 'Q', color: '#29d4c5', val: 5 }], links: [] };
    mount(true);
    await Promise.resolve(); // let mount effects run
    expect(sceneCalls.created).toBe(1);
    expect(sceneCalls.lastData.nodes.length).toBe(1);
  });
  it('shows a loading overlay while loading', () => {
    store.loading.value = true;
    const root = mount(true);
    expect(root.querySelector('.galaxy-loading')).not.toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-app.test.js`
Expected: FAIL — cannot resolve `App.jsx`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/components/App.jsx`:
```jsx
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { graph, loading, error, selectedNodeId, hoveredNodeId } from '../store.js';
import { createScene } from '../scene.js';
import Legend from './Legend.jsx';
import DetailCard from './DetailCard.jsx';

export default function App({ connected }) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);

  // Mount the imperative scene once, on connect; tear it down on unmount/disconnect.
  useEffect(() => {
    if (!connected || !hostRef.current) return undefined;
    const scene = createScene(hostRef.current);
    sceneRef.current = scene;
    scene.onHover((id) => { hoveredNodeId.value = id; });
    scene.onClick((id) => { selectedNodeId.value = id; });
    scene.setData(graph.value);
    return () => { scene.destroy(); sceneRef.current = null; };
  }, [connected]);

  // Push graph updates into the live scene.
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.setData(graph.value);
  }, [graph.value]);

  if (!connected) {
    return (
      <div class="app-root">
        <div class="empty-state">Not connected — open a Rossum page and click Galaxy in the extension popup.</div>
      </div>
    );
  }

  return (
    <div class="app-root">
      <div class="galaxy-stage">
        <div class="galaxy-canvas" ref={hostRef}></div>
        <Legend />
        <DetailCard />
        {loading.value && <div class="galaxy-loading">Mapping the organization{'…'}</div>}
        {error.value && <div class="galaxy-error">{error.value}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-app.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-app.test.js` — PASS.

---

## Task 9: `galaxy/index.jsx` — `initGalaxy()`

**Files:**
- Create: `src/galaxy/index.jsx`
- Test: `tests/galaxy-init.test.js` (mocks `api.js`)

`initGalaxy` probes the connection (`whoami`), then fetches + builds the graph into the store. Run-once (the shell memoizes it). No persisted prefs in v1 (no search/filters/camera state — consistent with the spec's out-of-scope list).

- [ ] **Step 1: Write the failing test**

Create `tests/galaxy-init.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiMock = { whoami: vi.fn(), fetchOrgResources: vi.fn(), init: vi.fn() };
vi.mock('../src/galaxy/api.js', () => apiMock);

import { initGalaxy } from '../src/galaxy/index.jsx';
import * as store from '../src/galaxy/store.js';

beforeEach(() => {
  apiMock.whoami.mockReset();
  apiMock.fetchOrgResources.mockReset();
  store.connected.value = null;
  store.graph.value = { nodes: [], links: [] };
  store.error.value = null;
  store.loading.value = false;
});

describe('initGalaxy', () => {
  it('sets connected=false and skips fetching when whoami fails', async () => {
    apiMock.whoami.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
    await initGalaxy();
    expect(store.connected.value).toBe(false);
    expect(store.error.value).toMatch(/session expired/i);
    expect(apiMock.fetchOrgResources).not.toHaveBeenCalled();
  });
  it('connects, fetches, and builds the graph into the store', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockResolvedValue({
      organization: { id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme' },
      workspaces: [{ id: 10, url: 'https://x/api/v1/workspaces/10', name: 'WS', organization: 'https://x/api/v1/organizations/1' }],
      queues: [], hooks: [], connectors: [],
    });
    await initGalaxy();
    expect(store.connected.value).toBe(true);
    expect(store.loading.value).toBe(false);
    const ids = store.graph.value.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['organization:1', 'workspace:10']);
  });
  it('surfaces a fetch error without crashing', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValue(new Error('boom'));
    await initGalaxy();
    expect(store.connected.value).toBe(true);
    expect(store.error.value).toMatch(/boom|failed/i);
    expect(store.loading.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/galaxy-init.test.js`
Expected: FAIL — cannot resolve `index.jsx`.

- [ ] **Step 3: Write the implementation**

Create `src/galaxy/index.jsx`:
```jsx
import * as api from './api.js';
import * as store from './store.js';
import { buildGraph } from './graph.js';

export async function initGalaxy() {
  let connected = false;
  try {
    await api.whoami();
    connected = true;
  } catch (err) {
    store.error.value = err.message || 'Failed to verify session';
    connected = false;
  }
  store.connected.value = connected;
  if (!connected) return;

  store.loading.value = true;
  try {
    const raw = await api.fetchOrgResources({});
    store.graph.value = buildGraph(raw);
  } catch (err) {
    store.error.value = err.message || 'Failed to load the organization';
  } finally {
    store.loading.value = false;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/galaxy-init.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/galaxy-init.test.js` — PASS.

---

## Task 10: Wire Galaxy into the Console shell

**Files:**
- Modify: `src/console/components/Rail.jsx`
- Modify: `src/console/components/Console.jsx`
- Modify: `src/console/boot.js:5-7`
- Modify: `src/console/index.jsx`
- Modify: `tests/console-rail.test.js`, `tests/console-boot.test.js`

- [ ] **Step 1: Update the failing tests first**

In `tests/console-boot.test.js`, extend the `isValidApp` test (replace the `describe('isValidApp', …)` block):
```js
describe('isValidApp', () => {
  it('accepts known apps only', () => {
    expect(isValidApp('mdh')).toBe(true);
    expect(isValidApp('audit')).toBe(true);
    expect(isValidApp('galaxy')).toBe(true);
    expect(isValidApp('nope')).toBe(false);
    expect(isValidApp(undefined)).toBe(false);
  });
});
```

In `tests/console-rail.test.js`, update the count test (replace the `it('renders one button per app', …)` block):
```js
  it('renders one button per app', () => {
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(3);
  });

  it('renders the Galaxy app button', () => {
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')]
      .find((b) => b.getAttribute('title') === 'Org Galaxy');
    expect(btn).toBeTruthy();
    btn.click();
    expect(activeApp.value).toBe('galaxy');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/console-boot.test.js tests/console-rail.test.js`
Expected: FAIL — `isValidApp('galaxy')` is false; only 2 rail buttons; no "Org Galaxy".

- [ ] **Step 3: Implement the wiring**

`src/console/boot.js` — replace lines 5-7:
```js
export function isValidApp(v) {
  return v === 'mdh' || v === 'audit' || v === 'galaxy';
}
```

`src/console/components/Rail.jsx` — add a galaxy icon constant after `AUDIT_ICON` (before `const APPS`):
```jsx
const GALAXY_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="2.2" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(120 12 12)" />
  </svg>
);
```
…and add the `APPS` entry (replace the `APPS` array):
```jsx
const APPS = [
  { id: 'mdh', label: 'Data', title: 'Dataset Management', icon: DATA_ICON },
  { id: 'audit', label: 'Audit', title: 'Audit Log Viewer', icon: AUDIT_ICON },
  { id: 'galaxy', label: 'Galaxy', title: 'Org Galaxy', icon: GALAXY_ICON },
];
```

`src/console/components/Console.jsx` — add imports and extend the render switch. Replace the import block and the `if (app === 'mdh')` switch:
```jsx
import { h, Fragment } from 'preact';
import { activeApp } from '../store.js';
import Rail from './Rail.jsx';
import MdhApp from '../../mdh/components/App.jsx';
import AuditApp from '../../audit/components/App.jsx';
import GalaxyApp from '../../galaxy/components/App.jsx';
import * as mdhStore from '../../mdh/store.js';
import * as auditStore from '../../audit/store.js';
import * as galaxyStore from '../../galaxy/store.js';
```
```jsx
  let view;
  if (app === 'mdh') {
    const c = mdhStore.connected.value;
    view = c === null ? <Connecting /> : <MdhApp connected={c} />;
  } else if (app === 'galaxy') {
    const c = galaxyStore.connected.value;
    view = c === null ? <Connecting /> : <GalaxyApp connected={c} />;
  } else {
    const c = auditStore.connected.value;
    view = c === null ? <Connecting /> : <AuditApp connected={c} />;
  }
```

`src/console/index.jsx` — five edits:

(a) add imports after the audit imports (after line 15):
```jsx
import * as galaxyApi from '../galaxy/api.js';
import * as galaxyStore from '../galaxy/store.js';
import { initGalaxy } from '../galaxy/index.jsx';
```
(b) add to `TITLES` (inside the object at lines 18-21):
```jsx
  galaxy: 'Org Galaxy — Rossum SA',
```
(c) add a memo flag next to `auditInited` (line 40):
```jsx
let galaxyInited = false;
```
(d) add a branch inside `ensureInited` (before `return Promise.resolve();`):
```jsx
  if (app === 'galaxy' && !galaxyInited) {
    galaxyInited = true;
    return initGalaxy();
  }
```
(e) in the no-credentials branch add (next to the mdh/audit `connected.value = false` lines, ~line 91-92):
```jsx
    galaxyStore.connected.value = false;
```
…and in the connected branch add (after the audit `auditApi.init(...)` line ~103):
```jsx
  galaxyStore.domain.value = domain;
  galaxyStore.token.value = token;
  galaxyApi.init(domain, token);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/console-boot.test.js tests/console-rail.test.js tests/console-store.test.js`
Expected: PASS (3 rail buttons, Galaxy switches activeApp, `isValidApp('galaxy')` true).

- [ ] **Step 5: Checkpoint — full suite + build**

Run:
```bash
npm test && npm run build
```
Expected: full suite green; `dist/console/console.js` builds. Re-run the CSP grep:
```bash
grep -c -E "eval\(|new Function\(|WebAssembly" dist/console/console.js || echo "CLEAN"
```
Expected: `CLEAN` / `0`.

---

## Task 11: `console.css` — Galaxy styles + verify deep-link routes

**Files:**
- Modify: `console.css` (repo root — copied verbatim into `dist/console/` by `build.js`)
- Modify: `src/audit/deeplink.js` (only after live route verification — see Step 3)

- [ ] **Step 1: Add the Galaxy styles**

Append to `console.css` (uses existing CSS custom properties; supports dark mode through the existing `:root` overrides):
```css
/* ---- Galaxy app ---- */
.galaxy-stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
.galaxy-canvas { position: absolute; inset: 0; }
.galaxy-canvas canvas { display: block; }

.galaxy-legend {
  position: absolute; left: 16px; bottom: 16px; display: flex; flex-wrap: wrap; gap: 10px;
  padding: 10px 12px; border-radius: 10px; font-size: 12px; color: var(--text-secondary, #9aa6c4);
  background: var(--surface-overlay, rgba(16,22,38,0.72)); border: 1px solid var(--border, rgba(120,140,200,0.18));
  backdrop-filter: blur(6px);
}
.galaxy-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.galaxy-legend-dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 8px currentColor; }

.galaxy-detail-card {
  position: absolute; right: 16px; top: 16px; width: 260px; padding: 16px;
  border-radius: 12px; background: var(--surface-overlay, rgba(16,22,38,0.82));
  border: 1px solid var(--border, rgba(120,140,200,0.2)); backdrop-filter: blur(8px);
  box-shadow: 0 12px 40px rgba(0,0,0,0.35);
}
.galaxy-detail-close { position: absolute; right: 8px; top: 6px; background: none; border: none;
  color: var(--text-secondary, #9aa6c4); font-size: 18px; cursor: pointer; line-height: 1; }
.galaxy-detail-type { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; font-weight: 700; }
.galaxy-detail-name { font-size: 16px; font-weight: 600; margin: 4px 0 10px; color: var(--text-primary, #e8edff); }
.galaxy-detail-facts { margin: 0 0 12px; font-size: 13px; }
.galaxy-detail-facts > div { display: flex; justify-content: space-between; padding: 3px 0; }
.galaxy-detail-facts dt { color: var(--text-secondary, #9aa6c4); margin: 0; }
.galaxy-detail-facts dd { margin: 0; color: var(--text-primary, #e8edff); }
.galaxy-detail-link {
  display: inline-block; padding: 7px 12px; border-radius: 8px; font-size: 13px; text-decoration: none;
  color: var(--accent-fg, #08122e); background: var(--accent, #7aa2ff);
}

.galaxy-loading, .galaxy-error {
  position: absolute; left: 50%; top: 16px; transform: translateX(-50%); padding: 8px 14px;
  border-radius: 8px; font-size: 13px; background: var(--surface-overlay, rgba(16,22,38,0.82));
  border: 1px solid var(--border, rgba(120,140,200,0.2)); color: var(--text-primary, #e8edff);
}
.galaxy-error { color: var(--danger-fg, #ffb4b4); border-color: var(--danger-border, rgba(255,120,120,0.4)); }
```

- [ ] **Step 2: Build and hand-verify the scene in the browser**

Run:
```bash
npm run build
```
Then load the unpacked `dist/` extension in Chrome, open a Rossum page, open the extension popup, and open the Console (Dataset Management or Audit). Click the **Galaxy** rail item. Verify:
- nodes render and glow (bloom), the layout settles, then the camera idle-rotates;
- hover dims/highlights neighbors and shows a label; org/workspace names are always visible;
- clicking a node eases the camera and opens the detail card;
- clicking a **queue** or **hook** node's "Open in Rossum" lands on the right page.

> This is the hand-verification the unit tests cannot do (no WebGL in jsdom). If a `graph.js` edge looks wrong, that is the Task 12 / §12 field-name verification — fix `graph.js` and re-run `tests/galaxy-graph.test.js`.

- [ ] **Step 3: Verify and add the remaining deep-link routes (correctness over guessing)**

Using the live Rossum UI (the maintainer's session) OR the MCP read tools, confirm the actual UI path for `workspace`, `connector`, `engine`, and `organization`. Only for the ones you can confirm, extend `ROUTES` in `src/audit/deeplink.js`, e.g.:
```js
export const ROUTES = {
  annotation: (id) => `/document/${id}`,
  queue: (id) => `/queues/${id}`,
  hook: (id) => `/settings/extensions/${id}`,
  // Add ONLY routes verified against the live UI; leave the rest out so the
  // detail card hides the button rather than producing a dead link.
};
```
If a route cannot be confirmed, leave it out — the DetailCard already hides the button for types `buildDeeplink` doesn't know.

- [ ] **Step 4: Checkpoint**

Run: `npm test && npm run build` — full suite green, build OK.

---

## Task 12: Documentation (CLAUDE.md)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Architecture + Storage + Dependencies sections**

In the Console bullet list, note the third app. Under **Architecture**, add a `Galaxy` subsection:
```markdown
### Galaxy (3D org birdview)

A Preact app (`src/galaxy/`) that fetches the live Rossum org over REST and
renders it as a 3D force-directed network via `3d-force-graph` (on three.js,
default d3 engine — never ngraph, which uses `new Function` and is CSP-blocked).
`graph.js` is a pure transform (REST bundle → {nodes, links}, inverting
`hook.queues[]` and `run_after[]`); `scene.js` is a thin imperative wrapper
(bloom + idle auto-rotate); `App.jsx` bridges signals ↔ scene. Reachable from
the Console app rail; auth uses the shared `consoleAuth_<uuid>` flow.
```
In **Chrome Storage Keys**, no new keys are added (v1 persists no Galaxy state).
In **Dependencies**, add: `**3d-force-graph** (+ three) — 3D force-directed graph for the Galaxy app (~360KB gzip in console.js)`.

- [ ] **Step 2: Checkpoint**

Run: `npm test` — still green (docs-only change).

---

## Task 13 (Optional): Popup launch button

**Files:**
- Modify: `src/popup/components/App.jsx`

The Console launch plumbing already accepts any app id (`openConsoleTab(tab, auth, '<id>')`, verified in `src/popup/utils.js`). Galaxy is reachable by clicking its rail item after opening the Console, so this is optional.

- [ ] **Step 1: Mirror the existing Audit button**

Open `src/popup/components/App.jsx`, find the "Audit Logs" button (its handler calls `openConsoleTab(tab, auth, 'audit')`) and add a sibling "Galaxy" button calling `openConsoleTab(tab, auth, 'galaxy')`. Keep the same markup/handler shape as the Audit button. If a popup test exists for the Rossum section, extend it to assert the new button appears and triggers `openConsoleTab` with `'galaxy'`.

- [ ] **Step 2: Checkpoint**

Run: `npm test && npm run build` — green; build OK.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 purpose → whole plan; §2 scope/nodes/edges → Task 4 `graph.js`; §3 grounded context → Tasks 3 (api), 10 (wiring), 1 (deps/CSP); §4 graph model → Task 4; §5 modules → Tasks 2–9; §6 scene → Task 5 + Task 11 hand-verify; §7 interactions → Tasks 5 (hover/click/idle), 7 (detail/deep-link), 11 (verify); §8 error handling → Tasks 3 (403→partial, 401 propagate), 9 (probe/error state), 8 (overlays); §9 testing → every task is TDD + Task 5 mock note; §10 deps/build → Task 1; §11 out-of-scope → respected (no search/filters/metrics/persistence); §12 verify items → Task 11 Steps 2-3 (field names + routes) and Task 5 (engine derivation already implemented in graph.js). No uncovered requirement.

**Refinement vs spec:** spec §5 mentioned "restore prefs / persistence effects" generically; v1 has no persistable Galaxy state (search/filters/camera all out of scope), so `initGalaxy` intentionally registers none. Noted in Task 9 and Task 12.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; the only deliberately-open item is Task 11 Step 3 deep-link routes, which is a verification gate (correctness over guessing), not a code placeholder.

**Type consistency:** node shape `{id,type,rawId,name,color,val}`, link shape `{source,target,kind}`, `buildGraph`/`idFromUrl`/`NODE_STYLE`/`LINK_STYLE` (graph.js), `listAll`/`fetchOrgResources`/`whoami` (api.js), and the scene interface `{setData,onHover,onClick,focus,setIdleSpin,destroy}` are used consistently across Tasks 4, 5, 7, 8, 9.
