# Fabry Chat Console App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth Console app "Fabry" — a Claude-style chat interface over the Rossum Agent API, gated behind `experimentalUnlocked`.

**Architecture:** Thin client over server state (spec: `docs/superpowers/specs/2026-07-10-fabry-chat-console-design.md`). The Agent API owns all chat content (`GET /chats`, `GET /chats/{id}`, SSE streaming); the browser holds it in Preact signals only. Agent transport moves from `src/mdh/agent/` to neutral `src/agent/` and gains five additive endpoints. A hand-rolled markdown parser renders replies as vnodes (no innerHTML).

**Tech Stack:** Preact + @preact/signals, esbuild (existing), vitest/jsdom (existing). **No new dependencies.**

## Global Constraints

- **No git commits during execution** — owner preference (overrides the usual commit-per-task cadence). Each task's gate is its test run going green; the owner commits at the end.
- **No new npm dependencies.**
- Tests live in `tests/*.test.js`, render via `h(Component, null)` — **never raw JSX in .test.js** (oxc only transforms `.jsx`). DOM tests start with `// @vitest-environment jsdom`.
- JSX unicode gotcha (CLAUDE.md): `\uXXXX` does NOT work in JSX text/attributes — use `{'…'}` expressions or literal glyphs.
- **Never put customer names or customer data** in code, comments, tests, or fixtures — synthetic values only (`acme.rossum.app`, `chat_1`, "Invoice queue").
- Backward compatibility: no existing `chrome.storage` keys change meaning; all new behavior is additive. Existing Fabry surfaces (MDH box, Inspector, Audit, annotate-for-me) must stay behavior-identical.
- User-facing name is **Mr. Fabry** (rail label "Fabry").
- Full suite must be green after every task: `npm test`. Final task also runs `npm run build` (the loaded extension runs `dist/`, not `src/`).
- Agent API base: `https://rossum-agent-api.tools.rossum.cloud/api/v1` (already in `manifest.json` host_permissions — no manifest change).

---

### Task 1: Move agent transport to `src/agent/`

Pure mechanical move — zero behavior change. `agentQuery.js` and `aiContext.js` are MDH-specific and **stay** in `src/mdh/agent/`.

**Files:**
- Move: `src/mdh/agent/agentApi.js` → `src/agent/agentApi.js`
- Move: `src/mdh/agent/agentStream.js` → `src/agent/agentStream.js`
- Modify (imports only): `src/agent/agentStream.js`, `src/mdh/agent/agentQuery.js`, `src/mdh/index.jsx`, `src/mdh/components/AgentBox.jsx`, `src/inspector/index.jsx`, `src/inspector/synthesize.js`, `src/inspector/agentAttribute.js`, `src/audit/index.jsx`, `src/audit/fabry.js`, `src/console/index.jsx`, `src/rossum/annotate/fabryBridge.js`, `src/rossum/annotate/loop.js`, `src/rossum/annotate/propose.js`
- Rename test: `tests/mdh-agent-api.test.js` → `tests/agent-api.test.js`, `tests/mdh-agent-stream.test.js` → `tests/agent-stream.test.js`
- Modify tests that import the moved files (found by grep in Step 3).

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/agent/agentApi.js` exporting `init(domain, token)`, `probeAgent()`, `createChat()`, `streamMessage(chatId, content, {onEvent, signal})`; `src/agent/agentStream.js` exporting `createSseParser()`, `newAcc()`, `foldEvents(acc, events)`, `replyText(acc)`, `extractPipeline(text)`, `toolLabel(name)` — identical signatures, new location. All later tasks import from `../agent/…` (from `src/fabry/`) or `../src/agent/…` (from tests).

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/agent
git mv src/mdh/agent/agentApi.js src/agent/agentApi.js
git mv src/mdh/agent/agentStream.js src/agent/agentStream.js
git mv tests/mdh-agent-api.test.js tests/agent-api.test.js
git mv tests/mdh-agent-stream.test.js tests/agent-stream.test.js
```

- [ ] **Step 2: Fix the moved files' own imports**

In `src/agent/agentStream.js` line 3:

```js
// old: import { stripFences, safeParseArray } from '../llmPipeline.js';
import { stripFences, safeParseArray } from '../mdh/llmPipeline.js';
```

(`src/agent/agentApi.js`'s `import { createSseParser } from './agentStream.js';` still resolves — no change.)

- [ ] **Step 3: Update every importer**

Find them (expect the exact list below plus the two renamed test files):

```bash
grep -rln "mdh/agent/agentApi\|mdh/agent/agentStream\|agent/agentStream.js'\|agent/agentApi.js'" src tests
```

Exact edits (old → new), one line each:

| File | Old import path | New import path |
|---|---|---|
| `src/mdh/agent/agentQuery.js` | `./agentStream.js` | `../../agent/agentStream.js` |
| `src/mdh/index.jsx` | `./agent/agentApi.js` | `../agent/agentApi.js` |
| `src/mdh/components/AgentBox.jsx` | `../agent/agentApi.js` | `../../agent/agentApi.js` |
| `src/inspector/index.jsx` | `../mdh/agent/agentApi.js` | `../agent/agentApi.js` |
| `src/inspector/synthesize.js` | `../mdh/agent/agentStream.js` | `../agent/agentStream.js` |
| `src/inspector/agentAttribute.js` | `../mdh/agent/agentStream.js` | `../agent/agentStream.js` |
| `src/audit/index.jsx` | `../mdh/agent/agentApi.js` | `../agent/agentApi.js` |
| `src/audit/fabry.js` | `../mdh/agent/agentStream.js` | `../agent/agentStream.js` |
| `src/console/index.jsx` | `../mdh/agent/agentApi.js` | `../agent/agentApi.js` |
| `src/rossum/annotate/fabryBridge.js` | `../../mdh/agent/agentStream.js` | `../../agent/agentStream.js` |
| `src/rossum/annotate/loop.js` | `../../mdh/agent/agentStream.js` | `../../agent/agentStream.js` |
| `src/rossum/annotate/propose.js` | `../../mdh/agent/agentStream.js` | `../../agent/agentStream.js` |

In tests: update any `../src/mdh/agent/agentApi.js` → `../src/agent/agentApi.js` and `../src/mdh/agent/agentStream.js` → `../src/agent/agentStream.js` (grep from above lists them, e.g. `tests/agent-api.test.js`, `tests/agent-stream.test.js`, and any of `mdh-agent-box`, `mdh-agent-query`, `mdh-agent-context`, `mdh-init-ai-probe`, `audit-fabry-wiring`, `inspector-index`, `annotate-*` that reference the two moved modules — including string paths inside `vi.mock(...)` calls, which grep also finds). References to `mdh/agent/agentQuery.js` or `mdh/agent/aiContext.js` are **left alone**.

- [ ] **Step 4: Verify zero behavior change**

Run: `npm test`
Expected: full suite passes with the same test count as before the move (no skips, no failures). Also verify nothing still points at the old paths:

```bash
grep -rn "mdh/agent/agentApi\|mdh/agent/agentStream" src tests
```

Expected: no output.

---

### Task 2: New transport endpoints + image sending

**Files:**
- Modify: `src/agent/agentApi.js`
- Test: `tests/agent-api.test.js`

**Interfaces:**
- Consumes: existing `authHeaders()`, `agentError(status)`, `AGENT_BASE` in `agentApi.js`.
- Produces (all exported from `src/agent/agentApi.js`):
  - `listChats({ limit = 50, offset = 0 } = {})` → `Promise<{chats, total, limit, offset}>`
  - `getChat(chatId)` → `Promise<{chat_id, messages, created_at, files}>`
  - `submitFeedback(chatId, turnIndex, isPositive)` → `Promise<{turn_index, is_positive}>`
  - `listCommands()` → `Promise<Array<{name, description, argument_suggestions}>>` (returns `[]` on any failure — degradation, never throws)
  - `downloadChatFile(chatId, filename)` → `Promise<Blob>`
  - `streamMessage(chatId, content, { onEvent, signal, images })` — new optional `images: [{media_type, data}]`; body becomes `{content, images}` only when images are non-empty (live-verified vision shape, 2026-07-07; re-confirm in Task 11).

- [ ] **Step 1: Write the failing tests** (append to `tests/agent-api.test.js`)

```js
describe('listChats / getChat / submitFeedback / downloadChatFile', () => {
  it('listChats GETs with pagination and auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chats: [{ chat_id: 'chat_1' }], total: 1, limit: 50, offset: 0 }) });
    global.fetch = fetchMock;
    const out = await agentApi.listChats();
    expect(out.total).toBe(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats?limit=50&offset=0');
    expect(opts.headers['X-Rossum-Token']).toBe('tok123');
  });
  it('listChats throws with status on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(agentApi.listChats()).rejects.toMatchObject({ status: 401 });
  });
  it('getChat returns the detail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chat_id: 'chat_1', messages: [], created_at: 'x', files: [] }) });
    const out = await agentApi.getChat('chat_1');
    expect(out.chat_id).toBe('chat_1');
    expect(global.fetch.mock.calls[0][0]).toContain('/chats/chat_1');
  });
  it('submitFeedback PUTs snake_case body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ turn_index: 2, is_positive: true }) });
    global.fetch = fetchMock;
    await agentApi.submitFeedback('chat_1', 2, true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats/chat_1/feedback');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ turn_index: 2, is_positive: true });
  });
  it('downloadChatFile returns a blob and URL-encodes the filename', async () => {
    const blob = new Blob(['x']);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    expect(await agentApi.downloadChatFile('chat_1', 'a b.csv')).toBe(blob);
    expect(global.fetch.mock.calls[0][0]).toContain('/chats/chat_1/files/a%20b.csv');
  });
});

describe('listCommands', () => {
  it('returns commands on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ commands: [{ name: '/persona', description: 'd' }] }) });
    expect((await agentApi.listCommands())[0].name).toBe('/persona');
  });
  it('returns [] on failure (degradation, never throws)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net'));
    expect(await agentApi.listCommands()).toEqual([]);
  });
});

describe('streamMessage images option', () => {
  it('adds top-level images only when non-empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(['data: [DONE]\n\n']));
    global.fetch = fetchMock;
    await agentApi.streamMessage('c1', 'look', { onEvent: () => {}, images: [{ media_type: 'image/png', data: 'AAA=' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ content: 'look', images: [{ media_type: 'image/png', data: 'AAA=' }] });
    await agentApi.streamMessage('c1', 'plain', { onEvent: () => {} });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ content: 'plain' });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/agent-api.test.js`
Expected: FAIL — `agentApi.listChats is not a function` (and siblings).

- [ ] **Step 3: Implement** (append to `src/agent/agentApi.js`; change `streamMessage` body line)

```js
async function getJson(path, init) {
  const res = await fetch(`${AGENT_BASE}${path}`, { headers: authHeaders({ 'Content-Type': 'application/json' }), ...init });
  if (!res.ok) throw agentError(res.status);
  return res.json();
}

// GET /chats — the authenticated user's chat sessions, newest-first server-side.
export function listChats({ limit = 50, offset = 0 } = {}) {
  return getJson(`/chats?limit=${limit}&offset=${offset}`);
}

// GET /chats/{id} — full history: {chat_id, messages, created_at, files}.
export function getChat(chatId) {
  return getJson(`/chats/${chatId}`);
}

// PUT /chats/{id}/feedback — thumbs on one assistant turn.
export function submitFeedback(chatId, turnIndex, isPositive) {
  return getJson(`/chats/${chatId}/feedback`, {
    method: 'PUT', body: JSON.stringify({ turn_index: turnIndex, is_positive: isPositive }),
  });
}

// GET /commands — unauthenticated per the spec; [] on any failure so the
// composer's autocomplete simply hides instead of erroring.
export async function listCommands() {
  try {
    const res = await fetch(`${AGENT_BASE}/commands`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.commands) ? data.commands : [];
  } catch { return []; }
}

// GET /chats/{id}/files/{filename} — needs auth headers; a plain <a href> would 401.
export async function downloadChatFile(chatId, filename) {
  const res = await fetch(`${AGENT_BASE}/chats/${chatId}/files/${encodeURIComponent(filename)}`, { headers: authHeaders() });
  if (!res.ok) throw agentError(res.status);
  return res.blob();
}
```

In `streamMessage`, extend the options destructuring and the body line:

```js
export async function streamMessage(chatId, content, { onEvent = () => {}, signal, images } = {}) {
```

```js
      body: JSON.stringify(images && images.length ? { content, images } : { content }),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agent-api.test.js` → all pass. Then `npm test` → full suite green.

---

### Task 3: Markdown parser + renderer

**Files:**
- Create: `src/ui/fabry/markdown.js`
- Create: `src/ui/fabry/FabryMarkdown.jsx`
- Test: `tests/ui-fabry-markdown.test.js`

**Interfaces:**
- Produces:
  - `parseInline(text)` → `Span[]` where `Span = {type:'text'|'code'|'strong'|'em', text} | {type:'link', text, href}`
  - `parseMarkdown(text)` → `Block[]` where `Block = {type:'heading', level, spans} | {type:'para', spans} | {type:'ul'|'ol', items: Span[][]} | {type:'code', lang, text} | {type:'blockquote', spans} | {type:'table', header: Span[][], rows: Span[][][]} | {type:'hr'}`
  - `FabryMarkdown({ text, streaming })` — renders blocks; appends `<span class="fabry-caret">` while `streaming`.
- Scope (documented subset): no nesting inside strong/em (plain text only), no images-in-markdown, links restricted to `http(s)` (anything else renders as literal text), one list level. Streaming tolerance: an unterminated fence renders as code-so-far; unmatched inline markers render literally.

- [ ] **Step 1: Write the failing tests** (`tests/ui-fabry-markdown.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { parseInline, parseMarkdown } from '../src/ui/fabry/markdown.js';
import FabryMarkdown from '../src/ui/fabry/FabryMarkdown.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(FabryMarkdown, props), root);
  return root;
}

describe('parseInline', () => {
  it('splits code, strong, em, links', () => {
    expect(parseInline('a `x` **b** *c* [d](https://r8.example)')).toEqual([
      { type: 'text', text: 'a ' }, { type: 'code', text: 'x' }, { type: 'text', text: ' ' },
      { type: 'strong', text: 'b' }, { type: 'text', text: ' ' }, { type: 'em', text: 'c' },
      { type: 'text', text: ' ' }, { type: 'link', text: 'd', href: 'https://r8.example' },
    ]);
  });
  it('non-http(s) link schemes render as literal text', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }]);
  });
  it('unterminated markers stay literal (streaming tolerance)', () => {
    expect(parseInline('**bold-not-closed')).toEqual([{ type: 'text', text: '**bold-not-closed' }]);
  });
});

describe('parseMarkdown', () => {
  it('headings, paragraphs, lists', () => {
    const b = parseMarkdown('## Title\n\npara one\nsame para\n\n- one\n- two\n\n1. a\n2. b');
    expect(b.map((x) => x.type)).toEqual(['heading', 'para', 'ul', 'ol']);
    expect(b[0].level).toBe(2);
    expect(b[1].spans[0].text).toBe('para one same para');
    expect(b[2].items.length).toBe(2);
  });
  it('fenced code keeps language and never parses inline', () => {
    const b = parseMarkdown('```json\n{"a": "**x**"}\n```');
    expect(b).toEqual([{ type: 'code', lang: 'json', text: '{"a": "**x**"}' }]);
  });
  it('unterminated fence consumes the rest (streaming)', () => {
    const b = parseMarkdown('```\npartial');
    expect(b).toEqual([{ type: 'code', lang: '', text: 'partial' }]);
  });
  it('blockquote and table', () => {
    const b = parseMarkdown('> quoted\n\n| h1 | h2 |\n| --- | --- |\n| a | b |');
    expect(b[0].type).toBe('blockquote');
    expect(b[1].type).toBe('table');
    expect(b[1].rows[0][1][0].text).toBe('b');
  });
});

