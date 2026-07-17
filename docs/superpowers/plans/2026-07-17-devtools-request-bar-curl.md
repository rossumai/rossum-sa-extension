# DevTools Request Bar + Copy as curl — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rossum-aware, GET-only request bar (catalog-autocomplete + validation) and a Copy-as-curl action to the DevTools "Rossum" panel.

**Architecture:** Additive to the existing panel (`src/devtools/`). Three new pure modules (`requestInput.js`, `catalog.js`, `curl.js`) + one new component (`RequestBar.jsx`), wired into `panel.jsx`. A bar-issued GET becomes a tab through the *same* path a Cmd/click uses (`resourceFromApiUrl` → `openResourceTab`), with a new generic **read-only** descriptor (`genericResourceFromPath`) for list/query/unknown paths. Editing is untouched (existing PATCH diff→confirm). curl is built purely and copied to the clipboard; the live token is emitted only on an explicit, warned action.

**Tech Stack:** Preact + `@preact/signals`, esbuild (iife, `jsxFactory: h`), Vitest (`tests/devtools-*.test.js`, jsdom for components, `h(Component, null)` — never raw JSX in tests).

## Global Constraints

- **GET-only issuing.** The bar never sends non-GET. No method dropdown in v1. Editing a fetched resource stays on the existing PATCH diff→confirm flow.
- **Nothing persisted.** No new `chrome.storage` keys, no history/saved requests. The auth token is never written at rest; the live-token curl reaches the clipboard only on the explicit "Copy with live token" action.
- **Warn, don't block.** An unknown endpoint shows an advisory chip but still fires.
- **Reuse-first.** Route through `openResourceTab`/`loadResource`/`getResource`/`PreviewPane`; do not duplicate fetch/render logic.
- **apiPath contract.** Every fetched path must start with `/api/v1/` (enforced by `api.js` `urlFor`) and contain no `..`.
- **JSX unicode:** never put `\uXXXX` in JSX text/attributes — use the literal glyph, an HTML entity, or a `{'…'}` expression (see CLAUDE.md "JSX escape sequences"). In plain `.js` strings `\uXXXX` is fine.
- **Tests:** Vitest; components use `h(Component, null)` and condition-based `waitFor` (no fixed `setTimeout` flushes as sync points).
- **Commits:** ONE commit at the very end of the run (owner preference — no per-task commits, no feat/refactor/docs splitting). No `Co-Authored-By` trailer. Work on `master`, no branches/worktrees.
- **Build:** this changes DevTools UI → the final task runs `npm run build` and the run must tell the user to reload the extension (dist is what runs, not src).

---

## File Structure

**New (all `src/devtools/`):**
- `requestInput.js` — pure. `normalizeRequestInput(raw, currentDomain)` → `{apiPath}` | `{error}` | `null`.
- `catalog.js` — pure. `ENDPOINTS`, `suggest(raw)`, `isKnownCollection(apiPath)`, `mergeLiveCollections(names)`.
- `curl.js` — pure. `buildCurl({domain, apiPath, token})` → string.
- `RequestBar.jsx` — the bar + autocomplete dropdown + validation chip.

**Modified:**
- `resourceFromApiUrl.js` — add `genericResourceFromPath(apiPath)` (leave existing export byte-identical).
- `actions.js` — add `openRequestPath(rawInput, domain, deps)`.
- `api.js` — store the raw token; add `getContext()` → `{domain, token}` (for curl).
- `store.js` — add `toast` signal.
- `panel.jsx` — mount `<RequestBar>` above the tab bar; Cmd/Ctrl+L focus; curl in footer + tab context menu; render toast.
- `panel.css` — bar, dropdown, validation chip, curl buttons, toast (theme-aware).

**Tests (new):** `tests/devtools-requestinput.test.js`, `tests/devtools-catalog.test.js`, `tests/devtools-curl.test.js`, `tests/devtools-requestbar.test.js`. **Extended:** `tests/devtools-resourcefromurl.test.js`, `tests/devtools-actions.test.js`, `tests/devtools-panel.test.js`.

> **Checkpoint convention (owner git preference):** each task ends by running the full suite green (`npm test`) — that is the review gate. Do **not** `git commit` per task. A single final commit is Task 9.

---

### Task 1: `requestInput.js` — normalize free-form input to an apiPath

**Files:**
- Create: `src/devtools/requestInput.js`
- Test: `tests/devtools-requestinput.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeRequestInput(raw, currentDomain) → { apiPath } | { error } | null`. `null` = empty/no-op input; `{error}` = a message to show without firing; `{apiPath}` = a leading-slash `/api/v1/…` path with any query string preserved.

- [ ] **Step 1: Write the failing test**

