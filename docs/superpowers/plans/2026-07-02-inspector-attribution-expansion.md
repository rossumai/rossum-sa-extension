# Inspector attribution expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the Inspector's remaining attribution gaps (unattributed messages, non-standard blockers, ambiguous export failures, connector/rules field provenance) with a programmatic-first cascade — deterministic correlation when reliable, AI only for the residual — and prefetch all attributions on annotation load so panels are pure, instantly-rendered views.

**Architecture:** New pure `correlate.js` (request_id→hook-log and rule-log correlation) + new `orchestrate.js` (compute findings on load, run programmatic attributions synchronously, launch AI in the background, abortable per annotation). `agentAttribute.js`/`attributionContext.js` gain new `kind`s + a batched field path. Panels (`BlockedPanel`, `ExportPanel`, `ProvenancePanel`, and — de-launched — `RejectedPanel`/`LabelsPanel`) become pure renderers of `store.attributions`.

**Tech Stack:** Preact + @preact/signals, esbuild (jsxFactory `h`), Vitest + jsdom. Reuses the shipped agent transport (`../mdh/agent/agentApi.js`, `agentStream.js`) and `runAttribution`/`onPhase` live progress.

## Global Constraints

- **READ-ONLY is paramount.** No new code may write, patch, create, delete, or mutate anything in the customer org, and must never touch the `revalidate` flow. Only reads: already-loaded `store.data`/`enrichment`, plus `api.getHook`/`listHooks`/`listRules`/`listHookLogs`/`listRuleExecutionLogs`. AI stays `/persona cautious` + read-only prompt framing.
- **Programmatic-first, AI last.** Verified/best-effort programmatic attribution (self-declared `detail` ids; `request_id`→hook-log; rule-exec-log correlation) runs before any agent call. Verified paths already in the code (standard blockers, self-attributed messages, workflow/manual rejection, rule labels, in-log export, named provenance) stay untouched and never call the agent.
- **Reliability tiers** use the existing `REL` from `culprit.js`: `REL.VERIFIED`, `REL.BEST_EFFORT`, `REL.UNAVAILABLE`. AI verdicts use `confidence: 'high'|'medium'|'low'` rendered by `ReliabilityBadge`.
- **`request_id` cardinality (ship-gate):** message→hook correlation is labelled `REL.VERIFIED` on the assumption a hook-log `request_id`/`uuid` is per-invocation. The controller confirms this against real data during implementation; if it is per-run-shared, downgrade `correlateMessage`'s hook match to `REL.BEST_EFFORT`. The cascade is safe either way.
- **No git commits / no branches.** Work stays uncommitted on `master` (owner constraint). Each task's "verify" = run its tests + `npm run build`; there is no commit step.
- **`store.attributions` is a generic map** (`setAttribution(key, val)`), reset per annotation — no store change is needed; new keys just reuse it. Entry shape: `{ status:'loading'|'done'|'error', verdict?, phase?, error?, source?:'programmatic'|'ai' }`.
- **Test convention:** `.test.js`, render via `import { h, render } from 'preact'` into a manual div, `vi.mock` collaborators, poll-based `waitFor` (no fixed-timeout flush). Node-only modules test without jsdom.

---

### Task 1: `correlate.js` — programmatic correlation (pure)

**Files:**
- Create: `src/inspector/correlate.js`
- Test: `tests/inspector-correlate.test.js`

**Interfaces:**
- Consumes: `REL` from `./culprit.js`.
- Produces: `correlateMessage(msg, { hookLogs, ruleLogs, hooksById }) → { culprit:{kind,id,name}, reliability } | null`; `correlateField(schemaId, { ruleLogs, rules }) → { culprit, reliability } | null`. `msg` is a `classifyMessage` result (has `.requestId`). Used by Task 4.

- [ ] **Step 1: Write the failing test** — `tests/inspector-correlate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { correlateMessage, correlateField } from '../src/inspector/correlate.js';
import { REL } from '../src/inspector/culprit.js';

describe('correlateMessage', () => {
  const hooksById = { 50: { id: 50, name: 'Rejector' } };
  it('ties a message to a hook by request_id (VERIFIED)', () => {
    const msg = { requestId: 'r1', culprit: null };
    const out = correlateMessage(msg, { hookLogs: [{ hook_id: 50, request_id: 'r1' }], ruleLogs: [], hooksById });
    expect(out).toEqual({ culprit: { kind: 'hook', id: 50, name: 'Rejector' }, reliability: REL.VERIFIED });
  });
  it('matches on the log uuid when request_id differs', () => {
    const out = correlateMessage({ requestId: 'u9' }, { hookLogs: [{ hook_id: 50, uuid: 'u9' }], ruleLogs: [], hooksById });
    expect(out.culprit.id).toBe(50);
  });
  it('falls back to a rule log (BEST_EFFORT) when no hook log matches', () => {
    const out = correlateMessage({ requestId: 'r2' }, { hookLogs: [], ruleLogs: [{ rule_id: 7, rule_name: 'Tag', request_id: 'r2' }], hooksById });
    expect(out).toEqual({ culprit: { kind: 'rule', id: 7, name: 'Tag' }, reliability: REL.BEST_EFFORT });
  });
  it('returns null with no request_id or no match', () => {
    expect(correlateMessage({ requestId: null }, { hookLogs: [], ruleLogs: [], hooksById })).toBeNull();
    expect(correlateMessage({ requestId: 'x' }, { hookLogs: [{ hook_id: 1, request_id: 'y' }], ruleLogs: [], hooksById })).toBeNull();
  });
});

describe('correlateField', () => {
  const rules = [{ id: 7, name: 'Set terms', actions: [{ payload: { schema_id: 'terms' } }] }];
  it('ties a rules-sourced field to a fired rule that targets it (BEST_EFFORT)', () => {
    const out = correlateField('terms', { ruleLogs: [{ rule_id: 7, execution_result: 'success' }], rules });
    expect(out).toEqual({ culprit: { kind: 'rule', id: 7, name: 'Set terms' }, reliability: REL.BEST_EFFORT });
  });
  it('ignores a rule that did not fire, or does not target the field', () => {
    expect(correlateField('terms', { ruleLogs: [{ rule_id: 7, execution_result: 'skipped' }], rules })).toBeNull();
    expect(correlateField('other', { ruleLogs: [{ rule_id: 7, execution_result: 'success' }], rules })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run tests/inspector-correlate.test.js`) — module not found.

- [ ] **Step 3: Implement** — `src/inspector/correlate.js`:

