# Audit & Activity Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the console's Audit app as a unified Audit & Activity console — a generic descriptor-driven shell over four Rossum log sources (Audit Logs, Hook Logs, Workflow Activity, Rules Execution) with cached name-resolution and deep-linking.

**Architecture:** One generic shell (TabBar → FiltersBar → ResultsTable → DetailPanel → Pagination) is driven by a per-source **descriptor** (`{ path, paginationMode, supportsServerSearch, filters, columns, detail, buildParams, refs }`). The shell handles pagination (cursor + offset), server/client search, per-source availability, and a cached id→name resolver + deep-links. Each source is an isolated module; the shell is proven end-to-end with Audit Logs, then the other three are additive descriptors.

**Tech Stack:** Preact + @preact/signals, esbuild, vitest (jsdom). Reuses the existing console shell's `initAudit()` contract, `api.js` GET (401/403 handling), `JsonTree.jsx`, `ConnectionBar.jsx`, `ErrorBanner.jsx`, `UnavailablePanel.jsx`, `quickSearch.js`, and the MDH 60s-LRU cache pattern.

> **PROJECT CONVENTION — NO COMMITS:** Per the maintainer's standing instruction, do **not** `git commit` and do not branch. Use `git rm` (stages only). Each task ends with a **Checkpoint** (run tests) instead of a commit. Tests are `.test.js` rendering components via `h(Component, null)` (never raw JSX in tests) and waiting via condition-based `waitFor` — never fixed `setTimeout`.

---

## Verified API facts (ground truth — from live probe 2026-06-04)

- Base at runtime: `${uiOrigin}/api/v1/…`, Bearer session token (existing flow). Paths below include the `/api/v1` prefix.
- **audit_logs**: `GET /api/v1/audit_logs/` — cursor pagination; needs `include_total=true` for `pagination.total`; `pagination.next` carries `cursor=…`. Filters: `object_type` (required; document/annotation/user), `action`, `object_id`, `timestamp_after`, `timestamp_before`, `username`. No server `search`.
- **hooks/logs**: `GET /api/v1/hooks/logs/` — offset (`page`); `pagination.total` by default. Filters incl. `hook`, `queue`, `annotation`, `status`, `status_code`, `log_level`, `timestamp_after/before`, `request_id`; server `search`.
- **workflow_activities**: `GET /api/v1/workflow_activities/` — cursor; needs `include_total=true`. Filters: `annotation`, `workflow_run`, `assignees`, `action`, `created_at_after/before`, `ordering`. No server `search`.
- **rules_execution_logs**: `GET /api/v1/rules_execution_logs/` — offset; `pagination.total` by default. Filters: `rule`, `annotation`, `queue`, `execution_result`, `trigger_event`, `request_id`, `created_at_after/before`; server `search`.
- config_history is excluded (403 for org-group-admin).

## File structure

```
src/audit/
  index.jsx              MODIFY  initAudit() — restore per-source state, persist, query effect
  store.js               REWRITE activeSource + filtersBySource + active-view signals
  api.js                 MODIFY  export get/buildQuery; add extractParam, normalizePage
  query.js               REWRITE fetchActive() — descriptor-driven fetch + normalize
  resolve.js             CREATE  cached id->name resolver (signal-backed)
  deeplink.js            CREATE  build Rossum UI URLs from origin (route map + verify task)
  sources/
    index.js             CREATE  SOURCES registry + SOURCE_ORDER
    auditLogs.js         CREATE  descriptor
    hookLogs.js          CREATE  descriptor
    rulesExecution.js    CREATE  descriptor
    workflowActivities.js CREATE descriptor
  components/
    App.jsx              REWRITE shell layout
    TabBar.jsx           CREATE  source tabs
    FiltersBar.jsx       CREATE  generic filter controls from descriptor
    ResultsTable.jsx     REWRITE generic columns from descriptor
    DetailPanel.jsx      CREATE  right-side detail
    Pagination.jsx       REWRITE generic (cursor + offset)
    ConnectionBar.jsx    keep    (minor: source-aware label optional)
    ErrorBanner.jsx      keep
    JsonTree.jsx         keep
    UnavailablePanel.jsx MODIFY  source-aware title
    Filters.jsx          DELETE  (git rm — replaced by FiltersBar)
    RecordDetail.jsx     DELETE  (git rm — replaced by DetailPanel)
  audit.css?             n/a     (styles live in src/console/console.css; this plan adds rules there)
```

CSS additions go into `src/console/console.css` (the unified stylesheet).

---

## Task 1: Store — per-source state

**Files:** Rewrite `src/audit/store.js`

- [ ] **Step 1: Replace the entire file with:**

```js
import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initAudit runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = not yet probed; true/false after whoami

// Which source tab is active.
export const activeSource = signal('audit'); // 'audit' | 'hooks' | 'workflow' | 'rules'

// Per-source filter + paging state. `page` is used by offset sources, `cursor`
// by cursor sources; both reset on any filter/search/pageSize change.
export const filtersBySource = signal({
  audit: { object_type: 'annotation', action: '', object_id: '', username: '',
           timestamp_after: '', timestamp_before: '', page: 1, cursor: null, pageSize: 50, search: '' },
  hooks: { hook: '', queue: '', annotation: '', status: '', status_code: '', log_level: '',
           timestamp_after: '', timestamp_before: '', request_id: '', page: 1, cursor: null, pageSize: 50, search: '' },
  workflow: { annotation: '', workflow_run: '', assignees: '', action: '', ordering: '-id',
              created_at_after: '', created_at_before: '', page: 1, cursor: null, pageSize: 50, search: '' },
  rules: { rule: '', annotation: '', queue: '', execution_result: '', trigger_event: '', request_id: '',
           created_at_after: '', created_at_before: '', page: 1, cursor: null, pageSize: 50, search: '' },
});

// Active-view results for the currently displayed source.
export const rows = signal([]);
export const pageInfo = signal({ total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null });
export const loading = signal(false);
export const error = signal(null);
export const selectedRow = signal(null); // row._idx of the open detail, or null

// Client-side quick filter over the loaded page (reset on source switch).
export const quickSearch = signal('');

// Per-active-source availability (a source may 403 independently).
export const availability = signal('unknown'); // 'unknown' | 'available' | 'unavailable'
export const availabilityMessage = signal(null);
export const availabilityStatus = signal(null);

// Merge a patch into one source's filter state (immutably, to trigger signals).
export function patchFilters(key, patch) {
  const cur = filtersBySource.value[key];
  filtersBySource.value = { ...filtersBySource.value, [key]: { ...cur, ...patch } };
}
```

- [ ] **Step 2: Checkpoint** — `npx vitest run` still green (no consumers yet broken; query.js/components updated in later tasks). Do not commit.

---

## Task 2: api.js — export helpers + pagination utilities

**Files:** Modify `src/audit/api.js`; Test `tests/audit-api.test.js` (extend)

- [ ] **Step 1: Write the failing test** (append to `tests/audit-api.test.js`)

