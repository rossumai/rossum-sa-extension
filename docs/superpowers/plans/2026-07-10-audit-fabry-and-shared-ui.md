# Mr. Fabry in Audit Logs + shared Fabry UI seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Mr. Fabry assistant to the Console's Audit Logs app — a top ask bar (MDH visual design) + an inline streaming-narrative answer panel (Inspector Diagnosis visual design) that auto-summarizes the latest audit activity and answers follow-up questions — built on a new minimal shared `src/ui/` component seed.

**Architecture:** New store-agnostic components in `src/ui/` (`GerundLoader`, `fabry/FabryInput`, `fabry/FabryNarrative`, `fabry/FabryTranscript`, `fabry/narrative.js`), all emitting the existing shared `console.css` classes. Audit-specific logic (`src/audit/fabry.js` prompt+runners, `src/audit/index.jsx` orchestration, `src/audit/store.js` state, `src/audit/components/FabryPanel.jsx`) composes them. Transport reuses the already-shared, already-initialized `src/mdh/agent/{agentApi,agentStream}.js`.

**Tech Stack:** Preact + `@preact/signals`, esbuild (IIFE bundle), Vitest + jsdom, the Rossum Agent API ("Mr. Fabry").

**Design spec:** `docs/superpowers/specs/2026-07-10-audit-fabry-and-shared-ui-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits are deferred.** The repo owner defers commits — do NOT `git commit` during execution. End each task at a **green full test suite** instead. (Owner preference; overrides the skill's per-task commit step. No `Co-Authored-By` trailer if a commit is ever requested.)
- **Tests** live in `tests/**/*.test.js` (flat names). DOM tests start with `// @vitest-environment jsdom`, use `import { h, render } from 'preact'`, an inline `waitFor` helper, and `vi.mock('../src/…')`. Never broaden `vitest.config.*`. Prefer condition-based `waitFor` over fixed `setTimeout` sleeps.
- **Test commands:** single file `npx vitest run tests/<file>.test.js`; full suite `npm test` (= `vitest run`).
- **Build for dogfood:** `npm run build` after UI changes (tests run against `src/`, but the loaded extension runs `dist/`). Then tell the owner to reload the unpacked extension.
- **No manifest change, no new `chrome.storage` keys, no persisted-state migration.** Fabry conversation state is ephemeral.
- **Reuse existing CSS classes** in `src/console/console.css` (`nl-search-*`, `agent-spark`, `inspector-diag-*`, `inspector-followup*`, `inspector-modal*`, `inspector-caret`, `inspector-diag-list`, `inspector-empty`, `inspector-esec-skel`, `inspector-fold-btn`, `inspector-code-block`, `inspector-note`). Add only the thin `.audit-fabry*` wrapper.
- **Reuse `src/mdh/agent/{agentApi,agentStream}.js` as-is** — no relocation (deferred).
- **MDH and Inspector are NOT modified** (they keep their own `parseNarrative` copies until their own migration spec).
- **No customer data** in code, tests, comments, or commits — use generic values (`a@b.c`, `queue 5`, `annotation 123`).
- **Read-only:** the agent's read-only framing is defense-in-depth only; the server-side write-lock remains the ship-blocker for non-dogfood use. This feature only reads.
- **JSX unicode:** use literal glyphs (`✦`, `…`, `×`, `↻`, `✨`) or `{'\uXXXX'}` expressions — never bare `\uXXXX` in JSX text/attributes (renders literally). En-dashes etc. inside plain JS strings are fine.

---

### Task 1: Verification spike — does the agent reach `audit_log`? (gate)

Not a code task; no test, no commit. Confirms the grounding assumption behind
`FABRY_MODE = 'autonomous'` (set in Task 9). Both modes are fully built and
tested regardless — this only decides which one ships, and flipping it is a
one-line change in Task 9. Run this **before signing off Task 12**; it does not
block Tasks 2–11.

**Requires a live session on an INTERNAL, non-customer Rossum org** (owner-run,
or agent-browser dogfood on an internal org only — never a customer org).

- [ ] **Step 1: Create a chat + ask an audit question**

Using the extension's own transport values (a Rossum session token + the org
`…/api/v1` base), against an internal org:
1. `POST https://rossum-agent-api.tools.rossum.cloud/api/v1/chats` with headers
   `X-Rossum-Token: <token>`, `X-Rossum-Api-Url: <domain>/api/v1`, body `{}` → note `chat_id`.
2. `POST /chats/<chat_id>/messages` body `{"content":"Using your read-only tools, list the 5 most recent audit log entries for this organization and say which tool you used."}` and read the SSE stream.

- [ ] **Step 2: Observe the tool events + record the outcome**

In the stream, look for `tool-input-start {toolName}` / `tool-output-available`
events that return real audit-log rows.
- **Pass** → the agent fetched audit logs autonomously. Keep `FABRY_MODE = 'autonomous'`. Record the tool name/params used.
- **Fail / refused / no audit tool** → set `FABRY_MODE = 'seeded'` in Task 9 (one-line change; the seeded path + tests already exist). The feature ships scoped to the loaded view.

Record the result inline in the design spec's §5 (one line: mode + date + evidence). No customer data in the note.

---

### Task 2: Shared pure narrative parser — `src/ui/fabry/narrative.js`

**Files:**
- Create: `src/ui/fabry/narrative.js`
- Test: `tests/ui-fabry-narrative.test.js`

**Interfaces:**
- Produces: `parseCitations(text) → [{type:'text',text} | {type:'cite',id}]`; `parseNarrative(text) → [{type:'p'|'li', segments:[…]}]`. Both pure, streaming-safe.

- [ ] **Step 1: Write the failing test**

```js
// tests/ui-fabry-narrative.test.js
import { describe, it, expect } from 'vitest';
import { parseNarrative, parseCitations } from '../src/ui/fabry/narrative.js';

describe('parseCitations', () => {
  it('splits text and cite segments', () => {
    const seg = parseCitations('A [e:audit:1] and [e:user:2].');
    expect(seg.filter((s) => s.type === 'cite').map((s) => s.id)).toEqual(['audit:1', 'user:2']);
    expect(seg[0]).toEqual({ type: 'text', text: 'A ' });
  });
  it('no markers → single text segment; empty → []', () => {
    expect(parseCitations('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(parseCitations('')).toEqual([]);
  });
});

describe('parseNarrative', () => {
  it('splits lines into paragraph and bullet blocks', () => {
    const b = parseNarrative('Takeaway.\n- one\n- two\nNext step: go.');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li', 'p']);
    expect(b[3].segments[0].text).toContain('Next step');
  });
  it('tolerates blank lines, • bullets, a partial last line; empty/null → []', () => {
    const b = parseNarrative('Head\n\n• first\n- seco');
    expect(b.map((x) => x.type)).toEqual(['p', 'li', 'li']);
    expect(b[2].segments[0].text).toBe('seco');
    expect(parseNarrative('')).toEqual([]);
    expect(parseNarrative(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-fabry-narrative.test.js`