```js
// Programmatic (deterministic / near-deterministic) attribution over already-loaded
// data — the "reliable" tier that runs before any AI fallback. Pure: no DOM, no network.
import { REL } from './culprit.js';

// An unattributed message (classifyMessage result, culprit === null): tie it to the
// hook/rule that produced it via the shared request_id. Hook match preferred (a hook
// log's request_id/uuid identifies its invocation); rule match is best-effort.
export function correlateMessage(msg, { hookLogs = [], ruleLogs = [], hooksById = {} } = {}) {
  const rid = msg && msg.requestId;
  if (!rid) return null;
  const log = (hookLogs || []).find((l) => l && (l.request_id === rid || l.uuid === rid));
  if (log && log.hook_id != null) {
    const h = hooksById[log.hook_id];
    return { culprit: { kind: 'hook', id: log.hook_id, name: (h && h.name) || `hook ${log.hook_id}` }, reliability: REL.VERIFIED };
  }
  const rl = (ruleLogs || []).find((l) => l && l.request_id === rid);
  if (rl && rl.rule_id != null) {
    return { culprit: { kind: 'rule', id: rl.rule_id, name: rl.rule_name || `rule ${rl.rule_id}` }, reliability: REL.BEST_EFFORT };
  }
  return null;
}

// schema_ids a rule's actions write/target (payload.schema_id + payload.schema_ids[]).
function ruleActionTargets(rule) {
  const ids = new Set();
  for (const a of (rule && rule.actions) || []) {
    const p = a && a.payload;
    if (!p) continue;
    if (typeof p.schema_id === 'string') ids.add(p.schema_id);
    for (const s of Array.isArray(p.schema_ids) ? p.schema_ids : []) if (typeof s === 'string') ids.add(s);
  }
  return [...ids];
}

// A field whose primary source is 'rules': find a rule that fired (success) on this
// annotation whose action targets this schema_id. Best-effort (the rule could-have).
export function correlateField(schemaId, { ruleLogs = [], rules = [] } = {}) {
  if (!schemaId) return null;
  const fired = new Set(
    (ruleLogs || [])
      .filter((l) => l && (l.execution_result === 'success' || l.execution_result === 'partial_success'))
      .map((l) => l.rule_id),
  );
  for (const r of rules || []) {
    if (!fired.has(r.id)) continue;
    if (ruleActionTargets(r).includes(schemaId)) {
      return { culprit: { kind: 'rule', id: r.id, name: r.name || `rule ${r.id}` }, reliability: REL.BEST_EFFORT };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests — expect PASS.** Then `npx vitest run tests/inspector-correlate.test.js` green.

- [ ] **Step 5: No commit** (owner constraint — leave uncommitted).

---

### Task 2: `agentAttribute.js` — new AI kinds + batched field attribution

**Files:**
- Modify: `src/inspector/agentAttribute.js`
- Test: `tests/inspector-agent-attribute.test.js` (extend)

**Interfaces:**
- Consumes: existing `newAcc`/`foldEvents`/`replyText` (already imported), existing `firstJsonObject`/`parseAttribution`/`runAttribution`.
- Produces: `buildAttributionPrompt` handles `kind` `'message'`/`'blocker'`/`'export'` (in addition to `'label'`/`'reject'`); new `buildFieldBatchPrompt(fields, ctx)`, `parseFieldBatch(text) → { fields:[{schema_id,culprit,confidence,explanation}] }`, `runFieldBatchAttribution({ agentApi, items, context, onPhase, signal }) → { verdicts:[…] }`. Used by Task 4.

- [ ] **Step 1: Write the failing tests** — append to `tests/inspector-agent-attribute.test.js`:

```js
import { buildAttributionPrompt as _bap, parseFieldBatch, buildFieldBatchPrompt, runFieldBatchAttribution } from '../src/inspector/agentAttribute.js';

describe('buildAttributionPrompt new kinds', () => {
  it('frames a message question read-only + JSON-only', () => {
    const p = _bap({ kind: 'message', annotation: { id: 1, status: 'to_review' }, target: { level: 'error', content: 'Total mismatch', schemaId: 'amount_due' }, candidates: [], logs: [], fields: null });
    expect(p).toMatch(/READ-ONLY/);
    expect(p).toMatch(/message/i);
    expect(p).toMatch(/Total mismatch/);
    expect(p).toMatch(/ONLY this JSON object/);
  });
  it('frames a blocker explanation and an export question', () => {
    expect(_bap({ kind: 'blocker', target: { type: 'custom_x', schemaId: 'iban' }, candidates: [], logs: [] })).toMatch(/custom_x/);
    expect(_bap({ kind: 'export', target: { error: 'HTTP 500' }, candidates: [], logs: [] })).toMatch(/HTTP 500/);
  });
});

describe('parseFieldBatch', () => {
  it('parses a fields array; unknown culprit → null; bad confidence → low', () => {
    const out = parseFieldBatch('{"fields":[{"schema_id":"terms","culprit":{"kind":"rule","id":7,"name":"R"},"confidence":"high","explanation":"e"},{"schema_id":"iban","culprit":{"kind":"unknown"},"confidence":"bogus","explanation":"x"}]}');
    expect(out.fields[0]).toEqual({ schema_id: 'terms', culprit: { kind: 'rule', id: 7, name: 'R' }, confidence: 'high', explanation: 'e' });
    expect(out.fields[1]).toEqual({ schema_id: 'iban', culprit: null, confidence: 'low', explanation: 'x' });
  });
  it('returns {fields:[]} on unparseable', () => {
    expect(parseFieldBatch('nope')).toEqual({ fields: [] });
  });
});

