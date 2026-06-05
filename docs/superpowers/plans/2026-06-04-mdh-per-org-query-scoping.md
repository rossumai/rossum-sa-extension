# MDH per-org query scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope MDH's Saved queries, Recent query history, and the reload-restore last query per organization id (with a domain fallback) so they're no longer shared across projects.

**Architecture:** Resolve the org once at MDH connect (`GET {domain}/api/v1/internal/token_info` → `organization_uuid`) into a `store.orgId` signal; a `scopeSuffix()` helper returns `org:<id>` (or `domain:<origin>` fallback); `QueryHistory.jsx` and `lastPipeline.js` append that suffix to their `chrome.storage.local` keys. No migration — each org's library starts fresh; old global keys are left untouched.

**Tech Stack:** Preact + @preact/signals, vitest, Chrome storage API.

> **PROJECT CONVENTION — NO COMMITS:** Do not `git commit` and do not branch. Each task ends with a **Checkpoint** (run tests). Tests are `.test.js`; run with `npx vitest run <file>`.

---

## File structure

- **Modify** `src/mdh/store.js` — add `orgId` signal + `scopeSuffix()` helper.
- **Modify** `src/mdh/api.js` — add `getOrgId()` (reads `organization_uuid` from `/internal/token_info`).
- **Modify** `src/mdh/components/QueryHistory.jsx` — `readList`/`writeList` use the org-scoped key; drop the now-dead `chrome.storage.sync` merge.
- **Modify** `src/mdh/lastPipeline.js` — replace `LAST_PIPELINE_KEY` const with `lastPipelineKey()`.
- **Modify** `src/mdh/index.jsx` — resolve `orgId` at the top of `initMdh`, use `lastPipelineKey()` for the scoped read.
- **Test** `tests/mdh-api.test.js` (append `getOrgId`), `tests/mdh-query-history.test.js` (new), `tests/mdh-last-pipeline.test.js` (update for scoped key).

---

## Task 1: orgId signal + scopeSuffix helper

**Files:** Modify `src/mdh/store.js`; Test `tests/mdh-query-history.test.js` (created here, extended in Task 3)

- [ ] **Step 1: Write the failing test** — create `tests/mdh-query-history.test.js`

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { orgId, domain, scopeSuffix } from '../src/mdh/store.js';

beforeEach(() => { orgId.value = null; domain.value = ''; });

describe('scopeSuffix', () => {
  it('prefers the org id when resolved', () => {
    orgId.value = 214757;
    expect(scopeSuffix()).toBe('org:214757');
  });
  it('falls back to the origin when org id is null', () => {
    orgId.value = null;
    domain.value = 'https://acme.rossum.app';
    expect(scopeSuffix()).toBe('domain:https://acme.rossum.app');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: FAIL — `scopeSuffix`/`orgId` not exported.

- [ ] **Step 3: Edit `src/mdh/store.js`**

Add after the `token` signal (line 5):

```js
// Organization id of the connected project (resolved at connect via
// api.getOrgId). null until resolved, or if the lookup failed.
export const orgId = signal(null);
```

Add at the end of the file:

```js
// Suffix that namespaces per-org client state (saved/recent/last queries) so it
// isn't shared across projects. Prefers the org id; falls back to the origin so
// the data is still per-project (never global) if the org id is unavailable.
export function scopeSuffix() {
  return orgId.value != null ? `org:${orgId.value}` : `domain:${domain.value}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 2: api.getOrgId

**Files:** Modify `src/mdh/api.js`; Test `tests/mdh-api.test.js` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/mdh-api.test.js`

```js
describe('getOrgId', () => {
  beforeEach(() => { api.init('https://acme.rossum.app', 'tok'); });

  it('returns the organization_uuid from /internal/token_info', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ organization_uuid: 'b3f1c2d4-5a6b-7c8d-9e0f-112233445566' }),
    });
    expect(await api.getOrgId()).toBe('b3f1c2d4-5a6b-7c8d-9e0f-112233445566');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://acme.rossum.app/api/v1/internal/token_info',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    expect(await api.getOrgId()).toBeNull();
  });

  it('returns null when organization_uuid is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ user: {} }) });
    expect(await api.getOrgId()).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    expect(await api.getOrgId()).toBeNull();
  });
});
```

(If `import * as api from '../src/mdh/api.js'` and `vi` aren't already imported at the top of the file, add them.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-api.test.js`
Expected: FAIL — `api.getOrgId` is not a function.

- [ ] **Step 3: Edit `src/mdh/api.js`** — add this exported function (e.g. right after `init`):

```js
// Resolve the active project's organization UUID from the token's own context via
// /internal/token_info. token_info reflects the org the *token* belongs to (the
// customer org), unlike /auth/user which returns the user's home org (always org 1
// for system users). Used only to namespace per-org client state; returns null on
// any failure so callers fall back to a domain-scoped key. (token_info is gated to
// session tokens — the Bearer secureToken the extension uses — and rejects API keys.)
export async function getOrgId() {
  const { signal, timer } = combinedSignal();
  try {
    const res = await fetch(`${baseDomain}/api/v1/internal/token_info`, {
      headers: { Authorization: authHeader },
      signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.organization_uuid || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}
```

