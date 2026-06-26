# AI Query Details Modal — Clarity Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the "AI query details" modal (`AiRunTraceDetails`) into one humanized, structured-and-explained step-by-step trace — replacing the duplicate jargon timeline + round cards — without changing the trace data, the loop, or the collapsed bar.

**Architecture:** A pure, testable `buildStepViews(trace)` (+ `outcomeBanner`, `contextBits` and small label maps) turns the existing `trace` into a render model; `AiRunTraceDetails` maps it to a request/outcome header + a single numbered step spine (humanized action + approach pill + state chip + "why" + collapsible query and collapsible result sample) + a humanized context line + a collapsed glossary. New `.ai-trace-*` CSS reusing existing console tokens.

**Tech Stack:** Preact (classic JSX `h`), vitest (jsdom), esbuild; the existing `trace` object from `buildTrace`.

## Global Constraints

- **Render-only.** Do NOT change `buildTrace`, the loop, `trace.calls`/`rounds`/`hints` shape, or the collapsed `AiRunTrace` bar / its summary. New exports are additive.
- **Keep the `.ai-trace-body` class** on the modal's inner wrapper — `.modal-card:has(.ai-trace-body)` (console.css:1452) sets the modal width and a test asserts `.ai-trace-body` exists.
- **Reuse existing tokens only:** `--accent`, `--success`/`--warning`/`--danger` (+ `-bg`/`-fg`), `--border`, `--bg-card`, `--bg-code`, `--text-primary`/`--text-secondary`, `--font-mono`, `--radius`. No new/undefined CSS variables.
- **JSX unicode (per CLAUDE.md):** `\uXXXX` does NOT work in JSX text/attributes. Use literal glyphs (`·`, `–`, `“`, `”`, `✓`, `⚠`, `✕`) directly in JSX text, or JS expressions. Chevrons live in CSS `content:` (fine).
- **No customer data** in tests/fixtures — synthetic only.
- **No git commits/staging during implementation** (user workflow preference). Stay on `master`; end each task with the suite (and build, for the UI task) green.
- **Omit per-step durations**; the "Refined" step node uses the warning hue (approved mockup choices).

---

### Task 1: Pure view-model — `buildStepViews`, `outcomeBanner`, `contextBits` (`AiRunTrace.jsx`)

Add the pure humanization helpers as exported functions. The component still
renders the old way after this task (helpers unused yet) → the existing suite
stays green.

**Files:**
- Modify: `src/mdh/components/AiRunTrace.jsx` (add exported pure functions near the top, below the imports)
- Test: `tests/mdh-ai-run-trace.test.js` (append a new `describe` block; add the new names to the import)

**Interfaces:**
- Consumes: a `trace` object `{ request, status, corrected, calls:[{kind,round,angle?,status}], rounds:[{trigger?,reasoning?,candidates:[{angle,pipelineText,verdict,rowCount,error?,sample?,score?,issue?,picked,applied}]}], hints }`.
- Produces:
  - `buildStepViews(trace) → Step[]`, `Step = { kind:'write'|'refine'|'check', action, approach?, note?, why?, chip:{text,tone:'ok'|'warn'|'bad'|'neutral'}, pipelineText?, sample?, rowCount? }`.
  - `outcomeBanner(trace) → { tone:'ok'|'warn'|'bad'|'neutral', icon, text, tag? } | null`.
  - `contextBits(hints) → string[]`.
  - `sampleColumns(rows) → string[]` (exported; used by the render + tested).

- [ ] **Step 1: Write the failing tests**

Add `buildStepViews, outcomeBanner, contextBits, sampleColumns` to the existing import line in `tests/mdh-ai-run-trace.test.js`, then append:

```js
describe('buildStepViews (humanized step model)', () => {
  const happy = {
    request: 'q', status: 'ok', corrected: false,
    calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'passed' }],
    rounds: [{ kind: 'initial', reasoning: 'rows match the request',
      candidates: [{ angle: 'exact', pipelineText: '[{"$limit":12}]', verdict: 'ok', rowCount: 12, sample: [{ a: 1 }], score: 95, picked: true, applied: true }] }],
  };
  it('happy path → [write, check] with humanized labels, query + sample on write', () => {
    const s = buildStepViews(happy);
    expect(s.map((x) => x.kind)).toEqual(['write', 'check']);
    expect(s[0].action).toBe('Wrote a query');
    expect(s[0].approach).toBe('direct approach');
    expect(s[0].chip).toEqual({ text: '12 rows', tone: 'ok' });
    expect(s[0].pipelineText).toBe('[{"$limit":12}]');
    expect(s[0].sample).toEqual([{ a: 1 }]);
    expect(s[1].action).toBe('Checked the result');
    expect(s[1].chip).toEqual({ text: 'looks right · 95/100', tone: 'ok' });
    expect(s[1].why).toBe('rows match the request');
  });
  it('self-corrected (empty → minimal fix → passed) → [write, refine, check] with why', () => {
    const t = {
      request: 'q', status: 'ok', corrected: true,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'empty' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
      rounds: [
        { kind: 'initial', candidates: [{ angle: 'exact', pipelineText: '[]', verdict: 'empty', rowCount: 0, picked: true, applied: false }] },
        { kind: 'correction', trigger: 'empty', reasoning: 'now matches',
          candidates: [{ angle: 'exact', pipelineText: '[]', verdict: 'empty', rowCount: 0, picked: false, applied: false },
            { angle: 'minimal', pipelineText: '[{"$match":{"x":1}}]', verdict: 'ok', rowCount: 8, sample: [{ x: 1 }], score: 90, picked: true, applied: true }] },
      ],
    };
    const s = buildStepViews(t);
    expect(s.map((x) => x.kind)).toEqual(['write', 'refine', 'check']);
    expect(s[1].action).toBe('Refined the query');
    expect(s[1].approach).toBe('minimal fix');
    expect(s[1].why).toBe('Retried because the previous query returned no rows.');
    expect(s[1].chip).toEqual({ text: '8 rows', tone: 'ok' });
  });
  it('mismatch refine → why includes the incumbent issue', () => {
    const t = { request: 'q', status: 'ok', corrected: true,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'flagged' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
      rounds: [
        { kind: 'initial', candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, issue: 'wrong field', picked: true, applied: false }] },
        { kind: 'correction', trigger: 'mismatch',
          candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, issue: 'wrong field', picked: false, applied: false },
            { angle: 'minimal', verdict: 'ok', rowCount: 7, picked: true, applied: true }] },
      ] };
    expect(buildStepViews(t)[2].why).toBe('Retried because the check found: wrong field.');
  });
  it('a failed fix call (no candidate) → chip but no query/sample', () => {
    const t = { request: 'q', status: 'ok', corrected: false,
      calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'flagged' },
        { kind: 'fix', round: 2, angle: 'minimal', status: 'failed' }],
      rounds: [{ kind: 'initial', candidates: [{ angle: 'exact', verdict: 'ok', rowCount: 5, picked: true, applied: true }] }] };
    const last = buildStepViews(t).at(-1);
    expect(last.kind).toBe('refine');
    expect(last.chip).toEqual({ text: "couldn't write a query", tone: 'bad' });
    expect(last.pipelineText).toBeUndefined();
    expect(last.sample).toBeUndefined();
  });
  it('no calls → []', () => {
    expect(buildStepViews({ request: 'q', status: 'ok', rounds: [] })).toEqual([]);
  });
});

describe('outcomeBanner', () => {
  const mk = (status, applied, calls, corrected) => ({ status, corrected,
    calls: calls || [], rounds: [{ candidates: [applied] }] });
  it('ok + checked', () => {
    const b = outcomeBanner(mk('ok', { applied: true, rowCount: 12, verdict: 'ok' }, [{ kind: 'verify', status: 'passed' }]));
    expect(b).toMatchObject({ tone: 'ok', icon: '✓', text: 'Applied a checked query — 12 rows.' });
  });
  it('ok + not checked → "(not checked)"', () => {
    const b = outcomeBanner(mk('ok', { applied: true, rowCount: 1, verdict: 'ok' }, []));
    expect(b.text).toBe('Applied a query — 1 row (not checked).');
  });
  it('empty / error / unverified / no-chosen + self-corrected tag', () => {
    expect(outcomeBanner(mk('empty', { applied: true, rowCount: 0, verdict: 'empty' }, [{ kind: 'verify', status: 'flagged' }])).tone).toBe('warn');
    expect(outcomeBanner(mk('error', { applied: true, verdict: 'error', error: 'bad stage' }, [])).text).toBe('Query failed: bad stage.');
    expect(outcomeBanner(mk('unverified', { applied: true, verdict: 'unrun' }, [])).text).toBe('Query ready — not run.');
    expect(outcomeBanner({ status: 'ok', rounds: [], calls: [] }).text).toBe('No usable query produced.');
    expect(outcomeBanner(mk('ok', { applied: true, rowCount: 3, verdict: 'ok' }, [{ kind: 'verify', status: 'passed' }], true)).tag).toBe('self-corrected');
  });
});

describe('contextBits', () => {
  it('humanizes hints', () => {
    expect(contextBits({ collection: 'vendors', fields: 12, knownValues: ['state', 'country'], searchIndexes: ['default'], ranges: 1 }))
      .toEqual(['collection vendors', '12 fields', 'sample values for state, country', 'search index default', '1 numeric range']);
  });
  it('empty hints → []', () => { expect(contextBits({})).toEqual([]); });
});

describe('sampleColumns', () => {
  it('first-seen order, excludes _id', () => {
    expect(sampleColumns([{ _id: 1, name: 'a', qty: 2 }, { name: 'b', extra: 9 }])).toEqual(['name', 'qty', 'extra']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: FAIL — `buildStepViews`/`outcomeBanner`/`contextBits`/`sampleColumns` are not exported.

- [ ] **Step 3: Implement**

In `src/mdh/components/AiRunTrace.jsx`, add below the `import` line (above `DOT_CLASS`):

```js
// ---- Pure humanization view-model (DOM-free; rendered by AiRunTraceDetails) --
const APPROACH = { exact: 'direct approach', tolerant: 'format-tolerant', minimal: 'minimal fix', rethink: 'rebuilt' };
const APPROACH_NOTE = {
  exact: 'Translated your request literally, matching stored values exactly.',
  tolerant: 'Allowed for value/format differences (case, codes, text matching).',
  minimal: 'Smallest change to the previous attempt that could fix it.',
  rethink: 'Rewrote the query from scratch with a different strategy.',
};
const TRIGGER_REASON = { empty: 'the previous query returned no rows', error: 'the previous query hit a database error', mismatch: 'the check found' };