describe('runFieldBatchAttribution', () => {
  it('returns a verdict per field from the agent reply', async () => {
    const agentApi = {
      createChat: async () => 'c1',
      streamMessage: async (_id, content, { onEvent }) => {
        if (content === '/persona cautious') return;
        onEvent({ type: 'text-delta', delta: '{"fields":[{"schema_id":"terms","culprit":{"kind":"rule","id":7,"name":"R"},"confidence":"medium","explanation":"e"}]}' });
        onEvent({ type: 'finish' });
      },
    };
    const { verdicts } = await runFieldBatchAttribution({ agentApi, items: [{ schemaId: 'terms', value: '2/10' }], context: { annotation: {}, candidates: [], logs: [], fields: {} } });
    expect(verdicts).toEqual([{ schema_id: 'terms', culprit: { kind: 'rule', id: 7, name: 'R' }, confidence: 'medium', explanation: 'e' }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`parseFieldBatch` etc. not exported).

- [ ] **Step 3: Implement** — in `src/inspector/agentAttribute.js`, extend `buildAttributionPrompt`'s kind branch (replace the `if (kind === 'label') … else …` block) and append the batch functions. The new kind branch:

```js
  if (kind === 'label') {
    parts.push(`Question: which extension applied the label "${target.name}" (id ${target.id}) to this annotation, and why?`);
  } else if (kind === 'message') {
    parts.push(`Question: which extension produced this ${target.level || ''} message, and why?`);
    parts.push(`Message text: ${JSON.stringify(target.content || '')}${target.schemaId ? ` (on field ${target.schemaId})` : ''}.`);
  } else if (kind === 'blocker') {
    parts.push(`Question: explain this automation blocker — type "${target.type}"${target.schemaId ? ` on field ${target.schemaId}` : ''}. What does it mean, and what most likely caused it? If a specific extension is responsible, name it; otherwise use kind "unknown".`);
  } else if (kind === 'export') {
    parts.push(`Question: which export extension failed for this annotation, and why?${target.error ? ` Recorded error: ${JSON.stringify(target.error)}.` : ''} Explain the failure in plain language.`);
  } else {
    parts.push(`Question: which extension rejected this annotation${target.rejectedAt ? ` (rejected at ${target.rejectedAt})` : ''}, and why?`);
    if (target.reason) parts.push(`Recorded rejection reason: ${target.reason}`);
  }
```

Append (after `runAttribution`):

```js
// Batched field-provenance attribution: one call for many ambiguous fields.
export function buildFieldBatchPrompt(fields = [], { annotation = {}, candidates = [], logs = [] } = {}) {
  const parts = [
    'You are investigating a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything and never call any write / reject / revalidate action — only read and reason.',
    `Annotation: id ${annotation.id}, status ${annotation.status}.`,
    'For each field below, determine which extension, rule, or connector wrote its value (reason about the candidate extensions\' ACTUAL code/settings/logs). If it cannot be determined, use kind "unknown".',
    `Fields:\n${fields.map((f) => `- ${f.schemaId} = ${JSON.stringify(f.value ?? null)}`).join('\n')}`,
  ];
  parts.push('Candidate extensions on this queue:');
  for (const c of candidates) {
    parts.push(`- hook #${c.id} "${c.name}" [type=${c.type}; events=${(c.events || []).join(',')}]\n  settings: ${trunc(JSON.stringify(c.settings ?? {}), 600)}\n  code: ${c.code ? trunc(c.code, 1500) : '(no readable code — webhook/opaque)'}`);
  }
  if (logs.length) parts.push(`Relevant hook logs:\n${logs.map((l) => `- hook ${l.hook ?? l.hook_id ?? '?'} action=${l.action} level=${l.log_level}`).join('\n')}`);
  parts.push('Respond with ONLY this JSON object and nothing else: {"fields":[{"schema_id":"<id>","culprit":{"kind":"hook|webhook|rule|connector|manual|unknown","id":<number|null>,"name":"<name>"},"confidence":"high|medium|low","explanation":"<one short sentence>"}]}');
  return parts.join('\n\n');
}

function normalizeVerdictObject(o) {
  const c = o && o.culprit;
  const culprit = c && c.kind && c.kind !== 'unknown'
    ? { kind: String(c.kind), id: c.id == null ? null : c.id, name: String(c.name || '') }
    : null;
  const confidence = ['high', 'medium', 'low'].includes(o && o.confidence) ? o.confidence : 'low';
  return { culprit, confidence, explanation: typeof (o && o.explanation) === 'string' ? o.explanation : '' };
}

export function parseFieldBatch(text) {
  if (typeof text !== 'string') return { fields: [] };
  const jsonText = firstJsonObject(text);
  if (!jsonText) return { fields: [] };
  try {
    const o = JSON.parse(jsonText);
    const arr = Array.isArray(o.fields) ? o.fields : [];
    return { fields: arr.filter((f) => f && f.schema_id).map((f) => ({ schema_id: String(f.schema_id), ...normalizeVerdictObject(f) })) };
  } catch { return { fields: [] }; }
}

export async function runFieldBatchAttribution({ agentApi, items, context, onPhase = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  let lastStatus = 'thinking';
  await agentApi.streamMessage(chatId, buildFieldBatchPrompt(items, context), {
    signal,
    onEvent: (ev) => { foldEvents(acc, [ev]); if (acc.status && acc.status !== lastStatus) { lastStatus = acc.status; onPhase(acc.status); } },
  });
  return { verdicts: parseFieldBatch(replyText(acc)).fields };
}
```

Note: `normalizeVerdictObject` centralizes the culprit/confidence normalization; leave the existing `parseAttribution` as-is (it already does this inline — do NOT refactor it in this task).

- [ ] **Step 4: Run tests — expect PASS** (`npx vitest run tests/inspector-agent-attribute.test.js`). Then `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 3: `attributionContext.js` — gatherers for the new kinds

**Files:**
- Modify: `src/inspector/attributionContext.js`
- Test: `tests/inspector-attribution-context.test.js` (extend)

**Interfaces:**
- Consumes: existing `activeQueueHooksWithCode`, `baseContext`, `compactFields`.
- Produces: `gatherMessageContext({ api, store, message })`, `gatherBlockerContext({ api, store, blocker })`, `gatherExportContext({ api, store, error })`, `gatherFieldsContext({ api, store })` — each returns `{ annotation, target, candidates, logs, fields }` (fields-batch returns `target` unused; items are passed separately by the orchestrator). All wrapped in try/catch → safe empty context. Used by Task 4.

- [ ] **Step 1: Write the failing tests** — append to `tests/inspector-attribution-context.test.js`:

```js
import { gatherMessageContext, gatherBlockerContext, gatherExportContext, gatherFieldsContext } from '../src/inspector/attributionContext.js';

const store = { data: { value: { annotation: { id: 9, status: 'to_review', queue: 'https://h/api/v1/queues/3' }, content: { content: [] }, resolved: { hooksById: { 5: { id: 5, name: 'H', type: 'function', events: [], code: 'x' } } } } }, enrichment: { value: { hookLogs: [] } } };
const api = { listHooks: async () => [], getHook: async () => null };

describe('new gatherers', () => {
  it('gatherMessageContext carries the message target + candidates', async () => {
    const ctx = await gatherMessageContext({ api, store, message: { level: 'error', content: 'x', schemaId: 'iban' } });
    expect(ctx.target).toEqual({ level: 'error', content: 'x', schemaId: 'iban' });
    expect(ctx.candidates[0].id).toBe(5);
  });
  it('gatherBlockerContext + gatherExportContext carry their targets', async () => {
    expect((await gatherBlockerContext({ api, store, blocker: { type: 't', schemaId: 'f' } })).target).toEqual({ type: 't', schemaId: 'f' });
    expect((await gatherExportContext({ api, store, error: 'E' })).target).toEqual({ error: 'E' });
  });
  it('gatherFieldsContext returns candidates + never throws on a broken store', async () => {
    const ctx = await gatherFieldsContext({ api, store });
    expect(Array.isArray(ctx.candidates)).toBe(true);
    const bad = await gatherFieldsContext({ api, store: { data: { value: null }, enrichment: { value: {} } } });
    expect(bad.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — append to `src/inspector/attributionContext.js`:

```js
export async function gatherMessageContext({ api, store, message }) {
  try {
    const { d, logs, fields } = baseContext(store);
    const candidates = d ? await activeQueueHooksWithCode(api, d) : [];
    return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, target: message, candidates, logs, fields };
  } catch { return { annotation: {}, target: message, candidates: [], logs: [], fields: {} }; }
}

export async function gatherBlockerContext({ api, store, blocker }) {
  try {
    const { d, logs, fields } = baseContext(store);
    const candidates = d ? await activeQueueHooksWithCode(api, d) : [];
    return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, target: blocker, candidates, logs, fields };
  } catch { return { annotation: {}, target: blocker, candidates: [], logs: [], fields: {} }; }
}

export async function gatherExportContext({ api, store, error = null }) {
  try {
    const { d, logs, fields } = baseContext(store);
    const all = d ? await activeQueueHooksWithCode(api, d) : [];
    const candidates = all.filter((h) => (h.events || []).some((e) => String(e).startsWith('annotation_content.export')));
    return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, target: { error }, candidates: candidates.length ? candidates : all, logs, fields };
  } catch { return { annotation: {}, target: { error }, candidates: [], logs: [], fields: {} }; }
}

export async function gatherFieldsContext({ api, store }) {
  try {
    const { d, logs, fields } = baseContext(store);
    const candidates = d ? await activeQueueHooksWithCode(api, d) : [];
    return { annotation: { id: d?.annotation?.id, status: d?.annotation?.status }, candidates, logs, fields };
  } catch { return { annotation: {}, candidates: [], logs: [], fields: {} }; }
}
```

- [ ] **Step 4: Run tests — expect PASS.** Then `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 4: `orchestrate.js` — findings + load-time attribution driver

**Files:**
- Create: `src/inspector/orchestrate.js`
- Test: `tests/inspector-orchestrate.test.js`

**Interfaces:**
- Consumes: `classifyMessage`/`explainBlocker`/`classifyRejection`/`fieldProvenance`/`labelAttribution`/`matchConfigsForField`/`exportHookCandidates` from `./culprit.js`; `correlateMessage`/`correlateField` from `./correlate.js`; `runAttribution`/`runFieldBatchAttribution` from `./agentAttribute.js`; `gather*Context` from `./attributionContext.js`; `store`.
- Produces: key helpers `messageKey(i)`, `blockerKey(i)`, `fieldKey(id)`, and constants `reject`/`label:<id>`/`export` (label reuses `label:${id}`); `computeFindings(store) → [{ key, kind, payload }]`; `orchestrateAttributions({ store, api, agentApi, signal }) → Promise<void>`. Used by Task 5. The panels import the key helpers to read the right `store.attributions` entry.

- [ ] **Step 1: Write the failing test** — `tests/inspector-orchestrate.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messageKey, blockerKey, fieldKey, computeFindings } from '../src/inspector/orchestrate.js';

function storeWith(data, enrichment = {}) {
  return { data: { value: data }, enrichment: { value: { hookLogs: [], ruleLogs: [], notes: [], workflow: [], ...enrichment } }, aiAvailable: { value: true }, attributions: { value: {} }, annotationId: { value: String(data?.annotation?.id) }, setAttribution() {} };
}

describe('key helpers', () => {
  it('are stable strings', () => {
    expect(messageKey(2)).toBe('message:2');
    expect(blockerKey(0)).toBe('blocker:0');
    expect(fieldKey('iban')).toBe('field:iban');
  });
});

describe('computeFindings', () => {
  it('finds an unattributed message but not a self-attributed one', () => {
    const store = storeWith({
      annotation: { id: 1, status: 'to_review', messages: [
        { type: 'error', content: 'A', detail: { hook_id: 5 } },   // self-attributed → skip
        { type: 'error', content: 'B', detail: { request_id: 'r1' } }, // unattributed → finding
      ], labels: [] },
      blocker: { content: [] }, content: { content: [] }, resolved: { queue: null, hooksById: {}, labelsById: undefined },
    });
    const f = computeFindings(store);
    const msgs = f.filter((x) => x.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].key).toBe(messageKey(1));
  });
  it('finds a non-standard blocker but not low_score/automation_disabled/error_message', () => {
    const store = storeWith({ annotation: { id: 1, status: 'to_review', messages: [], labels: [] }, blocker: { content: [
      { type: 'low_score', samples: [{ details: { score: 0.1, threshold: 0.9 } }] },
      { type: 'weird_custom_blocker' },
    ] }, content: { content: [] }, resolved: { queue: null, hooksById: {}, labelsById: undefined } });
    const b = computeFindings(store).filter((x) => x.kind === 'blocker');
    expect(b).toHaveLength(1);
    expect(b[0].payload.type).toBe('weird_custom_blocker');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `src/inspector/orchestrate.js`:

```js
import * as store from './store.js';
import { classifyMessage, explainBlocker, classifyRejection, fieldProvenance, labelAttribution, matchConfigsForField, exportHookCandidates, REL } from './culprit.js';
import { correlateMessage, correlateField } from './correlate.js';
import { runAttribution, runFieldBatchAttribution } from './agentAttribute.js';
import { gatherMessageContext, gatherBlockerContext, gatherExportContext, gatherFieldsContext, gatherRejectContext, gatherLabelContext } from './attributionContext.js';

const idFromUrl = (url) => { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; };
export const messageKey = (i) => `message:${i}`;
export const blockerKey = (i) => `blocker:${i}`;
export const fieldKey = (schemaId) => `field:${schemaId}`;
export const labelKey = (id) => `label:${id}`;
const STD_BLOCKERS = new Set(['low_score', 'automation_disabled', 'error_message']);

function walkDatapoints(nodes, out) {
  for (const n of nodes || []) { if (n.category === 'datapoint') out.push(n); if (n.children) walkDatapoints(n.children, out); }
  return out;
}

// Enumerate everything on the annotation that needs attribution and has no verified
// self-declared cause. Pure over store.data/enrichment.
export function computeFindings(s) {
  const d = s.data.value;
  if (!d) return [];
  const a = d.annotation || {};
  const findings = [];

  // messages with no self-declared rule_id/hook_id
  (a.messages || []).forEach((raw, i) => {
    const m = classifyMessage(raw);
    if (!m.culprit) findings.push({ key: messageKey(i), kind: 'message', payload: { index: i, level: m.level, content: m.content, schemaId: m.datapointId ? null : null, requestId: m.requestId } });
  });

  // non-standard blockers (not the three verified types, and no det-name attribution)
  (d.blocker?.content || []).forEach((raw, i) => {
    const b = explainBlocker(raw, { queue: d.resolved?.queue });
    if (!STD_BLOCKERS.has(b.type) && !b.culprit) findings.push({ key: blockerKey(i), kind: 'blocker', payload: { index: i, type: b.type, schemaId: b.schemaId } });
  });

  // export: failed, and the failing hook can't be named from logs
  const failed = a.status === 'failed_export' || !!a.export_failed_at;
  if (failed) {
    const hooks = Object.values(d.resolved?.hooksById || {});
    const logs = Array.isArray(s.enrichment.value.hookLogs) ? s.enrichment.value.hookLogs : [];
    const { failing, candidates } = exportHookCandidates(hooks, logs);
    if (!failing && candidates.length !== 1) findings.push({ key: 'export', kind: 'export', payload: { error: null } });
  }

  // fields whose source is rules/connector, or data_matching with no config naming it
  const hooks = Object.values(d.resolved?.hooksById || {});
  for (const dp of walkDatapoints(d.content?.content || [], [])) {
    const p = fieldProvenance(dp);
    if (!p.schemaId) continue;
    const ambiguous = p.primary === 'rules' || p.primary === 'connector' || (p.primary === 'data_matching' && matchConfigsForField(p.schemaId, hooks).length === 0);
    if (ambiguous) findings.push({ key: fieldKey(p.schemaId), kind: 'field', payload: { schemaId: p.schemaId, value: p.value, primary: p.primary } });
  }

  // existing AI findings (hoisted from the panels): hook rejection + applied non-rule labels
  const rej = classifyRejection({ annotation: a, workflowActivities: s.enrichment.value.workflow || [], notes: s.enrichment.value.notes || [], usersById: d.resolved?.usersById || {} });
  if (rej.type === 'hook') findings.push({ key: 'reject', kind: 'reject', payload: { reason: rej.reason?.text || null } });
  if (d.resolved?.labelsById !== undefined) {
    const { applied } = labelAttribution({ annotation: a, labelsById: d.resolved.labelsById, labelRules: d.resolved.labelRules || [] });
    for (const l of applied) if (!l.rule) findings.push({ key: labelKey(l.id), kind: 'label', payload: { id: l.id, name: l.name } });
  }
  return findings;
}

// Launch attribution for every finding: programmatic first (synchronous, free), AI in
// the background only for the residual. Guarded once-per-key; abortable per annotation.
export async function orchestrateAttributions({ store: s = store, api, agentApi, signal } = {}) {
  const d = s.data.value;
  if (!d) return;
  const findings = computeFindings(s);
  const enr = s.enrichment.value || {};
  const hookLogs = Array.isArray(enr.hookLogs) ? enr.hookLogs : [];
  const ruleLogs = Array.isArray(enr.ruleLogs) ? enr.ruleLogs : [];
  const rules = d.resolved?.rules || [];
  const hooksById = d.resolved?.hooksById || {};
  const aborted = () => signal && signal.aborted;
  const setDone = (key, verdict, reliability) => { if (!aborted()) s.setAttribution(key, { status: 'done', verdict, reliability, source: 'programmatic' }); };
  const ai = [];
  const fieldItems = [];

  for (const f of findings) {
    if (s.attributions.value[f.key]) continue; // once per key per annotation
    if (f.kind === 'message') {
      const msg = classifyMessage((d.annotation.messages || [])[f.payload.index]);
      const c = correlateMessage(msg, { hookLogs, ruleLogs, hooksById });
      if (c) { setDone(f.key, { culprit: c.culprit, confidence: null, explanation: '' }, c.reliability); continue; }
      ai.push({ key: f.key, run: (onPhase) => gatherMessageContext({ api, store: s, message: f.payload }).then((context) => runAttribution({ agentApi, kind: 'message', context, onPhase, signal })) });
    } else if (f.kind === 'field') {
      const c = correlateField(f.payload.schemaId, { ruleLogs, rules });
      if (c) { setDone(f.key, { culprit: c.culprit, confidence: null, explanation: '' }, c.reliability); continue; }
      fieldItems.push({ key: f.key, schemaId: f.payload.schemaId, value: f.payload.value });
    } else if (f.kind === 'blocker') {
      ai.push({ key: f.key, run: (onPhase) => gatherBlockerContext({ api, store: s, blocker: f.payload }).then((context) => runAttribution({ agentApi, kind: 'blocker', context, onPhase, signal })) });
    } else if (f.kind === 'export') {
      ai.push({ key: f.key, run: (onPhase) => gatherExportContext({ api, store: s, error: f.payload.error }).then((context) => runAttribution({ agentApi, kind: 'export', context, onPhase, signal })) });
    } else if (f.kind === 'reject') {
      ai.push({ key: f.key, run: (onPhase) => gatherRejectContext({ api, store: s, reason: f.payload.reason }).then((context) => runAttribution({ agentApi, kind: 'reject', context, onPhase, signal })) });
    } else if (f.kind === 'label') {
      ai.push({ key: f.key, run: (onPhase) => gatherLabelContext({ api, store: s, labelId: f.payload.id, labelName: f.payload.name }).then((context) => runAttribution({ agentApi, kind: 'label', context, onPhase, signal })) });
    }
  }

  if (!s.aiAvailable.value) return; // no fallback — leave residual findings unattributed

  // Per-finding AI (background).
  for (const item of ai) {
    if (s.attributions.value[item.key]) continue;
    s.setAttribution(item.key, { status: 'loading', phase: 'thinking', source: 'ai' });
    const onPhase = (phase) => { if (aborted()) return; const cur = s.attributions.value[item.key]; if (cur && cur.status === 'loading' && cur.phase !== phase) s.setAttribution(item.key, { status: 'loading', phase, source: 'ai' }); };
    item.run(onPhase)
      .then(({ verdict }) => { if (!aborted()) s.setAttribution(item.key, { status: 'done', verdict, source: 'ai' }); })
      .catch((e) => { if (!aborted() && e?.name !== 'AbortError') s.setAttribution(item.key, { status: 'error', error: e?.message || 'failed', source: 'ai' }); });
  }

  // Batched field AI (one call for all residual fields).
  if (fieldItems.length) {
    for (const it of fieldItems) s.setAttribution(it.key, { status: 'loading', phase: 'thinking', source: 'ai' });
    const onPhase = (phase) => { if (aborted()) return; for (const it of fieldItems) { const cur = s.attributions.value[it.key]; if (cur && cur.status === 'loading' && cur.phase !== phase) s.setAttribution(it.key, { status: 'loading', phase, source: 'ai' }); } };
    gatherFieldsContext({ api, store: s })
      .then((context) => runFieldBatchAttribution({ agentApi, items: fieldItems, context, onPhase, signal }))
      .then(({ verdicts }) => {
        if (aborted()) return;
        const byId = new Map(verdicts.map((v) => [v.schema_id, v]));
        for (const it of fieldItems) {
          const v = byId.get(it.schemaId);
          s.setAttribution(it.key, { status: 'done', verdict: v ? { culprit: v.culprit, confidence: v.confidence, explanation: v.explanation } : { culprit: null, confidence: 'low', explanation: '' }, source: 'ai' });
        }
      })
      .catch((e) => { if (!aborted() && e?.name !== 'AbortError') for (const it of fieldItems) s.setAttribution(it.key, { status: 'error', error: e?.message || 'failed', source: 'ai' }); });
  }
}
```

Note for the implementer: `computeFindings`'s message `schemaId` is left `null` (top-level vs field-scoped message text is enough for the agent; the datapoint-id→schema_id resolution is a possible later refinement). Keep it as written. `d.resolved.rules` may be undefined until Task 5 loads rules; `correlateField` tolerates `[]`.

- [ ] **Step 4: Run tests — expect PASS.** Then `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 5: `index.jsx` prefetch + orchestrator wiring; de-launch Rejected/Labels

**Files:**
- Modify: `src/inspector/index.jsx`, `src/inspector/components/RejectedPanel.jsx`, `src/inspector/components/LabelsPanel.jsx`
- Test: `tests/inspector-rejected-panel.test.js`, `tests/inspector-labels-panel.test.js` (adjust)

**Interfaces:**
- Consumes: `orchestrateAttributions` from `./orchestrate.js`.
- Produces: on annotation load, enrichment is prefetched and `orchestrateAttributions` runs (abortable per annotation). Rejected/Labels panels no longer self-launch attribution (they render `store.attributions` fed by the orchestrator).

- [ ] **Step 1: Adjust the panel tests first.** In `tests/inspector-rejected-panel.test.js` and `tests/inspector-labels-panel.test.js`, the panels no longer call `runAttribution` themselves — the orchestrator does. Update the "auto-runs / auto-attributes" tests to **pre-seed** `store.attributions` (as the orchestrator would) and assert the panel RENDERS it, rather than asserting `runAttribution` was called. Keep the unavailable-note tests. Concretely, replace each auto-run test body with: set `store.setAttribution('reject', { status:'done', verdict:{…} })` (or `label:<id>`) then render and assert the culprit/confidence/explanation appear; and update the live-phase test to pre-seed `{ status:'loading', phase:'reading extension logs' }`. Remove assertions on `runAttribution.mock.calls` and the abort/guard tests that exercised the panel effect (those behaviors now live in `orchestrate.js` / Task 4). Run them — expect FAIL against the current self-launching panels (they still call runAttribution, so the mock-not-called expectations differ) — this is the RED that Step 3 fixes.

- [ ] **Step 2: Confirm the failing state** (`npx vitest run tests/inspector-rejected-panel.test.js tests/inspector-labels-panel.test.js`).

- [ ] **Step 3a: Remove the self-launch effect** from `src/inspector/components/RejectedPanel.jsx` — delete the entire `useEffect(() => { … runAttribution … }, [rej.type, …])` block (lines that set `store.setAttribution('reject', …)` and call `runAttribution`) and the now-unused imports (`runAttribution`, `gatherRejectContext`, `loadQueueHooks`, `agentApi`, `api`). Keep the enrichment-load effect and everything that READS `store.attributions.value.reject` for rendering (the `attr?.status` branches incl. the live `phase`). Do the same in `LabelsPanel.jsx`'s `AiLabelAttribution`: delete its launching `useEffect` + unused imports; keep the component reading `store.attributions.value['label:'+label.id]` and rendering loading/verdict/unavailable.

- [ ] **Step 3b: Wire the orchestrator** in `src/inspector/index.jsx`. Add the import and prefetch+run on load. Replace the end of `loadAnnotation`'s success branch and add a helper:

```js
import { orchestrateAttributions } from './orchestrate.js';
// … existing imports …

let attrController = null;
async function prefetchAndOrchestrate() {
  if (attrController) attrController.abort();
  attrController = new AbortController();
  const signal = attrController.signal;
  // Prefetch all enrichment + queue hooks/labels/rules in parallel (all 403-tolerant).
  await Promise.all([
    loadEnrichment('workflow'), loadEnrichment('notes'), loadEnrichment('hookLogs'), loadEnrichment('ruleLogs'),
    loadQueueHooks(), loadLabelContext(), loadQueueRules(),
  ]);
  if (signal.aborted) return;
  await orchestrateAttributions({ store, api, agentApi, signal });
}
```

Add `loadQueueRules` (rules aren't otherwise on `resolved`):

```js
export async function loadQueueRules() {
  const d = store.data.value;
  if (!d || !d.annotation.queue || d.resolved._rulesLoaded) return;
  const rules = await safe(() => api.listRules(idFromUrl(d.annotation.queue))) || [];
  const cur = store.data.value; if (!cur) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, rules, _rulesLoaded: true } };
}
```

In `loadAnnotation`, after `store.data.value = { … }` and the `recordRecent(...)` call, kick it off (not awaited, guarded by the staleness check already above it):

```js
    prefetchAndOrchestrate();
```

Abort on annotation change: in `store.setAnnotationId`, the orchestrator's own `attrController.abort()` at the next `prefetchAndOrchestrate` handles supersession; also abort when navigating away — add to `loadAnnotation`'s start (`if (attrController) attrController.abort();`).

- [ ] **Step 4: Run the panel tests — expect PASS.** Then the full inspector suite + `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 6: `BlockedPanel.jsx` — render message + non-standard-blocker attributions

**Files:**
- Modify: `src/inspector/components/BlockedPanel.jsx`
- Test: `tests/inspector-blocked-panel.test.js` (new)

**Interfaces:**
- Consumes: `messageKey`/`blockerKey` from `../orchestrate.js`; `store.attributions`; `CulpritChip`/`ReliabilityBadge`.
- Produces: each message row and each non-standard blocker card shows its attribution — a self-declared culprit (verified), a programmatic verdict (culprit + verified/best-effort badge), or an AI verdict (culprit + confidence + explanation, live `phase` while loading).

- [ ] **Step 1: Write the failing test** — `tests/inspector-blocked-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import BlockedPanel from '../src/inspector/components/BlockedPanel.jsx';
import { messageKey } from '../src/inspector/orchestrate.js';
import * as store from '../src/inspector/store.js';

let root;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('BlockedPanel message attribution', () => {
  it('renders a self-attributed error message culprit (verified, no agent)', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'Bad', detail: { hook_id: 5, hook_name: 'H' } }] }, blocker: { content: [] }, resolved: { queue: null } };
    render(h(BlockedPanel, null), root);
    expect(root.textContent).toContain('Bad');
    expect(root.textContent).toContain('H');
  });
  it('renders an orchestrator-fed AI culprit + explanation for an unattributed message', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'Mystery', detail: { request_id: 'r1' } }] }, blocker: { content: [] }, resolved: { queue: null } };
    store.setAttribution(messageKey(0), { status: 'done', verdict: { culprit: { kind: 'hook', id: 9, name: 'Guesser' }, confidence: 'medium', explanation: 'emits this on total mismatch' }, source: 'ai' });
    render(h(BlockedPanel, null), root);
    expect(root.textContent).toContain('Guesser');
    expect(root.textContent).toContain('emits this on total mismatch');
  });
  it('shows the live phase while an unattributed message is being reasoned', () => {
    store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'M', detail: {} }] }, blocker: { content: [] }, resolved: { queue: null } };
    store.setAttribution(messageKey(0), { status: 'loading', phase: 'reading extension logs', source: 'ai' });
    render(h(BlockedPanel, null), root);
    expect(root.textContent).toContain('reading extension logs');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `BlockedPanel.jsx`, make `MsgRow` take the message's original index and render its attribution. Replace the messages mapping so each `classifyMessage` result keeps its original index, and `MsgRow` reads `store.attributions.value[messageKey(i)]`:

```jsx
import { messageKey, blockerKey } from '../orchestrate.js';
// … existing imports (add store already present) …

function AttrLine({ entry }) {
  if (!entry) return null;
  if (entry.status === 'loading') return <span class="inspector-label-why inspector-loading inspector-ai-phase">{entry.phase || 'thinking'}…</span>;
  if (entry.status === 'error') return <span class="inspector-label-why">AI attribution failed</span>;
  if (entry.status === 'done' && entry.verdict) {
    return (
      <span class="inspector-ai-verdict-inline">
        <CulpritChip culprit={entry.verdict.culprit} />
        {entry.source === 'programmatic'
          ? <ReliabilityBadge level={entry.reliability} />
          : <ReliabilityBadge level={entry.verdict.confidence} />}
        {entry.verdict.explanation ? <span class="inspector-why">{entry.verdict.explanation}</span> : null}
      </span>
    );
  }
  return null;
}

function MsgRow({ m, idx }) {
  const attr = store.attributions.value[messageKey(idx)];
  return (
    <div class="inspector-mrow">
      <span class={`inspector-lv inspector-lv-${m.level}`}>{m.level}</span>
      <div class="mc">
        <div class="inspector-mtxt">{m.content}</div>
        <div class="inspector-mrow2">
          {m.culprit ? <CulpritChip culprit={m.culprit} /> : <AttrLine entry={attr} />}
          {m.culprit ? <ReliabilityBadge level={m.reliability} /> : (!attr ? <ReliabilityBadge level="unavailable" /> : null)}
          {m.isException ? <span class="inspector-tag">is_exception</span> : null}
          {m.requestId ? <span class="inspector-tag">request_id {m.requestId.slice(0, 8)}</span> : null}
        </div>
      </div>
    </div>
  );
}
```