describe('FabryMarkdown', () => {
  it('renders vnodes — HTML-shaped input stays inert text', () => {
    const root = mount({ text: 'hi <img src=x onerror=alert(1)> there' });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('renders code blocks and a streaming caret', () => {
    const root = mount({ text: '```\ncode\n```', streaming: true });
    expect(root.querySelector('pre code').textContent).toBe('code');
    expect(root.querySelector('.fabry-caret')).toBeTruthy();
  });
  it('links open in a new tab with rel protection', () => {
    const root = mount({ text: '[d](https://r8.example)' });
    const a = root.querySelector('a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ui-fabry-markdown.test.js`
Expected: FAIL — cannot resolve `../src/ui/fabry/markdown.js`.

- [ ] **Step 3: Implement `src/ui/fabry/markdown.js`**

```js
// Hand-rolled markdown subset → block tree. Never produces HTML strings —
// FabryMarkdown.jsx renders the tree as vnodes, so output is XSS-inert by
// construction. Tolerates streaming-partial input: an unterminated fence
// becomes code-so-far; unmatched inline markers render literally.
// Subset by design: no nesting inside strong/em, no md images, http(s) links
// only, one list level.

const SAFE_HREF = /^https?:\/\//i;

export function parseInline(text) {
  const spans = [];
  let buf = '';
  const flush = () => { if (buf) { spans.push({ type: 'text', text: buf }); buf = ''; } };
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^`([^`]+)`/))) { flush(); spans.push({ type: 'code', text: m[1] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) { flush(); spans.push({ type: 'strong', text: m[1] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\*([^*\s][^*]*)\*/))) { flush(); spans.push({ type: 'em', text: m[1] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      if (SAFE_HREF.test(m[2])) spans.push({ type: 'link', text: m[1], href: m[2] });
      else spans.push({ type: 'text', text: m[0] });
      i += m[0].length; continue;
    }
    buf += s[i]; i += 1;
  }
  flush();
  return spans;
}

const LIST_UL = /^\s*[-*+]\s+(.*)$/;
const LIST_OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// A paragraph run breaks on any line that starts a different block.
const PARA_BREAK = /^(```|#{1,4}\s|>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*\|)/;

export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i += 1; continue; }
    if ((m = line.match(/^```(\w*)\s*$/))) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1; // closing fence (absent while streaming)
      blocks.push({ type: 'code', lang: m[1] || '', text: buf.join('\n') });
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { blocks.push({ type: 'heading', level: m[1].length, spans: parseInline(m[2]) }); i += 1; continue; }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) {
      const buf = [m[1]];
      i += 1;
      while (i < lines.length && (m = lines[i].match(/^>\s?(.*)$/))) { buf.push(m[1]); i += 1; }
      blocks.push({ type: 'blockquote', spans: parseInline(buf.join(' ')) });
      continue;
    }
    if (LIST_UL.test(line) || LIST_OL.test(line)) {
      const ordered = LIST_OL.test(line);
      const itemRe = ordered ? LIST_OL : LIST_UL;
      const items = [];
      while (i < lines.length && (m = lines[i].match(itemRe))) { items.push(parseInline(m[1])); i += 1; }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim()));
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !PARA_BREAK.test(lines[i])) { buf.push(lines[i]); i += 1; }
    blocks.push({ type: 'para', spans: parseInline(buf.join(' ')) });
  }
  return blocks;
}
```

- [ ] **Step 4: Implement `src/ui/fabry/FabryMarkdown.jsx`**

```jsx
import { h } from 'preact';
import { parseMarkdown } from './markdown.js';

// Block tree → vnodes. All text lands as text nodes (never innerHTML).
function Spans({ spans }) {
  return spans.map((s) => {
    if (s.type === 'code') return <code class="fabry-md-icode">{s.text}</code>;
    if (s.type === 'strong') return <strong>{s.text}</strong>;
    if (s.type === 'em') return <em>{s.text}</em>;
    if (s.type === 'link') return <a href={s.href} target="_blank" rel="noopener noreferrer">{s.text}</a>;
    return s.text;
  });
}

function BlockView({ b }) {
  if (b.type === 'heading') return h('h' + Math.min(b.level + 2, 6), { class: 'fabry-md-h' }, h(Spans, { spans: b.spans }));
  if (b.type === 'code') return <pre class="fabry-md-code"><code>{b.text}</code></pre>;
  if (b.type === 'ul') return <ul>{b.items.map((it) => <li><Spans spans={it} /></li>)}</ul>;
  if (b.type === 'ol') return <ol>{b.items.map((it) => <li><Spans spans={it} /></li>)}</ol>;
  if (b.type === 'blockquote') return <blockquote class="fabry-md-quote"><Spans spans={b.spans} /></blockquote>;
  if (b.type === 'hr') return <hr class="fabry-md-hr" />;
  if (b.type === 'table') {
    return (
      <div class="fabry-md-tablewrap">
        <table class="fabry-md-table">
          <thead><tr>{b.header.map((c) => <th><Spans spans={c} /></th>)}</tr></thead>
          <tbody>{b.rows.map((r) => <tr>{r.map((c) => <td><Spans spans={c} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <p><Spans spans={b.spans} /></p>;
}

export default function FabryMarkdown({ text, streaming }) {
  return (
    <div class="fabry-md">
      {parseMarkdown(text).map((b) => <BlockView b={b} />)}
      {streaming ? <span class="fabry-caret" /> : null}
    </div>
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/ui-fabry-markdown.test.js` → all pass. Then `npm test` → green.

---

### Task 4: Experimental gate + skeleton Fabry app in the shell

**Files:**
- Modify: `src/console/store.js`, `src/console/boot.js`, `src/console/components/Rail.jsx`, `src/console/components/Console.jsx`, `src/console/index.jsx`, `src/console/console.css`
- Create: `src/fabry/store.js` (skeleton), `src/fabry/index.jsx` (skeleton), `src/fabry/components/App.jsx` (skeleton)
- Test: `tests/console-boot.test.js`, `tests/console-rail.test.js` (extend)

**Interfaces:**
- Consumes: `chrome.storage.local` key `experimentalUnlocked` (existing, popup-owned).
- Produces:
  - `src/console/store.js`: `export const experimentalUnlocked = signal(false);`
  - `src/console/boot.js`: `isValidApp('fabry') === true`; `pickInitialApp({ stagingApp, persistedApp, fabryUnlocked = false })` — `'fabry'` only wins when `fabryUnlocked`; `appAfterGateChange(activeApp, fabryUnlocked)` → `'mdh'` when an active `'fabry'` loses the gate, else `activeApp` unchanged.
  - `src/fabry/store.js` (skeleton, replaced in Task 5): `domain`, `token`, `connected`, `agentAvailable` signals.
  - `src/fabry/index.jsx`: `initFabry()` (skeleton: probe only).
  - Rail shows a 5th item (id `fabry`, label "Fabry", title "Mr. Fabry", `exp` badge) only when unlocked.

- [ ] **Step 1: Write the failing tests**

Append to `tests/console-boot.test.js`:

```js
describe('fabry experimental gate', () => {
  it('isValidApp accepts fabry', () => {
    expect(isValidApp('fabry')).toBe(true);
  });
  it('pickInitialApp only yields fabry when unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: true })).toBe('fabry');
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: false })).toBe('mdh');
    expect(pickInitialApp({ persistedApp: 'fabry' })).toBe('mdh'); // default locked (older callers)
    expect(pickInitialApp({ stagingApp: 'fabry', persistedApp: 'audit', fabryUnlocked: false })).toBe('audit');
  });
  it('appAfterGateChange kicks an active fabry back to mdh on re-lock', () => {
    expect(appAfterGateChange('fabry', false)).toBe('mdh');
    expect(appAfterGateChange('fabry', true)).toBe('fabry');
    expect(appAfterGateChange('audit', false)).toBe('audit');
  });
});
```

(add `appAfterGateChange` to the file's import from `../src/console/boot.js`.)

In `tests/console-rail.test.js`: import `experimentalUnlocked` from `../src/console/store.js`, set `experimentalUnlocked.value = false;` in the existing `beforeEach`, and append:

```js
describe('Rail — fabry gate', () => {
  it('hides Fabry while locked', () => {
    experimentalUnlocked.value = false;
    const root = mount();
    expect(root.querySelectorAll('.app-rail-item').length).toBe(4);
    expect([...root.querySelectorAll('.app-rail-item')].some((b) => b.getAttribute('title') === 'Mr. Fabry')).toBe(false);
  });
  it('shows Fabry with an exp badge when unlocked, and switches on click', () => {
    experimentalUnlocked.value = true;
    const root = mount();
    const btn = [...root.querySelectorAll('.app-rail-item')].find((b) => b.getAttribute('title') === 'Mr. Fabry');
    expect(btn).toBeTruthy();
    expect(btn.querySelector('.app-rail-exp').textContent).toBe('exp');
    btn.click();
    expect(activeApp.value).toBe('fabry');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/console-boot.test.js tests/console-rail.test.js`
Expected: FAIL — `appAfterGateChange` not exported; fabry cases wrong.

- [ ] **Step 3: Implement the pure gate logic**

`src/console/store.js` — append:

```js
// Experimental features gate (popup-owned; 5 quick clicks on the version hash).
// Mirrored from chrome.storage.local at boot and live via onChanged.
export const experimentalUnlocked = signal(false);
```

`src/console/boot.js` — extend:

```js
export function isValidApp(v) {
  return v === 'mdh' || v === 'audit' || v === 'galaxy' || v === 'inspector' || v === 'fabry';
}

export function pickInitialApp({ stagingApp, persistedApp, fabryUnlocked = false } = {}) {
  const ok = (v) => isValidApp(v) && (v !== 'fabry' || fabryUnlocked);
  if (ok(stagingApp)) return stagingApp;
  if (ok(persistedApp)) return persistedApp;
  return 'mdh';
}

// Re-locking the experimental gate while Fabry is the active app falls back to
// Dataset Management; any other app is unaffected.
export function appAfterGateChange(activeApp, fabryUnlocked) {
  return activeApp === 'fabry' && !fabryUnlocked ? 'mdh' : activeApp;
}
```

- [ ] **Step 4: Skeleton app files**

`src/fabry/store.js`:

```js
import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initFabry runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = booting; true/false after
export const agentAvailable = signal(null); // null = probing; false = agent offline
```

`src/fabry/index.jsx`:

```js
import * as agentApi from '../agent/agentApi.js';
import * as store from './store.js';

export async function initFabry() {
  store.agentAvailable.value = await agentApi.probeAgent();
}
```

`src/fabry/components/App.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';

export default function App({ connected }) {
  if (!connected) return <div class="app-root"><div class="empty-state">Not connected. Open a Rossum page and launch the Console again.</div></div>;
  if (store.agentAvailable.value === false) {
    return <div class="app-root"><div class="empty-state">Mr. Fabry is offline (agent unreachable). Try again later.</div></div>;
  }
  return <div class="app-root fabry-root"><div class="empty-state">Mr. Fabry</div></div>;
}
```

- [ ] **Step 5: Wire the shell**

`src/console/components/Rail.jsx` — add the icon + entry + gate filter:

```jsx
import { activeApp, experimentalUnlocked } from '../store.js';

const FABRY_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />
  </svg>
);
```

APPS gains `{ id: 'fabry', label: 'Fabry', title: 'Mr. Fabry', icon: FABRY_ICON, exp: true }` (last). Render maps over `APPS.filter((a) => !a.exp || experimentalUnlocked.value)` and the badge line becomes:

```jsx
{a.beta && <span class="app-rail-beta">beta</span>}
{a.exp && <span class="app-rail-exp">exp</span>}
```

`src/console/components/Console.jsx` — add imports + branch (mirroring galaxy):

```jsx
import FabryApp from '../../fabry/components/App.jsx';
import * as fabryStore from '../../fabry/store.js';
```

```jsx
  } else if (app === 'fabry') {
    const c = fabryStore.connected.value;
    view = c === null ? <Connecting /> : <FabryApp connected={c} />;
  }
```

`src/console/index.jsx`:

```js
import { activeApp, experimentalUnlocked } from './store.js';
import { pickInitialApp, resolveBootAuth, computeStaleAuthRemovals, appAfterGateChange } from './boot.js';
import * as fabryStore from '../fabry/store.js';
import { initFabry } from '../fabry/index.jsx';
```

- `TITLES` gains `fabry: 'Mr. Fabry — Rossum SA'`.
- `ensureInited` gains (with a `fabryInited` flag): `if (app === 'fabry' && !fabryInited) { fabryInited = true; return initFabry(); }`
- In `boot()`: add `'experimentalUnlocked'` to the `chrome.storage.local.get([...])` keys; then

```js
  experimentalUnlocked.value = !!stored.experimentalUnlocked;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.experimentalUnlocked) {
      experimentalUnlocked.value = !!changes.experimentalUnlocked.newValue;
    }
  });
  effect(() => { activeApp.value = appAfterGateChange(activeApp.value, experimentalUnlocked.value); });
```

- `pickInitialApp` call becomes `pickInitialApp({ stagingApp, persistedApp, fabryUnlocked: !!stored.experimentalUnlocked })`.
- No-creds path adds `fabryStore.connected.value = false;`; creds path adds `fabryStore.domain.value = domain; fabryStore.token.value = token; fabryStore.connected.value = true;` (transport `agentApi.init` is already called).

`src/console/console.css` — next to `.app-rail-beta` (line ~3047):

```css
.app-rail-exp { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--diag-fg); border: 1px solid var(--diag-border); border-radius: 6px; padding: 0 4px; margin-top: 2px; }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/console-boot.test.js tests/console-rail.test.js tests/console-shell.test.js` → pass. Then `npm test` → green (existing rail tests still see 4 items because `beforeEach` locks the gate).

---

### Task 5: Fabry store, thread normalization, formatting helpers

**Files:**
- Modify: `src/fabry/store.js` (replace skeleton with full store)
- Create: `src/fabry/thread.js`, `src/fabry/format.js`
- Test: `tests/fabry-thread.test.js`, `tests/fabry-format.test.js`

**Interfaces:**
- Produces `src/fabry/store.js` signals: `domain`, `token`, `connected`, `agentAvailable`, `chats` (ChatSummary[]), `chatsTotal`, `chatsLoading`, `activeChatId`, `thread` (Turn[]), `threadLoading`, `liveTurn` (fold acc | null), `streaming`, `files` (FileInfo[]), `commands`, `personaChoice` ('cautious'|'default'), `error`, `sendError`; `resetChatView()` clears activeChatId/thread/files/liveTurn/sendError.
- Produces `src/fabry/thread.js`:
  - `normalizeMessages(messages)` → `Turn[]`; `Turn = { role: 'user'|'assistant', chip: boolean, text: string, images: [{media_type, data}], feedback: boolean|null, reasoning: string, tools: string[], interrupted: boolean }`. `chip === true` for user turns whose text starts with `/` (slash-command primings).
  - `personaOf(turns)` → `'cautious' | 'default' | null` (last `/persona <arg>` chip wins).
  - `assistantOrdinal(turns, idx)` → 0-based count of assistant turns up to and including `idx`, minus 1. **VERIFY-GATE (spec §10.1):** used as `turn_index` for feedback; adjust after live verification.
- Produces `src/fabry/format.js`: `tsToMs(ts)` (heuristic sec→ms), `relativeTime(ms, now)`, `chatTitle(summary)` (`summary ?? preview ?? first_message ?? '(empty chat)'`).

- [ ] **Step 1: Write the failing tests**

`tests/fabry-thread.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeMessages, personaOf, assistantOrdinal } from '../src/fabry/thread.js';

describe('normalizeMessages', () => {
  it('maps string and content-part messages, marking slash turns as chips', () => {
    const turns = normalizeMessages([
      { role: 'user', content: '/persona cautious' },
      { role: 'assistant', content: 'Persona set.' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', media_type: 'image/png', data: 'AAA=' }] },
      { role: 'assistant', content: 'An invoice.', feedback: true },
    ]);
    expect(turns[0]).toMatchObject({ role: 'user', chip: true, text: '/persona cautious' });
    expect(turns[2]).toMatchObject({ role: 'user', chip: false, text: 'what is this?' });
    expect(turns[2].images).toEqual([{ media_type: 'image/png', data: 'AAA=' }]);
    expect(turns[3].feedback).toBe(true);
    expect(turns[1].feedback).toBe(null);
  });
});

describe('personaOf', () => {
  it('last /persona chip wins; null when none', () => {
    const t = normalizeMessages([
      { role: 'user', content: '/persona cautious' },
      { role: 'user', content: '/persona default' },
    ]);
    expect(personaOf(t)).toBe('default');
    expect(personaOf([])).toBe(null);
  });
});

describe('assistantOrdinal', () => {
  it('counts assistant turns only', () => {
    const t = normalizeMessages([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ]);
    expect(assistantOrdinal(t, 1)).toBe(0);
    expect(assistantOrdinal(t, 3)).toBe(1);
  });
});
```

`tests/fabry-format.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { tsToMs, relativeTime, chatTitle } from '../src/fabry/format.js';

describe('tsToMs', () => {
  it('passes ms through, upscales seconds', () => {
    expect(tsToMs(1760000000000)).toBe(1760000000000);
    expect(tsToMs(1760000000)).toBe(1760000000000);
  });
});

describe('relativeTime', () => {
  const now = 1760000000000;
  it('buckets', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 120_000, now)).toBe('2m ago');
    expect(relativeTime(now - 7_200_000, now)).toBe('2h ago');
    expect(relativeTime(now - 172_800_000, now)).toBe('2d ago');
  });
});

