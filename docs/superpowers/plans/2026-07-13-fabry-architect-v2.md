# Fabry Architect v2 Implementation Plan (owner iteration)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. This plan REWORKS the already-built (uncommitted) v1 Architect into v2 per the owner's mid-run redesign. Spec: `docs/superpowers/specs/2026-07-13-fabry-architect-design.md` (§Revision v2, §4–§9).

**Goal:** Move the deliverable list into the sidebar with inline run status; open a deliverable to edit its Markdown source in a CodeMirror editor; remember each check's last result (verdict+evidence+time) on its Data Storage doc and show it marked outdated; blend the active sidebar row into the editor.

**Architecture:** Deliverables (Markdown docs) + last-run results persist server-side on `__mrfabry_architect` docs. `store.deliverables`/`activeId`/`results(stale)`; `api` gains `loadDeliverables→{deliverables,results}`/`saveResult`/`editedAt`; `actions` persists results and marks staleness; new components `MarkdownEditor` (CodeMirror + `@codemirror/lang-markdown`), `ArchitectSidebar` (list, moved into the sidebar), `DeliverableEditor` + reworked `ArchitectApp`. Chat mode stays byte-identical.

**Tech Stack:** Preact + @preact/signals, esbuild, vitest/jsdom, CodeMirror 6 (`@codemirror/lang-markdown@^6.5.0`, already installed).

## Global Constraints

- **Read-only Run against the org.** `createChat()` (no args) → `/persona cautious` → `buildCheckPrompt`. NEVER send `mcp_mode`/any write flag. Persisting a result is a write to Architect's OWN `__mrfabry_architect` collection only.
- **Nothing extra at rest in the browser.** Deliverable content + results live server-side per-org on the DS docs. Only the per-tab, content-free `fabryMode` persists in the browser; `activeId` is in-memory only.
- **Collection name** = single cosmetic constant `COLLECTION='__mrfabry_architect'` in `architect/api.js`; no code parses the `__` prefix. Docs keep `kind:'requirement'` for back-compat.
- **Staleness rule:** a result is stale when `!ranAt` OR `editedAt > ranAt` OR it was loaded from storage (not produced by a run this session). A fresh run clears stale + sets `ranAt`; editing sets stale.
- **Chat mode byte-identical.** Only the Architect sidebar body + main pane change. Do not alter chat markup/handlers/classes.
- **JSX unicode:** safe forms only (`{'…'}`, literal glyph, entity) — never `\uXXXX` in JSX text/attrs.
- **Tests** are `.test.js` with `h()`. `flush = () => new Promise(r => setTimeout(r,0))`. Component tests needing effects set an immediate rAF polyfill. Real CodeMirror works in jsdom here (see `tests/mdh-json-editor.test.js`: mount + `vi.waitFor` on a ref); mock `MarkdownEditor` in higher-level component tests.
- **Rebuild dist after UI changes.** **No git commit during the run** — stage only; one commit at the very end when the owner asks; no Co-Authored-By.
- This reworks staged v1 files. Removing v1's `RequirementRow.jsx`/`RequirementAdd.jsx` and rewriting `tests/fabry-architect-app.test.js` is expected.

---

### Task V1: Data layer — `api.js` + `store.js` v2

**Files:**
- Modify: `src/fabry/architect/api.js`
- Modify: `src/fabry/architect/store.js`
- Create: `src/fabry/architect/format.js` (pure title + relative-time helpers)
- Test: `tests/fabry-architect-api.test.js` (rewrite), `tests/fabry-architect-store.test.js` (rewrite), `tests/fabry-architect-format.test.js` (new)

**Interfaces produced:**
- `api.COLLECTION`, `api.ensureCollection()`, `api.loadDeliverables() → {deliverables:{id,text,order}[], results:{[id]:{verdict,evidence,chatId,ranAt,stale:true}}}`, `api.addDeliverable({id,text,order,createdAt})`, `api.updateDeliverable(id,text,editedAt)`, `api.deleteDeliverable(id)`, `api.saveResult(id,{verdict,evidence,chatId,ranAt})`.
- `store.deliverables`, `store.activeId`, `store.loaded`, `store.loadError`, `store.running`, `store.results` signals; `store.setResult(id,r)`, `store.clearResults()`, `store.setActive(id)`.
- `format.deliverableTitle(text) → string`, `format.relativeTime(ms, now) → string`.

- [ ] **Step 1: Write failing tests**

`tests/fabry-architect-format.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { deliverableTitle, relativeTime } from '../src/fabry/architect/format.js';

describe('deliverableTitle', () => {
  it('uses the first non-empty line, stripping leading # and inline marks', () => {
    expect(deliverableTitle('# VAT extraction\nbody')).toBe('VAT extraction');
    expect(deliverableTitle('\n\n  ## **Bold** title  \nx')).toBe('Bold title');
    expect(deliverableTitle('plain first line')).toBe('plain first line');
  });
  it('falls back to Untitled for empty content', () => {
    expect(deliverableTitle('')).toBe('Untitled');
    expect(deliverableTitle('   \n  ')).toBe('Untitled');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats recent/min/hour/day', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
  it('tolerates missing input', () => { expect(relativeTime(null, now)).toBe(''); });
});
```

`tests/fabry-architect-store.test.js` (rewrite):
```js
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/architect/store.js';

beforeEach(() => { store.results.value = {}; store.deliverables.value = []; store.activeId.value = null; });

describe('architect store', () => {
  it('has sane defaults', () => {
    expect(store.deliverables.value).toEqual([]);
    expect(store.activeId.value).toBeNull();
    expect(store.loaded.value).toBe(false);
    expect(store.running.value).toBe(false);
    expect(store.results.value).toEqual({});
  });
  it('setResult merges immutably by id', () => {
    store.setResult('r1', { verdict: 'pass', evidence: 'a', chatId: 'c1', ranAt: 1, stale: false });
    const first = store.results.value;
    store.setResult('r2', { verdict: 'fail', evidence: 'b', chatId: 'c2', ranAt: 2, stale: true });
    expect(Object.keys(store.results.value).sort()).toEqual(['r1', 'r2']);
    expect(store.results.value).not.toBe(first);
  });
  it('clearResults empties; setActive sets the open id', () => {
    store.setResult('r1', { verdict: 'pass', evidence: '', chatId: 'c', ranAt: 1, stale: false });
    store.clearResults(); expect(store.results.value).toEqual({});
    store.setActive('r9'); expect(store.activeId.value).toBe('r9');
  });
});
```

`tests/fabry-architect-api.test.js` (rewrite):
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