Change the messages mapping to keep original indices (so `errorMsgs`/`otherMsgs` carry `idx`):

```jsx
  const messages = (d.annotation.messages || []).map((raw, idx) => ({ ...classifyMessage(raw), idx }));
  const errorMsgs = messages.filter((m) => m.level === 'error');
  const otherMsgs = messages.filter((m) => m.level !== 'error');
  // … render: {errorMsgs.map((m) => <MsgRow m={m} idx={m.idx} />)} and same for otherMsgs …
```

For non-standard blockers, render an `<AttrLine entry={store.attributions.value[blockerKey(i)]} />` beneath the blocker card's explanation (map blockers WITH index; the standard ones simply won't have an attributions entry, so `AttrLine` renders nothing):

```jsx
  {(d.blocker?.content || []).map((raw, i) => { const b = explainBlocker(raw, ctx); return (
    <div class="inspector-bcard">
      <div class="ttl"><code>{b.type}</code>{b.schemaId ? <span> · {b.schemaId}</span> : null} <CulpritChip culprit={b.culprit} /> <ReliabilityBadge level={b.reliability} /></div>
      <div class="inspector-why">{b.explanation}</div>
      <AttrLine entry={store.attributions.value[blockerKey(i)]} />
    </div>
  ); })}
```

(Replace the existing `blockers`/`MsgRow` usage accordingly; keep the Re-evaluate strip + `live` note unchanged.)

