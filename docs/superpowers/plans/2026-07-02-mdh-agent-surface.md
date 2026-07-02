# MDH Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MDH's `llmchat` NL→pipeline engine with the Rossum Agent API ("Mr. Fabry") as a compact, conversational, read-only agent surface embedded in the pipeline pane.

**Architecture:** A pure SSE-stream parser + a thin streaming transport talk to the Agent API; a small set of store signals holds the per-collection chat session; a compact `AgentBox` component replaces the old `.nl-search-row`. The agent introspects the collection itself and returns a pipeline, which is applied to MDH's existing JSON editor — MDH still executes and renders results (List/Table/Stages, saved queries) unchanged. The old client-side generate/verify loop is retired.

**Tech Stack:** Preact + @preact/signals, esbuild (iife), Vitest (`.test.js` via `h()` + `vi.mock`), Fetch + ReadableStream streaming, the Rossum Agent API (AI-SDK data-stream protocol).

**Spec:** `docs/superpowers/specs/2026-07-02-mdh-agent-surface-design.md`

## Global Constraints

- **Read-only, strictly.** Every session primes the `cautious` persona (`/persona cautious`) AND a read-only preamble; **never** send an approval turn. The client cannot technically prevent a server-side write — a hard guarantee is a ship-blocker tracked in the spec (§4/§10); this build is **internal/dogfood on test orgs only**.
- **Fully replace** `llmchat` — no fallback, no engine toggle.
- **Agent base URL:** `https://rossum-agent-api.tools.r8.lol/api/v1` (already covered by `host_permissions: https://*.r8.lol/*`; no CSP change needed).
- **Auth headers:** `X-Rossum-Token: <raw token>`, `X-Rossum-Api-Url: <domain>/api/v1`.
- **Message body field is `content`** (not `message`). Reply text = accumulated `text-delta`, or `data-final-answer.data.text` if present (slash-command turns have no `data-final-answer`).
- **UI must stay compact** (no permanent new column) and show a **"Powered by Mr. Fabry"** attribution. "Mr. Fabry" is the internal agent name; never display customer names/data.
- **Do NOT `git commit` during this run** (standing user preference). End each task by running its test file; end the plan with the full suite + `npm run build`. The user commits later. Vitest tests are `.test.js` using `h(Component, null, ...)` + `vi.mock` — never raw JSX in tests.

---

## File Structure

**Create:**
- `src/mdh/agent/agentStream.js` — pure: SSE parser (chunk-tolerant), event folding, tool→status labels, pipeline extraction.
- `src/mdh/agent/agentApi.js` — transport: `init`, `probeAgent`, `createChat`, `streamMessage`.
- `src/mdh/components/AgentBox.jsx` — the compact conversational UI.
- `tests/mdh-agent-stream.test.js`, `tests/mdh-agent-api.test.js`, `tests/mdh-agent-box.test.js`.

**Modify:**
- `src/mdh/store.js` — add agent-session signals.
- `src/mdh/components/PipelineEditor.jsx` — replace NL box + `handleNlSubmit` + `AiRunTrace` with `<AgentBox editorRef={editorRef} />`.
- `src/mdh/index.jsx` — `resolveAiAvailability` uses `agentApi.probeAgent()`.
- `src/console/index.jsx` — `agentApi.init(domain, token)` beside `mdhApi.init`.
- `src/mdh/llmPipeline.js` — trim to the kept pure helpers only.
- `src/mdh/api.js` — remove `llmChat`, `probeLlmChat`, `classifyProbe` import.
- `src/console/console.css` — add `.agent-*` rules.
- `CLAUDE.md` — update the MDH section.

**Delete:**
- `src/mdh/aiPipelineLoop.js`, `src/mdh/aiContext.js`, `src/mdh/components/AiRunTrace.jsx`.
- `tests/mdh-ai-pipeline-loop.test.js`, `tests/mdh-ai-context.test.js`, `tests/mdh-ai-run-trace.test.js`, `tests/mdh-pipeline-editor-ai.test.js`.

---

## Task 1: Pure stream parser + pipeline extraction (`agentStream.js`)

**Files:**
- Create: `src/mdh/agent/agentStream.js`
- Test: `tests/mdh-agent-stream.test.js`

**Interfaces:**
- Consumes: `stripFences`, `safeParseArray` from `src/mdh/llmPipeline.js` (pure; survive the Task 5 trim).
- Produces:
  - `createSseParser() → { feed(chunkText): Event[], flush(): Event[] }` — buffers across chunk boundaries; `[DONE]` becomes `{type:'__done__'}`; non-JSON `data:` lines are skipped.
  - `toolLabel(name: string): string`
  - `newAcc(): { reasoning, text, finalAnswer, status, done, tools }`
  - `foldEvents(acc, events: Event[]): acc` (mutates + returns)
  - `replyText(acc): string` — `finalAnswer ?? text`
  - `extractPipeline(text: string): string | null` — pretty-printed JSON array, or null.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-agent-stream.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  createSseParser, toolLabel, newAcc, foldEvents, replyText, extractPipeline,
} from '../src/mdh/agent/agentStream.js';