describe('architect api v2', () => {
  it('uses the __mrfabry_architect collection', () => { expect(api.COLLECTION).toBe('__mrfabry_architect'); });

  it('ensureCollection tolerates already-exists but rethrows 401', async () => {
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 400 }));
    await expect(api.ensureCollection()).resolves.toBeUndefined();
    mdh.createCollection.mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 }));
    await expect(api.ensureCollection()).rejects.toMatchObject({ status: 401 });
  });

  it('loadDeliverables maps docs and derives stale persisted results', async () => {
    mdh.find.mockResolvedValueOnce({ result: [
      { _id: 'a', kind: 'requirement', text: '# A', order: 1, lastVerdict: 'pass', lastEvidence: 'ok', lastChatId: 'c1', ranAt: 111 },
      { _id: 'b', kind: 'requirement', text: '# B', order: 2 },
    ] });
    const { deliverables, results } = await api.loadDeliverables();
    expect(mdh.find).toHaveBeenCalledWith('__mrfabry_architect', { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
    expect(deliverables).toEqual([{ id: 'a', text: '# A', order: 1 }, { id: 'b', text: '# B', order: 2 }]);
    expect(results.a).toEqual({ verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 111, stale: true });
    expect(results.b).toBeUndefined(); // no lastVerdict → no result
  });

  it('loadDeliverables tolerates a missing result envelope', async () => {
    mdh.find.mockResolvedValueOnce({});
    expect(await api.loadDeliverables()).toEqual({ deliverables: [], results: {} });
  });

  it('addDeliverable inserts the documented shape', async () => {
    await api.addDeliverable({ id: 'x', text: 'body', order: 3, createdAt: 111 });
    expect(mdh.insertOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x', kind: 'requirement', text: 'body', order: 3, createdAt: 111 });
  });
  it('updateDeliverable $sets text + editedAt', async () => {
    await api.updateDeliverable('x', 'new', 222);
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { text: 'new', editedAt: 222 } });
  });
  it('deleteDeliverable deletes by _id', async () => {
    await api.deleteDeliverable('x');
    expect(mdh.deleteOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' });
  });
  it('saveResult $sets the last-run fields', async () => {
    await api.saveResult('x', { verdict: 'fail', evidence: 'bad', chatId: 'c9', ranAt: 333 });
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'x' }, { $set: { lastVerdict: 'fail', lastEvidence: 'bad', lastChatId: 'c9', ranAt: 333 } });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/fabry-architect-format.test.js tests/fabry-architect-store.test.js tests/fabry-architect-api.test.js`
Expected: FAIL (format module missing; store lacks `activeId`/`setActive`; api lacks `loadDeliverables`/`saveResult`/3-arg update).

- [ ] **Step 3: Implement `src/fabry/architect/format.js`**

```js
// Pure display helpers for the deliverable list.
export function deliverableTitle(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length);
  if (!line) return 'Untitled';
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 80) || 'Untitled';
}