- [ ] **Step 4: Run tests — expect PASS.** Then full inspector suite + `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 7: `ExportPanel.jsx` — render the ambiguous-export AI attribution

**Files:**
- Modify: `src/inspector/components/ExportPanel.jsx`
- Test: `tests/inspector-export-panel.test.js` (new)

**Interfaces:**
- Consumes: `store.attributions.value.export`; `CulpritChip`/`ReliabilityBadge`.
- Produces: when the failing hook can't be named from logs, the panel renders the `export` attribution (AI culprit + confidence + explanation, live phase) instead of only the "one of N…" text.

- [ ] **Step 1: Write the failing test** — `tests/inspector-export-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ExportPanel from '../src/inspector/components/ExportPanel.jsx';
import * as store from '../src/inspector/store.js';

let root;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('ExportPanel AI attribution', () => {
  it('renders the orchestrator-fed export culprit + explanation when the failing hook is ambiguous', () => {
    store.data.value = { annotation: { id: 1, status: 'failed_export', export_failed_at: 't' }, resolved: { hooksById: {} } };
    store.enrichment.value = { ...store.enrichment.value, hookLogs: [] };
    store.setAttribution('export', { status: 'done', verdict: { culprit: { kind: 'hook', id: 3, name: 'Exporter' }, confidence: 'medium', explanation: 'timed out posting to the ERP' }, source: 'ai' });
    render(h(ExportPanel, null), root);
    expect(root.textContent).toContain('Exporter');
    expect(root.textContent).toContain('timed out posting to the ERP');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `ExportPanel.jsx`, after the existing `inspector-kv` block, when `!failing && candidates.length !== 1`, render the `export` attribution:

```jsx
import CulpritChip from './CulpritChip.jsx';
// … existing imports (ReliabilityBadge already present) …

  const attr = store.attributions.value.export;
  // … inside the returned JSX, after </div> of inspector-kv, before closing inspector-panel: …
  {!failing && candidates.length !== 1 && attr && (
    <div class="inspector-ai-attr">
      <div class="t">Which export extension failed — reasoned by Mr. Fabry from the queue's export extensions + logs.</div>
      {attr.status === 'loading' && <div class="inspector-loading inspector-ai-phase">{attr.phase || 'thinking'}…</div>}
      {attr.status === 'error' && <div class="inspector-empty">AI attribution failed.</div>}
      {attr.status === 'done' && attr.verdict && (
        <div class="inspector-ai-verdict">
          <div class="ttl"><CulpritChip culprit={attr.verdict.culprit} /> <ReliabilityBadge level={attr.verdict.confidence} /></div>
          {attr.verdict.explanation && <div class="inspector-why">{attr.verdict.explanation}</div>}
        </div>
      )}
    </div>
  )}
```

- [ ] **Step 4: Run tests — expect PASS.** Then full inspector suite + `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 8: `ProvenancePanel.jsx` — render ambiguous-field attribution + `not_found` label

**Files:**
- Modify: `src/inspector/components/ProvenancePanel.jsx`
- Test: `tests/inspector-provenance-panel.test.js` (new)

**Interfaces:**
- Consumes: `fieldKey` from `../orchestrate.js`; `store.attributions`; `CulpritChip`.
- Produces: for a field whose source is `rules`/`connector`/unnamed `data_matching`, the Source cell shows the attribution (programmatic best-effort culprit, or AI culprit + explanation, or live phase). `SRC_LABEL` gains `not_found: 'not found'`.

- [ ] **Step 1: Write the failing test** — `tests/inspector-provenance-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ProvenancePanel from '../src/inspector/components/ProvenancePanel.jsx';
import { fieldKey } from '../src/inspector/orchestrate.js';
import * as store from '../src/inspector/store.js';

let root;
beforeEach(() => { store.reset(); store.setAnnotationId('1'); root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

describe('ProvenancePanel field attribution', () => {
  it('renders the attribution for a rules-sourced field', () => {
    store.data.value = { annotation: { id: 1 }, content: { content: [ { category: 'datapoint', schema_id: 'terms', content: { value: '2/10' }, validation_sources: ['rules'] } ] }, resolved: { hooksById: {} } };
    store.setAttribution(fieldKey('terms'), { status: 'done', verdict: { culprit: { kind: 'rule', id: 7, name: 'Set terms' }, confidence: 'medium', explanation: 'writes terms' }, source: 'ai' });
    render(h(ProvenancePanel, null), root);
    expect(root.textContent).toContain('Set terms');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `ProvenancePanel.jsx`: add `not_found: 'not found'` to `SRC_LABEL`; import `fieldKey` from `../orchestrate.js` and `CulpritChip`. In the Source `<td>`, for a field whose `primary` is `rules`/`connector`/`data_matching`, also render `store.attributions.value[fieldKey(p.schemaId)]` (after the existing `matchSource` for data_matching):

```jsx
  function attrFor(schemaId) {
    const a = store.attributions.value[fieldKey(schemaId)];
    if (!a) return null;
    if (a.status === 'loading') return <span class="inspector-label-why inspector-loading inspector-ai-phase"> {a.phase || 'thinking'}…</span>;
    if (a.status === 'done' && a.verdict && a.verdict.culprit) return <span class="inspector-label-why"> <CulpritChip culprit={a.verdict.culprit} /></span>;
    return null;
  }
  // in the Source cell, after the data_matching matchSource(...) call:
  {(p.primary === 'rules' || p.primary === 'connector' || p.primary === 'data_matching') ? attrFor(p.schemaId) : null}
```

- [ ] **Step 4: Run tests — expect PASS.** Then full inspector suite + `npm run build`.

- [ ] **Step 5: No commit.**

---

### Task 9: Full verification + `request_id` cardinality confirmation

**Files:**
- Modify (only if needed): `src/inspector/correlate.js` (reliability downgrade), `src/console/console.css` (only if a new class needs styling — reuse `.inspector-ai-*`/`.inspector-loading`/`.inspector-ai-phase` first)

- [ ] **Step 1: Confirm `request_id` cardinality.** Using the live token (read-only), find or create an annotation that carries messages and compare a message's `detail.request_id` against `/hooks/logs` `request_id`/`uuid`. If a `request_id` maps to exactly one hook invocation → keep `correlateMessage`'s hook match at `REL.VERIFIED`. If it is shared across a whole validation run (many hooks) → change that branch to `REL.BEST_EFFORT` and add a one-line code comment noting the finding. (If it cannot be observed, leave VERIFIED and record the assumption in the ledger.)

- [ ] **Step 2: Grep for dangling references** — `grep -rn "runAttribution\|gatherRejectContext\|gatherLabelContext" src/inspector/components/RejectedPanel.jsx src/inspector/components/LabelsPanel.jsx` must be empty (self-launch fully removed).

- [ ] **Step 3: CSS check** — confirm the new markup reuses existing classes (`.inspector-ai-attr`, `.inspector-ai-verdict`, `.inspector-ai-verdict-inline`, `.inspector-loading`, `.inspector-ai-phase`, `.inspector-why`, `.inspector-label-why`). Add a rule only if something renders unstyled; if so, append near the other `.inspector-*` rules (append-only — `console.css` has unrelated in-flight edits).

- [ ] **Step 4: Full verification** — `npx vitest run` (all green) + `npm run build` (green — catches any dangling import incl. the `../mdh/agent/*` chain).

- [ ] **Step 5: No commit.**

---

## Self-Review

**Spec coverage:** §4A messages → Tasks 1 (correlate), 4 (orchestrate), 6 (BlockedPanel); §4B non-standard blockers → Tasks 4, 6; §4C export → Tasks 2/3/4, 7; §4D fields → Tasks 1/2/3/4, 8; prefetch orchestrator → Tasks 4, 5; hoist reject/label → Tasks 4, 5; read-only → all (only reads + `/persona cautious`); §9 request_id gate → Task 9. All covered.

**Placeholder scan:** every code step is complete; the only judgement step (Task 9 request_id downgrade) is a concrete conditional with the exact edit. No TBD/TODO.

**Type consistency:** `correlateMessage`/`correlateField → { culprit, reliability } | null` used identically in Task 4. `runAttribution({agentApi,kind,context,onPhase,signal}) → {verdict}` and `runFieldBatchAttribution(...) → {verdicts:[{schema_id,culprit,confidence,explanation}]}` consistent across Tasks 2/4. Key helpers `messageKey`/`blockerKey`/`fieldKey`/`labelKey` defined in Task 4 and consumed by Tasks 6/7/8. `store.setAttribution(key,{status,verdict,phase?,error?,reliability?,source})` consistent across Tasks 4/6/7/8. Attribution entry read the same way in every panel.
