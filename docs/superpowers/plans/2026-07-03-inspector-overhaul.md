# Inspector Overhaul (Diagnosis Report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Inspector's six question-tabs with a single progressively-filling Diagnosis Report: instant programmatic evidence + verdict, staged investigation progress, and a citation-linked narrative synthesized by the Rossum Agent ("Mr. Fabry").

**Architecture:** A pure evidence model (`evidence.js`) wraps the existing `culprit.js`/`correlate.js` attribution logic and computes a deterministic "why not automated" verdict. A staged lifecycle (gather → attribute → synthesize → complete) drives a visible progress strip; one agent chat per annotation synthesizes a narrative that cites evidence ids, rendered as chips that scroll to evidence anchors. New intake/workflow/drift sections, plus deep-link entry points (content script + popup) for the already-existing `pendingAnnotationId` consumer.

**Tech Stack:** Preact + @preact/signals, esbuild, vitest + jsdom, Rossum REST API, Rossum Agent API (transport in `src/mdh/agent/agentApi.js`).

**Spec:** `docs/superpowers/specs/2026-07-03-inspector-overhaul-design.md`

## Global Constraints

- **Do NOT commit.** Leave all changes uncommitted on master; no branches/worktrees. (User's standing preference overrides this skill's commit steps — every "Commit" step is replaced by a test run.)
- **Never leak customer names or customer data** — all fixtures, examples, and verification notes use synthetic values only.
- Tests are `.test.js` files in `tests/`, rendering via `h(Component, null)` — **no raw JSX in test files** (breaks oxc). Use `vi.mock` for module mocks. No fixed-timeout sleeps — use condition-based `waitFor` (copy the helper from `tests/inspector-orchestrate.test.js`).
- JSX: unicode escapes do NOT work in JSX text children — use `{'…'}` or the literal character.
- Read-only: `revalidate()` stays the only write. Agent prompts keep read-only framing + `/persona cautious`.
- Run a focused test file with `npx vitest run tests/<file>.test.js`; the full suite with `npm test`.
- After all UI work: `npm run build` (the loaded extension runs `dist/`, not `src/`) and tell the user to reload the extension.
- Reliability semantics: never guess. A fact that can't be verified renders as `unavailable` ("Not recorded"), not as a plausible value.

---

### Task 0: Live verification (spec §8) — V1–V5

**Files:**
- Create: `docs/superpowers/specs/2026-07-03-inspector-overhaul-verification.md`

**Interfaces:**
- Produces: verified facts (or explicit "unverified — degraded path stays") consumed by Tasks 3, 4, 6, and 9. Implementation tasks are written to handle BOTH outcomes, so this task never blocks them; it only upgrades copy/reliability tiers.

This task needs a live dev org session token (user-provided). If none is available when this task runs, record every check as `UNVERIFIED` in the notes file and move on — the code defaults to the degraded (honest) behavior.