function verdictChip(verdict, rowCount) {
  switch (verdict) {
    case 'ok': return { text: `${rowCount} row${rowCount === 1 ? '' : 's'}`, tone: 'ok' };
    case 'empty': return { text: '0 rows · no matches', tone: 'warn' };
    case 'error': return { text: 'database error', tone: 'bad' };
    case 'invalid': return { text: 'not a valid query', tone: 'bad' };
    case 'unrun': return { text: 'ready · not run', tone: 'neutral' };
    case 'failed': return { text: "couldn't write a query", tone: 'bad' };
    case 'duplicate': return { text: 'repeated a previous attempt', tone: 'neutral' };
    default: return { text: String(verdict || 'done'), tone: 'neutral' };
  }
}
function checkChip(status, score) {
  if (status === 'passed') return { text: typeof score === 'number' ? `looks right · ${score}/100` : 'looks right', tone: 'ok' };
  if (status === 'flagged') return { text: "doesn't fully match", tone: 'warn' };
  if (status === 'parse-fail') return { text: "couldn't verify automatically", tone: 'neutral' };
  return { text: 'check failed', tone: 'neutral' };
}

// One render-ready step per LLM call, joined to its round/candidate detail.
export function buildStepViews(trace) {
  if (!trace || !Array.isArray(trace.calls) || trace.calls.length === 0) return [];
  const rounds = Array.isArray(trace.rounds) ? trace.rounds : [];
  return trace.calls.map((call) => {
    const round = rounds[(call.round || 1) - 1];
    const cands = (round && round.candidates) || [];
    if (call.kind === 'verify') {
      const chosen = cands.find((c) => c.picked) || cands.find((c) => c.applied);
      return { kind: 'check', action: 'Checked the result',
        chip: checkChip(call.status, chosen && chosen.score),
        why: round && round.reasoning ? round.reasoning : undefined };
    }
    const cand = cands.find((c) => c.angle === call.angle);
    const verdict = cand ? cand.verdict : call.status; // failed/duplicate have no candidate
    const step = {
      kind: call.kind === 'fix' ? 'refine' : 'write',
      action: call.kind === 'fix' ? 'Refined the query' : 'Wrote a query',
      approach: APPROACH[call.angle] || call.angle,
      note: APPROACH_NOTE[call.angle],
      chip: verdictChip(verdict, cand ? cand.rowCount : 0),
      pipelineText: cand ? cand.pipelineText : undefined,
      sample: cand && Array.isArray(cand.sample) && cand.sample.length ? cand.sample : undefined,
      rowCount: cand ? cand.rowCount : undefined,
    };
    if (call.kind === 'fix' && round) {
      const reason = TRIGGER_REASON[round.trigger];
      if (reason) {
        const issue = round.trigger === 'mismatch' ? (cands.find((c) => c.angle !== call.angle) || {}).issue : undefined;
        step.why = `Retried because ${reason}${issue ? `: ${issue}` : ''}.`;
      }
    }
    return step;
  });
}

