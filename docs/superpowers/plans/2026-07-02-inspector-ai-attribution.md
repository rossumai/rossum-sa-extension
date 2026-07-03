# Inspector AI Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Inspector's two regex-heuristic attributions (which extension applied a label; which hook rejected the doc) with the Rossum Agent API ("Mr. Fabry"), which reasons over the actual hook code / settings / logs / field values and returns a reasoned attribution + confidence + plain-language explanation.

**Architecture:** A new pure `agentAttribute.js` (prompt builder + lenient verdict parser + a `runAttribution` orchestrator that reuses the existing `mdh/agent` transport) and an `attributionContext.js` (assembles candidate hooks-with-code + logs + field values from the Inspector's `api`/store). The two in-scope panels (Rejected, Labels) auto-run the agent on open for their finding, render loading → attributed `CulpritChip` + confidence + explanation, and the retired regex helpers are deleted. Verified attributions are untouched.

**Tech Stack:** Preact + @preact/signals, esbuild (iife), Vitest (`.test.js` via `h()` + `vi.mock`), the shared Rossum Agent API transport (`src/mdh/agent/agentApi.js` + `agentStream.js`).

**Spec:** `docs/superpowers/specs/2026-07-02-inspector-ai-attribution-design.md`

## Global Constraints

- **Read-only, strictly.** The agent must never write and must never touch the `revalidate` path. Prime `/persona cautious` + a read-only prompt framing on every chat. Hard server-side guarantee is a ship-blocker before non-dogfood (documented, not coded).
- **Scope = the two regex-on-code attributions only:** Labels applied-by-**extension** (non-rule) labels, and Rejected's **automated-hook** case. Verified attributions (rule-applied labels, workflow/human rejection, Blocked/Provenance/Pipeline/Export) are untouched.
- **Auto on panel open**, only for these two panels. One agent call per finding returns `{culprit, confidence, explanation}`. **No regex fallback** — if the agent is unavailable, the finding shows an explicit "AI attribution unavailable" state (per the approved design).
- **Reuse the shared agent transport** `src/mdh/agent/agentApi.js` (`createChat`, `streamMessage`, `probeAgent`) + `agentStream.js` (`newAcc`/`foldEvents`/`replyText`) — do NOT duplicate it. It's already `init`'d once in the console shell.
- **Evidence is seeded client-side** (candidate hook code via `api.getHook`, logs via `api.listHookLogs`, field values from content) so the common case doesn't depend on the agent's own MCP tool auth.
- Vitest tests are `.test.js` using `h(Component, null, ...)` + `vi.mock` (jsdom for components). **Do NOT `git commit`** during the run (standing owner preference); end each task by running its test file, end the plan with the full suite + `npm run build`.

---

## File Structure

**Create:**
- `src/inspector/agentAttribute.js` — pure `buildAttributionPrompt`/`parseAttribution` + `runAttribution` (agentApi-only).
- `src/inspector/attributionContext.js` — `gatherLabelContext`/`gatherRejectContext` (api + store → context object).
- `tests/inspector-agent-attribute.test.js`, `tests/inspector-attribution-context.test.js`.

**Modify:**
- `src/inspector/store.js` — add `aiAvailable` + `attributions` signals; reset them per annotation.
- `src/inspector/index.jsx` — probe agent availability in `initInspector`; drop `extractLabelHooks` from `loadLabelContext` (keep labels/rules; keep raw hooks for context).
- `src/inspector/components/ReliabilityBadge.jsx` — render `high|medium|low` confidence.
- `src/inspector/components/RejectedPanel.jsx` — auto agent attribution for the hook case.
- `src/inspector/components/LabelsPanel.jsx` — agent attribution for applied non-rule labels.
- `src/inspector/culprit.js` — delete the retired regex helpers.
- `src/console/console.css` — attribution loading/confidence styles.
- Tests: update/trim `tests/inspector-*` that reference the retired helpers.

**Delete (from culprit.js, not whole files):** `LABEL_APPLY_SIG`, `labelIdsInBlob`, `hookReferencesLabelName`, `extractLabelHooks`, `labelExtensionCandidates`, `extensionAttribution`, `detectRejectCapability`, `rankRejectCandidates`, and any now-unused local helper.

---

## Task 1: agentAttribute — prompt builder + verdict parser (pure)

**Files:**
- Create: `src/inspector/agentAttribute.js`
- Test: `tests/inspector-agent-attribute.test.js`

**Interfaces:**
- Produces:
  - `buildAttributionPrompt({ kind, annotation, target, candidates, logs, fields }): string` — `kind` ∈ `'label'|'reject'`.
  - `parseAttribution(text): { culprit: {kind,id,name}|null, confidence: 'high'|'medium'|'low', explanation: string } | null`

- [ ] **Step 1: Write the failing test** — `tests/inspector-agent-attribute.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildAttributionPrompt, parseAttribution } from '../src/inspector/agentAttribute.js';

describe('buildAttributionPrompt', () => {
  const base = {
    annotation: { id: 42, status: 'rejected' },
    candidates: [{ id: 7, name: 'Rejector', type: 'function', events: ['annotation_content.confirm'], code: 'if (x) annotation.reject()', settings: { a: 1 } }],
    logs: [{ hook: 7, action: 'annotation_content.confirm', log_level: 'ERROR', request_id: 'r1' }],
    fields: { total: '10' },
  };
  it('label prompt is read-only, names the label, seeds candidates+code, demands JSON-only', () => {
    const p = buildAttributionPrompt({ kind: 'label', target: { id: 3, name: 'Urgent' }, ...base });
    expect(p).toMatch(/READ-ONLY/);
    expect(p).toMatch(/label "Urgent"/);
    expect(p).toMatch(/hook #7 "Rejector"/);
    expect(p).toMatch(/if \(x\) annotation\.reject\(\)/);         // real code seeded
    expect(p).toMatch(/ONLY this JSON object/);
  });
  it('reject prompt states the reject question + reason', () => {
    const p = buildAttributionPrompt({ kind: 'reject', target: { rejectedAt: '2026-01-01', reason: 'bad total' }, ...base });
    expect(p).toMatch(/which extension rejected/i);
    expect(p).toMatch(/bad total/);
  });
  it('marks a codeless webhook candidate as opaque', () => {
    const p = buildAttributionPrompt({ kind: 'reject', target: {}, annotation: base.annotation, candidates: [{ id: 9, name: 'WH', type: 'webhook', events: [], code: null, settings: {} }] });
    expect(p).toMatch(/opaque/);
  });
});

describe('parseAttribution', () => {
  it('parses a valid verdict', () => {
    expect(parseAttribution('{"culprit":{"kind":"hook","id":7,"name":"Rejector"},"confidence":"high","explanation":"it calls reject()"}'))
      .toEqual({ culprit: { kind: 'hook', id: 7, name: 'Rejector' }, confidence: 'high', explanation: 'it calls reject()' });
  });
  it('maps unknown culprit to null and clamps bad confidence to low', () => {
    expect(parseAttribution('prose {"culprit":{"kind":"unknown"},"confidence":"???","explanation":"n/a"} tail'))
      .toEqual({ culprit: null, confidence: 'low', explanation: 'n/a' });
  });
  it('returns null when there is no JSON object', () => {
    expect(parseAttribution('I could not determine this.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-agent-attribute.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/inspector/agentAttribute.js` (parser + prompt for now; `runAttribution` is Task 2):

```js
// AI-reasoned attribution for the Inspector — the agent reads real hook code /
// settings / logs / field values and returns a culprit + confidence + why.
// Pure prompt/parse here; runAttribution (below) reuses the shared agent transport.
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';

const trunc = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };

export function buildAttributionPrompt({ kind, annotation = {}, target = {}, candidates = [], logs = [], fields = null }) {
  const parts = [
    'You are investigating a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything and never call any write / reject / revalidate action — only read and reason.',
  ];
  if (kind === 'label') {
    parts.push(`Question: which extension applied the label "${target.name}" (id ${target.id}) to this annotation, and why?`);
  } else {
    parts.push(`Question: which extension rejected this annotation${target.rejectedAt ? ` (rejected at ${target.rejectedAt})` : ''}, and why?`);
    if (target.reason) parts.push(`Recorded rejection reason: ${target.reason}`);
  }
  parts.push(`Annotation: id ${annotation.id}, status ${annotation.status}.`);
  if (fields) parts.push(`Field values (compact):\n${trunc(JSON.stringify(fields), 1500)}`);
  parts.push('Candidate extensions on this queue — reason about their ACTUAL code/settings/logs. A webhook with no readable code is opaque; say so rather than guess.');
  for (const c of candidates) {
    parts.push(`- hook #${c.id} "${c.name}" [type=${c.type}; events=${(c.events || []).join(',')}]\n  settings: ${trunc(JSON.stringify(c.settings ?? {}), 800)}\n  code: ${c.code ? trunc(c.code, 2000) : '(no readable code — webhook/opaque)'}`);
  }
  if (logs.length) {
    parts.push(`Relevant hook logs:\n${logs.map((l) => `- hook ${l.hook ?? l.hook_id ?? '?'} action=${l.action} level=${l.log_level}${l.request_id ? ` request_id=${l.request_id}` : ''}`).join('\n')}`);
  }
  parts.push('Decide which single extension is responsible. If none can be determined, use kind "unknown". If it was clearly a person (no extension involved), use kind "manual".');
  parts.push('Respond with ONLY this JSON object and nothing else: {"culprit":{"kind":"hook|webhook|rule|manual|unknown","id":<number|null>,"name":"<name>"},"confidence":"high|medium|low","explanation":"<one short paragraph>"}');
  return parts.join('\n\n');
}