Expected: FAIL — cannot resolve `../src/ui/fabry/narrative.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/ui/fabry/narrative.js
// Pure, DOM-free narrative parsing for Fabry answers — line-aware paragraph/
// bullet blocks with inline [e:<id>] citation segments. Streaming-safe (a
// partial last line still renders). Canonical home for the shared Fabry UI;
// copied from the Inspector's synthesize.js (which keeps its own copy until it
// migrates onto src/ui/).
const CITE_RE = /\[e:([A-Za-z0-9_.:-]+)\]/g;

export function parseCitations(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out = [];
  let last = 0;
  for (const m of s.matchAll(CITE_RE)) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'cite', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

export function parseNarrative(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const blocks = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^[-•]\s+(.*)$/.exec(t);
    blocks.push(m ? { type: 'li', segments: parseCitations(m[1]) } : { type: 'p', segments: parseCitations(t) });
  }
  return blocks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui-fabry-narrative.test.js` → Expected: PASS.

- [ ] **Step 5: Full suite green**

Run: `npm test` → Expected: all pass (no commit — see Global Constraints).

---

### Task 3: Shared gerund loader — `src/ui/GerundLoader.jsx`

**Files:**
- Create: `src/ui/GerundLoader.jsx`
- Test: `tests/ui-gerund-loader.test.js`

**Interfaces:**
- Produces: `default GerundLoader({ gerunds: string[], intervalMs?=2400 })` — renders `.nl-search-loading` with a `.nl-gerund` showing a rotating gerund.

- [ ] **Step 1: Write the failing test**

```js
// tests/ui-gerund-loader.test.js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import GerundLoader from '../src/ui/GerundLoader.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(GerundLoader, props), root); return root; }

describe('GerundLoader', () => {
  it('renders the loader wrapper with the first gerund', () => {
    const el = mount({ gerunds: ['Thinking', 'Reading'] });
    expect(el.querySelector('.nl-search-loading')).toBeTruthy();
    expect(el.querySelector('.nl-gerund').textContent).toContain('Thinking');
  });
  it('falls back to a default gerund when the list is empty', () => {
    const el = mount({ gerunds: [] });
    expect(el.querySelector('.nl-gerund').textContent).toContain('Working');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-gerund-loader.test.js` → Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```jsx
// src/ui/GerundLoader.jsx
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Animated rainbow gerund loader — crossfades between rotating gerunds while a
// Fabry run is in flight. Owns its own tick; emits the shared console.css
// classes (.nl-search-loading / .nl-gerund / -in / -out).
export default function GerundLoader({ gerunds, intervalMs = 2400 }) {
  const [gi, setGi] = useState(0);
  useEffect(() => {
    setGi(0);
    const id = setInterval(() => setGi((i) => i + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  const list = gerunds && gerunds.length ? gerunds : ['Working'];
  return (
    <div class="nl-search-loading">
      {gi > 0 && <span key={'o' + gi} class="nl-gerund nl-gerund-out">{list[(gi - 1) % list.length] + '…'}</span>}
      <span key={'i' + gi} class="nl-gerund nl-gerund-in">{list[gi % list.length] + '…'}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui-gerund-loader.test.js` → Expected: PASS.

- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 4: Shared ask input — `src/ui/fabry/FabryInput.jsx`

**Files:**
- Create: `src/ui/fabry/FabryInput.jsx`
- Test: `tests/ui-fabry-input.test.js`

**Interfaces:**
- Consumes: `GerundLoader` (Task 3).
- Produces: `default FabryInput({ value, onInput(v), onSubmit(v), busy, placeholder, gerunds })` — controlled input; Enter → `onSubmit`, Escape → `onInput('')`; busy hides value + disables + shows loader.

- [ ] **Step 1: Write the failing test**

```js
// tests/ui-fabry-input.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryInput from '../src/ui/fabry/FabryInput.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryInput, props), root); return root; }
const fireInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const fireKey = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('FabryInput', () => {
  it('reflects value, calls onInput, and submits on Enter', () => {
    const onInput = vi.fn(); const onSubmit = vi.fn();
    const el = mount({ value: 'hi', onInput, onSubmit, busy: false, placeholder: 'Ask…', gerunds: ['G'] });
    const input = el.querySelector('input.nl-search-input');
    expect(input.value).toBe('hi');
    expect(el.querySelector('.agent-spark')).toBeTruthy();
    fireInput(input, 'who deleted users');
    expect(onInput).toHaveBeenCalledWith('who deleted users');
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith('who deleted users');
  });
  it('Escape clears via onInput', () => {
    const onInput = vi.fn();
    const el = mount({ value: 'x', onInput, onSubmit: vi.fn(), busy: false, placeholder: '', gerunds: ['G'] });
    fireKey(el.querySelector('input'), 'Escape');
    expect(onInput).toHaveBeenCalledWith('');
  });
  it('busy hides the value, disables the input, and shows the loader', () => {
    const el = mount({ value: 'x', onInput: vi.fn(), onSubmit: vi.fn(), busy: true, placeholder: '', gerunds: ['G'] });
    const input = el.querySelector('input');
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(el.querySelector('.nl-search-loading')).toBeTruthy();
    expect(el.querySelector('.agent-spark.loading')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-fabry-input.test.js` → Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```jsx
// src/ui/fabry/FabryInput.jsx
import { h } from 'preact';
import GerundLoader from '../GerundLoader.jsx';

// Controlled Fabry ask input (MDH visual design): ✦ spark + rounded input +
// gerund loader while busy. Store-agnostic — the parent owns value/submit.
export default function FabryInput({ value, onInput, onSubmit, busy, placeholder, gerunds }) {
  return (
    <div class="agent-input-row">
      <div class="nl-search-wrapper">
        <span class={'agent-spark' + (busy ? ' loading' : '')}>{'✦'}</span>
        <input
          class={'nl-search-input' + (busy ? ' loading' : '')}
          type="text"
          placeholder={placeholder}
          value={busy ? '' : value}
          disabled={busy}
          onInput={(e) => onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(e.target.value); if (e.key === 'Escape') onInput(''); }}
        />
        {busy && <GerundLoader gerunds={gerunds} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/ui-fabry-input.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 5: Shared narrative renderer — `src/ui/fabry/FabryNarrative.jsx`

**Files:**
- Create: `src/ui/fabry/FabryNarrative.jsx`
- Test: `tests/ui-fabry-narrative-view.test.js`

**Interfaces:**
- Consumes: `parseNarrative` (Task 2).
- Produces: `default FabryNarrative({ text, streaming, resolveCite? })` — renders `.inspector-diag-body` with `<p>` paragraphs + `.inspector-diag-list li` bullets + `.inspector-caret` iff streaming. Cite segments: no `resolveCite` → plain text (Audit's citation-free case); with resolver → `.inspector-cite` button (or `.inspector-cite.unresolved` if it returns null).

- [ ] **Step 1: Write the failing test**

```js
// tests/ui-fabry-narrative-view.test.js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryNarrative from '../src/ui/fabry/FabryNarrative.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryNarrative, props), root); return root; }