```js
import { extractParam, normalizePage } from '../src/audit/api.js';

describe('extractParam', () => {
  it('reads a query param from an absolute URL', () => {
    expect(extractParam('https://x/api/v1/audit_logs?cursor=abc123&page_size=3', 'cursor')).toBe('abc123');
  });
  it('returns null for missing param or bad url', () => {
    expect(extractParam('https://x/api/v1/audit_logs?page_size=3', 'cursor')).toBeNull();
    expect(extractParam(null, 'cursor')).toBeNull();
    expect(extractParam('not a url', 'cursor')).toBeNull();
  });
});

describe('normalizePage', () => {
  it('offset: derives hasPrev from current page, hasNext from next link', () => {
    const p = normalizePage({ total: 43, total_pages: 15, next: 'https://x?page=2', previous: null }, 'offset', 1);
    expect(p).toMatchObject({ total: 43, totalPages: 15, hasNext: true, hasPrev: false, nextCursor: null, prevCursor: null });
    expect(normalizePage({ total: 43, total_pages: 15, next: null, previous: 'https://x?page=1' }, 'offset', 2).hasPrev).toBe(true);
  });
  it('cursor: extracts next/prev cursors and total', () => {
    const p = normalizePage({ total: 238, total_pages: 80, next: 'https://x?cursor=NEXT&include_total=true', previous: null }, 'cursor', 1);
    expect(p).toMatchObject({ total: 238, totalPages: 80, hasNext: true, hasPrev: false, nextCursor: 'NEXT', prevCursor: null });
    const p2 = normalizePage({ next: null, previous: 'https://x?cursor=PREV' }, 'cursor', 1);
    expect(p2).toMatchObject({ hasNext: false, hasPrev: true, nextCursor: null, prevCursor: 'PREV' });
  });
  it('handles a null pagination object', () => {
    expect(normalizePage(null, 'offset', 1)).toMatchObject({ total: null, hasNext: false, hasPrev: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/audit-api.test.js`
Expected: FAIL — `extractParam`/`normalizePage` not exported.

- [ ] **Step 3: Edit `src/audit/api.js`**

(a) Export the existing private `get` and `buildQuery` — change `async function get(` to `export async function get(` and `function buildQuery(` to `export function buildQuery(`.

(b) Remove `listAuditLogs` (descriptors build paths now). Keep `init` and `whoami`.

(c) Append:

