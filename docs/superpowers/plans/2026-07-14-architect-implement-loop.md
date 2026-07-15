# Architect ralph-style "Implement" loop — Implementation Plan

> **STATUS: IMPLEMENTED & SHIPPED — this plan is a historical build record.** It
> captured the ORIGINAL approach; the shipped design deviated in several load-bearing
> ways. The **authoritative final design** is
> `docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md` (consolidated).
> Key deviations from this plan: **task decomposition was added** (this plan's
> whole-deliverable single chat was replaced by a plan→task-loop→roll-up state machine);
> **`allowedOps` / write-scope / `suggestScope` / `screenOp` were removed** (replaced by
> instruction guardrails); the gate is a **double** gate (experimental + Arm, ON by
> default — the popup kill-switch was removed), not triple; and write-enablement moved
> from `createChat({ write })` to the **message body** `streamMessage({ mcpMode })`.
> Read the consolidated spec, not this plan, for current behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-native, ralph-style autonomous loop to the Fabry Architect app that implements each SOW deliverable against the live org (write-enabled agent) and verifies with the existing read-only check, until each deliverable passes or bounds trip.

**Architecture:** Additive to the shipped Architect (`src/fabry/architect/`). New pure modules — `implement.js` (prompts), `audit.js` (write audit + scope screen), `implementLoop.js` (bounded sequential loop) — plus glue in `actions.js`/`store.js`/`api.js`, one narrow transport opt-in in `src/agent/agentApi.js`, a triple gate (existing `experimentalUnlocked` + new default-OFF popup kill-switch + per-run Arm dialog), and UI in the sidebar + deliverable editor. The read-only check is unchanged and stays the default.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE), Vitest (jsdom for components), the Rossum Agent API (AI-SDK data-stream), MDH Data Storage client.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md` — every task implicitly includes it.
- **Write-enablement is a SINGLE call site.** `mcp_mode:"read-write"` is sent ONLY by `agentApi.createChat({ write:true })`, called only from the implement path. `createChat()` with no arg MUST stay byte-identical to today (`body: '{}'`). No other Fabry surface (check, refine, chat, deep-verify, Inspector, MDH, annotate-for-me) changes.
- **Implement chat uses the DEFAULT persona with NO `/persona` priming** (priming `cautious` would re-introduce the per-write gate we deliberately turned off). The read-only check keeps its `/persona cautious` priming.
- **Triple gate:** `experimentalUnlocked` (existing) AND a new popup kill-switch **`fabryArchitectImplementEnabled`, DEFAULT OFF** (only a stored `true` reveals the implement surface; mirrored live via `chrome.storage.onChanged`) AND the per-run **Arm** confirm.
- **Bounds (hard):** `maxAttempts = 3` per deliverable, `maxTotalWrites = 50` global. Implement runs **sequentially** (concurrency 1 — org writes must not race). Journal cap `JOURNAL_CAP = 10`.
- **Write scope:** per-deliverable `allowedOps` (array of agent tool-name strings, e.g. `['create_rule','patch_schema']`). A write tool NOT in `allowedOps` is out-of-scope → the loop aborts that turn and marks the deliverable `blocked`. Honest limit: the client sees a tool call only after it fired, so this stops-after, it does not prevent the single offending call.
- **Data Storage doc fields are all OPTIONAL / back-compat.** v1 docs (no new fields) MUST load unchanged. No storage key changes meaning.
- **Privacy — never leak customer names/data.** All prompts, examples, and tests use GENERIC Rossum content only (queues/hooks/rules/schema-fields/VAT etc.), never a customer name.
- **Vitest convention:** tests are `.test.js` and construct components via `h(Component, props)` — raw JSX in `.test.js` breaks the oxc parser. Component tests start with `// @vitest-environment jsdom`.
- **Commit policy (repo owner):** do NOT commit per task. Each task ends with a **Checkpoint** (run its tests green). A SINGLE commit is made only at the very end, and only when the owner asks (Task 13). Rebuild `dist/` after UI/CSS changes (`npm run build`) — tests run `src/` but the loaded extension runs `dist/`.
- **Run one test file:** `npx vitest run tests/<file>` . Full suite: `npm test`.

---

### Task 1: Transport — `createChat({ write })` write opt-in

**Files:**
- Modify: `src/agent/agentApi.js:46-53`
- Test: `tests/agent-api-createchat.test.js` (create)

**Interfaces:**
- Produces: `createChat({ write } = {}) → Promise<string>` — POSTs `{ mcp_mode:'read-write' }` when `write===true`, else `{}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agent-api-createchat.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as agentApi from '../src/agent/agentApi.js';

beforeEach(() => { agentApi.init('https://x.rossum.app', 'tok'); });

describe('createChat write opt-in', () => {
  it('sends an empty body by default (read-only, unchanged)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ chat_id: 'c1' }) });
    global.fetch = fetchMock;
    await agentApi.createChat();
    expect(fetchMock.mock.calls[0][1].body).toBe('{}');
  });
  it('sends mcp_mode:read-write when { write:true }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ chat_id: 'c2' }) });
    global.fetch = fetchMock;
    await agentApi.createChat({ write: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ mcp_mode: 'read-write' });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/agent-api-createchat.test.js`
Expected: FAIL (default posts `'{}'` today so test 1 passes, but test 2 fails — `createChat` ignores the arg and posts `'{}'`).

- [ ] **Step 3: Implement**

Replace `src/agent/agentApi.js:46-53` (keep the guard comment above it, updated):

```js
// POST /chats — new chat session. Write-enablement is a DELIBERATE, single-call-
// site decision: createChat({write:true}) sends mcp_mode:"read-write" (enables
// write-tagged MCP tools server-side) and is used ONLY by the Architect implement
// loop. Every other caller uses createChat() → {} → the server's read-only default.
export async function createChat({ write } = {}) {
  const res = await fetch(`${AGENT_BASE}/chats`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(write ? { mcp_mode: 'read-write' } : {}),
  });
  if (!res.ok) throw agentError(res.status);
  const data = await res.json();
  return data.chat_id;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/agent-api-createchat.test.js` → PASS.

- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-chat.test.js tests/fabry-deeploop.test.js` still green (existing `createChat()` callers unaffected).

---

### Task 2: `implement.js` — pure prompts + scope parse

**Files:**
- Create: `src/fabry/architect/implement.js`
- Test: `tests/fabry-architect-implement.test.js` (create)

**Interfaces:**
- Produces:
  - `buildImplementPrompt(deliverable, { allowedOps, journal }) → string`
  - `buildScopePrompt(deliverable) → string`
  - `parseScope(text) → string[]`

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement.test.js
import { describe, it, expect } from 'vitest';
import { buildImplementPrompt, buildScopePrompt, parseScope } from '../src/fabry/architect/implement.js';

describe('buildImplementPrompt', () => {
  it('states the allowed write ops, carries journal learnings + the requirement', () => {
    const p = buildImplementPrompt('Add a VAT rule', {
      allowedOps: ['create_rule', 'patch_schema'],
      journal: [{ attempt: 1, summary: 'created rule X', verdict: 'fail', learnings: 'rule did not fire' }],
    });
    expect(p).toMatch(/ONLY these write operations: create_rule, patch_schema/);
    expect(p).toMatch(/attempt 1: created rule X/);
    expect(p).toMatch(/rule did not fire/);
    expect(p).toMatch(/REQUIREMENT:\nAdd a VAT rule/);
  });
  it('with no allowedOps, forbids writing', () => {
    expect(buildImplementPrompt('x', { allowedOps: [] })).toMatch(/do not write anything/i);
  });
});
describe('buildScopePrompt / parseScope', () => {
  it('scope prompt is read-only and asks for a JSON array', () => {
    const p = buildScopePrompt('Add a VAT rule');
    expect(p).toMatch(/READ-ONLY/i);
    expect(p).toMatch(/JSON array/i);
  });
  it('parseScope extracts a string array, ignoring prose + non-strings', () => {
    expect(parseScope('Sure: ["create_rule", "patch_schema", 5]')).toEqual(['create_rule', 'patch_schema']);
    expect(parseScope('no array here')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module implement.js`).