describe('chatTitle', () => {
  it('summary > preview > first_message > placeholder', () => {
    expect(chatTitle({ summary: 's', preview: 'p', first_message: 'f' })).toBe('s');
    expect(chatTitle({ preview: 'p', first_message: 'f' })).toBe('p');
    expect(chatTitle({ first_message: 'f' })).toBe('f');
    expect(chatTitle({})).toBe('(empty chat)');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/fabry-thread.test.js tests/fabry-format.test.js`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

`src/fabry/thread.js`:

```js
// Pure view-model helpers for chat history. Server Message → Turn.

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
}

function partsToImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'image').map((p) => ({ media_type: p.media_type, data: p.data }));
}

export function normalizeMessages(messages) {
  return (messages || []).map((msg) => {
    const text = partsToText(msg.content);
    return {
      role: msg.role,
      chip: msg.role === 'user' && text.startsWith('/'),
      text,
      images: partsToImages(msg.content),
      feedback: msg.feedback ?? null,
      reasoning: '',
      tools: [],
      interrupted: false,
    };
  });
}

// Last /persona chip wins; deterministic, no guessing beyond history.
export function personaOf(turns) {
  let out = null;
  for (const t of turns || []) {
    const m = t.chip && t.text.match(/^\/persona\s+(\w+)/);
    if (m) out = m[1];
  }
  return out;
}

// 0-based ordinal of the assistant turn at `idx` among assistant turns.
// VERIFY-GATE (spec §10.1): assumed to equal the API's feedback turn_index;
// verify live via the feedback echo in ChatDetail before trusting persisted 👍.
export function assistantOrdinal(turns, idx) {
  let n = -1;
  for (let i = 0; i <= idx && i < turns.length; i += 1) {
    if (turns[i].role === 'assistant') n += 1;
  }
  return n;
}
```

`src/fabry/format.js`:

```js
// ChatSummary.timestamp units are not documented; treat values that are too
// small to be milliseconds as seconds.
export function tsToMs(ts) {
  return ts > 1e12 ? ts : ts * 1000;
}

export function relativeTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function chatTitle(summary) {
  return summary?.summary || summary?.preview || summary?.first_message || '(empty chat)';
}
```

`src/fabry/store.js` (full replacement of the skeleton):

```js
import { signal } from '@preact/signals';

// Shared connection (set by the console shell before initFabry runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = booting; true/false after
export const agentAvailable = signal(null); // null = probing; false = agent offline

// Sidebar (mirrors GET /chats — the server owns chat state; nothing persisted).
export const chats = signal([]);
export const chatsTotal = signal(null);
export const chatsLoading = signal(false);

// Open conversation.
export const activeChatId = signal(null);
export const thread = signal([]); // Turn[] (src/fabry/thread.js)
export const threadLoading = signal(false);
export const files = signal([]); // FileInfo[] from ChatDetail
export const liveTurn = signal(null); // streaming fold acc, or null
export const streaming = signal(false);

// Composer context.
export const commands = signal([]); // from GET /commands ([] = hide autocomplete)
export const personaChoice = signal('cautious'); // applies to the NEXT new chat

// Errors: `error` is app-level (auth/offline); `sendError` is per-send, inline.
export const error = signal(null);
export const sendError = signal(null);

export function resetChatView() {
  activeChatId.value = null;
  thread.value = [];
  files.value = [];
  liveTurn.value = null;
  sendError.value = null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fabry-thread.test.js tests/fabry-format.test.js` → pass. `npm test` → green.

---

### Task 6: Chat orchestration + init + per-tab active chat

**Files:**
- Create: `src/fabry/chat.js`
- Modify: `src/fabry/index.jsx` (full init), `src/console/tabState.js` (add key)
- Test: `tests/fabry-chat.test.js`

**Interfaces:**
- Consumes: Task 2 transport, Task 5 store/thread.
- Produces `src/fabry/chat.js`:
  - `loadChats({ more = false } = {})` — first page replaces, `more: true` appends the next `offset = chats.length` page.
  - `openChat(chatId)` — aborts any stream, loads + normalizes history, sets `activeChatId/thread/files`.
  - `startNewChat()` — `resetChatView()` (server chat created lazily on first send).
  - `sendMessage(text, images = [])` — creates the chat + optional `/persona cautious` priming on first send; streams the reply into `liveTurn`; appends turns; refreshes the sidebar. Throws nothing; failures land in `sendError` (429 → friendly copy; 401 → `error`). Returns `true` on success, `false` on failure (composer keeps its draft on `false`).
  - `stopStreaming()` — aborts; the partial fold is kept as an `interrupted` turn.
  - `sendFeedback(ordinal, isPositive)` — PUT + optimistic `thread` update.
  - `downloadFile(filename)` — blob → temporary object URL → anchor click → revoke.
- Modifies `src/console/tabState.js`: `TAB_SCOPED_KEYS` gains `'fabryActiveChat'`.
- `initFabry()`: probe → `agentAvailable`; when up: `listCommands` → `commands`, `loadChats()`, restore per-tab `fabryActiveChat` → `openChat`, and an `effect` persisting `activeChatId` via `writeTabState`.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-chat.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn().mockResolvedValue(true),
  createChat: vi.fn().mockResolvedValue('chat_new'),
  listChats: vi.fn().mockResolvedValue({ chats: [{ chat_id: 'chat_1', timestamp: 1, message_count: 2, first_message: 'hi' }], total: 1, limit: 50, offset: 0 }),
  getChat: vi.fn().mockResolvedValue({ chat_id: 'chat_1', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], created_at: 'x', files: [{ filename: 'out.csv', size: 3, timestamp: 't' }] }),
  submitFeedback: vi.fn().mockResolvedValue({ turn_index: 0, is_positive: true }),
  listCommands: vi.fn().mockResolvedValue([{ name: '/persona', description: 'd' }]),
  downloadChatFile: vi.fn().mockResolvedValue(new Blob(['x'])),
  streamMessage: vi.fn(),
}));

import * as agentApi from '../src/agent/agentApi.js';
import * as store from '../src/fabry/store.js';
import { loadChats, openChat, sendMessage, sendFeedback, stopStreaming } from '../src/fabry/chat.js';

function streamOk(reply) {
  agentApi.streamMessage.mockImplementation(async (id, content, { onEvent }) => {
    onEvent({ type: 'text-delta', delta: reply });
    onEvent({ type: 'finish' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.resetChatView();
  store.chats.value = []; store.chatsTotal.value = null;
  store.personaChoice.value = 'cautious';
  store.error.value = null; store.sendError.value = null; store.streaming.value = false;
  global.chrome = { storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } } };
});

describe('loadChats / openChat', () => {
  it('fills the sidebar and opens a chat with normalized turns + files', async () => {
    await loadChats();
    expect(store.chats.value.length).toBe(1);
    expect(store.chatsTotal.value).toBe(1);
    await openChat('chat_1');
    expect(store.activeChatId.value).toBe('chat_1');
    expect(store.thread.value.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(store.files.value[0].filename).toBe('out.csv');
  });
});

describe('sendMessage', () => {
  it('new chat: creates, primes cautious persona, streams, appends turns', async () => {
    streamOk('answer');
    const ok = await sendMessage('question', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).toHaveBeenCalled();
    expect(agentApi.streamMessage.mock.calls[0][1]).toBe('/persona cautious');
    expect(agentApi.streamMessage.mock.calls[1][1]).toBe('question');
    const roles = store.thread.value.map((t) => `${t.role}${t.chip ? ':chip' : ''}`);
    expect(roles).toEqual(['user:chip', 'assistant', 'user', 'assistant']);
    expect(store.thread.value.at(-1).text).toBe('answer');
    expect(store.streaming.value).toBe(false);
  });
  it('default persona sends no priming turn', async () => {
    store.personaChoice.value = 'default';
    streamOk('a');
    await sendMessage('q', []);
    expect(agentApi.streamMessage.mock.calls[0][1]).toBe('q');
  });
  it('429 lands in sendError and returns false (draft preserved by composer)', async () => {
    store.personaChoice.value = 'default';
    agentApi.streamMessage.mockRejectedValue(Object.assign(new Error('Agent error 429'), { status: 429 }));
    const ok = await sendMessage('q', []);
    expect(ok).toBe(false);
    expect(store.sendError.value).toMatch(/rate/i);
  });
  it('passes images through', async () => {
    store.personaChoice.value = 'default';
    streamOk('a');
    await sendMessage('look', [{ media_type: 'image/png', data: 'AAA=' }]);
    expect(agentApi.streamMessage.mock.calls[0][2].images).toEqual([{ media_type: 'image/png', data: 'AAA=' }]);
  });
});

describe('stopStreaming', () => {
  it('keeps the partial fold as an interrupted turn', async () => {
    store.personaChoice.value = 'default';
    agentApi.streamMessage.mockImplementation((id, content, { onEvent, signal }) => new Promise((resolve, reject) => {
      onEvent({ type: 'text-delta', delta: 'par' });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = sendMessage('q', []);
    await Promise.resolve();
    stopStreaming();
    await p;
    const last = store.thread.value.at(-1);
    expect(last).toMatchObject({ role: 'assistant', text: 'par', interrupted: true });
  });
});

describe('sendFeedback', () => {
  it('PUTs and optimistically marks the turn', async () => {
    await openChat('chat_1');
    await sendFeedback(0, true);
    expect(agentApi.submitFeedback).toHaveBeenCalledWith('chat_1', 0, true);
    expect(store.thread.value[1].feedback).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-chat.test.js`
Expected: FAIL — `src/fabry/chat.js` does not exist.

- [ ] **Step 3: Implement `src/fabry/chat.js`**

```js
// Chat orchestration: the server owns all chat state; these actions mirror it
// into the store. One AbortController + loadId guard covers both stream and
// history loads so a chat switch can never write stale state (Inspector pattern).
import * as agentApi from '../agent/agentApi.js';
import { newAcc, foldEvents, replyText } from '../agent/agentStream.js';
import * as store from './store.js';
import { normalizeMessages, assistantOrdinal } from './thread.js';

let controller = null;
let loadId = 0;

function friendly(err) {
  if (err?.status === 429) return 'Rate-limited by the agent — try again shortly.';
  if (err?.status === 401) return null; // handled as app-level error
  return err?.message || 'Something went wrong talking to Mr. Fabry.';
}

export async function loadChats({ more = false } = {}) {
  store.chatsLoading.value = true;
  try {
    const offset = more ? store.chats.value.length : 0;
    const page = await agentApi.listChats({ limit: 50, offset });
    store.chats.value = more ? [...store.chats.value, ...page.chats] : page.chats;
    store.chatsTotal.value = page.total;
  } catch (err) {
    if (err?.status === 401) store.error.value = err.message;
    // other failures: sidebar simply stays as-is (degradation per spec §5)
  } finally {
    store.chatsLoading.value = false;
  }
}

function abortInFlight() {
  loadId += 1;
  if (controller) controller.abort();
  controller = null;
  store.streaming.value = false;
  store.liveTurn.value = null;
  return loadId;
}

export async function openChat(chatId) {
  const id = abortInFlight();
  store.activeChatId.value = chatId;
  store.thread.value = [];
  store.files.value = [];
  store.sendError.value = null;
  store.threadLoading.value = true;
  try {
    const detail = await agentApi.getChat(chatId);
    if (id !== loadId) return;
    store.thread.value = normalizeMessages(detail.messages);
    store.files.value = detail.files || [];
  } catch (err) {
    if (id !== loadId) return;
    if (err?.status === 401) store.error.value = err.message;
    else store.sendError.value = friendly(err);
  } finally {
    if (id === loadId) store.threadLoading.value = false;
  }
}

export function startNewChat() {
  abortInFlight();
  store.resetChatView();
}

function pushTurn(turn) {
  store.thread.value = [...store.thread.value, turn];
}

const BLANK_TURN = { chip: false, images: [], feedback: null, reasoning: '', tools: [], interrupted: false };

async function streamTurn(chatId, content, { images, signal } = {}) {
  const acc = newAcc();
  store.liveTurn.value = { ...acc };
  await agentApi.streamMessage(chatId, content, {
    images,
    signal,
    onEvent: (e) => {
      foldEvents(acc, [e]);
      store.liveTurn.value = { ...acc, tools: [...acc.tools] };
    },
  });
  return acc;
}

function accTurn(acc, interrupted) {
  return { ...BLANK_TURN, role: 'assistant', text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools, interrupted };
}

// Returns true on success, false on failure (the composer keeps its draft on false).
export async function sendMessage(text, images = []) {
  if (store.streaming.value) return false;
  const id = abortInFlight();
  controller = new AbortController();
  const signal = controller.signal;
  store.sendError.value = null;
  store.streaming.value = true;
  try {
    let chatId = store.activeChatId.value;
    if (!chatId) {
      chatId = await agentApi.createChat();
      if (id !== loadId) return false;
      store.activeChatId.value = chatId;
      if (store.personaChoice.value === 'cautious') {
        pushTurn({ ...BLANK_TURN, role: 'user', chip: true, text: '/persona cautious' });
        const prime = await streamTurn(chatId, '/persona cautious', { signal });
        if (id !== loadId) return false;
        pushTurn(accTurn(prime, false));
      }
    }
    pushTurn({ ...BLANK_TURN, role: 'user', text, images });
    const acc = await streamTurn(chatId, text, { images, signal });
    if (id !== loadId) return false;
    pushTurn(accTurn(acc, false));
    loadChats(); // refresh sidebar so the chat appears with its server preview
    return true;
  } catch (err) {
    if (id !== loadId) return false;
    if (err?.name === 'AbortError' || signal.aborted) {
      // stopStreaming already kept the partial turn
      return false;
    }
    if (err?.status === 401) { store.error.value = err.message; return false; }
    store.sendError.value = friendly(err);
    return false;
  } finally {
    if (id === loadId) {
      store.streaming.value = false;
      store.liveTurn.value = null;
      controller = null;
    }
  }
}

export function stopStreaming() {
  if (!store.streaming.value) return;
  const acc = store.liveTurn.value;
  if (acc) pushTurn(accTurn(acc, true));
  if (controller) controller.abort();
}

// `ordinal` is the assistant-turn ordinal — see the VERIFY-GATE note in thread.js.
export async function sendFeedback(ordinal, isPositive) {
  const chatId = store.activeChatId.value;
  if (!chatId) return;
  try {
    await agentApi.submitFeedback(chatId, ordinal, isPositive);
    let seen = -1;
    store.thread.value = store.thread.value.map((t) => {
      if (t.role !== 'assistant') return t;
      seen += 1;
      return seen === ordinal ? { ...t, feedback: isPositive } : t;
    });
  } catch (err) {
    if (err?.status === 401) store.error.value = err.message;
    else store.sendError.value = friendly(err);
  }
}

export async function downloadFile(filename) {
  const chatId = store.activeChatId.value;
  if (!chatId) return;
  try {
    const blob = await agentApi.downloadChatFile(chatId, filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    store.sendError.value = friendly(err);
  }
}
```

(`assistantOrdinal` from `thread.js` stays a standalone helper — it documents the
VERIFY-GATE mapping; `Thread.jsx` counts ordinals inline while rendering.)

- [ ] **Step 4: Full `src/fabry/index.jsx`**

```js
import { effect } from '@preact/signals';
import * as agentApi from '../agent/agentApi.js';
import * as store from './store.js';
import { loadChats, openChat } from './chat.js';
import { resolveTabState, writeTabState } from '../console/tabState.js';

let wired = false;

export async function initFabry() {
  store.agentAvailable.value = await agentApi.probeAgent();
  if (!store.agentAvailable.value) return;

  agentApi.listCommands().then((cmds) => { store.commands.value = cmds; });
  await loadChats();

  // Per-tab restore of the open conversation (id only — content stays server-side).
  try {
    const stored = await chrome.storage.local.get('fabryActiveChat');
    const saved = resolveTabState(['fabryActiveChat'], stored).fabryActiveChat;
    if (saved && typeof saved === 'string') openChat(saved).catch(() => {});
  } catch { /* restore is best-effort */ }

  if (!wired) {
    wired = true;
    effect(() => { writeTabState('fabryActiveChat', store.activeChatId.value); });
  }
}
```

- [ ] **Step 5: Add the tab-state key**

`src/console/tabState.js` — `TAB_SCOPED_KEYS` gains `'fabryActiveChat'` (after `'consoleActiveApp'`).

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/fabry-chat.test.js tests/console-tab-state.test.js` → pass. `npm test` → green.

---

### Task 7: App layout + Sidebar

**Files:**
- Modify: `src/fabry/components/App.jsx` (replace skeleton)
- Create: `src/fabry/components/Sidebar.jsx`
- Modify: `src/console/console.css`
- Test: `tests/fabry-sidebar.test.js`, `tests/fabry-app.test.js`

**Interfaces:**
- Consumes: store signals, `chat.js` actions, `format.js` helpers.
- Produces: `App({ connected })` — offline / booting / two-column layout; `Sidebar()` — self-contained (reads store, calls `chat.js`).
- Thread column internals (`Thread`, `Composer`, `FilesStrip`) arrive in Tasks 8–10; `App` renders a `<main class="fabry-main">` with a placeholder `<div class="fabry-thread-slot" />` until Task 8 replaces it.

- [ ] **Step 1: Write the failing tests**

`tests/fabry-sidebar.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Sidebar from '../src/fabry/components/Sidebar.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Sidebar, null), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.chats.value = [
    { chat_id: 'chat_1', timestamp: 1760000000, message_count: 4, first_message: 'find failed exports', summary: 'Failed exports triage' },
    { chat_id: 'chat_2', timestamp: 1760000000, message_count: 1, first_message: 'hello' },
  ];
  store.chatsTotal.value = 10;
  store.activeChatId.value = 'chat_2';
  store.chatsLoading.value = false;
});