export function parseAttribution(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const c = o.culprit;
    const culprit = c && c.kind && c.kind !== 'unknown' && c.kind !== 'manual'
      ? { kind: String(c.kind), id: c.id == null ? null : c.id, name: String(c.name || '') }
      : (c && c.kind === 'manual' ? { kind: 'manual', id: null, name: c.name ? String(c.name) : 'manual' } : null);
    const confidence = ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low';
    return { culprit, confidence, explanation: typeof o.explanation === 'string' ? o.explanation : '' };
  } catch { return null; }
}

// Filled in Task 2.
export async function runAttribution() { throw new Error('not implemented'); }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-agent-attribute.test.js` → PASS. (No commit — owner constraint.)

---

## Task 2: agentAttribute — runAttribution orchestrator

**Files:**
- Modify: `src/inspector/agentAttribute.js`
- Test: `tests/inspector-agent-attribute.test.js` (add cases)

**Interfaces:**
- Consumes: `buildAttributionPrompt`/`parseAttribution` (Task 1); `createChat`/`streamMessage` from `../mdh/agent/agentApi.js`; `newAcc`/`foldEvents`/`replyText` from `../mdh/agent/agentStream.js`.
- Produces: `runAttribution({ agentApi, kind, context, onPhase?, signal? }): Promise<{ verdict }>` — `context = { annotation, target, candidates, logs, fields }`. Creates a fresh chat, primes `/persona cautious`, sends one turn, parses. Unparseable → a null-culprit verdict whose `explanation` is the raw reply (never fabricate a culprit).

- [ ] **Step 1: Write the failing test** — add to `tests/inspector-agent-attribute.test.js`:

```js
import { vi } from 'vitest';
import { runAttribution } from '../src/inspector/agentAttribute.js';