```js
// tests/devtools-requestinput.test.js
import { describe, it, expect } from 'vitest';
import { normalizeRequestInput } from '../src/devtools/requestInput.js';

const DOM = 'https://elis.rossum.app';

describe('normalizeRequestInput', () => {
  it('returns null for empty / whitespace / non-string', () => {
    expect(normalizeRequestInput('', DOM)).toBeNull();
    expect(normalizeRequestInput('   ', DOM)).toBeNull();
    expect(normalizeRequestInput(null, DOM)).toBeNull();
  });
  it('accepts a full URL of the current org and keeps path + query', () => {
    expect(normalizeRequestInput('https://elis.rossum.app/api/v1/queues/9?x=1', DOM))
      .toEqual({ apiPath: '/api/v1/queues/9?x=1' });
  });
  it('rejects a full URL of a different host', () => {
    const r = normalizeRequestInput('https://other.rossum.app/api/v1/queues/9', DOM);
    expect(r.error).toMatch(/elis\.rossum\.app/);
  });
  it('auto-prepends /api/v1 to a bare path', () => {
    expect(normalizeRequestInput('/queues/9', DOM)).toEqual({ apiPath: '/api/v1/queues/9' });
    expect(normalizeRequestInput('queues', DOM)).toEqual({ apiPath: '/api/v1/queues' });
    expect(normalizeRequestInput('annotations?queue=1', DOM)).toEqual({ apiPath: '/api/v1/annotations?queue=1' });
  });
  it('leaves an already /api/v1 path unchanged (no double-prefix)', () => {
    expect(normalizeRequestInput('/api/v1/hooks/3', DOM)).toEqual({ apiPath: '/api/v1/hooks/3' });
    expect(normalizeRequestInput('/api/v1', DOM)).toEqual({ apiPath: '/api/v1' });
  });
  it('errors on an unresolved {id} placeholder', () => {
    expect(normalizeRequestInput('/api/v1/queues/{id}', DOM).error).toMatch(/\{id\}/);
  });
  it('errors on a path traversal attempt', () => {
    expect(normalizeRequestInput('/api/v1/../secrets', DOM).error).toMatch(/invalid/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-requestinput.test.js`
Expected: FAIL — `normalizeRequestInput is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/devtools/requestInput.js
// PURE: normalize free-form request-bar input into a Rossum /api/v1 apiPath.
// Returns { apiPath } | { error } | null (null = empty/no-op).
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

export function normalizeRequestInput(raw, currentDomain) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  let path = s;
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return { error: 'Not a valid URL.' }; }
    const cur = hostOf(currentDomain);
    if (cur && u.host !== cur) return { error: `Only ${cur} can be queried here.` };
    path = u.pathname + u.search;
  }

  if (!path.startsWith('/')) path = '/' + path;
  if (!/^\/api\/v1(\/|$)/.test(path)) path = '/api/v1' + path;
  if (path.includes('..')) return { error: 'Invalid path.' };
  if (path.includes('{')) return { error: 'Replace the {id} placeholder with a real id.' };
  return { apiPath: path };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-requestinput.test.js`
Expected: PASS (all 7).

---

### Task 2: `catalog.js` — endpoint catalog, autocomplete, validation

**Files:**
- Create: `src/devtools/catalog.js`
- Test: `tests/devtools-catalog.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ENDPOINTS: Array<{ collection, kind:'list'|'detail'|'sub', pathTemplate, label, description }>`
  - `suggest(raw) → ENDPOINTS[]` — ranked (prefix-match first), capped at 8; `[]` for empty input.
  - `isKnownCollection(apiPath) → boolean` — is the leading `/api/v1/<collection>` in the catalog.
  - `mergeLiveCollections(names: string[]) → void` — add catalog rows for live-discovered collections not already present (used by the optional Task 8).

- [ ] **Step 1: Write the failing test**