const sse = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

describe('createSseParser', () => {
  it('parses whole events and yields [DONE] as __done__', () => {
    const p = createSseParser();
    const evs = p.feed(sse({ type: 'start' }) + sse({ type: 'text-delta', delta: 'hi' }) + sse('[DONE]'));
    expect(evs.map((e) => e.type)).toEqual(['start', 'text-delta', '__done__']);
  });

  it('tolerates a chunk boundary in the middle of an event', () => {
    const p = createSseParser();
    const full = sse({ type: 'text-delta', delta: 'hello' });
    const cut = Math.floor(full.length / 2);
    expect(p.feed(full.slice(0, cut))).toEqual([]);        // incomplete
    const evs = p.feed(full.slice(cut));
    expect(evs).toEqual([{ type: 'text-delta', delta: 'hello' }]);
  });

  it('skips non-JSON data lines without throwing', () => {
    const p = createSseParser();
    expect(p.feed('data: not-json\n\n')).toEqual([]);
  });

  it('flush() returns a trailing event with no blank-line terminator', () => {
    const p = createSseParser();
    expect(p.feed('data: {"type":"finish"}')).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'finish' }]);
  });
});

describe('toolLabel', () => {
  it('maps known tools and falls back', () => {
    expect(toolLabel('list_datasets')).toBe('listing datasets');
    expect(toolLabel('data_storage_aggregate')).toBe('querying the collection');
    expect(toolLabel('load_skill')).toBe('consulting reference');
    expect(toolLabel('something_weird')).toBe('working');
    expect(toolLabel('')).toBe('working');
  });
});

describe('foldEvents / replyText', () => {
  it('accumulates text, sets status from tools, prefers finalAnswer', () => {
    const acc = newAcc();
    foldEvents(acc, [
      { type: 'reasoning-start' },
      { type: 'tool-input-start', toolName: 'list_datasets' },
      { type: 'text-delta', delta: 'a' },
      { type: 'text-delta', delta: 'b' },
    ]);
    expect(acc.status).toBe('listing datasets');
    expect(replyText(acc)).toBe('ab');
    foldEvents(acc, [{ type: 'data-final-answer', data: { text: 'FINAL' } }, { type: '__done__' }]);
    expect(replyText(acc)).toBe('FINAL');
    expect(acc.done).toBe(true);
  });
});