describe('Sidebar', () => {
  it('renders rows with title fallback chain and marks the active one', () => {
    const root = mount();
    const rows = [...root.querySelectorAll('.fabry-chat-row')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Failed exports triage'); // summary wins
    expect(rows[1].textContent).toContain('hello'); // first_message fallback
    expect(rows[1].classList.contains('active')).toBe(true);
  });
  it('clicking a row opens it; New chat resets', () => {
    const root = mount();
    root.querySelectorAll('.fabry-chat-row')[0].click();
    expect(chat.openChat).toHaveBeenCalledWith('chat_1');
    root.querySelector('.fabry-newchat').click();
    expect(chat.startNewChat).toHaveBeenCalled();
  });
  it('shows Load more only while more exist', () => {
    const root = mount();
    expect(root.querySelector('.fabry-loadmore')).toBeTruthy();
    store.chatsTotal.value = 2;
    const root2 = mount();
    expect(root2.querySelector('.fabry-loadmore')).toBeNull();
  });
});
```

`tests/fabry-app.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(), sendMessage: vi.fn(),
  stopStreaming: vi.fn(), sendFeedback: vi.fn(), downloadFile: vi.fn(),
}));

import * as store from '../src/fabry/store.js';
import App from '../src/fabry/components/App.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(App, props), root);
  return root;
}