```js
// tests/devtools-catalog.test.js
import { describe, it, expect } from 'vitest';
import { ENDPOINTS, suggest, isKnownCollection, mergeLiveCollections } from '../src/devtools/catalog.js';

describe('catalog', () => {
  it('ships a non-trivial curated catalog of {collection,kind,pathTemplate,label,description}', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(15);
    for (const e of ENDPOINTS) {
      expect(typeof e.collection).toBe('string');
      expect(['list', 'detail', 'sub']).toContain(e.kind);
      expect(e.pathTemplate.startsWith('/api/v1/')).toBe(true);
      expect(typeof e.label).toBe('string');
      expect(typeof e.description).toBe('string');
    }
  });
  it('suggest ranks prefix matches first and includes sub-resources', () => {
    const s = suggest('ann');
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].collection).toBe('annotations');
    expect(s.some((e) => e.pathTemplate.includes('/content'))).toBe(true);
  });
  it('suggest matches on a typed path and is capped at 8', () => {
    expect(suggest('/api/v1/queues')[0].collection).toBe('queues');
    expect(suggest('e').length).toBeLessThanOrEqual(8);
  });
  it('suggest returns [] for empty input', () => {
    expect(suggest('')).toEqual([]);
    expect(suggest('   ')).toEqual([]);
  });
  it('isKnownCollection recognises catalog collections and flags unknowns', () => {
    expect(isKnownCollection('/api/v1/queues')).toBe(true);
    expect(isKnownCollection('/api/v1/annotations/5/content')).toBe(true);
    expect(isKnownCollection('/api/v1/florps')).toBe(false);
  });
  it('mergeLiveCollections adds only unknown names', () => {
    const before = ENDPOINTS.length;
    mergeLiveCollections(['queues', 'florps']);
    expect(isKnownCollection('/api/v1/florps')).toBe(true);
    expect(ENDPOINTS.length).toBe(before + 1); // queues already present
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-catalog.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/devtools/catalog.js
// PURE-ish: curated catalog of the SA-relevant Rossum API surface, plus
// autocomplete + validation helpers. `ENDPOINTS` is mutated only by
// mergeLiveCollections (append-only, dedup by collection+kind).
export const ENDPOINTS = [
  { collection: 'queues', kind: 'list', pathTemplate: '/api/v1/queues', label: 'Queues', description: 'list · filters: workspace · ordering · page_size' },
  { collection: 'queues', kind: 'detail', pathTemplate: '/api/v1/queues/{id}', label: 'Queue', description: 'one queue · fields: schema, hooks, inbox, engine, workspace' },
  { collection: 'schemas', kind: 'list', pathTemplate: '/api/v1/schemas', label: 'Schemas', description: 'list · ordering · page_size' },
  { collection: 'schemas', kind: 'detail', pathTemplate: '/api/v1/schemas/{id}', label: 'Schema', description: 'one schema (content tree)' },
  { collection: 'hooks', kind: 'list', pathTemplate: '/api/v1/hooks', label: 'Hooks', description: 'list · filters: active, queue · page_size' },
  { collection: 'hooks', kind: 'detail', pathTemplate: '/api/v1/hooks/{id}', label: 'Hook', description: 'one hook/extension' },
  { collection: 'hooks', kind: 'sub', pathTemplate: '/api/v1/hooks/logs', label: 'Hook logs', description: 'hook execution logs · filters: hook, log_level' },
  { collection: 'engines', kind: 'list', pathTemplate: '/api/v1/engines', label: 'Engines', description: 'list of extraction engines' },
  { collection: 'engines', kind: 'detail', pathTemplate: '/api/v1/engines/{id}', label: 'Engine', description: 'one engine' },
  { collection: 'rules', kind: 'list', pathTemplate: '/api/v1/rules', label: 'Rules', description: 'list · filters: queue, enabled' },
  { collection: 'rules', kind: 'detail', pathTemplate: '/api/v1/rules/{id}', label: 'Rule', description: 'one business rule' },
  { collection: 'annotations', kind: 'list', pathTemplate: '/api/v1/annotations', label: 'Annotations', description: 'list · filters: queue, status, document, id · sideload: document, modifier · ordering' },
  { collection: 'annotations', kind: 'detail', pathTemplate: '/api/v1/annotations/{id}', label: 'Annotation', description: 'one annotation · sideload: document, modifier' },
  { collection: 'annotations', kind: 'sub', pathTemplate: '/api/v1/annotations/{id}/content', label: 'Annotation content', description: 'datapoint tree (read-only here)' },
  { collection: 'documents', kind: 'detail', pathTemplate: '/api/v1/documents/{id}', label: 'Document', description: 'one document' },
  { collection: 'documents', kind: 'sub', pathTemplate: '/api/v1/documents/{id}/content', label: 'Document content', description: 'original file (preview)' },
  { collection: 'pages', kind: 'detail', pathTemplate: '/api/v1/pages/{id}', label: 'Page', description: 'one page · page_data?granularity=words' },
  { collection: 'relations', kind: 'list', pathTemplate: '/api/v1/relations', label: 'Relations', description: 'annotation relations' },
  { collection: 'workspaces', kind: 'list', pathTemplate: '/api/v1/workspaces', label: 'Workspaces', description: 'list · filters: organization' },
  { collection: 'workspaces', kind: 'detail', pathTemplate: '/api/v1/workspaces/{id}', label: 'Workspace', description: 'one workspace' },
  { collection: 'organizations', kind: 'list', pathTemplate: '/api/v1/organizations', label: 'Organizations', description: 'list (usually one)' },
  { collection: 'organizations', kind: 'detail', pathTemplate: '/api/v1/organizations/{id}', label: 'Organization', description: 'one organization' },
  { collection: 'users', kind: 'list', pathTemplate: '/api/v1/users', label: 'Users', description: 'list · filters: username, email, is_active' },
  { collection: 'users', kind: 'detail', pathTemplate: '/api/v1/users/{id}', label: 'User', description: 'one user' },
  { collection: 'groups', kind: 'list', pathTemplate: '/api/v1/groups', label: 'Groups', description: 'permission groups' },
  { collection: 'connectors', kind: 'list', pathTemplate: '/api/v1/connectors', label: 'Connectors', description: 'legacy connectors' },
  { collection: 'email_templates', kind: 'list', pathTemplate: '/api/v1/email_templates', label: 'Email templates', description: 'list · filters: queue' },
  { collection: 'emails', kind: 'list', pathTemplate: '/api/v1/emails', label: 'Emails', description: 'list · filters: queue, thread' },
  { collection: 'email_threads', kind: 'list', pathTemplate: '/api/v1/email_threads', label: 'Email threads', description: 'list · filters: queue' },
  { collection: 'inboxes', kind: 'detail', pathTemplate: '/api/v1/inboxes/{id}', label: 'Inbox', description: 'one inbox' },
  { collection: 'workflows', kind: 'list', pathTemplate: '/api/v1/workflows', label: 'Workflows', description: 'approval workflows' },
  { collection: 'workflow_steps', kind: 'list', pathTemplate: '/api/v1/workflow_steps', label: 'Workflow steps', description: 'ordered steps · filter: workflow' },
  { collection: 'workflow_runs', kind: 'list', pathTemplate: '/api/v1/workflow_runs', label: 'Workflow runs', description: 'runs · filters: annotation, status' },
  { collection: 'workflow_activities', kind: 'list', pathTemplate: '/api/v1/workflow_activities', label: 'Workflow activities', description: 'assignee activity · filter: workflow_run' },
  { collection: 'audit_logs', kind: 'list', pathTemplate: '/api/v1/audit_logs', label: 'Audit logs', description: 'cursor pagination · filters: user, action, object' },
  { collection: 'tasks', kind: 'detail', pathTemplate: '/api/v1/tasks/{id}', label: 'Task', description: 'async operation status' },
  { collection: 'auth', kind: 'sub', pathTemplate: '/api/v1/auth/user', label: 'Auth user', description: 'the current user + home org' },
];

const term = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  const noApi = s.replace(/^https?:\/\/[^/]+/, '').replace(/^\/?api\/v1\/?/, '');
  return noApi.replace(/^\//, '');
};

export function suggest(raw) {
  const t = term(raw);
  if (!t) return [];
  const scored = [];
  for (const e of ENDPOINTS) {
    const hay = `${e.collection} ${e.label} ${e.pathTemplate}`.toLowerCase();
    if (!hay.includes(t)) continue;
    const rank = e.collection.startsWith(t) ? 0 : e.pathTemplate.toLowerCase().includes('/' + t) ? 1 : 2;
    scored.push({ e, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, 8).map((x) => x.e);
}

export function isKnownCollection(apiPath) {
  const m = String(apiPath || '').match(/^\/api\/v1\/([a-z_]+)/);
  if (!m) return false;
  return ENDPOINTS.some((e) => e.collection === m[1]);
}

export function mergeLiveCollections(names) {
  for (const name of names || []) {
    if (typeof name !== 'string' || !name) continue;
    if (ENDPOINTS.some((e) => e.collection === name)) continue;
    ENDPOINTS.push({ collection: name, kind: 'list', pathTemplate: `/api/v1/${name}`, label: name, description: 'list (discovered)' });
  }
}
```