export function relativeTime(ms, now) {
  if (!ms) return '';
  const diff = Math.max(0, (now || 0) - ms);
  if (diff < 45_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(diff / 86_400_000);
  return `${d}d ago`;
}
```

- [ ] **Step 4: Rewrite `src/fabry/architect/store.js`**

```js
import { signal } from '@preact/signals';

// Deliverables (Markdown docs) + their last check results live server-side in
// Data Storage; only the content-free fabryMode is persisted in the browser.
// activeId (which deliverable is open) is in-memory only.
export const deliverables = signal([]); // {id, text, order}[]
export const activeId = signal(null);   // open deliverable id, or null
export const loaded = signal(false);
export const loadError = signal(null);
export const running = signal(false);
export const results = signal({}); // { [id]: Result }

export function setResult(id, result) { results.value = { ...results.value, [id]: result }; }
export function clearResults() { results.value = {}; }
export function setActive(id) { activeId.value = id; }
```

- [ ] **Step 5: Rewrite `src/fabry/architect/api.js`**

```js
// Data Storage wrapper for the Architect system collection (v2: deliverables +
// persisted last-run results). Collection name is a single cosmetic constant —
// no code parses the `__` prefix (swappable). Docs keep kind:'requirement'.
import * as mdh from '../../mdh/api.js';

export const COLLECTION = '__mrfabry_architect';

export async function ensureCollection() {
  try { await mdh.createCollection(COLLECTION); }
  catch (err) { if (err?.status === 401) throw err; }
}

export async function loadDeliverables() {
  const res = await mdh.find(COLLECTION, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  const docs = (res && res.result) || [];
  const deliverables = docs.map((d) => ({ id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0 }));
  const results = {};
  for (const d of docs) {
    if (d.lastVerdict) {
      // Loaded from storage → always stale until re-run this session.
      results[d._id] = { verdict: d.lastVerdict, evidence: d.lastEvidence || '', chatId: d.lastChatId || null, ranAt: d.ranAt || null, stale: true };
    }
  }
  return { deliverables, results };
}

export function addDeliverable({ id, text, order, createdAt }) {
  return mdh.insertOne(COLLECTION, { _id: id, kind: 'requirement', text, order, createdAt });
}
export function updateDeliverable(id, text, editedAt) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { text, editedAt } });
}
export function deleteDeliverable(id) {
  return mdh.deleteOne(COLLECTION, { _id: id });
}
export function saveResult(id, { verdict, evidence, chatId, ranAt }) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { lastVerdict: verdict, lastEvidence: evidence, lastChatId: chatId, ranAt } });
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npx vitest run tests/fabry-architect-format.test.js tests/fabry-architect-store.test.js tests/fabry-architect-api.test.js`
Expected: PASS (all).

- [ ] **Step 7: Stage (no commit)**

`git add src/fabry/architect/api.js src/fabry/architect/store.js src/fabry/architect/format.js tests/fabry-architect-api.test.js tests/fabry-architect-store.test.js tests/fabry-architect-format.test.js`

---

### Task V2: `actions.js` v2 (load stale results, open/edit, persist runs)

**Files:**
- Modify: `src/fabry/architect/actions.js`
- Test: `tests/fabry-architect-actions.test.js` (rewrite)

**Interfaces produced:** `loadArchitect()`, `addDeliverable(text?)` (creates + opens), `openDeliverable(id)`, `updateDeliverable(id,text)` (store-live + marks stale + persists editedAt), `deleteDeliverable(id)`, `runAll()`, `reRun(id)`, `stopRun()`.
**Consumes:** V1's `api.js`/`store.js`/`format` (n/a), `check.js` + `run.js` (unchanged), `agentApi`, `agentStream`.

- [ ] **Step 1: Write failing test** — `tests/fabry-architect-actions.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/agent/agentApi.js', () => ({ createChat: vi.fn(), streamMessage: vi.fn() }));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '__mrfabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  loadDeliverables: vi.fn().mockResolvedValue({ deliverables: [], results: {} }),
  addDeliverable: vi.fn().mockResolvedValue({}),
  updateDeliverable: vi.fn().mockResolvedValue({}),
  deleteDeliverable: vi.fn().mockResolvedValue({}),
  saveResult: vi.fn().mockResolvedValue({}),
}));
import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import { loadArchitect, addDeliverable, openDeliverable, updateDeliverable, deleteDeliverable, runAll } from '../src/fabry/architect/actions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
function scriptReplies(map) {
  let n = 0;
  agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
  agentApi.streamMessage.mockImplementation(async (chatId, content, { onEvent }) => {
    if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
    const key = Object.keys(map).find((k) => content.includes(k)) || '';
    onEvent({ type: 'text-delta', delta: map[key] || 'VERDICT: UNCERTAIN' });
    onEvent({ type: 'finish' });
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.activeId.value = null;
  store.loaded.value = false; store.loadError.value = null; store.running.value = false;
});

describe('loadArchitect', () => {
  it('loads deliverables + persisted (stale) results', async () => {
    api.loadDeliverables.mockResolvedValueOnce({ deliverables: [{ id: 'a', text: '# A', order: 1 }], results: { a: { verdict: 'pass', evidence: 'ok', chatId: 'c', ranAt: 5, stale: true } } });
    await loadArchitect();
    expect(api.ensureCollection).toHaveBeenCalled();
    expect(store.deliverables.value.length).toBe(1);
    expect(store.results.value.a.stale).toBe(true);
    expect(store.loaded.value).toBe(true);
  });
  it('records loadError without throwing', async () => {
    api.ensureCollection.mockRejectedValueOnce(new Error('nope'));
    await loadArchitect();
    expect(store.loadError.value).toMatch(/nope/);
    expect(store.loaded.value).toBe(false);
  });
});

describe('add/open/update/delete', () => {
  it('addDeliverable creates an empty deliverable and opens it', async () => {
    await addDeliverable();
    expect(store.deliverables.value.length).toBe(1);
    const d = store.deliverables.value[0];
    expect(store.activeId.value).toBe(d.id);
    expect(api.addDeliverable).toHaveBeenCalledWith(expect.objectContaining({ id: d.id, text: '', order: 1 }));
  });
  it('openDeliverable sets activeId', () => { openDeliverable('z'); expect(store.activeId.value).toBe('z'); });
  it('updateDeliverable updates store text live, marks its result stale, and persists editedAt', async () => {
    store.deliverables.value = [{ id: 'a', text: '# old', order: 1 }];
    store.setResult('a', { verdict: 'pass', evidence: 'e', chatId: 'c', ranAt: 5, stale: false });
    await updateDeliverable('a', '# new body');
    expect(store.deliverables.value[0].text).toBe('# new body');
    expect(store.results.value.a.stale).toBe(true);
    expect(api.updateDeliverable).toHaveBeenCalledWith('a', '# new body', expect.any(Number));
  });
  it('updateDeliverable no-ops when unchanged', async () => {
    store.deliverables.value = [{ id: 'a', text: 'same', order: 1 }];
    await updateDeliverable('a', 'same');
    expect(api.updateDeliverable).not.toHaveBeenCalled();
  });
  it('deleteDeliverable removes it, its result, and clears activeId if open', async () => {
    store.deliverables.value = [{ id: 'a', text: 'x', order: 1 }];
    store.setResult('a', { verdict: 'pass', evidence: '', chatId: 'c', ranAt: 1, stale: true });
    store.activeId.value = 'a';
    await deleteDeliverable('a');
    expect(store.deliverables.value).toEqual([]);
    expect(store.results.value.a).toBeUndefined();
    expect(store.activeId.value).toBeNull();
  });
});

describe('runAll', () => {
  it('checks each deliverable in its own chat, records verdicts, and persists results (stale cleared)', async () => {
    store.deliverables.value = [{ id: 'a', text: 'ALPHA', order: 1 }, { id: 'b', text: 'BETA', order: 2 }];
    scriptReplies({ ALPHA: 'VERDICT: PASS\ngood', BETA: 'VERDICT: FAIL\n- bad' });
    await runAll();
    expect(store.results.value.a.verdict).toBe('pass');
    expect(store.results.value.a.stale).toBe(false);
    expect(store.results.value.b.verdict).toBe('fail');
    expect(api.saveResult).toHaveBeenCalledTimes(2);
    expect(api.saveResult).toHaveBeenCalledWith('a', expect.objectContaining({ verdict: 'pass', chatId: 'chat_0' }));
    expect(store.running.value).toBe(false);
  });
  it('never sends a write-enabling flag (read-only contract)', async () => {
    store.deliverables.value = [{ id: 'a', text: 'ALPHA', order: 1 }];
    scriptReplies({ ALPHA: 'VERDICT: PASS' });
    await runAll();
    for (const call of agentApi.createChat.mock.calls) expect(call.length).toBe(0);
    for (const call of agentApi.streamMessage.mock.calls) {
      const opts = call[2] || {};
      expect('mcp_mode' in opts).toBe(false);
      expect(Object.keys(opts).sort()).toEqual(['onEvent', 'signal']);
    }
  });
  it('no-ops on an empty list', async () => { await runAll(); expect(agentApi.createChat).not.toHaveBeenCalled(); });
});
```

- [ ] **Step 2: Run test, verify it fails**
Run: `npx vitest run tests/fabry-architect-actions.test.js` — FAIL (actions still v1: `requirements`, no `openDeliverable`/`saveResult`/stale).

- [ ] **Step 3: Rewrite `src/fabry/architect/actions.js`**

```js
// Impure glue for Architect (v2): binds the store to Data Storage (api.js) and
// the agent transport. Run creates one fresh cautious read-only chat per
// deliverable, then persists the result onto its own doc. Mirrors chat.js.
import * as agentApi from '../../agent/agentApi.js';
import { newAcc, foldEvents, replyText } from '../../agent/agentStream.js';
import * as api from './api.js';
import * as check from './check.js';
import { runChecks } from './run.js';
import * as store from './store.js';

let controller = null;
let runId = 0;

function newId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return 'r' + Date.now() + Math.random().toString(36).slice(2, 8);
}
function clearSpinners() {
  const cleaned = {};
  for (const [k, v] of Object.entries(store.results.value)) cleaned[k] = v?.running ? { ...v, running: false } : v;
  store.results.value = cleaned;
}