- [ ] **Step 1: V1 — populated email shape.** On a dev org with at least one email-ingested annotation: `GET /api/v1/annotations/<id>` → note `email` URL; `GET <email url>`. Record which of these keys exist and their shapes: `from` / `sender` / `subject` / `created_at`. Update the notes file.
- [ ] **Step 2: V2 — workflow_run statuses + assignees.** On a dev org with approval workflows: `GET /api/v1/workflow_runs?annotation=<id>` → record observed `workflow_status` values beyond `approved`; `GET /api/v1/workflow_activities?annotation=<id>` → record whether `step_started` activities carry non-empty `assignees[]`. Update notes.
- [ ] **Step 3: V3 — blocker `details.detail[0]`.** Find (or create via a throwaway rule with an `add_automation_blocker` action, then delete it) an annotation with a rule-sourced blocker: `GET <automation_blocker url>` → record whether `content[].details.detail[0].rule_name/hook_name` is populated. Update notes.
- [ ] **Step 4: V4 — `message.detail.request_id` uniqueness.** On an annotation whose messages came from ≥2 hooks in one validation run: compare each message's `detail.request_id` against `GET /api/v1/hooks/logs?annotation=<id>` entries' `request_id`/`uuid`. Record: per-invocation (each message's request_id matches exactly one hook log) or shared. If shared → in Task 9's Step 6, change `correlateMessage`'s hook-match reliability from `REL.VERIFIED` to `REL.BEST_EFFORT` (one-line change flagged there).
- [ ] **Step 5: V5 — agent citation compliance.** Using the Rossum Agent API on the dev org (`agentApi.createChat` + `streamMessage` from a scratch script, or via the finished Task 6 code): send a `buildSynthesisPrompt` built from a large synthetic evidence model (~200 items, near the 48k cap) and record (a) whether the reply uses `[e:<id>]` markers as instructed, (b) whether ids are copied accurately. If compliance is poor, the DiagnosisPanel fallback (Task 13) — rendering plain narrative when no citations parse — is the shipped behavior; note it.
- [ ] **Step 6: Write up.** The notes file lists each check, VERIFIED/UNVERIFIED, the observed shapes (synthetic examples only — never real file names, senders, or org identifiers), and which task consumed the result.

---

### Task 1: Extract the shared prompt budget helper

**Files:**
- Create: `src/inspector/promptBudget.js`
- Modify: `src/inspector/agentAttribute.js` (remove the local copy, import instead)
- Test: `tests/inspector-prompt-budget.test.js`

**Interfaces:**
- Produces: `budgetedJoin(head: string[], middle: string[], tail: string[], max?: number): string` and `MAX_PROMPT = 48000`. Consumed by `agentAttribute.js` (existing behavior) and `synthesize.js` (Task 6).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { budgetedJoin, MAX_PROMPT } from '../src/inspector/promptBudget.js';

describe('budgetedJoin', () => {
  it('keeps head and tail always, budgets the middle, notes omissions', () => {
    const head = ['H'];
    const tail = ['T'];
    const middle = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)];
    const out = budgetedJoin(head, middle, tail, 700);
    expect(out.startsWith('H\n\n')).toBe(true);
    expect(out.endsWith('\n\nT')).toBe(true);
    expect(out).toContain('a'.repeat(300));
    expect(out).toContain('more candidate');   // omission note
    expect(out).not.toContain('c'.repeat(300));
  });
  it('exports the 48k cap', () => {
    expect(MAX_PROMPT).toBe(48000);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run tests/inspector-prompt-budget.test.js` → "Cannot find module …promptBudget.js")

- [ ] **Step 3: Create `src/inspector/promptBudget.js`** — move the constant + function **verbatim** from `agentAttribute.js` (lines defining `MAX_PROMPT`, `NOTE_RESERVE`, `budgetedJoin`), adding `export` to both:

```js
// Shared prompt-length budgeting for agent calls. The agent /messages endpoint
// rejects a content string over 50000 chars — keep head (framing/question) +
// tail (output instruction) ALWAYS and budget the middle, noting omissions.
export const MAX_PROMPT = 48000;
const NOTE_RESERVE = 160; // headroom kept free so the omission note itself never breaches the cap

export function budgetedJoin(head, middle, tail, max = MAX_PROMPT) {
  const sep = '\n\n';
  const kept = [];
  let used = [...head, ...tail].reduce((n, p) => n + p.length + sep.length, 0);
  let omitted = 0;
  for (const m of middle) {
    if (used + m.length + sep.length > max - NOTE_RESERVE) { omitted++; continue; }
    used += m.length + sep.length;
    kept.push(m);
  }
  if (omitted) kept.push(`(… ${omitted} more candidate item(s) omitted to stay within the length limit — fetch them with your tools if needed.)`);
  return [...head, ...kept, ...tail].join(sep);
}
```

In `agentAttribute.js`: delete the local `MAX_PROMPT`/`NOTE_RESERVE`/`budgetedJoin` definitions and add `import { budgetedJoin } from './promptBudget.js';` at the top. Note the omission-note wording changes from "candidate extension(s)" to "candidate item(s)" — check `tests/inspector-agent-attribute.test.js` for an assertion on that string and update it if present.

- [ ] **Step 4: Run** `npx vitest run tests/inspector-prompt-budget.test.js tests/inspector-agent-attribute.test.js` — expect PASS.

---

### Task 2: `evidence.js` — datapoint resolution, thresholds, verdict

**Files:**
- Create: `src/inspector/evidence.js`
- Test: `tests/inspector-evidence.test.js`

**Interfaces:**
- Consumes: `classifyMessage`, `explainBlocker`, `fieldProvenance`, `REL` from `./culprit.js`.
- Produces:
  - `schemaIdForDatapoint(contentNodes, datapointId) → string|null`
  - `fieldThresholds(schema, queue) → { bySchemaId: Object<string,number>, defaultThreshold: number|null }`
  - `computeVerdict({ annotation, blocker, content, queue, schema }) → { state, severity: 'success'|'warning'|'danger', headline, reasons: [{ fact, culprit, reliability, evidenceId }] }`
    - `state` ∈ `'automated' | 'automation-off' | 'blocked' | 'rejected' | 'export-failed' | 'in-review' | 'not-recorded'`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { schemaIdForDatapoint, fieldThresholds, computeVerdict } from '../src/inspector/evidence.js';

const CONTENT = [{ category: 'section', children: [
  { category: 'datapoint', id: 101, schema_id: 'po_number', content: { value: '', rir_confidence: 0.31 } },
  { category: 'multivalue', children: [{ category: 'datapoint', id: 102, schema_id: 'item_total', content: { value: '5' } }] },
]}];

describe('schemaIdForDatapoint', () => {
  it('resolves nested datapoint ids (string or number)', () => {
    expect(schemaIdForDatapoint(CONTENT, '101')).toBe('po_number');
    expect(schemaIdForDatapoint(CONTENT, 102)).toBe('item_total');
    expect(schemaIdForDatapoint(CONTENT, '999')).toBe(null);
  });
});

describe('fieldThresholds', () => {
  it('collects per-field score_threshold with queue default fallback', () => {
    const schema = { content: [{ category: 'section', children: [
      { category: 'datapoint', id: 'po_number', score_threshold: 0.9 },
      { category: 'datapoint', id: 'total' },
    ]}] };
    const t = fieldThresholds(schema, { default_score_threshold: 0.8 });
    expect(t.bySchemaId.po_number).toBe(0.9);
    expect(t.bySchemaId.total).toBeUndefined();
    expect(t.defaultThreshold).toBe(0.8);
  });
});

describe('computeVerdict', () => {
  const queue = { default_score_threshold: 0.8, automation_level: 'always' };
  it('automated annotation → success', () => {
    const v = computeVerdict({ annotation: { status: 'exported', automated: true }, blocker: null, content: null, queue, schema: null });
    expect(v.state).toBe('automated');
    expect(v.severity).toBe('success');
  });
  it('automation off → automation-off with queue fact', () => {
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker: null, content: null,
      queue: { automation_level: 'never' }, schema: null });
    expect(v.state).toBe('automation-off');
    expect(v.headline).toContain('automation');
  });
  it('blockers → blocked, low_score reason names field + numbers', () => {
    const blocker = { content: [
      { type: 'error_message', level: 'annotation' },
      { type: 'low_score', schema_id: 'po_number', samples: [{ datapoint_id: 101, details: { score: 0.31, threshold: 0.8 } }] },
    ] };
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker, content: { content: [] }, queue, schema: null });
    expect(v.state).toBe('blocked');
    expect(v.severity).toBe('danger');
    const low = v.reasons.find((r) => r.evidenceId === 'blocker:1');
    expect(low.fact).toContain('po_number');
    expect(low.fact).toContain('0.31');
  });
  it('rejected / failed_export outrank in-review', () => {
    expect(computeVerdict({ annotation: { status: 'rejected' }, blocker: null, content: null, queue, schema: null }).state).toBe('rejected');
    expect(computeVerdict({ annotation: { status: 'failed_export' }, blocker: null, content: null, queue, schema: null }).state).toBe('export-failed');
  });
  it('no blockers, not automated → honest in-review', () => {
    const v = computeVerdict({ annotation: { status: 'to_review', automated: false }, blocker: { content: [] }, content: null, queue, schema: null });
    expect(v.state).toBe('in-review');
    expect(v.headline).not.toMatch(/because/i);   // no invented cause
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Implement `src/inspector/evidence.js`**

```js
// Pure evidence model for the Diagnosis Report. Wraps culprit.js/correlate.js —
// never re-derives what they already attribute. Every item carries a stable id
// (citation target), a one-line fact, and a reliability tier. No DOM, no network.
import { classifyMessage, explainBlocker, classifyRejection, fieldProvenance, labelAttribution, matchConfigsForField, exportHookCandidates, REL } from './culprit.js';

const idFromUrl = (url) => { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; };
const fmt = (n) => (typeof n === 'number' ? (Math.round(n * 100) / 100).toString() : String(n ?? '?'));

export function schemaIdForDatapoint(nodes, datapointId) {
  if (datapointId == null) return null;
  const want = String(datapointId);
  const walk = (list) => {
    for (const n of list || []) {
      if (n.category === 'datapoint' && String(n.id) === want) return n.schema_id || null;
      if (n.children) { const hit = walk(n.children); if (hit) return hit; }
    }
    return null;
  };
  return walk(nodes);
}

// Per-field score_threshold from the schema tree; queue default as fallback.
export function fieldThresholds(schema, queue) {
  const bySchemaId = {};
  const walk = (list) => {
    for (const n of list || []) {
      if (n.category === 'datapoint' && typeof n.score_threshold === 'number') bySchemaId[n.id] = n.score_threshold;
      if (n.children) walk(n.children);
    }
  };
  walk(schema?.content);
  const defaultThreshold = typeof queue?.default_score_threshold === 'number' ? queue.default_score_threshold : null;
  return { bySchemaId, defaultThreshold };
}

// Deterministic "why (not) automated" verdict — never guesses (spec §4.2).
export function computeVerdict({ annotation, blocker, content, queue, schema }) {
  const a = annotation || {};
  const reasons = [];
  if (a.status === 'rejected') {
    return { state: 'rejected', severity: 'danger', headline: 'Rejected — see the Rejection section for who and why', reasons };
  }
  if (a.status === 'failed_export' || a.export_failed_at) {
    return { state: 'export-failed', severity: 'danger', headline: 'Export failed — see the Export section', reasons };
  }
  if (a.automated === true) {
    return { state: 'automated', severity: 'success', headline: 'Automated — no human touch was needed', reasons };
  }
  if (queue && (queue.automation_level === 'never' || queue.automation_enabled === false)) {
    return {
      state: 'automation-off', severity: 'warning',
      headline: `Not automated — queue automation is off (automation_level: "${queue.automation_level ?? 'unknown'}")`,
      reasons: [{ fact: 'Queue configuration disables automation.', culprit: { kind: 'queue', id: null, name: 'queue configuration' }, reliability: REL.VERIFIED, evidenceId: 'verdict:automation' }],
    };
  }
  const items = blocker?.content || [];
  if (items.length) {
    const thr = fieldThresholds(schema, queue);
    items.forEach((raw, i) => {
      const b = explainBlocker(raw, { queue });
      if (b.type === 'low_score') {
        const sample = Array.isArray(raw?.samples) ? raw.samples[0] : null;
        const score = sample?.details?.score;
        const threshold = sample?.details?.threshold ?? thr.bySchemaId[b.schemaId] ?? thr.defaultThreshold;
        reasons.push({
          fact: `${b.schemaId || 'a field'} extraction confidence ${fmt(score)} is below the threshold ${fmt(threshold)}`,
          culprit: b.culprit, reliability: b.reliability, evidenceId: `blocker:${i}`,
        });
      } else {
        reasons.push({ fact: b.explanation, culprit: b.culprit, reliability: b.reliability, evidenceId: `blocker:${i}` });
      }
    });
    const errors = items.filter((x) => x?.type === 'error_message').length;
    const lows = items.filter((x) => x?.type === 'low_score').length;
    const parts = [];
    if (errors) parts.push(`${errors} blocking error${errors > 1 ? 's' : ''}`);
    if (lows) parts.push(`${lows} field${lows > 1 ? 's' : ''} below threshold`);
    if (!parts.length) parts.push(`${items.length} blocker${items.length > 1 ? 's' : ''}`);
    return { state: 'blocked', severity: 'danger', headline: `Not automated — ${parts.join(' + ')}`, reasons };
  }
  if (blocker) {
    return { state: 'in-review', severity: 'warning', headline: 'In review — no automation blockers recorded', reasons };
  }
  return { state: 'not-recorded', severity: 'warning', headline: 'Not automated — the platform recorded no blocker for this annotation', reasons };
}
```

(The imports of `classifyMessage`, `classifyRejection`, `labelAttribution`, `matchConfigsForField`, `exportHookCandidates`, `fieldProvenance`, `schemaIdForDatapoint` are used by Task 3 in this same file — the linter may flag them as unused until then; that's expected within this task sequence.)

- [ ] **Step 4: Run** `npx vitest run tests/inspector-evidence.test.js` — expect PASS.

---

### Task 3: `evidence.js` — core evidence items (`buildEvidence`)

**Files:**
- Modify: `src/inspector/evidence.js`
- Test: `tests/inspector-evidence.test.js` (append)

**Interfaces:**
- Consumes: Task 2 helpers; `store.attributions` values are passed IN as a plain object (pure function).
- Produces: `buildEvidence(input) → { items, verdict }` where `input = { annotation, blocker, content, queue, schema, document, parentDocument, relations, email, enrichment, resolved, workflowRuns, workflowSteps, attributions }` and each item is `{ id, section, fact, reliability, culprit, sourceRef, data }`. Item ids reuse the attribution keys (`message:<i>`, `blocker:<i>`, `field:<schemaId>`, `label:<id>`, `reject`, `export`) so residual AI results merge by key. Sections: `'intake' | 'blockers' | 'fields' | 'labels' | 'rejection' | 'export' | 'workflow'`.

- [ ] **Step 1: Append failing tests**

```js
import { buildEvidence } from '../src/inspector/evidence.js';

function baseInput(over = {}) {
  return {
    annotation: { id: 1, status: 'to_review', automated: false, messages: [], labels: [] },
    blocker: { content: [] }, content: { content: [] },
    queue: { default_score_threshold: 0.8 }, schema: null, document: null,
    parentDocument: null, relations: [], email: null,
    enrichment: { workflow: [], notes: [], hookLogs: [], ruleLogs: [] },
    resolved: { usersById: {}, hooksById: {}, labelsById: undefined, labelRules: [] },
    workflowRuns: [], workflowSteps: [], attributions: {},
    ...over,
  };
}

describe('buildEvidence — core items', () => {
  it('message items carry attribution culprit and resolved field name', () => {
    const input = baseInput({
      annotation: { id: 1, status: 'to_review', messages: [
        { type: 'error', content: 'Bad value', id: 101, detail: { rule_id: 7, rule_name: 'PO required' } },
      ], labels: [] },
      content: { content: [{ category: 'section', children: [{ category: 'datapoint', id: 101, schema_id: 'po_number', content: { value: '' } }] }] },
    });
    const { items } = buildEvidence(input);
    const m = items.find((i) => i.id === 'message:0');
    expect(m.section).toBe('blockers');
    expect(m.fact).toContain('po_number');
    expect(m.culprit.name).toBe('PO required');
    expect(m.reliability).toBe('verified');
  });
  it('merges a residual AI attribution into the matching item', () => {
    const input = baseInput({
      annotation: { id: 1, status: 'to_review', messages: [{ type: 'error', content: 'X', detail: {} }], labels: [] },
      attributions: { 'message:0': { status: 'done', source: 'ai', verdict: { culprit: { kind: 'hook', id: 9, name: 'Exporter' }, confidence: 'medium', explanation: 'e' } } },
    });
    const m = buildEvidence(input).items.find((i) => i.id === 'message:0');
    expect(m.culprit.name).toBe('Exporter');
    expect(m.reliability).toBe('best-effort'); // AI verdicts are never 'verified'
  });
  it('field items only for automation-written sources; includes confidence + threshold', () => {
    const input = baseInput({
      content: { content: [{ category: 'section', children: [
        { category: 'datapoint', id: 1, schema_id: 'total', content: { value: '10', rir_confidence: 0.97 }, validation_sources: ['score'] },
        { category: 'datapoint', id: 2, schema_id: 'note', content: { value: 'x' }, validation_sources: ['human'] },
      ] }] },
    });
    const { items } = buildEvidence(input);
    expect(items.find((i) => i.id === 'field:total')).toBeTruthy();
    expect(items.find((i) => i.id === 'field:total').data.threshold).toBe(0.8);
    expect(items.find((i) => i.id === 'field:note')).toBeTruthy(); // human edits are evidence too
  });
  it('unavailable enrichment produces an explicit gap item', () => {
    const input = baseInput({ enrichment: { workflow: [], notes: [], hookLogs: 'unavailable', ruleLogs: [] } });
    const gap = buildEvidence(input).items.find((i) => i.id === 'gap:hookLogs');
    expect(gap.reliability).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildEvidence` not exported).

- [ ] **Step 3: Implement — append to `evidence.js`:**

```js
function walkDatapoints(nodes, out = []) {
  for (const n of nodes || []) { if (n.category === 'datapoint') out.push(n); if (n.children) walkDatapoints(n.children, out); }
  return out;
}

// AI verdicts merge into items as best-effort culprits (never 'verified').
function applyAttribution(item, attr) {
  if (!attr || attr.status !== 'done' || !attr.verdict) return item;
  if (item.culprit) return item; // programmatic/self-declared culprit wins
  const v = attr.verdict;
  if (!v.culprit) return item;
  return { ...item, culprit: v.culprit, reliability: attr.source === 'programmatic' ? (attr.reliability || REL.BEST_EFFORT) : REL.BEST_EFFORT, data: { ...item.data, aiExplanation: v.explanation || null, aiConfidence: v.confidence || null } };
}

export function buildEvidence(input) {
  const { annotation, blocker, content, queue, schema, enrichment = {}, resolved = {}, attributions = {} } = input;
  const a = annotation || {};
  const items = [];
  const push = (it) => items.push(applyAttribution(it, attributions[it.id]));

  // messages → blockers section
  (a.messages || []).forEach((raw, i) => {
    const m = classifyMessage(raw);
    const field = schemaIdForDatapoint(content?.content, m.datapointId);
    push({
      id: `message:${i}`, section: 'blockers',
      fact: `${m.level} message${field ? ` on field ${field}` : ''}: "${m.content}"`,
      reliability: m.reliability, culprit: m.culprit,
      sourceRef: `/api/v1/annotations/${a.id}`, data: { level: m.level, field, isException: m.isException },
    });
  });

  // automation blockers
  (blocker?.content || []).forEach((raw, i) => {
    const b = explainBlocker(raw, { queue });
    const field = b.schemaId || schemaIdForDatapoint(content?.content, b.datapointId);
    push({
      id: `blocker:${i}`, section: 'blockers',
      fact: `automation blocker ${b.type}${field ? ` on field ${field}` : ''}: ${b.explanation}`,
      reliability: b.reliability, culprit: b.culprit,
      sourceRef: a.automation_blocker || null, data: { type: b.type, field },
    });
  });

  // fields (all datapoints with a schema_id; automation-written ones get attribution ids)
  const thr = fieldThresholds(schema, queue);
  const hooks = Object.values(resolved.hooksById || {});
  for (const dp of walkDatapoints(content?.content)) {
    const p = fieldProvenance(dp);
    if (!p.schemaId) continue;
    const threshold = thr.bySchemaId[p.schemaId] ?? thr.defaultThreshold;
    const configs = p.primary === 'data_matching' ? matchConfigsForField(p.schemaId, hooks) : [];
    const via = configs.length ? ` via ${configs.map((c) => c.hookName + (c.configName ? ` · ${c.configName}` : '')).join(', ')}` : '';
    push({
      id: `field:${p.schemaId}`, section: 'fields',
      fact: `field ${p.schemaId} = ${JSON.stringify(p.value ?? null)} (source: ${p.primary}${via}${p.confidence != null ? `, confidence ${fmt(p.confidence)}${threshold != null ? ` vs threshold ${fmt(threshold)}` : ''}` : ''})`,
      reliability: REL.VERIFIED, culprit: null,
      sourceRef: `/api/v1/annotations/${a.id}/content`,
      data: { primary: p.primary, value: p.value, confidence: p.confidence, threshold, configs },
    });
  }

  // labels
  if (resolved.labelsById !== undefined) {
    const { applied, notApplied } = labelAttribution({ annotation: a, labelsById: resolved.labelsById, labelRules: resolved.labelRules || [] });
    for (const l of applied) {
      push({
        id: `label:${l.id}`, section: 'labels',
        fact: l.rule ? `label "${l.name}" applied by rule ${l.rule.name}` : `label "${l.name}" applied (no rule governs it)`,
        reliability: l.reliability, culprit: l.rule ? { kind: 'rule', id: null, name: l.rule.name } : null,
        sourceRef: `/api/v1/annotations/${a.id}`, data: { color: l.color, applied: true },
      });
    }
    for (const l of notApplied) {
      push({ id: `label-not:${l.id}`, section: 'labels', fact: `label "${l.name}" NOT applied — rule ${l.rule.name} did not fire`, reliability: l.reliability, culprit: null, sourceRef: null, data: { color: l.color, applied: false } });
    }
  }

  // rejection
  const rej = classifyRejection({ annotation: a, workflowActivities: Array.isArray(enrichment.workflow) ? enrichment.workflow : [], notes: Array.isArray(enrichment.notes) ? enrichment.notes : [], usersById: resolved.usersById || {} });
  if (rej.type !== 'none') {
    push({
      id: 'reject', section: 'rejection',
      fact: `rejected (${rej.type}) by ${rej.culprit?.name || 'unknown'}${rej.reason.text ? ` — reason: "${rej.reason.text}"` : ' — reason not recorded'}${rej.current ? '' : ' (historical)'}`,
      reliability: rej.reliability, culprit: rej.culprit, sourceRef: `/api/v1/annotations/${a.id}`, data: { when: rej.when, current: rej.current },
    });
  }

  // export
  if (a.status === 'failed_export' || a.export_failed_at) {
    const logs = Array.isArray(enrichment.hookLogs) ? enrichment.hookLogs : [];
    const { failing, candidates } = exportHookCandidates(hooks, logs);
    push({
      id: 'export', section: 'export',
      fact: failing ? `export failed in extension ${failing.hookName}${failing.error ? `: "${failing.error}"` : ''}` : `export failed — failing extension not in logs (${candidates.length} export extension(s) on the queue)`,
      reliability: failing ? REL.BEST_EFFORT : REL.UNAVAILABLE,
      culprit: failing ? { kind: 'hook', id: failing.hookId, name: failing.hookName } : null,
      sourceRef: '/api/v1/hooks/logs', data: { candidates },
    });
  }

  // explicit gaps: enrichment sources that 403'd
  for (const [kind, v] of Object.entries(enrichment)) {
    if (v === 'unavailable') push({ id: `gap:${kind}`, section: 'blockers', fact: `${kind} could not be read (permission denied) — related facts are unavailable, not absent`, reliability: REL.UNAVAILABLE, culprit: null, sourceRef: null, data: {} });
  }

  items.push(...intakeEvidence(input));
  items.push(...workflowEvidence(input));

  const verdict = computeVerdict({ annotation, blocker, content, queue, schema });
  return { items, verdict };
}
```

Add **temporary stubs** at the end of the file so this task is runnable before Task 4 (Task 4 replaces them):

```js
export function intakeEvidence() { return []; }
export function workflowEvidence() { return []; }
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-evidence.test.js` — expect PASS.

---

### Task 4: `evidence.js` — intake + workflow evidence

**Files:**
- Modify: `src/inspector/evidence.js` (replace the two stubs)
- Test: `tests/inspector-evidence-intake.test.js`

**Interfaces:**
- Consumes: `input.document` (fields `original_file_name, mime_type, arrived_at, created_at, parent, email, attachment_status`), `input.parentDocument`, `input.relations` (resolved relation objects), `input.email` (shape per Task 0 V1 — code is defensive), `input.workflowRuns`, `input.workflowSteps`, `input.enrichment.workflow` (activities), `input.annotation.einvoice`.
- Produces: items in sections `intake` / `workflow` with ids `intake:arrival`, `intake:split`, `intake:duplicate`, `intake:einvoice`, `workflow:run`, `workflow:step:<id>`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { intakeEvidence, workflowEvidence } from '../src/inspector/evidence.js';

const base = { annotation: { id: 1 }, document: null, parentDocument: null, relations: [], email: null, workflowRuns: [], workflowSteps: [], enrichment: {} };

describe('intakeEvidence', () => {
  it('classifies arrival by attachment_status (verified vocabulary)', () => {
    const cases = [
      [null, /uploaded directly/i],
      ['processed', /email attachment/i],
      ['extracted_archive', /archive/i],
    ];
    for (const [status, re] of cases) {
      const items = intakeEvidence({ ...base, document: { attachment_status: status, arrived_at: '2026-07-01T09:14:00Z' } });
      expect(items.find((i) => i.id === 'intake:arrival').fact).toMatch(re);
    }
  });
  it('split parent produces intake:split with the parent file name', () => {
    const items = intakeEvidence({ ...base,
      document: { parent: 'https://x/api/v1/documents/50', attachment_status: null },
      parentDocument: { id: 50, original_file_name: 'batch_scan.pdf' } });
    expect(items.find((i) => i.id === 'intake:split').fact).toContain('batch_scan.pdf');
  });
  it('duplicate relation lists sibling annotation ids, edit relations ignored', () => {
    const items = intakeEvidence({ ...base, relations: [
      { type: 'edit', annotations: [] },
      { type: 'duplicate', annotations: ['https://x/api/v1/annotations/1', 'https://x/api/v1/annotations/2'] },
    ] });
    const dup = items.find((i) => i.id === 'intake:duplicate');
    expect(dup.fact).toContain('2');
    expect(items.filter((i) => i.fact.match(/edit/i))).toHaveLength(0);
  });
  it('email with unknown shape degrades honestly', () => {
    const items = intakeEvidence({ ...base, document: { attachment_status: 'processed', email: 'https://x/api/v1/emails/9' }, email: {} });
    const arr = items.find((i) => i.id === 'intake:arrival');
    expect(arr.fact).toMatch(/email attachment/i);
    expect(arr.fact).not.toMatch(/undefined/);
  });
});

describe('workflowEvidence', () => {
  it('no runs → empty (section renders n/a)', () => {
    expect(workflowEvidence(base)).toHaveLength(0);
  });
  it('run + steps + assignee activity', () => {
    const items = workflowEvidence({ ...base,
      workflowRuns: [{ id: 10, workflow_status: 'in_review', current_step: 'https://x/api/v1/workflow_steps/3', workflow: 'https://x/api/v1/workflows/5' }],
      workflowSteps: [
        { id: 2, url: 'https://x/api/v1/workflow_steps/2', name: 'Team lead', ordering: 1, mode: 'any' },
        { id: 3, url: 'https://x/api/v1/workflow_steps/3', name: 'Finance', ordering: 2, mode: 'all' },
      ],
      enrichment: { workflow: [{ action: 'step_started', workflow_step: 'https://x/api/v1/workflow_steps/3', assignees: ['https://x/api/v1/users/77'] }] },
    });
    const run = items.find((i) => i.id === 'workflow:run');
    expect(run.fact).toContain('in_review');
    expect(run.fact).toContain('Finance');
    const step = items.find((i) => i.id === 'workflow:step:3');
    expect(step.data.current).toBe(true);
    expect(step.data.assignees).toEqual(['77']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (stubs return `[]` for every case).

- [ ] **Step 3: Replace the stubs in `evidence.js`:**

```js
// Verified attachment_status vocabulary (2026-06-19): null=upload,
// processed=email attachment, extracted_archive, hook_failed, filtered_by_hook_custom.
const ARRIVAL = {
  null: 'uploaded directly',
  processed: 'arrived as an email attachment',
  extracted_archive: 'extracted from an archive',
  hook_failed: 'imported (an intake hook failed on it)',
  filtered_by_hook_custom: 'imported (filtered by an intake hook)',
};

export function intakeEvidence({ annotation, document: doc, parentDocument, relations = [], email }) {
  const items = [];
  const a = annotation || {};
  if (doc) {
    const key = doc.attachment_status ?? null;
    const how = ARRIVAL[key] || `arrived (attachment_status: "${doc.attachment_status}")`;
    // Email detail only from verified keys; unknown shape → generic phrasing (V1).
    const sender = email && typeof email === 'object' ? (email.from?.email || email.from || email.sender?.email || null) : null;
    const subject = email && typeof email === 'object' && typeof email.subject === 'string' ? email.subject : null;
    const extra = [sender ? `from ${sender}` : null, subject ? `subject "${subject}"` : null].filter(Boolean).join(', ');
    items.push({
      id: 'intake:arrival', section: 'intake',
      fact: `document ${how}${doc.arrived_at ? ` at ${doc.arrived_at}` : ''}${extra ? ` (${extra})` : ''}`,
      reliability: REL.VERIFIED, culprit: null, sourceRef: `/api/v1/documents/${doc.id ?? ''}`,
      data: { attachmentStatus: doc.attachment_status ?? null, mime: doc.mime_type || null, sender, subject },
    });
    if (doc.parent) {
      items.push({
        id: 'intake:split', section: 'intake',
        fact: `split from parent document ${parentDocument?.original_file_name ? `"${parentDocument.original_file_name}"` : `#${idFromUrl(doc.parent)}`}`,
        reliability: REL.VERIFIED, culprit: null, sourceRef: doc.parent, data: { parentId: idFromUrl(doc.parent) },
      });
    }
  }
  const dup = (relations || []).find((r) => r && r.type === 'duplicate');
  if (dup) {
    const siblings = (dup.annotations || []).map(idFromUrl).filter((x) => x && String(x) !== String(a.id));
    items.push({
      id: 'intake:duplicate', section: 'intake',
      fact: `part of a duplicate group with ${siblings.length + (siblings.length === (dup.annotations || []).length ? 0 : 0) || (dup.annotations || []).length} annotation(s): ${(dup.annotations || []).map(idFromUrl).filter(Boolean).join(', ')}`,
      reliability: REL.VERIFIED, culprit: null, sourceRef: dup.url || null, data: { members: (dup.annotations || []).map(idFromUrl).filter(Boolean) },
    });
  }
  if (a.einvoice === true) {
    items.push({ id: 'intake:einvoice', section: 'intake', fact: 'recognized as an e-invoice', reliability: REL.VERIFIED, culprit: null, sourceRef: null, data: {} });
  }
  return items;
}

export function workflowEvidence({ workflowRuns = [], workflowSteps = [], enrichment = {} }) {
  const items = [];
  const run = (workflowRuns || [])[0];
  if (!run) return items;
  const activities = Array.isArray(enrichment.workflow) ? enrichment.workflow : [];
  const steps = [...(workflowSteps || [])].sort((x, y) => (x.ordering ?? 0) - (y.ordering ?? 0));
  const currentId = idFromUrl(run.current_step);
  const currentStep = steps.find((s) => String(s.id) === String(currentId));
  items.push({
    id: 'workflow:run', section: 'workflow',
    fact: `approval workflow status "${run.workflow_status}"${currentStep ? `, currently at step "${currentStep.name}"` : ''}`,
    reliability: REL.VERIFIED, culprit: null, sourceRef: run.url || null,
    data: { status: run.workflow_status, currentStepId: currentId },
  });
  for (const s of steps) {
    const started = activities.find((ac) => ac.action === 'step_started' && idFromUrl(ac.workflow_step) === String(s.id));
    const assignees = (started?.assignees || []).map(idFromUrl).filter(Boolean);
    items.push({
      id: `workflow:step:${s.id}`, section: 'workflow',
      fact: `step ${s.ordering ?? '?'} "${s.name}" (mode ${s.mode || 'unknown'})${assignees.length ? ` — assignee(s): ${assignees.map((u) => `user ${u}`).join(', ')}` : ''}`,
      reliability: REL.VERIFIED, culprit: null, sourceRef: s.url || null,
      data: { ordering: s.ordering ?? null, mode: s.mode || null, current: String(s.id) === String(currentId), assignees },
    });
  }
  return items;
}
```

Delete the two stub definitions from Task 3.

- [ ] **Step 4: Run** `npx vitest run tests/inspector-evidence-intake.test.js tests/inspector-evidence.test.js` — expect PASS. (If the duplicate-count assertion is awkward, the fact string just needs the member ids present — adjust the fact wording, not the test's intent.)

---

### Task 5: `driftDiff.js`

**Files:**
- Create: `src/inspector/driftDiff.js`
- Test: `tests/inspector-drift-diff.test.js`

**Interfaces:**
- Produces: `driftDiff(persisted: Message[], live: Message[], matchedRules?: any[]) → { added, removed, unchanged, matchedRules }` — messages keyed by `(type, content, id)`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { driftDiff } from '../src/inspector/driftDiff.js';

describe('driftDiff', () => {
  const e = (content, type = 'error', id = null) => ({ type, content, id });
  it('classifies added / removed / unchanged by (type, content, id)', () => {
    const persisted = [e('A'), e('B', 'warning'), e('C', 'error', 101)];
    const live = [e('A'), e('D'), e('C', 'error', 102)];
    const d = driftDiff(persisted, live, [{ id: 7 }]);
    expect(d.unchanged.map((m) => m.content)).toEqual(['A']);
    expect(d.removed.map((m) => m.content)).toEqual(['B', 'C']);
    expect(d.added.map((m) => m.content)).toEqual(['D', 'C']);
    expect(d.matchedRules).toEqual([{ id: 7 }]);
  });
  it('tolerates null/undefined inputs', () => {
    const d = driftDiff(null, undefined);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/inspector/driftDiff.js`:**

```js
// Pure diff of persisted annotation.messages[] vs a live validate() result —
// "would today's config treat this annotation differently?" Messages have no
// stable identity, so key by (type, content, datapoint id).
const key = (m) => `${m?.type ?? ''}|${m?.content ?? ''}|${m?.id ?? ''}`;

export function driftDiff(persisted, live, matchedRules = []) {
  const p = Array.isArray(persisted) ? persisted : [];
  const l = Array.isArray(live) ? live : [];
  const pKeys = new Set(p.map(key));
  const lKeys = new Set(l.map(key));
  return {
    added: l.filter((m) => !pKeys.has(key(m))),
    removed: p.filter((m) => !lKeys.has(key(m))),
    unchanged: p.filter((m) => lKeys.has(key(m))),
    matchedRules: Array.isArray(matchedRules) ? matchedRules : [],
  };
}
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-drift-diff.test.js` — expect PASS.

---

### Task 6: `synthesize.js` — prompt, citations, streaming run

**Files:**
- Create: `src/inspector/synthesize.js`
- Test: `tests/inspector-synthesize.test.js`

**Interfaces:**
- Consumes: `budgetedJoin` (Task 1), `newAcc/foldEvents/replyText` from `../mdh/agent/agentStream.js`, `agentApi` (`createChat`, `streamMessage`) injected.
- Produces:
  - `buildSynthesisPrompt(evidence: {items, verdict}, annotation: {id, status, queueId}) → string`
  - `parseCitations(text) → Array<{type:'text',text:string} | {type:'cite',id:string}>`
  - `runSynthesis({ agentApi, evidence, annotation, onPhase, onText, signal }) → Promise<{ text, reasoning, tools }>`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { buildSynthesisPrompt, parseCitations, runSynthesis } from '../src/inspector/synthesize.js';

const EV = {
  verdict: { state: 'blocked', headline: 'Not automated — 1 blocking error', reasons: [{ fact: 'f', evidenceId: 'blocker:0' }] },
  items: [
    { id: 'blocker:0', section: 'blockers', fact: 'automation blocker error_message', reliability: 'verified', culprit: { kind: 'rule', id: 7, name: 'PO required' } },
    { id: 'gap:hookLogs', section: 'blockers', fact: 'hook logs unavailable', reliability: 'unavailable', culprit: null },
  ],
};

describe('buildSynthesisPrompt', () => {
  it('contains verdict, evidence lines with ids, citation + read-only instructions', () => {
    const p = buildSynthesisPrompt(EV, { id: 1, status: 'to_review', queueId: '5' });
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('[blocker:0] (verified)');
    expect(p).toContain('[e:<id>]');
    expect(p).toContain('Not automated');
    expect(p.length).toBeLessThan(48001);
  });
});

describe('parseCitations', () => {
  it('splits text and cite segments', () => {
    const seg = parseCitations('Blocked by a rule [e:blocker:0] and logs are gone [e:gap:hookLogs].');
    expect(seg.filter((s) => s.type === 'cite').map((s) => s.id)).toEqual(['blocker:0', 'gap:hookLogs']);
    expect(seg[0]).toEqual({ type: 'text', text: 'Blocked by a rule ' });
    expect(seg[seg.length - 1].text).toContain('.');
  });
  it('no markers → single text segment; empty → []', () => {
    expect(parseCitations('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(parseCitations('')).toEqual([]);
  });
});

describe('runSynthesis', () => {
  it('primes persona, streams text via onText, returns transcript', async () => {
    const prompts = [];
    const agentApi = {
      createChat: vi.fn(async () => 'chat1'),
      streamMessage: vi.fn(async (_id, content, { onEvent }) => {
        prompts.push(content);
        if (content === '/persona cautious') return;
        onEvent({ type: 'reasoning-start' });
        onEvent({ type: 'reasoning-delta', delta: 'thinking about it' });
        onEvent({ type: 'text-delta', delta: 'Blocked [e:blocker:0]' });
        onEvent({ type: 'finish' });
      }),
    };
    const texts = [];
    const phases = [];
    const res = await runSynthesis({ agentApi, evidence: EV, annotation: { id: 1, status: 'to_review', queueId: '5' }, onPhase: (p) => phases.push(p), onText: (t) => texts.push(t) });
    expect(prompts[0]).toBe('/persona cautious');
    expect(res.text).toBe('Blocked [e:blocker:0]');
    expect(res.reasoning).toContain('thinking');
    expect(texts[texts.length - 1]).toBe('Blocked [e:blocker:0]');
    expect(phases[0]).toBe('thinking');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/inspector/synthesize.js`:**

```js
// Narrative synthesis over the evidence model — one agent chat per annotation.
// The prompt seeds the FULL evidence list (facts we already hold, budget-capped);
// the agent may use its read-only tools for residual gaps, but every claim should
// cite an evidence id we can resolve. Pure prompt/parse here; transport injected.
import { budgetedJoin } from './promptBudget.js';
import { newAcc, foldEvents, replyText } from '../mdh/agent/agentStream.js';

function itemLine(it) {
  return `[${it.id}] (${it.reliability}) ${it.fact}${it.culprit ? ` — culprit: ${it.culprit.kind} ${it.culprit.name}${it.culprit.id != null ? ` #${it.culprit.id}` : ''}` : ''}`;
}

export function buildSynthesisPrompt(evidence, annotation = {}) {
  const v = evidence?.verdict || {};
  const head = [
    'You are writing the diagnosis for a single Rossum annotation in a READ-ONLY forensic tool. Never modify anything — only read and reason.',
    `Annotation: id ${annotation.id}, status ${annotation.status}${annotation.queueId ? `, queue ${annotation.queueId}` : ''}.`,
    `Programmatic verdict (already verified): ${v.headline || 'unknown'}.`,
    'Evidence collected so far (id, reliability, fact):',
  ];
  const middle = (evidence?.items || []).map(itemLine);
  const tail = [
    'Write a short narrative diagnosis (3–6 sentences, plain text, no markdown headings, no JSON):',
    '- Tell the story in order: how the document arrived, what extraction did, what stopped or advanced it, and the single most useful next step.',
    '- After EVERY factual claim, cite the supporting evidence id inline as [e:<id>] — e.g. [e:blocker:0]. Copy ids exactly.',
    '- For anything marked (unavailable), say plainly that it is not recorded — never invent a cause.',
    '- You may use your read-only tools to check details the evidence lacks, but do not repeat the whole evidence list back.',
  ];
  return budgetedJoin(head, middle, tail);
}

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

export async function runSynthesis({ agentApi, evidence, annotation, onPhase = () => {}, onText = () => {}, signal }) {
  onPhase('thinking');
  const chatId = await agentApi.createChat();
  await agentApi.streamMessage(chatId, '/persona cautious', { onEvent: () => {}, signal });
  const acc = newAcc();
  let lastStatus = 'thinking';
  let lastText = '';
  await agentApi.streamMessage(chatId, buildSynthesisPrompt(evidence, annotation), {
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
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-synthesize.test.js` — expect PASS.

---

### Task 7: Store — investigation / synthesis / evidence signals

**Files:**
- Modify: `src/inspector/store.js`
- Test: `tests/inspector-store.test.js` (append)

**Interfaces:**
- Produces (consumed by Tasks 9, 12, 13):
  - `investigation` signal: `{ stage: 'idle'|'gathering'|'attributing'|'synthesizing'|'complete'|'agent-offline', sourcesDone: number, sourcesTotal: number, activity: string }`
  - `synthesis` signal: `null | { status: 'pending'|'streaming'|'done'|'error'|'offline', text: string, reasoning: string, tools: string[], error: string|null }`
  - `evidence` signal: `null | { items, verdict }`
  - `setInvestigation(patch)` — shallow-merge helper.
  - `setAnnotationId(id)` additionally resets all three.

- [ ] **Step 1: Append failing tests to `tests/inspector-store.test.js`**

```js
import { investigation, synthesis, evidence, setInvestigation, setAnnotationId } from '../src/inspector/store.js';

describe('investigation signals', () => {
  it('setInvestigation shallow-merges', () => {
    setInvestigation({ stage: 'gathering', sourcesTotal: 8 });
    setInvestigation({ sourcesDone: 3 });
    expect(investigation.value.stage).toBe('gathering');
    expect(investigation.value.sourcesDone).toBe(3);
    expect(investigation.value.sourcesTotal).toBe(8);
  });
  it('setAnnotationId resets investigation, synthesis, evidence', () => {
    synthesis.value = { status: 'done', text: 'x', reasoning: '', tools: [], error: null };
    evidence.value = { items: [], verdict: {} };
    setAnnotationId('42');
    expect(investigation.value.stage).toBe('idle');
    expect(synthesis.value).toBe(null);
    expect(evidence.value).toBe(null);
  });
});
```

(Match the existing import style at the top of that test file — extend the existing `import … from '../src/inspector/store.js'` line.)

- [ ] **Step 2: Run — expect FAIL** (no such exports).

- [ ] **Step 3: Implement in `store.js`** — add after the `attributions` block:

```js
// Progressive investigation lifecycle (spec §4.3).
const IDLE_INVESTIGATION = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
export const investigation = signal({ ...IDLE_INVESTIGATION });
export function setInvestigation(patch) { investigation.value = { ...investigation.value, ...patch }; }

// Narrative synthesis state (null until the synthesize stage starts).
export const synthesis = signal(null);

// The evidence model, recomputed as sources land (pure buildEvidence output).
export const evidence = signal(null);
```

And extend `setAnnotationId` / `reset` with:

```js
  investigation.value = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
  synthesis.value = null;
  evidence.value = null;
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-store.test.js` — expect PASS.

---

### Task 8: API additions

**Files:**
- Modify: `src/inspector/api.js`
- Test: `tests/inspector-api.test.js` (append)

**Interfaces:**
- Produces: `listWorkflowRuns(annId)`, `listWorkflowSteps(workflowId)`, `getRelation(url)`, `getEmail(url)`. **Removes** `listEmails` (spec §6 — grep first: `grep -rn listEmails src/ tests/` must only show `api.js` before deleting).

- [ ] **Step 1: Append failing tests** (mirror the existing fetch-mock style already used in `tests/inspector-api.test.js` — reuse its `mockFetch` helper if present; otherwise this standalone pattern):

```js
import * as api from '../src/inspector/api.js';

describe('workflow + relation endpoints', () => {
  it('listWorkflowRuns hits /workflow_runs?annotation=', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ results: [], pagination: {} }) }; });
    api.init('https://org.example', 't');
    await api.listWorkflowRuns(42);
    expect(calls[0]).toContain('/api/v1/workflow_runs?');
    expect(calls[0]).toContain('annotation=42');
  });
  it('listWorkflowSteps filters by workflow id', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ results: [], pagination: {} }) }; });
    api.init('https://org.example', 't');
    await api.listWorkflowSteps(5);
    expect(calls[0]).toContain('/api/v1/workflow_steps?');
    expect(calls[0]).toContain('workflow=5');
  });
  it('listEmails is gone', () => {
    expect(api.listEmails).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`listEmails` still exported; new fns missing).

- [ ] **Step 3: Implement in `api.js`** — replace the `listEmails` line with:

```js
export const listWorkflowRuns = (annId, o) => safeListAll(`/api/v1/workflow_runs?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listWorkflowSteps = (workflowId, o) => safeListAll(`/api/v1/workflow_steps?${buildQuery({ workflow: workflowId, page_size: 100 })}`, o);
export const getRelation = (url, o) => get(url, o);   // url from annotation.relations[]
export const getEmail = (url, o) => get(url, o);      // url from annotation.email / document.email
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-api.test.js` — expect PASS.

---

### Task 9: Orchestration — staged lifecycle, new loaders, synthesis launch

**Files:**
- Modify: `src/inspector/index.jsx`, `src/inspector/orchestrate.js`
- Test: `tests/inspector-index.test.js` (append), `tests/inspector-orchestrate.test.js` (append)

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces:
  - `orchestrateAttributions(...)` now **returns a Promise that settles when every attribution (programmatic + AI, incl. the field batch) has settled** — callers may still ignore it.
  - `loadIntakeContext()` and `loadWorkflowContext()` exported loaders storing onto `store.data.value.resolved` as `{ parentDocument, relations, email }` and `{ workflowRuns, workflowSteps }`.
  - `recomputeEvidence()` — rebuilds `store.evidence` from current signals (called after every load and attribution change).
  - `prefetchAndOrchestrate()` drives `investigation.stage` through gathering → attributing → synthesizing → complete (`agent-offline` when `!aiAvailable`).

- [ ] **Step 1: Append a failing orchestrate test** (in `tests/inspector-orchestrate.test.js`, reusing its `orchStore`/`fakeAgent`/`waitFor` helpers):

```js
describe('orchestrateAttributions returns a settle promise', () => {
  it('resolves only after AI attributions have landed', async () => {
    const store = orchStore(msgAnn([{ type: 'error', content: 'B', detail: {} }]));
    const agentApi = fakeAgent();
    await orchestrateAttributions({ store, api: fakeApi, agentApi });
    // after await: no attribution may still be 'loading'
    const states = Object.values(store.attributions.value).map((a) => a.status);
    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain('loading');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (current implementation fires `.then` chains and resolves immediately).

- [ ] **Step 3: Modify `orchestrate.js`** — collect promises: in the per-finding AI loop replace `item.run(onPhase).then(…).catch(…)` with pushing the chained promise into a `pending` array; same for the field-batch promise; end the function with `await Promise.allSettled(pending);`. Exact shape:

```js
  const pending = [];
  // Per-finding AI (background).
  for (const item of ai) {
    if (s.attributions.value[item.key]) continue;
    s.setAttribution(item.key, { status: 'loading', phase: 'thinking', source: 'ai' });
    const onPhase = (phase) => { if (aborted()) return; const cur = s.attributions.value[item.key]; if (cur && cur.status === 'loading' && cur.phase !== phase) s.setAttribution(item.key, { status: 'loading', phase, source: 'ai' }); };
    pending.push(item.run(onPhase)
      .then(({ verdict }) => { if (!aborted()) s.setAttribution(item.key, { status: 'done', verdict, source: 'ai' }); })
      .catch((e) => { if (!aborted() && e?.name !== 'AbortError') s.setAttribution(item.key, { status: 'error', error: e?.message || 'failed', source: 'ai' }); }));
  }
```

…and for the field batch, `pending.push(gatherFieldsContext(…).then(…).catch(…))` (the existing chain, unchanged inside). Both early `return`s (`if (!d) return;` etc.) stay; the `if (!s.aiAvailable.value) return;` line stays (settle promise resolves immediately in that case). Final line: `await Promise.allSettled(pending);`.

- [ ] **Step 4: Run** `npx vitest run tests/inspector-orchestrate.test.js` — expect PASS (all pre-existing tests too — the function was already `async`; its return value was previously unused).

- [ ] **Step 5: Append failing index tests** (in `tests/inspector-index.test.js`, matching its existing mock style — it already mocks `./api.js` etc. via `vi.mock`; extend the module mock with the new api fns):

```js
describe('staged lifecycle', () => {
  it('walks gathering → attributing → synthesizing → complete and stores synthesis text', async () => {
    // agent available; loadAnnotation on a minimal annotation fixture
    // (exact mock wiring mirrors the file's existing loadAnnotation tests)
    await loadAnnotation('1');
    await waitFor(() => store.investigation.value.stage === 'complete');
    expect(store.synthesis.value.status).toBe('done');
    expect(store.evidence.value).toBeTruthy();
    expect(store.investigation.value.sourcesDone).toBe(store.investigation.value.sourcesTotal);
  });
  it('agent offline → stage ends agent-offline, synthesis marked offline', async () => {
    store.aiAvailable.value = false;
    await loadAnnotation('1');
    await waitFor(() => store.investigation.value.stage === 'agent-offline');
    expect(store.synthesis.value.status).toBe('offline');
  });
});
```

- [ ] **Step 6: Implement in `index.jsx`:**

New loaders (same load-scoped-guard pattern as `loadQueueHooks`):

```js
// Intake context: parent document, duplicate relations, source email — all best-effort.
export async function loadIntakeContext() {
  const d = store.data.value;
  if (!d || d.resolved._intakeLoaded) return;
  const myId = loadId;
  const doc = d.resolved.document || null;
  const [parentDocument, relations, email] = await Promise.all([
    doc?.parent ? safe(() => api.getDocument(doc.parent)) : Promise.resolve(null),
    Promise.all((d.annotation.relations || []).map((u) => safe(() => api.getRelation(u)))).then((rs) => rs.filter(Boolean)),
    (d.annotation.email || doc?.email) ? safe(() => api.getEmail(d.annotation.email || doc.email)) : Promise.resolve(null),
  ]);
  const cur = store.data.value;
  if (!cur || myId !== loadId) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, parentDocument, relations, email, _intakeLoaded: true } };
}

// Approval-workflow context: runs + their steps.
export async function loadWorkflowContext() {
  const d = store.data.value;
  if (!d || d.resolved._workflowLoaded) return;
  const myId = loadId;
  const runs = await safe(() => api.listWorkflowRuns(d.annotation.id)) || [];
  const wfIds = [...new Set(runs.map((r) => idFromUrl(r.workflow)).filter(Boolean))];
  const steps = (await Promise.all(wfIds.map((id) => safe(() => api.listWorkflowSteps(id))))).flat().filter(Boolean);
  const cur = store.data.value;
  if (!cur || myId !== loadId) return;
  store.data.value = { ...cur, resolved: { ...cur.resolved, workflowRuns: runs, workflowSteps: steps, _workflowLoaded: true } };
}

// Rebuild the evidence model from current signals — cheap and pure; call after
// every source load and after attribution changes.
export function recomputeEvidence() {
  const d = store.data.value;
  if (!d) { store.evidence.value = null; return; }
  store.evidence.value = buildEvidence({
    annotation: d.annotation, blocker: d.blocker, content: d.content,
    queue: d.resolved.queue, schema: d.resolved.schema, document: d.resolved.document,
    parentDocument: d.resolved.parentDocument || null, relations: d.resolved.relations || [],
    email: d.resolved.email || null, enrichment: store.enrichment.value,
    resolved: d.resolved, workflowRuns: d.resolved.workflowRuns || [],
    workflowSteps: d.resolved.workflowSteps || [], attributions: store.attributions.value,
  });
}
```

**Note:** `queue`/`schema`/`document` currently live at `d.resolved.queue` etc. — they do (set in `loadAnnotation`'s `resolved` object); pass them from there.

Rewire `prefetchAndOrchestrate`:

```js
const SOURCES = ['workflow', 'notes', 'hookLogs', 'ruleLogs', 'hooks', 'labels', 'rules', 'workflowCtx', 'intakeCtx'];
async function prefetchAndOrchestrate() {
  if (attrController) attrController.abort();
  attrController = new AbortController();
  const signal = attrController.signal;
  store.setInvestigation({ stage: 'gathering', sourcesDone: 0, sourcesTotal: SOURCES.length, activity: '' });
  const tick = (p) => p.then(() => { if (!signal.aborted) { store.setInvestigation({ sourcesDone: store.investigation.value.sourcesDone + 1 }); recomputeEvidence(); } });
  await Promise.all([
    tick(loadEnrichment('workflow')), tick(loadEnrichment('notes')),
    tick(loadEnrichment('hookLogs')), tick(loadEnrichment('ruleLogs')),
    tick(loadQueueHooks()), tick(loadLabelContext()), tick(loadQueueRules()),
    tick(loadWorkflowContext()), tick(loadIntakeContext()),
  ]);
  if (signal.aborted) return;
  store.setInvestigation({ stage: 'attributing' });
  await orchestrateAttributions({ store, api, agentApi, signal });
  if (signal.aborted) return;
  recomputeEvidence();
  if (!store.aiAvailable.value) {
    store.synthesis.value = { status: 'offline', text: '', reasoning: '', tools: [], error: null };
    store.setInvestigation({ stage: 'agent-offline', activity: '' });
    return;
  }
  store.setInvestigation({ stage: 'synthesizing' });
  store.synthesis.value = { status: 'streaming', text: '', reasoning: '', tools: [], error: null };
  try {
    const a = store.data.value?.annotation || {};
    const res = await runSynthesis({
      agentApi, evidence: store.evidence.value,
      annotation: { id: a.id, status: a.status, queueId: idFromUrl(a.queue) },
      signal,
      onPhase: (p) => { if (!signal.aborted) store.setInvestigation({ activity: p }); },
      onText: (t) => { if (!signal.aborted) store.synthesis.value = { ...store.synthesis.value, text: t }; },
    });
    if (signal.aborted) return;
    store.synthesis.value = { status: 'done', text: res.text, reasoning: res.reasoning, tools: res.tools, error: null };
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return;
    store.synthesis.value = { ...store.synthesis.value, status: 'error', error: e?.message || 'synthesis failed' };
  }
  store.setInvestigation({ stage: 'complete', activity: '' });
}
```

Note: `SOURCES.length` is 9 — the two lists must stay in sync; the `tick()` calls define the truth (count the tick calls; today = 9). Also: 7 tick sources come from existing loaders (labels+rules were previously one line — keep `loadLabelContext` and `loadQueueRules` as separate ticks as shown). Imports to add at top of `index.jsx`: `buildEvidence` from `./evidence.js`, `runSynthesis` from `./synthesize.js`.

Also call `recomputeEvidence()` at the end of `loadAnnotation`'s success path (right after `store.data.value = …`), so the skeleton has evidence before enrichment lands. **V4 hook (Task 0):** if V4 found request_id is shared, change `REL.VERIFIED` → `REL.BEST_EFFORT` in `correlateMessage`'s hook branch (`src/inspector/correlate.js`) as part of this task.

- [ ] **Step 7: Run** `npx vitest run tests/inspector-index.test.js tests/inspector-orchestrate.test.js` — expect PASS.

---

### Task 10: CSS + `EvidenceSection` wrapper

**Files:**
- Modify: `src/console/console.css`
- Create: `src/inspector/components/EvidenceSection.jsx`
- Test: `tests/inspector-evidence-section.test.js`

**Interfaces:**
- Produces: `<EvidenceSection id title count status defaultOpen>` — `status ∈ 'loaded'|'pending'|'attributing'|'unavailable'|'na'|'optin'|'sparse'`; renders `data-evidence-section={id}`; children hidden when collapsed. Consumed by Tasks 14–16.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';

import EvidenceSection from '../src/inspector/components/EvidenceSection.jsx';

function mount(vnode) {
  const el = document.createElement('div');
  render(vnode, el);
  return el;
}

describe('EvidenceSection', () => {
  it('renders title, count, status chip and children', () => {
    const el = mount(h(EvidenceSection, { id: 'intake', title: 'Intake & origin', count: 'email attachment', status: 'loaded' }, h('div', { class: 'kid' }, 'body')));
    expect(el.textContent).toContain('Intake & origin');
    expect(el.querySelector('.inspector-sst-loaded')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeTruthy();
    expect(el.querySelector('[data-evidence-section="intake"]')).toBeTruthy();
  });
  it('toggles collapse on header click', () => {
    const el = mount(h(EvidenceSection, { id: 'x', title: 'T', status: 'na' }, h('div', { class: 'kid' })));
    el.querySelector('.inspector-esec-hd').click();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
  it('n/a and pending render no children even when open', () => {
    const el = mount(h(EvidenceSection, { id: 'x', title: 'T', status: 'pending' }, h('div', { class: 'kid' })));
    expect(el.querySelector('.inspector-esec-skel')).toBeTruthy();
    expect(el.querySelector('.kid')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `EvidenceSection.jsx`:**

```jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';

const STATUS_LABEL = {
  loaded: 'loaded', pending: 'gathering', attributing: 'attributing',
  unavailable: 'unavailable', na: 'n/a', optin: 'opt-in', sparse: 'logs sparse',
};

// Generic collapsible report section with a per-section investigation status chip.
// `pending` shows a skeleton instead of children; `na` shows nothing but the header.
export default function EvidenceSection({ id, title, count = null, status = 'loaded', defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const showBody = open && status !== 'pending' && status !== 'na';
  return (
    <div class="inspector-esec" data-evidence-section={id}>
      <div class="inspector-esec-hd" onClick={() => setOpen(!open)}>
        <span class="inspector-esec-tri">{open ? '▾' : '▸'}</span>
        <span class="inspector-esec-nm">{title}</span>
        {count != null ? <span class="inspector-esec-cnt">{count}</span> : null}
        <span class={`inspector-sst inspector-sst-${status}`}>{STATUS_LABEL[status] || status}</span>
      </div>
      {open && status === 'pending' && (
        <div class="inspector-esec-bd"><div class="inspector-esec-skel" /><div class="inspector-esec-skel" style="width:70%" /></div>
      )}
      {showBody && <div class="inspector-esec-bd">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Append CSS to the Inspector block of `console.css`** (find the existing `.inspector-` rules and add below; all colors via existing variables so dark mode works):

```css
/* Diagnosis Report — evidence sections */
.inspector-esec { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 12px; }
.inspector-esec-hd { display: flex; align-items: center; gap: 9px; padding: 10px 16px; cursor: pointer; user-select: none; }
.inspector-esec-tri { color: var(--text-secondary); font-size: 10px; }
.inspector-esec-nm { font-weight: 650; }
.inspector-esec-cnt { color: var(--text-secondary); font-size: 12px; }
.inspector-esec-bd { border-top: 1px solid var(--border); padding: 12px 16px; }
.inspector-esec-skel { height: 11px; border-radius: 4px; margin: 7px 0; background: linear-gradient(90deg, var(--bg-hover) 25%, var(--bg-code) 50%, var(--bg-hover) 75%); background-size: 200% 100%; animation: inspector-shimmer 1.4s infinite; }
@keyframes inspector-shimmer { to { background-position: -200% 0; } }
.inspector-sst { margin-left: auto; font-size: 10.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; border-radius: 4px; padding: 2px 7px; }
.inspector-sst-loaded { background: var(--success-bg); color: var(--success-fg); }
.inspector-sst-pending, .inspector-sst-attributing { background: var(--info-bg); color: var(--info-fg); }
.inspector-sst-unavailable, .inspector-sst-na, .inspector-sst-optin { background: var(--bg-code); color: var(--text-secondary); }
.inspector-sst-sparse { background: var(--warning-bg); color: var(--warning-fg); }
/* investigation strip */
.inspector-inv { display: flex; align-items: center; gap: 14px; background: var(--info-bg); border: 1px solid var(--info-border); border-radius: var(--radius); padding: 8px 14px; margin-bottom: 12px; font-size: 12.5px; }
.inspector-inv-st { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.inspector-inv-st.pend { color: var(--text-secondary); font-weight: 500; }
.inspector-inv-ic { width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }
.inspector-inv-st.done .inspector-inv-ic { background: var(--success); color: #fff; }
.inspector-inv-st.run .inspector-inv-ic { border: 2px solid var(--accent); border-top-color: transparent; animation: inspector-spin 1s linear infinite; }
.inspector-inv-st.pend .inspector-inv-ic { border: 2px dashed var(--border); }
.inspector-inv-sep { color: var(--text-secondary); }
.inspector-inv-act { margin-left: auto; color: var(--text-secondary); font-style: italic; }
@keyframes inspector-spin { to { transform: rotate(360deg); } }
/* verdict card */
.inspector-verdict { background: var(--bg-card); border: 1px solid var(--border); border-left-width: 4px; border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px; margin-bottom: 12px; }
.inspector-verdict.sev-danger { border-left-color: var(--danger); }
.inspector-verdict.sev-warning { border-left-color: var(--warning); }
.inspector-verdict.sev-success { border-left-color: var(--success); }
.inspector-verdict-h { font-size: 15px; font-weight: 700; }
.inspector-verdict-why { margin-top: 6px; color: var(--text-primary); }
/* diagnosis */
.inspector-diag { background: var(--bg-card); border: 1px solid var(--info-border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px; margin-bottom: 12px; }
.inspector-diag-hd { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; margin-bottom: 8px; }
.inspector-diag-phase { margin-left: auto; font-weight: 500; font-size: 11.5px; color: var(--text-secondary); font-style: italic; }
.inspector-diag p { margin: 0 0 8px; }
.inspector-cite { display: inline-flex; align-items: center; gap: 3px; background: var(--info-bg); border: 1px solid var(--info-border); color: var(--info-fg); border-radius: 999px; padding: 0 8px; font-size: 11px; font-weight: 600; cursor: pointer; vertical-align: 1px; }
.inspector-cite.unresolved { background: var(--bg-code); border-color: var(--border); color: var(--text-secondary); cursor: default; text-decoration: line-through; }
.inspector-ev-flash { animation: inspector-ev-flash 1.6s ease-out; }
@keyframes inspector-ev-flash { 0% { background: var(--info-bg); } 100% { background: transparent; } }
/* confidence bar */
.inspector-conf { display: inline-block; width: 64px; height: 7px; border-radius: 4px; background: var(--bg-hover); position: relative; margin-right: 6px; vertical-align: 0; }
.inspector-conf i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
.inspector-conf .thr { position: absolute; top: -2.5px; bottom: -2.5px; width: 2px; background: var(--text-primary); opacity: .55; }
```

- [ ] **Step 5: Run** `npx vitest run tests/inspector-evidence-section.test.js` — expect PASS.

---

### Task 11: `ReportHeader` + `VerdictCard`

**Files:**
- Create: `src/inspector/components/ReportHeader.jsx`, `src/inspector/components/VerdictCard.jsx`
- Test: `tests/inspector-report-header.test.js`

**Interfaces:**
- Consumes: `store.data` (header), `store.evidence` (verdict), existing `Overview.jsx` + `Timeline.jsx` (composed, not rewritten), `CulpritChip`.
- Produces: `<ReportHeader />` (one card wrapping Overview + Timeline), `<VerdictCard />` (headline + reasons with culprit chips; hidden while `store.evidence` is null).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import ReportHeader from '../src/inspector/components/ReportHeader.jsx';
import VerdictCard from '../src/inspector/components/VerdictCard.jsx';

function mount(vnode) { const el = document.createElement('div'); render(vnode, el); return el; }

describe('ReportHeader', () => {
  it('renders overview + timeline inside one card', () => {
    store.data.value = { annotation: { id: 9, status: 'to_review', created_at: '2026-07-01T09:14:00Z' }, blocker: null, content: null, resolved: { usersById: {}, hooksById: {} } };
    const el = mount(h(ReportHeader, null));
    expect(el.querySelector('.inspector-rephead')).toBeTruthy();
    expect(el.textContent).toContain('#9');
    expect(el.textContent).toContain('Created');
  });
});

describe('VerdictCard', () => {
  beforeEach(() => { store.evidence.value = null; });
  it('null evidence → renders nothing', () => {
    expect(mount(h(VerdictCard, null)).textContent).toBe('');
  });
  it('renders headline, severity class, reasons with culprits', () => {
    store.evidence.value = { items: [], verdict: { state: 'blocked', severity: 'danger', headline: 'Not automated — 1 blocking error',
      reasons: [{ fact: 'po_number is empty', culprit: { kind: 'rule', id: 7, name: 'PO required' }, reliability: 'verified', evidenceId: 'blocker:0' }] } };
    const el = mount(h(VerdictCard, null));
    expect(el.querySelector('.inspector-verdict.sev-danger')).toBeTruthy();
    expect(el.textContent).toContain('Not automated');
    expect(el.textContent).toContain('PO required');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** `ReportHeader.jsx`:

```jsx
import { h } from 'preact';
import Overview from './Overview.jsx';
import Timeline from './Timeline.jsx';

// One header card: identity/overview + the status timeline (spec §5.1).
export default function ReportHeader() {
  return (
    <div class="inspector-rephead">
      <Overview />
      <Timeline />
    </div>
  );
}
```

`VerdictCard.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import CulpritChip from './CulpritChip.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';

// The instant programmatic verdict (spec §4.2) — renders as soon as core data is in.
export default function VerdictCard() {
  const ev = store.evidence.value;
  if (!ev || !ev.verdict) return null;
  const v = ev.verdict;
  return (
    <div class={`inspector-verdict sev-${v.severity}`}>
      <div class="inspector-verdict-h">{v.headline}</div>
      {v.reasons.map((r) => (
        <div class="inspector-verdict-why">
          {r.fact} {r.culprit ? <CulpritChip culprit={r.culprit} /> : null} <ReliabilityBadge level={r.reliability} />
        </div>
      ))}
    </div>
  );
}
```

Add CSS: `.inspector-rephead { margin-bottom: 12px; }` (Overview/Timeline already carry their own cards; wrap-only).

- [ ] **Step 4: Run** `npx vitest run tests/inspector-report-header.test.js` — expect PASS.

---

### Task 12: `InvestigationStrip`

**Files:**
- Create: `src/inspector/components/InvestigationStrip.jsx`
- Test: `tests/inspector-investigation-strip.test.js`

**Interfaces:**
- Consumes: `store.investigation`, `store.attributions`, `store.synthesis`.
- Produces: `<InvestigationStrip />` — three stage pills (Gather n/m, Attribute k of K, Synthesize) with done/run/pend states, activity text right-aligned; collapses to a stat line when `stage === 'complete'`; renders an "agent offline" variant.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import InvestigationStrip from '../src/inspector/components/InvestigationStrip.jsx';

function mount() { const el = document.createElement('div'); render(h(InvestigationStrip, null), el); return el; }

describe('InvestigationStrip', () => {
  beforeEach(() => { store.attributions.value = {}; store.synthesis.value = null; });
  it('gathering shows source progress and pending later stages', () => {
    store.investigation.value = { stage: 'gathering', sourcesDone: 3, sourcesTotal: 9, activity: '' };
    const el = mount();
    expect(el.textContent).toContain('3/9');
    expect(el.querySelectorAll('.inspector-inv-st.pend').length).toBe(2);
  });
  it('attributing shows AI finding progress and live activity', () => {
    store.investigation.value = { stage: 'attributing', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    store.attributions.value = {
      a: { status: 'done', source: 'ai' }, b: { status: 'loading', source: 'ai', phase: 'reading extension code' }, c: { status: 'done', source: 'programmatic' },
    };
    const el = mount();
    expect(el.textContent).toContain('1 of 2');
    expect(el.textContent).toContain('reading extension code');
  });
  it('complete collapses to a stat line', () => {
    store.investigation.value = { stage: 'complete', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    store.attributions.value = { a: { status: 'done', source: 'ai' } };
    const el = mount();
    expect(el.textContent).toMatch(/9 sources/);
    expect(el.textContent).toMatch(/1 attribution/);
  });
  it('idle renders nothing', () => {
    store.investigation.value = { stage: 'idle', sourcesDone: 0, sourcesTotal: 0, activity: '' };
    expect(mount().textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `InvestigationStrip.jsx`:**

```jsx
import { h } from 'preact';
import * as store from '../store.js';

function stageState(stage, self) {
  const order = ['gathering', 'attributing', 'synthesizing', 'complete'];
  const cur = stage === 'agent-offline' ? 'complete' : stage;
  const a = order.indexOf(self); const b = order.indexOf(cur);
  if (b > a) return 'done';
  if (b === a) return 'run';
  return 'pend';
}

function Pill({ state, label, note }) {
  return (
    <span class={`inspector-inv-st ${state}`}>
      <span class="inspector-inv-ic">{state === 'done' ? '✓' : ''}</span> {label}{note ? <span class="inspector-inv-note"> {note}</span> : null}
    </span>
  );
}

// The visible investigation lifecycle (spec §4.3): Gather → Attribute → Synthesize.
export default function InvestigationStrip() {
  const inv = store.investigation.value;
  if (inv.stage === 'idle') return null;
  const attrs = Object.values(store.attributions.value);
  const ai = attrs.filter((a) => a.source === 'ai');
  const aiDone = ai.filter((a) => a.status !== 'loading').length;
  const loadingPhase = ai.find((a) => a.status === 'loading' && a.phase)?.phase;
  const activity = inv.activity || loadingPhase || '';

  if (inv.stage === 'complete' || inv.stage === 'agent-offline') {
    const unavailable = (store.evidence.value?.items || []).filter((i) => i.reliability === 'unavailable').length;
    return (
      <div class="inspector-inv">
        <span class="inspector-inv-st done"><span class="inspector-inv-ic">{'✓'}</span> Investigation {inv.stage === 'agent-offline' ? 'finished (AI offline)' : 'complete'}</span>
        <span class="inspector-inv-act">
          {inv.sourcesTotal} sources {'·'} {ai.length} attribution{ai.length === 1 ? '' : 's'}{unavailable ? ` · ${unavailable} unavailable` : ''}
        </span>
      </div>
    );
  }
  return (
    <div class="inspector-inv">
      <Pill state={stageState(inv.stage, 'gathering')} label="Gather" note={`${inv.sourcesDone}/${inv.sourcesTotal}`} />
      <span class="inspector-inv-sep">{'›'}</span>
      <Pill state={stageState(inv.stage, 'attributing')} label="Attribute" note={ai.length ? `${aiDone} of ${ai.length}` : ''} />
      <span class="inspector-inv-sep">{'›'}</span>
      <Pill state={stageState(inv.stage, 'synthesizing')} label="Synthesize" />
      {activity ? <span class="inspector-inv-act">{activity}{'…'}</span> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-investigation-strip.test.js` — expect PASS.

---

### Task 13: `DiagnosisPanel` — streaming narrative, citations, transcript

**Files:**
- Create: `src/inspector/components/DiagnosisPanel.jsx`
- Test: `tests/inspector-diagnosis-panel.test.js`

**Interfaces:**
- Consumes: `store.synthesis`, `store.evidence`, `parseCitations` (Task 6).
- Produces: `<DiagnosisPanel />`. Citation chips: click → `document.querySelector('[data-evidence-id="<id>"]') || document.querySelector('[data-evidence-section="<section>"]')` → `scrollIntoView({behavior:'smooth', block:'center'})` + a temporary `inspector-ev-flash` class. Unresolvable id (not in `evidence.items`) → `.inspector-cite.unresolved`, not clickable. Transcript in a lightweight modal overlay.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import DiagnosisPanel from '../src/inspector/components/DiagnosisPanel.jsx';

function mount() { const el = document.createElement('div'); render(h(DiagnosisPanel, null), el); return el; }
const EV = { items: [{ id: 'blocker:0', section: 'blockers', fact: 'f', reliability: 'verified', culprit: null }], verdict: {} };

describe('DiagnosisPanel', () => {
  beforeEach(() => { store.evidence.value = EV; });
  it('null synthesis (still attributing) → skeleton', () => {
    store.synthesis.value = null;
    store.investigation.value = { stage: 'attributing', sourcesDone: 9, sourcesTotal: 9, activity: '' };
    expect(mount().querySelector('.inspector-esec-skel')).toBeTruthy();
  });
  it('streaming text renders resolvable citation chips, unresolvable struck', () => {
    store.synthesis.value = { status: 'streaming', text: 'Blocked [e:blocker:0] and [e:nope:1].', reasoning: '', tools: [], error: null };
    const el = mount();
    const chips = el.querySelectorAll('.inspector-cite');
    expect(chips.length).toBe(2);
    expect(chips[0].classList.contains('unresolved')).toBe(false);
    expect(chips[1].classList.contains('unresolved')).toBe(true);
  });
  it('offline / error states render honest notes', () => {
    store.synthesis.value = { status: 'offline', text: '', reasoning: '', tools: [], error: null };
    expect(mount().textContent).toMatch(/unavailable/i);
    store.synthesis.value = { status: 'error', text: '', reasoning: '', tools: [], error: 'boom' };
    expect(mount().textContent).toMatch(/failed/i);
  });
  it('done state shows View investigation toggle with reasoning', () => {
    store.synthesis.value = { status: 'done', text: 'All good.', reasoning: 'because logs', tools: ['rossum_get_hook'], error: null };
    const el = mount();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('View investigation'));
    btn.click();
    expect(el.textContent).toContain('because logs');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `DiagnosisPanel.jsx`:**

```jsx
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { parseCitations } from '../synthesize.js';

function flashEvidence(id, section) {
  const el = document.querySelector(`[data-evidence-id="${id}"]`) || (section ? document.querySelector(`[data-evidence-section="${section}"]`) : null);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('inspector-ev-flash');
  // restart the animation on repeated clicks
  void el.offsetWidth;
  el.classList.add('inspector-ev-flash');
}

function Cite({ id }) {
  const items = store.evidence.value?.items || [];
  const item = items.find((i) => i.id === id);
  if (!item) return <span class="inspector-cite unresolved" title="cited evidence not found">{id}</span>;
  return (
    <button type="button" class="inspector-cite" title={item.fact} onClick={() => flashEvidence(id, item.section)}>{id}</button>
  );
}

function Narrative({ text, streaming }) {
  const segments = parseCitations(text);
  return (
    <p>
      {segments.map((s) => (s.type === 'cite' ? <Cite id={s.id} /> : <span>{s.text}</span>))}
      {streaming ? <span class="inspector-caret" /> : null}
    </p>
  );
}

function Transcript({ reasoning, tools, onClose }) {
  return (
    <div class="inspector-modal-backdrop" onClick={onClose}>
      <div class="inspector-modal" onClick={(e) => e.stopPropagation()}>
        <div class="inspector-modal-hd">Investigation transcript <button type="button" class="inspector-modal-x" onClick={onClose}>{'×'}</button></div>
        {tools.length ? <div class="inspector-note">Tools used: {tools.join(', ')}</div> : null}
        <pre class="inspector-code-block">{reasoning || '(no reasoning recorded)'}</pre>
      </div>
    </div>
  );
}

// The synthesized narrative (spec §4.4) — never gates the programmatic report.
export default function DiagnosisPanel() {
  const [showTranscript, setShowTranscript] = useState(false);
  const syn = store.synthesis.value;
  const inv = store.investigation.value;
  const waiting = !syn && (inv.stage === 'gathering' || inv.stage === 'attributing');

  return (
    <div class="inspector-diag">
      <div class="inspector-diag-hd">
        {'✨'} Diagnosis
        {waiting ? <span class="inspector-diag-phase">starts after attribution finishes{'…'}</span> : null}
        {syn?.status === 'streaming' ? <span class="inspector-diag-phase">writing{'…'}</span> : null}
        {syn?.status === 'done' ? (
          <span class="inspector-diag-phase">
            <button type="button" class="inspector-fold-btn" onClick={() => setShowTranscript(true)}>View investigation</button>
          </span>
        ) : null}
      </div>
      {waiting && <Fragment><div class="inspector-esec-skel" style="width:92%" /><div class="inspector-esec-skel" style="width:78%" /></Fragment>}
      {syn?.status === 'offline' && <div class="inspector-empty">AI synthesis unavailable (agent offline) — the verified evidence below is complete.</div>}
      {syn?.status === 'error' && <div class="inspector-empty">AI synthesis failed{syn.error ? ` (${syn.error})` : ''} — the verified evidence below is complete.</div>}
      {(syn?.status === 'streaming' || syn?.status === 'done') && <Narrative text={syn.text} streaming={syn.status === 'streaming'} />}
      {showTranscript && syn ? <Transcript reasoning={syn.reasoning} tools={syn.tools || []} onClose={() => setShowTranscript(false)} /> : null}
    </div>
  );
}
```

Add CSS:

```css
.inspector-caret { display: inline-block; width: 7px; height: 14px; background: var(--accent); vertical-align: -2px; animation: inspector-blink 1s steps(1) infinite; }
@keyframes inspector-blink { 50% { opacity: 0; } }
.inspector-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.inspector-modal { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--glass-shadow); max-width: 720px; width: 90%; max-height: 80vh; overflow: auto; padding: 14px 16px; }
.inspector-modal-hd { display: flex; align-items: center; justify-content: space-between; font-weight: 700; margin-bottom: 8px; }
.inspector-modal-x { background: none; border: none; font-size: 17px; cursor: pointer; color: var(--text-secondary); }
```

- [ ] **Step 4: Run** `npx vitest run tests/inspector-diagnosis-panel.test.js` — expect PASS.

---

### Task 14: `IntakeSection`, `WorkflowSection`, `DriftSection`

**Files:**
- Create: `src/inspector/components/IntakeSection.jsx`, `src/inspector/components/WorkflowSection.jsx`, `src/inspector/components/DriftSection.jsx`
- Test: `tests/inspector-new-sections.test.js`

**Interfaces:**
- Consumes: `store.evidence` items by section; `store.live`, `store.data`, `runRevalidate` (existing), `driftDiff` (Task 5), `EvidenceSection` (Task 10).
- Produces: three section components used by `Report.jsx` (Task 16). Every evidence row renders `data-evidence-id={item.id}` (citation anchor).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import IntakeSection from '../src/inspector/components/IntakeSection.jsx';
import WorkflowSection from '../src/inspector/components/WorkflowSection.jsx';
import DriftSection from '../src/inspector/components/DriftSection.jsx';

function mount(vnode) { const el = document.createElement('div'); render(vnode, el); return el; }

describe('IntakeSection', () => {
  it('renders intake items with data-evidence-id anchors', () => {
    store.evidence.value = { verdict: {}, items: [
      { id: 'intake:arrival', section: 'intake', fact: 'document arrived as an email attachment', reliability: 'verified', culprit: null, data: {} },
    ] };
    const el = mount(h(IntakeSection, null));
    expect(el.querySelector('[data-evidence-id="intake:arrival"]')).toBeTruthy();
    expect(el.textContent).toContain('email attachment');
  });
  it('no intake items → n/a status, no body', () => {
    store.evidence.value = { verdict: {}, items: [] };
    const el = mount(h(IntakeSection, null));
    expect(el.querySelector('.inspector-sst-na')).toBeTruthy();
  });
});

describe('WorkflowSection', () => {
  it('renders run + steps, current step highlighted', () => {
    store.evidence.value = { verdict: {}, items: [
      { id: 'workflow:run', section: 'workflow', fact: 'approval workflow status "in_review"', reliability: 'verified', culprit: null, data: { status: 'in_review' } },
      { id: 'workflow:step:3', section: 'workflow', fact: 'step 2 "Finance"', reliability: 'verified', culprit: null, data: { current: true } },
    ] };
    const el = mount(h(WorkflowSection, null));
    expect(el.textContent).toContain('in_review');
    expect(el.querySelector('.inspector-wf-current')).toBeTruthy();
  });
});

describe('DriftSection', () => {
  beforeEach(() => { store.live.value = null; store.data.value = { annotation: { id: 1, messages: [{ type: 'error', content: 'A' }] }, blocker: null, content: null, resolved: {} }; });
  it('idle → opt-in button and lock note', () => {
    const el = mount(h(DriftSection, null));
    expect(el.textContent).toMatch(/Re-evaluate/);
    expect(el.textContent).toMatch(/reviewing lock/i);
  });
  it('after a live run → renders the diff', () => {
    store.live.value = { messages: [{ type: 'error', content: 'B' }], matchedTriggerRules: [] };
    const el = mount(h(DriftSection, null));
    expect(el.textContent).toContain('B');           // added
    expect(el.textContent).toContain('A');           // removed
    expect(el.textContent).toMatch(/added|removed/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** `IntakeSection.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import EvidenceSection from './EvidenceSection.jsx';
import ReliabilityBadge from './ReliabilityBadge.jsx';

// Arrival story: email/upload/split/archive + duplicates (spec §5.5-intake).
export default function IntakeSection() {
  const items = (store.evidence.value?.items || []).filter((i) => i.section === 'intake');
  const status = items.length ? 'loaded' : (store.evidence.value ? 'na' : 'pending');
  const arrival = items.find((i) => i.id === 'intake:arrival');
  return (
    <EvidenceSection id="intake" title="Intake & origin" count={arrival ? arrival.data.attachmentStatus || 'upload' : null} status={status}>
      {items.map((i) => (
        <div class="inspector-ev" data-evidence-id={i.id}>
          <span>{i.fact}</span> <ReliabilityBadge level={i.reliability} />
        </div>
      ))}
    </EvidenceSection>
  );
}
```

`WorkflowSection.jsx`:

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import EvidenceSection from './EvidenceSection.jsx';

// Approval-workflow state: run status + ordered steps, current step marked.
export default function WorkflowSection() {
  const items = (store.evidence.value?.items || []).filter((i) => i.section === 'workflow');
  const run = items.find((i) => i.id === 'workflow:run');
  const status = items.length ? 'loaded' : (store.evidence.value ? 'na' : 'pending');
  return (
    <EvidenceSection id="workflow" title="Approval workflow" count={run ? run.data.status : 'no workflow'} status={status}>
      {items.map((i) => (
        <div class={`inspector-ev${i.data?.current ? ' inspector-wf-current' : ''}`} data-evidence-id={i.id}>{i.fact}</div>
      ))}
    </EvidenceSection>
  );
}
```

`DriftSection.jsx` (also REMOVE the re-evaluate block + `live` note from `BlockedPanel.jsx` in this task — it moves here):

```jsx
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { runRevalidate } from '../index.jsx';
import { driftDiff } from '../driftDiff.js';
import EvidenceSection from './EvidenceSection.jsx';

// Opt-in config-drift check (spec §4.5): live validate vs the persisted messages.
export default function DriftSection() {
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState(null);
  const d = store.data.value;
  const live = store.live.value;
  const diff = live ? driftDiff(d?.annotation?.messages, live.messages, live.matchedTriggerRules) : null;

  const run = async () => {
    setErr(null); setRunning(true);
    try { await runRevalidate(); }
    catch (e) { setErr(e?.message || 'Re-evaluation failed'); }
    finally { setRunning(false); }
  };

  return (
    <EvidenceSection id="drift" title="Config drift" count={diff ? `${diff.added.length} added · ${diff.removed.length} removed` : 'persisted vs today’s config'} status={diff ? 'loaded' : 'optin'}>
      {!diff && (
        <Fragment>
          <button class="btn btn-primary" disabled={running} onClick={run}>{running ? 'Re-evaluating…' : 'Re-evaluate against today’s config'}</button>
          <div class="inspector-note">Runs a live <code class="inspector-code">validate</code> (start {'→'} validate {'→'} cancel). Takes a brief reviewing lock on the annotation.</div>
          {err && <div class="inspector-empty">{err}</div>}
        </Fragment>
      )}
      {diff && (
        <Fragment>
          <div class="inspector-sect">Messages under today{'’'}s config</div>
          {diff.added.map((m) => <div class="inspector-ev inspector-drift-add" data-evidence-id="drift:added">+ {m.type}: {m.content}</div>)}
          {diff.removed.map((m) => <div class="inspector-ev inspector-drift-del" data-evidence-id="drift:removed">{'−'} {m.type}: {m.content}</div>)}
          {!diff.added.length && !diff.removed.length && <div class="inspector-empty">No drift {'—'} today{'’'}s config produces the same messages.</div>}
          <div class="inspector-note">{diff.matchedRules.length} rule(s) matched in the live run. The live result is not persisted.</div>
        </Fragment>
      )}
    </EvidenceSection>
  );
}
```

Add CSS: `.inspector-wf-current { font-weight: 700; } .inspector-drift-add { color: var(--success-fg); } .inspector-drift-del { color: var(--danger-fg); } .inspector-ev { padding: 4px 0; }`

- [ ] **Step 4: Run** `npx vitest run tests/inspector-new-sections.test.js tests/inspector-blocked-panel.test.js` — expect PASS. (`inspector-blocked-panel.test.js` may assert the re-evaluate button — remove those assertions there since the button moved to DriftSection.)

---

### Task 15: Adapt existing panels into section bodies

**Files:**
- Modify: `src/inspector/components/BlockedPanel.jsx`, `ProvenancePanel.jsx`, `PipelinePanel.jsx`, `LabelsPanel.jsx`, `RejectedPanel.jsx`, `ExportPanel.jsx`
- Test: existing panel tests (adjust), `tests/inspector-provenance-panel.test.js` (append)

**Interfaces:**
- Consumes: evidence anchors contract from Task 13 (`data-evidence-id`).
- Produces: panels render unchanged content + anchors; Provenance gains confidence bars; Pipeline relabels "no log".

- [ ] **Step 1: Append a failing provenance test**

```js
it('renders a confidence bar with threshold for engine fields', () => {
  // fixture: datapoint with rir_confidence 0.31, schema threshold 0.8 (reuse the file's existing store fixture pattern)
  // assert:
  expect(el.querySelector('.inspector-conf')).toBeTruthy();
  expect(el.textContent).toContain('0.31');
});
```

(Adapt to the file's existing fixture helpers — it already mounts ProvenancePanel with store fixtures.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Make the edits:**

1. **BlockedPanel.jsx** — (a) re-evaluate block already removed in Task 14; (b) add `data-evidence-id={`blocker:${i}`}` to each `.inspector-bcard` and `data-evidence-id={`message:${m.idx}`}` to each `.inspector-mrow`; (c) resolve field names: add at top `import { schemaIdForDatapoint } from '../evidence.js';` and inside `MsgRow` render `{field ? <span class="inspector-tag">field {field}</span> : null}` where `const field = schemaIdForDatapoint(store.data.value?.content?.content, m.datapointId);`.
2. **ProvenancePanel.jsx** — add `data-evidence-id={`field:${p.schemaId}`}` on each `<tr>`; replace the confidence `<td>` content with a bar + numbers:

```jsx
<td>
  {p.confidence != null ? (
    <span>
      <span class="inspector-conf">
        <i style={`width:${Math.round(p.confidence * 100)}%;background:${threshold != null && p.confidence < threshold ? 'var(--danger)' : 'var(--success)'}`} />
        {threshold != null ? <span class="thr" style={`left:${Math.round(threshold * 100)}%`} /> : null}
      </span>
      {p.confidence.toFixed(2)}{threshold != null ? ` / ${threshold}` : ''}
    </span>
  ) : (p.primary === 'human' ? 'edited' : '')}
</td>
```

with `const { bySchemaId, defaultThreshold } = fieldThresholds(d.resolved.schema, d.resolved.queue);` computed once above the map and `const threshold = bySchemaId[p.schemaId] ?? defaultThreshold;` per row (`import { fieldThresholds } from '../evidence.js';`).
3. **PipelinePanel.jsx** — change the no-log span text from `no log` to `no log {'—'} likely ran` and its `title` to `Only failures are reliably logged; absence of a log usually means it ran fine.`
4. **LabelsPanel.jsx** — add `data-evidence-id={`label:${l.id}`}` to each applied-label `.inspector-bcard` and `data-evidence-id={`label-not:${l.id}`}` to the not-applied cards.
5. **RejectedPanel.jsx** — add `data-evidence-id="reject"` to the `.inspector-culprit` div.
6. **ExportPanel.jsx** — add `data-evidence-id="export"` to the `.inspector-kv` div.

- [ ] **Step 4: Run** `npx vitest run tests/inspector-provenance-panel.test.js tests/inspector-blocked-panel.test.js tests/inspector-labels-panel.test.js tests/inspector-rejected-panel.test.js tests/inspector-export-panel.test.js tests/inspector-components.test.js` — fix any assertion that referenced the old "no log" text; expect PASS.

---

### Task 16: `Report.jsx` + App swap (tabs removed)

**Files:**
- Create: `src/inspector/components/Report.jsx`
- Modify: `src/inspector/components/App.jsx`
- Test: `tests/inspector-report.test.js`; adjust `tests/inspector-shell.test.js` / `tests/inspector-components.test.js` if they assert tabs

**Interfaces:**
- Consumes: every component from Tasks 10–15; existing panels wrapped in `EvidenceSection`s.
- Produces: `<Report />` — the full single-column assembly. `App.jsx` renders `IdInput` + (`RecentAnnotations` | `Report`); the `TABS` array and tab state are deleted; empty-state copy for the not-connected view becomes: `Not connected. Open a Rossum annotation and click Inspect this annotation, or paste an id below.` (button exists after Task 17).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import * as store from '../src/inspector/store.js';
import Report from '../src/inspector/components/Report.jsx';

function mount() { const el = document.createElement('div'); render(h(Report, null), el); return el; }

describe('Report', () => {
  it('assembles header, strip, verdict, diagnosis and all sections in order', () => {
    store.data.value = { annotation: { id: 9, status: 'to_review', messages: [], labels: [], created_at: '2026-07-01T09:00:00Z' }, blocker: { content: [] }, content: { content: [] }, resolved: { usersById: {}, hooksById: {}, labelsById: {}, labelRules: [], queue: null, schema: null, document: null } };
    store.evidence.value = { items: [], verdict: { state: 'in-review', severity: 'warning', headline: 'In review', reasons: [] } };
    store.investigation.value = { stage: 'gathering', sourcesDone: 1, sourcesTotal: 9, activity: '' };
    const el = mount();
    const text = el.textContent;
    expect(el.querySelector('.inspector-rephead')).toBeTruthy();
    expect(el.querySelector('.inspector-inv')).toBeTruthy();
    expect(el.querySelector('.inspector-verdict')).toBeTruthy();
    expect(el.querySelector('.inspector-diag')).toBeTruthy();
    for (const t of ['Intake & origin', 'Blockers & messages', 'Fields', 'Extension runs', 'Labels', 'Rejection', 'Approval workflow', 'Export', 'Config drift']) {
      expect(text).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `Report.jsx`:**

```jsx
import { h } from 'preact';
import * as store from '../store.js';
import ReportHeader from './ReportHeader.jsx';
import InvestigationStrip from './InvestigationStrip.jsx';
import VerdictCard from './VerdictCard.jsx';
import DiagnosisPanel from './DiagnosisPanel.jsx';
import EvidenceSection from './EvidenceSection.jsx';
import IntakeSection from './IntakeSection.jsx';
import WorkflowSection from './WorkflowSection.jsx';
import DriftSection from './DriftSection.jsx';
import BlockedPanel from './BlockedPanel.jsx';
import ProvenancePanel from './ProvenancePanel.jsx';
import PipelinePanel from './PipelinePanel.jsx';
import LabelsPanel from './LabelsPanel.jsx';
import RejectedPanel from './RejectedPanel.jsx';
import ExportPanel from './ExportPanel.jsx';

function sectionStatus(section) {
  const ev = store.evidence.value;
  if (!ev) return 'pending';
  return ev.items.some((i) => i.section === section) ? 'loaded' : 'na';
}

// The single-column Diagnosis Report (spec §5).
export default function Report() {
  const d = store.data.value;
  if (!d) return null;
  const a = d.annotation;
  const attrs = Object.values(store.attributions.value);
  const attributing = attrs.some((x) => x.status === 'loading');
  const logs = store.enrichment.value.hookLogs;
  return (
    <div class="inspector-report">
      <ReportHeader />
      <InvestigationStrip />
      <VerdictCard />
      <DiagnosisPanel />
      <IntakeSection />
      <EvidenceSection id="blockers" title="Blockers & messages" count={`${(d.blocker?.content || []).length} blocker(s) · ${(a.messages || []).length} message(s)`} status={attributing ? 'attributing' : 'loaded'}>
        <BlockedPanel />
      </EvidenceSection>
      <EvidenceSection id="fields" title="Fields" status="loaded">
        <ProvenancePanel />
      </EvidenceSection>
      <EvidenceSection id="pipeline" title="Extension runs" status={logs === 'unavailable' ? 'unavailable' : 'sparse'}>
        <PipelinePanel />
      </EvidenceSection>
      <EvidenceSection id="labels" title="Labels" count={`${(a.labels || []).length} applied`} status={attributing ? 'attributing' : 'loaded'}>
        <LabelsPanel />
      </EvidenceSection>
      <EvidenceSection id="rejection" title="Rejection" status={sectionStatus('rejection')}>
        <RejectedPanel />
      </EvidenceSection>
      <WorkflowSection />
      <EvidenceSection id="export" title="Export" status={sectionStatus('export')}>
        <ExportPanel />
      </EvidenceSection>
      <DriftSection />
    </div>
  );
}
```

- [ ] **Step 4: Modify `App.jsx`** — delete `TABS`, the `useState` tab, and the per-tab renders; the connected branch becomes:

```jsx
  const d = store.data.value;
  return (
    <div class="app-root">
      <main class="main">
        <div class="inspector-root">
          <IdInput onSubmit={inspect} />
          {store.loading.value && <div class="inspector-loading">Loading{'…'}</div>}
          {store.error.value && <div class="error-banner">{store.error.value}</div>}
          {!d && !store.loading.value && <RecentAnnotations onSelect={inspect} />}
          {d && <Report />}
        </div>
      </main>
    </div>
  );
```

(Remove now-unused panel imports from App.jsx; keep the not-connected branch, with the copy fix.)

- [ ] **Step 5: Run** `npx vitest run tests/inspector-report.test.js tests/inspector-shell.test.js tests/inspector-components.test.js` — update any test asserting the old tab bar; expect PASS. Then `npm test` — full suite green.

---

### Task 17: Entry points — content-script button, background handler, popup

**Files:**
- Create: `src/rossum/features/inspect-annotation.js`
- Modify: `src/rossum/index.js`, `src/background/index.js`, `src/popup/components/App.jsx`, `src/popup/utils.js`
- Test: `tests/rossum-inspect-annotation.test.js`, `tests/background.test.js` (append — check the existing background test filename with `ls tests | grep -i background` and append there)

**Interfaces:**
- Consumes: the existing `consoleAuth_<uuid>` staging + `pendingAnnotationId` consumer (`src/console/index.jsx`), `openConsoleTab(tab, authData, app)` (popup utils — spreads `authData` into the staging entry, so `pendingAnnotationId` rides along).
- Produces:
  - `annotationIdFromPath(pathname) → string|null` and `init()` from the feature module; message `{type: 'openInspector', token, domain, annotationId}`.
  - background `openInspector(msg, deps)` staging `{app: 'inspector', pendingAnnotationId, token, domain, createdAt}`.
  - popup: `annotationIdFromUrl(url)` in `utils.js`; an "Inspect this annotation" button; `inspectAnnotationEnabled` toggle (**default ON** — stored value `false` disables; `undefined` counts as enabled).

- [ ] **Step 1: Write the failing feature test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { annotationIdFromPath, init } from '../src/rossum/features/inspect-annotation.js';

describe('annotationIdFromPath', () => {
  it('matches /document/<id> routes only', () => {
    expect(annotationIdFromPath('/document/4718203')).toBe('4718203');
    expect(annotationIdFromPath('/document/4718203/edit')).toBe('4718203');
    expect(annotationIdFromPath('/documents')).toBe(null);
    expect(annotationIdFromPath('/queues/1')).toBe(null);
  });
});

describe('init', () => {
  beforeEach(() => { document.body.innerHTML = ''; globalThis.chrome = { runtime: { sendMessage: vi.fn() } }; });
  it('injects the button on an annotation page and messages the worker on click', () => {
    window.history.replaceState(null, '', '/document/42');
    window.localStorage.setItem('secureToken', 'tok');
    init({ intervalMs: 0 });
    const btn = document.querySelector('#rossum-sa-extension-inspect-btn button');
    expect(btn).toBeTruthy();
    btn.click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'openInspector', token: 'tok', domain: window.location.origin, annotationId: '42',
    });
  });
  it('does not inject on non-annotation routes', () => {
    window.history.replaceState(null, '', '/annotations-list');
    init({ intervalMs: 0 });
    expect(document.querySelector('#rossum-sa-extension-inspect-btn')).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/rossum/features/inspect-annotation.js`** (same floating-card pattern as `dataset-mgmt-suggest.js`; the Rossum app is a SPA, so re-check the route on an interval and add/remove the button accordingly):

```js
// On a Rossum annotation view (/document/<id> — the id in that URL is the
// ANNOTATION id), offer a one-click jump into the Console Inspector. Mirrors
// dataset-mgmt-suggest: floating bottom-right card, background worker opens the
// extension page (content scripts can't chrome.tabs.create).
const WRAP_ID = 'rossum-sa-extension-inspect-btn';
const STYLE_ID = 'rossum-sa-extension-inspect-style';

export function annotationIdFromPath(pathname) {
  const m = /^\/document\/(\d+)(?:[/?#]|$)/.exec(String(pathname || ''));
  return m ? m[1] : null;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${WRAP_ID} { position: fixed; bottom: 16px; right: 16px; z-index: 2147483646; }
#${WRAP_ID} button {
  background: linear-gradient(90deg, #4270db, #5b8af0); color: #fff; border: none;
  border-radius: 10px; padding: 8px 14px; font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.28);
}
#${WRAP_ID} button:hover { filter: brightness(1.06); }`;
  (document.head || document.documentElement)?.appendChild(style);
}

function sync() {
  const annotationId = annotationIdFromPath(window.location.pathname);
  const existing = document.getElementById(WRAP_ID);
  if (!annotationId) { if (existing) existing.remove(); return; }
  if (existing) { existing.dataset.annId = annotationId; return; }
  ensureStyle();
  const wrap = document.createElement('div');
  wrap.id = WRAP_ID;
  wrap.dataset.annId = annotationId;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '🔎 Inspect this annotation';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'openInspector',
      token: window.localStorage.getItem('secureToken'),
      domain: window.location.origin,
      annotationId: wrap.dataset.annId,
    });
  });
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
}

export function init({ intervalMs = 1500 } = {}) {
  sync();
  if (intervalMs > 0) setInterval(sync, intervalMs); // SPA route changes
}
```

- [ ] **Step 4: Wire into `src/rossum/index.js`** — add `'inspectAnnotationEnabled'` to `SETTINGS_KEYS`, import `{ init as initInspectAnnotation } from './features/inspect-annotation.js';`, and inside the settings callback add (default-ON semantics — only an explicit `false` disables):

```js
  if (settings.inspectAnnotationEnabled !== false) initInspectAnnotation();
```

- [ ] **Step 5: Extend `src/background/index.js`** — add alongside `openDatasetManagement`:

```js
export function openInspector(msg, deps) {
  const { storageSet, tabsCreate, getURL, uuid, now } = deps;
  const authId = uuid();
  const opts = { url: getURL(`console/console.html?authId=${authId}`) };
  const opener = msg.openerTab;
  if (opener && typeof opener.index === 'number') {
    opts.index = opener.index + 1;
    opts.windowId = opener.windowId;
  }
  storageSet(
    { [`consoleAuth_${authId}`]: { token: msg.token, domain: msg.domain, app: 'inspector', pendingAnnotationId: msg.annotationId, createdAt: now() } },
    () => tabsCreate(opts),
  );
  return authId;
}
```

…and in the message listener add before the existing check:

```js
    if (msg?.type === 'openInspector' && sender.id === chrome.runtime.id) {
      openInspector({ ...msg, openerTab: sender.tab }, realDeps);
      return;
    }
```

Append a background test (same deps-injection style as the existing `openDatasetManagement` tests):

```js
it('openInspector stages app+pendingAnnotationId then opens the console', () => {
  const stored = {}; const created = [];
  const deps = { storageSet: (o, cb) => { Object.assign(stored, o); cb(); }, tabsCreate: (o) => created.push(o), getURL: (p) => `chrome-extension://x/${p}`, uuid: () => 'u1', now: () => 123 };
  openInspector({ token: 't', domain: 'https://org.example', annotationId: '42' }, deps);
  expect(stored.consoleAuth_u1).toEqual({ token: 't', domain: 'https://org.example', app: 'inspector', pendingAnnotationId: '42', createdAt: 123 });
  expect(created[0].url).toContain('authId=u1');
});
```

- [ ] **Step 6: Popup.** In `src/popup/utils.js` add:

```js
// The /document/<id> path segment on a Rossum page is the ANNOTATION id.
export function annotationIdFromUrl(url) {
  try { const u = new URL(url); return /^\/document\/(\d+)(?:[/?#]|$)/.exec(u.pathname)?.[1] || null; } catch { return null; }
}
```

In `src/popup/components/App.jsx`: add `'inspectAnnotationEnabled'` to `STORAGE_TOGGLES`; in the storage-fill effect give it default-on semantics (`filled[key] = key === 'inspectAnnotationEnabled' ? vals[key] !== false : !!vals[key]`); add next to `onRossumConsole`:

```jsx
  const annId = annotationIdFromUrl(tab?.url || '');
  const onInspectAnnotation = () => fetchAuthAndOpen((t, auth) => openConsoleTab(t, { ...auth, pendingAnnotationId: annId }, 'inspector'));
```

…render a button in the Rossum card (only when `site === 'rossum' && annId`), styled like the existing Console button row:

```jsx
  {annId ? (
    <button class="console-open-btn" onClick={onInspectAnnotation}>
      Inspect this annotation <ExternalIcon />
    </button>
  ) : null}
```

(match the actual class/markup of the existing "Dataset Management" button in that file — reuse its exact structure) …and a `Toggle` in the Rossum section:

```jsx
  <Toggle
    label="Inspect-annotation button"
    description="Floating button on annotation pages that opens the Inspector"
    checked={storageValues.inspectAnnotationEnabled}
    onChange={(v) => setStorageToggle('inspectAnnotationEnabled', v)}
  />
```

- [ ] **Step 7: Run** `npx vitest run tests/rossum-inspect-annotation.test.js` plus the background + popup test files (`ls tests | grep -iE 'background|popup'` to find them) — expect PASS.

---

### Task 18: Finalize — full suite, build, docs

**Files:**
- Modify: `CLAUDE.md`
- Test: full suite

- [ ] **Step 1: Full suite** — `npm test` → all green. Fix any straggler (most likely: old copy assertions).
- [ ] **Step 2: Build** — `npm run build` → completes without errors (the extension runs from `dist/`).
- [ ] **Step 3: Update `CLAUDE.md`:**
  - Add an **Inspector** subsection under Architecture (mirroring the MDH/Audit/Galaxy ones) describing: Diagnosis Report layout, `evidence.js`/`synthesize.js`/`driftDiff.js`/`promptBudget.js`, the staged lifecycle, citation chips, the entry points (content-script feature + popup button + background `openInspector`), and the read-only stance.
  - Chrome Storage Keys: add `inspectAnnotationEnabled` to the feature-toggles line (note default-ON semantics: only explicit `false` disables).
- [ ] **Step 4: Manual smoke test note for the user** (do not skip reporting this): reload the unpacked extension from `dist/`, open a Rossum annotation, click the new floating button, and confirm the Console opens the Inspector on that annotation with the progressive report filling in. Report the result honestly — including anything not exercised (e.g., agent offline path if the agent was up).

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** §4.1→T2-4, §4.2→T2, §4.3→T7/T9/T12, §4.4→T6/T13, §4.5→T5/T14, §5→T10-16, §6→T8, §7→T17, §8→T0, §9→woven into T9/T13/T14 (abort/offline/409/unresolvable-citation), §10→no-migration checks in T7/T16/T17 (additive keys only), §11→global constraints, §12→per-task tests. Gap check: none found.
- **Type consistency:** evidence item ids (`message:<i>`, `blocker:<i>`, `field:<schemaId>`, `label:<id>`, `reject`, `export`, `intake:*`, `workflow:*`, `gap:*`) are defined in T3/T4 and consumed verbatim in T13 (citation resolution) and T15 (anchors). `investigation.stage` vocabulary is identical in T7/T9/T12/T13. `runSynthesis` signature matches between T6 and T9.
- **Placeholder scan:** T15 Step 1 intentionally references the file's existing fixtures (appending to an existing test file); all new files carry complete code.