> Note the `·` (middle dot) lives inside plain JS strings — that is allowed and renders correctly. Do **not** move these into JSX text.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-catalog.test.js`
Expected: PASS (all 6).

---

### Task 3: `curl.js` — build an equivalent curl command

**Files:**
- Create: `src/devtools/curl.js`
- Test: `tests/devtools-curl.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildCurl({ domain, apiPath, token }) → string`. Redacted (`$ROSSUM_TOKEN` + `# export` hint) when `token` is falsy; live (real token, no hint) when present.

- [ ] **Step 1: Write the failing test**

```js
// tests/devtools-curl.test.js
import { describe, it, expect } from 'vitest';
import { buildCurl } from '../src/devtools/curl.js';

const DOM = 'https://elis.rossum.app';

describe('buildCurl', () => {
  it('redacts the token by default and adds an export hint', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/queues/123' });
    expect(out).toContain("Authorization: Token $ROSSUM_TOKEN");
    expect(out).toContain("'https://elis.rossum.app/api/v1/queues/123'");
    expect(out).toContain('# export ROSSUM_TOKEN=');
  });
  it('emits the live token and no hint when a token is given', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/queues/123', token: 'abc123' });
    expect(out).toContain('Authorization: Token abc123');
    expect(out).not.toContain('$ROSSUM_TOKEN');
    expect(out).not.toContain('# export');
  });
  it('single-quotes the URL (shell-safe)', () => {
    const out = buildCurl({ domain: DOM, apiPath: '/api/v1/annotations?queue=1' });
    expect(out).toContain("'https://elis.rossum.app/api/v1/annotations?queue=1'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-curl.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/devtools/curl.js
// PURE: build an equivalent GET curl command for a Rossum API path.
export function buildCurl({ domain, apiPath, token } = {}) {
  const url = `${domain || ''}${apiPath || ''}`;
  const auth = token ? `Token ${token}` : 'Token $ROSSUM_TOKEN';
  const cmd = `curl -H 'Authorization: ${auth}' \\\n  '${url}'`;
  return token ? cmd : `${cmd}\n# export ROSSUM_TOKEN=<your token>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-curl.test.js`
Expected: PASS (all 3).

---

### Task 4: generic descriptor + `openRequestPath`

**Files:**
- Modify: `src/devtools/resourceFromApiUrl.js` (add one export at end — leave `resourceFromApiUrl` byte-identical)
- Modify: `src/devtools/actions.js` (import `genericResourceFromPath`; add `openRequestPath`)
- Test: `tests/devtools-resourcefromurl.test.js` (extend), `tests/devtools-actions.test.js` (extend)

**Interfaces:**
- Consumes: `resourceFromApiUrl(url)` (existing), `normalizeRequestInput` (Task 1), `openResourceTab(resource, deps)` (existing), `store.keyOf` (existing).
- Produces:
  - `genericResourceFromPath(apiPath) → { type, apiPath, label, readOnly:true } | null` — a read-only descriptor for list/query/unknown paths; **no `id`**; `apiPath` retains the full query string.
  - `openRequestPath(rawInput, domain, deps) → { tab } | { error } | null` — normalize → pick single-resource (no query, has id) vs generic → `openResourceTab`.

- [ ] **Step 1: Write the failing tests**

```js
// append to tests/devtools-resourcefromurl.test.js
import { genericResourceFromPath } from '../src/devtools/resourceFromApiUrl.js';

describe('genericResourceFromPath', () => {
  it('builds a read-only descriptor for a bare collection', () => {
    expect(genericResourceFromPath('/api/v1/queues'))
      .toEqual({ type: 'queues', apiPath: '/api/v1/queues', label: 'queues', readOnly: true });
  });
  it('keeps the query string in apiPath and label', () => {
    const r = genericResourceFromPath('/api/v1/annotations?queue=1&status=to_review');
    expect(r.apiPath).toBe('/api/v1/annotations?queue=1&status=to_review');
    expect(r.type).toBe('annotations');
    expect(r.readOnly).toBe(true);
  });
  it('truncates a very long label with an ellipsis', () => {
    const long = '/api/v1/annotations?' + 'x=1&'.repeat(30);
    expect(genericResourceFromPath(long).label.length).toBeLessThanOrEqual(40);
  });
  it('returns null for a non /api/v1 path', () => {
    expect(genericResourceFromPath('/nope')).toBeNull();
  });
});
```