- [ ] **Step 3: Implement**

```js
// src/fabry/architect/implement.js
// Pure prompt builders for the Architect IMPLEMENT loop (write-enabled) + the
// read-only scope suggestion. No network, no DOM. Mirrors check.js.

export function buildImplementPrompt(deliverable, { allowedOps = [], journal = [] } = {}) {
  const ops = allowedOps.length ? allowedOps.join(', ') : '(none — do not write anything)';
  const lines = [
    'You are implementing a single requirement from a Statement of Work (SOW) against a live Rossum organization.',
    'Using YOUR TOOLS, make the organization satisfy this requirement.',
    `You MAY use ONLY these write operations: ${ops}. Never use any other create/update/patch/delete/upload operation. Reads are always allowed.`,
    'Do the minimum necessary; never delete or modify anything unrelated to this requirement.',
  ];
  if (journal.length) {
    lines.push('', 'PREVIOUS ATTEMPTS (learn from these — do not repeat what failed):');
    for (const j of journal) {
      lines.push(`- attempt ${j.attempt}: ${j.summary || '(no summary)'} → verdict ${j.verdict || 'unknown'}. ${j.learnings || ''}`.trim());
    }
  }
  lines.push('', 'When done, briefly summarize exactly what you changed (the resources you created or patched).', '', `REQUIREMENT:\n${deliverable}`);
  return lines.join('\n');
}

export function buildScopePrompt(deliverable) {
  return [
    'You are scoping the WRITE operations needed to implement one SOW requirement in a Rossum organization.',
    'List ONLY the agent write-tool names you would need (e.g. create_rule, patch_schema, create_hook, patch_queue). Do NOT include read tools.',
    'Reply with ONLY a JSON array of tool-name strings, nothing else. Stay READ-ONLY — do not make any changes now.',
    '',
    `REQUIREMENT:\n${deliverable}`,
  ].join('\n');
}

export function parseScope(text) {
  const m = String(text ?? '').match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — file green.

---

### Task 3: `audit.js` — write classifier, scope screen, stream folder

**Files:**
- Create: `src/fabry/architect/audit.js`
- Test: `tests/fabry-architect-audit.test.js` (create)

**Interfaces:**
- Produces:
  - `isWriteTool(name) → boolean`
  - `screenOp(tool, allowedOps) → { allowed:true } | { allowed:false, offending }`
  - `summarizeArgs(input) → string` (redacted one-liner)
  - `makeAuditFolder(allowedOps, { now }) → { writes:[{tool,argsSummary,ok,at}], feed(ev) → { offending } | null }`

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-audit.test.js
import { describe, it, expect } from 'vitest';
import { isWriteTool, screenOp, summarizeArgs, makeAuditFolder } from '../src/fabry/architect/audit.js';

describe('isWriteTool', () => {
  it('classifies writes vs reads', () => {
    expect(isWriteTool('create_rule')).toBe(true);
    expect(isWriteTool('patch_schema')).toBe(true);
    expect(isWriteTool('delete_queue')).toBe(true);
    expect(isWriteTool('get_queue')).toBe(false);
    expect(isWriteTool('list_hooks')).toBe(false);
    expect(isWriteTool('data_storage_aggregate')).toBe(false);
  });
});
describe('screenOp', () => {
  it('allows reads and in-scope writes; flags out-of-scope writes', () => {
    expect(screenOp('get_queue', [])).toEqual({ allowed: true });
    expect(screenOp('create_rule', ['create_rule'])).toEqual({ allowed: true });
    expect(screenOp('delete_queue', ['create_rule'])).toEqual({ allowed: false, offending: 'delete_queue' });
  });
});
describe('summarizeArgs', () => {
  it('redacts to a short name/#id, never a full payload', () => {
    expect(summarizeArgs({ name: 'VAT rule', id: 42, secret: 'x'.repeat(500) })).toBe('VAT rule #42');
  });
});
describe('makeAuditFolder', () => {
  it('records write tool calls (name + args + ok) and ignores reads', () => {
    const f = makeAuditFolder(['create_rule'], { now: () => 7 });
    expect(f.feed({ type: 'tool-input-start', toolCallId: 't1', toolName: 'get_queue' })).toBeNull();
    expect(f.feed({ type: 'tool-input-start', toolCallId: 't2', toolName: 'create_rule' })).toBeNull();
    f.feed({ type: 'tool-input-available', toolCallId: 't2', input: { name: 'VAT' } });
    f.feed({ type: 'tool-output-available', toolCallId: 't2', output: 'ok' });
    expect(f.writes).toEqual([{ tool: 'create_rule', argsSummary: 'VAT', ok: true, at: 7 }]);
  });
  it('returns { offending } the moment an out-of-scope write appears', () => {
    const f = makeAuditFolder(['create_rule'], { now: () => 0 });
    expect(f.feed({ type: 'tool-input-start', toolCallId: 't1', toolName: 'delete_queue' })).toEqual({ offending: 'delete_queue' });
    expect(f.writes[0]).toMatchObject({ tool: 'delete_queue', ok: null });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing module).

- [ ] **Step 3: Implement**

```js
// src/fabry/architect/audit.js
// Pure: classify + audit the Agent API's write tool calls and screen them against
// a per-deliverable allowedOps allowlist. Reads are always allowed. Fed the RAW
// stream events (agentStream.foldEvents drops tool input/output). No network/DOM.

const WRITE_RE = /^(create|update|patch|delete|bulk_update|confirm|start|upload|prune|copy|drop|insert|replace|rename|refire|invoke|test_hook)/i;
const READ_RE = /^(get|list|search|find|aggregate|read|fetch|whoami|healthz|render|generate|extract|validate)/i;

export function isWriteTool(name) {
  return typeof name === 'string' && WRITE_RE.test(name) && !READ_RE.test(name);
}

export function screenOp(tool, allowedOps = []) {
  if (!isWriteTool(tool)) return { allowed: true };
  return allowedOps.includes(tool) ? { allowed: true } : { allowed: false, offending: tool };
}

export function summarizeArgs(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input).slice(0, 60);
  const id = input.id ?? input.queue_id ?? input.hook_id ?? input.schema_id ?? input.rule_id ?? input.engine_id;
  const name = input.name ?? input.username ?? (input.content && input.content.name);
  const parts = [];
  if (name) parts.push(String(name));
  if (id != null) parts.push('#' + id);
  return parts.join(' ').slice(0, 80);
}