function appliedCandidate(trace) {
  for (const r of (trace.rounds || [])) for (const c of (r.candidates || [])) if (c.applied) return c;
  return null;
}
export function outcomeBanner(trace) {
  if (!trace) return null;
  const truncate = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const calls = Array.isArray(trace.calls) ? trace.calls : [];
  const lastVerify = [...calls].reverse().find((c) => c.kind === 'verify');
  const checked = !!lastVerify && lastVerify.status === 'passed';
  const applied = appliedCandidate(trace);
  const tag = trace.corrected ? 'self-corrected' : undefined;
  const n = applied ? (applied.rowCount || 0) : 0;
  const rows = `${n} row${n === 1 ? '' : 's'}`;
  switch (trace.status) {
    case 'error': return { tone: 'bad', icon: '✕', text: `Query failed${applied && applied.error ? `: ${truncate(applied.error, 80)}` : ''}.`, tag };
    case 'unverified': return { tone: 'neutral', icon: '•', text: 'Query ready — not run.', tag };
    case 'empty': return { tone: 'warn', icon: '⚠', text: 'Applied — 0 rows (no matches).', tag };
    case 'ok': return checked
      ? { tone: 'ok', icon: '✓', text: `Applied a checked query — ${rows}.`, tag }
      : { tone: 'ok', icon: '✓', text: `Applied a query — ${rows} (not checked).`, tag };
    default: return { tone: 'bad', icon: '✕', text: 'No usable query produced.', tag };
  }
}

export function contextBits(hints = {}) {
  const b = [];
  if (hints.collection) b.push(`collection ${hints.collection}`);
  if (hints.fields) b.push(`${hints.fields} field${hints.fields === 1 ? '' : 's'}`);
  if (hints.knownValues && hints.knownValues.length) b.push(`sample values for ${hints.knownValues.join(', ')}`);
  if (hints.searchIndexes && hints.searchIndexes.length) b.push(`search index ${hints.searchIndexes.join(', ')}`);
  if (hints.ranges) b.push(`${hints.ranges} numeric range${hints.ranges === 1 ? '' : 's'}`);
  if (hints.numericStrings && hints.numericStrings.length) b.push(`${hints.numericStrings.length} number-like text field${hints.numericStrings.length === 1 ? '' : 's'}`);
  if (hints.arrayPaths && hints.arrayPaths.length) b.push(`${hints.arrayPaths.length} array field${hints.arrayPaths.length === 1 ? '' : 's'}`);
  return b;
}

