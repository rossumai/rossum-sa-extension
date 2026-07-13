# Fabry Architect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Chat/Architect mode switch inside the Mr. Fabry Console app; Architect keeps a per-org list of natural-language SOW requirements in a Data Storage system collection and runs a read-only Mr. Fabry check of each against the live org.

**Architecture:** A new `fabryMode` signal ('chat'|'architect') swaps the `.fabry-main` pane and the sidebar body; Chat mode is byte-identical. Architect adds `src/fabry/architect/` — pure `check.js` (prompt + verdict parse) and `run.js` (concurrency-limited orchestration, transport injected, mirroring `deepLoop.js`), a `store.js` of signals, an `api.js` binding `src/mdh/api.js` to the `__mrfabry_architect` collection, and an impure `actions.js` glue (mirroring `chat.js`). Three components render the list. Run creates one fresh cautious-primed agent chat per requirement and parses `VERDICT: PASS|FAIL|UNCERTAIN`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, JSX `h`/`Fragment`), vitest + jsdom. Reuses `src/agent/agentApi.js` + `src/agent/agentStream.js` (already initialized at Console boot) and `src/mdh/api.js` (Data Storage client, already initialized at Console boot).

## Global Constraints

- **Read-only Run.** The per-requirement check MUST stay strictly read-only against the org: cautious persona prime (`/persona cautious`) + read-only prompt framing. The agent's server-side default is read-only (`agentApi.createChat` sends no `mcp_mode`); do not change that.
- **Architect's ONLY writes** are to the `__mrfabry_architect` Data Storage collection (its own requirement documents). Never write to any other collection or org resource.
- **Collection name is a single cosmetic constant** `COLLECTION = '__mrfabry_architect'` in `src/fabry/architect/api.js`. No code parses or gates on the `__` prefix. It must be swappable to an unprefixed name with no other change.
- **No new gate.** Architect lives inside the existing `experimentalUnlocked`-gated Fabry app. Add no new storage-key gate.
- **Chat mode is byte-identical.** The mode switch only swaps the main pane + sidebar body. Do not alter existing Chat markup, behavior, or `chat.js`.
- **`fabryMode` is per-tab and content-free** — stored via `src/console/tabState.js` like `fabryActiveChat`. No requirement text, evidence, or org data is persisted in the browser.
- **JSX unicode:** `\uXXXX` does NOT work in JSX raw text or attribute values. Use a JS-expression string (`{'→'}`), the literal glyph, or an HTML entity. In `title=`, wrap the whole value in an expression/template literal.
- **Tests are `.test.js`** using `h(Component, props)` (never raw JSX in tests — oxc breaks). `flush = () => new Promise((r) => setTimeout(r, 0))`. Component test files that rely on `useEffect` firing must set an immediate rAF polyfill (`globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; }`) because `tests/setup.js`'s polyfill is a no-op.
- **Rebuild dist after UI changes** (`npm run build`) — tests run `src/` but the loaded extension runs `dist/`.
- **Do NOT git commit during implementation.** The whole run lands as ONE commit at the end, only when the owner asks. No per-task commits, no branches, no Co-Authored-By trailer. Each task ends by staging its files and running its tests green; the subagent-driven controller reviews via tree-snapshot diffs.

---

### Task 1: `fabryMode` signal + per-tab persistence

**Files:**
- Modify: `src/fabry/store.js` (add signal + setter near the composer-context block, ~line 25)
- Modify: `src/console/tabState.js:18-25` (add `'fabryMode'` to `TAB_SCOPED_KEYS`)
- Modify: `src/fabry/index.jsx` (read stored mode on init; persist via effect)
- Test: `tests/fabry-mode.test.js`

**Interfaces:**
- Produces: `store.fabryMode` (signal, `'chat'` default), `store.setFabryMode(m)` — sets `'architect'` iff `m === 'architect'`, else `'chat'`. `TAB_SCOPED_KEYS` includes `'fabryMode'`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-mode.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/store.js';
import { TAB_SCOPED_KEYS } from '../src/console/tabState.js';

beforeEach(() => { store.fabryMode.value = 'chat'; });