export function makeAuditFolder(allowedOps = [], { now = () => Date.now() } = {}) {
  const byId = new Map();   // toolCallId → { tool, entry|null }
  const writes = [];
  return {
    writes,
    feed(ev) {
      if (!ev || typeof ev.type !== 'string') return null;
      const { type, toolCallId } = ev;
      if (type === 'tool-input-start' || type === 'tool-input-available') {
        let e = byId.get(toolCallId);
        if (!e) { e = { tool: ev.toolName || '', entry: null }; byId.set(toolCallId, e); }
        if (ev.toolName && !e.tool) e.tool = ev.toolName;
        if (isWriteTool(e.tool) && !e.entry) { e.entry = { tool: e.tool, argsSummary: '', ok: null, at: now() }; writes.push(e.entry); }
        if (type === 'tool-input-available' && e.entry) e.entry.argsSummary = summarizeArgs(ev.input);
        const s = screenOp(e.tool, allowedOps);
        return s.allowed ? null : { offending: s.offending };
      }
      if (type === 'tool-output-available') { const e = byId.get(toolCallId); if (e && e.entry) e.entry.ok = true; return null; }
      return null;
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — file green.

---

### Task 4: `implementLoop.js` — bounded sequential loop

**Files:**
- Create: `src/fabry/architect/implementLoop.js`
- Test: `tests/fabry-architect-implement-loop.test.js` (create)

**Interfaces:**
- Consumes: nothing from other new modules (transport injected).
- Produces: `runImplement(deliverables, { implementOne, checkOne, onEvent, maxAttempts, maxTotalWrites, signal }) → Promise<void>`
  - `implementOne(d, { attempt, journal }) → { writes:[], summary, blocked?, chatId? } | null`
  - `checkOne(d) → { verdict, evidence, chatId } | null`
  - `onEvent(id, patch)` — patch keys: `status`, `attempt`, `running`, `writes`, `summary`, `verdict`, `done`, `error`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-loop.test.js
import { describe, it, expect, vi } from 'vitest';
import { runImplement } from '../src/fabry/architect/implementLoop.js';

const ds = (n) => Array.from({ length: n }, (_, i) => ({ id: 'd' + i, text: 't' + i }));
const collect = () => { const ev = {}; return { onEvent: (id, p) => { ev[id] = { ...(ev[id] || {}), ...p }; }, ev }; };

describe('runImplement', () => {
  it('passes on the first attempt: one implement + one check, status passing', async () => {
    const implementOne = vi.fn().mockResolvedValue({ writes: [{ tool: 'create_rule' }], summary: 's' });
    const checkOne = vi.fn().mockResolvedValue({ verdict: 'pass', evidence: 'ok', chatId: 'c' });
    const { onEvent, ev } = collect();
    await runImplement(ds(1), { implementOne, checkOne, onEvent });
    expect(implementOne).toHaveBeenCalledTimes(1);
    expect(checkOne).toHaveBeenCalledTimes(1);
    expect(ev.d0.status).toBe('passing');
  });
  it('retries with journal-seeded learnings, then passes', async () => {
    const implementOne = vi.fn()
      .mockResolvedValueOnce({ writes: [], summary: 'try1' })
      .mockResolvedValueOnce({ writes: [], summary: 'try2' });
    const checkOne = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fail', evidence: 'nope', chatId: 'c1' })
      .mockResolvedValueOnce({ verdict: 'pass', evidence: 'ok', chatId: 'c2' });
    const { onEvent, ev } = collect();
    await runImplement(ds(1), { implementOne, checkOne, onEvent });
    expect(implementOne).toHaveBeenCalledTimes(2);
    expect(implementOne.mock.calls[1][1].journal).toEqual([{ attempt: 1, summary: 'try1', verdict: 'fail', learnings: 'nope' }]);
    expect(ev.d0.status).toBe('passing');
  });
  it('exhausts maxAttempts → failed', async () => {
    const implementOne = vi.fn().mockResolvedValue({ writes: [], summary: 's' });
    const checkOne = vi.fn().mockResolvedValue({ verdict: 'fail', evidence: 'no', chatId: 'c' });
    const { onEvent, ev } = collect();
    await runImplement(ds(1), { implementOne, checkOne, onEvent, maxAttempts: 2 });
    expect(implementOne).toHaveBeenCalledTimes(2);
    expect(ev.d0.status).toBe('failed');
  });
  it('an out-of-scope write blocks the deliverable (no check)', async () => {
    const implementOne = vi.fn().mockResolvedValue({ writes: [], summary: '', blocked: 'delete_queue' });
    const checkOne = vi.fn();
    const { onEvent, ev } = collect();
    await runImplement(ds(1), { implementOne, checkOne, onEvent });
    expect(checkOne).not.toHaveBeenCalled();
    expect(ev.d0.status).toBe('blocked');
  });
  it('maxTotalWrites is a global circuit-breaker', async () => {
    const implementOne = vi.fn().mockResolvedValue({ writes: [{ tool: 'create_rule' }, { tool: 'create_rule' }], summary: 's' });
    const checkOne = vi.fn().mockResolvedValue({ verdict: 'fail', evidence: 'no', chatId: 'c' });
    const { onEvent, ev } = collect();
    await runImplement(ds(3), { implementOne, checkOne, onEvent, maxAttempts: 1, maxTotalWrites: 3 });
    // d0 uses 2 writes; d1 uses 2 (total 4 ≥ 3 after) → d2 never implemented.
    expect(implementOne).toHaveBeenCalledTimes(2);
    expect(ev.d2.status).toBe('blocked');
  });
  it('stops on abort', async () => {
    const ctrl = new AbortController();
    const implementOne = vi.fn().mockImplementation(async () => { ctrl.abort(); return { writes: [], summary: '' }; });
    const checkOne = vi.fn().mockResolvedValue({ verdict: 'pass', evidence: '', chatId: 'c' });
    const { onEvent } = collect();
    await runImplement(ds(3), { implementOne, checkOne, onEvent, signal: ctrl.signal });
    expect(implementOne).toHaveBeenCalledTimes(1);
  });
  it('isolates an implementOne throw as a failed attempt', async () => {
    const implementOne = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ writes: [], summary: 's' });
    const checkOne = vi.fn().mockResolvedValue({ verdict: 'pass', evidence: 'ok', chatId: 'c' });
    const { onEvent, ev } = collect();
    await runImplement(ds(1), { implementOne, checkOne, onEvent, maxAttempts: 2 });
    expect(ev.d0.status).toBe('passing');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing module).

- [ ] **Step 3: Implement**

```js
// src/fabry/architect/implementLoop.js
// Sequential, abort-aware, bounded implement loop for Architect deliverables.
// Pure: transport injected (implementOne/checkOne); state streams via onEvent(id,
// patch). Mirrors run.js but SEQUENTIAL (org writes must not race) with per-
// deliverable attempt retries + a global write budget. No network/DOM.

export async function runImplement(deliverables, {
  implementOne, checkOne, onEvent = () => {}, maxAttempts = 3, maxTotalWrites = 50, signal,
} = {}) {
  let totalWrites = 0;
  for (const d of deliverables) {
    if (signal && signal.aborted) return;
    if (totalWrites >= maxTotalWrites) { onEvent(d.id, { status: 'blocked', running: false, done: true, error: 'Write budget reached.' }); continue; }
    const journal = [];
    let status = 'failed';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal && signal.aborted) return;
      onEvent(d.id, { status: 'running', attempt, running: true, error: null });
      let impl;
      try { impl = await implementOne(d, { attempt, journal }); }
      catch (err) { impl = { writes: [], summary: '', error: err?.message || String(err) }; }
      if (signal && signal.aborted) return;
      if (impl == null) return;   // aborted mid-turn
      totalWrites += (impl.writes ? impl.writes.length : 0);
      onEvent(d.id, { writes: impl.writes || [], summary: impl.summary || '', chatId: impl.chatId });
      if (impl.blocked) { status = 'blocked'; onEvent(d.id, { status, running: false, error: `Out-of-scope operation: ${impl.blocked}` }); break; }
      let v;
      try { v = await checkOne(d); }
      catch (err) { v = { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null }; }
      if (signal && signal.aborted) return;
      if (v == null) return;
      onEvent(d.id, { verdict: v, running: false });
      if (v.verdict === 'pass') { status = 'passing'; break; }
      journal.push({ attempt, summary: impl.summary || '', verdict: v.verdict, learnings: v.evidence || '' });
      if (totalWrites >= maxTotalWrites) { status = 'blocked'; break; }
    }
    onEvent(d.id, { status, running: false, done: true, journal });
  }
}
```

- [ ] **Step 4: Run — expect PASS.** (Note the circuit-breaker test: d0 records 2 writes → totalWrites 2 < 3, d1 records 2 → totalWrites 4, journal push then breaks with `blocked`; d2 hits the top-of-loop guard `4 >= 3` → `blocked`, never implemented. `implementOne` called twice.)
- [ ] **Step 5: Checkpoint** — file green.

---

### Task 5: `store.js` — implement signals + helpers

**Files:**
- Modify: `src/fabry/architect/store.js` (append)
- Test: `tests/fabry-architect-implement-store.test.js` (create)

**Interfaces:**
- Produces: `implementRunning` (signal bool), `implement` (signal `{[id]:State}`), `setImplement(id, patch)`, `clearImplement(id)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-store.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/architect/store.js';

beforeEach(() => { store.implement.value = {}; store.implementRunning.value = false; });

describe('implement store', () => {
  it('setImplement merges a patch onto per-id state', () => {
    store.setImplement('a', { status: 'running', attempt: 1 });
    store.setImplement('a', { attempt: 2, writes: [{ tool: 'create_rule' }] });
    expect(store.implement.value.a).toMatchObject({ status: 'running', attempt: 2 });
    expect(store.implement.value.a.writes.length).toBe(1);
  });
  it('clearImplement removes one id', () => {
    store.setImplement('a', { status: 'passing' });
    store.clearImplement('a');
    expect(store.implement.value.a).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`implement` undefined).

- [ ] **Step 3: Implement** — append to `src/fabry/architect/store.js`:

```js
// --- Implement loop (ralph-style) state (spec 2026-07-14-architect-implement-loop) ---
// implement[id] = { status:'idle'|'running'|'passing'|'failed'|'blocked', attempt,
//   writes:[{tool,argsSummary,ok,at}], summary, chatId, journal, running, error }
export const implementRunning = signal(false);
export const implement = signal({});
export function setImplement(id, patch) {
  implement.value = { ...implement.value, [id]: { ...(implement.value[id] || {}), ...patch } };
}
export function clearImplement(id) { const rest = { ...implement.value }; delete rest[id]; implement.value = rest; }
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-architect-store.test.js` still green.

---

### Task 6: `api.js` — allowedOps + scope + implement-result persistence

**Files:**
- Modify: `src/fabry/architect/api.js`
- Test: `tests/fabry-architect-implement-api.test.js` (create)

**Interfaces:**
- Produces:
  - `loadDeliverables()` now also puts `allowedOps` on each deliverable and returns `implement` (a `{[id]:State}` map of persisted, stale results).
  - `saveScope(id, allowedOps) → Promise`
  - `saveImplementResult(id, { status, attempts, writes, summary, chatId, ranAt, journal }) → Promise` (journal capped to last `JOURNAL_CAP=10`).

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-api.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js', () => ({
  createCollection: vi.fn(), find: vi.fn(), insertOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn(),
}));
import * as mdh from '../src/mdh/api.js';
import * as api from '../src/fabry/architect/api.js';

beforeEach(() => vi.clearAllMocks());

describe('loadDeliverables (implement fields)', () => {
  it('maps allowedOps onto deliverables and returns persisted (stale) implement state', async () => {
    mdh.find.mockResolvedValue({ result: [
      { _id: 'a', kind: 'requirement', text: 'A', order: 1, allowedOps: ['create_rule'], implementStatus: 'passing', attempts: 2, implementRanAt: 5, lastImplementSummary: 'made rule', lastImplementWrites: [{ tool: 'create_rule', ok: true }] },
      { _id: 'b', kind: 'requirement', text: 'B', order: 2 },
    ] });
    const { deliverables, implement } = await api.loadDeliverables();
    expect(deliverables[0].allowedOps).toEqual(['create_rule']);
    expect(deliverables[1].allowedOps).toEqual([]);
    expect(implement.a).toMatchObject({ status: 'passing', attempt: 2, stale: true, summary: 'made rule' });
    expect(implement.b).toBeUndefined();
  });
});
describe('saveScope / saveImplementResult', () => {
  it('saveScope $sets allowedOps', async () => {
    await api.saveScope('a', ['create_rule', 'patch_schema']);
    expect(mdh.updateOne).toHaveBeenCalledWith('__mrfabry_architect', { _id: 'a' }, { $set: { allowedOps: ['create_rule', 'patch_schema'] } });
  });
  it('saveImplementResult persists status + caps the journal to the last 10', async () => {
    const journal = Array.from({ length: 15 }, (_, i) => ({ attempt: i }));
    await api.saveImplementResult('a', { status: 'failed', attempts: 3, writes: [], summary: 's', chatId: 'c', ranAt: 9, journal });
    const set = mdh.updateOne.mock.calls[0][2].$set;
    expect(set.implementStatus).toBe('failed');
    expect(set.implementJournal.length).toBe(10);
    expect(set.implementJournal[0].attempt).toBe(5);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`saveScope` undefined; `implement` not returned).

- [ ] **Step 3: Implement** — in `src/fabry/architect/api.js`:

Add near the top:
```js
export const JOURNAL_CAP = 10;
```

Replace `loadDeliverables` with:
```js
export async function loadDeliverables() {
  const res = await mdh.find(COLLECTION, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  const docs = (res && res.result) || [];
  const deliverables = docs.map((d) => ({
    id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0,
    allowedOps: Array.isArray(d.allowedOps) ? d.allowedOps : [],
  }));
  const results = {};
  const implement = {};
  for (const d of docs) {
    if (d.lastVerdict) {
      results[d._id] = { verdict: d.lastVerdict, evidence: d.lastEvidence || '', chatId: d.lastChatId || null, ranAt: d.ranAt || null, stale: true };
    }
    if (d.implementStatus) {
      implement[d._id] = {
        status: d.implementStatus, attempt: d.attempts || 0,
        writes: Array.isArray(d.lastImplementWrites) ? d.lastImplementWrites : [],
        summary: d.lastImplementSummary || '', chatId: d.lastImplementChatId || null,
        journal: Array.isArray(d.implementJournal) ? d.implementJournal : [],
        ranAt: d.implementRanAt || null, stale: true,
      };
    }
  }
  return { deliverables, results, implement };
}
```

Append:
```js
export function saveScope(id, allowedOps) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { allowedOps } });
}
export function saveImplementResult(id, { status, attempts, writes, summary, chatId, ranAt, journal }) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: {
    implementStatus: status, attempts, lastImplementWrites: writes || [], lastImplementSummary: summary || '',
    lastImplementChatId: chatId || null, implementRanAt: ranAt, implementJournal: (journal || []).slice(-JOURNAL_CAP),
  } });
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-architect-api.test.js` still green (existing `loadDeliverables` test ignores the new `implement` key; if it asserts an exact object shape, update it to also expect `implement: {}`).

---

### Task 7: `actions.js` — implement glue

**Files:**
- Modify: `src/fabry/architect/actions.js` (imports + append)
- Test: `tests/fabry-architect-implement-actions.test.js` (create)

**Interfaces:**
- Consumes: `agentApi.createChat({write})`/`streamMessage` (Task 1); `implement.*` (Task 2); `audit.*` (Task 3); `runImplement` (Task 4); `store.implement*` (Task 5); `api.saveScope/saveImplementResult` (Task 6); the existing module-local `runOne` (check).
- Produces: `suggestScope(text)`, `armImplement(id, allowedOps)`, `reImplement(id)`, `runImplementAll()`, `stopImplement()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-actions.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/agent/agentApi.js', () => ({ createChat: vi.fn(), streamMessage: vi.fn() }));
vi.mock('../src/fabry/architect/api.js', () => ({
  COLLECTION: '__mrfabry_architect',
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  loadDeliverables: vi.fn().mockResolvedValue({ deliverables: [], results: {}, implement: {} }),
  addDeliverable: vi.fn().mockResolvedValue({}), updateDeliverable: vi.fn().mockResolvedValue({}),
  deleteDeliverable: vi.fn().mockResolvedValue({}), saveResult: vi.fn().mockResolvedValue({}),
  setOrder: vi.fn().mockResolvedValue({}), saveScope: vi.fn().mockResolvedValue({}),
  saveImplementResult: vi.fn().mockResolvedValue({}),
}));
import * as agentApi from '../src/agent/agentApi.js';
import * as api from '../src/fabry/architect/api.js';
import * as store from '../src/fabry/architect/store.js';
import { armImplement, reImplement, suggestScope } from '../src/fabry/architect/actions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => {
  vi.clearAllMocks();
  store.deliverables.value = []; store.results.value = {}; store.implement.value = {}; store.implementRunning.value = false;
});