export async function loadArchitect() {
  if (store.loaded.value) return;
  store.loadError.value = null;
  try {
    await api.ensureCollection();
    const { deliverables, results } = await api.loadDeliverables();
    store.deliverables.value = deliverables;
    store.results.value = results;
    store.loaded.value = true;
  } catch (err) {
    store.loadError.value = err?.message || 'Could not load deliverables.';
  }
}

export async function addDeliverable(text = '') {
  const order = store.deliverables.value.reduce((m, d) => Math.max(m, d.order || 0), 0) + 1;
  const d = { id: newId(), text: String(text || ''), order };
  store.deliverables.value = [...store.deliverables.value, d];
  store.activeId.value = d.id; // open the new one for editing
  try {
    await api.addDeliverable({ id: d.id, text: d.text, order, createdAt: Date.now() });
  } catch (err) {
    store.deliverables.value = store.deliverables.value.filter((x) => x.id !== d.id);
    if (store.activeId.value === d.id) store.activeId.value = null;
    store.loadError.value = err?.message || 'Could not create deliverable.';
  }
}

export function openDeliverable(id) { store.activeId.value = id; }

export async function updateDeliverable(id, text) {
  const t = String(text ?? '');
  const prev = store.deliverables.value.find((d) => d.id === id);
  if (!prev || prev.text === t) return;
  store.deliverables.value = store.deliverables.value.map((d) => (d.id === id ? { ...d, text: t } : d));
  const r = store.results.value[id];
  if (r && !r.running && !r.stale) store.setResult(id, { ...r, stale: true });
  try {
    await api.updateDeliverable(id, t, Date.now());
  } catch (err) {
    store.loadError.value = err?.message || 'Could not save edit.';
  }
}

export async function deleteDeliverable(id) {
  store.deliverables.value = store.deliverables.value.filter((d) => d.id !== id);
  const rest = { ...store.results.value };
  delete rest[id];
  store.results.value = rest;
  if (store.activeId.value === id) store.activeId.value = null;
  try {
    await api.deleteDeliverable(id);
  } catch (err) {
    store.loadError.value = err?.message || 'Could not delete deliverable.';
  }
}

async function runOne(d, signal) {
  const chatId = await agentApi.createChat();
  if (signal?.aborted) return null;
  const fold = async (content) => {
    const acc = newAcc();
    await agentApi.streamMessage(chatId, content, { signal, onEvent: (e) => foldEvents(acc, [e]) });
    return replyText(acc);
  };
  await fold('/persona cautious');
  if (signal?.aborted) return null;
  const text = await fold(check.buildCheckPrompt(d.text));
  if (signal?.aborted) return null;
  const { verdict, evidence } = check.parseCheckVerdict(text);
  return { verdict, evidence, chatId };
}

// Record + persist a completed result onto its own doc (write to OUR system
// collection; non-fatal on error — the result stays in memory).
function persist(id, r) {
  const ranAt = Date.now();
  store.setResult(id, { ...r, ranAt, stale: false, running: false });
  api.saveResult(id, { verdict: r.verdict, evidence: r.evidence, chatId: r.chatId, ranAt }).catch(() => {});
}

export async function runAll() {
  if (store.running.value) return;
  const ds = store.deliverables.value;
  if (!ds.length) return;
  runId += 1;
  const id = runId;
  controller = new AbortController();
  const signal = controller.signal;
  store.running.value = true;
  const pending = { ...store.results.value };
  for (const d of ds) pending[d.id] = { ...(pending[d.id] || { verdict: null, evidence: '', chatId: null }), running: true };
  store.results.value = pending;
  try {
    await runChecks(ds, {
      concurrency: 3,
      signal,
      runOne: (d) => runOne(d, signal),
      onResult: (rid, result) => { if (id === runId) persist(rid, result); },
    });
  } finally {
    if (id === runId) { clearSpinners(); store.running.value = false; controller = null; }
  }
}

export async function reRun(id) {
  const d = store.deliverables.value.find((x) => x.id === id);
  if (!d) return;
  const ctrl = new AbortController();
  store.setResult(id, { ...(store.results.value[id] || { verdict: null, evidence: '', chatId: null }), running: true });
  try {
    const result = await runOne(d, ctrl.signal);
    if (result) persist(id, result);
    else store.setResult(id, { ...(store.results.value[id] || {}), running: false });
  } catch (err) {
    store.setResult(id, { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null, ranAt: Date.now(), stale: false, error: true });
  }
}

export function stopRun() {
  runId += 1;
  if (controller) controller.abort();
  controller = null;
  store.running.value = false;
  clearSpinners();
}
```

- [ ] **Step 4: Run test, verify pass** — `npx vitest run tests/fabry-architect-actions.test.js` → PASS.
- [ ] **Step 5: Stage** — `git add src/fabry/architect/actions.js tests/fabry-architect-actions.test.js`

---

### Task V3: `MarkdownEditor.jsx` (CodeMirror + Markdown highlighting)

**Files:**
- Create: `src/fabry/architect/components/MarkdownEditor.jsx`
- Test: `tests/fabry-architect-markdown-editor.test.js`

**Interfaces produced:** default `MarkdownEditor({ value='', onChange, editorRef })` — CodeMirror with `@codemirror/lang-markdown`, theme-aware, line-wrapped; seeds `value`, calls `onChange(doc)` on edits; `editorRef.current = { getValue }`.

- [ ] **Step 1: Write failing test** — `tests/fabry-architect-markdown-editor.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import MarkdownEditor from '../src/fabry/architect/components/MarkdownEditor.jsx';

function mount(props) { const root = document.createElement('div'); document.body.appendChild(root); render(h(MarkdownEditor, props), root); return root; }