describe('Fabry App states', () => {
  beforeEach(() => { store.agentAvailable.value = true; store.error.value = null; });
  it('not connected message', () => {
    expect(mount({ connected: false }).textContent).toContain('Not connected');
  });
  it('agent offline state', () => {
    store.agentAvailable.value = false;
    expect(mount({ connected: true }).textContent).toContain('offline');
  });
  it('connected renders sidebar + main', () => {
    const root = mount({ connected: true });
    expect(root.querySelector('.fabry-sidebar')).toBeTruthy();
    expect(root.querySelector('.fabry-main')).toBeTruthy();
  });
  it('app-level error shows the banner', () => {
    store.error.value = 'Session expired. Reconnect.';
    expect(mount({ connected: true }).querySelector('.fabry-error').textContent).toContain('Session expired');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-sidebar.test.js tests/fabry-app.test.js`
Expected: FAIL — `Sidebar.jsx` missing; App lacks layout.

- [ ] **Step 3: Implement `src/fabry/components/Sidebar.jsx`**

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import { loadChats, openChat, startNewChat } from '../chat.js';
import { tsToMs, relativeTime, chatTitle } from '../format.js';

export default function Sidebar() {
  const list = store.chats.value;
  const hasMore = store.chatsTotal.value != null && list.length < store.chatsTotal.value;
  return (
    <aside class="fabry-sidebar">
      <button type="button" class="fabry-newchat" onClick={startNewChat}>{'＋ New chat'}</button>
      <div class="fabry-chatlist">
        {list.map((c) => (
          <button
            type="button"
            key={c.chat_id}
            class={'fabry-chat-row' + (store.activeChatId.value === c.chat_id ? ' active' : '')}
            onClick={() => openChat(c.chat_id)}
          >
            <span class="fabry-chat-title">{chatTitle(c)}</span>
            <span class="fabry-chat-meta">{relativeTime(tsToMs(c.timestamp))} {'·'} {c.message_count}</span>
          </button>
        ))}
        {list.length === 0 && !store.chatsLoading.value && <div class="fabry-chat-empty">No conversations yet</div>}
      </div>
      {hasMore && (
        <button type="button" class="fabry-loadmore" disabled={store.chatsLoading.value} onClick={() => loadChats({ more: true })}>
          Load more
        </button>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Implement `src/fabry/components/App.jsx`** (replace skeleton)

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import Sidebar from './Sidebar.jsx';

export default function App({ connected }) {
  if (!connected) {
    return <div class="app-root"><div class="empty-state">Not connected. Open a Rossum page and launch the Console again.</div></div>;
  }
  if (store.agentAvailable.value === false) {
    return <div class="app-root"><div class="empty-state">Mr. Fabry is offline (agent unreachable). Try again later.</div></div>;
  }
  return (
    <div class="app-root fabry-root">
      {store.error.value && <div class="fabry-error">{store.error.value}</div>}
      <div class="fabry-layout">
        <Sidebar />
        <main class="fabry-main">
          <div class="fabry-thread-slot" />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: CSS** (append to `src/console/console.css`; all colors via existing variables)

```css
/* ==== Fabry chat app ==== */
.fabry-root { display: flex; flex-direction: column; min-height: 0; }
.fabry-error { background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-border); border-radius: var(--radius); padding: 8px 12px; margin: 8px; font-size: 12px; }
.fabry-layout { display: grid; grid-template-columns: 280px 1fr; flex: 1; min-height: 0; }
.fabry-sidebar { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); padding: 10px; gap: 8px; }
.fabry-newchat { border: 1px solid var(--diag-border); color: var(--diag-fg); background: linear-gradient(180deg, var(--diag-grad-a), var(--diag-grad-b)); border-radius: var(--radius); padding: 7px 10px; font-weight: 600; cursor: pointer; }
.fabry-chatlist { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; overscroll-behavior: contain; }
.fabry-chat-row { display: flex; flex-direction: column; gap: 2px; text-align: left; border: 0; background: none; border-radius: 8px; padding: 7px 9px; cursor: pointer; }
.fabry-chat-row:hover { background: var(--surface-hover); }
.fabry-chat-row.active { background: var(--diag-grad-b); }
.fabry-chat-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fabry-chat-meta { font-size: 10px; color: var(--text-muted); }
.fabry-chat-empty { font-size: 12px; color: var(--text-muted); padding: 12px; text-align: center; }
.fabry-loadmore { border: 1px dashed var(--border); background: none; border-radius: 8px; padding: 6px; font-size: 11px; cursor: pointer; color: var(--text-muted); }
.fabry-main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
```

Note: verify variable names against the top of `console.css` (`--border`, `--surface-hover`, `--text-muted`, `--danger-*`) — if a name differs, use the file's actual token; do not invent new variables.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/fabry-sidebar.test.js tests/fabry-app.test.js` → pass. `npm test` → green.

---

### Task 8: Thread + turn components

**Files:**
- Create: `src/fabry/components/Thread.jsx`, `src/fabry/components/AssistantTurn.jsx`
- Modify: `src/fabry/components/App.jsx` (mount Thread in `.fabry-main`), `src/console/console.css`
- Test: `tests/fabry-thread-view.test.js`

**Interfaces:**
- Consumes: `store.thread/liveTurn/streaming/threadLoading/activeChatId`, `FabryMarkdown`, `GerundLoader`, `chat.sendFeedback`, `chat.openChat`, `thread.assistantOrdinal`.
- Produces: `Thread()` — scrolling turn list + live streaming turn + new-chat empty state; `AssistantTurn({ turn, ordinal, streaming })`.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-thread-view.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  sendFeedback: vi.fn(), openChat: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Thread from '../src/fabry/components/Thread.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Thread, null), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeChatId.value = 'chat_1';
  store.threadLoading.value = false;
  store.streaming.value = false;
  store.liveTurn.value = null;
  store.thread.value = [
    { role: 'user', chip: true, text: '/persona cautious', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'assistant', chip: false, text: 'Persona set.', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'user', chip: false, text: '**q**', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'assistant', chip: false, text: 'the **answer**', images: [], feedback: true, reasoning: 'thought hard', tools: ['rossum_get_queue'], interrupted: false },
  ];
});