```js
// append to tests/devtools-actions.test.js
import { openRequestPath } from '../src/devtools/actions.js';

describe('openRequestPath', () => {
  const deps = { getResource: () => Promise.resolve({ kind: 'json', data: {} }) };
  it('opens a single resource as an editable tab (no query, has id)', () => {
    const r = openRequestPath('/api/v1/queues/9', 'https://elis.rossum.app', deps);
    expect(r.tab.resource).toEqual({ type: 'queue', id: '9', apiPath: '/api/v1/queues/9', label: 'Queue' });
    expect(r.tab.resource.readOnly).toBeUndefined();
  });
  it('opens a bare collection as a generic read-only tab', () => {
    const r = openRequestPath('queues', 'https://elis.rossum.app', deps);
    expect(r.tab.resource.readOnly).toBe(true);
    expect(r.tab.resource.apiPath).toBe('/api/v1/queues');
  });
  it('routes a query path to the generic descriptor and keeps the query', () => {
    const r = openRequestPath('/api/v1/annotations?queue=1', 'https://elis.rossum.app', deps);
    expect(r.tab.resource.apiPath).toBe('/api/v1/annotations?queue=1');
    expect(r.tab.resource.readOnly).toBe(true);
  });
  it('returns an error (no tab) for a cross-host URL', () => {
    const r = openRequestPath('https://other.rossum.app/api/v1/queues/1', 'https://elis.rossum.app', deps);
    expect(r.error).toBeTruthy();
    expect(r.tab).toBeUndefined();
  });
  it('returns null for empty input', () => {
    expect(openRequestPath('   ', 'https://elis.rossum.app', deps)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/devtools-resourcefromurl.test.js tests/devtools-actions.test.js`
Expected: FAIL — `genericResourceFromPath` / `openRequestPath` not exported.

- [ ] **Step 3: Implement**

Append to `src/devtools/resourceFromApiUrl.js`:

```js
// A generic READ-ONLY descriptor for list / query / unknown paths (no id).
// Used by the request bar when the input isn't a single editable resource.
export function genericResourceFromPath(apiPath) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/v1/')) return null;
  const rest = apiPath.slice('/api/v1/'.length);
  const collection = (rest.match(/^([a-z_]+)/) || [])[1] || 'resource';
  const label = rest.length > 40 ? rest.slice(0, 39) + '…' : rest;
  return { type: collection, apiPath, label, readOnly: true };
}
```

Modify `src/devtools/actions.js` — update the import and add the function:

```js
// change the existing import line to also pull in the generic builder:
import { resourceFromApiUrl, genericResourceFromPath } from './resourceFromApiUrl.js';
import { normalizeRequestInput } from './requestInput.js';
```

```js
// append near openResourceTab:
// Fire a request-bar input: normalize → single resource (editable) or generic
// read-only (list/query/unknown) → open as a tab. GET-only; never non-GET.
export function openRequestPath(rawInput, domain, deps) {
  const norm = normalizeRequestInput(rawInput, domain);
  if (!norm) return null;
  if (norm.error) return { error: norm.error };
  const single = norm.apiPath.includes('?') ? null : resourceFromApiUrl(norm.apiPath);
  const resource = single || genericResourceFromPath(norm.apiPath);
  if (!resource) return { error: 'Could not parse that path.' };
  const tab = openResourceTab(resource, deps);
  return { tab };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/devtools-resourcefromurl.test.js tests/devtools-actions.test.js`
Expected: PASS (existing + new).

---

### Task 5: `api.getContext()` + `store.toast`

**Files:**
- Modify: `src/devtools/api.js` (store raw token; add `getContext`)
- Modify: `src/devtools/store.js` (add `toast` signal)
- Test: `tests/devtools-api.test.js` (extend)

**Interfaces:**
- Consumes: `api.init(domain, token)` (existing).
- Produces: `api.getContext() → { domain, token }` (raw values, in-memory only); `store.toast` signal (`null` | `{ message }`).

- [ ] **Step 1: Write the failing test**

```js
// append to tests/devtools-api.test.js
import * as api from '../src/devtools/api.js';

describe('getContext', () => {
  it('returns the domain and raw token set by init', () => {
    api.init('https://elis.rossum.app', 'tok_123');
    expect(api.getContext()).toEqual({ domain: 'https://elis.rossum.app', token: 'tok_123' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-api.test.js`
Expected: FAIL — `api.getContext is not a function`.

- [ ] **Step 3: Implement**

In `src/devtools/api.js`, add a `rawToken` module var and set it in `init`, then add `getContext`:

```js
let baseDomain = '';
let authHeader = '';
let rawToken = '';

export function init(domain, token) {
  baseDomain = domain || '';
  rawToken = token || '';
  authHeader = token ? `Token ${token}` : '';
}

export function getContext() { return { domain: baseDomain, token: rawToken }; }
```

In `src/devtools/store.js`, add after the other signals:

```js
// Transient toast (e.g. "Live token copied"). null = hidden.
export const toast = signal(null);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-api.test.js`
Expected: PASS.

---

### Task 6: `RequestBar.jsx` + panel wiring (bar, autocomplete, Cmd/Ctrl+L)

**Files:**
- Create: `src/devtools/RequestBar.jsx`
- Modify: `src/devtools/panel.jsx` (import + set domain/token into `api` in the bridge [already done via `api.init`]; render `<RequestBar>` above `<TabBar>`; add Cmd/Ctrl+L to the capture-phase keydown handler)
- Modify: `src/devtools/panel.css` (bar, dropdown, chip)
- Test: `tests/devtools-requestbar.test.js`

