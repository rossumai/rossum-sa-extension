# MDH AI Pipeline Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the colourful natural-language pipeline input in the MDH editor, powered by the verified `internal/llmchat` endpoint, self-hiding where the endpoint is feature-flagged off.

**Architecture:** Three small units — `llmPipeline.js` (pure prompt/parse/classify), `api.js` additions (`llmChat` + `probeLlmChat`, mirroring the existing `getOrgId()` internal-endpoint pattern), and an `aiAvailable` signal set by a non-blocking probe in `initMdh` — plus restoring the original NL input JSX into `PipelineEditor.jsx` and its animated CSS into `console.css`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE), vitest + jsdom, CodeMirror 6 (existing editor). No new dependencies.

## Global Constraints

- **No git commits during this run** (user standing preference, overrides the skill's commit steps). Every task ends with **build + test verification** instead of a commit. Work stays on `master`; no branches/worktrees.
- **No `Co-Authored-By: Claude` trailer** anywhere (moot — no commits).
- Verified `llmchat` contract (live, a customer dev org, 2026-06-23): `POST {baseDomain}/api/v1/internal/llmchat`; body `{messages:[{role:'user',content}]}`; **input must be user-role only** (a `system`/replayed turn → 400); empty body `{}` → 400 (the availability signal); reply = **last** message's `content` (role comes back `"system"`); no model/temperature/system-prompt control.
- Internal endpoints use `baseDomain`, **not** the Data-Storage `serviceBase`.
- Tests: `.test.js`, `h(Component)` + `vi.mock`, raw preact `render(h(...), root)` into a jsdom container (no testing-library). No test makes a live network call.
- Purely additive; behavior identical to today wherever `llmchat` is absent/erroring. No popup toggle. No chrome.storage key (per-org availability cached in `sessionStorage`).

---

### Task 1: `llmPipeline.js` — pure prompt/parse/classify helpers

**Files:**
- Create: `src/mdh/llmPipeline.js`
- Test: `tests/mdh-llm-pipeline.test.js`

**Interfaces:**
- Produces:
  - `MONGO_SYSTEM_INSTRUCTION: string`
  - `buildPipelineMessages({ fields?: string[], currentPipeline?: string, request?: string }) → [{ role:'user', content:string }]`
  - `extractReply(response: object) → string`
  - `stripFences(text: string) → string`
  - `classifyProbe(status: number) → boolean`

- [ ] **Step 1: Write the failing test**

```js
// tests/mdh-llm-pipeline.test.js
import { describe, it, expect } from 'vitest';
import {
  buildPipelineMessages, extractReply, stripFences, classifyProbe, MONGO_SYSTEM_INSTRUCTION,
} from '../src/mdh/llmPipeline.js';

describe('buildPipelineMessages', () => {
  it('folds instruction + fields + pipeline + request into one user message', () => {
    const msgs = buildPipelineMessages({ fields: ['a', 'b'], currentPipeline: '[]', request: 'top 5' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain(MONGO_SYSTEM_INSTRUCTION);
    expect(msgs[0].content).toContain('Available fields: a, b');
    expect(msgs[0].content).toContain('Current pipeline:\n[]');
    expect(msgs[0].content).toContain('Request: top 5');
  });
  it('omits the fields line when there are no fields', () => {
    expect(buildPipelineMessages({ fields: [], request: 'x' })[0].content).not.toContain('Available fields');
  });
  it('defaults an empty/missing pipeline to []', () => {
    expect(buildPipelineMessages({ request: 'x' })[0].content).toContain('Current pipeline:\n[]');
  });
});

describe('extractReply', () => {
  it('returns the last message content', () => {
    expect(extractReply({ messages: [{ role: 'user', content: 'q' }, { role: 'system', content: 'A' }] })).toBe('A');
  });
  it('tolerates null/empty/garbage', () => {
    expect(extractReply(null)).toBe('');
    expect(extractReply({})).toBe('');
    expect(extractReply({ messages: [] })).toBe('');
  });
});

describe('stripFences', () => {
  it('strips ```json fences', () => {
    expect(stripFences('```json\n[{"$limit":5}]\n```')).toBe('[{"$limit":5}]');
  });
  it('strips bare fences', () => { expect(stripFences('```\n[]\n```')).toBe('[]'); });
  it('trims unfenced text', () => { expect(stripFences('  [] ')).toBe('[]'); });
  it('tolerates non-strings', () => { expect(stripFences(null)).toBe(''); });
});