describe('MarkdownEditor', () => {
  it('mounts CodeMirror seeded with value and exposes getValue via ref', async () => {
    const ref = { current: null };
    mount({ value: '# Hello', editorRef: ref });
    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current.getValue()).toBe('# Hello');
    expect(document.querySelector('.cm-editor')).toBeTruthy();
  });
  it('emits onChange when the document changes', async () => {
    const ref = { current: null };
    const onChange = vi.fn();
    mount({ value: 'a', onChange, editorRef: ref });
    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    ref.current.setValue('a b'); // test helper on the ref
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('a b'));
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — module missing.

- [ ] **Step 3: Implement `src/fabry/architect/components/MarkdownEditor.jsx`**

```jsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const light = HighlightStyle.define([
  { tag: tags.heading, color: '#1a1a24', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#4270db' },
  { tag: tags.url, color: '#4270db' },
  { tag: tags.monospace, color: '#c41a16' },
  { tag: [tags.list, tags.quote], color: '#7a7a8c' },
  { tag: tags.processingInstruction, color: '#7a7a8c' }, // markdown punctuation (#, *, -)
]);
const dark = HighlightStyle.define([
  { tag: tags.heading, color: '#e8e8ee', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#5db0d7' },
  { tag: tags.url, color: '#5db0d7' },
  { tag: tags.monospace, color: '#f29766' },
  { tag: [tags.list, tags.quote], color: '#9a9aac' },
  { tag: tags.processingInstruction, color: '#9a9aac' },
]);
function prefersDark() {
  try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}
const surface = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-primary)', fontSize: '13.5px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-gutters': { display: 'none' },
  '.cm-content': { padding: '10px 0' },
});

export default function MarkdownEditor({ value = '', onChange, editorRef }) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged && onChangeRef.current) onChangeRef.current(u.state.doc.toString());
    });
    const hl = syntaxHighlighting(prefersDark() ? dark : light);
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [basicSetup, markdown(), EditorView.lineWrapping, surface, hl, listener] }),
    });
    view.current = v;
    if (editorRef) editorRef.current = {
      getValue: () => v.state.doc.toString(),
      setValue: (text) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }),
    };
    return () => v.destroy();
  }, []);

  // Value-prop is a seed AND an external-switch sync (opening a different
  // deliverable). Only dispatch when the incoming value truly differs from the
  // current doc, so typing (which flows out via onChange) is never clobbered.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (value !== cur) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div class="fabry-arch-md" ref={host} />;
}
```

- [ ] **Step 4: Run test, verify pass** — `npx vitest run tests/fabry-architect-markdown-editor.test.js` → PASS.
- [ ] **Step 5: Stage** — `git add src/fabry/architect/components/MarkdownEditor.jsx tests/fabry-architect-markdown-editor.test.js`

---

### Task V4: `ArchitectSidebar.jsx` (deliverable list in the sidebar)

**Files:**
- Create: `src/fabry/architect/components/ArchitectSidebar.jsx`
- Test: `tests/fabry-architect-sidebar.test.js`

**Interfaces produced:** default `ArchitectSidebar()` — mounts `loadArchitect`; header with **Run all ▷**/Stop + progress count; "＋ New deliverable"; a row per deliverable (title + status dot; active highlight; click → openDeliverable).
**Consumes:** `store` (deliverables/activeId/results/running/loadError), `actions` (loadArchitect/addDeliverable/openDeliverable/runAll/stopRun), `format.deliverableTitle`.

- [ ] **Step 1: Write failing test** — `tests/fabry-architect-sidebar.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  addDeliverable: vi.fn(), openDeliverable: vi.fn(), runAll: vi.fn(), stopRun: vi.fn(),
}));
import * as actions from '../src/fabry/architect/actions.js';
import * as store from '../src/fabry/architect/store.js';
import ArchitectSidebar from '../src/fabry/architect/components/ArchitectSidebar.jsx';
const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() { const root = document.createElement('div'); document.body.appendChild(root); render(h(ArchitectSidebar, null), root); return root; }
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.activeId.value = null;
  store.loaded.value = true; store.loadError.value = null; store.running.value = false;
});

describe('ArchitectSidebar', () => {
  it('loads on mount', async () => { mount(); await flush(); expect(actions.loadArchitect).toHaveBeenCalled(); });
  it('renders a row per deliverable with a title', () => {
    store.deliverables.value = [{ id: 'a', text: '# VAT', order: 1 }, { id: 'b', text: 'plain', order: 2 }];
    const root = mount();
    const rows = root.querySelectorAll('.fabry-arch-item');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toMatch(/VAT/);
  });
  it('marks the active row and click opens a deliverable', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    store.activeId.value = 'a';
    const root = mount();
    expect(root.querySelector('.fabry-arch-item.active')).toBeTruthy();
    root.querySelector('.fabry-arch-item').click();
    expect(actions.openDeliverable).toHaveBeenCalledWith('a');
  });
  it('renders status dots by verdict + running spinner + stale', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }, { id: 'c', text: 'C', order: 3 }];
    store.results.value = { a: { verdict: 'pass', stale: false }, b: { running: true }, c: { verdict: 'fail', stale: true } };
    const root = mount();
    const dots = root.querySelectorAll('.fabry-arch-dot');
    expect(dots[0].className).toMatch(/pass/);
    expect(root.querySelector('.fabry-arch-dot.running')).toBeTruthy();
    expect(root.querySelector('.fabry-arch-dot.stale')).toBeTruthy();
  });
  it('New deliverable + Run all wire to actions; Run disabled when empty', () => {
    const root = mount();
    expect(root.querySelector('.fabry-arch-runall').disabled).toBe(true);
    root.querySelector('.fabry-arch-new').click();
    expect(actions.addDeliverable).toHaveBeenCalled();
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }];
    const root2 = mount();
    root2.querySelector('.fabry-arch-runall').click();
    expect(actions.runAll).toHaveBeenCalled();
  });
  it('while running the Run-all control shows Stop with a progress count', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1 }, { id: 'b', text: 'B', order: 2 }];
    store.results.value = { a: { verdict: 'pass', stale: false, running: false } };
    store.running.value = true;
    const root = mount();
    const btn = root.querySelector('.fabry-arch-runall');
    expect(btn.textContent).toMatch(/stop/i);
    btn.click();
    expect(actions.stopRun).toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-progress').textContent).toMatch(/1\s*\/\s*2/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — module missing.

- [ ] **Step 3: Implement `src/fabry/architect/components/ArchitectSidebar.jsx`**

```jsx
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect, addDeliverable, openDeliverable, runAll, stopRun } from '../actions.js';
import { deliverableTitle } from '../format.js';

function dotClass(r) {
  if (!r) return 'none';
  if (r.running) return 'running';
  if (r.verdict === 'pass') return 'pass' + (r.stale ? ' stale' : '');
  if (r.verdict === 'fail') return 'fail' + (r.stale ? ' stale' : '');
  if (r.verdict === 'uncertain') return 'uncertain' + (r.stale ? ' stale' : '');
  return 'none';
}

export default function ArchitectSidebar() {
  useEffect(() => { loadArchitect(); }, []);
  const ds = store.deliverables.value;
  const results = store.results.value;
  const running = store.running.value;
  const done = Object.values(results).filter((r) => r && !r.running && r.verdict).length;

  return (
    <div class="fabry-arch-side">
      <div class="fabry-arch-side-head">
        <button
          type="button"
          class="fabry-arch-runall"
          disabled={!running && ds.length === 0}
          onClick={() => (running ? stopRun() : runAll())}
        >
          {running ? 'Stop' : 'Run all ▷'}
        </button>
        {(running || done > 0) && <span class="fabry-arch-progress">{done}{' / '}{ds.length} checked</span>}
      </div>
      <button type="button" class="fabry-arch-new" onClick={() => addDeliverable()}>{'＋ New deliverable'}</button>
      {store.loadError.value && <div class="fabry-arch-error">{store.loadError.value}</div>}
      <div class="fabry-arch-list">
        {ds.length === 0 && <div class="fabry-arch-empty">No deliverables yet.</div>}
        {ds.map((d) => (
          <button
            type="button"
            key={d.id}
            class={'fabry-arch-item' + (store.activeId.value === d.id ? ' active' : '')}
            onClick={() => openDeliverable(d.id)}
          >
            <span class={'fabry-arch-dot ' + dotClass(results[d.id])} />
            <span class="fabry-arch-item-title">{deliverableTitle(d.text)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify pass** — `npx vitest run tests/fabry-architect-sidebar.test.js` → PASS.
- [ ] **Step 5: Stage** — `git add src/fabry/architect/components/ArchitectSidebar.jsx tests/fabry-architect-sidebar.test.js`

---

### Task V5: `DeliverableEditor.jsx` + `ArchitectApp.jsx` (open-deliverable pane)

**Files:**
- Create: `src/fabry/architect/components/DeliverableEditor.jsx`
- Rewrite: `src/fabry/architect/components/ArchitectApp.jsx`
- Test: `tests/fabry-architect-app.test.js` (rewrite)

**Interfaces produced:** `ArchitectApp` renders `DeliverableEditor` when `store.activeId` is set (and the deliverable exists), else a placeholder. `DeliverableEditor({ deliverable })` — status chip + stale note + Re-run + `MarkdownEditor` (debounced `updateDeliverable`) + Delete + result details (evidence via FabryMarkdown + view-investigation).
**Consumes:** `store`, `actions` (updateDeliverable/deleteDeliverable/reRun/stopRun), `MarkdownEditor`, `format.relativeTime`, fabry `store.setFabryMode` + `chat.openChat`, `FabryMarkdown`.

- [ ] **Step 1: Write failing test** — `tests/fabry-architect-app.test.js` (rewrite; mock MarkdownEditor + actions + chat):
```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined),
  updateDeliverable: vi.fn(), deleteDeliverable: vi.fn(), reRun: vi.fn(), stopRun: vi.fn(),
}));
vi.mock('../src/fabry/architect/components/MarkdownEditor.jsx', () => ({
  default: ({ value, onChange }) => h('textarea', { class: 'md-mock', value, onInput: (e) => onChange && onChange(e.currentTarget.value) }),
}));
vi.mock('../src/fabry/chat.js', () => ({ openChat: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import * as astore from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import * as chat from '../src/fabry/chat.js';
import ArchitectApp from '../src/fabry/architect/components/ArchitectApp.jsx';
const flush = () => new Promise((r) => setTimeout(r, 0));
function mount() { const root = document.createElement('div'); document.body.appendChild(root); render(h(ArchitectApp, null), root); return root; }
beforeEach(() => {
  vi.clearAllMocks();
  astore.deliverables.value = []; astore.results.value = {}; astore.activeId.value = null;
  astore.loaded.value = true; astore.running.value = false; astore.loadError.value = null;
  fstore.fabryMode.value = 'architect';
});

describe('ArchitectApp', () => {
  it('loads on mount and shows a placeholder when nothing is open', async () => {
    const root = mount(); await flush();
    expect(actions.loadArchitect).toHaveBeenCalled();
    expect(root.querySelector('.fabry-arch-placeholder')).toBeTruthy();
  });
  it('shows the editor for the active deliverable', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }];
    astore.activeId.value = 'a';
    const root = mount();
    expect(root.querySelector('.md-mock')).toBeTruthy();
  });
  it('editing the markdown calls updateDeliverable (debounced)', async () => {
    vi.useFakeTimers();
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    const ta = root.querySelector('.md-mock');
    ta.value = '# A edited'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(700);
    expect(actions.updateDeliverable).toHaveBeenCalledWith('a', '# A edited');
    vi.useRealTimers();
  });
  it('shows verdict + evidence + stale note and Re-run', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'fail', evidence: 'missing hook', chatId: 'c1', ranAt: 1, stale: true } };
    const root = mount();
    expect(root.querySelector('.fabry-arch-chip.fail')).toBeTruthy();
    expect(root.querySelector('.fabry-arch-stale')).toBeTruthy();
    expect(root.querySelector('.fabry-arch-evidence').textContent).toMatch(/missing hook/);
    root.querySelector('.fabry-arch-rerun').click();
    expect(actions.reRun).toHaveBeenCalledWith('a');
  });
  it('view-investigation switches to chat mode + opens the chat', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    astore.results.value = { a: { verdict: 'pass', evidence: 'ok', chatId: 'c1', ranAt: 1, stale: false } };
    const root = mount();
    root.querySelector('.fabry-arch-viewchat').click();
    expect(fstore.fabryMode.value).toBe('chat');
    expect(chat.openChat).toHaveBeenCalledWith('c1');
  });
  it('Delete calls deleteDeliverable', () => {
    astore.deliverables.value = [{ id: 'a', text: '# A', order: 1 }]; astore.activeId.value = 'a';
    const root = mount();
    root.querySelector('.fabry-arch-del').click();
    expect(actions.deleteDeliverable).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

- [ ] **Step 3: Implement `src/fabry/architect/components/DeliverableEditor.jsx`**

```jsx
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import * as store from '../store.js';
import * as fstore from '../../store.js';
import { openChat } from '../../chat.js';
import { updateDeliverable, deleteDeliverable, reRun, stopRun } from '../actions.js';
import { relativeTime } from '../format.js';
import MarkdownEditor from './MarkdownEditor.jsx';
import FabryMarkdown from '../../../ui/fabry/FabryMarkdown.jsx';

const CHIP = { pass: { cls: 'pass', label: '✓ Met' }, fail: { cls: 'fail', label: '✗ Not met' }, uncertain: { cls: 'uncertain', label: '? Uncertain' } };

export default function DeliverableEditor({ deliverable }) {
  const result = store.results.value[deliverable.id];
  const timer = useRef(null);
  const latest = useRef(deliverable.text);

  // Debounce persistence of edits; flush any pending edit on unmount / switch.
  // Null the timer after clearing it, so a deliverable the user only VIEWED
  // (never edited) can't re-fire a stale flush on a later switch. timer.current
  // is truthy only for a pending edit of the CURRENT deliverable.
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; updateDeliverable(deliverable.id, latest.current); } }, [deliverable.id]);

  function onChange(text) {
    latest.current = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; updateDeliverable(deliverable.id, text); }, 600);
  }
  function viewChat() { if (!result?.chatId) return; fstore.setFabryMode('chat'); openChat(result.chatId); }

  const chip = result && !result.running ? CHIP[result.verdict] : null;
  const now = Date.now();

  return (
    <div class="fabry-arch-editor">
      <div class="fabry-arch-editor-head">
        <div class="fabry-arch-status">
          {result?.running && <span class="fabry-arch-chip running"><span class="fabry-arch-spin" />{'Checking…'}</span>}
          {chip && <span class={'fabry-arch-chip ' + chip.cls}>{chip.label}</span>}
          {chip && result.stale && (
            <span class="fabry-arch-stale">{'· last checked '}{relativeTime(result.ranAt, now) || 'previously'}{' · may be outdated — re-run'}</span>
          )}
        </div>
        <div class="fabry-arch-editor-actions">
          <button type="button" class="fabry-arch-rerun" onClick={() => (result?.running ? stopRun() : reRun(deliverable.id))}>
            {result?.running ? 'Stop' : 'Re-run ▷'}
          </button>
          <button type="button" class="fabry-arch-del" title="Delete deliverable" onClick={() => deleteDeliverable(deliverable.id)}>{'Delete'}</button>
        </div>
      </div>
      <div class="fabry-arch-editor-body">
        <MarkdownEditor key={deliverable.id} value={deliverable.text} onChange={onChange} />
      </div>
      {result && !result.running && result.verdict && (
        <div class="fabry-arch-details">
          <div class="fabry-arch-evidence"><FabryMarkdown text={result.evidence || '(no evidence returned)'} streaming={false} /></div>
          {result.chatId && <button type="button" class="fabry-arch-viewchat" onClick={viewChat}>{'View investigation →'}</button>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `src/fabry/architect/components/ArchitectApp.jsx`**

```jsx
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadArchitect } from '../actions.js';
import DeliverableEditor from './DeliverableEditor.jsx';

export default function ArchitectApp() {
  useEffect(() => { loadArchitect(); }, []);
  const active = store.deliverables.value.find((d) => d.id === store.activeId.value);
  return (
    <div class="fabry-arch">
      {active ? (
        <DeliverableEditor deliverable={active} />
      ) : (
        <div class="fabry-arch-placeholder">
          <p class="fabry-arch-placeholder-title">SOW deliverables</p>
          <p class="fabry-arch-placeholder-sub">Select a deliverable from the sidebar, or add one, then Run to check it read-only against this organization.</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test, verify pass** — `npx vitest run tests/fabry-architect-app.test.js` → PASS.
- [ ] **Step 6: Stage** — `git add src/fabry/architect/components/DeliverableEditor.jsx src/fabry/architect/components/ArchitectApp.jsx tests/fabry-architect-app.test.js`

---

### Task V6: Sidebar wiring + remove v1 row components + CSS

**Files:**
- Modify: `src/fabry/components/Sidebar.jsx` (render `ArchitectSidebar` in architect mode)
- Delete: `src/fabry/architect/components/RequirementRow.jsx`, `src/fabry/architect/components/RequirementAdd.jsx`
- Modify: `src/console/console.css` (rework `.fabry-arch-*`: sidebar list/dots/blend + editor pane + staleness; keep `.fabry-mode-*`, `.fabry-arch-spin`, `.fabry-arch-chip*`)
- Modify: `tests/fabry-architect-wiring.test.js` (architect mode sidebar now shows the deliverable list)

**Interfaces consumed:** `store.fabryMode`, `ArchitectSidebar` default export.

- [ ] **Step 1: Update the wiring test** — replace the two architect-mode sidebar assertions in `tests/fabry-architect-wiring.test.js` so that in architect mode the sidebar renders the deliverable list container (mock ArchitectSidebar to a marker), keeping the App-swap + Chat-mode-intact assertions:

```js
// Add near the other vi.mock calls at top:
vi.mock('../src/fabry/architect/components/ArchitectSidebar.jsx', () => ({
  default: () => h('div', { class: 'arch-side-marker' }, 'SIDE'),
}));

// Replace the 'hides the chat list in architect mode' test with:
it('renders the deliverable sidebar (not the chat list) in architect mode', () => {
  store.fabryMode.value = 'architect';
  const root = mount(Sidebar);
  expect(root.querySelector('.fabry-chatlist')).toBeNull();
  expect(root.querySelector('.arch-side-marker')).toBeTruthy();
  expect(root.querySelector('.fabry-mode')).toBeTruthy();
});
```
(Keep the existing 'App pane swap' tests and the 'shows the chat list and New chat in chat mode' test unchanged — App.jsx already mocks ArchitectApp.)

- [ ] **Step 2: Run test, verify the new assertion fails** — `npx vitest run tests/fabry-architect-wiring.test.js` (the architect-mode sidebar has no `.arch-side-marker` yet).

- [ ] **Step 3: Wire `src/fabry/components/Sidebar.jsx`**

Add the import near the top:
```js
import ArchitectSidebar from '../architect/components/ArchitectSidebar.jsx';
```
In the expanded-sidebar return, replace the three `{!architect && (...)}` blocks (New-chat, chat-list, loading row) with: keep them gated on `!architect`, and add — immediately after the `.fabry-mode` toggle — an architect branch:
```jsx
      {architect ? (
        <ArchitectSidebar />
      ) : (
        <>
          <button type="button" class="fabry-newchat" onClick={startNewChat}>{'＋ New chat'}</button>
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
          {store.chatsLoading.value && <div class="fabry-chat-loadingrow">Loading{'…'}</div>}
        </>
      )}
      <div class="fabry-side-resizer" title="Drag to resize" onMouseDown={startResize} />
```
The chat-mode markup inside the Fragment is BYTE-IDENTICAL to the current `!architect`-gated blocks — do not alter it, only regroup it under the `architect ? ... : <>...</>` conditional. Ensure `import { h, Fragment } from 'preact';` (Fragment is needed for `<>`).

- [ ] **Step 4: Delete the retired v1 components**
```bash
git rm src/fabry/architect/components/RequirementRow.jsx src/fabry/architect/components/RequirementAdd.jsx
```
(If already unstaged-new from v1 staging, use `rm` + `git add -A src/fabry/architect/components/`.)

- [ ] **Step 5: Rework `.fabry-arch-*` CSS in `src/console/console.css`**

Replace the v1 Architect block (the `/* ── Fabry Architect ── */` section) with the v2 rules below. KEEP `.fabry-mode*` (from wiring), and KEEP `.fabry-arch-spin` + `.fabry-arch-chip`/`.pass`/`.fail`/`.uncertain`/`.running` (reused). Only existing `:root` tokens; the active-row blend uses `--bg-card` to match the editor surface.

```css
/* ── Fabry Architect (v2) ─────────────────────────────────────────────── */
/* Sidebar deliverable list */
.fabry-arch-side { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.fabry-arch-side-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 8px; }
.fabry-arch-runall { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 12px; font-weight: 600; font-size: 12.5px; cursor: pointer; }
.fabry-arch-runall:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.fabry-arch-runall:disabled { opacity: 0.5; cursor: default; }
.fabry-arch-progress { font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.fabry-arch-new { border: 1px dashed var(--border); color: var(--accent); background: none; border-radius: 8px; padding: 7px 10px; font-weight: 600; font-size: 12.5px; cursor: pointer; text-align: left; margin: 0 4px 8px; }
.fabry-arch-new:hover { background: var(--bg-hover); border-style: solid; }
.fabry-arch-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; overscroll-behavior: none; }
.fabry-arch-empty { color: var(--text-secondary); font-size: 12.5px; padding: 8px 6px; }
.fabry-arch-item { display: flex; align-items: center; gap: 8px; text-align: left; border: none; background: none; color: var(--text-primary); font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px 0 0 8px; cursor: pointer; margin-right: -1px; }
.fabry-arch-item:hover { background: var(--bg-hover); }
/* Active row blends into the editor: same --bg-card surface, no right seam. */
.fabry-arch-item.active { background: var(--bg-card); border-radius: 8px 0 0 8px; position: relative; z-index: 1; }
.fabry-arch-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fabry-arch-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--border); }
.fabry-arch-dot.pass { background: var(--success); }
.fabry-arch-dot.fail { background: var(--danger); }
.fabry-arch-dot.uncertain { background: var(--warning); }
.fabry-arch-dot.stale { box-shadow: inset 0 0 0 2px var(--bg-card); opacity: 0.75; } /* hollow = outdated */
.fabry-arch-dot.running { background: var(--accent); animation: spin 0.7s linear infinite; border-top-color: transparent; }

/* Main pane: editor blends from the active sidebar row (shared --bg-card) */
.fabry-arch { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-card); }
.fabry-arch-placeholder { margin: auto; max-width: 420px; text-align: center; color: var(--text-secondary); padding: 24px; }
.fabry-arch-placeholder-title { font-size: 15px; font-weight: 650; color: var(--text-primary); margin: 0 0 4px; }
.fabry-arch-placeholder-sub { font-size: 13px; margin: 0; }
.fabry-arch-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.fabry-arch-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); flex: none; }
.fabry-arch-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fabry-arch-stale { font-size: 11.5px; color: var(--warning-fg); }
.fabry-arch-editor-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.fabry-arch-rerun { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 12px; font-weight: 600; font-size: 12.5px; cursor: pointer; }
.fabry-arch-rerun:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.fabry-arch-del { border: 1px solid var(--border); background: none; color: var(--text-secondary); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
.fabry-arch-del:hover { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger); }
.fabry-arch-editor-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 18px; }
.fabry-arch-md { height: 100%; }
.fabry-arch-md .cm-editor { height: 100%; }
.fabry-arch-details { border-top: 1px solid var(--border); padding: 12px 18px; max-height: 40%; overflow: auto; flex: none; }
.fabry-arch-evidence { font-size: 13px; }
.fabry-arch-viewchat { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 12.5px; font-weight: 600; padding: 6px 0 0; }
.fabry-arch-viewchat:hover { text-decoration: underline; }
.fabry-arch-error { background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger); border-radius: 8px; padding: 6px 10px; margin: 0 4px 8px; font-size: 12px; }
/* Reused v1 rules kept: .fabry-arch-chip(.pass/.fail/.uncertain/.running), .fabry-arch-spin */
.fabry-arch-chip { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600; background: var(--bg-hover); }
.fabry-arch-chip.pass { background: var(--success-bg); color: var(--success-fg); border-color: var(--success); }
.fabry-arch-chip.fail { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger); }
.fabry-arch-chip.uncertain { background: var(--warning-bg); color: var(--warning-fg); border-color: var(--warning); }
.fabry-arch-chip.running { color: var(--text-secondary); }
.fabry-arch-spin { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; margin-right: 6px; vertical-align: -1px; }
```
(Confirm exactly one `@keyframes spin` remains in the file — reuse it; do not add a duplicate. Do not modify any non-`.fabry-arch-*` rule.)

- [ ] **Step 6: Run affected tests + existing Fabry suites**
Run: `npx vitest run tests/fabry-architect-wiring.test.js tests/fabry-app.test.js tests/fabry-sidebar.test.js tests/fabry-chat.test.js`
Expected: PASS (architect sidebar marker present; chat mode intact).

- [ ] **Step 7: Stage** — `git add -A src/fabry/components/Sidebar.jsx src/fabry/architect/components/ src/console/console.css tests/fabry-architect-wiring.test.js`

---

## Controller steps after V6 (not a subagent task)
- Full suite `npx vitest run` (all green, including the removed v1 app-test rewrite).
- `npm run build`; gates: `grep -c __mrfabry_architect dist/console/console.js` ≥1, `grep -c mcp_mode dist/console/console.js` == 0; confirm `@codemirror/lang-markdown` bundled (no esbuild error).
- Update `CLAUDE.md` Architect bullet (deliverables-in-sidebar, CodeMirror MD editor, persisted+stale results) + note `@codemirror/lang-markdown` in Dependencies.
- Final whole-branch review (opus) over the full v1+v2 diff.

## Self-Review
- Spec coverage: sidebar list (V4) ✓; open-to-edit CodeMirror MD (V3+V5) ✓; run progress in sidebar (V4) ✓; details on open (V5) ✓; remember last run + staleness (V1 api/store + V2 actions + V5 display) ✓; blend active row → editor (V6 CSS `--bg-card`) ✓; read-only preserved (V2 test) ✓; chat byte-identical (V6 + existing suites) ✓.
- Type consistency: `deliverables {id,text,order}` + `results[id] {verdict,evidence,chatId,ranAt,running?,stale?,error?}` consistent across api/store/actions/components. `loadDeliverables → {deliverables,results}` matches actions.loadArchitect destructure. `saveResult(id,{verdict,evidence,chatId,ranAt})` matches actions.persist. `deliverableTitle`/`relativeTime` signatures match callers.
- No placeholders; every code step complete.