describe('Thread', () => {
  it('renders chips, user turns, assistant markdown, reasoning and tool chips', () => {
    const root = mount();
    expect(root.querySelector('.fabry-turn-chip').textContent).toContain('/persona cautious');
    expect(root.querySelectorAll('.fabry-turn-user').length).toBe(1); // chip is not a user bubble
    expect(root.querySelector('.fabry-turn-assistant .fabry-md strong').textContent).toBe('answer');
    expect(root.querySelector('.fabry-tools').textContent).toContain('reading the queue');
    expect(root.querySelector('.fabry-thinking')).toBeTruthy();
  });
  it('feedback buttons call sendFeedback with the assistant ordinal', () => {
    const root = mount();
    const turns = root.querySelectorAll('.fabry-turn-assistant');
    turns[1].querySelector('.fabry-fb-up').click();
    expect(chat.sendFeedback).toHaveBeenCalledWith(1, true);
  });
  it('renders the streaming live turn with a caret and the interrupted refresh row', () => {
    store.streaming.value = true;
    store.liveTurn.value = { reasoning: 'r', text: 'partial', tools: [], status: 'thinking', done: false };
    const root = mount();
    expect(root.querySelector('.fabry-turn-live .fabry-caret')).toBeTruthy();
    store.streaming.value = false;
    store.liveTurn.value = null;
    store.thread.value = [...store.thread.value, { role: 'assistant', chip: false, text: 'par', images: [], feedback: null, reasoning: '', tools: [], interrupted: true }];
    const root2 = mount();
    root2.querySelector('.fabry-refresh').click();
    expect(chat.openChat).toHaveBeenCalledWith('chat_1');
  });
  it('empty new chat shows the greeting', () => {
    store.activeChatId.value = null;
    store.thread.value = [];
    expect(mount().querySelector('.fabry-greeting')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-thread-view.test.js`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement `src/fabry/components/AssistantTurn.jsx`**

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import { toolLabel } from '../../agent/agentStream.js';
import { sendFeedback, openChat } from '../chat.js';
import * as store from '../store.js';

// One assistant turn: collapsible reasoning, ordered tool chips, markdown body,
// feedback + copy footer. `ordinal` is the assistant-turn ordinal used as the
// feedback turn_index (VERIFY-GATE, see thread.js).
export default function AssistantTurn({ turn, ordinal, streaming }) {
  const [showThinking, setShowThinking] = useState(false);
  const open = streaming || showThinking; // stream visibly, collapse when done
  return (
    <div class={'fabry-turn-assistant' + (streaming ? ' fabry-turn-live' : '')}>
      {turn.reasoning ? (
        <div class="fabry-thinking">
          <button type="button" class="fabry-thinking-toggle" onClick={() => setShowThinking(!showThinking)}>
            {open ? 'Thinking ▾' : 'Thinking ▸'}
          </button>
          {open && <pre class="fabry-thinking-body">{turn.reasoning}</pre>}
        </div>
      ) : null}
      {turn.tools && turn.tools.length ? (
        <div class="fabry-tools">{turn.tools.map((t) => <span class="fabry-tool-chip" title={t}>{toolLabel(t)}</span>)}</div>
      ) : null}
      <FabryMarkdown text={turn.text} streaming={streaming} />
      {turn.interrupted && (
        <div class="fabry-interrupted">
          Stopped before the reply finished.{' '}
          <button type="button" class="fabry-refresh" onClick={() => openChat(store.activeChatId.value)}>Refresh from server</button>
        </div>
      )}
      {!streaming && !turn.interrupted && (
        <div class="fabry-turn-foot">
          <button type="button" class={'fabry-fb-up' + (turn.feedback === true ? ' on' : '')} title="Good answer" onClick={() => sendFeedback(ordinal, true)}>{'\u{1F44D}'}</button>
          <button type="button" class={'fabry-fb-down' + (turn.feedback === false ? ' on' : '')} title="Bad answer" onClick={() => sendFeedback(ordinal, false)}>{'\u{1F44E}'}</button>
          <button type="button" class="fabry-copy" title="Copy reply" onClick={() => navigator.clipboard?.writeText(turn.text)}>Copy</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/fabry/components/Thread.jsx`**

```jsx
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import * as store from '../store.js';
import AssistantTurn from './AssistantTurn.jsx';

function UserTurn({ turn }) {
  if (turn.chip) return <div class="fabry-turn-chip">{turn.text}</div>;
  return (
    <div class="fabry-turn-user">
      {turn.images.map((img) => <img class="fabry-turn-img" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />)}
      <div class="fabry-turn-user-text">{turn.text}</div>
    </div>
  );
}

export default function Thread() {
  const ref = useRef(null);
  const turns = store.thread.value;
  const live = store.liveTurn.value;

  // Pin-to-bottom: only auto-scroll when the user hasn't scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns, live && live.text, live && live.reasoning]);

  if (!store.activeChatId.value && turns.length === 0) {
    return (
      <div class="fabry-greeting">
        <div class="fabry-greeting-mark">{'✦'}</div>
        <div class="fabry-greeting-title">Ask Mr. Fabry about this organization</div>
        <div class="fabry-greeting-sub">Queues, extensions, documents, data {'—'} Fabry investigates with its own tools.</div>
      </div>
    );
  }

  let ordinal = -1;
  return (
    <div class="fabry-thread" ref={ref}>
      {store.threadLoading.value && <div class="fabry-thread-loading">Loading conversation{'…'}</div>}
      {turns.map((t) => {
        if (t.role !== 'assistant') return <UserTurn turn={t} />;
        ordinal += 1;
        return <AssistantTurn turn={t} ordinal={ordinal} streaming={false} />;
      })}
      {store.streaming.value && live && (
        <AssistantTurn turn={{ text: live.text, reasoning: live.reasoning, tools: live.tools || [], feedback: null, interrupted: false }} ordinal={ordinal + 1} streaming />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Mount in `App.jsx`** — replace `<div class="fabry-thread-slot" />` with `<Thread />` (+ import).

- [ ] **Step 6: CSS** (append)

```css
.fabry-thread { flex: 1; overflow-y: auto; min-height: 0; padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; max-width: 860px; width: 100%; margin: 0 auto; overscroll-behavior: contain; }
.fabry-turn-chip { align-self: center; font-size: 11px; color: var(--text-muted); border: 1px dashed var(--border); border-radius: 999px; padding: 2px 10px; font-family: var(--mono, monospace); }
.fabry-turn-user { align-self: flex-end; max-width: 78%; background: var(--diag-grad-b); border: 1px solid var(--diag-border); border-radius: 12px 12px 4px 12px; padding: 9px 12px; font-size: 13px; white-space: pre-wrap; }
.fabry-turn-img { max-width: 220px; max-height: 160px; border-radius: 8px; display: block; margin-bottom: 6px; }
.fabry-turn-assistant { align-self: stretch; font-size: 13px; line-height: 1.55; }
.fabry-thinking-toggle { border: 0; background: none; color: var(--diag-fg); font-size: 11px; cursor: pointer; padding: 0; }
.fabry-thinking-body { font-size: 11px; color: var(--text-muted); border-left: 2px solid var(--diag-border); padding: 4px 10px; margin: 6px 0; white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
.fabry-tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.fabry-tool-chip { font-size: 10px; color: var(--diag-fg); border: 1px solid var(--diag-border); border-radius: 999px; padding: 1px 8px; }
.fabry-md p { margin: 6px 0; }
.fabry-md-code { background: var(--surface-inset, rgba(0,0,0,.05)); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12px; }
.fabry-md-icode { background: var(--surface-inset, rgba(0,0,0,.05)); border-radius: 4px; padding: 0 4px; font-size: 12px; }
.fabry-md-tablewrap { overflow-x: auto; }
.fabry-md-table { border-collapse: collapse; font-size: 12px; }
.fabry-md-table th, .fabry-md-table td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.fabry-md-quote { border-left: 3px solid var(--diag-border); margin: 6px 0; padding: 2px 10px; color: var(--text-muted); }
.fabry-md-h { margin: 10px 0 4px; }
.fabry-caret { display: inline-block; width: 7px; height: 14px; background: var(--diag-fg); margin-left: 2px; animation: fabry-blink 1s steps(1) infinite; vertical-align: text-bottom; }
@keyframes fabry-blink { 50% { opacity: 0; } }
.fabry-turn-foot { display: flex; gap: 6px; margin-top: 6px; }
.fabry-turn-foot button { border: 1px solid var(--border); background: none; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; opacity: .7; }
.fabry-turn-foot button:hover, .fabry-turn-foot button.on { opacity: 1; border-color: var(--diag-border); color: var(--diag-fg); }
.fabry-interrupted { font-size: 11px; color: var(--warning-fg, #92600a); margin-top: 6px; }
.fabry-refresh { border: 0; background: none; color: var(--diag-fg); cursor: pointer; text-decoration: underline; font-size: 11px; }
.fabry-greeting { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text-muted); }
.fabry-greeting-mark { font-size: 28px; color: var(--diag-fg); }
.fabry-greeting-title { font-size: 16px; font-weight: 700; color: var(--text); }
.fabry-thread-loading { text-align: center; color: var(--text-muted); font-size: 12px; }
```

(Same variable-name caveat as Task 7.)

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/fabry-thread-view.test.js tests/fabry-app.test.js` → pass. `npm test` → green.

---

### Task 9: Composer, attachments, command autocomplete, persona picker

**Files:**
- Create: `src/fabry/components/Composer.jsx`, `src/fabry/components/CommandMenu.jsx`
- Modify: `src/fabry/components/App.jsx` (mount Composer under Thread), `src/console/console.css`
- Test: `tests/fabry-composer.test.js`

**Interfaces:**
- Consumes: `store.streaming/sendError/commands/personaChoice/activeChatId`, `chat.sendMessage/stopStreaming`, `GerundLoader`.
- Produces: `Composer()` — self-contained (owns its draft + attachments); `CommandMenu({ query, commands, onPick })` — pure presentational.
- Attachment caps: max 4 images, 5 MB each (defensive client cap — server limit undocumented), MIME whitelist `image/png|jpeg|gif|webp`.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-composer.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(true), stopStreaming: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Composer from '../src/fabry/components/Composer.jsx';
import CommandMenu from '../src/fabry/components/CommandMenu.jsx';

function mount(Comp, props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, props), root);
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  store.streaming.value = false;
  store.sendError.value = null;
  store.activeChatId.value = null;
  store.personaChoice.value = 'cautious';
  store.commands.value = [
    { name: '/persona', description: 'switch persona', argument_suggestions: [{ value: 'cautious', description: 'safe' }] },
    { name: '/list-skills', description: 'skills', argument_suggestions: [] },
  ];
});

describe('Composer', () => {
  it('Enter sends and clears; Shift+Enter does not send', async () => {
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = 'hello'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(chat.sendMessage).toHaveBeenCalledWith('hello', []);
    expect(root.querySelector('textarea').value).toBe('');
  });
  it('keeps the draft when sendMessage fails', async () => {
    chat.sendMessage.mockResolvedValue(false);
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = 'draft'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(root.querySelector('textarea').value).toBe('draft');
  });
  it('shows Stop while streaming and calls stopStreaming', () => {
    store.streaming.value = true;
    const root = mount(Composer, {});
    const stop = root.querySelector('.fabry-stop');
    expect(stop).toBeTruthy();
    stop.click();
    expect(chat.stopStreaming).toHaveBeenCalled();
  });
  it('persona picker renders only for a new chat and flips the signal', () => {
    const root = mount(Composer, {});
    const seg = root.querySelectorAll('.fabry-persona button');
    expect(seg.length).toBe(2);
    seg[1].click();
    expect(store.personaChoice.value).toBe('default');
    store.activeChatId.value = 'chat_1';
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-persona')).toBeNull();
  });
  it('typing / opens the command menu; inline send error renders', () => {
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = '/li'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.fabry-cmdmenu').textContent).toContain('/list-skills');
    store.sendError.value = 'Rate-limited by the agent — try again shortly.';
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-senderr').textContent).toMatch(/Rate-limited/);
  });
  it('always shows the standing capability notice', () => {
    expect(mount(Composer, {}).querySelector('.fabry-notice').textContent).toMatch(/can .*modif/i);
  });
});

describe('CommandMenu', () => {
  it('filters by prefix and picks with arguments', () => {
    const onPick = vi.fn();
    const root = mount(CommandMenu, { query: '/pe', commands: store.commands.value, onPick });
    const rows = [...root.querySelectorAll('.fabry-cmd-row')];
    expect(rows.length).toBe(1);
    rows[0].click();
    expect(onPick).toHaveBeenCalledWith('/persona ');
    const sug = root.querySelector('.fabry-cmd-arg');
    sug.click();
    expect(onPick).toHaveBeenCalledWith('/persona cautious');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-composer.test.js`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement `src/fabry/components/CommandMenu.jsx`**

```jsx
import { h } from 'preact';

// Pure popover listing slash commands matching `query` ('' hides nothing).
export default function CommandMenu({ query, commands, onPick }) {
  const q = (query || '').toLowerCase();
  const hits = (commands || []).filter((c) => c.name.toLowerCase().startsWith(q));
  if (!hits.length) return null;
  return (
    <div class="fabry-cmdmenu">
      {hits.map((c) => (
        <div class="fabry-cmd">
          <button type="button" class="fabry-cmd-row" onClick={() => onPick(c.name + ' ')}>
            <span class="fabry-cmd-name">{c.name}</span>
            <span class="fabry-cmd-desc">{c.description}</span>
          </button>
          {(c.argument_suggestions || []).map((s) => (
            <button type="button" class="fabry-cmd-arg" title={s.description} onClick={() => onPick(`${c.name} ${s.value}`)}>
              {s.value}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/fabry/components/Composer.jsx`**

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { sendMessage, stopStreaming } from '../chat.js';
import GerundLoader from '../../ui/GerundLoader.jsx';
import CommandMenu from './CommandMenu.jsx';

const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const GERUNDS = ['Thinking', 'Investigating', 'Reading', 'Cross-checking', 'Answering'];

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ media_type: file.type, data: String(r.result).split(',')[1] });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Composer() {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState([]);
  const streaming = store.streaming.value;
  const isNewChat = !store.activeChatId.value;

  async function addFiles(files) {
    const picked = [...files].filter((f) => IMG_TYPES.includes(f.type) && f.size <= MAX_BYTES);
    const room = MAX_IMAGES - images.length;
    const converted = await Promise.all(picked.slice(0, room).map(fileToImage));
    setImages((cur) => [...cur, ...converted]);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    const sent = [...images];
    setImages([]);
    const ok = await sendMessage(text, sent);
    if (!ok) { setDraft(text); setImages(sent); }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }

  const showMenu = draft.startsWith('/') && !draft.includes('\n') && store.commands.value.length > 0;

  return (
    <div class="fabry-composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files || []); }}>
      {store.sendError.value && <div class="fabry-senderr">{store.sendError.value}</div>}
      {isNewChat && (
        <div class="fabry-persona">
          <span class="fabry-persona-label">Persona</span>
          {['cautious', 'default'].map((p) => (
            <button type="button" class={store.personaChoice.value === p ? 'on' : ''} onClick={() => { store.personaChoice.value = p; }}>{p}</button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div class="fabry-attach-row">
          {images.map((img, i) => (
            <span class="fabry-attach">
              <img src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />
              <button type="button" title="Remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>{'×'}</button>
            </span>
          ))}
        </div>
      )}
      <div class="fabry-input-wrap">
        {showMenu && <CommandMenu query={draft} commands={store.commands.value} onPick={(v) => setDraft(v)} />}
        <textarea
          class="fabry-input"
          rows={2}
          placeholder={'Message Mr. Fabry… (Enter to send, Shift+Enter for a new line)'}
          value={draft}
          disabled={streaming}
          onInput={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="fabry-input-actions">
          <label class="fabry-attach-btn" title="Attach image">
            {'\u{1F4CE}'}
            <input type="file" accept={IMG_TYPES.join(',')} multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          {streaming
            ? <button type="button" class="fabry-stop" onClick={stopStreaming}>Stop</button>
            : <button type="button" class="fabry-send" disabled={!draft.trim()} onClick={submit}>Send</button>}
        </div>
        {streaming && <GerundLoader gerunds={GERUNDS} />}
      </div>
      <div class="fabry-notice">
        Mr. Fabry can read this organization and, in the default persona, act on it {'—'} including modifications. The cautious persona asks before writes.
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount in `App.jsx`** — `.fabry-main` becomes `<Thread />` + `<Composer />` (import both).

- [ ] **Step 6: CSS** (append)

```css
.fabry-composer { padding: 10px 22px 14px; max-width: 860px; width: 100%; margin: 0 auto; position: relative; }
.fabry-senderr { color: var(--danger-fg); font-size: 12px; margin-bottom: 6px; }
.fabry-persona { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 11px; color: var(--text-muted); }
.fabry-persona button { border: 1px solid var(--border); background: none; border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
.fabry-persona button.on { border-color: var(--diag-border); color: var(--diag-fg); background: var(--diag-grad-b); }
.fabry-attach-row { display: flex; gap: 8px; margin-bottom: 8px; }
.fabry-attach { position: relative; }
.fabry-attach img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
.fabry-attach button { position: absolute; top: -6px; right: -6px; border: 1px solid var(--border); background: var(--surface); border-radius: 999px; width: 18px; height: 18px; line-height: 1; font-size: 11px; cursor: pointer; }
.fabry-input-wrap { position: relative; display: flex; gap: 8px; align-items: flex-end; }
.fabry-input { flex: 1; resize: none; border: 1px solid var(--diag-border); border-radius: 12px; padding: 10px 12px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); max-height: 180px; }
.fabry-input:focus { outline: 2px solid var(--diag-border); }
.fabry-input-actions { display: flex; gap: 6px; align-items: center; }
.fabry-attach-btn { cursor: pointer; font-size: 15px; opacity: .7; }
.fabry-attach-btn:hover { opacity: 1; }
.fabry-send, .fabry-stop { border: 1px solid var(--diag-border); border-radius: 10px; padding: 8px 16px; font-weight: 600; cursor: pointer; color: var(--diag-fg); background: linear-gradient(180deg, var(--diag-grad-a), var(--diag-grad-b)); }
.fabry-send:disabled { opacity: .5; cursor: default; }
.fabry-cmdmenu { position: absolute; bottom: 100%; left: 0; right: 0; margin-bottom: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; max-height: 260px; overflow-y: auto; z-index: 5; }
.fabry-cmd-row { display: flex; gap: 10px; width: 100%; text-align: left; border: 0; background: none; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.fabry-cmd-row:hover { background: var(--surface-hover); }
.fabry-cmd-name { font-family: var(--mono, monospace); font-size: 12px; color: var(--diag-fg); }
.fabry-cmd-desc { font-size: 11px; color: var(--text-muted); }
.fabry-cmd-arg { border: 1px solid var(--diag-border); background: none; color: var(--diag-fg); border-radius: 999px; font-size: 10px; padding: 1px 8px; margin: 0 0 4px 26px; cursor: pointer; }
.fabry-notice { font-size: 10.5px; color: var(--text-muted); margin-top: 8px; text-align: center; }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/fabry-composer.test.js tests/fabry-app.test.js` → pass. `npm test` → green.

---

### Task 10: Header + files strip

**Files:**
- Create: `src/fabry/components/ChatHeader.jsx`, `src/fabry/components/FilesStrip.jsx`
- Modify: `src/fabry/components/App.jsx` (mount both), `src/console/console.css`
- Test: `tests/fabry-header-files.test.js`

**Interfaces:**
- Consumes: `store.activeChatId/chats/thread/files`, `format.chatTitle`, `thread.personaOf`, `chat.downloadFile`.
- Produces: `ChatHeader()` — title from the sidebar summary of the active chat (fallback: first user turn text), persona pill when known, quiet token stat when the summary carries totals; `FilesStrip()` — one row per file with a download button.

- [ ] **Step 1: Write the failing tests** (`tests/fabry-header-files.test.js`)

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({ downloadFile: vi.fn() }));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import ChatHeader from '../src/fabry/components/ChatHeader.jsx';
import FilesStrip from '../src/fabry/components/FilesStrip.jsx';

function mount(Comp) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, null), root);
  return root;
}

beforeEach(() => {
  store.activeChatId.value = 'chat_1';
  store.chats.value = [{ chat_id: 'chat_1', timestamp: 1, message_count: 2, first_message: 'hi', summary: 'Failed exports triage', total_input_tokens: 1200, total_output_tokens: 800 }];
  store.thread.value = [
    { role: 'user', chip: true, text: '/persona cautious', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
  ];
  store.files.value = [{ filename: 'out.csv', size: 2048, timestamp: 't' }];
});

describe('ChatHeader', () => {
  it('shows title, persona pill and token stat', () => {
    const root = mount(ChatHeader);
    expect(root.textContent).toContain('Failed exports triage');
    expect(root.querySelector('.fabry-hd-persona').textContent).toBe('cautious');
    expect(root.querySelector('.fabry-hd-tokens').textContent).toContain('2.0k');
  });
  it('renders nothing without an active chat', () => {
    store.activeChatId.value = null;
    expect(mount(ChatHeader).querySelector('.fabry-hd')).toBeNull();
  });
});

describe('FilesStrip', () => {
  it('lists files and downloads on click', () => {
    const root = mount(FilesStrip);
    expect(root.textContent).toContain('out.csv');
    expect(root.textContent).toContain('2.0 KB');
    root.querySelector('.fabry-file-dl').click();
    expect(chat.downloadFile).toHaveBeenCalledWith('out.csv');
  });
  it('renders nothing when no files', () => {
    store.files.value = [];
    expect(mount(FilesStrip).querySelector('.fabry-files')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fabry-header-files.test.js` → FAIL (components missing).

- [ ] **Step 3: Implement**

`src/fabry/components/ChatHeader.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import { chatTitle } from '../format.js';
import { personaOf } from '../thread.js';

function kTokens(s) {
  const n = (s?.total_input_tokens || 0) + (s?.total_output_tokens || 0);
  return n > 0 ? `${(n / 1000).toFixed(1)}k tokens` : null;
}

export default function ChatHeader() {
  const id = store.activeChatId.value;
  if (!id) return null;
  const summary = store.chats.value.find((c) => c.chat_id === id);
  const firstUser = store.thread.value.find((t) => t.role === 'user' && !t.chip);
  const title = summary ? chatTitle(summary) : (firstUser?.text || 'Conversation');
  const persona = personaOf(store.thread.value);
  const tokens = kTokens(summary);
  return (
    <header class="fabry-hd">
      <span class="fabry-hd-title" title={title}>{title}</span>
      {persona && <span class="fabry-hd-persona">{persona}</span>}
      {tokens && <span class="fabry-hd-tokens">{tokens}</span>}
    </header>
  );
}
```

`src/fabry/components/FilesStrip.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import { downloadFile } from '../chat.js';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesStrip() {
  const files = store.files.value;
  if (!files.length) return null;
  return (
    <div class="fabry-files">
      {files.map((f) => (
        <span class="fabry-file">
          <span class="fabry-file-name" title={f.filename}>{f.filename}</span>
          <span class="fabry-file-size">{fmtBytes(f.size)}</span>
          <button type="button" class="fabry-file-dl" title="Download" onClick={() => downloadFile(f.filename)}>{'⤓'}</button>
        </span>
      ))}
    </div>
  );
}
```

`App.jsx` `.fabry-main` final order: `<ChatHeader />`, `<Thread />`, `<FilesStrip />`, `<Composer />`.

- [ ] **Step 4: CSS** (append)

```css
.fabry-hd { display: flex; align-items: center; gap: 10px; padding: 10px 22px; border-bottom: 1px solid var(--border); max-width: 860px; width: 100%; margin: 0 auto; }
.fabry-hd-title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fabry-hd-persona { font-size: 10px; color: var(--diag-fg); border: 1px solid var(--diag-border); border-radius: 999px; padding: 1px 8px; }
.fabry-hd-tokens { margin-left: auto; font-size: 10px; color: var(--text-muted); }
.fabry-files { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 22px; max-width: 860px; width: 100%; margin: 0 auto; }
.fabry-file { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 11px; }
.fabry-file-size { color: var(--text-muted); font-size: 10px; }
.fabry-file-dl { border: 0; background: none; cursor: pointer; color: var(--diag-fg); font-size: 13px; }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fabry-header-files.test.js` → pass. `npm test` → green.

---

### Task 11: Docs, build, and live verification gates

**Files:**
- Modify: `CLAUDE.md`
- No source changes (unless verification finds bugs).

- [ ] **Step 1: Update CLAUDE.md**

Additions (keep the existing style):
- Architecture: document `src/agent/` as the shared Rossum Agent API transport (moved from `src/mdh/agent/`; `agentQuery.js`/`aiContext.js` remain MDH-specific), and a new "### Fabry Chat (`src/fabry/`)" subsection: fifth Console app, Claude-style chat over the Agent API, experimental-gated (`experimentalUnlocked`), server-owned chat state (list/get/feedback/files/commands endpoints), hand-rolled markdown renderer in `src/ui/fabry/markdown.js`, persona picker (cautious default) + standing write-capability notice, per-tab `fabryActiveChat` (id only).
- Chrome Storage Keys: `fabryActiveChat` (per-tab via tabState; content-free chat id); note `experimentalUnlocked` now also gates the Fabry Console app.
- Note the three §10 verification gates' outcomes (Step 3) once known.

- [ ] **Step 2: Full verification**

```bash
npm test        # full suite green
npm run build   # dist/ rebuild — the loaded extension runs dist/, not src/
```

Expected: both succeed. Remind the owner to reload the unpacked extension (and any open Console tabs).

- [ ] **Step 3: Live verification gates (internal org only — spec §10)**

Dogfood with the agent-browser recipe (memory: `reference_extension_dogfood_agent_browser.md`). Never use a customer org. Checklist:

1. **turn_index semantics**: send 2+ turns, click 👍 on the second assistant turn, `GET /chats/{id}` — confirm the `feedback: true` lands on that assistant message. If it lands elsewhere, fix `assistantOrdinal` (message index vs ordinal) and its test.
2. **Abort behavior**: Stop mid-stream, then "Refresh from server" — observe whether the server reply completed anyway; adjust the interrupted-turn copy if so ("Stopped receiving — the agent may have finished server-side").
3. **Chat-list scoping**: confirm `GET /chats` only returns the current user+org's chats (compare two orgs if available).
4. **Re-confirm** `{content, images}` send shape (attach a small PNG, ask "what is in this image").
5. **Gate UX**: lock/unlock via the popup version hash with the Console open — rail item appears/disappears live; re-lock while Fabry is active switches to MDH; persisted `consoleActiveApp:'fabry'` + locked gate boots into MDH.
6. **Machine chats**: open an MDH-created chat from the sidebar — priming prompt renders as a chip, history is readable, continuing it works.

Record outcomes in CLAUDE.md/memory; fix + re-test anything that contradicts the assumptions (each gate maps to one function + one test).

---

## Self-Review Notes

- **Spec coverage**: §4 architecture → Tasks 4–6; §5 gating/backcompat → Task 4 (+ Task 6 tabState); §6 UI → Tasks 7–10; §7 data flow → Task 6; §8 errors → Tasks 2/6 (401/429/degradation) + Task 8 (interrupted turn); §9 privacy → global constraints + no-persistence store design; §10 gates → Task 11; §11 testing → per-task; §12 out of scope respected (no delete/rename, no cross-surface links, no drafts persistence).
- **Type consistency**: `Turn` shape defined once (Task 5) and reused verbatim in Tasks 6–10; transport signatures defined in Task 2 and consumed unchanged; `pickInitialApp`'s new param is optional (older call sites and tests unaffected).
- Ordering note: Tasks 7–10 layer UI over Task 6's actions; each mounts into `App.jsx` incrementally so the suite is green after every task.
- Conscious simplification vs spec §6: the new-chat state centers the ✦ greeting with the composer directly below it (bottom of the column), rather than literally mid-screen — same information, no extra layout mode. Flag to the owner during dogfood if it reads wrong.