export function sampleColumns(rows) {
  const cols = [];
  for (const r of (Array.isArray(rows) ? rows : [])) for (const k of Object.keys(r || {})) if (k !== '_id' && !cols.includes(k)) cols.push(k);
  return cols;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: PASS — new pure tests + all existing tests (the old render is untouched).

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-ai-run-trace.test.js` green. (No commit.)

---

### Task 2: Render rewrite + CSS + render tests (`AiRunTrace.jsx`, `console.css`)

Replace `AiRunTraceDetails`'s body (the `CallPath` timeline + round cards) with
the unified step view; swap the modal-detail CSS; rewrite the modal render tests
(keep the bar tests).

**Files:**
- Modify: `src/mdh/components/AiRunTrace.jsx` (rewrite `AiRunTraceDetails`; delete `CALL_KIND`/`callLabel`/`groupCalls`/`CallPath`, `verdictLabel`, `hintsLine`, `TRIGGER_WHY`/`roundTitle`)
- Modify: `src/console/console.css` (replace lines `.ai-trace-body { … }` through `.ai-trace-call-error… { … }` — the modal-detail block — with the new block; keep the bar rules `.ai-trace`…`.ai-trace-chevron` above it)
- Test: `tests/mdh-ai-run-trace.test.js` (rewrite the modal-content tests; keep the bar tests)

**Interfaces:**
- Consumes: `buildStepViews`, `outcomeBanner`, `contextBits`, `sampleColumns` (Task 1).
- Produces: the same exports (`AiRunTraceDetails` named, `AiRunTrace` default). No new exports.

- [ ] **Step 1: Rewrite the modal-content tests (write the failing tests)**

In `tests/mdh-ai-run-trace.test.js`, REPLACE the two old fixtures (`trace` and `correctedTrace`) and the `describe('AiRunTrace (compact bar → modal)', …)` block's modal-content tests + the old `AiRunTrace call-path timeline` describe block with the following. KEEP the bar-structure tests but update the click-opens-modal content assertions. Final fixtures + tests:

```js
const trace = {
  request: 'products under 50 in Tools', status: 'ok', summary: 'AI-checked · 12 rows', corrected: false,
  calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'ok' }, { kind: 'verify', round: 1, status: 'passed' }],
  rounds: [{ kind: 'initial', reasoning: 'all rows match', candidates: [
    { angle: 'exact', pipelineText: '[{"$limit":12}]', verdict: 'ok', rowCount: 12, sample: [{ sku: 'A1', price: 9 }], score: 95, picked: true, applied: true },
  ] }],
  hints: { collection: 'products', fields: 9, knownValues: ['category'], ranges: 1 },
};
const correctedTrace = {
  request: 'vendors in California', status: 'ok', summary: 'AI-checked · 8 rows', corrected: true,
  calls: [{ kind: 'generate', round: 1, angle: 'exact', status: 'empty' },
    { kind: 'fix', round: 2, angle: 'minimal', status: 'ok' }, { kind: 'verify', round: 2, status: 'passed' }],
  rounds: [
    { kind: 'initial', candidates: [{ angle: 'exact', pipelineText: '[{"$match":{"state":"California"}}]', verdict: 'empty', rowCount: 0, picked: true, applied: false }] },
    { kind: 'correction', trigger: 'empty', reasoning: 'now matches', candidates: [
      { angle: 'exact', pipelineText: '[{"$match":{"state":"California"}}]', verdict: 'empty', rowCount: 0, picked: false, applied: false },
      { angle: 'minimal', pipelineText: '[{"$match":{"state":"CA"}}]', verdict: 'ok', rowCount: 8, sample: [{ name: 'Northwind', state: 'CA' }], score: 90, picked: true, applied: true },
    ] },
  ],
  hints: { collection: 'vendors', fields: 12 },
};

describe('AiRunTrace bar', () => {
  beforeEach(() => { modalContent.value = null; });
  it('renders nothing without a trace', () => { expect(mount(AiRunTrace, { trace: null }).textContent).toBe(''); });
  it('shows summary + status dot, no detail inline', () => {
    const root = mount(AiRunTrace, { trace });
    expect(root.textContent).toContain('AI-checked · 12 rows');
    expect(root.querySelector('.ai-trace-dot')).toBeTruthy();
    expect(root.querySelector('.ai-trace-body')).toBeNull();
  });
  it('shows the self-corrected tag when corrected', () => {
    expect(mount(AiRunTrace, { trace: correctedTrace }).querySelector('.ai-trace-tag')).toBeTruthy();
  });
});