function mockAgentApi(reply) {
  return {
    createChat: vi.fn(async () => 'chat_i'),
    streamMessage: vi.fn(async (_id, content, { onEvent }) => {
      if (content === '/persona cautious') return;
      onEvent({ type: 'text-delta', delta: reply });
      onEvent({ type: 'finish' });
    }),
  };
}

describe('runAttribution', () => {
  const ctx = { annotation: { id: 1, status: 'rejected' }, target: { rejectedAt: 't' }, candidates: [], logs: [], fields: null };
  it('primes the cautious persona then returns the parsed verdict', async () => {
    const agentApi = mockAgentApi('{"culprit":{"kind":"hook","id":7,"name":"Rejector"},"confidence":"high","explanation":"x"}');
    const { verdict } = await runAttribution({ agentApi, kind: 'reject', context: ctx });
    expect(agentApi.streamMessage).toHaveBeenCalledWith('chat_i', '/persona cautious', expect.anything());
    expect(verdict.culprit).toEqual({ kind: 'hook', id: 7, name: 'Rejector' });
    expect(verdict.confidence).toBe('high');
  });
  it('falls back to a null-culprit verdict (raw reply) when unparseable', async () => {
    const agentApi = mockAgentApi('I cannot tell.');
    const { verdict } = await runAttribution({ agentApi, kind: 'reject', context: ctx });
    expect(verdict.culprit).toBeNull();
    expect(verdict.explanation).toBe('I cannot tell.');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-agent-attribute.test.js` → FAIL (`not implemented`).

- [ ] **Step 3: Implement** — replace the stub in `src/inspector/agentAttribute.js`:

```js
export async function runAttribution({ agentApi, kind, context, onPhase = () => {}, signal }) {
  onPhase('Reasoning');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  await agentApi.streamMessage(chatId, buildAttributionPrompt({ kind, ...context }), {
    signal,
    onEvent: (ev) => { foldEvents(acc, [ev]); if (acc.status) onPhase(acc.status); },
  });
  const raw = replyText(acc);
  const verdict = parseAttribution(raw) || { culprit: null, confidence: 'low', explanation: raw };
  return { verdict };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-agent-attribute.test.js` → PASS (all cases).

---

## Task 3: attributionContext — gather candidates + evidence

**Files:**
- Create: `src/inspector/attributionContext.js`
- Test: `tests/inspector-attribution-context.test.js`

**Interfaces:**
- Consumes: the Inspector `api` (`getHook`, `listHooks`, `listHookLogs`) and `store.data`/`store.enrichment`.
- Produces:
  - `gatherRejectContext({ api, store, reason }): Promise<{ annotation, target, candidates, logs, fields }>`
  - `gatherLabelContext({ api, store, labelId, labelName }): Promise<{ annotation, target, candidates, logs, fields }>`
  - Both: `candidates` = active queue hooks with `.code` (fetched via `getHook` when the list entry lacks it), `logs` = annotation hook logs, `fields` = a compact `{schemaId: value}` map from content. Never throw (degrade to empties).
- Helper `compactFields(content)` and `activeQueueHooksWithCode(api, d)` are internal.

- [ ] **Step 1: Write the failing test** — `tests/inspector-attribution-context.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { gatherRejectContext, gatherLabelContext } from '../src/inspector/attributionContext.js';

function fakeStore(overrides = {}) {
  const d = {
    annotation: { id: 5, status: 'rejected', rejected_at: 't', queue: 'https://x/api/v1/queues/9' },
    content: [{ schema_id: 'total', category: 'datapoint', content: { value: '10' } }],
    resolved: { hooksById: { 7: { id: 7, name: 'H', type: 'function', events: ['annotation_content.confirm'] } } },
    ...overrides.data,
  };
  return {
    data: { value: d },
    enrichment: { value: { hookLogs: [{ hook: 7, action: 'x', log_level: 'ERROR' }], ...overrides.enrichment } },
  };
}
const api = () => ({
  getHook: vi.fn(async (id) => ({ id, name: 'H', type: 'function', events: ['annotation_content.confirm'], config: { code: 'reject()' } })),
  listHooks: vi.fn(async () => []),
  listHookLogs: vi.fn(async () => [{ hook: 7, action: 'x', log_level: 'ERROR' }]),
});

describe('gatherRejectContext', () => {
  it('assembles candidates (with fetched code), logs, and compact fields', async () => {
    const a = api();
    const ctx = await gatherRejectContext({ api: a, store: fakeStore(), reason: 'bad total' });
    expect(ctx.annotation.id).toBe(5);
    expect(ctx.target.reason).toBe('bad total');
    expect(ctx.candidates[0]).toMatchObject({ id: 7, name: 'H' });
    expect(ctx.candidates[0].code).toBe('reject()'); // pulled via getHook
    expect(ctx.fields).toEqual({ total: '10' });
    expect(ctx.logs.length).toBe(1);
  });
});

describe('gatherLabelContext', () => {
  it('targets the label and includes candidates', async () => {
    const ctx = await gatherLabelContext({ api: api(), store: fakeStore(), labelId: '3', labelName: 'Urgent' });
    expect(ctx.target).toEqual({ id: '3', name: 'Urgent' });
    expect(ctx.candidates.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-attribution-context.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/inspector/attributionContext.js`:

```js
// Assemble the read-only evidence the attribution agent reasons over: candidate
// queue hooks WITH their code, this annotation's hook logs, and compact field values.
const idFromUrl = (url) => { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; };

// Flatten the content datapoint tree to { schema_id: value } (best-effort, compact).
export function compactFields(content) {
  const out = {};
  const walk = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (n && n.category === 'datapoint' && n.schema_id) out[n.schema_id] = n.content?.value ?? null;
      if (n && n.children) walk(n.children);
    }
  };
  walk(content);
  return out;
}

// Active queue hooks with .code — from resolved.hooksById if present, else listHooks;
// getHook fills in code where the list entry lacks it. Bounded + never throws.
async function activeQueueHooksWithCode(api, d) {
  let hooks = Object.values(d.resolved?.hooksById || {});
  if (hooks.length === 0 && d.annotation?.queue) {
    hooks = (await api.listHooks(idFromUrl(d.annotation.queue)).catch(() => [])) || [];
  }
  hooks = hooks.filter((hk) => hk && hk.active !== false);
  return Promise.all(hooks.map(async (hk) => {
    let code = hk.config?.code ?? hk.code ?? null;
    if (code == null && hk.type === 'function') {
      const full = await api.getHook(hk.id).catch(() => null);
      code = full?.config?.code ?? full?.code ?? null;
    }
    return { id: hk.id, name: hk.name, type: hk.type, events: hk.events || [], settings: hk.settings ?? hk.config ?? {}, code };
  }));
}

function baseContext(store) {
  const d = store.data.value;
  const enr = store.enrichment.value || {};
  return { d, logs: Array.isArray(enr.hookLogs) ? enr.hookLogs : [], fields: compactFields(d?.content) };
}

export async function gatherRejectContext({ api, store, reason = null }) {
  const { d, logs, fields } = baseContext(store);
  const candidates = d ? await activeQueueHooksWithCode(api, d) : [];
  return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, target: { rejectedAt: d?.annotation?.rejected_at || null, reason }, candidates, logs, fields };
}

export async function gatherLabelContext({ api, store, labelId, labelName }) {
  const { d, logs, fields } = baseContext(store);
  const candidates = d ? await activeQueueHooksWithCode(api, d) : [];
  return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, target: { id: labelId, name: labelName }, candidates, logs, fields };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-attribution-context.test.js` → PASS.

---

## Task 4: store — aiAvailable + attributions + probe

**Files:**
- Modify: `src/inspector/store.js`, `src/inspector/index.jsx`

**Interfaces:**
- Produces: `store.aiAvailable` (signal, boolean), `store.attributions` (signal, map keyed `label:<id>` / `reject` → `{status,verdict?,error?}`), `store.setAttribution(key, val)`. Reset with the annotation.
- `initInspector` sets `store.aiAvailable` from `agentApi.probeAgent()` (non-blocking).

- [ ] **Step 1: add signals + reset** — in `src/inspector/store.js`, after `export const live = signal(null);`:

```js
// Rossum Agent API ("Mr. Fabry") availability for AI attribution (probed at init).
export const aiAvailable = signal(false);
// Per-finding AI attribution state, keyed 'label:<id>' / 'reject'. Reset per annotation.
export const attributions = signal({});
export function setAttribution(key, val) { attributions.value = { ...attributions.value, [key]: val }; }
```

Add `attributions.value = {};` to BOTH `setAnnotationId` (after `enrichment.value = emptyEnrichment();`) and `reset()`.

- [ ] **Step 2: probe availability at init** — in `src/inspector/index.jsx`, add import at top:

```js
import * as agentApi from '../mdh/agent/agentApi.js';
```

In `initInspector`, after `store.connected.value = true;`:

```js
  agentApi.probeAgent().then((ok) => { store.aiAvailable.value = ok; }).catch(() => {}); // non-blocking
```

- [ ] **Step 3: run existing store/init tests** — `npx vitest run tests/inspector-*.test.js` → the store/init changes are additive; existing tests still pass. (No dedicated test — exercised via the panel tests in Tasks 6–7.)

---

## Task 5: ReliabilityBadge — render confidence

**Files:**
- Modify: `src/inspector/components/ReliabilityBadge.jsx`
- Test: `tests/inspector-reliability-badge.test.js` (create)

**Interfaces:**
- Produces: `<ReliabilityBadge level={...} />` now also renders `'high'|'medium'|'low'` (agent confidence) in addition to the existing `'unavailable'`; `'verified'|'best-effort'|null` stay hidden.

- [ ] **Step 1: Write the failing test** — `tests/inspector-reliability-badge.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { h, render } from 'preact';
import ReliabilityBadge from '../src/inspector/components/ReliabilityBadge.jsx';

let root;
function mount(level) { root = document.createElement('div'); document.body.appendChild(root); render(h(ReliabilityBadge, { level }), root); return root; }
afterEach(() => { if (root) { render(null, root); root.remove(); } });

describe('ReliabilityBadge', () => {
  it('shows a confidence label for high/medium/low', () => {
    expect(mount('high').textContent).toMatch(/high confidence/i);
    expect(mount('low').textContent).toMatch(/low confidence/i);
  });
  it('still shows "Not recorded" for unavailable and nothing for verified/null', () => {
    expect(mount('unavailable').textContent).toMatch(/not recorded/i);
    expect(mount('verified').textContent).toBe('');
    expect(mount(null).textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-reliability-badge.test.js` → FAIL (only `unavailable` renders).

- [ ] **Step 3: Implement** — replace `src/inspector/components/ReliabilityBadge.jsx`:

```js
import { h } from 'preact';

const LABEL = {
  unavailable: 'Not recorded',
  high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence',
};

export default function ReliabilityBadge({ level }) {
  // 'unavailable' + the AI confidence levels are surfaced; 'verified'/'best-effort'
  // stay hidden (per the original product decision).
  if (!LABEL[level]) return null;
  return <span class={`inspector-rb inspector-rb-${level}`}>{LABEL[level]}</span>;
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-reliability-badge.test.js` → PASS.

---

## Task 6: RejectedPanel — auto agent attribution for the hook case

**Files:**
- Modify: `src/inspector/components/RejectedPanel.jsx`
- Test: `tests/inspector-rejected-panel.test.js` (create)

**Interfaces:**
- Consumes: `classifyRejection` (kept) from `culprit.js`; `runAttribution` from `agentAttribute.js`; `gatherRejectContext` from `attributionContext.js`; `store.attributions`/`setAttribution`/`aiAvailable`; `CulpritChip`; `ReliabilityBadge`.
- Replaces the `Investigate` button + `rankRejectCandidates` with: when `rej.type === 'hook'`, auto-run `runAttribution({kind:'reject'})` on mount (once, keyed `'reject'`), render loading → agent `CulpritChip` + confidence + explanation, or an "unavailable" note when `!aiAvailable`.

- [ ] **Step 1: Write the failing test** — `tests/inspector-rejected-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/inspector/index.jsx', () => ({ loadEnrichment: vi.fn(), loadQueueHooks: vi.fn() }));
const runAttribution = vi.fn();
vi.mock('../src/inspector/agentAttribute.js', () => ({ runAttribution: (...a) => runAttribution(...a) }));
vi.mock('../src/inspector/attributionContext.js', () => ({ gatherRejectContext: vi.fn(async () => ({})) }));

import RejectedPanel from '../src/inspector/components/RejectedPanel.jsx';
import * as store from '../src/inspector/store.js';

function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function p(){ let ok=false; try{ok=fn()}catch{} if(ok)return res(); if(Date.now()-t0>timeout)return rej(new Error('timeout')); setTimeout(p,step);})(); });
}
let root;
beforeEach(() => {
  store.aiAvailable.value = true;
  store.attributions.value = {};
  store.enrichment.value = { workflow: [], notes: [], hookLogs: [] };
  store.data.value = { annotation: { id: 1, status: 'rejected', rejected_at: 't', automatically_rejected: true }, resolved: { usersById: {}, hooksById: {} } };
  vi.clearAllMocks();
  root = document.createElement('div'); document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('RejectedPanel AI attribution', () => {
  it('auto-runs the agent for the hook case and renders the culprit + confidence + explanation', async () => {
    runAttribution.mockResolvedValue({ verdict: { culprit: { kind: 'hook', id: 7, name: 'Rejector' }, confidence: 'high', explanation: 'calls reject() when total is 0' } });
    render(h(RejectedPanel, null), root);
    await waitFor(() => runAttribution.mock.calls.length > 0);
    await waitFor(() => /Rejector/.test(root.textContent) && /calls reject/.test(root.textContent));
    expect(root.textContent).toMatch(/high confidence/i);
  });
  it('shows an unavailable note when the agent is offline', async () => {
    store.aiAvailable.value = false;
    render(h(RejectedPanel, null), root);
    await waitFor(() => /unavailable/i.test(root.textContent));
    expect(runAttribution).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-rejected-panel.test.js` → FAIL (module still imports `rankRejectCandidates`, no agent wiring).

- [ ] **Step 3: Implement** — replace `src/inspector/components/RejectedPanel.jsx`:

```js
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from '../store.js';
import { loadEnrichment, loadQueueHooks } from '../index.jsx';
import { classifyRejection } from '../culprit.js';
import { runAttribution } from '../agentAttribute.js';
import { gatherRejectContext } from '../attributionContext.js';
import * as api from '../api.js';
import * as agentApi from '../../mdh/agent/agentApi.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';
import CulpritChip from './CulpritChip.jsx';

export default function RejectedPanel() {
  const d = store.data.value;
  const enr = store.enrichment.value;

  useEffect(() => {
    if (store.enrichment.value.workflow === null) loadEnrichment('workflow');
    if (store.enrichment.value.notes === null) loadEnrichment('notes');
  }, [store.annotationId.value]);

  const rej = d ? classifyRejection({
    annotation: d.annotation,
    workflowActivities: Array.isArray(enr.workflow) ? enr.workflow : [],
    notes: Array.isArray(enr.notes) ? enr.notes : [],
    usersById: d.resolved.usersById,
  }) : { type: 'none' };

  // Auto-run AI attribution for the ambiguous automated-hook case.
  useEffect(() => {
    if (rej.type !== 'hook' || !store.aiAvailable.value) return;
    if (store.attributions.value.reject) return; // once per annotation
    let aborted = false;
    const ctrl = new AbortController();
    store.setAttribution('reject', { status: 'loading' });
    (async () => {
      loadQueueHooks(); if (store.enrichment.value.hookLogs === null) loadEnrichment('hookLogs');
      try {
        const context = await gatherRejectContext({ api, store, reason: rej.reason?.text || null });
        const { verdict } = await runAttribution({ agentApi, kind: 'reject', context, signal: ctrl.signal });
        if (!aborted) store.setAttribution('reject', { status: 'done', verdict });
      } catch (e) {
        if (!aborted && e?.name !== 'AbortError') store.setAttribution('reject', { status: 'error', error: e?.message || 'failed' });
      }
    })();
    return () => { aborted = true; ctrl.abort(); };
  }, [rej.type, store.aiAvailable.value, store.annotationId.value]);

  if (!d) return null;
  if (rej.type === 'none') return <div class="inspector-empty">This annotation has not been rejected.</div>;

  const attr = store.attributions.value.reject;
  return (
    <div class="inspector-panel">
      <div class={`inspector-culprit inspector-culprit-${rej.culprit?.kind || 'none'}`}>
        <div class="lbl">Culprit · {rej.culprit?.kind}</div>
        <div class="name">{rej.culprit?.name} <ReliabilityBadge level={rej.reliability} /></div>
        <div class="meta">{rej.automatic ? 'Automatic' : 'Manual'}{rej.when ? ` · ${rej.when}` : ''}{rej.current ? '' : ' · (historical — not currently rejected)'}</div>
      </div>
      <div class="inspector-reason">
        <div class="h">Reason</div>
        <div class="body">{rej.reason.text || 'Reason not recorded by the API.'}</div>
        <ReliabilityBadge level={rej.reason.reliability} />
      </div>
      {rej.type === 'hook' && (
        <div class="inspector-ai-attr">
          <div class="t">Which extension rejected this — reasoned by Mr. Fabry from the queue's extension code + logs.</div>
          {!store.aiAvailable.value && <div class="inspector-empty">AI attribution unavailable (agent offline).</div>}
          {attr?.status === 'loading' && <div class="inspector-loading">Reasoning…</div>}
          {attr?.status === 'error' && <div class="inspector-empty">AI attribution failed.</div>}
          {attr?.status === 'done' && (
            <div class="inspector-ai-verdict">
              <div class="ttl"><CulpritChip culprit={attr.verdict.culprit} /> <ReliabilityBadge level={attr.verdict.confidence} /></div>
              {attr.verdict.explanation && <div class="inspector-why">{attr.verdict.explanation}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-rejected-panel.test.js` → PASS (both cases).

---

## Task 7: LabelsPanel — agent attribution for applied non-rule labels

**Files:**
- Modify: `src/inspector/components/LabelsPanel.jsx`
- Test: `tests/inspector-labels-panel.test.js` (create)

**Interfaces:**
- Consumes: `labelAttribution` + `contrastText` (kept) from `culprit.js`; `runAttribution`; `gatherLabelContext`; `store.attributions`/`aiAvailable`; `CulpritChip`; `ReliabilityBadge`; `FoldableCode`.
- For each **applied** label WITHOUT a `rule` (rule-applied stays verified), auto-run `runAttribution({kind:'label'})` once (keyed `label:<id>`) and render the agent culprit + confidence + explanation (or loading/unavailable). Removes `extensionAttribution` usage.

- [ ] **Step 1: Write the failing test** — `tests/inspector-labels-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/inspector/index.jsx', () => ({ loadLabelContext: vi.fn() }));
const runAttribution = vi.fn();
vi.mock('../src/inspector/agentAttribute.js', () => ({ runAttribution: (...a) => runAttribution(...a) }));
vi.mock('../src/inspector/attributionContext.js', () => ({ gatherLabelContext: vi.fn(async () => ({})) }));

import LabelsPanel from '../src/inspector/components/LabelsPanel.jsx';
import * as store from '../src/inspector/store.js';

function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  return new Promise((res, rej) => { const t0 = Date.now(); (function p(){ let ok=false; try{ok=fn()}catch{} if(ok)return res(); if(Date.now()-t0>timeout)return rej(new Error('timeout')); setTimeout(p,step);})(); });
}
let root;
beforeEach(() => {
  store.aiAvailable.value = true;
  store.attributions.value = {};
  // one applied non-rule label (id 3) → agent-attributed
  store.data.value = { annotation: { labels: ['https://x/api/v1/labels/3'] }, resolved: { labelsById: { 3: { id: '3', name: 'Urgent', color: '#f00' } }, labelRules: [], labelHooks: [] } };
  vi.clearAllMocks();
  root = document.createElement('div'); document.body.appendChild(root);
});
afterEach(() => { render(null, root); root.remove(); });

describe('LabelsPanel AI attribution', () => {
  it('auto-attributes an applied non-rule label via the agent', async () => {
    runAttribution.mockResolvedValue({ verdict: { culprit: { kind: 'hook', id: 8, name: 'Labeler' }, confidence: 'medium', explanation: 'sets Urgent when total>1000' } });
    render(h(LabelsPanel, null), root);
    await waitFor(() => runAttribution.mock.calls.length > 0);
    await waitFor(() => /Labeler/.test(root.textContent) && /sets Urgent/.test(root.textContent));
    expect(runAttribution).toHaveBeenCalledWith(expect.objectContaining({ kind: 'label' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/inspector-labels-panel.test.js` → FAIL (imports `extensionAttribution`, no agent wiring).

- [ ] **Step 3: Implement** — edit `src/inspector/components/LabelsPanel.jsx`:
  - Change the import line 5 to drop `extensionAttribution`: `import { labelAttribution, contrastText } from '../culprit.js';`
  - Add imports:
    ```js
    import { runAttribution } from '../agentAttribute.js';
    import { gatherLabelContext } from '../attributionContext.js';
    import * as api from '../api.js';
    import * as agentApi from '../../mdh/agent/agentApi.js';
    import CulpritChip from './CulpritChip.jsx';
    ```
  - Delete the `appliedSource` function entirely (its `extensionAttribution` branches are replaced by the agent). Keep the rule-applied case inline (verified).
  - Replace the `applied.map(...)` block with a per-label component that: renders the `LabelChip`; if `l.rule` shows the verified "applied by rule" + fires-when `FoldableCode` (unchanged); else renders an `<AiLabelAttribution label={l} />` that auto-runs the agent. Add:

    ```js
    function AiLabelAttribution({ label }) {
      const key = `label:${label.id}`;
      useEffect(() => {
        if (!store.aiAvailable.value || store.attributions.value[key]) return;
        let aborted = false; const ctrl = new AbortController();
        store.setAttribution(key, { status: 'loading' });
        (async () => {
          try {
            const context = await gatherLabelContext({ api, store, labelId: label.id, labelName: label.name });
            const { verdict } = await runAttribution({ agentApi, kind: 'label', context, signal: ctrl.signal });
            if (!aborted) store.setAttribution(key, { status: 'done', verdict });
          } catch (e) { if (!aborted && e?.name !== 'AbortError') store.setAttribution(key, { status: 'error', error: e?.message }); }
        })();
        return () => { aborted = true; ctrl.abort(); };
      }, [store.aiAvailable.value, store.annotationId.value]);

      const attr = store.attributions.value[key];
      if (!store.aiAvailable.value) return <span class="inspector-label-why">AI attribution unavailable</span>;
      if (!attr || attr.status === 'loading') return <span class="inspector-label-why inspector-loading">reasoning…</span>;
      if (attr.status === 'error') return <span class="inspector-label-why">AI attribution failed</span>;
      const v = attr.verdict;
      return (
        <span class="inspector-ai-verdict-inline">
          <CulpritChip culprit={v.culprit} /> <ReliabilityBadge level={v.confidence} />
          {v.explanation && <span class="inspector-why">{v.explanation}</span>}
        </span>
      );
    }
    ```
  - The `applied.map` renders: for `l.rule` the existing verified markup; else `<div class="inspector-bcard"><div class="ttl"><LabelChip .../> <AiLabelAttribution label={l} /></div></div>`. Keep the `notApplied` and `!hasLabelAutomation` blocks unchanged, and keep the `useEffect(loadLabelContext)`. Add `useEffect` to the preact/hooks import.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/inspector-labels-panel.test.js` → PASS.

---

## Task 8: Retire the regex heuristics + CSS + full verification

**Files:**
- Modify: `src/inspector/culprit.js`, `src/inspector/index.jsx`, `src/console/console.css`
- Modify tests: any `tests/inspector-*.test.js` referencing retired helpers

- [ ] **Step 1: delete retired helpers from `culprit.js`** — remove `LABEL_APPLY_SIG`, `labelIdsInBlob`, `hookReferencesLabelName`, `extractLabelHooks`, `labelExtensionCandidates`, `extensionAttribution`, `detectRejectCapability`, `rankRejectCandidates` (and any local helper only they used). Keep everything else (`classifyMessage`, `explainBlocker`, `classifyRejection`, `fieldProvenance`, `matchingExtensions`, `matchConfigsForField`, `contrastText`, `exportHookCandidates`, `buildPipeline`, `extractLabelRules`, `labelAttribution`, `REL`).

- [ ] **Step 2: fix `index.jsx` `loadLabelContext`** — it imports and calls `extractLabelHooks`. Change the import (`line 3`) to `import { extractLabelRules } from './culprit.js';` and drop the `labelHooks` derivation: keep fetching `hooks` (still needed by `gatherLabelContext` via `resolved.hooksById`) but store them raw. Replace the tail of `loadLabelContext`:

```js
  const labelsById = {};
  for (const l of labels || []) labelsById[String(l.id)] = { id: String(l.id), name: l.name, color: l.color, url: l.url };
  const labelRules = extractLabelRules(rules || []);
  const hooksById = {};
  for (const hk of (hooks || [])) hooksById[hk.id] = hk;
  const cur = store.data.value;
  if (!cur) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, labelsById, labelRules, hooksById: { ...cur.resolved.hooksById, ...hooksById }, _hooksLoaded: true } };
```

(This makes queue hooks available to `gatherLabelContext` and removes the `labelHooks`/`extractLabelHooks` dependency.)

- [ ] **Step 3: grep for dangling references** — `grep -rn "extensionAttribution\|rankRejectCandidates\|extractLabelHooks\|detectRejectCapability\|labelExtensionCandidates\|LABEL_APPLY_SIG\|hookReferencesLabelName\|labelIdsInBlob\|\.labelHooks" src/inspector/` must return **zero** hits. Fix any straggler.

- [ ] **Step 4: add CSS** — in `src/console/console.css` add (near other `.inspector-*` rules):

```css
.inspector-ai-attr { margin-top: 14px; }
.inspector-ai-attr .t { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.inspector-ai-verdict { margin-top: 6px; }
.inspector-ai-verdict-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.inspector-rb-high { color: var(--success); }
.inspector-rb-medium { color: var(--warning); }
.inspector-rb-low { color: var(--text-secondary); }
```

(Grep `console.css` first for the exact existing `--success`/`--warning`/`--text-secondary` variable names and match them; substitute the closest if a name differs.)

- [ ] **Step 5: trim retired-helper tests** — find `tests/inspector-*.test.js` importing any retired symbol (`grep -rn "extensionAttribution\|rankRejectCandidates\|extractLabelHooks\|detectRejectCapability\|labelExtensionCandidates" tests/`) and delete those specific `describe`/`it` blocks (or the file if wholly about them). Keep tests for kept `culprit.js` functions.

- [ ] **Step 6: full verification** — run:
  - `npx vitest run` → full suite green.
  - `npm run build` → succeeds (catches any dangling import / cross-module path issue, incl. the `../../mdh/agent/*` imports from inspector components).

---

## Self-Review

**Spec coverage:** §4 scope (Labels applied-non-rule + Rejected hook-case) → Tasks 6, 7; agent replaces regex → Tasks 1–3, 8; auto-on-open → Tasks 6, 7 effects; verdict `{culprit,confidence,explanation}` → Tasks 1, 2; confidence surfaced → Task 5; read-only persona → Task 2 (`/persona cautious`) + prompt (Task 1); no-fallback/unavailable → Tasks 6, 7 (`aiAvailable` gate); seeded evidence + `getHook` → Task 3; retire regex → Task 8; aiAvailable probe → Task 4. All covered.

**Placeholder scan:** every code step has complete code; the only "grep first / substitute closest" note (Task 8 CSS) is a concrete instruction with the grep. No TBD/TODO.

**Type consistency:** `runAttribution({agentApi,kind,context,onPhase?,signal?}) → {verdict}` and `verdict={culprit,confidence,explanation}` identical across Tasks 1,2,6,7. `gatherRejectContext`/`gatherLabelContext({api,store,...}) → {annotation,target,candidates,logs,fields}` identical across Tasks 3,6,7. `store.setAttribution(key,val)` + keys `'reject'`/`label:<id>` consistent across Tasks 4,6,7. `ReliabilityBadge level` accepts confidence in Task 5, consumed in Tasks 6,7. Consistent.