**Interfaces:**
- Consumes: `suggest` + `isKnownCollection` (Task 2), `openRequestPath` (Task 4), `api.getContext` (Task 5).
- Produces: `RequestBar({ onSubmit })` where `onSubmit(rawInput) → { tab } | { error } | null`. Renders `input.rawjson-reqbar-input`, a `.rawjson-reqbar-suggest` dropdown, and a `.rawjson-reqbar-chip` advisory when the typed collection is unknown.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
// tests/devtools-requestbar.test.js
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import RequestBar from '../src/devtools/RequestBar.jsx';

async function waitFor(fn, tries = 100) {
  for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 0)); }
  throw new Error('waitFor timed out');
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RequestBar', () => {
  it('renders an input and shows suggestions as you type', async () => {
    const root = document.createElement('div');
    render(h(RequestBar, { onSubmit: () => null }), root);
    const input = root.querySelector('.rawjson-reqbar-input');
    expect(input).not.toBeNull();
    type(input, 'ann');
    await waitFor(() => root.querySelector('.rawjson-reqbar-suggest'));
    expect(root.querySelector('.rawjson-reqbar-suggest').textContent.toLowerCase()).toContain('annotation');
  });
  it('submits the typed path on Enter', async () => {
    const onSubmit = vi.fn(() => ({ tab: { id: 't1' } }));
    const root = document.createElement('div');
    render(h(RequestBar, { onSubmit }), root);
    const input = root.querySelector('.rawjson-reqbar-input');
    type(input, '/api/v1/queues');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => onSubmit.mock.calls.length > 0);
    expect(onSubmit).toHaveBeenCalledWith('/api/v1/queues');
  });
  it('shows an advisory chip for an unknown collection', async () => {
    const root = document.createElement('div');
    render(h(RequestBar, { onSubmit: () => null }), root);
    type(root.querySelector('.rawjson-reqbar-input'), '/api/v1/florps');
    await waitFor(() => root.querySelector('.rawjson-reqbar-chip'));
    expect(root.querySelector('.rawjson-reqbar-chip')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-requestbar.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RequestBar.jsx`**

```jsx
// src/devtools/RequestBar.jsx
import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { suggest, isKnownCollection } from './catalog.js';

export default function RequestBar({ onSubmit }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef(null);

  const items = suggest(value);
  const unknown = value.trim() && /^\/?(api\/v1\/)?[a-z_]+/i.test(value.trim()) && !isKnownCollection(
    value.trim().startsWith('/api/v1/') ? value.trim() : '/api/v1/' + value.trim().replace(/^\//, '')
  );

  const fire = (raw) => { const v = (raw ?? value).trim(); if (!v) return; onSubmit(v); setOpen(false); };

  const pick = (e) => {
    setValue(e.pathTemplate);
    setOpen(false);
    const el = inputRef.current;
    if (el) {
      const at = e.pathTemplate.indexOf('{');
      requestAnimationFrame(() => { el.focus(); if (at >= 0) el.setSelectionRange(at, e.pathTemplate.indexOf('}') + 1); });
    }
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setOpen(true); setHi((i) => Math.min(items.length - 1, i + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setHi((i) => Math.max(-1, i - 1)); }
    else if (ev.key === 'Escape') { setOpen(false); setHi(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (open && hi >= 0 && items[hi]) pick(items[hi]);
      else fire();
    }
  };

  return (
    <div class="rawjson-reqbar">
      <span class="rawjson-reqbar-method">GET</span>
      <input
        ref={inputRef}
        class="rawjson-reqbar-input"
        type="text"
        spellcheck={false}
        placeholder="/api/v1/queues?page_size=100  —  type to search endpoints"
        value={value}
        onInput={(ev) => { setValue(ev.target.value); setOpen(true); setHi(-1); }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      <button class="rawjson-reqbar-go" title="Go" onClick={() => fire()}>{'→'}</button>
      {unknown ? <span class="rawjson-reqbar-chip">not a known Rossum endpoint {'—'} will still try</span> : null}
      {open && items.length ? (
        <ul class="rawjson-reqbar-suggest">
          {items.map((e, i) => (
            <li key={e.pathTemplate + e.kind} class={`rawjson-reqbar-item${i === hi ? ' active' : ''}`} onMouseDown={(ev) => { ev.preventDefault(); pick(e); }}>
              <span class="rawjson-reqbar-item-path">{e.pathTemplate}</span>
              <span class="rawjson-reqbar-item-desc">{e.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

> The `placeholder` attribute value contains `—`. Per CLAUDE.md, `\uXXXX` does NOT work inside a JSX attribute value written as a plain string — it renders literally. **Fix before finishing:** make the placeholder an expression, e.g. `placeholder={'/api/v1/queues?page_size=100 — type to search endpoints'}`. (The `{'→'}` button and `{'—'}` chip are already expressions and are correct.)

- [ ] **Step 3b: Wire into `panel.jsx`**

Add the import:

```jsx
import RequestBar from './RequestBar.jsx';
import { requestDiff, saveResource, loadResource, openResourceTab, openRequestPath } from './actions.js';
```

Render the bar above the tab bar (inside the main `return`, before `<TabBar …>`):

```jsx
<RequestBar onSubmit={(raw) => {
  const r = openRequestPath(raw, api.getContext().domain, deps);
  if (r && r.error) store.toast.value = { message: r.error };
  return r;
}} />
<TabBar tabs={tabsList} activeId={active.id} />
```

Extend the capture-phase `onKeydown` (the one that already handles Cmd/Ctrl+F) to also focus the bar on Cmd/Ctrl+L:

```jsx
const onKeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    const v = store.views.active;
    if (v) { e.preventDefault(); e.stopImmediatePropagation(); v.focus(); try { openSearchPanel(v); } catch { /* ignore */ } }
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
    const el = document.querySelector('.rawjson-reqbar-input');
    if (el) { e.preventDefault(); e.stopImmediatePropagation(); el.focus(); el.select(); }
  }
};
```

- [ ] **Step 3c: Styles in `panel.css`**

```css
.rawjson-reqbar { position: relative; display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid var(--border, #ddd); background: var(--bg, #fff); }
.rawjson-reqbar-method { font: 600 10px/1 monospace; color: var(--fg-dim, #888); padding: 2px 4px; border: 1px solid var(--border, #ddd); border-radius: 3px; }
.rawjson-reqbar-input { flex: 1; font: 11px/1.4 monospace; padding: 3px 6px; border: 1px solid var(--border, #ccc); border-radius: 3px; background: transparent; color: var(--fg, #222); }
.rawjson-reqbar-go { border: none; background: transparent; cursor: pointer; font-size: 13px; color: var(--accent, #2b6); padding: 0 4px; }
.rawjson-reqbar-chip { font-size: 10px; color: var(--warning-fg, #a60); }
.rawjson-reqbar-suggest { position: absolute; z-index: 30; left: 6px; right: 6px; top: 100%; margin: 2px 0 0; padding: 0; list-style: none; max-height: 260px; overflow-y: auto; background: var(--bg, #fff); border: 1px solid var(--border, #ccc); border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
.rawjson-reqbar-item { display: flex; flex-direction: column; padding: 4px 8px; cursor: pointer; }
.rawjson-reqbar-item.active, .rawjson-reqbar-item:hover { background: var(--accent-bg, #eef6ff); }
.rawjson-reqbar-item-path { font: 11px/1.3 monospace; color: var(--fg, #222); }
.rawjson-reqbar-item-desc { font-size: 10px; color: var(--fg-dim, #888); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-requestbar.test.js`
Expected: PASS (all 3).

---

### Task 7: Copy as curl UI (footer + tab context menu + toast)

**Files:**
- Modify: `src/devtools/panel.jsx` (footer buttons; tab-menu entries; toast render; a `copyCurl(live)` helper)
- Modify: `src/devtools/panel.css` (curl buttons + toast)
- Test: `tests/devtools-panel.test.js` (extend)

**Interfaces:**
- Consumes: `buildCurl` (Task 3), `api.getContext` (Task 5), `store.toast` (Task 5), the active tab's `resource.apiPath`.
- Produces: footer buttons `.rawjson-curl` / `.rawjson-curl-live`; tab-menu buttons; a `.rawjson-toast` element; clipboard writes via `navigator.clipboard.writeText`.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/devtools-panel.test.js
describe('Copy as curl', () => {
  it('copies a redacted curl for the active resource', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    globalThis.navigator.clipboard = { writeText };
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { id: 1 } });
    const root = mount();
    root.querySelector('.rawjson-curl').click();
    await waitFor(() => writeText.mock.calls.length > 0);
    expect(writeText.mock.calls[0][0]).toContain('$ROSSUM_TOKEN');
    expect(writeText.mock.calls[0][0]).toContain('/api/v1/queues/1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devtools-panel.test.js`
Expected: FAIL — no `.rawjson-curl` element.

- [ ] **Step 3: Implement in `panel.jsx`**

Add imports:

```jsx
import { buildCurl } from './curl.js';
```

Add a helper inside `Panel` (before the `return`):

```jsx
const copyCurl = (apiPath, live) => {
  const ctx = api.getContext();
  const text = buildCurl({ domain: ctx.domain, apiPath, token: live ? ctx.token : null });
  try {
    navigator.clipboard.writeText(text);
    store.toast.value = { message: live ? 'Live token copied — treat as a secret' : 'curl copied' };
    setTimeout(() => { store.toast.value = null; }, 2500);
  } catch { store.toast.value = { message: 'Copy failed' }; }
};
```

In the footer block, add the curl buttons beside Save / the read-only note (only when the tab has a resource with an apiPath):

```jsx
{active.resource && !active.preview ? (
  <div class="rawjson-footer">
    {active.readOnly
      ? <span class="rawjson-readonly-note">Read-only {'—'} this resource can't be edited here.</span>
      : <button class="rawjson-save" disabled={!active.dirty || active.saving} onClick={() => requestDiff(active.id)}>{'Save…'}</button>}
    {active.resource.apiPath ? (
      <span class="rawjson-curl-group">
        <button class="rawjson-curl" onClick={() => copyCurl(active.resource.apiPath, false)}>Copy as curl</button>
        <button class="rawjson-curl-live" title="Includes your live token" onClick={() => copyCurl(active.resource.apiPath, true)}>Copy with live token {'⚠'}</button>
      </span>
    ) : null}
  </div>
) : null}
```

Add curl entries to the tab context menu (so preview + resource-bearing page tabs are covered). In the `tabMenu` menu block, after the existing buttons, add (guarded by the menu tab having a resource apiPath):

```jsx
{menuTab.resource && menuTab.resource.apiPath ? (
  <>
    <button onClick={() => { copyCurl(menuTab.resource.apiPath, false); store.tabMenu.value = null; }}>Copy as curl</button>
    <button onClick={() => { copyCurl(menuTab.resource.apiPath, true); store.tabMenu.value = null; }}>Copy with live token {'⚠'}</button>
  </>
) : null}
```

Render the toast near the end of the panel `return` (after `{menus}`):

```jsx
{store.toast.value ? <div class="rawjson-toast">{store.toast.value.message}</div> : null}
```

- [ ] **Step 3b: Styles in `panel.css`**

```css
.rawjson-curl-group { margin-left: auto; display: inline-flex; gap: 6px; }
.rawjson-curl, .rawjson-curl-live { font-size: 11px; padding: 2px 6px; border: 1px solid var(--border, #ccc); border-radius: 3px; background: transparent; color: var(--fg, #222); cursor: pointer; }
.rawjson-curl-live { color: var(--warning-fg, #a60); border-color: var(--warning-border, #e0b060); }
.rawjson-toast { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); background: var(--fg, #222); color: var(--bg, #fff); font-size: 11px; padding: 6px 12px; border-radius: 4px; box-shadow: 0 3px 10px rgba(0,0,0,.25); z-index: 50; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/devtools-panel.test.js`
Expected: PASS (existing + new).

---

### Task 8 (OPTIONAL — live-verify gated): seed the catalog from the DRF API root

> Ship only after verifying live that `GET /api/v1/` returns a browsable `{collection: url, …}` map on a dev org. If it 403s or isn't a map, skip this task — the curated catalog stands alone. This task must degrade silently on any error.

**Files:**
- Modify: `src/devtools/panel.jsx` (one-shot fetch on first bar focus)
- Test: `tests/devtools-catalog.test.js` already covers `mergeLiveCollections`; add a guard test that a non-map response is ignored.

- [ ] **Step 1: Add a defensive test**

```js
// append to tests/devtools-catalog.test.js
it('mergeLiveCollections ignores non-string / falsy names', () => {
  const before = ENDPOINTS.length;
  mergeLiveCollections([null, 42, '', undefined]);
  expect(ENDPOINTS.length).toBe(before);
});
```

- [ ] **Step 2: Run it (should already pass given Task 2's guards)**

Run: `npx vitest run tests/devtools-catalog.test.js`
Expected: PASS.

- [ ] **Step 3: One-shot live seed in `panel.jsx`**

Inside the `useEffect`, after `startBridge(...)`, add a lazy seed guarded by a module flag so it runs at most once and never throws into the UI:

```jsx
let seeded = false;
const seedCatalog = async () => {
  if (seeded) return; seeded = true;
  try {
    const root = await api.getJson('/api/v1/');
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const names = Object.keys(root).filter((k) => typeof root[k] === 'string' && /\/api\/v1\//.test(root[k]));
      if (names.length) mergeLiveCollections(names);
    }
  } catch { /* DRF root unavailable — curated catalog stands alone */ }
};
```

Wire it to the bar's first focus (pass `onFirstFocus={seedCatalog}` to `<RequestBar>` and call it in the input's `onFocus`, once), and import `mergeLiveCollections` from `./catalog.js`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

---

### Task 9: Build + single commit

**Files:** none (build + commit only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: clean build into `dist/` (esbuild bundles the new modules; `console.js`/`panel` entry unaffected). Confirm no errors.

- [ ] **Step 3: Single commit (owner preference — one commit per run, no Co-Authored-By trailer)**

```bash
git add -A
git commit -m "feat: Rossum-aware GET request bar + Copy as curl in the DevTools panel"
```

- [ ] **Step 4: Tell the user to reload**

The loaded extension runs `dist/`, so instruct the user: **reload the extension at `chrome://extensions`, then close & reopen DevTools on a Rossum tab** to pick up the new panel bar. (Reloading the extension does not re-inject into already-open tabs.)

---

## Self-Review

**1. Spec coverage**
- Request bar (placement, GET-only, Cmd/Ctrl+L) → Task 6. ✓
- Input parsing/normalization + cross-host reject + `/api/v1` auto-prefix + `{id}` guard → Task 1. ✓
- Curated catalog + fuzzy autocomplete + advisory validation + inline param descriptions → Task 2 + Task 6 (chip/dropdown). ✓
- Optional DRF-root live seed (graceful) → Task 8 (gated). ✓
- Firing → tab: single-resource reuse + generic read-only list/query descriptor keyed by full path → Task 4. ✓
- Copy as curl (redacted default + opt-in live + toast, footer + tab menu) → Task 3 + Task 5 + Task 7. ✓
- Errors/read-only/no-persistence → Tasks 4/6/7 (reuse existing `loadResource` handling; nothing persisted; token only via explicit action). ✓
- Testing matrix (pure + partial UI) → per-task tests. ✓

**2. Placeholder scan** — no TBD/TODO; every code step shows full code. The two JSX-unicode-in-attribute hazards (RequestBar placeholder) are called out explicitly with the fix. ✓

**3. Type consistency** — `normalizeRequestInput → {apiPath}|{error}|null`, `genericResourceFromPath → {type,apiPath,label,readOnly}|null`, `openRequestPath → {tab}|{error}|null`, `buildCurl({domain,apiPath,token})→string`, `getContext()→{domain,token}`, `suggest/isKnownCollection/mergeLiveCollections` — names identical across the tasks that define and consume them. `store.toast` value shape `{message}` consistent in Tasks 5/6/7. ✓

**4. Known follow-ups (out of scope, per spec)** — param-builder chips, browse palette, contextual related-resources, history/saved requests, non-GET methods, HTTPie/prd2/fetch export.