describe('AiRunTraceDetails (humanized step view)', () => {
  it('renders nothing without a trace', () => { expect(mount(AiRunTraceDetails, { trace: null }).textContent).toBe(''); });
  it('shows request, outcome, numbered steps, chips, glossary', () => {
    const root = mount(AiRunTraceDetails, { trace });
    expect(root.querySelector('.ai-trace-body')).toBeTruthy();
    expect(root.textContent).toContain('You asked');
    expect(root.textContent).toContain('products under 50 in Tools');
    expect(root.querySelector('.ai-trace-outcome-ok')).toBeTruthy();
    expect(root.textContent).toContain('Applied a checked query — 12 rows');
    expect(root.querySelectorAll('.ai-trace-stepc')).toHaveLength(2);
    expect(root.textContent).toContain('Wrote a query');
    expect(root.textContent).toContain('direct approach');
    expect(root.textContent).toContain('looks right · 95/100');
    expect(root.querySelector('.ai-trace-node-check')).toBeTruthy();
    expect(root.textContent).toContain('What the AI knew');
    expect(root.textContent).toContain('collection products');
    expect(root.querySelector('.ai-trace-glossary')).toBeTruthy();
    expect(root.textContent).not.toContain('verified ·'); // no leftover jargon marker
  });
  it('shows query + result-sample collapsibles whose content reveals on open', () => {
    const root = mount(AiRunTraceDetails, { trace });
    const discs = root.querySelectorAll('details.ai-trace-disc');
    expect(discs.length).toBe(2); // Show query + Show results
    expect(root.textContent).toContain('Show query');
    expect(root.textContent).toContain('Show results');
    expect(root.querySelector('.ai-trace-query').textContent).toContain('$limit');
    expect(root.querySelector('.ai-trace-rows')).toBeTruthy(); // sample table present
    expect(root.textContent).toContain('sku');
  });
  it('corrected run → 3 steps incl. a refine with a why, and self-corrected tag', () => {
    const root = mount(AiRunTraceDetails, { trace: correctedTrace });
    expect(root.querySelectorAll('.ai-trace-stepc')).toHaveLength(3);
    expect(root.textContent).toContain('Refined the query');
    expect(root.textContent).toContain('minimal fix');
    expect(root.textContent).toContain('Retried because the previous query returned no rows');
    expect(root.querySelector('.ai-trace-node-refine')).toBeTruthy();
    expect(root.querySelector('.ai-trace-outcome-tag')).toBeTruthy();
  });
  it('opens from the bar with the new content', () => {
    const root = mount(AiRunTrace, { trace });
    root.querySelector('.ai-trace-bar').click();
    expect(modalContent.value.title).toBe('AI query details');
    const body = document.createElement('div');
    render(modalContent.value.render(), body);
    expect(body.querySelector('.ai-trace-body')).toBeTruthy();
    expect(body.textContent).toContain('Wrote a query');
  });
});
```

(Delete the old fixtures/tests that referenced `.ai-trace-timeline`, `.ai-trace-step-parallel`, `.ai-trace-call`, `Initial · 2 candidates`, `Correction 1 · fixing`, `.ai-trace-applied`, `.ai-trace-cand-chosen`, `tolerant`, `too broad`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: FAIL — the current `AiRunTraceDetails` renders the timeline + round cards, not `.ai-trace-stepc`/`.ai-trace-outcome-ok`/etc.

- [ ] **Step 3: Implement the render**

In `src/mdh/components/AiRunTrace.jsx`, DELETE the now-unused helpers `CALL_KIND`, `callLabel`, `groupCalls`, `CallPath`, `verdictLabel`, `hintsLine`, `TRIGGER_WHY`, `roundTitle`. Replace the whole `export function AiRunTraceDetails({ trace }) { … }` with:

```jsx
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function ResultSample({ rows, rowCount }) {
  const cols = sampleColumns(rows);
  const shown = rows.length;
  const cap = typeof rowCount === 'number' && rowCount > shown ? `${shown} of ${rowCount}` : `${shown} row${shown === 1 ? '' : 's'}`;
  return (
    <details class="ai-trace-disc">
      <summary>{`Show results (${cap})`}</summary>
      <div class="ai-trace-results">
        <table class="ai-trace-rows">
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          {rows.map((r, ri) => <tr key={ri}>{cols.map((c) => <td key={c}>{cellText(r[c])}</td>)}</tr>)}
        </table>
      </div>
    </details>
  );
}