describe('fabryMode', () => {
  it('defaults to chat', () => {
    expect(store.fabryMode.value).toBe('chat');
  });
  it('setFabryMode accepts architect and coerces anything else to chat', () => {
    store.setFabryMode('architect');
    expect(store.fabryMode.value).toBe('architect');
    store.setFabryMode('nonsense');
    expect(store.fabryMode.value).toBe('chat');
    store.setFabryMode('architect');
    store.setFabryMode('chat');
    expect(store.fabryMode.value).toBe('chat');
  });
  it('is a per-tab navigation key', () => {
    expect(TAB_SCOPED_KEYS).toContain('fabryMode');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-mode.test.js`
Expected: FAIL — `store.fabryMode` is undefined; `TAB_SCOPED_KEYS` lacks `'fabryMode'`.

- [ ] **Step 3: Add the signal + setter to `src/fabry/store.js`**

Insert after the composer-context block (after the `personaChoice` signal, ~line 24):

```js
// Fabry sub-app mode: 'chat' (existing chat app) | 'architect' (SOW checks).
// Per-tab navigation state (persisted via tabState in index.jsx), content-free.
export const fabryMode = signal('chat');
export function setFabryMode(m) {
  fabryMode.value = m === 'architect' ? 'architect' : 'chat';
}
```

- [ ] **Step 4: Add `'fabryMode'` to `TAB_SCOPED_KEYS` in `src/console/tabState.js`**

Change the array (currently lines 18-25) to include `'fabryMode'` right after `'fabryActiveChat'`:

```js
export const TAB_SCOPED_KEYS = [
  'consoleActiveApp',
  'fabryActiveChat',
  'fabryMode',
  'mdhActiveView',
  'mdhSelectedCollection',
  'mdhActivePanel',
  'mdhOpsSearch',
];
```

- [ ] **Step 5: Wire read + persist in `src/fabry/index.jsx`**

Add the import at the top (extend the existing tabState import):

```js
import { resolveTabState, writeTabState } from '../console/tabState.js';
```

(already present — no change if so.)

In `initFabry`, inside the existing `try` that hydrates sidebar prefs OR right after it, restore the mode (session-first, local seed). Add after the sidebar-pref `try/catch` block (~line 15):

```js
  try {
    const modePref = await chrome.storage.local.get(['fabryMode']);
    const savedMode = resolveTabState(['fabryMode'], modePref).fabryMode;
    if (savedMode === 'architect') store.fabryMode.value = 'architect';
  } catch { /* mode restore is best-effort */ }
```

In the `if (!wired)` block, add a persist effect next to the existing ones:

```js
    effect(() => { writeTabState('fabryMode', store.fabryMode.value); });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/fabry-mode.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Stage (do not commit)**

Run: `git add src/fabry/store.js src/console/tabState.js src/fabry/index.jsx tests/fabry-mode.test.js`

---

### Task 2: `check.js` — pure prompt + verdict parser

**Files:**
- Create: `src/fabry/architect/check.js`
- Test: `tests/fabry-architect-check.test.js`

**Interfaces:**
- Produces:
  - `buildCheckPrompt(requirement: string) → string` — read-only framing + `VERDICT: PASS|FAIL|UNCERTAIN` first-line contract + the requirement text.
  - `parseCheckVerdict(text: string) → { verdict: 'pass'|'fail'|'uncertain', evidence: string }` — first `VERDICT:` line anywhere (case-insensitive, multiline); anything unrecognized → `'uncertain'`; `evidence` is the full trimmed reply.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-check.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildCheckPrompt, parseCheckVerdict } from '../src/fabry/architect/check.js';

describe('buildCheckPrompt', () => {
  it('includes read-only framing, the verdict contract, and the requirement', () => {
    const p = buildCheckPrompt('Every invoice queue must have a duplicate-detection hook.');
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/VERDICT: PASS/);
    expect(p).toMatch(/VERDICT: FAIL/);
    expect(p).toMatch(/VERDICT: UNCERTAIN/);
    expect(p).toContain('Every invoice queue must have a duplicate-detection hook.');
  });
});

describe('parseCheckVerdict', () => {
  it('parses a first-line PASS', () => {
    const r = parseCheckVerdict('VERDICT: PASS\nAll three queues have the hook.');
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toContain('All three queues');
  });
  it('parses FAIL and UNCERTAIN case-insensitively', () => {
    expect(parseCheckVerdict('verdict: fail\n- missing on Q2').verdict).toBe('fail');
    expect(parseCheckVerdict('Verdict: Uncertain\ncould not read logs').verdict).toBe('uncertain');
  });
  it('finds a verdict line that is not the first line', () => {
    expect(parseCheckVerdict('Let me check...\nVERDICT: PASS\ndone').verdict).toBe('pass');
  });
  it('defaults to uncertain when no verdict line is present', () => {
    const r = parseCheckVerdict('I looked but the answer is unclear.');
    expect(r.verdict).toBe('uncertain');
    expect(r.evidence).toBe('I looked but the answer is unclear.');
  });
  it('tolerates null/undefined', () => {
    expect(parseCheckVerdict(undefined).verdict).toBe('uncertain');
    expect(parseCheckVerdict(null).evidence).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-check.test.js`
Expected: FAIL — module `src/fabry/architect/check.js` not found.

- [ ] **Step 3: Implement `src/fabry/architect/check.js`**

```js
// Pure prompt builder + verdict parser for an Architect requirement check.
// One requirement → one read-only agent check → VERDICT: PASS|FAIL|UNCERTAIN.
// Mirrors deepLoop.parseVerdict, extended with UNCERTAIN. No network, no DOM.

export function buildCheckPrompt(requirement) {
  return [
    'You are auditing a Rossum organization against a single requirement from a Statement of Work (SOW).',
    'Using YOUR TOOLS, inspect the live organization (queues, schemas, extensions/hooks, rules, engines, settings) and determine whether this requirement is correctly implemented. Stay strictly READ-ONLY — never create, update, or delete anything.',
    'Reply with a FIRST LINE that is exactly one of:',
    '  VERDICT: PASS       (the requirement is met)',
    '  VERDICT: FAIL       (the requirement is not met)',
    '  VERDICT: UNCERTAIN  (you could not determine it)',
    'After the verdict line, explain your finding with concrete evidence — cite the specific queues, fields, hooks, or rules you inspected. Be concise.',
    '',
    `REQUIREMENT:\n${requirement}`,
  ].join('\n');
}

export function parseCheckVerdict(text) {
  const s = String(text ?? '');
  const m = s.match(/^\s*verdict:\s*(pass|fail|uncertain)\b/im);
  const verdict = m ? m[1].toLowerCase() : 'uncertain';
  return { verdict, evidence: s.trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-check.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Stage (do not commit)**

Run: `git add src/fabry/architect/check.js tests/fabry-architect-check.test.js`

---

### Task 3: `run.js` — concurrency-limited, abort-aware orchestration (pure)

**Files:**
- Create: `src/fabry/architect/run.js`
- Test: `tests/fabry-architect-run.test.js`

**Interfaces:**
- Consumes: nothing (transport injected).
- Produces: `runChecks(reqs, { runOne, onResult, concurrency = 3, signal }) → Promise<Array>` where `reqs` is `{id, text, order}[]`, `runOne(req) → Promise<result|null>` (null = aborted/stale mid-run), `onResult(reqId, result)` fires as each completes. A `runOne` throw becomes `{ verdict: 'uncertain', evidence: 'Check could not complete: …', chatId: null, error: true }` (never blocks siblings). Aborts before launching more when `signal.aborted`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-run.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runChecks } from '../src/fabry/architect/run.js';

const reqs = (n) => Array.from({ length: n }, (_, i) => ({ id: 'r' + i, text: 'req ' + i, order: i }));

describe('runChecks', () => {
  it('runs every requirement and streams results via onResult', async () => {
    const seen = {};
    const out = await runChecks(reqs(3), {
      runOne: async (req) => ({ verdict: 'pass', evidence: 'ok ' + req.id, chatId: 'c_' + req.id }),
      onResult: (id, r) => { seen[id] = r.verdict; },
    });
    expect(out.map((r) => r.verdict)).toEqual(['pass', 'pass', 'pass']);
    expect(seen).toEqual({ r0: 'pass', r1: 'pass', r2: 'pass' });
  });

  it('turns a runOne throw into an uncertain result and keeps going', async () => {
    const out = await runChecks(reqs(3), {
      runOne: async (req) => { if (req.id === 'r1') throw new Error('boom'); return { verdict: 'fail', evidence: 'x', chatId: 'c' }; },
      onResult: () => {},
    });
    expect(out[0].verdict).toBe('fail');
    expect(out[1].verdict).toBe('uncertain');
    expect(out[1].error).toBe(true);
    expect(out[1].evidence).toMatch(/could not complete/i);
    expect(out[2].verdict).toBe('fail');
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0, max = 0;
    await runChecks(reqs(8), {
      concurrency: 3,
      runOne: async () => {
        inFlight += 1; max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { verdict: 'pass', evidence: '', chatId: 'c' };
      },
      onResult: () => {},
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
  });

  it('stops launching new checks once the signal aborts', async () => {
    const ctrl = new AbortController();
    const calls = [];
    const p = runChecks(reqs(6), {
      concurrency: 2,
      signal: ctrl.signal,
      runOne: async (req) => { calls.push(req.id); if (req.id === 'r1') ctrl.abort(); await new Promise((r) => setTimeout(r, 1)); return { verdict: 'pass', evidence: '', chatId: 'c' }; },
      onResult: () => {},
    });
    await p;
    expect(calls.length).toBeLessThan(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-run.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fabry/architect/run.js`**

```js
// Concurrency-limited, abort-aware runner for Architect requirement checks.
// Pure: transport arrives injected (runOne), results stream out via onResult —
// the deepLoop.js precedent. A runOne throw is isolated to that requirement.

export async function runChecks(reqs, { runOne, onResult, concurrency = 3, signal } = {}) {
  const results = new Array(reqs.length).fill(null);
  let next = 0;

  async function worker() {
    for (;;) {
      if (signal && signal.aborted) return;
      const i = next;
      next += 1;
      if (i >= reqs.length) return;
      const req = reqs[i];
      let result;
      try {
        result = await runOne(req);
      } catch (err) {
        result = { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null, error: true };
      }
      if (signal && signal.aborted) return;
      if (result == null) return; // aborted/stale mid-runOne
      results[i] = result;
      if (onResult) onResult(req.id, result);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, reqs.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-run.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Stage (do not commit)**

Run: `git add src/fabry/architect/run.js tests/fabry-architect-run.test.js`

---

### Task 4: `store.js` — Architect signals

**Files:**
- Create: `src/fabry/architect/store.js`
- Test: `tests/fabry-architect-store.test.js`

**Interfaces:**
- Produces: signals `requirements` (`{id,text,order}[]`), `loaded` (bool), `loadError` (string|null), `running` (bool), `results` (`{ [id]: Result }`); `Result = { verdict: 'pass'|'fail'|'uncertain'|null, evidence: string, chatId: string|null, running?: boolean, error?: boolean }`. Helpers `setResult(id, result)`, `clearResults()`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-store.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/architect/store.js';

beforeEach(() => { store.results.value = {}; store.requirements.value = []; });

describe('architect store', () => {
  it('has sane defaults', () => {
    expect(store.requirements.value).toEqual([]);
    expect(store.loaded.value).toBe(false);
    expect(store.running.value).toBe(false);
    expect(store.results.value).toEqual({});
  });
  it('setResult merges immutably by id', () => {
    store.setResult('r1', { verdict: 'pass', evidence: 'a', chatId: 'c1' });
    const first = store.results.value;
    store.setResult('r2', { verdict: 'fail', evidence: 'b', chatId: 'c2' });
    expect(Object.keys(store.results.value).sort()).toEqual(['r1', 'r2']);
    expect(store.results.value).not.toBe(first); // new object each set
  });
  it('clearResults empties the map', () => {
    store.setResult('r1', { verdict: 'pass', evidence: '', chatId: 'c' });
    store.clearResults();
    expect(store.results.value).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fabry/architect/store.js`**

```js
import { signal } from '@preact/signals';

// Architect state. Requirements live server-side (Data Storage); results live
// in memory only. Nothing here is persisted in the browser.
export const requirements = signal([]); // {id, text, order}[]
export const loaded = signal(false);
export const loadError = signal(null);
export const running = signal(false);
export const results = signal({}); // { [reqId]: Result }

export function setResult(id, result) {
  results.value = { ...results.value, [id]: result };
}
export function clearResults() {
  results.value = {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-store.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Stage (do not commit)**

Run: `git add src/fabry/architect/store.js tests/fabry-architect-store.test.js`

---

### Task 5: `api.js` — Data Storage wrapper for the system collection

**Files:**
- Create: `src/fabry/architect/api.js`
- Test: `tests/fabry-architect-api.test.js`

**Interfaces:**
- Consumes: `src/mdh/api.js` — `createCollection(name)`, `find(name, {query, sort, limit})` → `{result: docs[]}`, `insertOne(name, doc)`, `updateOne(name, filter, update)`, `deleteOne(name, filter)`.
- Produces:
  - `COLLECTION` = `'__mrfabry_architect'` (exported constant).
  - `ensureCollection() → Promise<void>` — idempotent create; swallows non-401 errors (already-exists), rethrows 401.
  - `loadRequirements() → Promise<{id,text,order}[]>` — `find({kind:'requirement'})` sorted by `order`, mapped from `_id`→`id`.
  - `addRequirement({id, text, order, createdAt}) → Promise` — `insertOne` of `{_id:id, kind:'requirement', text, order, createdAt}`.
  - `updateRequirement(id, text) → Promise` — `updateOne({_id:id}, {$set:{text}})`.
  - `deleteRequirement(id) → Promise` — `deleteOne({_id:id})`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({
  createCollection: vi.fn().mockResolvedValue({}),
  find: vi.fn(),
  insertOne: vi.fn().mockResolvedValue({}),
  updateOne: vi.fn().mockResolvedValue({}),
  deleteOne: vi.fn().mockResolvedValue({}),
}));

import * as mdh from '../src/mdh/api.js';
import * as api from '../src/fabry/architect/api.js';

beforeEach(() => vi.clearAllMocks());

describe('architect api', () => {
  it('uses the __mrfabry_architect system collection', () => {
    expect(api.COLLECTION).toBe('__mrfabry_architect');
  });

  it('ensureCollection tolerates an already-exists error but rethrows 401', async () => {
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 400 }));
    await expect(api.ensureCollection()).resolves.toBeUndefined();
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 }));
    await expect(api.ensureCollection()).rejects.toMatchObject({ status: 401 });
  });

  it('loadRequirements queries kind=requirement sorted by order and maps _id→id', async () => {
    mdh.find.mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: 'first', order: 1 },
      { _id: 'b', kind: 'requirement', text: 'second', order: 2 },
    ] });
    const reqs = await api.loadRequirements();
    expect(mdh.find).toHaveBeenCalledWith('__mrfabry_architect', { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
    expect(reqs).toEqual([{ id: 'a', text: 'first', order: 1 }, { id: 'b', text: 'second', order: 2 }]);
  });

  it('loadRequirements returns [] when result is missing', async () => {
    mdh.find.mockResolvedValueOnce({});
    expect(await api.loadRequirements()).toEqual([]);
  });

  it('addRequirement inserts the documented shape', async () => {
    await api.addRequirement({ id: 'x', text: 'do the thing', order: 3, createdAt: 111 });
    expect(mdh.insertOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x', kind: 'requirement', text: 'do the thing', order: 3, createdAt: 111 });
  });

  it('updateRequirement $sets text by _id', async () => {
    await api.updateRequirement('x', 'new text');
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { text: 'new text' } });
  });

  it('deleteRequirement deletes by _id', async () => {
    await api.deleteRequirement('x');
    expect(mdh.deleteOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-api.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fabry/architect/api.js`**

```js
// Data Storage wrapper bound to the Architect system collection. The collection
// name is a single COSMETIC constant — no code parses the `__` prefix, so it is
// swappable to an unprefixed name with no other change (see spec §7).
import * as mdh from '../../mdh/api.js';

export const COLLECTION = '__mrfabry_architect';

// Idempotent: creating an existing collection is a benign error we ignore; only
// an auth failure (401) is worth surfacing.
export async function ensureCollection() {
  try {
    await mdh.createCollection(COLLECTION);
  } catch (err) {
    if (err?.status === 401) throw err;
    // already-exists / other benign create error → ignore
  }
}

export async function loadRequirements() {
  const res = await mdh.find(COLLECTION, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  const docs = (res && res.result) || [];
  return docs.map((d) => ({ id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0 }));
}

export function addRequirement({ id, text, order, createdAt }) {
  return mdh.insertOne(COLLECTION, { _id: id, kind: 'requirement', text, order, createdAt });
}

export function updateRequirement(id, text) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { text } });
}

export function deleteRequirement(id) {
  return mdh.deleteOne(COLLECTION, { _id: id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-api.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Stage (do not commit)**

Run: `git add src/fabry/architect/api.js tests/fabry-architect-api.test.js`

---

### Task 6: `actions.js` — impure glue (load/edit + Run)

**Files:**
- Create: `src/fabry/architect/actions.js`
- Test: `tests/fabry-architect-actions.test.js`

**Interfaces:**
- Consumes: `agentApi.createChat()`, `agentApi.streamMessage(chatId, content, {signal, onEvent})`; `agentStream` `newAcc`/`foldEvents`/`replyText`; `check.buildCheckPrompt`/`parseCheckVerdict`; `run.runChecks`; `architect/api.js`; `architect/store.js`.
- Produces:
  - `loadArchitect() → Promise<void>` — `ensureCollection` + `loadRequirements` → sets `store.requirements`/`store.loaded`; on error sets `store.loadError` (never throws). No-ops if already loaded.
  - `addRequirement(text) → Promise<void>` — optimistic append (client-generated id, `order = max+1`); rolls back on failure.
  - `updateRequirement(id, text) → Promise<void>` — optimistic edit; no-op if unchanged/empty-unchanged.
  - `deleteRequirement(id) → Promise<void>` — optimistic remove + drop its result.
  - `runAll() → Promise<void>` — marks all `results` running, runs `runChecks` (concurrency 3) with an internal `runOne`, streams results; clears spinners on abort; no-op if already running or empty.
  - `reRun(id) → Promise<void>` — single-requirement re-check.
  - `stopRun()` — aborts an in-flight `runAll`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-actions.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/agentApi.js', () => ({
  createChat: vi.fn(),
  streamMessage: vi.fn(),
}));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '__mrfabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  loadRequirements: vi.fn().mockResolvedValue([]),
  addRequirement: vi.fn().mockResolvedValue({}),
  updateRequirement: vi.fn().mockResolvedValue({}),
  deleteRequirement: vi.fn().mockResolvedValue({}),
}));

import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import { loadArchitect, addRequirement, updateRequirement, deleteRequirement, runAll } from '../src/fabry/architect/actions.js';

// A createChat that returns a fresh id each call, and a streamMessage that emits
// a scripted reply keyed on the PROMPT content (2nd call per check is the real one;
// the 1st is the /persona prime).
function scriptReplies(map) {
  let n = 0;
  agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
  agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
    if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
    // content is the check prompt; find which requirement text it embeds
    const key = Object.keys(map).find((k) => content.includes(k)) || '';
    onEvent({ type: 'text-delta', delta: map[key] || 'VERDICT: UNCERTAIN' });
    onEvent({ type: 'finish' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.requirements.value = []; store.results.value = {};
  store.loaded.value = false; store.loadError.value = null; store.running.value = false;
});

describe('loadArchitect', () => {
  it('ensures the collection and loads requirements', async () => {
    api.loadRequirements.mockResolvedValueOnce([{ id: 'a', text: 'x', order: 1 }]);
    await loadArchitect();
    expect(api.ensureCollection).toHaveBeenCalled();
    expect(store.requirements.value).toEqual([{ id: 'a', text: 'x', order: 1 }]);
    expect(store.loaded.value).toBe(true);
  });
  it('records loadError without throwing', async () => {
    api.ensureCollection.mockRejectedValueOnce(new Error('nope'));
    await loadArchitect();
    expect(store.loadError.value).toMatch(/nope/);
    expect(store.loaded.value).toBe(false);
  });
});

describe('add/update/delete', () => {
  it('addRequirement appends with order max+1 and persists', async () => {
    store.requirements.value = [{ id: 'a', text: 'x', order: 5 }];
    await addRequirement('  new one  ');
    expect(store.requirements.value.length).toBe(2);
    const added = store.requirements.value[1];
    expect(added.text).toBe('new one');
    expect(added.order).toBe(6);
    expect(api.addRequirement).toHaveBeenCalledWith(expect.objectContaining({ id: added.id, text: 'new one', order: 6 }));
  });
  it('addRequirement ignores blank input', async () => {
    await addRequirement('   ');
    expect(store.requirements.value.length).toBe(0);
    expect(api.addRequirement).not.toHaveBeenCalled();
  });
  it('addRequirement rolls back on failure', async () => {
    api.addRequirement.mockRejectedValueOnce(new Error('fail'));
    await addRequirement('x');
    expect(store.requirements.value.length).toBe(0);
    expect(store.loadError.value).toMatch(/fail|save/i);
  });
  it('updateRequirement edits in place and persists', async () => {
    store.requirements.value = [{ id: 'a', text: 'old', order: 1 }];
    await updateRequirement('a', 'new');
    expect(store.requirements.value[0].text).toBe('new');
    expect(api.updateRequirement).toHaveBeenCalledWith('a', 'new');
  });
  it('updateRequirement no-ops when unchanged', async () => {
    store.requirements.value = [{ id: 'a', text: 'same', order: 1 }];
    await updateRequirement('a', 'same');
    expect(api.updateRequirement).not.toHaveBeenCalled();
  });
  it('deleteRequirement removes the row and its result', async () => {
    store.requirements.value = [{ id: 'a', text: 'x', order: 1 }];
    store.setResult('a', { verdict: 'pass', evidence: '', chatId: 'c' });
    await deleteRequirement('a');
    expect(store.requirements.value).toEqual([]);
    expect(store.results.value.a).toBeUndefined();
    expect(api.deleteRequirement).toHaveBeenCalledWith('a');
  });
});

describe('runAll', () => {
  it('checks each requirement in its own chat and records verdicts', async () => {
    store.requirements.value = [
      { id: 'a', text: 'ALPHA req', order: 1 },
      { id: 'b', text: 'BETA req', order: 2 },
    ];
    scriptReplies({ 'ALPHA req': 'VERDICT: PASS\ngood', 'BETA req': 'VERDICT: FAIL\n- bad' });
    await runAll();
    expect(store.results.value.a.verdict).toBe('pass');
    expect(store.results.value.b.verdict).toBe('fail');
    expect(store.results.value.a.chatId).toBe('chat_0');
    expect(store.running.value).toBe(false);
    // one prime + one check per requirement
    expect(agentApi.streamMessage).toHaveBeenCalledTimes(4);
  });
  it('no-ops on an empty list', async () => {
    await runAll();
    expect(agentApi.createChat).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-actions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fabry/architect/actions.js`**

```js
// Impure glue for Architect: binds the store to Data Storage (api.js) and the
// agent transport (agentApi + agentStream). Mirrors chat.js. Run creates one
// fresh cautious-primed chat per requirement — no shared context, read-only.
import * as agentApi from '../../agent/agentApi.js';
import { newAcc, foldEvents, replyText } from '../../agent/agentStream.js';
import * as api from './api.js';
import * as check from './check.js';
import { runChecks } from './run.js';
import * as store from './store.js';

let controller = null;

function newId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return 'r' + Date.now() + Math.random().toString(36).slice(2, 8);
}

export async function loadArchitect() {
  if (store.loaded.value) return;
  store.loadError.value = null;
  try {
    await api.ensureCollection();
    store.requirements.value = await api.loadRequirements();
    store.loaded.value = true;
  } catch (err) {
    store.loadError.value = err?.message || 'Could not load requirements.';
  }
}

export async function addRequirement(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const order = store.requirements.value.reduce((m, r) => Math.max(m, r.order || 0), 0) + 1;
  const req = { id: newId(), text: t, order };
  store.requirements.value = [...store.requirements.value, req];
  try {
    await api.addRequirement({ id: req.id, text: t, order, createdAt: Date.now() });
  } catch (err) {
    store.requirements.value = store.requirements.value.filter((r) => r.id !== req.id);
    store.loadError.value = err?.message || 'Could not save requirement.';
  }
}

export async function updateRequirement(id, text) {
  const t = String(text || '').trim();
  const prev = store.requirements.value.find((r) => r.id === id);
  if (!prev || prev.text === t || !t) return;
  store.requirements.value = store.requirements.value.map((r) => (r.id === id ? { ...r, text: t } : r));
  try {
    await api.updateRequirement(id, t);
  } catch (err) {
    store.loadError.value = err?.message || 'Could not save edit.';
  }
}

export async function deleteRequirement(id) {
  store.requirements.value = store.requirements.value.filter((r) => r.id !== id);
  const rest = { ...store.results.value };
  delete rest[id];
  store.results.value = rest;
  try {
    await api.deleteRequirement(id);
  } catch (err) {
    store.loadError.value = err?.message || 'Could not delete.';
  }
}

// One requirement → a fresh cautious chat → the check prompt → verdict.
async function runOne(req, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const fold = async (content) => {
    const acc = newAcc();
    await agentApi.streamMessage(chatId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
    return replyText(acc);
  };
  await fold('/persona cautious');
  if (signal?.aborted) return null;
  const text = await fold(check.buildCheckPrompt(req.text));
  if (signal?.aborted) return null;
  const { verdict, evidence } = check.parseCheckVerdict(text);
  return { verdict, evidence, chatId };
}

export async function runAll() {
  if (store.running.value) return;
  const reqs = store.requirements.value;
  if (!reqs.length) return;
  controller = new AbortController();
  const signal = controller.signal;
  store.running.value = true;
  const pending = {};
  for (const r of reqs) pending[r.id] = { verdict: null, evidence: '', chatId: null, running: true };
  store.results.value = pending;
  try {
    await runChecks(reqs, {
      concurrency: 3,
      signal,
      runOne: (req) => runOne(req, signal),
      onResult: (id, result) => store.setResult(id, result),
    });
  } finally {
    // Any rows still spinning (aborted mid-run) → stop their spinner.
    const cleaned = {};
    for (const [k, v] of Object.entries(store.results.value)) cleaned[k] = v?.running ? { ...v, running: false } : v;
    store.results.value = cleaned;
    store.running.value = false;
    controller = null;
  }
}

export async function reRun(id) {
  const req = store.requirements.value.find((r) => r.id === id);
  if (!req) return;
  const ctrl = new AbortController();
  store.setResult(id, { verdict: null, evidence: '', chatId: null, running: true });
  try {
    const result = await runOne(req, ctrl.signal);
    store.setResult(id, result || { verdict: 'uncertain', evidence: 'Check was cancelled.', chatId: null, error: true });
  } catch (err) {
    store.setResult(id, { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null, error: true });
  }
}

export function stopRun() {
  if (controller) controller.abort();
  controller = null;
  store.running.value = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-actions.test.js`
Expected: PASS (all cases). If `crypto.randomUUID` is unavailable under jsdom, the fallback id path is used — the tests assert on the id via `store.requirements.value[1].id`, not a literal.

- [ ] **Step 5: Stage (do not commit)**

Run: `git add src/fabry/architect/actions.js tests/fabry-architect-actions.test.js`

---

### Task 7: Components — RequirementRow, RequirementAdd, ArchitectApp + Architect pane CSS

**Files:**
- Create: `src/fabry/architect/components/RequirementRow.jsx`
- Create: `src/fabry/architect/components/RequirementAdd.jsx`
- Create: `src/fabry/architect/components/ArchitectApp.jsx`
- Modify: `src/console/console.css` (append `.fabry-arch-*` rules)
- Test: `tests/fabry-architect-app.test.js`

**Interfaces:**
- Consumes: `architect/store.js` signals; `actions.js` (`loadArchitect`, `addRequirement`, `updateRequirement`, `deleteRequirement`, `runAll`, `stopRun`, `reRun`); `src/ui/fabry/FabryMarkdown.jsx` (default export `FabryMarkdown({text, streaming})`); the fabry `store.setFabryMode` + `chat.openChat` for the "view investigation" link.
- Produces: `ArchitectApp` (default export) — the Architect main pane.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-app.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};

vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  addRequirement: vi.fn(), updateRequirement: vi.fn(), deleteRequirement: vi.fn(),
  runAll: vi.fn(), stopRun: vi.fn(), reRun: vi.fn(),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));

import * as actions from '../src/fabry/architect/actions.js';
import * as astore from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import * as chat from '../src/fabry/chat.js';
import ArchitectApp from '../src/fabry/architect/components/ArchitectApp.jsx';

const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(ArchitectApp, null), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  astore.requirements.value = []; astore.results.value = {};
  astore.loaded.value = true; astore.loadError.value = null; astore.running.value = false;
  fstore.fabryMode.value = 'architect';
});

describe('ArchitectApp', () => {
  it('loads on mount', async () => {
    mount(); await flush();
    expect(actions.loadArchitect).toHaveBeenCalled();
  });
  it('shows the empty state when there are no requirements', () => {
    const root = mount();
    expect(root.querySelector('.fabry-arch-empty')).toBeTruthy();
  });
  it('renders a row per requirement and a Run button', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }, { id: 'b', text: 'req B', order: 2 }];
    const root = mount();
    expect(root.querySelectorAll('.fabry-arch-row').length).toBe(2);
    expect(root.querySelector('.fabry-arch-run')).toBeTruthy();
  });
  it('Run button calls runAll; disabled with no requirements', () => {
    const root = mount();
    expect(root.querySelector('.fabry-arch-run').disabled).toBe(true);
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    const root2 = mount();
    const btn = root2.querySelector('.fabry-arch-run');
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(actions.runAll).toHaveBeenCalled();
  });
  it('while running the button shows Stop and calls stopRun', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    astore.running.value = true;
    const root = mount();
    const btn = root.querySelector('.fabry-arch-run');
    expect(btn.textContent).toMatch(/stop/i);
    btn.click();
    expect(actions.stopRun).toHaveBeenCalled();
  });
  it('renders verdict chips from results', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    astore.results.value = { a: { verdict: 'pass', evidence: 'all good', chatId: 'c1' } };
    const root = mount();
    const chip = root.querySelector('.fabry-arch-chip');
    expect(chip.className).toMatch(/pass/);
    expect(chip.textContent).toMatch(/met/i);
  });
  it('expanding a checked row shows evidence and a view-investigation link that switches to chat', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    astore.results.value = { a: { verdict: 'fail', evidence: 'missing hook', chatId: 'c1' } };
    const root = mount();
    root.querySelector('.fabry-arch-chip').click();
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/missing hook/);
    root.querySelector('.fabry-arch-viewchat').click();
    expect(fstore.fabryMode.value).toBe('chat');
    expect(chat.openChat).toHaveBeenCalledWith('c1');
  });
  it('delete button calls deleteRequirement', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    const root = mount();
    root.querySelector('.fabry-arch-del').click();
    expect(actions.deleteRequirement).toHaveBeenCalledWith('a');
  });
  it('editing a row and blurring calls updateRequirement', () => {
    astore.requirements.value = [{ id: 'a', text: 'req A', order: 1 }];
    const root = mount();
    const ta = root.querySelector('.fabry-arch-text');
    ta.value = 'req A edited';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    expect(actions.updateRequirement).toHaveBeenCalledWith('a', 'req A edited');
  });
  it('the add row adds a requirement on Enter', () => {
    const root = mount();
    const input = root.querySelector('.fabry-arch-add-input');
    input.value = 'a brand new requirement';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.addRequirement).toHaveBeenCalledWith('a brand new requirement');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-app.test.js`
Expected: FAIL — component modules not found.

- [ ] **Step 3: Implement `src/fabry/architect/components/RequirementRow.jsx`**

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import { openChat } from '../../chat.js';
import { updateRequirement, deleteRequirement, reRun } from '../actions.js';
import FabryMarkdown from '../../../ui/fabry/FabryMarkdown.jsx';

const CHIP = {
  pass: { cls: 'pass', label: '✓ Met' },
  fail: { cls: 'fail', label: '✗ Not met' },
  uncertain: { cls: 'uncertain', label: '? Uncertain' },
};

function StatusChip({ result, onToggle }) {
  if (!result) return null;
  if (result.running) return <span class="fabry-arch-chip running">{'Checking…'}</span>;
  const c = CHIP[result.verdict];
  if (!c) return null;
  return <button type="button" class={'fabry-arch-chip ' + c.cls} onClick={onToggle} title="Show evidence">{c.label}</button>;
}

export default function RequirementRow({ req }) {
  const result = store.results.value[req.id];
  const [text, setText] = useState(req.text);
  const [open, setOpen] = useState(false);

  function commit() {
    if (text !== req.text) updateRequirement(req.id, text);
  }
  function viewChat() {
    if (!result?.chatId) return;
    fstore.setFabryMode('chat');
    openChat(result.chatId);
  }

  return (
    <div class="fabry-arch-row">
      <div class="fabry-arch-rowmain">
        <textarea
          class="fabry-arch-text"
          value={text}
          rows={1}
          placeholder="Describe a requirement to check…"
          onInput={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
        />
        <StatusChip result={result} onToggle={() => setOpen((v) => !v)} />
        <button type="button" class="fabry-arch-del" title="Delete requirement" onClick={() => deleteRequirement(req.id)}>{'✕'}</button>
      </div>
      {open && result && !result.running && (
        <div class="fabry-arch-evidence">
          <FabryMarkdown text={result.evidence || '(no evidence returned)'} streaming={false} />
          <div class="fabry-arch-evidence-actions">
            {result.chatId && <button type="button" class="fabry-arch-viewchat" onClick={viewChat}>{'View investigation →'}</button>}
            <button type="button" class="fabry-arch-rerun" onClick={() => reRun(req.id)}>{'Re-run'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/fabry/architect/components/RequirementAdd.jsx`**

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { addRequirement } from '../actions.js';

export default function RequirementAdd() {
  const [text, setText] = useState('');
  function submit() {
    const t = text.trim();
    if (!t) return;
    addRequirement(t);
    setText('');
  }
  return (
    <div class="fabry-arch-add">
      <input
        class="fabry-arch-add-input"
        type="text"
        value={text}
        placeholder="＋ Add a requirement…"
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
      />
      <button type="button" class="fabry-arch-add-btn" onClick={submit} disabled={!text.trim()}>{'Add'}</button>
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/fabry/architect/components/ArchitectApp.jsx`**

```jsx
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect, runAll, stopRun } from '../actions.js';
import RequirementRow from './RequirementRow.jsx';
import RequirementAdd from './RequirementAdd.jsx';

function runCount() {
  const vals = Object.values(store.results.value);
  const done = vals.filter((r) => r && !r.running && r.verdict).length;
  return { done, total: store.requirements.value.length };
}

export default function ArchitectApp() {
  useEffect(() => { loadArchitect(); }, []);

  const reqs = store.requirements.value;
  const running = store.running.value;
  const { done, total } = runCount();

  return (
    <div class="fabry-arch">
      <header class="fabry-arch-header">
        <div class="fabry-arch-heading">
          <h2 class="fabry-arch-title">SOW requirements</h2>
          <p class="fabry-arch-sub">Checked read-only against this organization by Mr. Fabry.</p>
        </div>
        <button
          type="button"
          class="fabry-arch-run"
          disabled={!running && reqs.length === 0}
          onClick={() => (running ? stopRun() : runAll())}
        >
          {running ? `Stop (${done}/${total})` : `Run ▷`}
        </button>
      </header>

      {store.loadError.value && <div class="fabry-arch-error">{store.loadError.value}</div>}

      <div class="fabry-arch-list">
        {reqs.length === 0 && (
          <div class="fabry-arch-empty">
            No requirements yet. Add the customer{"’"}s SOW requirements below, then Run to check each one against the live organization.
          </div>
        )}
        {reqs.map((req) => <RequirementRow key={req.id} req={req} />)}
        <RequirementAdd />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Append Architect pane CSS to `src/console/console.css`**

Add at the end of the file (blue scheme, reuses existing tokens):

```css
/* ── Fabry Architect ──────────────────────────────────────────────────── */
.fabry-arch { display: flex; flex-direction: column; height: 100%; overflow-y: auto; padding: 20px 24px; }
.fabry-arch-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.fabry-arch-title { margin: 0; font-size: 18px; font-weight: 650; }
.fabry-arch-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
.fabry-arch-run { flex: none; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 8px 16px; font-weight: 600; cursor: pointer; }
.fabry-arch-run:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.fabry-arch-run:disabled { opacity: 0.5; cursor: default; }
.fabry-arch-error { background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }
.fabry-arch-list { display: flex; flex-direction: column; gap: 8px; max-width: 860px; }
.fabry-arch-empty { color: var(--text-secondary); border: 1px dashed var(--border); border-radius: 10px; padding: 18px; font-size: 13.5px; }
.fabry-arch-row { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); }
.fabry-arch-rowmain { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; }
.fabry-arch-text { flex: 1; border: none; background: none; resize: none; font: inherit; color: var(--text-primary); line-height: 1.45; padding: 4px 2px; min-height: 24px; overflow: hidden; }
.fabry-arch-text:focus { outline: none; }
.fabry-arch-chip { flex: none; border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600; cursor: pointer; background: var(--bg-hover); }
.fabry-arch-chip.pass { background: var(--success-bg); color: var(--success-fg); border-color: var(--success); }
.fabry-arch-chip.fail { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger); }
.fabry-arch-chip.uncertain { background: var(--warning-bg); color: var(--warning); border-color: var(--warning); }
.fabry-arch-chip.running { cursor: default; color: var(--text-secondary); }
.fabry-arch-del { flex: none; border: none; background: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; padding: 4px 6px; border-radius: 6px; }
.fabry-arch-del:hover { background: var(--danger-bg); color: var(--danger-fg); }
.fabry-arch-evidence { border-top: 1px solid var(--border); padding: 10px 12px; font-size: 13px; }
.fabry-arch-evidence-actions { display: flex; gap: 12px; margin-top: 8px; }
.fabry-arch-viewchat, .fabry-arch-rerun { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 12.5px; font-weight: 600; padding: 0; }
.fabry-arch-viewchat:hover, .fabry-arch-rerun:hover { text-decoration: underline; }
.fabry-arch-add { display: flex; gap: 8px; margin-top: 4px; }
.fabry-arch-add-input { flex: 1; border: 1px dashed var(--border); border-radius: 10px; background: none; font: inherit; color: var(--text-primary); padding: 9px 12px; }
.fabry-arch-add-input:focus { outline: none; border-color: var(--accent); border-style: solid; }
.fabry-arch-add-btn { flex: none; border: 1px solid var(--border); background: var(--bg-hover); color: var(--accent); border-radius: 10px; padding: 0 16px; font-weight: 600; cursor: pointer; }
.fabry-arch-add-btn:disabled { opacity: 0.5; cursor: default; }
```

Note: all tokens above are verified present in `console.css` `:root` — `--bg-card`, `--text-primary`, `--text-secondary`, `--bg-hover`, `--border`, `--accent`, `--accent-hover`, `--success`/`--success-bg`/`--success-fg`, `--danger`/`--danger-bg`/`--danger-fg`, `--warning`/`--warning-bg`. Do NOT introduce new color literals — reuse these tokens only.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-app.test.js`
Expected: PASS (all cases).

- [ ] **Step 8: Stage (do not commit)**

Run: `git add src/fabry/architect/components/ src/console/console.css tests/fabry-architect-app.test.js`

---

### Task 8: Wiring — App pane swap + Sidebar mode toggle + toggle CSS

**Files:**
- Modify: `src/fabry/components/App.jsx:38-43` (swap `.fabry-main` contents by mode)
- Modify: `src/fabry/components/Sidebar.jsx` (mode toggle under the brand; hide chat list in architect mode)
- Modify: `src/console/console.css` (append `.fabry-mode-*` rules)
- Test: `tests/fabry-architect-wiring.test.js`

**Interfaces:**
- Consumes: `store.fabryMode`/`store.setFabryMode`; `ArchitectApp` default export.
- Produces: mode-driven rendering. Chat mode markup byte-identical to today.

- [ ] **Step 1: Write the failing test**

Create `tests/fabry-architect-wiring.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(), sendMessage: vi.fn(),
  stopStreaming: vi.fn(), sendFeedback: vi.fn(), downloadFile: vi.fn(),
}));
// ArchitectApp pulls actions on mount — stub it to a marker so the wiring test
// stays about the swap, not Architect internals.
vi.mock('../src/fabry/architect/components/ArchitectApp.jsx', () => ({
  default: () => h('div', { class: 'arch-marker' }, 'ARCH'),
}));

import * as store from '../src/fabry/store.js';
import App from '../src/fabry/components/App.jsx';
import Sidebar from '../src/fabry/components/Sidebar.jsx';

function mount(Comp, props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, props || null), root);
  return root;
}

beforeEach(() => {
  store.agentAvailable.value = true;
  store.error.value = null;
  store.fabryMode.value = 'chat';
  store.sidebarOpen.value = true;
  store.chats.value = []; store.chatsTotal.value = null; store.chatsLoading.value = false;
});

describe('App pane swap', () => {
  it('chat mode renders the composer, not the architect pane', () => {
    const root = mount(App, { connected: true });
    expect(root.querySelector('.arch-marker')).toBeNull();
    expect(root.querySelector('.fabry-main')).toBeTruthy();
  });
  it('architect mode renders the architect pane', () => {
    store.fabryMode.value = 'architect';
    const root = mount(App, { connected: true });
    expect(root.querySelector('.arch-marker')).toBeTruthy();
  });
});

describe('Sidebar mode toggle', () => {
  it('renders a Chat/Architect segmented control and switches mode', () => {
    const root = mount(Sidebar);
    const opts = root.querySelectorAll('.fabry-mode-opt');
    expect(opts.length).toBe(2);
    const arch = [...opts].find((o) => /architect/i.test(o.textContent));
    arch.click();
    expect(store.fabryMode.value).toBe('architect');
  });
  it('hides the chat list in architect mode', () => {
    store.fabryMode.value = 'architect';
    const root = mount(Sidebar);
    expect(root.querySelector('.fabry-chatlist')).toBeNull();
    expect(root.querySelector('.fabry-mode')).toBeTruthy();
  });
  it('shows the chat list and New chat in chat mode', () => {
    const root = mount(Sidebar);
    expect(root.querySelector('.fabry-chatlist')).toBeTruthy();
    expect(root.querySelector('.fabry-newchat')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fabry-architect-wiring.test.js`
Expected: FAIL — `.fabry-mode-opt` absent; architect pane not rendered.

- [ ] **Step 3: Swap the main pane in `src/fabry/components/App.jsx`**

Add the import near the other component imports:

```js
import ArchitectApp from '../architect/components/ArchitectApp.jsx';
```

Replace the `<main class="fabry-main">…</main>` block (currently lines 38-43) with:

```jsx
        <main class="fabry-main">
          {store.fabryMode.value === 'architect' ? (
            <ArchitectApp />
          ) : (
            <>
              <ChatHeader />
              <Thread />
              <FilesStrip />
              <Composer />
            </>
          )}
        </main>
```

- [ ] **Step 4: Add the mode toggle to `src/fabry/components/Sidebar.jsx`**

Add the mode toggle immediately after the `.fabry-sidebar-title` block and gate the New-chat + chat-list on chat mode. Replace the expanded-sidebar return (currently lines 47-79) with:

```jsx
  const architect = store.fabryMode.value === 'architect';
  return (
    <aside class="fabry-sidebar">
      <div class="fabry-sidebar-title">
        <span class="fabry-sidebar-mark">{'✦'}</span>
        <span class="fabry-sidebar-name">Mr. Fabry</span>
        <button type="button" class="fabry-sidebar-toggle" title="Collapse chat list" onClick={() => store.setSidebarOpen(false)}>{'«'}</button>
      </div>
      <div class="fabry-mode" role="tablist">
        <button type="button" class={'fabry-mode-opt' + (!architect ? ' on' : '')} onClick={() => store.setFabryMode('chat')}>Chat</button>
        <button type="button" class={'fabry-mode-opt' + (architect ? ' on' : '')} onClick={() => store.setFabryMode('architect')}>Architect</button>
      </div>
      {!architect && (
        <button type="button" class="fabry-newchat" onClick={startNewChat}>{'＋ New chat'}</button>
      )}
      {!architect && (
        <div
          class="fabry-chatlist"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (hasMore && !store.chatsLoading.value && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
              loadChats({ more: true });
            }
          }}
        >
          {list.map((c) => (
            <button
              type="button"
              key={c.chat_id}
              class={'fabry-chat-row' + (store.activeChatId.value === c.chat_id ? ' active' : '')}
              onClick={() => openChat(c.chat_id)}
            >
              <span class="fabry-chat-title" title={chatTitle(c)}>{chatTitle(c)}</span>
            </button>
          ))}
          {list.length === 0 && !store.chatsLoading.value && <div class="fabry-chat-empty">No conversations yet</div>}
        </div>
      )}
      {!architect && store.chatsLoading.value && <div class="fabry-chat-loadingrow">Loading{'…'}</div>}
      <div class="fabry-side-resizer" title="Drag to resize" onMouseDown={startResize} />
    </aside>
  );
```

(The collapsed-sidebar return at lines 38-46 is unchanged.)

- [ ] **Step 5: Append mode-toggle CSS to `src/console/console.css`**

```css
/* Fabry Chat/Architect mode toggle (sidebar) */
.fabry-mode { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 0 4px 8px; }
.fabry-mode-opt { flex: 1; border: none; border-right: 1px solid var(--border); background: none; color: var(--text-secondary); font: inherit; font-weight: 600; font-size: 12.5px; padding: 6px 0; cursor: pointer; }
.fabry-mode-opt:last-child { border-right: none; }
.fabry-mode-opt:hover { background: var(--bg-hover); }
.fabry-mode-opt.on { background: var(--accent); color: #fff; }
.fabry-mode-opt.on:hover { background: var(--accent); }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/fabry-architect-wiring.test.js`
Expected: PASS (all cases).

- [ ] **Step 7: Run the existing Fabry suites to confirm Chat mode is untouched**

Run: `npx vitest run tests/fabry-app.test.js tests/fabry-sidebar.test.js tests/fabry-chat.test.js`
Expected: PASS (no regressions).

- [ ] **Step 8: Stage (do not commit)**

Run: `git add src/fabry/components/App.jsx src/fabry/components/Sidebar.jsx src/console/console.css tests/fabry-architect-wiring.test.js`

---

### Task 9: Build + documentation

**Files:**
- Modify: `CLAUDE.md` (Fabry Chat section + Chrome Storage Keys)
- Build artifact: `dist/` (regenerated)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS (all suites, including the 8 new/extended Architect files).

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: clean build; `dist/console/console.js` regenerated. Confirm no esbuild error about the new `src/fabry/architect/` modules.

- [ ] **Step 3: Grep the bundle to confirm Architect shipped and stayed read-only**

Run: `grep -c "__mrfabry_architect" dist/console/console.js && grep -c "mcp_mode" dist/console/console.js`
Expected: first count ≥ 1 (collection constant bundled); second count is 0 (no write-mode flag introduced).

- [ ] **Step 4: Update `CLAUDE.md`**

In the **Fabry Chat (`src/fabry/`)** section, add a paragraph describing the Architect mode:

```markdown
- **Architect mode** (spec `docs/superpowers/specs/2026-07-13-fabry-architect-design.md`):
  a `[Chat | Architect]` segmented toggle in the sidebar (under the ✦ brand)
  driven by the per-tab `fabryMode` signal swaps `.fabry-main` — Chat is
  byte-identical; Architect (`src/fabry/architect/`) keeps one editable
  natural-language SOW-requirement list per org in the `__mrfabry_architect`
  Data Storage system collection (one doc per requirement `{_id, kind:
  'requirement', text, order, createdAt}`; name is a single cosmetic constant
  in `architect/api.js`, no code depends on the `__` prefix). `Run ▷` checks
  each requirement in its own fresh cautious-primed agent chat and parses
  `VERDICT: PASS|FAIL|UNCERTAIN` + evidence (pure `check.js`; concurrency-3
  abort-aware `run.js`, mirroring `deepLoop.js`; impure glue in `actions.js`
  mirroring `chat.js`). Run is **strictly read-only** against the org;
  Architect's only writes are its own requirement docs. Each check is a real
  server chat (appears in the Chat sidebar; per-row "view investigation" opens
  it). No new gate — Architect is inside the existing `experimentalUnlocked`
  Fabry app.
```

In **Chrome Storage Keys → Fabry Chat state**, add `fabryMode` to the per-tab navigation keys:

```markdown
- Fabry Chat state: `fabrySidebarOpen` + `fabrySidebarWidth` are **global** layout prefs … `fabryActiveChat` and `fabryMode` (Chat|Architect sub-app selection) are **per-tab** (tabState pattern); chat content/images/transcripts never touch storage.
```

(Also add `'fabryMode'` to the MDH-state paragraph's list of per-tab keys if it enumerates them.)

- [ ] **Step 5: Stage (do not commit)**

Run: `git add CLAUDE.md`

- [ ] **Step 6: Report the pending live gate**

The one item not coverable by unit tests + build is the live server-side create of the `__mrfabry_architect` collection (spec §8). Note in the run summary that this remains a pre-ship live gate on elis (create + drop the collection, confirm 2xx/async-accept; if the name is rejected, apply the §7 fallback: change `COLLECTION` to `mrfabry_architect`). Do NOT run destructive live ops without a fresh token + owner go-ahead.

---

## Self-Review

**1. Spec coverage:**
- Mode switch (`fabryMode` + toggle + swap) → Tasks 1, 8. ✓
- One editable NL-requirement list per org → Tasks 4, 5, 6, 7. ✓
- `__mrfabry_architect` system collection, doc shape `{_id, kind, text, order, createdAt}` → Task 5. ✓
- Read-only `Run ▷` per-requirement fresh cautious chat, `VERDICT: PASS|FAIL|UNCERTAIN` + evidence → Tasks 2, 3, 6, 7. ✓
- Architect writes only its own docs; Run read-only → Global Constraints + Tasks 5, 6 + Task 9 grep gate. ✓
- Cosmetic swappable collection constant → Task 5 + Global Constraints. ✓
- No new gate; Chat byte-identical → Task 8 + Global Constraints + Task 8 Step 7 regression run. ✓
- Per-tab content-free `fabryMode` → Task 1. ✓
- Check chats appear in sidebar; per-row "view investigation" → Task 7. ✓
- One-Run-adds-N-chats tradeoff (accepted, deferred filtering) → spec §5/§9; no task needed. ✓
- Live create gate → Task 9 Step 6 (documented, not automated). ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. Task 7 Step 6 has one verify-token-names note (a real check against `:root`, not a placeholder) — the CSS itself is complete.

**3. Type consistency:** `Req = {id, text, order}` consistent across api (`loadRequirements` map), store, actions, components. `Result = {verdict, evidence, chatId, running?, error?}` consistent across run.js, store.setResult, actions, RequirementRow chip. `runChecks(reqs, {runOne, onResult, concurrency, signal})` matches its call in actions.runAll. `parseCheckVerdict → {verdict, evidence}` matches actions.runOne destructure. `buildCheckPrompt(req.text)` (string) matches actions call. `store.setFabryMode`/`store.fabryMode` consistent across store, Sidebar, App, RequirementRow, index.jsx. `COLLECTION` constant name consistent.