describe('suggestScope', () => {
  it('runs a READ-ONLY chat (no write flag) and parses the tool array', async () => {
    agentApi.createChat.mockResolvedValue('c1');
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      onEvent({ type: 'text-delta', delta: '["create_rule","patch_schema"]' }); onEvent({ type: 'finish' });
    });
    const ops = await suggestScope('Add a VAT rule');
    expect(agentApi.createChat).toHaveBeenCalledWith();           // no { write:true }
    expect(ops).toEqual(['create_rule', 'patch_schema']);
  });
});
describe('armImplement', () => {
  it('persists allowedOps and updates the deliverable in the store', async () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1, allowedOps: [] }];
    await armImplement('a', ['create_rule']);
    expect(api.saveScope).toHaveBeenCalledWith('a', ['create_rule']);
    expect(store.deliverables.value[0].allowedOps).toEqual(['create_rule']);
  });
});
describe('reImplement (write-enabled loop, scoped + audited)', () => {
  beforeEach(() => {
    store.deliverables.value = [{ id: 'a', text: 'Add a VAT rule', order: 1, allowedOps: ['create_rule'] }];
  });
  it('opens a WRITE chat, implements, then a read-only check PASS persists', async () => {
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
      if (/implementing a single requirement/.test(content)) {           // implement turn
        onEvent({ type: 'tool-input-start', toolCallId: 't1', toolName: 'create_rule' });
        onEvent({ type: 'tool-input-available', toolCallId: 't1', input: { name: 'VAT' } });
        onEvent({ type: 'tool-output-available', toolCallId: 't1', output: 'ok' });
        onEvent({ type: 'text-delta', delta: 'Created a VAT rule.' }); onEvent({ type: 'finish' }); return;
      }
      onEvent({ type: 'text-delta', delta: 'VERDICT: PASS\nThe rule exists.' }); onEvent({ type: 'finish' });  // check turn
    });
    await reImplement('a');
    await flush();
    // write chat opened with write:true; check chat opened read-only + cautious-primed
    expect(agentApi.createChat).toHaveBeenCalledWith({ write: true });
    expect(store.implement.value.a.status).toBe('passing');
    expect(store.implement.value.a.writes[0]).toMatchObject({ tool: 'create_rule', ok: true });
    expect(store.results.value.a.verdict).toBe('pass');           // reflected in the verdict banner
    expect(api.saveImplementResult).toHaveBeenCalled();
  });
  it('blocks on an out-of-scope write (agent tries delete_queue)', async () => {
    let n = 0;
    agentApi.createChat.mockImplementation(async () => 'chat_' + (n++));
    agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
      if (content.startsWith('/persona')) { onEvent({ type: 'finish' }); return; }
      if (/implementing a single requirement/.test(content)) {
        onEvent({ type: 'tool-input-start', toolCallId: 't1', toolName: 'delete_queue' });
        onEvent({ type: 'finish' }); return;
      }
      onEvent({ type: 'text-delta', delta: 'VERDICT: PASS' }); onEvent({ type: 'finish' });
    });
    await reImplement('a');
    await flush();
    expect(store.implement.value.a.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing exports).