(`combinedSignal`, `baseDomain`, and `authHeader` are module-level in `api.js` — `combinedSignal()` with no argument returns `{ signal, timer }` using a fresh AbortController + 30s timeout.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-api.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 3: Scope QueryHistory (Saved + Recent)

**Files:** Modify `src/mdh/components/QueryHistory.jsx`; Test `tests/mdh-query-history.test.js` (extend)

- [ ] **Step 1: Add failing tests** — append to `tests/mdh-query-history.test.js`

```js
import { saveQuery, isSaved, unsaveQuery, addToHistory } from '../src/mdh/components/QueryHistory.jsx';

function stubStorage() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
        set: (obj) => { Object.assign(data, obj); return Promise.resolve(); },
        remove: (key) => { delete data[key]; return Promise.resolve(); },
      },
      sync: { get: () => Promise.resolve({}), remove: () => Promise.resolve() },
    },
  };
  return data;
}

describe('QueryHistory per-org scoping', () => {
  it('writes Saved/Recent under the org-scoped key and keeps orgs separate', async () => {
    const data = stubStorage();
    orgId.value = 1; domain.value = 'https://x.rossum.app';
    await saveQuery('vendors', '[{"$limit":5}]', 'q1', {});
    await addToHistory('vendors', '[{"$limit":5}]', {});
    expect(data['savedQueries::org:1']).toHaveLength(1);
    expect(data['queryHistory::org:1']).toHaveLength(1);

    // Switch org -> empty library; the org:1 data is untouched.
    orgId.value = 2;
    expect(await isSaved('vendors', '[{"$limit":5}]')).toBe(false);
    await saveQuery('items', '[{"$count":"n"}]', 'q2', {});
    expect(data['savedQueries::org:2']).toHaveLength(1);
    expect(data['savedQueries::org:1']).toHaveLength(1);
  });

  it('falls back to a domain-scoped key when org id is null', async () => {
    const data = stubStorage();
    orgId.value = null; domain.value = 'https://acme.rossum.app';
    await saveQuery('vendors', '[]', 'q', {});
    expect(data['savedQueries::domain:https://acme.rossum.app']).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: FAIL — entries are written under the unscoped `savedQueries`/`queryHistory` keys.

- [ ] **Step 3: Edit `src/mdh/components/QueryHistory.jsx`**

Change the import on line 4 from:
```js
import { selectedCollection } from '../store.js';
```
to:
```js
import { selectedCollection, scopeSuffix } from '../store.js';
```

Replace the comment block + `readList` + `writeList` (lines 8–28) with:

```js
// Saved / Recent queries are namespaced per organization (scopeSuffix) so they
// aren't shared across projects. Stored in chrome.storage.local.
async function readList(baseKey) {
  const key = `${baseKey}::${scopeSuffix()}`;
  return (await chrome.storage.local.get(key))?.[key] || [];
}

async function writeList(baseKey, list) {
  const key = `${baseKey}::${scopeSuffix()}`;
  await chrome.storage.local.set({ [key]: list });
}
```

(All callers — `addToHistory`, `saveQuery`, `unsaveQuery`, `isSaved`, `HistoryList`, `SavedList` — already pass the bare `'queryHistory'`/`'savedQueries'` as `baseKey`, so they need no change. The legacy `chrome.storage.sync` merge is intentionally removed: under the new scoped keys there's no old data to merge, matching "start fresh.")

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-query-history.test.js`
Expected: PASS (all).

- [ ] **Step 5: Checkpoint** — green. Do not commit.

---

## Task 4: Scope last pipeline + wire org-id resolution into initMdh

**Files:** Modify `src/mdh/lastPipeline.js`, `src/mdh/index.jsx`; Update `tests/mdh-last-pipeline.test.js`

- [ ] **Step 1: Update the test** — replace the top import + the `saveLastPipeline` describe block in `tests/mdh-last-pipeline.test.js`

Change the import (line 18) from:
```js
import { LAST_PIPELINE_KEY, saveLastPipeline, bootPrefillFor } from '../src/mdh/lastPipeline.js';
```
to:
```js
import { lastPipelineKey, saveLastPipeline, bootPrefillFor } from '../src/mdh/lastPipeline.js';
import { orgId, domain } from '../src/mdh/store.js';
```

In the existing `beforeEach` (after the chrome stub is set up), add:
```js
  orgId.value = 7;
  domain.value = 'https://x.rossum.app';
```

Replace the three assertions that reference `LAST_PIPELINE_KEY` so they use the scoped key, and add a fallback test. The `saveLastPipeline` describe becomes:

```js
describe('lastPipeline persistence', () => {
  it('writes text + variables under the org-scoped key', () => {
    saveLastPipeline('[{"$match":{"v":"{vendor}"}}]', { vendor: 'ACME' });
    expect(lastPipelineKey()).toBe('mdhLastPipeline::org:7');
    expect(store[lastPipelineKey()]).toEqual({
      pipelineText: '[{"$match":{"v":"{vendor}"}}]',
      variables: { vendor: 'ACME' },
    });
  });

  it('copies variables (later mutation of the source does not leak in)', () => {
    const vars = { a: '1' };
    saveLastPipeline('[]', vars);
    vars.a = 'mutated';
    expect(store[lastPipelineKey()].variables).toEqual({ a: '1' });
  });

  it('tolerates missing variables', () => {
    saveLastPipeline('[]');
    expect(store[lastPipelineKey()]).toEqual({ pipelineText: '[]', variables: {} });
  });

  it('falls back to a domain-scoped key when org id is null', () => {
    orgId.value = null;
    saveLastPipeline('[]');
    expect(lastPipelineKey()).toBe('mdhLastPipeline::domain:https://x.rossum.app');
    expect(store['mdhLastPipeline::domain:https://x.rossum.app']).toBeTruthy();
  });
});
```

(The `bootPrefillFor` describe is unchanged.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-last-pipeline.test.js`
Expected: FAIL — `lastPipelineKey` is not exported.

- [ ] **Step 3: Edit `src/mdh/lastPipeline.js`** — replace the `LAST_PIPELINE_KEY` constant + `saveLastPipeline` (lines 8–18) with:

```js
import { scopeSuffix } from './store.js';

// Per-organization key for the most recent Data-panel pipeline (editor text +
// placeholder variables): a reload restores the query and projects don't share
// it. scopeSuffix prefers the org id, falling back to the origin.
export function lastPipelineKey() {
  return `mdhLastPipeline::${scopeSuffix()}`;
}

// Persist the current editor text + placeholder variables. Best-effort: a
// storage hiccup must never break editing, so failures are swallowed.
export function saveLastPipeline(pipelineText, variables) {
  try {
    chrome.storage.local.set({
      [lastPipelineKey()]: { pipelineText, variables: { ...(variables || {}) } },
    });
  } catch { /* storage unavailable — non-fatal */ }
}
```

(Keep the existing `bootPrefillFor` function below, unchanged. The `import` line goes at the very top of the file.)

- [ ] **Step 4: Edit `src/mdh/index.jsx`**

Change the import on line 6 from:
```js
import { LAST_PIPELINE_KEY, bootPrefillFor } from './lastPipeline.js';
```
to:
```js
import { lastPipelineKey, bootPrefillFor } from './lastPipeline.js';
```

In `initMdh`, replace the opening of the function body (the `const stored = await chrome.storage.local.get([...])` block, lines 98–101) with:

```js
export async function initMdh({ pendingCollection, pendingPipeline, pendingVariables } = {}) {
  // Resolve the org id first so per-org keys (last pipeline here, and saved/recent
  // in QueryHistory) are correct before any scoped read. Failure -> null -> the
  // domain-scoped fallback in scopeSuffix.
  store.orgId.value = await api.getOrgId();

  const lpKey = lastPipelineKey();
  const stored = await chrome.storage.local.get([
    'mdhActiveView', 'mdhSelectedCollection', 'mdhActivePanel', 'mdhOpsSearch', lpKey,
  ]);
```

And change the `bootPrefillFor` call (line 130) from `stored[LAST_PIPELINE_KEY]` to `stored[lpKey]`:

```js
  const restoredPipeline = bootPrefillFor(
    stored[lpKey],
    store.selectedCollection.value,
    !!store.pendingPipelineLoad.value,
  );
```

(No other lines in `initMdh` change.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/mdh-last-pipeline.test.js`
Expected: PASS.

- [ ] **Step 6: Full verification**

Run: `npm test`
Expected: full suite green (report numbers).
Run: `npm run build`
Expected: clean; `dist/console/console.js` exists.

- [ ] **Step 7: Checkpoint** — green + build clean. Do not commit.

---

## Self-review notes (author)

- **Spec coverage:** org-id retrieval → Task 2; `orgId` signal + `scopeSuffix` (+ domain fallback) → Task 1; scope `savedQueries`/`queryHistory` + drop sync merge → Task 3; scope `mdhLastPipeline` + resolve org-id before the scoped read in `initMdh` → Task 4; "start fresh / no migration" → inherent (new keys, old keys untouched, no read of them); testing → each task; group-admin edge → no code (documented in spec).
- **Type/name consistency:** `orgId` (signal), `scopeSuffix()`, `getOrgId()`, `lastPipelineKey()` used identically across store/api/QueryHistory/lastPipeline/index and all tests. Scoped key format `"<baseKey>::<scopeSuffix>"` consistent (`savedQueries::org:1`, `queryHistory::org:1`, `mdhLastPipeline::org:7`, `…::domain:<origin>`).
- **No placeholders:** every code/test step is complete; commands have expected results.