```js
// Read a single query-param value from an absolute URL (the API returns full
// next/previous URLs). Null on missing param or unparseable URL.
export function extractParam(url, name) {
  if (!url) return null;
  try { return new URL(url).searchParams.get(name); } catch { return null; }
}

// Normalize the API `pagination` object into the shell's pageInfo shape.
// mode 'cursor' uses cursor tokens from next/previous; mode 'offset' uses page math.
export function normalizePage(pagination, mode, currentPage) {
  const empty = { total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null };
  if (!pagination) return empty;
  const total = typeof pagination.total === 'number' ? pagination.total : null;
  const totalPages = typeof pagination.total_pages === 'number' ? pagination.total_pages : null;
  if (mode === 'cursor') {
    return {
      total, totalPages,
      hasNext: !!pagination.next,
      hasPrev: !!pagination.previous,
      nextCursor: extractParam(pagination.next, 'cursor'),
      prevCursor: pagination.previous ? extractParam(pagination.previous, 'cursor') : null,
    };
  }
  return {
    total, totalPages,
    hasNext: !!pagination.next,
    hasPrev: (currentPage || 1) > 1,
    nextCursor: null, prevCursor: null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/audit-api.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 3: resolve.js + deeplink.js

**Files:** Create `src/audit/resolve.js`, `src/audit/deeplink.js`; Test `tests/audit-resolve.test.js`

- [ ] **Step 1: Write the failing test** (`tests/audit-resolve.test.js`)

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/audit/api.js');
import * as api from '../src/audit/api.js';
import { resolveName, _resetResolveCache } from '../src/audit/resolve.js';
import { buildDeeplink, ROUTES } from '../src/audit/deeplink.js';

beforeEach(() => { vi.clearAllMocks(); _resetResolveCache(); });

describe('resolveName', () => {
  it('returns null on first call (cache miss) and fetches once; dedupes concurrent calls', async () => {
    let resolveFetch;
    api.get.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    expect(resolveName('hook', 123)).toBeNull();      // miss -> kicks off fetch
    resolveName('hook', 123);                          // concurrent -> no second fetch
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/v1/hooks/123/', expect.anything());
    resolveFetch({ name: 'Supplier matcher' });
    await Promise.resolve(); await Promise.resolve();
    expect(resolveName('hook', 123)).toBe('Supplier matcher'); // cached hit
  });

  it('falls back to null name on fetch error (caller shows the raw id)', async () => {
    api.get.mockRejectedValue(new Error('403'));
    expect(resolveName('queue', 9)).toBeNull();
    await Promise.resolve(); await Promise.resolve();
    expect(resolveName('queue', 9)).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1); // negative result cached, no refetch
  });
});

describe('buildDeeplink', () => {
  it('builds a URL from origin + route map; null for unknown type', () => {
    expect(buildDeeplink('https://acme.rossum.app', 'annotation', 42)).toBe(`https://acme.rossum.app${ROUTES.annotation(42)}`);
    expect(buildDeeplink('https://acme.rossum.app', 'mystery', 42)).toBeNull();
    expect(buildDeeplink('', 'annotation', 42)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/audit-resolve.test.js`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/audit/resolve.js`**

```js
import { signal } from '@preact/signals';
import * as api from './api.js';

const TTL_MS = 60_000;
// key `${type}:${id}` -> { name: string|null, ts: number }
const cache = signal({});
const inflight = new Set();

const PATHS = {
  hook: (id) => `/api/v1/hooks/${id}/`,
  queue: (id) => `/api/v1/queues/${id}/`,
  user: (id) => `/api/v1/users/${id}/`,
  rule: (id) => `/api/v1/rules/${id}/`,
};

// Pick a human label from a resolved resource (name first, else username/email).
function labelOf(obj) {
  return obj?.name || obj?.username || obj?.email || null;
}

// Returns the cached name (reactive read — subscribes the caller), or null if
// unknown. On a miss, kicks off a single deduped fetch; the cache update
// re-renders subscribers. Negative results (errors) are cached so we don't refetch.
export function resolveName(type, id) {
  if (id == null) return null;
  const path = PATHS[type];
  if (!path) return null;
  const key = `${type}:${id}`;
  const entry = cache.value[key];
  if (entry && Date.now() - entry.ts <= TTL_MS) return entry.name;
  if (!inflight.has(key)) {
    inflight.add(key);
    api.get(path(id))
      .then((obj) => setName(key, labelOf(obj)))
      .catch(() => setName(key, null))
      .finally(() => inflight.delete(key));
  }
  return entry ? entry.name : null;
}

function setName(key, name) {
  cache.value = { ...cache.value, [key]: { name, ts: Date.now() } };
}

// Test hook.
export function _resetResolveCache() {
  cache.value = {};
  inflight.clear();
}
```

- [ ] **Step 4: Create `src/audit/deeplink.js`**

```js
// Build links into the Rossum UI from the origin the console already holds.
//
// ROUTES maps a reference type to a UI path. These are the conventional Rossum
// UI routes and are VERIFIED against the live UI in Task 11 before shipping —
// keeping them in one place means only this file changes if a route differs.
export const ROUTES = {
  annotation: (id) => `/document/${id}`,
  queue: (id) => `/queues/${id}`,
  hook: (id) => `/settings/extensions/${id}`,
};

// Returns an absolute URL or null (unknown type / no origin / no id).
export function buildDeeplink(origin, type, id) {
  if (!origin || id == null) return null;
  const route = ROUTES[type];
  if (!route) return null;
  return `${origin}${route(id)}`;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/audit-resolve.test.js`
Expected: PASS.

- [ ] **Step 6: Checkpoint** — green. Do not commit. (The ROUTES values carry a verify-at-Task-11 note; they are concrete, not placeholders.)

---

## Task 4: Source registry + Audit Logs descriptor

**Files:** Create `src/audit/sources/index.js`, `src/audit/sources/auditLogs.js`; Test `tests/audit-sources.test.js`

- [ ] **Step 1: Write the failing test** (`tests/audit-sources.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { SOURCES, SOURCE_ORDER } from '../src/audit/sources/index.js';

describe('audit sources registry', () => {
  it('exposes the four sources in tab order', () => {
    expect(SOURCE_ORDER).toEqual(['audit', 'hooks', 'workflow', 'rules']);
    for (const k of SOURCE_ORDER) {
      expect(SOURCES[k].key).toBe(k);
      expect(typeof SOURCES[k].path).toBe('string');
      expect(['cursor', 'offset']).toContain(SOURCES[k].paginationMode);
      expect(typeof SOURCES[k].buildParams).toBe('function');
      expect(Array.isArray(SOURCES[k].columns)).toBe(true);
    }
  });

  it('audit descriptor: cursor mode, no server search, builds object_type/action params', () => {
    const d = SOURCES.audit;
    expect(d.paginationMode).toBe('cursor');
    expect(d.supportsServerSearch).toBe(false);
    const params = d.buildParams({ object_type: 'user', action: 'app_load', object_id: '', username: 'a@b.c', timestamp_after: '', timestamp_before: '' });
    expect(params).toMatchObject({ object_type: 'user', action: 'app_load', username: 'a@b.c' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/audit-sources.test.js`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/audit/sources/auditLogs.js`**

```js
import { h } from 'preact';
import JsonTree from '../components/JsonTree.jsx';

const ACTIONS_BY_TYPE = {
  document: ['create'],
  annotation: ['update-status'],
  user: ['create', 'delete', 'purge', 'update', 'destroy', 'app_load', 'reset-password', 'change-password'],
};

function statusClass(s) {
  if (typeof s !== 'number') return '';
  if (s >= 500) return 'status-5xx';
  if (s >= 400) return 'status-4xx';
  if (s >= 300) return 'status-3xx';
  if (s >= 200) return 'status-2xx';
  return '';
}

export const auditLogs = {
  key: 'audit',
  label: 'Audit Logs',
  path: '/api/v1/audit_logs/',
  paginationMode: 'cursor',
  supportsServerSearch: false,
  filters: [
    { name: 'object_type', kind: 'select', label: 'Object type *', required: true,
      options: () => ['annotation', 'document', 'user'] },
    { name: 'action', kind: 'select', label: 'Action',
      options: (st) => ACTIONS_BY_TYPE[st.object_type] || [] },
    { name: 'object_id', kind: 'number', label: 'Object ID' },
    { name: 'username', kind: 'text', label: 'Username' },
    { name: 'timestamp_after', kind: 'datetime', label: 'After' },
    { name: 'timestamp_before', kind: 'datetime', label: 'Before' },
  ],
  buildParams: (st) => ({
    object_type: st.object_type,
    action: st.action,
    object_id: st.object_id,
    username: st.username,
    timestamp_after: st.timestamp_after,
    timestamp_before: st.timestamp_before,
  }),
  columns: [
    { key: 'timestamp', label: 'Timestamp', cls: 'col-time mono', render: (r) => fmtTime(r.timestamp) },
    { key: 'username', label: 'User', cls: 'col-user', render: (r) => r.username || dash() },
    { key: 'object_type', label: 'Type', cls: 'col-type',
      render: (r) => <span class={'type-pill type-' + (r.object_type || 'unknown')}>{r.object_type || '—'}</span> },
    { key: 'action', label: 'Action', cls: 'col-action mono', render: (r) => r.action || dash() },
    { key: 'object', label: 'Object', cls: 'col-id mono',
      render: (r, ctx) => objectLink(r, ctx) },
    { key: 'status', label: 'Status', cls: 'col-status mono',
      render: (r) => { const s = r.content?.status_code; return <span class={statusClass(s)}>{s ?? '—'}</span>; } },
  ],
  detail: (r) => {
    const c = r.content || {};
    return [
      { title: 'Request', body: (
        <div class="mono" style="font-size:11px">
          <div>{c.method} {c.path}</div>
          <div>status {c.status_code}</div>
          <div>request_id {c.request_id} <CopyBtn text={c.request_id} /></div>
        </div>) },
      { title: 'Details', body: c.details ? <JsonTree data={c.details} /> : <span class="muted">—</span> },
    ];
  },
  refs: (r) => (r.object_id != null && r.object_type ? [{ type: r.object_type, id: r.object_id }] : []),
};

// Shared cell helpers (re-used by other descriptors).
export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function dash() { return <span class="muted">—</span>; }
export function CopyBtn({ text }) {
  if (!text) return null;
  return <button class="btn btn-sm" onClick={() => navigator.clipboard.writeText(String(text))}>Copy</button>;
}
// annotation/document/user object link in audit rows.
function objectLink(r, ctx) {
  if (r.object_id == null) return dash();
  const url = ctx.deeplink(r.object_type, r.object_id);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{r.object_id}</a> : String(r.object_id);
}
```

- [ ] **Step 4: Create `src/audit/sources/index.js`**

```js
import { auditLogs } from './auditLogs.js';
// hookLogs/workflowActivities/rulesExecution added in Tasks 8–10.
import { hookLogs } from './hookLogs.js';
import { workflowActivities } from './workflowActivities.js';
import { rulesExecution } from './rulesExecution.js';

export const SOURCES = {
  audit: auditLogs,
  hooks: hookLogs,
  workflow: workflowActivities,
  rules: rulesExecution,
};
export const SOURCE_ORDER = ['audit', 'hooks', 'workflow', 'rules'];
```

> NOTE: `index.js` imports all four. To keep Task 4 self-contained and runnable before Tasks 8–10, FIRST create temporary one-line stub descriptors so imports resolve, then replace them with the real modules in Tasks 8–10. Create stubs now:
> `src/audit/sources/hookLogs.js`: `export const hookLogs = { key:'hooks', label:'Hook Logs', path:'/api/v1/hooks/logs/', paginationMode:'offset', supportsServerSearch:true, filters:[], buildParams:()=>({}), columns:[], detail:()=>[], refs:()=>[] };`
> `src/audit/sources/workflowActivities.js`: same shape with `key:'workflow', label:'Workflow Activity', path:'/api/v1/workflow_activities/', paginationMode:'cursor', supportsServerSearch:false`.
> `src/audit/sources/rulesExecution.js`: same shape with `key:'rules', label:'Rules Execution', path:'/api/v1/rules_execution_logs/', paginationMode:'offset', supportsServerSearch:true`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/audit-sources.test.js`
Expected: PASS.

- [ ] **Step 6: Checkpoint** — green. Do not commit.

---

## Task 5: query.js — descriptor-driven fetch

**Files:** Rewrite `src/audit/query.js`; Test `tests/audit-query.test.js` (rewrite for fetchActive)

- [ ] **Step 1: Rewrite the test** `tests/audit-query.test.js`

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/audit/api.js');
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';
import { fetchActive } from '../src/audit/query.js';

// real normalizePage/extractParam via the actual module would be mocked away by
// vi.mock; provide passthrough implementations the query code relies on.
api.normalizePage = (await vi.importActual('../src/audit/api.js')).normalizePage;
api.extractParam = (await vi.importActual('../src/audit/api.js')).extractParam;
api.buildQuery = (await vi.importActual('../src/audit/api.js')).buildQuery;

beforeEach(() => {
  vi.clearAllMocks();
  store.activeSource.value = 'audit';
  store.rows.value = [];
  store.error.value = null;
  store.availability.value = 'unknown';
  store.filtersBySource.value = {
    ...store.filtersBySource.value,
    audit: { object_type: 'user', action: '', object_id: '', username: '', timestamp_after: '', timestamp_before: '', page: 1, cursor: null, pageSize: 50, search: '' },
  };
});

describe('fetchActive', () => {
  it('cursor source: requests include_total + cursor, tags rows with _idx, sets pageInfo', async () => {
    api.get.mockResolvedValue({ results: [{ a: 1 }, { a: 2 }], pagination: { total: 238, total_pages: 80, next: 'https://x?cursor=N', previous: null } });
    store.patchFilters('audit', { cursor: 'C1' });
    await fetchActive();
    const url = api.get.mock.calls[0][0];
    expect(url).toContain('/api/v1/audit_logs/?');
    expect(url).toContain('object_type=user');
    expect(url).toContain('include_total=true');
    expect(url).toContain('cursor=C1');
    expect(store.rows.value).toEqual([{ a: 1, _idx: 0 }, { a: 2, _idx: 1 }]);
    expect(store.pageInfo.value).toMatchObject({ total: 238, nextCursor: 'N', hasNext: true });
    expect(store.availability.value).toBe('available');
  });

  it('maps a 403 to per-source unavailable, not an error banner', async () => {
    const err = Object.assign(new Error('forbidden'), { status: 403, featureUnavailable: true });
    api.get.mockRejectedValue(err);
    await fetchActive();
    expect(store.availability.value).toBe('unavailable');
    expect(store.availabilityStatus.value).toBe(403);
    expect(store.error.value).toBeNull();
    expect(store.rows.value).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/audit-query.test.js`
Expected: FAIL — `fetchActive` not defined.

- [ ] **Step 3: Replace `src/audit/query.js` with:**

```js
import * as api from './api.js';
import * as store from './store.js';
import { SOURCES } from './sources/index.js';

let queryId = 0;

export async function fetchActive({ signal } = {}) {
  const myId = ++queryId;
  const key = store.activeSource.value;
  const desc = SOURCES[key];
  const st = store.filtersBySource.value[key];

  store.loading.value = true;
  store.error.value = null;
  store.selectedRow.value = null;

  const params = { ...desc.buildParams(st), page_size: st.pageSize };
  if (desc.paginationMode === 'cursor') {
    params.include_total = 'true';
    if (st.cursor) params.cursor = st.cursor;
  } else if (st.page && st.page > 1) {
    params.page = st.page;
  }
  if (desc.supportsServerSearch && st.search) params.search = st.search;

  try {
    const res = await api.get(`${desc.path}?${api.buildQuery(params)}`, { signal });
    if (myId !== queryId) return;
    const items = (Array.isArray(res?.results) ? res.results : []).map((r, i) => ({ ...r, _idx: i }));
    store.rows.value = items;
    store.pageInfo.value = api.normalizePage(res?.pagination, desc.paginationMode, st.page || 1);
    store.availability.value = 'available';
    store.availabilityMessage.value = null;
    store.availabilityStatus.value = null;
  } catch (err) {
    if (err?.name === 'AbortError' || myId !== queryId) return;
    store.rows.value = [];
    store.pageInfo.value = { total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null };
    if (err?.featureUnavailable) {
      store.availability.value = 'unavailable';
      store.availabilityMessage.value = err?.message || null;
      store.availabilityStatus.value = err?.status ?? null;
      store.error.value = null;
    } else {
      store.error.value = err?.message || 'Failed to load';
    }
  } finally {
    if (myId === queryId) store.loading.value = false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/audit-query.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 6: Shell components (TabBar, FiltersBar, ResultsTable, DetailPanel, Pagination)

**Files:** Create `TabBar.jsx`, `FiltersBar.jsx`, `DetailPanel.jsx`; Rewrite `ResultsTable.jsx`, `Pagination.jsx`. Add CSS to `src/console/console.css`.

- [ ] **Step 1: Create `src/audit/components/TabBar.jsx`**

```jsx
import { h } from 'preact';
import { activeSource } from '../store.js';
import { SOURCES, SOURCE_ORDER } from '../sources/index.js';

export default function TabBar() {
  const active = activeSource.value;
  return (
    <div class="audit-tabbar">
      {SOURCE_ORDER.map((k) => (
        <button
          class={'audit-tab' + (active === k ? ' active' : '')}
          onClick={() => { if (active !== k) activeSource.value = k; }}
        >{SOURCES[k].label}</button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/audit/components/FiltersBar.jsx`**

```jsx
import { h } from 'preact';
import { activeSource, filtersBySource, patchFilters, quickSearch } from '../store.js';
import { SOURCES } from '../sources/index.js';

const PAGE_SIZES = [20, 50, 100];

export default function FiltersBar() {
  const key = activeSource.value;
  const desc = SOURCES[key];
  const st = filtersBySource.value[key];

  // Any structured filter change resets paging (page=1, cursor=null). Changing
  // object_type also clears action (its options depend on the type).
  const setFilter = (name, value) => {
    const patch = { [name]: value, page: 1, cursor: null };
    if (name === 'object_type') patch.action = '';
    patchFilters(key, patch);
  };

  return (
    <section class="filters">
      <div class="filters-row">
        {desc.filters.map((f) => (
          <label class="filter">
            <span class="filter-label">{f.label}</span>
            {f.kind === 'select' ? (
              <select class="input" value={st[f.name]} onChange={(e) => setFilter(f.name, e.target.value)}>
                {!f.required && <option value="">any</option>}
                {(f.options ? f.options(st) : []).map((o) => <option value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                class="input"
                type={f.kind === 'number' ? 'number' : f.kind === 'datetime' ? 'datetime-local' : 'text'}
                placeholder={f.placeholder || ''}
                value={st[f.name]}
                onInput={(e) => setFilter(f.name, e.target.value)}
              />
            )}
          </label>
        ))}

        {desc.supportsServerSearch && (
          <label class="filter filter-grow">
            <span class="filter-label">Search <span class="hint-tag">server-side</span></span>
            <input class="input" type="search" value={st.search}
                   onInput={(e) => patchFilters(key, { search: e.target.value, page: 1, cursor: null })} />
          </label>
        )}

        <label class="filter filter-grow">
          <span class="filter-label">Quick filter <span class="hint-tag">this page only</span></span>
          <input class="input" type="search" value={quickSearch.value}
                 onInput={(e) => (quickSearch.value = e.target.value)} />
        </label>

        <label class="filter filter-compact">
          <span class="filter-label">Page size</span>
          <select class="input" value={st.pageSize}
                  onChange={(e) => patchFilters(key, { pageSize: Number(e.target.value), page: 1, cursor: null })}>
            {PAGE_SIZES.map((n) => <option value={n}>{n}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Rewrite `src/audit/components/ResultsTable.jsx`**

```jsx
import { h } from 'preact';
import { activeSource, rows, loading, selectedRow, quickSearch } from '../store.js';
import { SOURCES } from '../sources/index.js';
import { quickMatch } from '../quickSearch.js';
import { makeCtx } from '../ctx.js';

export default function ResultsTable() {
  const desc = SOURCES[activeSource.value];
  const all = rows.value;
  const q = quickSearch.value.trim();
  const filtered = q ? all.filter((r) => quickMatch(r, q)) : all;
  const ctx = makeCtx();

  if (loading.value && all.length === 0) return <div class="results-empty">Loading…</div>;
  if (!loading.value && all.length === 0) return <div class="results-empty">No records match the current filters.</div>;
  if (filtered.length === 0) return <div class="results-empty">No rows on this page match the quick filter.</div>;

  return (
    <div class="results-wrap">
      <table class="results-table">
        <thead><tr>{desc.columns.map((c) => <th class={c.cls}>{c.label}</th>)}</tr></thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={String(r._idx)}
                class={'result-row' + (selectedRow.value === r._idx ? ' expanded' : '')}
                onClick={() => (selectedRow.value = selectedRow.value === r._idx ? null : r._idx)}>
              {desc.columns.map((c) => <td class={c.cls}>{c.render(r, ctx)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/audit/ctx.js`** (the render context passed to descriptor `render`/`detail`)

```js
import { domain } from './store.js';
import { resolveName } from './resolve.js';
import { buildDeeplink } from './deeplink.js';

// Render context for descriptor columns/detail: name resolution + deep-links.
// Recreated per render so resolveName's reactive reads subscribe the live render.
export function makeCtx() {
  return {
    resolveName,
    deeplink: (type, id) => buildDeeplink(domain.value, type, id),
  };
}
```

- [ ] **Step 5: Create `src/audit/components/DetailPanel.jsx`**

```jsx
import { h } from 'preact';
import { activeSource, rows, selectedRow } from '../store.js';
import { SOURCES } from '../sources/index.js';
import { makeCtx } from '../ctx.js';

export default function DetailPanel() {
  const idx = selectedRow.value;
  if (idx == null) return null;
  const row = rows.value.find((r) => r._idx === idx);
  if (!row) return null;
  const desc = SOURCES[activeSource.value];
  const sections = desc.detail(row, makeCtx());

  return (
    <aside class="audit-detail">
      <div class="audit-detail-head">
        <span>Detail</span>
        <button class="modal-close" aria-label="Close" onClick={() => (selectedRow.value = null)}>{'×'}</button>
      </div>
      <div class="audit-detail-body">
        {sections.map((s) => (
          <div class="detail-section">
            <div class="detail-summary">{s.title}</div>
            <div class="detail-body">{s.body}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Rewrite `src/audit/components/Pagination.jsx`**

```jsx
import { h } from 'preact';
import { activeSource, filtersBySource, patchFilters, pageInfo, loading, rows } from '../store.js';
import { SOURCES } from '../sources/index.js';

export default function Pagination() {
  const key = activeSource.value;
  const desc = SOURCES[key];
  const st = filtersBySource.value[key];
  const pi = pageInfo.value;
  const n = rows.value.length;

  const totalText = pi.total != null ? ` of ${pi.total.toLocaleString()}` : '';
  const countText = n === 0 ? '0 records' : `${n.toLocaleString()} shown${totalText}`;

  let prev, next, label;
  if (desc.paginationMode === 'cursor') {
    prev = () => patchFilters(key, { cursor: pi.prevCursor ?? null });
    next = () => patchFilters(key, { cursor: pi.nextCursor });
    label = pi.totalPages != null ? `${pi.totalPages} pages` : '';
  } else {
    const cur = st.page || 1;
    prev = () => patchFilters(key, { page: cur - 1 });
    next = () => patchFilters(key, { page: cur + 1 });
    label = `Page ${cur}${pi.totalPages != null ? ` / ${pi.totalPages}` : ''}`;
  }

  return (
    <div class="pagination">
      <span>{countText}</span>
      <div class="pagination-controls">
        <button disabled={!pi.hasPrev || loading.value} onClick={prev}>{'←'} Prev</button>
        <span>{label}</span>
        <button disabled={!pi.hasNext || loading.value} onClick={next}>Next {'→'}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Add CSS to `src/console/console.css`** (append near the Audit section)

```css
/* Audit & Activity console */
.audit-tabbar { display: flex; gap: 2px; padding: 6px 16px 0; border-bottom: 1px solid var(--border); background: var(--bg-card); flex-shrink: 0; }
.audit-tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; font: inherit; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
.audit-tab:hover { color: var(--text-primary); }
.audit-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.audit-body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.audit-results-row { flex: 1; display: flex; min-height: 0; }
.audit-results-row .results-wrap { flex: 1; }
.audit-detail { width: 420px; min-width: 320px; max-width: 46%; border-left: 1px solid var(--border); background: var(--bg-card); display: flex; flex-direction: column; overflow: hidden; }
.audit-detail-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; }
.audit-detail-body { overflow: auto; padding: 10px 12px; }
```

- [ ] **Step 8: Checkpoint** — `npx vitest run` green so far (components compile; covered by the shell test in Task 7). Do not commit.

---

## Task 7: App shell wiring + initAudit rewrite

**Files:** Rewrite `src/audit/components/App.jsx`, `src/audit/index.jsx`; Modify `src/audit/components/UnavailablePanel.jsx`; Test `tests/audit-shell.test.js`

- [ ] **Step 1: Modify `UnavailablePanel.jsx`** — make the title source-aware. Change the import + title line:

```jsx
import { h } from 'preact';
import { availabilityMessage, availabilityStatus, activeSource } from '../store.js';
import { SOURCES } from '../sources/index.js';

export default function UnavailablePanel() {
  const status = availabilityStatus.value;
  const message = availabilityMessage.value;
  const label = SOURCES[activeSource.value]?.label || 'This source';
  return (
    <div class="unavailable-panel">
      <h2 class="unavailable-title">{label} aren't available for your role/plan</h2>
      {/* ...rest of the existing markup unchanged (lead/causes/raw/foot)... */}
```

(Keep the remaining body of the existing component as-is.)

- [ ] **Step 2: Rewrite `src/audit/components/App.jsx`**

```jsx
import { h, Fragment } from 'preact';
import { connected as connectedSig, availability, error, selectedRow } from '../store.js';
import ConnectionBar from './ConnectionBar.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import TabBar from './TabBar.jsx';
import FiltersBar from './FiltersBar.jsx';
import ResultsTable from './ResultsTable.jsx';
import DetailPanel from './DetailPanel.jsx';
import Pagination from './Pagination.jsx';
import UnavailablePanel from './UnavailablePanel.jsx';

export default function App({ connected }) {
  return (
    <div class="app-root">
      <main class="main">
        <ConnectionBar connected={connected} />
        <ErrorBanner />
        {!connected ? (
          <div class="empty-state">Not connected — open a Rossum page and click Audit Logs in the extension popup.</div>
        ) : (
          <Fragment>
            <TabBar />
            {availability.value === 'unavailable' ? (
              <UnavailablePanel />
            ) : (
              <div class="audit-body">
                <FiltersBar />
                <div class="audit-results-row">
                  <ResultsTable />
                  {selectedRow.value != null && <DetailPanel />}
                </div>
                <Pagination />
              </div>
            )}
          </Fragment>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `src/audit/index.jsx`**

```jsx
import { effect } from '@preact/signals';
import * as api from './api.js';
import * as store from './store.js';
import { activeApp } from '../console/store.js';
import { SOURCE_ORDER } from './sources/index.js';
import { fetchActive } from './query.js';

// Restore persisted per-source state, merging only known sources/keys over the
// defaults so a stale stored shape can't corrupt the store.
function restore(stored) {
  if (SOURCE_ORDER.includes(stored.auditActiveSource)) {
    store.activeSource.value = stored.auditActiveSource;
  }
  const saved = stored.auditFiltersBySource;
  if (saved && typeof saved === 'object') {
    const merged = { ...store.filtersBySource.value };
    for (const key of SOURCE_ORDER) {
      if (saved[key] && typeof saved[key] === 'object') {
        merged[key] = { ...merged[key], ...saved[key], cursor: null, page: 1 };
      }
    }
    store.filtersBySource.value = merged;
  }
}

export async function initAudit() {
  const stored = await chrome.storage.local.get(['auditActiveSource', 'auditFiltersBySource']);
  restore(stored);

  let connected = false;
  try { await api.whoami(); connected = true; }
  catch (err) { connected = false; store.error.value = err.message || 'Failed to verify session'; }
  store.connected.value = connected;
  if (!connected) return;

  effect(() => { chrome.storage.local.set({ auditActiveSource: store.activeSource.value }); });
  effect(() => { chrome.storage.local.set({ auditFiltersBySource: store.filtersBySource.value }); });
  // Reset the client quick filter when switching sources.
  effect(() => { const _s = store.activeSource.value; store.quickSearch.value = ''; });

  let queryController = null;
  effect(() => {
    const _src = store.activeSource.value;
    const _f = store.filtersBySource.value;
    const _app = activeApp.value;
    if (activeApp.value !== 'audit') return;
    if (queryController) queryController.abort();
    queryController = new AbortController();
    fetchActive({ signal: queryController.signal });
  });
}
```

- [ ] **Step 4: Write the shell test** `tests/audit-shell.test.js`

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/audit/api.js');
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';
import App from '../src/audit/components/App.jsx';

async function waitFor(cond, desc = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false; try { ok = cond(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
function mount(connected) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(App, { connected }), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeSource.value = 'audit';
  store.availability.value = 'available';
  store.rows.value = [];
  store.selectedRow.value = null;
  store.error.value = null;
});

describe('Audit shell', () => {
  it('renders the four source tabs when connected', () => {
    const root = mount(true);
    const labels = [...root.querySelectorAll('.audit-tab')].map((b) => b.textContent);
    expect(labels).toEqual(['Audit Logs', 'Hook Logs', 'Workflow Activity', 'Rules Execution']);
  });

  it('clicking a tab switches the active source', () => {
    const root = mount(true);
    [...root.querySelectorAll('.audit-tab')].find((b) => b.textContent === 'Hook Logs').click();
    expect(store.activeSource.value).toBe('hooks');
  });

  it('renders a row and opens the detail panel on click', async () => {
    store.rows.value = [{ _idx: 0, timestamp: '2026-01-01T00:00:00Z', username: 'a@b.c', object_type: 'user', action: 'app_load', object_id: 7, content: { status_code: 200, method: 'GET', path: '/x', request_id: 'r1' } }];
    const root = mount(true);
    await waitFor(() => root.querySelector('.result-row'), 'row rendered');
    root.querySelector('.result-row').click();
    await waitFor(() => root.querySelector('.audit-detail'), 'detail panel opened');
    expect(root.querySelector('.audit-detail').textContent).toContain('Request');
  });

  it('shows the unavailable panel when the active source is 403', () => {
    store.availability.value = 'unavailable';
    const root = mount(true);
    expect(root.querySelector('.unavailable-panel')).not.toBeNull();
    expect(root.querySelector('.results-wrap')).toBeNull();
  });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/audit-shell.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Checkpoint** — `npx vitest run` full suite green. Do not commit.

---

## Task 8: Hook Logs descriptor

**Files:** Replace stub `src/audit/sources/hookLogs.js`; Test add to `tests/audit-sources.test.js`

- [ ] **Step 1: Add the failing test** (append to `tests/audit-sources.test.js`)

```js
describe('hookLogs descriptor', () => {
  it('offset + server search; builds hook/queue/status params; resolves names + links', () => {
    const d = SOURCES.hooks;
    expect(d.paginationMode).toBe('offset');
    expect(d.supportsServerSearch).toBe(true);
    expect(d.buildParams({ hook: '5', queue: '', annotation: '9', status: 'failed', status_code: '', log_level: '', timestamp_after: '', timestamp_before: '', request_id: '' }))
      .toMatchObject({ hook: '5', annotation: '9', status: 'failed' });
    expect(d.refs({ hook_id: 1, queue_id: 2, annotation_id: 3 })).toEqual(
      expect.arrayContaining([{ type: 'hook', id: 1 }, { type: 'queue', id: 2 }, { type: 'annotation', id: 3 }]),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/audit-sources.test.js` → FAIL (stub has empty buildParams/refs).

- [ ] **Step 3: Replace `src/audit/sources/hookLogs.js`**

```jsx
import { h } from 'preact';
import JsonTree from '../components/JsonTree.jsx';
import { fmtTime, dash } from './auditLogs.js';

const STATUSES = ['waiting', 'running', 'completed', 'cancelled', 'failed'];
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

function refLink(ctx, type, id, label) {
  if (id == null) return dash();
  const url = ctx.deeplink(type, id);
  const text = label != null ? label : String(id);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : text;
}
function durationMs(r) {
  if (!r.start || !r.end) return null;
  const ms = new Date(r.end).getTime() - new Date(r.start).getTime();
  return Number.isFinite(ms) ? `${ms}ms` : null;
}

export const hookLogs = {
  key: 'hooks',
  label: 'Hook Logs',
  path: '/api/v1/hooks/logs/',
  paginationMode: 'offset',
  supportsServerSearch: true,
  filters: [
    { name: 'hook', kind: 'number', label: 'Hook ID' },
    { name: 'queue', kind: 'number', label: 'Queue ID' },
    { name: 'annotation', kind: 'number', label: 'Annotation ID' },
    { name: 'status', kind: 'select', label: 'Status', options: () => STATUSES },
    { name: 'status_code', kind: 'number', label: 'Status code' },
    { name: 'log_level', kind: 'select', label: 'Log level', options: () => LOG_LEVELS },
    { name: 'request_id', kind: 'text', label: 'Request ID' },
    { name: 'timestamp_after', kind: 'datetime', label: 'After' },
    { name: 'timestamp_before', kind: 'datetime', label: 'Before' },
  ],
  buildParams: (st) => ({
    hook: st.hook, queue: st.queue, annotation: st.annotation, status: st.status,
    status_code: st.status_code, log_level: st.log_level, request_id: st.request_id,
    timestamp_after: st.timestamp_after, timestamp_before: st.timestamp_before,
  }),
  columns: [
    { key: 'timestamp', label: 'Timestamp', cls: 'col-time mono', render: (r) => fmtTime(r.timestamp) },
    { key: 'hook', label: 'Hook', cls: 'col-user', render: (r, ctx) => refLink(ctx, 'hook', r.hook_id, ctx.resolveName('hook', r.hook_id)) },
    { key: 'event', label: 'Event', cls: 'col-action mono', render: (r) => r.event || dash() },
    { key: 'status', label: 'Status', cls: 'col-action mono', render: (r) => r.status || dash() },
    { key: 'status_code', label: 'Code', cls: 'col-status mono', render: (r) => r.status_code ?? dash() },
    { key: 'queue', label: 'Queue', cls: 'col-user', render: (r, ctx) => refLink(ctx, 'queue', r.queue_id, ctx.resolveName('queue', r.queue_id)) },
    { key: 'annotation', label: 'Annotation', cls: 'col-id mono', render: (r, ctx) => refLink(ctx, 'annotation', r.annotation_id) },
    { key: 'duration', label: 'Duration', cls: 'col-method mono', render: (r) => durationMs(r) || dash() },
  ],
  detail: (r) => [
    { title: 'Message', body: r.message ? <pre class="mono" style="white-space:pre-wrap">{r.message}</pre> : <span class="muted">—</span> },
    { title: 'Request', body: r.request ? <JsonTree data={r.request} /> : <span class="muted">—</span> },
    { title: 'Response', body: r.response ? <JsonTree data={r.response} /> : <span class="muted">—</span> },
    { title: 'Settings', body: r.settings ? <JsonTree data={r.settings} /> : <span class="muted">—</span> },
  ],
  refs: (r) => [
    r.hook_id != null && { type: 'hook', id: r.hook_id },
    r.queue_id != null && { type: 'queue', id: r.queue_id },
    r.annotation_id != null && { type: 'annotation', id: r.annotation_id },
  ].filter(Boolean),
};
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/audit-sources.test.js` → PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 9: Rules Execution descriptor

**Files:** Replace stub `src/audit/sources/rulesExecution.js`; Test add to `tests/audit-sources.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('rulesExecution descriptor', () => {
  it('offset + server search; builds rule/result params', () => {
    const d = SOURCES.rules;
    expect(d.paginationMode).toBe('offset');
    expect(d.supportsServerSearch).toBe(true);
    expect(d.buildParams({ rule: '7', annotation: '', queue: '4', execution_result: 'failure', trigger_event: '', request_id: '', created_at_after: '', created_at_before: '' }))
      .toMatchObject({ rule: '7', queue: '4', execution_result: 'failure' });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Replace `src/audit/sources/rulesExecution.js`**

```jsx
import { h } from 'preact';
import JsonTree from '../components/JsonTree.jsx';
import { fmtTime, dash } from './auditLogs.js';

const RESULTS = ['success', 'failure', 'partial_success'];
function refLink(ctx, type, id, label) {
  if (id == null) return dash();
  const url = ctx.deeplink(type, id);
  const text = label != null ? label : String(id);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : text;
}

export const rulesExecution = {
  key: 'rules',
  label: 'Rules Execution',
  path: '/api/v1/rules_execution_logs/',
  paginationMode: 'offset',
  supportsServerSearch: true,
  filters: [
    { name: 'rule', kind: 'number', label: 'Rule ID' },
    { name: 'queue', kind: 'number', label: 'Queue ID' },
    { name: 'annotation', kind: 'number', label: 'Annotation ID' },
    { name: 'execution_result', kind: 'select', label: 'Result', options: () => RESULTS },
    { name: 'trigger_event', kind: 'text', label: 'Trigger event' },
    { name: 'request_id', kind: 'text', label: 'Request ID' },
    { name: 'created_at_after', kind: 'datetime', label: 'After' },
    { name: 'created_at_before', kind: 'datetime', label: 'Before' },
  ],
  buildParams: (st) => ({
    rule: st.rule, queue: st.queue, annotation: st.annotation, execution_result: st.execution_result,
    trigger_event: st.trigger_event, request_id: st.request_id,
    created_at_after: st.created_at_after, created_at_before: st.created_at_before,
  }),
  columns: [
    { key: 'created_at', label: 'Timestamp', cls: 'col-time mono', render: (r) => fmtTime(r.created_at) },
    { key: 'rule', label: 'Rule', cls: 'col-user', render: (r) => r.rule_name || (r.rule_id != null ? String(r.rule_id) : dash()) },
    { key: 'queue', label: 'Queue', cls: 'col-user', render: (r, ctx) => refLink(ctx, 'queue', r.queue_id, ctx.resolveName('queue', r.queue_id)) },
    { key: 'annotation', label: 'Annotation', cls: 'col-id mono', render: (r, ctx) => refLink(ctx, 'annotation', r.annotation_id) },
    { key: 'trigger_event', label: 'Trigger', cls: 'col-action mono', render: (r) => r.trigger_event || dash() },
    { key: 'result', label: 'Result', cls: 'col-action mono', render: (r) => r.execution_result || dash() },
  ],
  detail: (r) => [
    { title: 'Trigger condition', body: <pre class="mono" style="white-space:pre-wrap">{r.trigger_condition || '—'}</pre> },
    { title: 'Condition results', body: r.trigger_condition_results ? <JsonTree data={r.trigger_condition_results} /> : <span class="muted">—</span> },
    { title: 'Actions', body: r.actions ? <JsonTree data={r.actions} /> : <span class="muted">—</span> },
    { title: 'Error', body: r.execution_error ? <pre class="mono" style="white-space:pre-wrap">{r.execution_error}</pre> : <span class="muted">—</span> },
  ],
  refs: (r) => [
    r.queue_id != null && { type: 'queue', id: r.queue_id },
    r.annotation_id != null && { type: 'annotation', id: r.annotation_id },
  ].filter(Boolean),
};
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 10: Workflow Activity descriptor

**Files:** Replace stub `src/audit/sources/workflowActivities.js`; Test add to `tests/audit-sources.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('workflowActivities descriptor', () => {
  it('cursor mode, no server search; builds annotation/action/ordering params; links annotation by id from url', () => {
    const d = SOURCES.workflow;
    expect(d.paginationMode).toBe('cursor');
    expect(d.supportsServerSearch).toBe(false);
    expect(d.buildParams({ annotation: '5', workflow_run: '', assignees: '', action: 'approved', ordering: '-id', created_at_after: '', created_at_before: '' }))
      .toMatchObject({ annotation: '5', action: 'approved', ordering: '-id' });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Replace `src/audit/sources/workflowActivities.js`**

```jsx
import { h } from 'preact';
import { fmtTime, dash } from './auditLogs.js';

const ACTIONS = ['step_started', 'step_completed', 'approved', 'rejected', 'workflow_started', 'workflow_completed', 'reassigned'];

// Extract a trailing numeric id from a hyperlinked resource URL (e.g. .../annotations/123).
function idFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}
function annotationLink(r, ctx) {
  const id = idFromUrl(r.annotation);
  if (id == null) return dash();
  const url = ctx.deeplink('annotation', id);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{id}</a> : String(id);
}

export const workflowActivities = {
  key: 'workflow',
  label: 'Workflow Activity',
  path: '/api/v1/workflow_activities/',
  paginationMode: 'cursor',
  supportsServerSearch: false,
  filters: [
    { name: 'annotation', kind: 'number', label: 'Annotation ID' },
    { name: 'workflow_run', kind: 'number', label: 'Workflow run ID' },
    { name: 'assignees', kind: 'number', label: 'Assignee user ID' },
    { name: 'action', kind: 'select', label: 'Action', options: () => ACTIONS },
    { name: 'ordering', kind: 'select', label: 'Order', options: () => ['-id', 'id'] },
    { name: 'created_at_after', kind: 'datetime', label: 'After' },
    { name: 'created_at_before', kind: 'datetime', label: 'Before' },
  ],
  buildParams: (st) => ({
    annotation: st.annotation, workflow_run: st.workflow_run, assignees: st.assignees,
    action: st.action, ordering: st.ordering,
    created_at_after: st.created_at_after, created_at_before: st.created_at_before,
  }),
  columns: [
    { key: 'created_at', label: 'Timestamp', cls: 'col-time mono', render: (r) => fmtTime(r.created_at) },
    { key: 'action', label: 'Action', cls: 'col-action mono', render: (r) => r.action || dash() },
    { key: 'annotation', label: 'Annotation', cls: 'col-id mono', render: (r, ctx) => annotationLink(r, ctx) },
    { key: 'created_by', label: 'By', cls: 'col-user', render: (r) => r.created_by || dash() },
    { key: 'note', label: 'Note', cls: 'col-path path-cell', render: (r) => r.note || dash() },
  ],
  detail: (r) => [
    { title: 'Activity', body: (
      <div class="mono" style="font-size:11px">
        <div>action: {r.action}</div>
        <div>workflow: {r.workflow || '—'}</div>
        <div>run: {r.workflow_run || '—'}</div>
        <div>step: {r.workflow_step || '—'}</div>
        <div>note: {r.note || '—'}</div>
      </div>) },
  ],
  refs: (r) => {
    const id = idFromUrl(r.annotation);
    return id != null ? [{ type: 'annotation', id }] : [];
  },
};
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 11: Verify deep-link routes against the live UI

**Files:** Modify `src/audit/deeplink.js` (only `ROUTES` values, if needed)

- [ ] **Step 1:** Open the running Rossum UI (the domain the extension targets) with `agent-browser` (see CLAUDE.md → Browser Automation). Navigate to: an annotation/document, a queue, and a hook/extension settings page. Record the actual URL path for each (the part after the origin).

- [ ] **Step 2:** Compare each to `ROUTES` in `src/audit/deeplink.js`:
  - `annotation: (id) => `/document/${id}``
  - `queue: (id) => `/queues/${id}``
  - `hook: (id) => `/settings/extensions/${id}``
  If any differs, update that single arrow function to match the observed path. If a resource type has no stable UI route, delete its `ROUTES` entry — `buildDeeplink` already returns `null` for unknown types, so those references degrade to plain text.

- [ ] **Step 3:** Re-run `npx vitest run tests/audit-resolve.test.js` (the deeplink test asserts against `ROUTES`, so it stays green by construction).

- [ ] **Step 4: Checkpoint** — green; routes confirmed. Do not commit.

---

## Task 12: Cleanup, docs, full verification

**Files:** `git rm` dead files; Modify `CLAUDE.md`; build + test + smoke

- [ ] **Step 1: Remove replaced files**

```bash
git rm src/audit/components/Filters.jsx src/audit/components/RecordDetail.jsx
```
Then grep to confirm nothing imports them: `grep -rn "Filters.jsx\|RecordDetail" src/audit` → expect no matches.

- [ ] **Step 2: Update `CLAUDE.md`** — in the Audit Logs section, replace the single-endpoint description with: the Audit app is now a unified Audit & Activity console (`src/audit/`) — a descriptor-driven shell (`sources/*` descriptors + generic `TabBar`/`FiltersBar`/`ResultsTable`/`DetailPanel`/`Pagination`) over four sources (audit_logs, hooks/logs, workflow_activities, rules_execution_logs); cursor + offset pagination; cached id→name resolution (`resolve.js`) + deep-links (`deeplink.js`); per-source 403 → `UnavailablePanel`. Note storage keys `auditActiveSource` + `auditFiltersBySource` (replacing `auditFilters`/`auditPageSize`).

- [ ] **Step 3: Full suite** — `npm test` → all green. Report numbers.

- [ ] **Step 4: Build** — `npm run build` → clean; confirm `dist/console/console.js` builds (the audit modules are bundled into the console entry).

- [ ] **Step 5: Manual smoke** (load `dist/` unpacked, open a Rossum page → popup → Audit Logs):
  - Four tabs render; switching tabs swaps filters/columns and fetches.
  - Audit Logs: change object_type/action/time range; cursor Prev/Next work; total shows.
  - Hook Logs: server search + status filter; offset Prev/Next; row → right detail panel with request/response/settings JSON; hook/queue names resolve; annotation link opens the Rossum UI.
  - A source the tenant lacks (or 403) shows the Unavailable panel without breaking the others.
  - Light + dark mode.

- [ ] **Step 6: Checkpoint** — full suite green + build clean + smoke verified. Do not commit (leave for the maintainer).

---

## Self-review notes (author)

- **Spec coverage:** sources/descriptor shell → T1–T7; Audit Logs → T4; Hook/Rules/Workflow → T8–T10; resolution+deep-link → T3 (+T11 route verify); per-source availability → T5/T7; pagination cursor+offset → T2/T5/T6; persistence/init → T1/T7; testing → each task; docs/cleanup → T12.
- **Type consistency:** signal/function names used uniformly — `activeSource`, `filtersBySource`, `patchFilters`, `rows`, `pageInfo`, `selectedRow`, `quickSearch`, `availability*`, `connected`; `SOURCES`/`SOURCE_ORDER`; `fetchActive`; `api.get`/`api.buildQuery`/`api.normalizePage`/`api.extractParam`; `resolveName`/`buildDeeplink`/`ROUTES`; `makeCtx()` → `{ resolveName, deeplink }`; descriptor shape `{ key,label,path,paginationMode,supportsServerSearch,filters,buildParams,columns,detail,refs }` identical across all four.
- **No placeholders:** every code step is complete; `ROUTES` carries a concrete map verified in T11 (not a TODO). The stub descriptors in T4 are explicitly temporary and fully replaced in T8–T10.
```