- [ ] **Step 3: Implement** — in `src/fabry/architect/actions.js`:

Add imports (top, beside the existing ones):
```js
import { summaryLine } from './format.js';
import * as implementMod from './implement.js';
import { runImplement } from './implementLoop.js';
import * as audit from './audit.js';
```

Append at the end of the file:
```js
// ── Implement loop (ralph-style, write-enabled) ─────────────────────────────
let implController = null;
let implRunId = 0;

// Read-only scope suggestion (used by the Arm dialog). Best-effort → [] on failure.
export async function suggestScope(text) {
  try {
    const chatId = await agentApi.createChat();
    const acc = newAcc();
    await agentApi.streamMessage(chatId, implementMod.buildScopePrompt(text), { onEvent: (e) => foldEvents(acc, [e]) });
    return implementMod.parseScope(replyText(acc));
  } catch { return []; }
}

export async function armImplement(id, allowedOps) {
  store.deliverables.value = store.deliverables.value.map((d) => (d.id === id ? { ...d, allowedOps } : d));
  try { await api.saveScope(id, allowedOps); }
  catch (err) { store.loadError.value = err?.message || 'Could not save scope.'; }
}

// One IMPLEMENT turn: fresh WRITE-enabled chat (default persona, NO priming),
// audited + scope-screened live. Aborts the turn on the first out-of-scope write.
// Returns { writes, summary, blocked, chatId } or null if aborted.
async function implementOne(d, { attempt, journal }, signal, allowedOps) {
  const chatId = await agentApi.createChat({ write: true });
  if (signal?.aborted) return null;
  const acc = newAcc();
  const folder = audit.makeAuditFolder(allowedOps);
  let blocked = null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    await agentApi.streamMessage(chatId, implementMod.buildImplementPrompt(d.text, { allowedOps, journal }), {
      signal: ctrl.signal,
      onEvent: (e) => { foldEvents(acc, [e]); const s = folder.feed(e); if (s && s.offending && !blocked) { blocked = s.offending; ctrl.abort(); } },
    });
  } catch (err) {
    if (!blocked && !signal?.aborted && err?.name !== 'AbortError') throw err;
  } finally { if (signal) signal.removeEventListener('abort', onAbort); }
  return { writes: folder.writes, summary: summaryLine(replyText(acc)) || '(no summary)', blocked, chatId };
}

// Apply a loop patch to the store; reflect a check verdict in the shared banner;
// persist on `done`.
function applyImplementPatch(id, patch) {
  const cur = store.implement.value[id] || {};
  const next = { ...cur, ...patch, stale: false };
  if (patch.writes) next.writes = [...(cur.writes || []), ...patch.writes];
  store.implement.value = { ...store.implement.value, [id]: next };
  if (patch.verdict) {
    const v = patch.verdict;
    store.setResult(id, { verdict: v.verdict, evidence: v.evidence, chatId: v.chatId, ranAt: Date.now(), stale: false, running: false });
  }
  if (patch.done) {
    const ranAt = Date.now();
    api.saveImplementResult(id, {
      status: next.status, attempts: next.attempt || 0, writes: next.writes || [], summary: next.summary || '',
      chatId: next.chatId || (store.results.value[id]?.chatId) || null, ranAt, journal: patch.journal || next.journal || [],
    }).catch(() => {});
  }
}

async function runImplementList(ds) {
  if (store.implementRunning.value || !ds.length) return;
  implRunId += 1; const rid = implRunId;
  const ctrl = new AbortController(); implController = ctrl;
  store.implementRunning.value = true;
  for (const d of ds) store.setImplement(d.id, { status: 'running', running: true, writes: [], error: null });
  try {
    await runImplement(ds, {
      maxAttempts: 3, maxTotalWrites: 50, signal: ctrl.signal,
      implementOne: (dd, cx) => implementOne(dd, cx, ctrl.signal, dd.allowedOps || []),
      checkOne: (dd) => runOne(dd, ctrl.signal),
      onEvent: (eid, patch) => { if (rid === implRunId) applyImplementPatch(eid, patch); },
    });
  } finally { if (rid === implRunId) { store.implementRunning.value = false; implController = null; } }
}

export function reImplement(id) {
  const d = store.deliverables.value.find((x) => x.id === id);
  return d ? runImplementList([d]) : undefined;
}

// Implement every deliverable that has a DECLARED scope (others are skipped —
// declare scope via the Arm dialog first).
export function runImplementAll() {
  return runImplementList(store.deliverables.value.filter((d) => (d.allowedOps || []).length));
}

export function stopImplement() {
  implRunId += 1;
  if (implController) implController.abort();
  implController = null;
  store.implementRunning.value = false;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-architect-actions.test.js` still green (existing check glue untouched).