// The full run detail — a single humanized, structured step-by-step trace,
// rendered INSIDE the "AI query details" modal. The `.ai-trace-body` wrapper is
// kept (it drives the modal width via `.modal-card:has(.ai-trace-body)`).
export function AiRunTraceDetails({ trace }) {
  if (!trace) return null;
  const banner = outcomeBanner(trace);
  const steps = buildStepViews(trace);
  const ctx = contextBits(trace.hints || {});
  return (
    <div class="modal-body">
      <div class="ai-trace-body">
        {trace.request && (
          <div>
            <div class="ai-trace-ask-label">You asked</div>
            <div class="ai-trace-ask-text">“{trace.request}”</div>
          </div>
        )}
        {banner && (
          <div class={`ai-trace-outcome ai-trace-outcome-${banner.tone}`}>
            <span class="ai-trace-outcome-ic">{banner.icon}</span>
            <span class="ai-trace-outcome-text">{banner.text}</span>
            {banner.tag && <span class="ai-trace-outcome-tag">{banner.tag}</span>}
          </div>
        )}
        {steps.length > 0 && (
          <div class="ai-trace-steps">
            {steps.map((s, i) => (
              <div key={i} class="ai-trace-stepc">
                <div class="ai-trace-rail">
                  <div class={`ai-trace-node ai-trace-node-${s.kind}`}>{i + 1}</div>
                  {i < steps.length - 1 && <div class="ai-trace-connector" />}
                </div>
                <div class="ai-trace-stepbody">
                  <div class="ai-trace-row1">
                    <span class="ai-trace-action">{s.action}</span>
                    {s.approach && <span class="ai-trace-approach">{s.approach}</span>}
                    <span class={`ai-trace-chip ai-trace-chip-${s.chip.tone}`}>{s.chip.text}</span>
                  </div>
                  {s.note && <div class="ai-trace-note">{s.note}</div>}
                  {s.why && <div class="ai-trace-why">{s.why}</div>}
                  {s.pipelineText && (
                    <details class="ai-trace-disc">
                      <summary>Show query</summary>
                      <pre class="ai-trace-query">{s.pipelineText}</pre>
                    </details>
                  )}
                  {s.sample && <ResultSample rows={s.sample} rowCount={s.rowCount} />}
                </div>
              </div>
            ))}
          </div>
        )}
        {ctx.length > 0 && (
          <div class="ai-trace-context"><span class="ai-trace-context-k">What the AI knew:</span> {ctx.join(' · ')}</div>
        )}
        <details class="ai-trace-glossary">
          <summary>What these terms mean</summary>
          <dl class="ai-trace-terms">
            <dt>Approach</dt>
            <dd>direct = literal translation, exact matches · format-tolerant = flexible matching · minimal fix = smallest change to the previous try · rebuilt = rewritten from scratch.</dd>
            <dt>Checked / score</dt>
            <dd>After running, the AI judges how well the rows answer your request (0–100). A mismatch or low score triggers a refine.</dd>
            <dt>What the AI knew</dt>
            <dd>Facts about your collection given to the AI to write a better query — fields, sample values, ranges, search indexes.</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace the CSS**

In `src/console/console.css`, replace the modal-detail block — every rule from
`.ai-trace-body { … }` through the final `.ai-trace-call-error, … { border-color: var(--danger); }`
(the rules added for the old round cards + timeline) — with this block. KEEP the
bar rules above it (`.ai-trace` … `.ai-trace-chevron`) unchanged:

```css
.ai-trace-body { padding: 6px 2px 4px; display: flex; flex-direction: column; }
.ai-trace-ask-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-secondary); font-weight: 600; }
.ai-trace-ask-text { font-size: 14px; line-height: 1.4; margin: 2px 0 10px; color: var(--text-primary); }
.ai-trace-outcome { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border-radius: var(--radius); font-size: 12.5px; font-weight: 550; }
.ai-trace-outcome-ic { flex: 0 0 auto; }
.ai-trace-outcome-text { min-width: 0; }
.ai-trace-outcome-ok { background: var(--success-bg); color: var(--success-fg); }
.ai-trace-outcome-warn { background: var(--warning-bg); color: var(--warning-fg); }
.ai-trace-outcome-bad { background: var(--danger-bg); color: var(--danger-fg); }
.ai-trace-outcome-neutral { background: var(--bg-code); color: var(--text-secondary); }
.ai-trace-outcome-tag { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; opacity: 0.8; }
.ai-trace-steps { margin: 14px 0 4px; display: flex; flex-direction: column; }
.ai-trace-stepc { display: grid; grid-template-columns: 22px 1fr; gap: 10px; padding-bottom: 14px; }
.ai-trace-stepc:last-child { padding-bottom: 0; }
.ai-trace-rail { display: flex; flex-direction: column; align-items: center; }
.ai-trace-node { width: 20px; height: 20px; border-radius: 50%; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; border: 2px solid var(--border); background: var(--bg-card); color: var(--text-secondary); }
.ai-trace-node-write { border-color: var(--accent); color: var(--accent); }
.ai-trace-node-check { border-color: var(--accent); background: var(--accent); color: #fff; }
.ai-trace-node-refine { border-color: var(--warning); color: var(--warning); }
.ai-trace-connector { flex: 1 1 auto; width: 2px; background: var(--border); margin: 2px 0; }
.ai-trace-stepbody { min-width: 0; padding-top: 1px; }
.ai-trace-row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ai-trace-action { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.ai-trace-approach { font-size: 10px; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; background: var(--bg-code); }
.ai-trace-chip { font-size: 10px; font-weight: 650; border-radius: 20px; padding: 1px 9px; margin-left: auto; white-space: nowrap; }
.ai-trace-chip-ok { background: var(--success-bg); color: var(--success-fg); }
.ai-trace-chip-warn { background: var(--warning-bg); color: var(--warning-fg); }
.ai-trace-chip-bad { background: var(--danger-bg); color: var(--danger-fg); }
.ai-trace-chip-neutral { background: var(--bg-code); color: var(--text-secondary); }
.ai-trace-note { font-size: 11.5px; color: var(--text-secondary); margin-top: 3px; line-height: 1.45; }
.ai-trace-why { font-size: 11.5px; color: var(--text-secondary); margin-top: 4px; line-height: 1.45; }
.ai-trace-disc { margin-top: 6px; }
.ai-trace-disc > summary { font-size: 11px; color: var(--accent); cursor: pointer; list-style: none; width: fit-content; }
.ai-trace-disc > summary::-webkit-details-marker { display: none; }
.ai-trace-disc > summary::before { content: '▸'; font-size: 9px; margin-right: 4px; display: inline-block; }
.ai-trace-disc[open] > summary::before { content: '▾'; }
.ai-trace-disc > summary:hover { text-decoration: underline; }
.ai-trace-query { margin: 6px 0 0; padding: 7px 9px; background: var(--bg-code); border-radius: var(--radius); overflow-x: auto; max-height: 160px; font-family: var(--font-mono); font-size: 10.5px; line-height: 1.5; white-space: pre; color: var(--text-primary); }
.ai-trace-results { margin-top: 6px; border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; }
.ai-trace-rows { border-collapse: collapse; width: 100%; font-family: var(--font-mono); font-size: 10px; }
.ai-trace-rows th { text-align: left; background: var(--bg-code); color: var(--text-secondary); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.ai-trace-rows td { padding: 4px 8px; border-bottom: 1px solid var(--border); color: var(--text-primary); font-variant-numeric: tabular-nums; }
.ai-trace-rows tr:last-child td { border-bottom: none; }
.ai-trace-context { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
.ai-trace-context-k { color: var(--text-primary); font-weight: 600; }
.ai-trace-glossary { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.ai-trace-glossary > summary { font-size: 11px; color: var(--text-secondary); cursor: pointer; font-weight: 600; list-style: none; }
.ai-trace-glossary > summary::-webkit-details-marker { display: none; }
.ai-trace-glossary > summary::before { content: '▸'; font-size: 9px; margin-right: 5px; display: inline-block; }
.ai-trace-glossary[open] > summary::before { content: '▾'; }
.ai-trace-terms { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 11px; line-height: 1.45; }
.ai-trace-terms dt { color: var(--text-primary); font-weight: 600; white-space: nowrap; }
.ai-trace-terms dd { margin: 0; color: var(--text-secondary); }
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: PASS — bar tests + the new step-view render tests + Task 1 pure tests.

- [ ] **Step 6: Whole-suite + build green gate**

Run: `npm test && npm run build`
Expected: full suite PASS (no other file referenced the removed render internals) and a clean build. (No commit.)

---

## Self-Review

**Spec coverage:**
- Request + outcome header → Task 2 render + `outcomeBanner` (Task 1). ✓
- Unified step list driven by `calls`, joined to `rounds` → `buildStepViews` (Task 1) + render (Task 2). ✓
- Humanization maps (action/approach/verdict chip/check chip/why) → Task 1 (`APPROACH`, `verdictChip`, `checkChip`, `TRIGGER_REASON`). ✓
- Collapsible query + result sample → Task 2 (`details.ai-trace-disc`, `ResultSample`, `sampleColumns`). ✓
- Humanized context line + glossary → `contextBits` (Task 1) + render (Task 2). ✓
- Edge states (error/parse-fail/unrun/no-chosen/failed-fix/empty-calls) → `outcomeBanner` + `buildStepViews` (Task 1) tested. ✓
- Backward compat (bar unchanged, `buildTrace`/loop/shape untouched, `.ai-trace-body` kept) → Global Constraints + Task 2 keeps the bar + wrapper class. ✓

**Placeholder scan:** none — full code in every step.

**Type consistency:** `Step` shape (`kind/action/approach/note/why/chip{text,tone}/pipelineText/sample/rowCount`) identical in Task 1 producer and Task 2 consumer. `outcomeBanner` `{tone,icon,text,tag}` consistent. `sampleColumns(rows)→string[]` used by `ResultSample`. Chip tones `ok|warn|bad|neutral` map to `.ai-trace-chip-*` and `.ai-trace-outcome-*` CSS classes (all four defined). Node kinds `write|check|refine` map to `.ai-trace-node-*` (all three defined).