describe('extractPipeline', () => {
  it('extracts a fenced json block', () => {
    const out = extractPipeline('```json\n[{"$match":{"a":1}}]\n```');
    expect(JSON.parse(out)).toEqual([{ $match: { a: 1 } }]);
  });
  it('extracts a fenced block surrounded by prose', () => {
    const out = extractPipeline('Here you go:\n```json\n[{"$sort":{"x":-1}}]\n```\nHope that helps!');
    expect(JSON.parse(out)).toEqual([{ $sort: { x: -1 } }]);
  });
  it('extracts a bare array', () => {
    expect(JSON.parse(extractPipeline('[{"$limit":5}]'))).toEqual([{ $limit: 5 }]);
  });
  it('returns null for prose with no array', () => {
    expect(extractPipeline('I cannot do that.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-agent-stream.test.js`
Expected: FAIL — cannot resolve `../src/mdh/agent/agentStream.js`.

- [ ] **Step 3: Write the implementation**

Create `src/mdh/agent/agentStream.js`:

```js
// Pure helpers for the Rossum Agent API stream (AI-SDK data-stream protocol).
// No network, no DOM — fully unit-testable. See spec §2 for the event vocabulary.
import { stripFences, safeParseArray } from '../llmPipeline.js';

const TOOL_LABELS = {
  load_skill: 'consulting reference',
  list_datasets: 'listing datasets',
  data_storage_list_collections: 'listing collections',
  data_storage_aggregate: 'querying the collection',
  data_storage_find: 'querying the collection',
  data_storage_list_indexes: 'inspecting indexes',
  data_storage_list_search_indexes: 'inspecting search indexes',
};

// Human status label for the compact live status line.
export function toolLabel(name) {
  if (!name) return 'working';
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (/aggregate|find|query|search/i.test(name)) return 'querying the collection';
  if (/list|get|read|fetch/i.test(name)) return 'reading';
  return 'working';
}

function parseLines(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1];
    if (payload === '[DONE]') { events.push({ type: '__done__' }); continue; }
    try { events.push(JSON.parse(payload)); } catch { /* partial/non-json → skip */ }
  }
  return events;
}

// Chunk-tolerant SSE parser. Events are separated by a blank line ("\n\n").
export function createSseParser() {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      const events = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        events.push(...parseLines(raw));
      }
      return events;
    },
    flush() {
      const raw = buffer;
      buffer = '';
      return raw.trim() ? parseLines(raw) : [];
    },
  };
}

export function newAcc() {
  return { reasoning: '', text: '', finalAnswer: null, status: '', done: false, tools: [] };
}

// Fold a batch of events into a mutable accumulator.
export function foldEvents(acc, events) {
  for (const e of events) {
    switch (e && e.type) {
      case 'reasoning-start': acc.status = 'thinking'; break;
      case 'reasoning-delta': acc.reasoning += e.delta || ''; break;
      case 'text-delta': acc.text += e.delta || ''; break;
      case 'data-final-answer': acc.finalAnswer = e.data?.text ?? acc.finalAnswer; break;
      case 'tool-input-start': acc.status = toolLabel(e.toolName); acc.tools.push(e.toolName); break;
      case 'finish': case '__done__': acc.done = true; break;
      default: break;
    }
  }
  return acc;
}

export function replyText(acc) {
  return acc.finalAnswer != null ? acc.finalAnswer : acc.text;
}

// Extract a MongoDB aggregation pipeline (JSON array) from the reply text.
// Tries a fenced ```json block first, then the whole fence-stripped text, then
// the first bracketed substring. Returns pretty JSON, or null.
export function extractPipeline(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(stripFences(text));
  const bracket = text.match(/\[[\s\S]*\]/);
  if (bracket) candidates.push(bracket[0]);
  for (const c of candidates) {
    const arr = safeParseArray(String(c).trim());
    if (arr) return JSON.stringify(arr, null, 2);
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-agent-stream.test.js`
Expected: PASS (all cases).

---

## Task 2: Streaming transport (`agentApi.js`)

**Files:**
- Create: `src/mdh/agent/agentApi.js`
- Test: `tests/mdh-agent-api.test.js`

**Interfaces:**
- Consumes: `createSseParser` from `./agentStream.js`.
- Produces:
  - `init(domain: string, token: string): void`
  - `probeAgent(): Promise<boolean>` — `GET /health` → `status === 'healthy'`.
  - `createChat(): Promise<string>` — chat_id; throws `{status}` on non-2xx.
  - `streamMessage(chatId, content, { onEvent, signal }): Promise<void>` — resolves on `[DONE]`/stream end; aborts on `signal` or after 90 s idle.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-agent-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as agentApi from '../src/mdh/agent/agentApi.js';

function streamResponse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) },
  };
}

beforeEach(() => { agentApi.init('https://acme.rossum.app', 'tok123'); });
afterEach(() => { vi.restoreAllMocks(); });

describe('probeAgent', () => {
  it('true when healthy', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) });
    expect(await agentApi.probeAgent()).toBe(true);
  });
  it('false on error / throw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net'));
    expect(await agentApi.probeAgent()).toBe(false);
  });
});

describe('createChat', () => {
  it('returns chat_id and sends auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ chat_id: 'chat_1' }) });
    global.fetch = fetchMock;
    expect(await agentApi.createChat()).toBe('chat_1');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-Rossum-Token']).toBe('tok123');
    expect(opts.headers['X-Rossum-Api-Url']).toBe('https://acme.rossum.app/api/v1');
  });
  it('throws with status on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(agentApi.createChat()).rejects.toMatchObject({ status: 401 });
  });
});

describe('streamMessage', () => {
  it('emits parsed events and posts content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"start"}\n\n',
      'data: {"type":"text-delta","delta":"hi"}\n\n',
      'data: [DONE]\n\n',
    ]));
    global.fetch = fetchMock;
    const events = [];
    await agentApi.streamMessage('chat_1', 'hello', { onEvent: (e) => events.push(e.type) });
    expect(events).toEqual(['start', 'text-delta', '__done__']);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats/chat_1/messages');
    expect(JSON.parse(opts.body)).toEqual({ content: 'hello' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-agent-api.test.js`
Expected: FAIL — cannot resolve `../src/mdh/agent/agentApi.js`.

- [ ] **Step 3: Write the implementation**

Create `src/mdh/agent/agentApi.js`:

```js
// Transport for the Rossum Agent API ("Mr. Fabry"). Streaming per-turn responses
// use the AI-SDK data-stream protocol; agentStream.js parses them. See spec §2/§5.
import { createSseParser } from './agentStream.js';

const AGENT_BASE = 'https://rossum-agent-api.tools.r8.lol/api/v1';
const IDLE_TIMEOUT = 90_000; // abort a turn after this long with no stream activity

let rossumToken = '';
let rossumApiUrl = '';

export function init(domain, token) {
  rossumToken = token || '';
  rossumApiUrl = domain ? `${domain}/api/v1` : '';
}

function authHeaders(extra) {
  return { 'X-Rossum-Token': rossumToken, 'X-Rossum-Api-Url': rossumApiUrl, ...(extra || {}) };
}

function agentError(status) {
  const e = new Error(status === 401
    ? 'Session expired. Open a Rossum page and click Data Storage again to reconnect.'
    : `Agent error ${status}`);
  e.status = status;
  return e;
}

// GET /health — cheap, unauthenticated liveness probe.
export async function probeAgent() {
  try {
    const res = await fetch(`${AGENT_BASE}/health`, { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.status === 'healthy';
  } catch { return false; }
}

// POST /chats — new chat session.
export async function createChat() {
  const res = await fetch(`${AGENT_BASE}/chats`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}',
  });
  if (!res.ok) throw agentError(res.status);
  const data = await res.json();
  return data.chat_id;
}

// POST /chats/{id}/messages — stream one turn. onEvent(event) per parsed event.
// Resolves when the stream ends; aborts on `signal` or IDLE_TIMEOUT of silence.
export async function streamMessage(chatId, content, { onEvent = () => {}, signal } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let idle;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT); };
  const cleanup = () => { clearTimeout(idle); if (signal) signal.removeEventListener('abort', onAbort); };

  resetIdle();
  let res;
  try {
    res = await fetch(`${AGENT_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    });
  } catch (err) { cleanup(); throw err; }

  if (!res.ok || !res.body) { cleanup(); throw agentError(res.status); }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) onEvent(ev);
    }
    for (const ev of parser.flush()) onEvent(ev);
  } finally {
    cleanup();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-agent-api.test.js`
Expected: PASS.

---

## Task 3: Store signals + `AgentBox` component

**Files:**
- Modify: `src/mdh/store.js` (add signals after the `aiAvailable` line, `:28`)
- Create: `src/mdh/components/AgentBox.jsx`
- Test: `tests/mdh-agent-box.test.js`

**Interfaces:**
- Consumes: `createChat`, `streamMessage` from `../agent/agentApi.js`; `newAcc`, `foldEvents`, `replyText`, `extractPipeline` from `../agent/agentStream.js`; `prependAiComment` from `../llmPipeline.js`; store signals `selectedCollection`, `records`, `sampledFields`, plus the new agent signals; `extractFieldNames` from `./JsonEditor.jsx`.
- Produces: `default export AgentBox({ editorRef })` — a Preact component rendering the compact conversational surface. On a produced pipeline it calls `editorRef.current.setValue(prependAiComment(pipelineText, request))`.

- [ ] **Step 1: Add the store signals**

In `src/mdh/store.js`, immediately after `export const aiAvailable = signal(false);`:

```js
// Agent surface ("Mr. Fabry") session state — per selected collection, in-memory.
export const agentChatId = signal(null);
export const agentPrimed = signal(false);              // /persona cautious sent for this chat
export const agentMessages = signal([]);               // [{ role:'user'|'assistant', text, status?, applied?, error? }]
export const agentStreaming = signal(false);
export const agentStatus = signal('');                 // live label while streaming
```

- [ ] **Step 2: Write the failing test**

Create `tests/mdh-agent-box.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

// AgentBox imports `extractFieldNames` from JsonEditor — mock it so CodeMirror
// isn't pulled in.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => null,
  extractFieldNames: () => ['vendor', 'amount'],
}));

// Mock the transport: createChat returns an id; streamMessage replays a scripted
// stream through onEvent, then resolves.
const script = { events: [] };
vi.mock('../src/mdh/agent/agentApi.js', () => ({
  init: vi.fn(),
  createChat: vi.fn(async () => 'chat_test'),
  streamMessage: vi.fn(async (_id, _content, { onEvent }) => { for (const e of script.events) onEvent(e); }),
}));

import AgentBox from '../src/mdh/components/AgentBox.jsx';
import { createChat, streamMessage } from '../src/mdh/agent/agentApi.js';
import * as store from '../src/mdh/store.js';

// Condition-based wait (avoid fixed-timeout flakiness under full-suite load).
function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let ok = false;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(poll, step);
    })();
  });
}
function fireInput(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
function fireEnter(el) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }

let root;
beforeEach(() => {
  store.selectedCollection.value = 'invoices';
  store.records.value = [{ vendor: 'x', amount: 1 }];
  store.sampledFields.value = ['vendor', 'amount'];
  store.agentChatId.value = null;
  store.agentPrimed.value = false;
  store.agentMessages.value = [];
  store.agentStreaming.value = false;
  store.agentStatus.value = '';
  vi.clearAllMocks();
  script.events = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('AgentBox', () => {
  it('applies an extracted pipeline to the editor', async () => {
    script.events = [
      { type: 'text-delta', delta: '```json\n[{"$match":{"amount":{"$gt":10}}}]\n```' },
      { type: 'finish' },
    ];
    const setValue = vi.fn();
    const editorRef = { current: { setValue, getValue: () => '' } };
    render(h(AgentBox, { editorRef }), root);
    const input = root.querySelector('input');
    fireInput(input, 'amounts over 10');
    fireEnter(input);

    await waitFor(() => setValue.mock.calls.length > 0);
    expect(createChat).toHaveBeenCalled();
    // /persona cautious priming turn + the real request:
    expect(streamMessage).toHaveBeenCalledWith('chat_test', '/persona cautious', expect.anything());
    const applied = setValue.mock.calls[0][0];
    expect(applied).toContain('"$match"');
    expect(applied).toContain('AI request: amounts over 10');
  });

  it('shows prose and does NOT touch the editor when no pipeline is returned', async () => {
    script.events = [
      { type: 'data-final-answer', data: { text: 'I can only help with Rossum data queries.' } },
      { type: 'finish' },
    ];
    const setValue = vi.fn();
    const editorRef = { current: { setValue, getValue: () => '' } };
    render(h(AgentBox, { editorRef }), root);
    const input = root.querySelector('input');
    fireInput(input, 'tell me a joke');
    fireEnter(input);

    await waitFor(() => /only help with Rossum/i.test(root.textContent));
    expect(setValue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-agent-box.test.js`
Expected: FAIL — cannot resolve `../src/mdh/components/AgentBox.jsx`.

- [ ] **Step 4: Write the implementation**

Create `src/mdh/components/AgentBox.jsx`:

```jsx
import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import {
  selectedCollection, records, sampledFields,
  agentChatId, agentPrimed, agentMessages, agentStreaming, agentStatus, error,
} from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import { createChat, streamMessage } from '../agent/agentApi.js';
import { newAcc, foldEvents, replyText, extractPipeline } from '../agent/agentStream.js';
import { prependAiComment } from '../llmPipeline.js';

// Read-only framing prepended to the FIRST real request of a session. The agent
// retains context across turns, so later turns send the raw request.
function openingContext(collection, fields, request) {
  return [
    'You are helping build READ-ONLY MongoDB aggregation pipelines for a Rossum Data Storage collection in the Dataset Management tool.',
    'STRICT: only read, aggregate, or introspect. NEVER create, update, delete, insert, drop, or modify any data, index, or configuration in the organization. If a request would require a write, explain instead of doing it.',
    `Target collection: ${collection || '(none selected)'}.`,
    fields.length ? `Known fields: ${fields.join(', ')}.` : '',
    'When you produce a query, output the MongoDB aggregation pipeline as a JSON array (a ```json fenced block is fine).',
    `Request: ${request}`,
  ].filter(Boolean).join('\n');
}

function fieldsNow() {
  const merged = new Set([...extractFieldNames(records.value), ...sampledFields.value]);
  return [...merged].sort();
}

export default function AgentBox({ editorRef }) {
  const [input, setInput] = useState('');
  const abortRef = useRef(null);

  // Reset the session when the collection changes or on unmount.
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    agentChatId.value = null;
    agentPrimed.value = false;
    agentMessages.value = [];
    agentStreaming.value = false;
    agentStatus.value = '';
  }, [selectedCollection.value]);
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  async function ensureSession(signal) {
    if (!agentChatId.value) agentChatId.value = await createChat();
    if (!agentPrimed.value) {
      // Prime the cautious (read-only) persona; discard its output.
      await streamMessage(agentChatId.value, '/persona cautious', { onEvent: () => {}, signal });
      agentPrimed.value = true;
    }
  }

  function pushMessage(msg) { agentMessages.value = [...agentMessages.value, msg]; }
  function updateLast(patch) {
    const list = agentMessages.value.slice();
    list[list.length - 1] = { ...list[list.length - 1], ...patch };
    agentMessages.value = list;
  }

  async function submit() {
    const q = (input || '').trim();
    if (!q || agentStreaming.value || !editorRef?.current) return;

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const firstTurn = agentMessages.value.length === 0;
    const collection = selectedCollection.value;
    const fields = fieldsNow();

    setInput('');
    pushMessage({ role: 'user', text: q });
    pushMessage({ role: 'assistant', text: '', status: 'thinking' });
    agentStreaming.value = true;
    agentStatus.value = 'thinking';

    const acc = newAcc();
    try {
      await ensureSession(ctrl.signal);
      const content = firstTurn ? openingContext(collection, fields, q) : q;
      await streamMessage(agentChatId.value, content, {
        signal: ctrl.signal,
        onEvent: (ev) => {
          foldEvents(acc, [ev]);
          agentStatus.value = acc.status || 'working';
          updateLast({ text: replyText(acc), status: acc.status });
        },
      });

      const reply = replyText(acc);
      const pipeline = extractPipeline(reply);
      if (pipeline) {
        editorRef.current.setValue(prependAiComment(pipeline, q));
        updateLast({ text: reply, status: undefined, applied: true });
      } else {
        updateLast({ text: reply, status: undefined });
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      updateLast({ text: acc.text || '', status: undefined, error: err?.message || 'Agent request failed' });
      if (err?.status !== 401) error.value = { message: 'Agent request failed: ' + (err?.message || '') };
    } finally {
      agentStreaming.value = false;
      agentStatus.value = '';
    }
  }

  function newChat() {
    if (abortRef.current) abortRef.current.abort();
    agentChatId.value = null;
    agentPrimed.value = false;
    agentMessages.value = [];
    agentStatus.value = '';
    agentStreaming.value = false;
  }

  const msgs = agentMessages.value;
  return (
    <div class="agent-box">
      {msgs.length > 0 && (
        <div class="agent-transcript">
          {msgs.map((m, i) => (
            <div key={i} class={'agent-msg agent-msg-' + m.role}>
              {m.role === 'assistant' && m.status && agentStreaming.value && i === msgs.length - 1
                ? <span class="agent-status">{'▸'} {m.status}{'…'}</span>
                : <span class="agent-msg-text">{m.text}</span>}
              {m.applied && <span class="agent-applied">applied {'✓'}</span>}
              {m.error && <span class="agent-error">{m.error}</span>}
            </div>
          ))}
        </div>
      )}
      <div class="agent-input-row">
        <input
          class={'nl-search-input' + (agentStreaming.value ? ' loading' : '')}
          type="text"
          placeholder="Ask Mr. Fabry to build a query…"
          value={input}
          disabled={agentStreaming.value}
          onInput={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setInput(''); }}
        />
        {msgs.length > 0 && !agentStreaming.value && (
          <button class="agent-newchat" title="Start a new conversation" onClick={newChat}>New chat</button>
        )}
      </div>
      <div class="agent-attribution">Powered by Mr. Fabry</div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-agent-box.test.js`
Expected: PASS (both cases).

---

## Task 4: Wire the agent into MDH (PipelineEditor, boot, availability probe)

**Files:**
- Modify: `src/console/index.jsx:121` (add `agentApi.init`)
- Modify: `src/mdh/index.jsx:103` (`resolveAiAvailability` uses `probeAgent`)
- Modify: `src/mdh/components/PipelineEditor.jsx` (replace NL box with `AgentBox`)

**Interfaces:**
- Consumes: `probeAgent`, `init` from `src/mdh/agent/agentApi.js`; `AgentBox` from `./AgentBox.jsx`.
- Produces: no new exports; `aiAvailable` is now driven by `probeAgent()`.

- [ ] **Step 1: Init the agent transport at boot**

In `src/console/index.jsx`, add the import near the other MDH imports (top of file), then the init call. After the line `mdhApi.init(domain, token);` (`:121`) add:

```js
  agentApi.init(domain, token);
```

Add this import alongside the existing `mdhApi` import (match the existing import style/path for the MDH api):

```js
import * as agentApi from '../mdh/agent/agentApi.js';
```

- [ ] **Step 2: Point availability at the agent**

In `src/mdh/index.jsx`, add the import at the top:

```js
import { probeAgent } from './agent/agentApi.js';
```

Replace the body of `resolveAiAvailability` (`:98–:106`) — change the probe call and comment:

```js
// Resolve Agent API ("Mr. Fabry") availability for the org, caching per-org in
// sessionStorage so a same-session reload doesn't re-probe. Never throws.
export async function resolveAiAvailability(orgKey) {
  const key = `mdhAiAvailable_${orgKey}`;
  let cached = null;
  try { cached = sessionStorage.getItem(key); } catch {}
  if (cached === 'true' || cached === 'false') return cached === 'true';
  const available = await probeAgent();
  try { sessionStorage.setItem(key, String(available)); } catch {}
  return available;
}
```

Update the comment block above `initMdh`'s probe call (`:118–:119`) to reference the agent instead of `/llmchat` (cosmetic).

- [ ] **Step 3: Swap the NL box for AgentBox in PipelineEditor**

In `src/mdh/components/PipelineEditor.jsx`:

Remove these imports (lines 9–12):
```js
import { runAiPipeline } from '../aiPipelineLoop.js';
import { prependAiComment, stripAiComment } from '../llmPipeline.js';
import { getSchemaHints } from '../aiContext.js';
import AiRunTrace from './AiRunTrace.jsx';
```
Add:
```js
import AgentBox from './AgentBox.jsx';
```

Remove the NL state/refs (lines ~21–30): `nlQuery`, `nlLoading`, `nlPhase`, `aiTrace`, `nlInputRef`, `nlAbortRef`, and the `useEffect(() => () => { if (nlAbortRef.current)… })` unmount-abort effect. Remove `setAiTrace(null)` from the `selectedCollection` effect (line 71) so it reads `useEffect(() => { updateSaveBtn(); }, [selectedCollection.value]);`.

Remove the entire `handleNlSubmit` function (lines ~79–117).

Replace the two `aiAvailable`-gated JSX blocks (lines ~203–223, the `.nl-search-row` block and the `AiRunTrace` block) with:

```jsx
      {aiAvailable.value && <AgentBox editorRef={editorRef} />}
```

Keep the `aiAvailable` import (line 3) — it still gates the box.

- [ ] **Step 4: Run the affected tests**

Run: `npx vitest run tests/mdh-pipeline-editor.test.js tests/mdh-agent-box.test.js`
Expected: `mdh-pipeline-editor.test.js` PASS (it does not depend on the removed NL loop; if any assertion referenced the old `.nl-search-row`, update it to expect `.agent-box`). `mdh-agent-box.test.js` PASS.

- [ ] **Step 5: Build to confirm no dangling imports**

Run: `npm run build`
Expected: build succeeds (no unresolved imports). Old modules still exist — they're deleted in Task 5.

---

## Task 5: Retire the `llmchat` machinery

**Files:**
- Delete: `src/mdh/aiPipelineLoop.js`, `src/mdh/aiContext.js`, `src/mdh/components/AiRunTrace.jsx`
- Delete: `tests/mdh-ai-pipeline-loop.test.js`, `tests/mdh-ai-context.test.js`, `tests/mdh-ai-run-trace.test.js`, `tests/mdh-pipeline-editor-ai.test.js`
- Modify: `src/mdh/api.js` (remove `llmChat`, `probeLlmChat`, the `classifyProbe` import)
- Modify: `src/mdh/llmPipeline.js` (trim to kept helpers)
- Modify: `tests/mdh-llm-pipeline.test.js` (drop tests for removed exports)
- Modify: `tests/mdh-init-ai-probe.test.js` (mock `probeAgent` instead of `probeLlmChat`)

**Interfaces:**
- Produces: `src/mdh/llmPipeline.js` now exports ONLY `stripFences`, `safeParseArray`, `AI_COMMENT_PREFIX`, `stripAiComment`, `prependAiComment`. All are pure and unchanged in behavior.

- [ ] **Step 1: Delete the retired source + test files**

```bash
rm src/mdh/aiPipelineLoop.js src/mdh/aiContext.js src/mdh/components/AiRunTrace.jsx
rm tests/mdh-ai-pipeline-loop.test.js tests/mdh-ai-context.test.js tests/mdh-ai-run-trace.test.js tests/mdh-pipeline-editor-ai.test.js
```

- [ ] **Step 2: Trim `api.js`**

In `src/mdh/api.js`: delete line 1 `import { classifyProbe } from './llmPipeline.js';`. Delete the `llmChat` function (`:147–174`) and the `probeLlmChat` function (`:179–194`) in full. Leave everything else untouched.

- [ ] **Step 3: Replace `llmPipeline.js` with the trimmed helpers**

Overwrite `src/mdh/llmPipeline.js` with exactly:

```js
// Pure text helpers shared by the agent surface. (The former llmchat prompt/loop
// machinery was retired 2026-07-02 in favor of the Rossum Agent API.)

export function stripFences(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

// Parse text to a pipeline array, or null if it isn't a JSON array.
export function safeParseArray(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- AI request comment (shown above an AI-generated pipeline) --------------
export const AI_COMMENT_PREFIX = '// 🤖 AI request: ';

// Remove a leading AI-request comment (and one blank separator line, if any).
export function stripAiComment(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith(AI_COMMENT_PREFIX)) i += 1;
  if (i > 0 && i < lines.length && lines[i].trim() === '') i += 1;
  return lines.slice(i).join('\n');
}

// Prepend a single-line AI-request comment above the pipeline, replacing any
// existing one. The request is collapsed to one line so it stays a valid `//`
// comment (JSON5 strips it on execution).
export function prependAiComment(pipelineText, request) {
  const body = stripAiComment(typeof pipelineText === 'string' ? pipelineText : '');
  const oneLine = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return body;
  return `${AI_COMMENT_PREFIX}${oneLine}\n${body}`;
}
```

- [ ] **Step 4: Fix the two touched tests**

In `tests/mdh-llm-pipeline.test.js`: keep only the `describe`/`it` blocks that test `stripFences`, `safeParseArray`, `stripAiComment`, `prependAiComment`, and `AI_COMMENT_PREFIX`. Delete every test that imports or references removed exports (`buildPipelineMessages`, `extractReply`, `classifyProbe`, `verdictFor`, `ensureRowLimit`, `samePipeline`, `MAX_ROWS`, `MONGO_SYSTEM_INSTRUCTION`, `ANGLES`, `FIX_ANGLES`, `buildFixMessages`, `buildVerifyMessages`, `parseVerification`, `buildTrace`, `leafStringFields`, `detectNumericStringFields`, `summarizeSearchIndexes`, `leafFieldTypes`, `arrayLeafPaths`, `extendedJsonType`). Update the import line to import only the kept names.

In `tests/mdh-init-ai-probe.test.js`: replace the `probeLlmChat` mock with a `probeAgent` mock. The module under test now imports `probeAgent` from `./agent/agentApi.js`, so mock that:
```js
vi.mock('../src/mdh/agent/agentApi.js', () => ({ probeAgent: vi.fn(), init: vi.fn() }));
import { probeAgent } from '../src/mdh/agent/agentApi.js';
// ...then in tests: probeAgent.mockResolvedValue(true) / (false), and assert
// resolveAiAvailability caches the result in sessionStorage as before.
```
Keep the caching assertions (sessionStorage key `mdhAiAvailable_<org>`) — that behavior is unchanged.

- [ ] **Step 5: Run the full suite + build**

Run: `npx vitest run`
Expected: PASS — no references to deleted modules remain. Fix any straggler import errors the run surfaces.

Run: `npm run build`
Expected: build succeeds.

---

## Task 6: Compact styling, attribution, and docs

**Files:**
- Modify: `src/console/console.css`
- Modify: `CLAUDE.md`

**Interfaces:** none (CSS + docs only).

- [ ] **Step 1: Add the `.agent-*` styles**

In `src/console/console.css`, near the existing `/* AI pipeline input … */` rules (`~:3689`), add compact styles. The transcript must be height-capped and scrollable so the surface stays small:

```css
/* Agent surface ("Mr. Fabry") — compact conversational query builder */
.agent-box { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
.agent-transcript { max-height: 160px; overflow-y: auto; overscroll-behavior: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.agent-msg { padding: 4px 8px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.agent-msg-user { align-self: flex-end; background: var(--accent-bg); color: var(--accent-fg); }
.agent-msg-assistant { align-self: flex-start; background: var(--surface-2, rgba(127,127,127,.08)); }
.agent-status { color: var(--text-muted, #888); font-style: italic; }
.agent-applied { margin-left: 6px; color: var(--success); font-size: 11px; }
.agent-error { color: var(--danger); }
.agent-input-row { display: flex; gap: 6px; align-items: center; }
.agent-input-row .nl-search-input { flex: 1; }
.agent-newchat { font-size: 11px; padding: 2px 8px; background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--text-muted, #888); cursor: pointer; }
.agent-attribution { font-size: 10px; color: var(--text-muted, #999); text-align: right; opacity: .7; }
```

If any variable above is not defined in `console.css`, substitute the closest existing semantic variable (the file defines `--accent`, `--success`, `--danger`, surfaces, and text colors — grep first and match names).

- [ ] **Step 2: Manual visual check (dogfood)**

Run: `npm run build`, reload the unpacked extension, open Dataset Management on a **test org**, select a collection. Verify: the box shows "Ask Mr. Fabry…" + "Powered by Mr. Fabry"; a query like "show 5 records" streams a status line, applies a pipeline to the editor, and the results pane runs it; a follow-up ("only where …") refines it; "New chat" resets. Confirm the transcript stays height-capped (no runaway growth).

- [ ] **Step 3: Update CLAUDE.md**

In the **Dataset Management (MDH)** section of `CLAUDE.md`, replace the `llmPipeline.js + aiPipelineLoop.js + aiContext.js` bullet with a description of the agent surface: engine is the Rossum Agent API ("Mr. Fabry") at `rossum-agent-api.tools.r8.lol` via `src/mdh/agent/{agentApi,agentStream}.js` + `components/AgentBox.jsx`; stateful per-collection chat; streams AI-SDK events; read-only posture (cautious persona + read-only framing; hard guarantee is a ship-blocker, internal/dogfood only); `aiAvailable` now gates on `probeAgent()` (`GET /health`). Note the retired modules. Keep the `console.css .nl-search-*`/`.agent-*` reference accurate.

- [ ] **Step 4: Final verification**

Run: `npx vitest run` — Expected: full suite PASS.
Run: `npm run build` — Expected: success.

---

## Self-Review

**Spec coverage:**
- §2 contract (auth headers, `content` field, stream vocab, `data-final-answer` optional) → Tasks 1–3.
- §4 read-only (cautious persona + read-only framing + never-approve) → Task 3 `ensureSession` + `openingContext` (Global Constraints). Hard-guarantee ship-blocker is documented, not coded (correct — it's an external dependency).
- §5 components (agentStream, agentApi, store signals, AgentBox; retire loop/context/trace; keep pure helpers) → Tasks 1–5.
- §6 data flow (accumulate `text-delta`, `data-final-answer` optional, extract→apply, prose→don't clobber) → Task 1 `foldEvents`/`replyText`/`extractPipeline`, Task 3 `submit`.
- §7 session lifecycle (per-collection, in-memory, reset on change / New chat) → Task 3 effects + `newChat`.
- §8 compact UI + "Powered by Mr. Fabry" → Task 3 markup + Task 6 CSS.
- §9 error handling (host down→hidden via probe; 401; stream error keeps editor intact; abort) → Task 2 `agentError`/idle-abort, Task 3 `catch`, Task 4 probe.
- §11 testing (parser, extraction, mocked-transport UI; remove retired tests) → Tasks 1–5.
- §12 docs/memory → Task 6 + post-run memory update.

**Placeholder scan:** none — every code step contains complete code; the only "substitute the closest variable" note (Task 6) is a real instruction to match existing CSS vars, with a grep directive.

**Type consistency:** `createSseParser().feed/flush` (Tasks 1,2); `newAcc/foldEvents/replyText/extractPipeline` names identical across Tasks 1,3; `createChat/streamMessage(chatId, content, {onEvent, signal})` identical across Tasks 2,3; `probeAgent`/`init` identical across Tasks 2,4,5; `prependAiComment` kept in the trimmed `llmPipeline.js` (Task 5) and consumed by AgentBox (Task 3). Consistent.