---

### Task 8: Kill-switch — fabry store signal + console mirror + popup toggle

**Files:**
- Modify: `src/fabry/store.js` (add signal, near `deepVerifyAllowed`)
- Modify: `src/console/index.jsx:90-107`
- Modify: `src/popup/components/App.jsx:21` (STORAGE_KEYS) + the Experimental section (~line 300-310)
- Test: `tests/fabry-architect-implement-gate.test.js` (create)

**Interfaces:**
- Produces: `fabryStore.implementAllowed` (signal bool, default **false**).

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-gate.test.js
import { describe, it, expect } from 'vitest';
import * as fabryStore from '../src/fabry/store.js';

describe('implementAllowed gate signal', () => {
  it('defaults to false (opt-in)', () => {
    expect(fabryStore.implementAllowed.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`implementAllowed` undefined).

- [ ] **Step 3: Implement**

In `src/fabry/store.js`, after `deepVerifyAllowed`:
```js
// popup kill switch mirror (fabryArchitectImplementEnabled, DEFAULT OFF — only a
// stored `true` reveals the Architect implement surface). Mirrored live from
// chrome.storage.onChanged in src/console/index.jsx.
export const implementAllowed = signal(false);
```

In `src/console/index.jsx`, extend the storage read (line ~94) and the boot assignment + onChanged mirror (lines ~99-106):
```js
// in chrome.storage.local.get([...]) add:
    'fabryArchitectImplementEnabled',
```
```js
// after the deepVerifyAllowed assignment:
  fabryStore.implementAllowed.value = stored.fabryArchitectImplementEnabled === true;
```
```js
// inside the onChanged listener, alongside the fabryDeepVerifyEnabled branch:
    if (area === 'local' && changes.fabryArchitectImplementEnabled) {
      fabryStore.implementAllowed.value = changes.fabryArchitectImplementEnabled.newValue === true;
    }
```

In `src/popup/components/App.jsx`, add `'fabryArchitectImplementEnabled'` to the STORAGE_KEYS array (line ~21), and add a toggle in the Experimental section mirroring the `fabryDeepVerifyEnabled` block — but **default OFF** (`checked={storageValues.fabryArchitectImplementEnabled === true}`):
```jsx
<label class="toggle-row">
  <input
    type="checkbox"
    id="fabryArchitectImplementEnabled"
    checked={storageValues.fabryArchitectImplementEnabled === true}
    onChange={(v) => setStorageToggle('fabryArchitectImplementEnabled', v)}
  />
  <span class="toggle-label">
    Architect: implement deliverables (writes to the org)
    <span class="toggle-hint">Autonomous, armed, bounded, audited. Off by default.</span>
  </span>
</label>
```
(Match the exact JSX shape/handlers used by the neighbouring `fabryDeepVerifyEnabled` row — copy that row and change the id/label/`checked` expression. `onChange` receiving a boolean matches the existing `setStorageToggle('fabryDeepVerifyEnabled', v)` usage.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npm run build` succeeds; manually confirm in the popup that the new toggle renders under Experimental (after unlocking) and is unchecked by default.

---

### Task 9: Arm dialog + DeliverableEditor Implement panel

**Files:**
- Create: `src/fabry/architect/components/ArmDialog.jsx`
- Modify: `src/fabry/architect/components/DeliverableEditor.jsx`
- Test: `tests/fabry-architect-implement-panel.test.js` (create)

**Interfaces:**
- Consumes: `suggestScope`/`armImplement`/`reImplement` (Task 7); `implementAllowed` (Task 8); `store.implement` (Task 5); Modal (`openModal`/`closeModal`/`ModalBody`/`ModalActions`/`ModalMessage`).
- Produces: `openArmDialog(deliverable, onConfirm)` — modal that suggests + edits `allowedOps`, calls `onConfirm(allowedOps)` on Arm.

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-panel.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('../src/fabry/architect/actions.js', () => ({
  updateDeliverable: vi.fn(), suggestScope: vi.fn().mockResolvedValue(['create_rule']),
  armImplement: vi.fn().mockResolvedValue(undefined), reImplement: vi.fn().mockResolvedValue(undefined),
}));
import * as actions from '../src/fabry/architect/actions.js';
import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import DeliverableEditor from '../src/fabry/architect/components/DeliverableEditor.jsx';
import Modal, { modalContent } from '../src/ui/Modal.jsx';

const flush = () => new Promise((r) => setTimeout(r, 0));
function mount(props) { const root = document.createElement('div'); document.body.appendChild(root); act(() => { render(h('div', null, h(DeliverableEditor, props), h(Modal, null)), root); }); return root; }
beforeEach(() => { vi.clearAllMocks(); modalContent.value = null; store.results.value = {}; store.implement.value = {}; fstore.implementAllowed.value = true; });

describe('Implement panel (kill-switch on)', () => {
  it('shows an Implement button; clicking opens the Arm dialog (suggested scope) → Arm calls armImplement + reImplement', async () => {
    const root = mount({ deliverable: { id: 'a', text: 'Add a VAT rule', allowedOps: [] } });
    const btn = [...root.querySelectorAll('button')].find((b) => /implement/i.test(b.textContent));
    expect(btn).toBeTruthy();
    act(() => btn.click());
    await flush();
    expect(actions.suggestScope).toHaveBeenCalledWith('Add a VAT rule');
    const arm = [...document.querySelectorAll('button')].find((b) => /arm/i.test(b.textContent));
    act(() => arm.click());
    await flush();
    expect(actions.armImplement).toHaveBeenCalledWith('a', ['create_rule']);
    expect(actions.reImplement).toHaveBeenCalledWith('a');
  });
  it('hides the Implement button when the kill-switch is off', () => {
    fstore.implementAllowed.value = false;
    const root = mount({ deliverable: { id: 'a', text: 'x', allowedOps: [] } });
    expect([...root.querySelectorAll('button')].find((b) => /implement/i.test(b.textContent))).toBeFalsy();
  });
  it('renders the audit log of writes from implement state', () => {
    store.implement.value = { a: { status: 'passing', writes: [{ tool: 'create_rule', argsSummary: 'VAT #7', ok: true }] } };
    const root = mount({ deliverable: { id: 'a', text: 'x', allowedOps: ['create_rule'] } });
    expect(root.textContent).toMatch(/create_rule/);
    expect(root.textContent).toMatch(/VAT #7/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no Implement button / ArmDialog).

- [ ] **Step 3: Implement**

`src/fabry/architect/components/ArmDialog.jsx`:
```jsx
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { openModal, closeModal, ModalBody, ModalActions, ModalMessage } from '../../../ui/Modal.jsx';
import { suggestScope } from '../actions.js';

function ArmBody({ deliverable, onConfirm }) {
  const [ops, setOps] = useState((deliverable.allowedOps || []).join(', '));
  const [loading, setLoading] = useState(!(deliverable.allowedOps || []).length);
  useEffect(() => {
    if ((deliverable.allowedOps || []).length) return undefined;
    let live = true;
    suggestScope(deliverable.text).then((s) => { if (live) { setOps(s.join(', ')); setLoading(false); } });
    return () => { live = false; };
  }, []);
  function arm() {
    const allowedOps = ops.split(',').map((s) => s.trim()).filter(Boolean);
    closeModal();
    onConfirm(allowedOps);
  }
  return (
    <ModalBody>
      <ModalMessage>
        {'This runs Mr. Fabry as a WRITE-enabled agent that will create/patch resources in this live organization until the check passes (max 3 attempts). Only the operations below are allowed; anything else stops the run. Every write is audited.'}
      </ModalMessage>
      <div class="fabry-arch-arm-scope">
        <label class="fabry-arch-arm-label">{'Allowed write operations'}</label>
        <input class="input" style="width:100%" value={ops} placeholder={loading ? 'Suggesting…' : 'create_rule, patch_schema'} onInput={(e) => setOps(e.currentTarget.value)} />
      </div>
      <ModalActions>
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-danger" disabled={loading} onClick={arm}>{'Arm & run ▷'}</button>
      </ModalActions>
    </ModalBody>
  );
}

export function openArmDialog(deliverable, onConfirm) {
  openModal('Implement deliverable', () => h(ArmBody, { deliverable, onConfirm }));
}
```

In `src/fabry/architect/components/DeliverableEditor.jsx`, add imports:
```js
import * as fstore from '../../store.js';   // already imported — reuse
import { reImplement, armImplement } from '../actions.js';   // add to the existing actions import
import { openArmDialog } from './ArmDialog.jsx';
```
(Adjust the existing `import { updateDeliverable } from '../actions.js';` to `import { updateDeliverable, reImplement, armImplement } from '../actions.js';`. `fstore` is already imported.)

Add, before the closing `</div>` of `.fabry-arch-editor` (after `<RefineDock .../>`):
```jsx
{fstore.implementAllowed.value && (() => {
  const impl = store.implement.value[deliverable.id];
  const onImplement = () => openArmDialog(deliverable, (allowedOps) => { armImplement(deliverable.id, allowedOps).then(() => reImplement(deliverable.id)); });
  return (
    <div class="fabry-arch-implement">
      <div class="fabry-arch-implement-hd">
        <span class="fabry-arch-implement-title">{'Implement'}</span>
        <button type="button" class="fabry-arch-implement-run" disabled={store.implementRunning.value} onClick={onImplement}>{'Implement ▷'}</button>
      </div>
      {impl && (
        <div class={'fabry-arch-implement-body status-' + (impl.status || 'idle')}>
          <div class="fabry-arch-implement-status">
            {impl.running ? h('span', { class: 'fabry-arch-spin' }) : null}
            {impl.status === 'passing' ? '✓ implemented (check passed)'
              : impl.status === 'failed' ? '✗ could not satisfy after retries'
              : impl.status === 'blocked' ? '⚠ blocked' : impl.running ? 'Working…' : ''}
            {impl.error && <span class="fabry-arch-implement-err">{' — '}{impl.error}</span>}
          </div>
          {impl.summary && <div class="fabry-arch-implement-summary">{impl.summary}</div>}
          {impl.writes && impl.writes.length > 0 && (
            <ul class="fabry-arch-implement-audit">
              {impl.writes.map((w, i) => (
                <li key={i} class={w.ok ? 'ok' : 'pending'}>
                  <code>{w.tool}</code>{w.argsSummary ? ' ' + w.argsSummary : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
})()}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-architect-implement-panel.test.js` green; existing DeliverableEditor tests (`tests/fabry-architect-app.test.js`) still green.

---

### Task 10: Sidebar — Implement all + kebab Implement

**Files:**
- Modify: `src/fabry/architect/components/ArchitectSidebar.jsx`
- Test: `tests/fabry-architect-implement-sidebar.test.js` (create)

**Interfaces:**
- Consumes: `runImplementAll`/`stopImplement`/`reImplement`/`armImplement` (Task 7); `openArmDialog` (Task 9); `implementAllowed`/`implementRunning`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fabry-architect-implement-sidebar.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
vi.mock('../src/fabry/architect/actions.js', () => ({
  loadArchitect: vi.fn().mockResolvedValue(undefined), addDeliverable: vi.fn(), openDeliverable: vi.fn(),
  runAll: vi.fn(), stopRun: vi.fn(), moveDeliverable: vi.fn(), reRun: vi.fn(), deleteDeliverable: vi.fn(),
  runImplementAll: vi.fn(), stopImplement: vi.fn(), reImplement: vi.fn(), armImplement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/ui/Modal.jsx', () => ({ confirmModal: vi.fn() }));
vi.mock('../src/fabry/architect/components/ArmDialog.jsx', () => ({ openArmDialog: vi.fn() }));
import * as actions from '../src/fabry/architect/actions.js';
import { openArmDialog } from '../src/fabry/architect/components/ArmDialog.jsx';
import * as store from '../src/fabry/architect/store.js';
import * as fstore from '../src/fabry/store.js';
import ArchitectSidebar from '../src/fabry/architect/components/ArchitectSidebar.jsx';

function mount() { const root = document.createElement('div'); document.body.appendChild(root); act(() => render(h(ArchitectSidebar, null), root)); return root; }
beforeEach(() => { vi.clearAllMocks(); store.deliverables.value = []; store.results.value = {}; store.implement.value = {}; store.loaded.value = true; store.running.value = false; store.implementRunning.value = false; fstore.implementAllowed.value = true; });

describe('Sidebar implement controls (kill-switch on)', () => {
  it('shows Implement all when there is at least one scoped deliverable', () => {
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1, allowedOps: ['create_rule'] }];
    const root = mount();
    const btn = [...root.querySelectorAll('button')].find((b) => /implement all/i.test(b.textContent));
    expect(btn).toBeTruthy();
    act(() => btn.click());
    expect(actions.runImplementAll).toHaveBeenCalled();
  });
  it('hides Implement all when the kill-switch is off', () => {
    fstore.implementAllowed.value = false;
    store.deliverables.value = [{ id: 'a', text: 'A', order: 1, allowedOps: ['create_rule'] }];
    const root = mount();
    expect([...root.querySelectorAll('button')].find((b) => /implement all/i.test(b.textContent))).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no Implement all button).

- [ ] **Step 3: Implement** — in `src/fabry/architect/components/ArchitectSidebar.jsx`:

Extend the actions import:
```js
import { loadArchitect, addDeliverable, openDeliverable, runAll, stopRun, moveDeliverable, reRun, deleteDeliverable, runImplementAll, stopImplement, reImplement, armImplement } from '../actions.js';
import * as fstore from '../../store.js';
import { openArmDialog } from './ArmDialog.jsx';
```

Read the gate + running flag inside the component body (next to the existing `const running = store.running.value;`):
```js
  const implementAllowed = fstore.implementAllowed.value;
  const implementRunning = store.implementRunning.value;
  const scopedCount = ds.filter((d) => (d.allowedOps || []).length).length;
```

Add a kebab menu item for Implement (inside the `.fabry-arch-menu`, after the Re-run button), gated:
```jsx
{implementAllowed && (
  <button type="button" class="fabry-arch-menu-item" disabled={implementRunning}
    onClick={() => { closeMenu(); openArmDialog(d, (ops) => { armImplement(d.id, ops).then(() => reImplement(d.id)); }); }}>
    {'Implement ▷'}
  </button>
)}
```

Add the Implement-all control in the footer, after the existing Run-all button (before `<Summary .../>`):
```jsx
{implementAllowed && (implementRunning || scopedCount > 0) && (
  <button type="button" class="fabry-arch-implementall"
    onClick={() => (implementRunning ? stopImplement() : runImplementAll())}>
    {implementRunning ? 'Stop' : 'Implement all ▷'}
  </button>
)}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Checkpoint** — `npx vitest run tests/fabry-architect-sidebar.test.js` still green.

---

### Task 11: Styles, rebuild, full-suite + bundle guard

**Files:**
- Modify: `src/console/console.base.css` (or `console.css` — match the current Architect block location; the build emits `console.css`)

- [ ] **Step 1: Add styles** for the new classes, reusing existing Architect tokens/vars (`--success`/`--danger`/`--warning`/`--bg-card`). Minimum set:
  - `.fabry-arch-implement`, `.fabry-arch-implement-hd`, `.fabry-arch-implement-title`, `.fabry-arch-implement-run`
  - `.fabry-arch-implement-body`, `.status-passing`/`.status-failed`/`.status-blocked` accents
  - `.fabry-arch-implement-status`, `.fabry-arch-implement-summary`, `.fabry-arch-implement-err`
  - `.fabry-arch-implement-audit` (list; `li.ok`/`li.pending`), `.fabry-arch-implementall`, `.fabry-arch-arm-scope`, `.fabry-arch-arm-label`
  Model them on the existing `.fabry-arch-runall` / `.fabry-arch-banner` rules already in the file (same paddings/radius/colors). Keep the `.fabry-arch-implementall` button visually distinct from `.fabry-arch-runall` (e.g. a `--danger`-tinted border) to signal "writes".

- [ ] **Step 2: Rebuild** — `npm run build` (succeeds, no errors).

- [ ] **Step 3: Bundle guard — verify the single write call site.** Run:

```bash
grep -c "mcp_mode" dist/console/console.js
grep -o "read-write" dist/console/console.js | wc -l
```
Expected: `mcp_mode` and `read-write` each appear a small, bounded number of times (only the `createChat` opt-in + the guard comment is stripped by minify, so effectively the one string literal). There must be **no** occurrence tied to check/refine/chat/deep-verify code paths. If unsure, `grep -n "read-write" dist/console/console.js` and confirm the surrounding code is the `createChat` body.

- [ ] **Step 4: Full suite** — `npm test`. Expected: all green (existing + new). Fix any regressions (e.g. an existing `loadDeliverables` shape assertion now needs `implement: {}`).

- [ ] **Step 5: Checkpoint** — suite green, `dist/` rebuilt.

---

### Task 12: Live-gate dogfood checklist (manual — spec §10; NOT code)

Do NOT ship beyond dogfood until these pass on an internal org (never a customer org; no customer names/data). Record results in the spec's §10 or a scratch note.

- [ ] **G1 — client can enable write mode.** In an internal-org Console (dogfood recipe: `reference_extension_dogfood_agent_browser.md`), arm + implement a trivial, reversible deliverable (e.g. "there is a queue named `zzz-fabry-test`"). Confirm via network/logs that `POST /chats` carried `{mcp_mode:"read-write"}` AND a write tool actually executed. If `mcp_mode` is ignored (server-config-only), STOP — the feature degrades to propose-only; do not ship as write-enabled.
- [ ] **G2 — writes succeed with the SA session token.** Confirm the create/patch actually landed in the org (visible in the Rossum UI) and the read-only check then flips to PASS.
- [ ] **G3 — read-only default still holds.** Confirm a NON-armed action (a normal check / chat) still cannot write (its `POST /chats` sends `{}`; write-tagged tools disabled). 
- [ ] **Scope stop-after.** Deliberately give a deliverable a scope that excludes what it needs; confirm the loop marks it `blocked` and the audit shows the offending tool.
- [ ] **Cleanup.** Remove any test resources created during G1/G2.

---

### Task 13: Single commit (owner-gated)

- [ ] **Step 1:** Ask the owner whether to commit. Do NOT commit without an explicit yes (repo policy + harness rule).
- [ ] **Step 2 (only on yes):** Stage the run's work and make ONE commit:

```bash
git add src/ tests/ docs/superpowers/ dist/
git commit -m "feat: Architect ralph-style Implement loop — write-enabled, armed, bounded, audited"
```
(No `Co-Authored-By` trailer — repo owner blocks it. Do not push unless asked.)

---

## Self-Review

**Spec coverage:**
- §2 ralph analysis → background, no task (informational). ✓
- §3 decisions (browser-only, write-enabled, armed/bounded/audited, per-deliverable scope, whole-deliverable single chat, DB adaptation) → Tasks 1,3,4,6,7,8,9,10. ✓
- §4 grounding (write tools, mcp_mode lever, persona, observable writes, check gate, single call site) → Tasks 1,3,7. ✓
- §5 mapping + lost-property (no rollback → bounds+audit) → Tasks 3,4,7,9. ✓
- §6 modules (implement.js, implementLoop.js, audit.js, actions glue, createChat opt-in, scope enforcement + honest limit, allowedOps authoring) → Tasks 1,2,3,4,7,9. ✓
- §7 loop/bounds/persona-no-priming/stop → Tasks 4,7 (maxAttempts=3, maxTotalWrites=50, sequential, default persona no priming). ✓
- §8 state store (optional fields, journal cap, server-side) → Tasks 5,6. ✓
- §9 UI (Implement control, Arm dialog, Implement panel, audit log, view-investigation) → Tasks 9,10 (view-investigation reuses the existing verdict-banner `View investigation`; the check verdict is reflected via `applyImplementPatch`). ✓
- §10 backward-compat + triple gate + live gates + privacy → Tasks 1,8,11,12; privacy honored by generic test/prompt content throughout. ✓
- §11 testing → each task's tests + Task 11 full suite + bundle guard. ✓
- §12 out-of-scope → not built (no decomposition, no rollback tooling, no scheduling). ✓

**Placeholder scan:** none — every step carries real code/commands.

**Type consistency:** `createChat({write})`, `buildImplementPrompt(deliverable,{allowedOps,journal})`, `makeAuditFolder(allowedOps,{now})→{writes,feed}`, `runImplement(deliverables,{implementOne,checkOne,onEvent,maxAttempts,maxTotalWrites,signal})`, `implementOne(d,{attempt,journal})→{writes,summary,blocked,chatId}`, `checkOne=runOne`, `saveImplementResult(id,{status,attempts,writes,summary,chatId,ranAt,journal})`, `store.setImplement(id,patch)`, `fstore.implementAllowed`, `openArmDialog(deliverable,onConfirm)` — names match across producer/consumer tasks. ✓