describe('FabryNarrative', () => {
  it('renders takeaway + bullets + next step, with a streaming caret only when streaming', () => {
    const el = mount({ text: 'Takeaway.\n- one\n- two\nNext step: go.', streaming: true });
    expect(el.querySelectorAll('.inspector-diag-list li').length).toBe(2);
    expect(el.querySelectorAll('.inspector-diag-body > p').length).toBe(2);
    expect(el.querySelector('.inspector-caret')).toBeTruthy();
    const el2 = mount({ text: 'Done.', streaming: false });
    expect(el2.querySelector('.inspector-caret')).toBeFalsy();
  });
  it('citation-free (no resolveCite): [e:…] renders as plain text, no chip', () => {
    const el = mount({ text: 'Blocked [e:audit:1].', streaming: false });
    expect(el.querySelector('.inspector-cite')).toBeFalsy();
    expect(el.textContent).toContain('audit:1');
  });
  it('with a resolver: resolvable → chip, null → struck chip', () => {
    const resolveCite = (id) => (id === 'ok:1' ? { title: 't', onClick: () => {} } : null);
    const el = mount({ text: 'a [e:ok:1] b [e:no:9]', streaming: false, resolveCite });
    const chips = el.querySelectorAll('.inspector-cite');
    expect(chips.length).toBe(2);
    expect(chips[0].classList.contains('unresolved')).toBe(false);
    expect(chips[1].classList.contains('unresolved')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-fabry-narrative-view.test.js` → Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```jsx
// src/ui/fabry/FabryNarrative.jsx
import { h } from 'preact';
import { parseNarrative } from './narrative.js';

// Renders one Fabry narrative body: takeaway paragraph, "- " bullet list, and a
// trailing "Next step:" line, streaming-safe. resolveCite is optional — when
// omitted, [e:<id>] segments render as plain text (Audit has no evidence model
// to cite into). resolveCite(id) → { title?, onClick? } | null.
function Segment({ seg, resolveCite }) {
  if (seg.type !== 'cite') return <span>{seg.text}</span>;
  if (!resolveCite) return <span>{seg.id}</span>;
  const hit = resolveCite(seg.id);
  if (!hit) return <span class="inspector-cite unresolved">{seg.id}</span>;
  return <button type="button" class="inspector-cite" title={hit.title || seg.id} onClick={hit.onClick}>{seg.id}</button>;
}

export default function FabryNarrative({ text, streaming, resolveCite }) {
  const blocks = parseNarrative(text);
  const out = [];
  let bullets = [];
  const seg = (segments) => segments.map((s) => <Segment seg={s} resolveCite={resolveCite} />);
  const flush = () => { if (bullets.length) { out.push(<ul class="inspector-diag-list">{bullets}</ul>); bullets = []; } };
  for (const b of blocks) {
    if (b.type === 'li') bullets.push(<li>{seg(b.segments)}</li>);
    else { flush(); out.push(<p>{seg(b.segments)}</p>); }
  }
  flush();
  return (
    <div class="inspector-diag-body">
      {out}
      {streaming ? <span class="inspector-caret" /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/ui-fabry-narrative-view.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 6: Shared transcript modal — `src/ui/fabry/FabryTranscript.jsx`

**Files:**
- Create: `src/ui/fabry/FabryTranscript.jsx`
- Test: `tests/ui-fabry-transcript.test.js`

**Interfaces:**
- Produces: `default FabryTranscript({ reasoning, tools, onClose })` — a read-only modal: reasoning `<pre class="inspector-code-block">` + optional `.inspector-note` tools line; backdrop click → `onClose`, inner click does not.

- [ ] **Step 1: Write the failing test**

```js
// tests/ui-fabry-transcript.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h, render } from 'preact';
import FabryTranscript from '../src/ui/fabry/FabryTranscript.jsx';

let root;
afterEach(() => { if (root) { render(null, root); root.remove(); } });
function mount(props) { root = document.createElement('div'); document.body.appendChild(root); render(h(FabryTranscript, props), root); return root; }

describe('FabryTranscript', () => {
  it('shows reasoning and the tools line; closes on backdrop but not inner click', () => {
    const onClose = vi.fn();
    const el = mount({ reasoning: 'because logs', tools: ['search', 'get'], onClose });
    expect(el.querySelector('.inspector-code-block').textContent).toContain('because logs');
    expect(el.querySelector('.inspector-note').textContent).toContain('search, get');
    el.querySelector('.inspector-modal').click();
    expect(onClose).not.toHaveBeenCalled();
    el.querySelector('.inspector-modal-backdrop').click();
    expect(onClose).toHaveBeenCalled();
  });
  it('renders a placeholder when there is no reasoning and no tools line when empty', () => {
    const el = mount({ reasoning: '', tools: [], onClose: () => {} });
    expect(el.querySelector('.inspector-code-block').textContent).toContain('no reasoning');
    expect(el.querySelector('.inspector-note')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-fabry-transcript.test.js` → Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```jsx
// src/ui/fabry/FabryTranscript.jsx
import { h } from 'preact';

// Read-only "investigation" modal for a finished Fabry answer: the streamed
// reasoning + the tool names it used. Reuses the Inspector modal chrome.
export default function FabryTranscript({ reasoning, tools, onClose }) {
  return (
    <div class="inspector-modal-backdrop" onClick={onClose}>
      <div class="inspector-modal" onClick={(e) => e.stopPropagation()}>
        <div class="inspector-modal-hd">Investigation transcript <button type="button" class="inspector-modal-x" onClick={onClose}>{'×'}</button></div>
        {tools && tools.length ? <div class="inspector-note">Tools used: {tools.join(', ')}</div> : null}
        <pre class="inspector-code-block">{reasoning || '(no reasoning recorded)'}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/ui-fabry-transcript.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 7: Audit Fabry prompt + runners — `src/audit/fabry.js`

**Files:**
- Create: `src/audit/fabry.js`
- Test: `tests/audit-fabry.test.js`

**Interfaces:**
- Consumes: `newAcc`/`foldEvents`/`replyText` from `src/mdh/agent/agentStream.js`; an injected `agentApi` with `createChat()` + `streamMessage(chatId, content, {onEvent, signal})`.
- Produces:
  - `DEFAULT_QUESTION: string`
  - `seedRows(rows) → string` (≤40 rows, `_idx` stripped, char-capped)
  - `buildAuditPrompt({ question, filters, rows, mode }) → string`
  - `buildFollowupPrompt(question) → string`
  - `runAuditQuery({ agentApi, question, filters, rows, mode='autonomous', onPhase?, onText?, signal }) → { text, reasoning, tools, chatId }`
  - `continueAuditQuery({ agentApi, chatId, question, onPhase?, onText?, signal }) → { text, reasoning, tools }`

- [ ] **Step 1: Write the failing test**

```js
// tests/audit-fabry.test.js
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_QUESTION, seedRows, buildAuditPrompt, buildFollowupPrompt, runAuditQuery, continueAuditQuery } from '../src/audit/fabry.js';

const FILTERS = { object_type: 'annotation', action: 'update-status', username: 'a@b.c', object_id: '', timestamp_after: '', timestamp_before: '' };

describe('buildAuditPrompt', () => {
  it('autonomous mode: read-only framing, filter context, tool instruction, format, no citations', () => {
    const p = buildAuditPrompt({ question: DEFAULT_QUESTION, filters: FILTERS, rows: [], mode: 'autonomous' });
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('object type=annotation');
    expect(p).toContain('username=a@b.c');
    expect(p).toMatch(/read-only tools/i);
    expect(p).toMatch(/takeaway/i);
    expect(p).toContain('"- "');
    expect(p).toContain('Next step:');
    expect(p).toContain('Do NOT include');
    expect(p).toContain('[e:');
    expect(p).toContain(DEFAULT_QUESTION);
  });
  it('seeded mode: embeds the loaded rows and forbids claims beyond them', () => {
    const p = buildAuditPrompt({ question: 'q', filters: FILTERS, rows: [{ _idx: 0, action: 'create', username: 'x@y.z' }], mode: 'seeded' });
    expect(p).toContain('"action":"create"');
    expect(p).not.toContain('_idx');
    expect(p).toMatch(/ONLY on these|do not claim/i);
    expect(p).not.toMatch(/read-only tools to fetch/i);
  });
});

describe('seedRows', () => {
  it('strips _idx and caps at 40 rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ _idx: i, n: i }));
    const out = seedRows(rows);
    expect(out).not.toContain('_idx');
    expect(JSON.parse(out.replace(/…\(truncated\)$/, '')).length).toBe(40);
  });
});

describe('buildFollowupPrompt', () => {
  it('keeps read-only framing + question, no citations, no persona', () => {
    const p = buildFollowupPrompt('why so many deletes?');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('why so many deletes?');
    expect(p).toMatch(/no \[e:/i);
    expect(p).not.toContain('/persona');
  });
});

describe('runAuditQuery / continueAuditQuery', () => {
  it('runAuditQuery primes persona, streams text, returns chatId', async () => {
    const prompts = [];
    const agentApi = {
      createChat: vi.fn(async () => 'chatA'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        prompts.push(content);
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-delta', delta: 'hmm' });
        onEvent({ type: 'tool-input-start', toolName: 'search' });
        onEvent({ type: 'text-delta', delta: 'Latest: 3 status changes.' });
        onEvent({ type: 'finish' });
      }),
    };
    const texts = [];
    const res = await runAuditQuery({ agentApi, question: 'q', filters: FILTERS, rows: [], mode: 'autonomous', onText: (t) => texts.push(t) });
    expect(prompts[0]).toBe('/persona cautious');
    expect(res.chatId).toBe('chatA');
    expect(res.text).toContain('Latest: 3 status changes.');
    expect(res.reasoning).toContain('hmm');
    expect(res.tools).toContain('search');
    expect(texts[texts.length - 1]).toContain('Latest');
  });
  it('continueAuditQuery reuses the chat without re-priming', async () => {
    const calls = [];
    const agentApi = {
      createChat: vi.fn(),
      streamMessage: vi.fn(async (id, content, { onEvent }) => {
        calls.push([id, content]);
        onEvent({ type: 'text-delta', delta: 'answer' });
        onEvent({ type: 'finish' });
      }),
    };
    const res = await continueAuditQuery({ agentApi, chatId: 'chatB', question: 'more?' });
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(calls[0][0]).toBe('chatB');
    expect(calls[0][1]).toContain('more?');
    expect(calls[0][1]).not.toContain('/persona');
    expect(res.text).toContain('answer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit-fabry.test.js` → Expected: FAIL — cannot resolve `../src/audit/fabry.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/audit/fabry.js
// Mr. Fabry over the Audit Logs app — one agent chat per session that answers
// questions about audit activity as a citation-free narrative. Pure prompt
// builders + injected-transport runners (agentApi injected), so the network
// stays out of unit tests. Mirrors src/inspector/synthesize.js.
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';

export const DEFAULT_QUESTION =
  "Summarize the latest activity in this organization's audit log: the most recent events, who did what, and anything notable.";

const FILTER_LABELS = [
  ['object_type', 'object type'], ['action', 'action'], ['object_id', 'object id'],
  ['username', 'username'], ['timestamp_after', 'after'], ['timestamp_before', 'before'],
];

function filterContext(filters) {
  const parts = [];
  for (const [key, label] of FILTER_LABELS) {
    const v = filters && filters[key];
    if (v != null && v !== '') parts.push(`${label}=${v}`);
  }
  return parts.length ? parts.join(', ') : '(no filters set)';
}

// Cap a seeded-mode row sample so a full page can't overflow the agent's
// content budget. Simple local cap (no promptBudget dependency).
const SEED_MAX_ROWS = 40;
const SEED_MAX_CHARS = 12000;
export function seedRows(rows) {
  const sample = (Array.isArray(rows) ? rows : []).slice(0, SEED_MAX_ROWS)
    .map((r) => { const { _idx, ...rest } = r || {}; return rest; });
  let json = JSON.stringify(sample);
  if (json.length > SEED_MAX_CHARS) json = json.slice(0, SEED_MAX_CHARS) + '…(truncated)';
  return json;
}

export function buildAuditPrompt({ question, filters, rows, mode }) {
  const head = [
    'You are Mr. Fabry answering a question in a READ-ONLY Rossum audit-log viewer. Never modify anything — only read and reason.',
    `The user is currently viewing audit logs filtered by: ${filterContext(filters)}.`,
  ];
  const body = mode === 'seeded'
    ? [
        'Here are the most recent audit-log entries currently loaded (JSON). Base your answer ONLY on these; do not claim anything beyond them, and say so if they are insufficient:',
        seedRows(rows),
      ]
    : [
        'Use your read-only tools to fetch the recent audit-log entries you need to answer. If you cannot retrieve audit logs, say so plainly rather than guessing.',
      ];
  const tail = [
    `Question: ${question}`,
    'Format your answer EXACTLY like this (plain text, no markdown headings, no JSON):',
    'Line 1: one short takeaway sentence.',
    'Then 3–6 bullet lines, each starting with "- ": one fact per bullet, most recent first.',
    'Last line: "Next step: …" naming the single most useful follow-up.',
    'Do NOT include any [e:…] citations — this viewer has no citation targets. Never invent activity that is not in the audit log.',
  ];
  return [...head, ...body, ...tail].join('\n\n');
}

export function buildFollowupPrompt(question) {
  return [
    'You are still answering questions in the same READ-ONLY Rossum audit-log viewer. Never modify anything — only read and reason (your read-only tools are available).',
    'Answer concisely (short "- " bullets welcome), plain text, no markdown headings, no [e:…] citations. If something is not in the audit log, say so plainly — never invent.',
    `Question: ${question}`,
  ].join('\n\n');
}

async function streamTurn(agentApi, chatId, content, { onPhase = () => {}, onText = () => {}, signal }) {
  const acc = newAcc();
  let lastStatus = '';
  let lastText = '';
  await agentApi.streamMessage(chatId, content, {
    signal,
    onEvent: (ev) => {
      foldEvents(acc, [ev]);
      if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); }
      const t = replyText(acc);
      if (t !== lastText) { lastText = t; onText(t); }
    },
  });
  return { text: replyText(acc), reasoning: acc.reasoning, tools: acc.tools.slice() };
}

export async function runAuditQuery({ agentApi, question, filters, rows, mode = 'autonomous', onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const res = await streamTurn(agentApi, chatId, buildAuditPrompt({ question, filters, rows, mode }), { onPhase, onText, signal });
  return { ...res, chatId };
}

export async function continueAuditQuery({ agentApi, chatId, question, onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  return streamTurn(agentApi, chatId, buildFollowupPrompt(question), { onPhase, onText, signal });
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/audit-fabry.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 8: Audit store — `aiAvailable` + `fabry` + `resetFabry`

**Files:**
- Modify: `src/audit/store.js` (append after `patchFilters`)
- Test: `tests/audit-store.test.js`

**Interfaces:**
- Produces: `aiAvailable = signal(false)`; `fabry = signal({ status:'idle'|'running'|'done'|'error', chatId:null, turns:[], error:null })` where `turns[i] = { id, question:null|string, text, reasoning, tools, state:'streaming'|'done'|'error' }`; `resetFabry()` restores the idle default.

- [ ] **Step 1: Write the failing test**

```js
// tests/audit-store.test.js
import { describe, it, expect } from 'vitest';
import * as store from '../src/audit/store.js';

describe('audit store — Fabry state', () => {
  it('defaults: aiAvailable false, fabry idle and empty', () => {
    store.resetFabry();
    expect(store.aiAvailable.value).toBe(false);
    expect(store.fabry.value).toEqual({ status: 'idle', chatId: null, turns: [], error: null });
  });
  it('resetFabry restores the idle default after mutation', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: 'x', turns: [{ id: 1, question: null, text: 'hi', reasoning: '', tools: [], state: 'done' }] };
    store.resetFabry();
    expect(store.fabry.value.turns).toEqual([]);
    expect(store.fabry.value.status).toBe('idle');
    expect(store.fabry.value.chatId).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit-store.test.js` → Expected: FAIL — `store.resetFabry is not a function` / `fabry` undefined.

- [ ] **Step 3: Write the implementation** — append to `src/audit/store.js`:

```js
// Rossum Agent API ("Mr. Fabry") reachable — set from probeAgent() at init.
export const aiAvailable = signal(false);

// Fabry conversation state (ephemeral; no persistence). One chat per session:
// turns[0] is the auto default-summary (question:null); later turns are Q&A.
// status: 'idle' | 'running' | 'done' | 'error'.
export const fabry = signal({ status: 'idle', chatId: null, turns: [], error: null });
export function resetFabry() {
  fabry.value = { status: 'idle', chatId: null, turns: [], error: null };
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/audit-store.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 9: Audit orchestration — `src/audit/index.jsx` wiring

**Files:**
- Modify: `src/audit/index.jsx` (add imports, module state, three exported functions, and the probe line in `initAudit`)
- Test: `tests/audit-fabry-wiring.test.js`

**Interfaces:**
- Consumes: `runAuditQuery`/`continueAuditQuery`/`DEFAULT_QUESTION` (Task 7), `store.aiAvailable`/`store.fabry`/`store.resetFabry` (Task 8), `agentApi` (`src/mdh/agent/agentApi.js`).
- Produces: `runDefaultSummary() → Promise`, `askAuditFabry(question) → Promise`, `restartFabry() → Promise`. `FABRY_MODE` module constant (`'autonomous'` — flip to `'seeded'` per Task 1).

- [ ] **Step 1: Write the failing test**

```js
// tests/audit-fabry-wiring.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/agent/agentApi.js', () => ({ init: vi.fn(), probeAgent: vi.fn() }));
vi.mock('../src/audit/fabry.js', () => ({
  DEFAULT_QUESTION: 'DEFAULT_Q',
  runAuditQuery: vi.fn(),
  continueAuditQuery: vi.fn(),
}));

import { runDefaultSummary, askAuditFabry, restartFabry } from '../src/audit/index.jsx';
import { runAuditQuery, continueAuditQuery } from '../src/audit/fabry.js';
import * as store from '../src/audit/store.js';

beforeEach(() => {
  vi.clearAllMocks();
  store.resetFabry();
  store.aiAvailable.value = false;
});

describe('runDefaultSummary', () => {
  it('no-op when the agent is unavailable', async () => {
    await runDefaultSummary();
    expect(runAuditQuery).not.toHaveBeenCalled();
    expect(store.fabry.value.status).toBe('idle');
  });
  it('runs once, streams the default summary, records chatId', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockResolvedValue({ text: 'Latest.', reasoning: 'r', tools: ['search'], chatId: 'c1' });
    await runDefaultSummary();
    expect(runAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ question: 'DEFAULT_Q', mode: 'autonomous' }));
    expect(store.fabry.value.status).toBe('done');
    expect(store.fabry.value.chatId).toBe('c1');
    expect(store.fabry.value.turns[0]).toMatchObject({ question: null, text: 'Latest.', state: 'done' });
    await runDefaultSummary(); // not idle anymore → no second run
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
  });
  it('records a turn error when the run rejects', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockRejectedValue(new Error('boom'));
    await runDefaultSummary();
    expect(store.fabry.value.status).toBe('error');
    expect(store.fabry.value.turns[0].state).toBe('error');
  });
});

describe('askAuditFabry', () => {
  it('continues the existing chat and appends a Q&A turn', async () => {
    store.aiAvailable.value = true;
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'Latest.', reasoning: '', tools: [], state: 'done' }] };
    continueAuditQuery.mockResolvedValue({ text: 'Because X.', reasoning: '', tools: [] });
    await askAuditFabry('why?');
    expect(continueAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', question: 'why?' }));
    expect(runAuditQuery).not.toHaveBeenCalled();
    const turns = store.fabry.value.turns;
    expect(turns.length).toBe(2);
    expect(turns[1]).toMatchObject({ question: 'why?', text: 'Because X.', state: 'done' });
  });
  it('starts a fresh chat when none exists yet', async () => {
    store.aiAvailable.value = true;
    runAuditQuery.mockResolvedValue({ text: 'A.', reasoning: '', tools: [], chatId: 'c2' });
    await askAuditFabry('first question');
    expect(runAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ question: 'first question' }));
    expect(store.fabry.value.chatId).toBe('c2');
    expect(store.fabry.value.turns[0]).toMatchObject({ question: 'first question', state: 'done' });
  });
  it('ignores a submit while a turn is streaming (one at a time)', async () => {
    store.fabry.value = { status: 'running', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
    await askAuditFabry('while busy');
    expect(continueAuditQuery).not.toHaveBeenCalled();
    expect(runAuditQuery).not.toHaveBeenCalled();
  });
});

describe('restartFabry', () => {
  it('clears the thread and re-runs the default summary', async () => {
    store.aiAvailable.value = true;
    store.fabry.value = { status: 'done', chatId: 'old', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }] };
    runAuditQuery.mockResolvedValue({ text: 'Fresh.', reasoning: '', tools: [], chatId: 'c9' });
    await restartFabry();
    expect(runAuditQuery).toHaveBeenCalledTimes(1);
    expect(store.fabry.value.chatId).toBe('c9');
    expect(store.fabry.value.turns.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit-fabry-wiring.test.js` → Expected: FAIL — exports not defined.

- [ ] **Step 3: Write the implementation**

Add imports at the top of `src/audit/index.jsx` (after the existing imports):

```js
import * as agentApi from '../mdh/agent/agentApi.js';
import { runAuditQuery, continueAuditQuery, DEFAULT_QUESTION } from './fabry.js';
```

Add module-level state + functions (after `restore`, before `initAudit`):

```js
// Ship mode for Fabry's grounding. 'autonomous' = the agent fetches audit logs
// via its own read-only tools (confirmed by the plan's Task 1 spike); flip to
// 'seeded' if that spike shows the agent cannot reach audit logs.
const FABRY_MODE = 'autonomous';

let fabryController = null;
function currentFilters() { return store.filtersBySource.value[store.activeSource.value] || {}; }
function currentRows() { return store.rows.value || []; }

// Immutably patch the turn with the given id in store.fabry.
function patchTurn(id, fn) {
  const cur = store.fabry.value;
  const turns = cur.turns.map((t) => (t.id === id ? { ...t } : t));
  const target = turns.find((t) => t.id === id);
  if (target) fn(target);
  store.fabry.value = { ...cur, turns };
}

// Auto-run the minimalistic default "latest activity" summary once per app
// activation (turn 0). Gated on availability + idle state.
export async function runDefaultSummary() {
  if (!store.aiAvailable.value) return;
  if (store.fabry.value.status !== 'idle') return;
  if (fabryController) fabryController.abort();
  fabryController = new AbortController();
  const signal = fabryController.signal;
  store.fabry.value = { status: 'running', chatId: null, error: null,
    turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
  try {
    const res = await runAuditQuery({
      agentApi, question: DEFAULT_QUESTION, filters: currentFilters(), rows: currentRows(), mode: FABRY_MODE, signal,
      onText: (t) => { if (!signal.aborted) patchTurn(1, (turn) => { turn.text = t; }); },
    });
    if (signal.aborted) return;
    store.fabry.value = { status: 'done', chatId: res.chatId, error: null,
      turns: [{ id: 1, question: null, text: res.text, reasoning: res.reasoning, tools: res.tools, state: 'done' }] };
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    patchTurn(1, (turn) => { turn.state = 'error'; });
    store.fabry.value = { ...store.fabry.value, status: 'error', error: e?.message || 'failed' };
  }
}

// Ask a question. Continues the session chat if one exists; otherwise (default
// summary failed / was cleared) starts a fresh chat. Appends one Q&A turn.
export async function askAuditFabry(question) {
  const q = String(question || '').trim();
  if (!q) return;
  const cur = store.fabry.value;
  if (cur.turns.some((t) => t.state === 'streaming')) return; // one at a time
  if (fabryController) fabryController.abort();
  fabryController = new AbortController();
  const signal = fabryController.signal;
  const id = (cur.turns[cur.turns.length - 1]?.id || 0) + 1;
  store.fabry.value = { ...cur, status: 'running',
    turns: [...cur.turns, { id, question: q, text: '', reasoning: '', tools: [], state: 'streaming' }] };
  const onText = (t) => { if (!signal.aborted) patchTurn(id, (turn) => { turn.text = t; }); };
  try {
    const hasChat = !!cur.chatId;
    const res = hasChat
      ? await continueAuditQuery({ agentApi, chatId: cur.chatId, question: q, signal, onText })
      : await runAuditQuery({ agentApi, question: q, filters: currentFilters(), rows: currentRows(), mode: FABRY_MODE, signal, onText });
    if (signal.aborted) return;
    patchTurn(id, (turn) => { turn.text = res.text; turn.reasoning = res.reasoning; turn.tools = res.tools; turn.state = 'done'; });
    const next = { ...store.fabry.value, status: 'done' };
    if (!hasChat && res.chatId) next.chatId = res.chatId;
    store.fabry.value = next;
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    patchTurn(id, (turn) => { turn.state = 'error'; });
    store.fabry.value = { ...store.fabry.value, status: 'error', error: e?.message || 'failed' };
  }
}

// The ↻ control: drop the thread and re-run the default summary.
export function restartFabry() {
  if (fabryController) fabryController.abort();
  store.resetFabry();
  return runDefaultSummary();
}
```

In `initAudit`, add the non-blocking probe + auto-run right after `store.connected.value = connected;` and the `if (!connected) return;` guard (so it only runs when connected):

```js
  agentApi.probeAgent().then((ok) => {
    store.aiAvailable.value = ok;
    if (ok) runDefaultSummary();
  }).catch(() => {});
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/audit-fabry-wiring.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 10: Audit Fabry panel — `src/audit/components/FabryPanel.jsx`

**Files:**
- Create: `src/audit/components/FabryPanel.jsx`
- Test: `tests/audit-fabry-panel.test.js`

**Interfaces:**
- Consumes: `store.fabry`/`store.resetFabry` (Task 8), `askAuditFabry`/`restartFabry` (Task 9), `FabryInput`/`FabryNarrative`/`FabryTranscript` (Tasks 4–6).
- Produces: `default FabryPanel()` — renders `.audit-fabry` with the input; when `turns.length > 0`, the `.inspector-diag` panel with a header (`↻`, `View investigation`, `×`) and one `Turn` per entry.

- [ ] **Step 1: Write the failing test**

```js
// tests/audit-fabry-panel.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const askAuditFabry = vi.fn();
const restartFabry = vi.fn();
vi.mock('../src/audit/index.jsx', () => ({ askAuditFabry: (...a) => askAuditFabry(...a), restartFabry: (...a) => restartFabry(...a) }));

import FabryPanel from '../src/audit/components/FabryPanel.jsx';
import * as store from '../src/audit/store.js';

const fireInput = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const fireEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

let root;
beforeEach(() => { vi.clearAllMocks(); store.resetFabry(); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });
function mount() { render(h(FabryPanel, null), root); return root; }

describe('FabryPanel', () => {
  it('idle (no turns): shows only the ask input, no panel', () => {
    const el = mount();
    expect(el.querySelector('.nl-search-input')).toBeTruthy();
    expect(el.querySelector('.inspector-diag')).toBeFalsy();
  });
  it('streaming default turn with no text yet → skeleton under a "Latest activity" label', () => {
    store.fabry.value = { status: 'running', chatId: null, error: null, turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'streaming' }] };
    const el = mount();
    expect(el.querySelector('.inspector-followup-role').textContent).toContain('Latest activity');
    expect(el.querySelector('.inspector-esec-skel')).toBeTruthy();
  });
  it('renders the default summary and a Q&A turn', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [
      { id: 1, question: null, text: 'Takeaway.\n- one\n- two\nNext step: go.', reasoning: 'r', tools: ['search'], state: 'done' },
      { id: 2, question: 'why?', text: 'Because.', reasoning: '', tools: [], state: 'done' },
    ] };
    const el = mount();
    expect(el.querySelectorAll('.inspector-diag-list li').length).toBe(2);
    const roles = [...el.querySelectorAll('.inspector-followup-role')].map((n) => n.textContent);
    expect(roles[0]).toContain('Latest activity');
    expect(roles[1]).toContain('You');
    expect(el.textContent).toContain('why?');
    expect(el.querySelector('.inspector-diag-credit').textContent).toContain('Mr. Fabry');
  });
  it('an error turn shows an honest note', () => {
    store.fabry.value = { status: 'error', chatId: null, error: 'x', turns: [{ id: 1, question: null, text: '', reasoning: '', tools: [], state: 'error' }] };
    expect(mount().textContent).toMatch(/could not answer/i);
  });
  it('Enter calls askAuditFabry; ↻ calls restartFabry; × clears the thread', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: '', tools: [], state: 'done' }] };
    const el = mount();
    const input = el.querySelector('.nl-search-input');
    fireInput(input, 'who deleted users');
    fireEnter(input);
    expect(askAuditFabry).toHaveBeenCalledWith('who deleted users');
    [...el.querySelectorAll('button')].find((b) => b.title === 'Start over').click();
    expect(restartFabry).toHaveBeenCalled();
    [...el.querySelectorAll('button')].find((b) => b.title === 'Clear').click();
    expect(store.fabry.value.turns.length).toBe(0);
  });
  it('View investigation opens the transcript with the last done turn reasoning', async () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: null, turns: [{ id: 1, question: null, text: 'x', reasoning: 'because search', tools: ['search'], state: 'done' }] };
    const el = mount();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('View investigation'));
    await act(() => { btn.click(); });
    expect(el.textContent).toContain('because search');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit-fabry-panel.test.js` → Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```jsx
// src/audit/components/FabryPanel.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { askAuditFabry, restartFabry } from '../index.jsx';
import FabryInput from '../../ui/fabry/FabryInput.jsx';
import FabryNarrative from '../../ui/fabry/FabryNarrative.jsx';
import FabryTranscript from '../../ui/fabry/FabryTranscript.jsx';

const GERUNDS = ['Summoning Mr. Fabry', 'Reading the audit log', 'Tracing activity', 'Cross-checking events', 'Almost there'];

function Turn({ turn }) {
  return (
    <div class="audit-fabry-turn">
      <div class="inspector-followup-q">
        <span class="inspector-followup-role">{turn.question == null ? 'Latest activity' : 'You'}</span>
        {turn.question == null ? null : ' ' + turn.question}
      </div>
      {turn.state === 'error'
        ? <div class="inspector-empty">Mr. Fabry could not answer that one.</div>
        : (turn.text
            ? <FabryNarrative text={turn.text} streaming={turn.state === 'streaming'} />
            : <div class="inspector-esec-skel" style="width:88%" />)}
    </div>
  );
}

export default function FabryPanel() {
  const [input, setInput] = useState('');
  const [showTx, setShowTx] = useState(false);
  const f = store.fabry.value;
  const busy = f.turns.some((t) => t.state === 'streaming');
  const lastDone = [...f.turns].reverse().find((t) => t.state === 'done');
  const send = (v) => { const q = String(v ?? input).trim(); if (!q || busy) return; setInput(''); askAuditFabry(q); };

  return (
    <div class="audit-fabry">
      <FabryInput
        value={input}
        onInput={setInput}
        onSubmit={send}
        busy={busy}
        placeholder="Ask Mr. Fabry about audit activity…"
        gerunds={GERUNDS}
      />
      {f.turns.length > 0 && (
        <div class="inspector-diag audit-fabry-panel">
          <div class="inspector-diag-hd">
            {'✨'} Audit insights <span class="inspector-diag-credit">by Mr. Fabry</span>
            <span class="inspector-diag-phase">
              <button type="button" class="inspector-fold-btn" title="Start over" onClick={() => restartFabry()}>{'↻'}</button>
              {lastDone ? <button type="button" class="inspector-fold-btn" onClick={() => setShowTx(true)}>View investigation</button> : null}
              <button type="button" class="inspector-fold-btn" title="Clear" onClick={() => store.resetFabry()}>{'×'}</button>
            </span>
          </div>
          {f.turns.map((t) => <Turn key={t.id} turn={t} />)}
        </div>
      )}
      {showTx && lastDone ? <FabryTranscript reasoning={lastDone.reasoning} tools={lastDone.tools || []} onClose={() => setShowTx(false)} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/audit-fabry-panel.test.js` → PASS.
- [ ] **Step 5: Full suite green** — `npm test` → all pass.

---

### Task 11: Mount the panel + CSS — `App.jsx` + `console.css`

**Files:**
- Modify: `src/audit/components/App.jsx` (import + gated mount inside `.audit-body`)
- Modify: `src/console/console.css` (append `.audit-fabry*` wrapper rules)
- Test: `tests/audit-shell.test.js` (add gating assertions)

**Interfaces:**
- Consumes: `aiAvailable` (Task 8), `FabryPanel` (Task 10).

- [ ] **Step 1: Add the failing gating tests** — append inside `describe('Audit shell', …)` in `tests/audit-shell.test.js`:

```js
  it('mounts the Fabry panel only when the agent is available', () => {
    store.aiAvailable.value = false;
    expect(mount(true).querySelector('.audit-fabry')).toBeNull();
    store.aiAvailable.value = true;
    expect(mount(true).querySelector('.audit-fabry')).not.toBeNull();
  });
```

Also add `store.aiAvailable.value = false;` to the `beforeEach` in that file so the existing tests keep asserting the unchanged layout.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit-shell.test.js` → Expected: FAIL — `.audit-fabry` never present (`aiAvailable`/`FabryPanel` not wired).

- [ ] **Step 3: Wire the mount** — in `src/audit/components/App.jsx`:

Add imports:
```js
import { availability, aiAvailable } from '../store.js';
import FabryPanel from './FabryPanel.jsx';
```
(Replace the existing `import { availability } from '../store.js';` line with the combined import above.)

Add the gated panel as the first child of the `.audit-body` div (above `<FiltersBar />`):
```jsx
          <div class="audit-body">
            {aiAvailable.value && <FabryPanel />}
            <FiltersBar />
```

- [ ] **Step 4: Add CSS** — append to `src/console/console.css`:

```css
/* Audit — Mr. Fabry ask bar + inline answer panel (reuses .nl-search-*, .agent-spark, .inspector-diag-*). */
.audit-fabry { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.audit-fabry-panel { margin-top: 2px; }
.audit-fabry-turn { margin-top: 10px; }
.audit-fabry-turn:first-of-type { margin-top: 6px; }
```

- [ ] **Step 5: Run tests to verify they pass** — `npx vitest run tests/audit-shell.test.js` → PASS.
- [ ] **Step 6: Full suite green** — `npm test` → all pass.

---

### Task 12: Build + dogfood verification (consumes Task 1)

**Files:** none (verification only).

- [ ] **Step 1: Confirm Task 1 outcome is applied**

Ensure `FABRY_MODE` in `src/audit/index.jsx` matches the Task 1 spike result
(`'autonomous'` if it passed; `'seeded'` if not). Do NOT sign off this task until
Task 1 has actually run — nothing ships on the unverified assumption.

- [ ] **Step 2: Build the loadable extension**

Run: `npm run build`
Expected: build completes; `dist/console/console.js` written. Sanity-check no
regression bundling three.js/CodeMirror (build prints no errors).

- [ ] **Step 3: Dogfood in the browser (internal org)**

Reload the unpacked extension (chrome://extensions → reload), open a Rossum page
on an **internal, non-customer** org, open **Audit Logs** from the popup. Verify:
1. The ✦ ask bar appears at the top of the audit body (above the filters) — and does NOT appear if the agent is offline.
2. On open, the "Latest activity" summary streams into the `.inspector-diag` panel (rainbow gerund loader while running).
3. Asking a follow-up appends a Q&A turn to the same thread; the input disables while streaming.
4. `View investigation` shows reasoning + tool names; `↻` re-runs the default; `×` clears the thread.
5. The existing filters / table / detail / pagination behave exactly as before.
6. With the agent reachable but audit-log source 403 (`UnavailablePanel`) or not-connected, no Fabry surface appears.

- [ ] **Step 4: Full suite green** — `npm test` → all pass. Report results to the owner (no commit unless asked).

---

## Notes for the implementer

- **Do not modify** `src/mdh/**` or `src/inspector/**`. The duplicated `parseNarrative` in `src/inspector/synthesize.js` stays until the Inspector's own migration spec.
- `agentApi` is already `init(domain, token)`'d at Console boot (`src/console/index.jsx`) — the Audit app must NOT re-init it.
- The Fabry panel imports `askAuditFabry`/`restartFabry` from `src/audit/index.jsx`; `index.jsx` does not import the panel — no import cycle (this mirrors the Inspector's `DiagnosisPanel` ← `index.jsx` relationship).
- If a Fabry turn 401s mid-stream, it surfaces as a turn `state:'error'` (honest note). Session-wide banner handling is unchanged; the programmatic audit table is never affected by a Fabry failure.