describe('classifyProbe', () => {
  it('400 ⇒ available', () => { expect(classifyProbe(400)).toBe(true); });
  it('403/500/0 ⇒ unavailable', () => {
    expect(classifyProbe(403)).toBe(false);
    expect(classifyProbe(500)).toBe(false);
    expect(classifyProbe(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: FAIL — cannot resolve `../src/mdh/llmPipeline.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/mdh/llmPipeline.js
// Pure (DOM-free, network-free) helpers for the AI pipeline input.
// The Rossum internal /llmchat endpoint accepts ONLY user-role messages and
// gives no system-prompt control (verified live on a customer dev org 2026-06-23), so
// all instructions are folded into a single user message.

// MongoDB-expert instruction prepended to every request. Single source of truth
// so the live prompt-evaluation phase (Task 7) can tune it in one place.
export const MONGO_SYSTEM_INSTRUCTION =
  'You are a MongoDB expert. You are given the available fields, the current ' +
  'aggregation pipeline, and a request. Modify the pipeline according to the ' +
  'request — add, remove, or change stages as needed. If the request describes a ' +
  'completely new query, replace the pipeline entirely. ' +
  'Output ONLY valid JSON — an array of aggregation pipeline stages. ' +
  'No explanation, no markdown, no code fences, no trailing text.';

export function buildPipelineMessages({ fields = [], currentPipeline = '', request = '' } = {}) {
  const parts = [MONGO_SYSTEM_INSTRUCTION];
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  parts.push(`Current pipeline:\n${currentPipeline && currentPipeline.trim() ? currentPipeline : '[]'}`);
  parts.push(`Request: ${request}`);
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function extractReply(response) {
  const msgs = response && response.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  return msgs[msgs.length - 1]?.content ?? '';
}

export function stripFences(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

// Availability probe classifier: POST {} returns 400 ("messages required") when
// llmchat is reachable/enabled; 403/other when feature-flagged off.
export function classifyProbe(status) {
  return status === 400;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: PASS (all 4 describe blocks).

- [ ] **Step 5: Verify (no commit)**

Run: `npm test` — full suite still green.

---

### Task 2: `api.js` — `llmChat` + `probeLlmChat`

**Files:**
- Modify: `src/mdh/api.js` (add two exports after `getOrgId()`, ~line 139; add one import at top)
- Test: `tests/mdh-api.test.js` (append two `describe` blocks)

**Interfaces:**
- Consumes: `classifyProbe` from `./llmPipeline.js`; module-scope `baseDomain`, `authHeader`, `combinedSignal`, `apiError`.
- Produces:
  - `llmChat(messages: object[], { signal? }) → Promise<{messages:object[]}>` — throws `apiError(msg, status)` on non-OK (so `.status` is observable, e.g. 403).
  - `probeLlmChat() → Promise<boolean>` — never throws.

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-api.test.js`)

```js
describe('llmChat', () => {
  beforeEach(() => { api.init('https://acme.rossum.app', 'tok'); });

  it('POSTs messages to the internal llmchat endpoint on baseDomain', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      ok({ messages: [{ role: 'user', content: 'q' }, { role: 'system', content: '[]' }] }),
    );
    const res = await api.llmChat([{ role: 'user', content: 'q' }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://acme.rossum.app/api/v1/internal/llmchat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
      }),
    );
    expect(res.messages).toHaveLength(2);
  });

  it('throws an error carrying the HTTP status on 403', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(err(403, { detail: 'nope' }));
    await expect(api.llmChat([{ role: 'user', content: 'q' }])).rejects.toMatchObject({ status: 403 });
  });
});

describe('probeLlmChat', () => {
  beforeEach(() => { api.init('https://acme.rossum.app', 'tok'); });

  it('true when the endpoint replies 400 (messages required)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(err(400, { messages: ['This field is required.'] }));
    expect(await api.probeLlmChat()).toBe(true);
  });
  it('false when gated (403)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(err(403, {}));
    expect(await api.probeLlmChat()).toBe(false);
  });
  it('false on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    expect(await api.probeLlmChat()).toBe(false);
  });
  it('sends an empty body (never generation content)', async () => {
    const f = vi.fn().mockResolvedValue(err(400, {}));
    globalThis.fetch = f;
    await api.probeLlmChat();
    expect(f.mock.calls[0][1].body).toBe('{}');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-api.test.js`
Expected: FAIL — `api.llmChat`/`api.probeLlmChat` are not functions.

- [ ] **Step 3: Implement** — add the import at the top of `src/mdh/api.js`:

```js
import { classifyProbe } from './llmPipeline.js';
```

and append after `getOrgId()`:

```js
// Rossum internal LLM chat. Per-org feature-flagged; verified live on
// a customer dev org 2026-06-23. Uses baseDomain (the Rossum API), NOT serviceBase
// (Data Storage). Input messages must be user-role only; the reply is the last
// element of the returned `messages` array (role comes back as "system").
export async function llmChat(messages, { signal: externalSignal } = {}) {
  const { signal, timer } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${baseDomain}/api/v1/internal/llmchat`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) {
    throw apiError('Session expired. Open a Rossum page and click Data Storage again to reconnect.', 401);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
  }
  return data;
}

// Cheap availability probe: POST {} → 400 ("messages required") when reachable/
// enabled, 403/other when gated. No model generation. Never throws (mirrors
// getOrgId): any error ⇒ unavailable.
export async function probeLlmChat() {
  const { signal, timer } = combinedSignal();
  try {
    const res = await fetch(`${baseDomain}/api/v1/internal/llmchat`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
    clearTimeout(timer);
    return classifyProbe(res.status);
  } catch {
    clearTimeout(timer);
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-api.test.js`
Expected: PASS (existing + 6 new tests).

- [ ] **Step 5: Verify (no commit)**

Run: `npm test`.

---

### Task 3: `aiAvailable` signal + non-blocking probe in `initMdh`

**Files:**
- Modify: `src/mdh/store.js` (add one signal)
- Modify: `src/mdh/index.jsx` (add probe in `initMdh`, after `store.orgId.value = await api.getOrgId();`, ~line 102)
- Test: `tests/mdh-init-ai-probe.test.js`

**Interfaces:**
- Consumes: `api.probeLlmChat`, `store.orgId`, `store.domain`, `store.aiAvailable`.
- Produces: `store.aiAvailable` (signal, default `false`); per-org `sessionStorage` key `mdhAiAvailable_<orgId|domain>`.

- [ ] **Step 1: Add the signal** to `src/mdh/store.js` (next to the other top-level signals, e.g. after `connected`):

```js
export const aiAvailable = signal(false); // /internal/llmchat reachable on this org
```

- [ ] **Step 2: Write the failing test**

```js
// tests/mdh-init-ai-probe.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolate the probe logic as a unit (initMdh has heavy side effects); test the
// exported helper that index.jsx uses.
import { resolveAiAvailability } from '../src/mdh/index.jsx';
import * as api from '../src/mdh/api.js';

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('resolveAiAvailability', () => {
  it('uses a cached true without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'true');
    const probe = vi.spyOn(api, 'probeLlmChat');
    expect(await resolveAiAvailability('org1')).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
  it('uses a cached false without probing', async () => {
    sessionStorage.setItem('mdhAiAvailable_org1', 'false');
    const probe = vi.spyOn(api, 'probeLlmChat');
    expect(await resolveAiAvailability('org1')).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
  it('probes and caches on a miss', async () => {
    vi.spyOn(api, 'probeLlmChat').mockResolvedValue(true);
    expect(await resolveAiAvailability('org2')).toBe(true);
    expect(sessionStorage.getItem('mdhAiAvailable_org2')).toBe('true');
  });
});
```

> Note: `tests/setup.js` runs under jsdom, which provides `sessionStorage`. If a prior test leaves it undefined, add `globalThis.sessionStorage = window.sessionStorage` in this file's top — verify during execution.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/mdh-init-ai-probe.test.js`
Expected: FAIL — `resolveAiAvailability` is not exported.

- [ ] **Step 4: Implement** — add to `src/mdh/index.jsx` (export the helper; call it non-blocking from `initMdh`):

```js
// Resolve /llmchat availability for the org, caching the result per-org in
// sessionStorage so a same-session reload doesn't re-probe. Returns a boolean;
// never throws (probeLlmChat swallows errors → false).
export async function resolveAiAvailability(orgKey) {
  const key = `mdhAiAvailable_${orgKey}`;
  let cached = null;
  try { cached = sessionStorage.getItem(key); } catch {}
  if (cached === 'true' || cached === 'false') return cached === 'true';
  const available = await api.probeLlmChat();
  try { sessionStorage.setItem(key, String(available)); } catch {}
  return available;
}
```

Then inside `initMdh`, immediately after `store.orgId.value = await api.getOrgId();`:

```js
  // AI pipeline input: probe /llmchat availability without blocking boot. A hang
  // or error simply leaves aiAvailable false (the input stays hidden).
  resolveAiAvailability(store.orgId.value || store.domain.value)
    .then((available) => { store.aiAvailable.value = available; })
    .catch(() => {});
```

(Confirm `import * as store from './store.js'` already covers `store.aiAvailable`; `api` is already imported as `* as api`.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/mdh-init-ai-probe.test.js`
Expected: PASS.

- [ ] **Step 6: Verify (no commit)**

Run: `npm test`.

---

### Task 4: Restore the NL input in `PipelineEditor.jsx`

**Files:**
- Modify: `src/mdh/components/PipelineEditor.jsx`
- Test: `tests/mdh-pipeline-editor-ai.test.js`

**Interfaces:**
- Consumes: `aiAvailable`, `error` (store); `api.llmChat`; `buildPipelineMessages`, `extractReply`, `stripFences` (llmPipeline); existing `fieldsFn()`, `editorRef`.
- Produces: the gated `.nl-search-row` UI + `handleNlSubmit`.

- [ ] **Step 1: Write the failing test**

```js
// tests/mdh-pipeline-editor-ai.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';

// Stub the heavy children so the editor mounts cheaply in jsdom.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => h('div', { class: 'json-editor-stub' }),
  extractFieldNames: () => [],
}));
vi.mock('../src/mdh/components/QueryHistory.jsx', () => ({
  LibraryPanel: () => null, saveQuery: () => {}, unsaveQuery: () => {}, isSaved: async () => false,
}));
vi.mock('../src/mdh/pipelineComments.js', () => ({ beautifyText: (t) => t }));

import PipelineEditor from '../src/mdh/components/PipelineEditor.jsx';
import { aiAvailable } from '../src/mdh/store.js';

const root = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
const props = {
  editorRef: { current: { getValue: () => '[]', setValue: vi.fn() } },
  initialValue: '[]', onChange() {}, onValidChange() {}, onLoadPipeline() {}, onReset() {}, onToggleStage() {},
};

beforeEach(() => { document.body.innerHTML = ''; aiAvailable.value = false; });

describe('PipelineEditor AI input', () => {
  it('hides the NL input when aiAvailable is false', () => {
    const r = root();
    render(h(PipelineEditor, props), r);
    expect(r.querySelector('.nl-search-input')).toBeNull();
  });
  it('shows the NL input when aiAvailable is true', () => {
    aiAvailable.value = true;
    const r = root();
    render(h(PipelineEditor, props), r);
    expect(r.querySelector('.nl-search-input')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-editor-ai.test.js`
Expected: FAIL — `.nl-search-input` never rendered.

- [ ] **Step 3: Implement** — edits to `src/mdh/components/PipelineEditor.jsx`:

(a) Update imports (line 3-7 region):

```js
import { selectedCollection, records, sampledFields, aiAvailable, error } from '../store.js';
import { extractFieldNames } from './JsonEditor.jsx';
import JsonEditor from './JsonEditor.jsx';
import { LibraryPanel, saveQuery, unsaveQuery, isSaved } from './QueryHistory.jsx';
import { beautifyText } from '../pipelineComments.js';
import * as api from '../api.js';
import { buildPipelineMessages, extractReply, stripFences } from '../llmPipeline.js';
```

(b) Add state/refs (after `const saveInputRef = useRef(null);`):

```js
  const [nlQuery, setNlQuery] = useState('');
  const [nlLoading, setNlLoading] = useState(false);
  const nlInputRef = useRef(null);
  const nlAbortRef = useRef(null);
```

(c) Abort any in-flight request on unmount (add near the other effects):

```js
  useEffect(() => () => { if (nlAbortRef.current) nlAbortRef.current.abort(); }, []);
```

(d) Add the handler (near the other handlers, e.g. after `beautify()`):

```js
  async function handleNlSubmit() {
    const q = nlQuery.trim();
    if (!q || nlLoading || !editorRef.current) return;

    const fields = fieldsFn();
    const currentPipeline = editorRef.current.getValue().trim();
    const messages = buildPipelineMessages({ fields, currentPipeline, request: q });

    if (nlAbortRef.current) nlAbortRef.current.abort();
    const controller = new AbortController();
    nlAbortRef.current = controller;

    setNlLoading(true);
    try {
      const res = await api.llmChat(messages, { signal: controller.signal });
      const cleaned = stripFences(extractReply(res));
      if (cleaned) editorRef.current.setValue(cleaned);
      setNlQuery('');
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (err.status === 403) { aiAvailable.value = false; return; } // gated mid-session → hide
      error.value = { message: 'AI search failed: ' + err.message };
    } finally {
      setNlLoading(false);
    }
  }
```

(e) Insert the gated NL row in the render, directly before the editor wrapper `<div style="display:flex;flex:1;min-height:0">` (current line 149):

```jsx
      {aiAvailable.value && (
        <div class="nl-search-row">
          <div class="nl-search-wrapper">
            <input
              ref={nlInputRef}
              class={'nl-search-input' + (nlLoading ? ' loading' : '')}
              type="text"
              placeholder="Describe a query in plain English..."
              value={nlLoading ? '' : nlQuery}
              disabled={nlLoading}
              onInput={(e) => setNlQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNlSubmit();
                if (e.key === 'Escape') { setNlQuery(''); nlInputRef.current?.blur(); }
              }}
            />
            {nlLoading && <div class="nl-search-loading">Generating pipeline...</div>}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-editor-ai.test.js`
Expected: PASS (both cases).

- [ ] **Step 5: Verify (no commit)**

Run: `npm test`.

---

### Task 5: Restore the animated CSS in `console.css`

**Files:**
- Modify: `src/console/console.css` (append the `nl-search`/`ai-*` rules)

**Interfaces:** consumes existing vars `--border`, `--radius`, `--bg-input`, `--text-primary`, `--text-secondary`, `--font-sans`, `--accent` (all present in `console.css`).

- [ ] **Step 1: Append the restored rules** (verbatim from `d99e48c~1:src/mdh/mdh.css`, minus the out-of-scope `.ai-thinking` selector):

```css
/* AI pipeline input (restored from d99e48c; engine swapped to /internal/llmchat) */
.nl-search-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.nl-search-wrapper { position: relative; }
.nl-search-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 11px;
  transition: border-color 0.2s;
  box-sizing: border-box;
}
.nl-search-input:focus { border-color: var(--accent); outline: none; }
.nl-search-input:disabled { opacity: 0.6; cursor: default; }
.nl-search-input::placeholder { color: var(--text-secondary); }
.nl-search-input.loading {
  border: 1.5px solid transparent;
  padding: 3.5px 7.5px;
  background:
    linear-gradient(var(--bg-input), var(--bg-input)) padding-box,
    conic-gradient(from var(--ai-angle), #8b5cf6, #ec4899, #f97316, #3b82f6, #22d3ee, #8b5cf6) border-box;
  color: transparent;
  box-shadow: 0 0 14px -4px rgba(139, 92, 246, 0.45);
  animation: ai-border-spin 2.4s linear infinite;
}
.nl-search-input.loading::placeholder { color: transparent; }
.nl-search-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 9.5px;
  font-size: 11px;
  font-style: italic;
  font-weight: 500;
  pointer-events: none;
  background: linear-gradient(90deg, #8b5cf6, #ec4899, #f97316, #3b82f6, #22d3ee, #8b5cf6);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: ai-text-shimmer 3s linear infinite;
}
@property --ai-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
@keyframes ai-border-spin { to { --ai-angle: 360deg; } }
@keyframes ai-text-shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }
@media (prefers-reduced-motion: reduce) {
  .nl-search-input.loading, .nl-search-loading { animation: none; }
}
```

> Verify `--radius` exists in `console.css`; if not, use the value the rest of the file uses for inputs (grep `border-radius` on `.input`).

- [ ] **Step 2: Build and verify the CSS ships**

Run: `npm run build`
Expected: build succeeds; `dist/console/console.css` contains `.nl-search-input.loading`.
Run: `grep -c 'nl-search-input' dist/console/console.css` → ≥ 1.

- [ ] **Step 3: Verify (no commit)**

Run: `npm test`.

---

### Task 6: Integration build + behavioral smoke

**Files:** none (verification task).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: no errors; `dist/console/console.js` built.

- [ ] **Step 2: CSP-cleanliness check** (the Console page forbids `new Function`/eval; ensure no new violation)

Run: `grep -nE 'new Function|eval\(' dist/console/console.js | grep -v sourceMappingURL | head`
Expected: no matches attributable to this feature (baseline already clean).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Manual smoke (headed), best-effort**

Load `dist/` as an unpacked extension, open Dataset Management on a customer dev org, confirm: the NL input appears (probe → 400 → available), typing a request + Enter shows the spinning-gradient/shimmer loading state and replaces the pipeline with valid JSON. (If manual load isn't available in this environment, rely on Task 7's live verification.)

---

### Task 7: LIVE prompt evaluation & iteration (the acceptance criterion)

**Goal:** Empirically verify the folded prompt yields **good, expected** pipelines across realistic requests — against the live `llmchat` AND by executing each generated pipeline on real Data Storage data (a customer dev org). Iterate `MONGO_SYSTEM_INSTRUCTION` until results are reliably correct, then lock it in.

**Files:**
- Modify (only if eval finds improvements): `src/mdh/llmPipeline.js` (`MONGO_SYSTEM_INSTRUCTION`), and `tests/mdh-llm-pipeline.test.js` if the instruction text assertion changes.
- Create (scratch, not shipped): an eval harness under the scratchpad dir.

**Methodology (no assumptions — every judgement grounded in a real execution):**

- [ ] **Step 1: Discover real data.** `data_storage_list_collections` on a customer dev org → pick 1–2 collections with rich fields. For each, `data_storage_find` a few docs to learn the **real** field names + types. Record them.

- [ ] **Step 2: Build a request suite (~12–15)** spanning: simple filter; multi-condition filter; sort; top-N (sort+limit+project); projection (include/exclude); count; group-by + sum; group-by + count; distinct values; date/recent filter; rename/compute a field; "modify the current pipeline" (start from a non-empty pipeline, add one stage); and 1–2 ambiguous/garbage requests (expect a sane minimal pipeline or empty, not a crash).

- [ ] **Step 3: For each request, call the REAL endpoint** with the exact production prompt: `buildPipelineMessages({ fields: <real fields>, currentPipeline: <case>, request })` → `POST {baseDomain}/api/v1/internal/llmchat` (curl with the org session token). Capture raw output.

- [ ] **Step 4: Validate each output three ways:**
  1. `stripFences` then `JSON.parse` → must be an **array** (syntactic validity).
  2. Execute it via `data_storage_aggregate` against the real collection → must **not error** (semantic validity on the real backend).
  3. Judge intent: does the returned data match what the request asked for? (e.g. "top 5 by amount" → 5 docs, descending, projected fields only.)

- [ ] **Step 5: Tally + diagnose.** Record pass/fail per case with the failure mode (invalid JSON / aggregation error / wrong intent). For systematic failures, refine `MONGO_SYSTEM_INSTRUCTION` — candidate additions only if evidence demands them, e.g.: "Use only the listed field names exactly"; "For dates, compare against ISO strings / `$dateFromString` as the data requires"; "Do not use `$$`-prefixed variables"; "Prefer `$project` to limit output fields when the request names specific columns." Keep the instruction tight (YAGNI) — add a clause only when a real failure proves it necessary.

- [ ] **Step 6: Re-run the full suite** after each instruction change until: 100% syntactically valid + executable, and intent-correct on all unambiguous cases. Document the final pass rate and any residual known-limitations.

- [ ] **Step 7: Lock it in.** Commit the final `MONGO_SYSTEM_INSTRUCTION` into `src/mdh/llmPipeline.js` (update the unit-test assertion if the text changed). Run `npm test`. Record the eval results (suite, pass rate, final prompt) in this plan's results section / a memory note.

> Execution note: run Steps 3–4 as a Workflow fan-out (one agent per request: build prompt → curl llmchat → parse → `data_storage_aggregate` → structured verdict), then synthesize Step 5. All operations are read-only (find/aggregate). The org session token is already available in this run.

---

### Task 8: Docs

**Files:**
- Modify: `CLAUDE.md` (MDH section + "Chrome Storage Keys")

- [ ] **Step 1:** In the MDH architecture section, add one sentence: the pipeline editor has an **AI pipeline input** (restored) that turns a plain-English request into an aggregation pipeline via the Rossum internal `/api/v1/internal/llmchat` endpoint, shown only where that per-org-feature-flagged endpoint is reachable (cheap empty-body probe at MDH init, cached per-org in `sessionStorage`).

- [ ] **Step 2:** Under "Chrome Storage Keys", note that AI availability is cached in **`sessionStorage`** (key `mdhAiAvailable_<org>`), not `chrome.storage` (so it is ephemeral and never persists the result at rest).

- [ ] **Step 3: Verify (no commit)** — `npm run build && npm test` green; re-read the edited CLAUDE.md sections for accuracy.

---

## Self-Review

**Spec coverage:** UI restore → Tasks 4+5; llmchat engine + verified contract → Tasks 1+2; graceful eager probe + per-org cache → Tasks 2+3; backward-compat (additive, hidden when off) → Tasks 3+4; testing (pure + mocked, no live) → Tasks 1–4; **prompt quality verified live** (new acceptance criterion) → Task 7; out-of-scope exclusions honored (no AiInsight/aiKnowledge/Feature-preview/Nano) → Tasks 4+5 only touch the NL input; docs → Task 8. No gaps.

**Placeholder scan:** all code blocks are concrete; the only deferred specifics are Task 7's real field names / request data, which are inherently discovered at eval time (the methodology is fully specified). The two `> Verify …` notes are guardrails, not missing content.

**Type consistency:** `buildPipelineMessages`/`extractReply`/`stripFences`/`classifyProbe` names + signatures match across Tasks 1, 2, 4. `api.llmChat`/`api.probeLlmChat` consistent in Tasks 2, 3, 4. `aiAvailable` signal consistent in Tasks 3, 4. `resolveAiAvailability(orgKey)` consistent in Task 3.
