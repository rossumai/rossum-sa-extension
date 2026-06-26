# AI Pipeline — Escalation-Gated Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the MDH AI pipeline loop to be escalation-gated (1 generate + 1 verify happy path, escalate only on error/empty/verify-flag), harden the verifier verdict against truncation, and add a run-path timeline to the detail modal — without regressing behavior.

**Architecture:** A single-candidate `runAiPipeline` (generate `exact` → execute → verify-or-escalate) with progressive single-fix corrections (`minimal` then `rethink`, one per round). `verifyAndSelect` judges N≥1 candidates and retries once with a *compact* prompt on a parse failure (llmchat is deterministic, so the retry must differ). The trace gains an additive `calls` array (ordered LLM calls with concurrency `group`s + durations) that the modal renders as a linear track — split-capable, branching only when a group has >1 call.

**Tech Stack:** Preact + `@preact/signals`, esbuild (IIFE, classic JSX `h`), vitest (jsdom), Rossum internal `/api/v1/internal/llmchat` (user-role only; params ignored; deterministic), Data Storage aggregation API.

## Global Constraints

- **`/internal/llmchat` is deterministic** (same prompt → same output; params ignored; reply = last `messages` element). Candidate diversity comes from prompt variation; a verify retry must use a *different (compact)* prompt or it reproduces the same truncation.
- **Public contract:** `runAiPipeline(...)` returns `{ pipelineText, trace }`; `trace.calls` is **additive**. `MONGO_SYSTEM_INSTRUCTION`, `ensureRowLimit`/`MAX_ROWS = 50`, `prependAiComment`/`stripAiComment`, `probeLlmChat`/`classifyProbe` (`aiAvailable`), and `getSchemaHints` (signature + per-collection cache) are unchanged. New params/fields are optional with safe defaults.
- **Never worse than today:** any new step that fails (verify down/garbage after retry, no collection, unparseable generation) falls back to applying the best mechanical pipeline.
- **No parallel LLM calls in this design** — happy path and single-fix corrections are sequential. The timeline is split-capable but renders linear; do NOT fake splits.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attributes — use a JS expression (`{'★'}`) or the literal glyph (per CLAUDE.md).
- **No git commits during implementation** (user workflow preference). Stay on `master`; no branches/worktrees. End each task with the suite (and `npm run build` for UI tasks) green. No `Co-Authored-By` trailer if the user later commits.
- **Never leak customer data** in tests, fixtures, or docs — use synthetic values only.
- **Test convention:** pure tests are `tests/<name>.test.js` importing from `../src/...`; component tests start with `// @vitest-environment jsdom` and render via `h`/`render` from `preact`. Run one file with `npx vitest run tests/<file>`.
- **Tunables (constants):** `CANDIDATE_ANGLES = ['exact']`, `CORRECTION_ANGLES = ['minimal','rethink']` (consumed one per round), `MAX_ROUNDS = 3`, `VERIFY_MIN_SCORE = 50`, `SAMPLE_ROWS = 3`.

---

### Task 1: `parseVerification` lenient recovery (`llmPipeline.js`)

Make the verdict parser survive a truncated verify response and default `best`
to `1` for a single candidate (observed live: a lone-candidate verdict returned
`best: null`).

**Files:**
- Modify: `src/mdh/llmPipeline.js` (`parseVerification`; add `recoverPartialJson` helper)
- Test: `tests/mdh-llm-pipeline.test.js` (extend the existing `parseVerification` describe block)

**Interfaces:**
- Produces: `parseVerification(text) → { candidates:[…], best:int, reasoning? } | null`. Now also recovers from truncated/partial JSON and, **when exactly one candidate is present**, accepts a missing/`null` `best` as `1`.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('parseVerification', …)` block in `tests/mdh-llm-pipeline.test.js`:

```js
it('recovers candidates+best from a response truncated mid-reasoning', () => {
  const truncated = '{"candidates":[{"index":1,"answersRequest":false,"score":0,"issue":"wrong op"}],"best":1,"reasoning":"the pipeline uses string compar';
  const v = parseVerification(truncated);
  expect(v).not.toBeNull();
  expect(v.best).toBe(1);
  expect(v.candidates[0].answersRequest).toBe(false);
});
it('defaults best to 1 for a single candidate when best is null/missing', () => {
  expect(parseVerification('{"candidates":[{"index":1,"answersRequest":false,"score":0,"issue":"x"}],"best":null,"reasoning":"cut').best).toBe(1);
});
it('still returns null when best is missing among multiple candidates', () => {
  expect(parseVerification('{"candidates":[{"index":1},{"index":2}],"best":nul')).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: FAIL — current `parseVerification` requires strict `JSON.parse` + integer `best`.

- [ ] **Step 3: Implement**

Replace `parseVerification` in `src/mdh/llmPipeline.js` and add the helper above it:

```js
// Best-effort repair of a truncated/partial JSON object: trim a dangling
// key/value or string, then close any still-open strings/brackets and re-parse.
function recoverPartialJson(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  let t = s.trim()
    .replace(/:\s*"[^"]*$/, ': ""')   // unterminated string value → empty
    .replace(/,\s*"[^"]*$/, '')        // dangling key with no value
    .replace(/:\s*$/, ': null')         // key with no value yet
    .replace(/,\s*$/, '');              // trailing comma
  const stack = []; let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  for (let i = stack.length - 1; i >= 0; i--) t += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(t); } catch { return null; }
}

// Defensive parse of a verifier reply. Strict first; on failure, recover from a
// truncated/partial response. A single-candidate verdict may omit/null `best`
// (→ defaults to 1); with >1 candidate an integer `best` is required.
export function parseVerification(text) {
  if (typeof text !== 'string') return null;
  const validate = (v, lenient) => {
    if (!v || typeof v !== 'object' || !Array.isArray(v.candidates)) return null;
    let best = v.best;
    if (!Number.isInteger(best)) {
      if (lenient && v.candidates.length === 1) best = 1;
      else return null;
    }
    return { candidates: v.candidates, best, reasoning: v.reasoning };
  };
  for (const t of [text, stripFences(text)]) {
    try { const ok = validate(JSON.parse(t), false); if (ok) return ok; } catch { /* try next */ }
  }
  const recovered = recoverPartialJson(stripFences(text));
  return recovered ? validate(recovered, true) : null;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: PASS — new cases + the existing `parseVerification` cases (valid, fenced, prose→null, `{"candidates":[]}`→null).

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-llm-pipeline.test.js` green. (No commit.)

---

### Task 2: `buildVerifyMessages` decision-first + `compact` mode (`llmPipeline.js`)

Order the requested JSON so decision fields survive truncation, instruct terse
strings, and add a `compact` variant (no `issue`/`reasoning`) for the retry.

**Files:**
- Modify: `src/mdh/llmPipeline.js` (`buildVerifyMessages`)
- Test: `tests/mdh-llm-pipeline.test.js` (extend the `buildVerifyMessages` describe block)

**Interfaces:**
- Produces: `buildVerifyMessages({ request, collection, fields, candidates, compact = false }) → [{role:'user',content}]`. `compact: true` asks only for `{candidates:[{index,answersRequest,score}],best}`.

- [ ] **Step 1: Write the failing tests**

Append to the `buildVerifyMessages` describe block:

```js
it('asks for decision fields first and short strings (non-compact)', () => {
  const c = buildVerifyMessages({ request: 'x', candidates: [{ pipelineText: '[]', rowCount: 1, sample: [] }] })[0].content;
  expect(c).toContain('"candidates"');
  expect(c.indexOf('"best"')).toBeLessThan(c.indexOf('"reasoning"')); // best before reasoning
  expect(c.toLowerCase()).toContain('short');
});
it('compact mode drops issue/reasoning from the requested shape', () => {
  const c = buildVerifyMessages({ request: 'x', compact: true, candidates: [{ pipelineText: '[]', rowCount: 1, sample: [] }] })[0].content;
  expect(c).toContain('"answersRequest"');
  expect(c).not.toContain('"reasoning"');
  expect(c).not.toContain('"issue"');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: FAIL — no `compact` branch; current shape lists `issue`/`reasoning`.

- [ ] **Step 3: Implement**

Replace `buildVerifyMessages` in `src/mdh/llmPipeline.js`:

```js
export function buildVerifyMessages({ request = '', collection = '', fields = [], candidates = [], compact = false } = {}) {
  const parts = ['You are a MongoDB expert reviewing candidate aggregation pipelines for whether their RESULTS correctly answer a user request.'];
  if (collection) parts.push(`Collection: ${collection}`);
  if (fields.length > 0) parts.push(`Available fields: ${fields.join(', ')}`);
  parts.push(`Request: ${request}`);
  candidates.forEach((c, i) => {
    const sample = Array.isArray(c.sample) ? c.sample : [];
    parts.push(`Candidate ${i + 1} pipeline:\n${c.pipelineText}\nIt returned ${c.rowCount ?? 0} row(s)${c.error ? ` (ERROR: ${c.error})` : ''}. Sample results:\n${JSON.stringify(sample)}`);
  });
  if (compact) {
    parts.push(
      'For EACH candidate decide whether its results answer the request. Output ONLY compact JSON — '
      + 'no markdown, no commentary, NO issue or reasoning text: '
      + '{"candidates":[{"index":<1-based>,"answersRequest":<true|false>,"score":<0-100>}],"best":<1-based index>}.');
  } else {
    parts.push(
      'For EACH candidate decide whether its results actually answer the request. Output ONLY JSON, no markdown, '
      + 'no commentary. Put the decision fields FIRST and keep every string SHORT: '
      + '{"candidates":[{"index":<1-based>,"answersRequest":<true|false>,"score":<0-100>,"issue":"<short, empty if fine>"}],'
      + '"best":<1-based index of the best candidate>,"reasoning":"<short>"}.');
  }
  return [{ role: 'user', content: parts.join('\n\n') }];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: PASS (the existing `buildVerifyMessages` "embeds request/candidate/sample + asks for JSON" case still passes — it checks `output only json`, present in both branches).

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-llm-pipeline.test.js` green. (No commit.)

---

### Task 3: `buildTrace` emits `calls` + "AI-checked" wording (`llmPipeline.js`)

Carry the run's LLM-call timeline through the (pure) trace, and rename the
collapsed-summary "verified" marker to the honest "AI-checked".

**Files:**
- Modify: `src/mdh/llmPipeline.js` (`buildTrace`)
- Test: `tests/mdh-llm-pipeline.test.js` (the `buildTrace` describe block)

**Interfaces:**
- Consumes: an optional `calls` array (ordered `{seq,kind,round,angle?,status,durationMs?,group}`).
- Produces: `buildTrace({ request, rounds, chosen, verification, hints, corrected, calls = [] }) → { …, summary, calls }`. The summary's verified marker reads `AI-checked · ` (was `verified · `).

- [ ] **Step 1: Write/adjust the failing tests**

In the `buildTrace` describe block of `tests/mdh-llm-pipeline.test.js`, update the
summary expectations and add a `calls` passthrough case. Replace the two summary
assertions that read `'verified'`:

```js
// (was: 'Best of 2 · verified · 12 rows')
expect(t.summary).toBe('Best of 2 · AI-checked · 12 rows');
// (the mechanical-fallback case keeps:) expect(t.summary).toBe('Best of 2 · 12 rows');
```

Add:

```js
it('passes the calls timeline through unchanged', () => {
  const calls = [{ seq: 0, kind: 'generate', round: 1, status: 'ok', group: 'g0' },
                 { seq: 1, kind: 'verify', round: 1, status: 'passed', group: 'g1' }];
  const t = buildTrace({ request: 'q', rounds: [{ kind: 'initial', candidates: [c1], picked: c1 }], chosen: c1, verification: { reasoning: 'ok' }, hints: {}, calls });
  expect(t.calls).toEqual(calls);
});
```

(NB: existing `buildTrace` tests in this repo pass `candidates:`; the working-tree `buildTrace` already takes `rounds:`. Use the `rounds:` form as above — match the current signature.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: FAIL — summary says `verified`; `t.calls` undefined.

- [ ] **Step 3: Implement**

In `buildTrace` (`src/mdh/llmPipeline.js`): add `calls = []` to the destructured
params, change the summary prefix, and include `calls` in the return:

```js
export function buildTrace({ request = '', rounds = [], chosen = null, verification = null, hints = {}, corrected = false, calls = [] } = {}) {
  const traceRounds = rounds.map((r, i) => ({
    kind: r.kind || (i === 0 ? 'initial' : 'correction'),
    trigger: r.trigger || undefined,
    reasoning: r.verification?.reasoning || undefined,
    candidates: (r.candidates || []).map((c) => mapCandidate(c, r.picked, chosen)),
  }));
  const status = chosen ? verdictStatus(chosen.verdict) : 'unverified';
  const verified = !!verification;
  const n = rounds[0] && Array.isArray(rounds[0].candidates) ? rounds[0].candidates.length : 0;
  const prefix = `${n > 1 ? `Best of ${n} · ` : ''}${verified ? 'AI-checked · ' : ''}`;
  let summary;
  if (!chosen) summary = 'No usable query produced';
  else if (status === 'error') summary = `Query failed${chosen.error ? `: ${traceTruncate(chosen.error, 60)}` : ''}`;
  else if (status === 'unverified') summary = 'Query ready (not executed)';
  else if (status === 'empty') summary = `${prefix}0 rows`;
  else summary = `${prefix}${chosen.rowCount} row${chosen.rowCount === 1 ? '' : 's'}`;
  return {
    request, status, summary, corrected,
    verifierReasoning: verification?.reasoning || undefined,
    rounds: traceRounds,
    hints: summarizeHints(hints),
    calls,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-llm-pipeline.test.js`
Expected: PASS.

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-llm-pipeline.test.js` green. (No commit.)

---

### Task 4: Escalation-gated loop rewrite (`aiPipelineLoop.js`)

Replace the always-2 loop with single-candidate generate → execute →
verify-or-escalate, progressive single-fix corrections, `verifyAndSelect` for
N≥1 with a compact retry, per-call recording into `trace.calls`, and
human-readable phase labels.

**Files:**
- Modify (full rewrite): `src/mdh/aiPipelineLoop.js`
- Test (full rewrite): `tests/mdh-ai-pipeline-loop.test.js`

**Interfaces:**
- Consumes: `buildPipelineMessages`, `buildFixMessages`, `buildVerifyMessages`, `parseVerification`, `extractReply`, `stripFences`, `safeParseArray`, `verdictFor`, `samePipeline`, `ensureRowLimit`, `buildTrace` (from `llmPipeline.js`); `api.llmChat/aggregate/find`.
- Produces: `runAiPipeline({ api, request, fields, collection, currentPipeline, samples, knownValues, numericStringFields, searchIndexes, fieldTypes, ranges, arrayPaths, topValues, signal, onPhase }) → { pipelineText, trace }`. Exports `CANDIDATE_ANGLES = ['exact']`, `CORRECTION_ANGLES = ['minimal','rethink']`, `MAX_ROUNDS = 3`, `VERIFY_MIN_SCORE = 50`. `trace.calls` = ordered `{seq,kind:'generate'|'fix'|'verify',round,angle?,status,durationMs?,group}`. Throws on `AbortError` and `403`.

- [ ] **Step 1: Write the failing tests (rewrite the file)**

Replace `tests/mdh-ai-pipeline-loop.test.js` entirely:

```js
import { describe, it, expect, vi } from 'vitest';
import { runAiPipeline } from '../src/mdh/aiPipelineLoop.js';
import { FIX_ANGLES } from '../src/mdh/llmPipeline.js';

const reply = (s) => ({ messages: [{ role: 'user', content: 'q' }, { role: 'system', content: s }] });
const gen = (pipeline) => reply(JSON.stringify(pipeline));
const verify = (obj) => reply(JSON.stringify(obj));

function fakeApi({ llm = [], agg = [], find = { result: [] } } = {}) {
  const llmQ = [...llm]; const aggQ = [...agg];
  return {
    llmChat: vi.fn(async () => { if (!llmQ.length) throw new Error('llm underflow'); return llmQ.shift(); }),
    aggregate: vi.fn(async () => { const n = aggQ.shift(); if (n instanceof Error) throw n; return n; }),
    find: vi.fn(async () => find),
  };
}
const base = { request: 'top vendors', fields: ['a'], collection: 'C', currentPipeline: '[]' };
const pass = (i = 1) => verify({ candidates: [{ index: i, answersRequest: true, score: 90, issue: '' }], best: i, reasoning: 'ok' });

describe('runAiPipeline (escalation-gated)', () => {
  it('happy path = 1 generate + 1 verify; applies the capped candidate', async () => {
    const api = fakeApi({ llm: [gen([{ $match: { a: 1 } }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
    expect(api.llmChat).toHaveBeenCalledTimes(2); // generate + verify
    expect(api.aggregate).toHaveBeenCalledTimes(1);
    expect(trace.status).toBe('ok');
    expect(trace.summary).toContain('AI-checked');
    expect(trace.summary).not.toContain('Best of');
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'verify']);
    expect(trace.calls[0].status).toBe('ok');
    expect(trace.calls[1].status).toBe('passed');
    expect(trace.calls[0].group).not.toBe(trace.calls[1].group); // sequential, distinct groups
  });

  it('verifier flags an ok-but-wrong candidate → one correction (minimal) → improved applied', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { wrong: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 20, issue: 'wrong field' }], best: 1, reasoning: '' }),
        gen([{ $match: { good: true } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 20, issue: '' }, { index: 2, answersRequest: true, score: 95, issue: '' }], best: 2, reasoning: '' })],
      agg: [{ result: [{ wrong: 1 }] }, { result: [{ good: 1 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { good: true } }, { $limit: 50 }]);
    expect(trace.corrected).toBe(true);
    expect(api.llmChat).toHaveBeenCalledTimes(4); // gen + verify + fix + re-verify
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'verify', 'fix', 'verify']);
    expect(trace.calls[2].angle).toBe('minimal'); // first correction angle
    // the fix prompt carried the full failure history + reviewer issue
    const fixPrompt = api.llmChat.mock.calls[2][0][0].content;
    expect(fixPrompt).toContain('do not repeat them');
    expect(fixPrompt).toContain('wrong field');
    expect(fixPrompt).toContain(FIX_ANGLES.minimal);
  });

  it('error skips verify and escalates straight to a correction', async () => {
    const err = Object.assign(new Error("Unrecognized stage '$srt'"), { status: 400 });
    const api = fakeApi({
      llm: [gen([{ $srt: {} }]), gen([{ $match: { a: 2 } }]), pass(2)],
      agg: [err, { result: [{ a: 2 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 2 } }, { $limit: 50 }]);
    expect(trace.status).toBe('ok');
    // round 1 errored → NO verify node for it; then fix + verify
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'fix', 'verify']);
    expect(trace.calls[0].status).toBe('error');
  });

  it('empty result escalates with sample docs fed into the fix prompt', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { x: 9 } }]), gen([{ $match: { x: 1 } }]), pass(2)],
      agg: [{ result: [] }, { result: [{ x: 1 }] }],
      find: { result: [{ x: 1 }] },
    });
    const { trace } = await runAiPipeline({ api, ...base, samples: [{ x: 1 }] });
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate', 'fix', 'verify']);
    expect(trace.calls[0].status).toBe('empty');
  });

  it('progressive angles minimal→rethink; caps at MAX_ROUNDS (≤2 corrections); worst case 6 calls', async () => {
    const flag = verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }, { index: 2, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' });
    const api = fakeApi({
      llm: [gen([{ $match: { n: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen([{ $match: { n: 2 } }]), flag, gen([{ $match: { n: 3 } }]), flag],
      agg: [{ result: [{ n: 1 }] }, { result: [{ n: 2 }] }, { result: [{ n: 3 }] }],
    });
    const { trace } = await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(6); // gen+verify + fix+verify + fix+verify
    expect(api.llmChat.mock.calls[2][0][0].content).toContain(FIX_ANGLES.minimal);
    expect(api.llmChat.mock.calls[4][0][0].content).toContain(FIX_ANGLES.rethink);
    expect(trace.calls.filter((c) => c.kind === 'fix').map((c) => c.angle)).toEqual(['minimal', 'rethink']);
  });

  it('stops early when a fix merely repeats an already-tried pipeline', async () => {
    const p = [{ $match: { x: 1 } }];
    const api = fakeApi({
      llm: [gen(p),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen(p)], // fix repeats round-1 → no progress → stop
      agg: [{ result: [{ x: 1 }] }],
    });
    await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(3); // gen + verify + 1 stale fix → stop
  });

  it('verify parse-fail → ONE compact retry (different prompt) then succeeds', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { a: 1 } }]), reply('not json'), pass()],
      agg: [{ result: [{ a: 1 }] }],
    });
    const { trace } = await runAiPipeline({ api, ...base });
    expect(api.llmChat).toHaveBeenCalledTimes(3); // gen + verify(fail) + verify(compact retry)
    // the retry used the compact prompt variant
    expect(api.llmChat.mock.calls[2][0][0].content).toContain('compact JSON');
    expect(trace.status).toBe('ok');
  });

  it('verify unparseable even after retry → mechanical fallback (never worse)', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { a: 1 } }]), reply('nope'), reply('still nope')],
      agg: [{ result: [{ a: 1 }] }],
    });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base });
    expect(JSON.parse(pipelineText)).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
    expect(trace.summary).not.toContain('AI-checked'); // fallback → not marked checked
    expect(trace.calls[1].status).toBe('parse-fail');
  });

  it('no collection → single generate, applied capped, no execute/verify', async () => {
    const api = fakeApi({ llm: [gen([{ $limit: 5 }])] });
    const { pipelineText, trace } = await runAiPipeline({ api, ...base, collection: null });
    expect(JSON.parse(pipelineText)).toEqual([{ $limit: 5 }]);
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(api.llmChat).toHaveBeenCalledTimes(1);
    expect(trace.calls.map((c) => c.kind)).toEqual(['generate']);
  });

  it('non-array output → applied as-is, not executed', async () => {
    const api = fakeApi({ llm: [reply('cannot do that')] });
    const { pipelineText } = await runAiPipeline({ api, ...base });
    expect(pipelineText).toBe('cannot do that');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('enforces the 50-row cap when the candidate omits $limit', async () => {
    const api = fakeApi({ llm: [gen([{ $match: { a: 1 } }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    await runAiPipeline({ api, ...base });
    expect(api.aggregate.mock.calls[0][1]).toEqual([{ $match: { a: 1 } }, { $limit: 50 }]);
  });

  it('propagates AbortError', async () => {
    const api = { llmChat: vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }), aggregate: vi.fn(), find: vi.fn() };
    await expect(runAiPipeline({ api, ...base })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a 403 so the caller can hide the feature', async () => {
    const api = { llmChat: vi.fn(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }), aggregate: vi.fn(), find: vi.fn() };
    await expect(runAiPipeline({ api, ...base })).rejects.toMatchObject({ status: 403 });
  });

  it('emits human-readable phase labels for the new flow', async () => {
    const api = fakeApi({ llm: [gen([{ $limit: 5 }]), pass()], agg: [{ result: [{ a: 1 }] }] });
    const phases = [];
    await runAiPipeline({ api, ...base, onPhase: (p) => phases.push(p) });
    expect(phases).toContain('Generating the query');
    expect(phases).toContain('Checking the result');
    expect(phases).not.toContain('generating'); // no internal keys leak
  });

  it('correction labels carry the round number ("Refining (1 of 2)")', async () => {
    const api = fakeApi({
      llm: [gen([{ $match: { n: 1 } }]),
        verify({ candidates: [{ index: 1, answersRequest: false, score: 10, issue: 'no' }], best: 1, reasoning: '' }),
        gen([{ $match: { n: 2 } }]), pass(2)],
      agg: [{ result: [{ n: 1 }] }, { result: [{ n: 2 }] }],
    });
    const phases = [];
    await runAiPipeline({ api, ...base, onPhase: (p) => phases.push(p) });
    expect(phases).toContain('Refining (1 of 2)');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-ai-pipeline-loop.test.js`
Expected: FAIL — current loop is always-2 (call counts, `trace.calls`, labels differ).

- [ ] **Step 3: Implement (full rewrite of `src/mdh/aiPipelineLoop.js`)**

```js
// Escalation-gated agentic loop for the AI pipeline input. Generates ONE (exact)
// candidate, executes it, and escalates only on a real signal: a backend error,
// 0 rows, or a semantic verifier flagging the result. Corrections are a single
// progressive fix per round (minimal → rethink), ≤2 rounds, each seeing the full
// failure history. Returns { pipelineText, trace }; trace.calls is the ordered
// LLM-call timeline. Degrades to apply-best on any failure. `api` (llmChat,
// aggregate, find) is injected. Throws on AbortError and on a 403 from llmChat.
import {
  buildPipelineMessages, buildFixMessages, buildVerifyMessages, parseVerification,
  extractReply, stripFences, safeParseArray, verdictFor, samePipeline, ensureRowLimit,
  buildTrace,
} from './llmPipeline.js';

export const CANDIDATE_ANGLES = ['exact'];               // happy path: one candidate
export const CORRECTION_ANGLES = ['minimal', 'rethink']; // one per correction round (progressive)
export const MAX_ROUNDS = 3;                              // round 1 + up to 2 corrections
export const VERIFY_MIN_SCORE = 50;
const SAMPLE_ROWS = 3;
const VERDICT_RANK = { ok: 4, unrun: 3, empty: 2, error: 1, invalid: 0 };

const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// Generate one raw model output. Rethrows AbortError + 403; any other error → null.
async function genCandidate(api, messages, signal) {
  try {
    return stripFences(extractReply(await api.llmChat(messages, { signal })));
  } catch (e) {
    if (e?.name === 'AbortError' || e?.status === 403) throw e;
    return null;
  }
}

// Parse → cap → execute → mechanical verdict. Never throws except AbortError.
async function evalCandidate(api, collection, rawText, angle, signal) {
  const parsed = safeParseArray(rawText);
  if (!parsed) return { angle, raw: rawText, pipelineText: rawText ?? '', parsed: false, verdict: 'invalid', rowCount: 0 };
  const limited = ensureRowLimit(parsed);
  const pipelineText = limited === parsed ? rawText : JSON.stringify(limited, null, 2);
  if (!collection) return { angle, raw: rawText, pipelineText, parsed: true, verdict: 'unrun', rowCount: 0 };
  try {
    const res = await api.aggregate(collection, limited, { signal });
    const rows = res?.result || [];
    return { angle, raw: rawText, pipelineText, parsed: true, verdict: verdictFor({ ok: true, rowCount: rows.length }), rowCount: rows.length, sample: rows.slice(0, SAMPLE_ROWS) };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { angle, raw: rawText, pipelineText, parsed: true, verdict: 'error', rowCount: 0, error: e?.message || String(e) };
  }
}

function mechanicalBest(cands) {
  return [...cands].sort((a, b) => (VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]) || (b.rowCount - a.rowCount))[0];
}

// Verify ≥1 candidates' RESULTS. On a parse-failure, retry ONCE with a compact
// prompt (llmchat is deterministic, so an identical retry would re-truncate).
// Returns { chosen, verification, parsed, ms }.
async function verifyAndSelect(api, ctx, cands, signal, onPhase) {
  onPhase('Checking the result');
  let verification = null;
  const t0 = clock();
  try {
    for (const compact of [false, true]) {           // attempt 1 normal; attempt 2 compact (only if needed)
      const msgs = buildVerifyMessages({ request: ctx.request, collection: ctx.collection, fields: ctx.fields, candidates: cands, compact });
      verification = parseVerification(stripFences(extractReply(await api.llmChat(msgs, { signal }))));
      if (verification) break;
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    verification = null;
  }
  const ms = clock() - t0;
  if (verification) {
    for (const j of verification.candidates || []) {
      const c = cands[(j.index || 0) - 1];
      if (c) { c.answersRequest = j.answersRequest; c.score = j.score; c.issue = j.issue || undefined; }
    }
    const best = (Number.isInteger(verification.best) && cands[verification.best - 1]) || cands[0];
    return { chosen: best, verification, parsed: true, ms };
  }
  return { chosen: cands.length > 1 ? mechanicalBest(cands) : cands[0], verification: null, parsed: false, ms };
}

function isGood(c, verification) {
  if (c.verdict !== 'ok') return false;
  if (!verification) return true; // can't judge → accept a running result
  return c.answersRequest !== false && (typeof c.score !== 'number' || c.score >= VERIFY_MIN_SCORE);
}

// Human reason a candidate failed — carried into the next retry's history.
function failReason(c) {
  const reviewer = c.issue ? ` Reviewer: ${c.issue}.` : '';
  if (c.verdict === 'error') return `failed with error: ${c.error || 'unknown error'}.${reviewer}`;
  if (c.verdict === 'empty') return `executed but returned 0 matching documents (likely a value-format or structure mismatch).${reviewer}`;
  if (c.verdict === 'invalid') return `was not a valid pipeline.${reviewer}`;
  return `executed but did not correctly answer the request.${reviewer}`;
}

function alreadyTried(tried, rawText) {
  return tried.some((t) => samePipeline(t.raw, rawText));
}

async function findSamples(api, collection) {
  try { return (await api.find(collection, { limit: 3 }))?.result || null; } catch { return null; }
}

export async function runAiPipeline({ api, request, fields = [], collection, currentPipeline = '',
  samples = null, knownValues = null, numericStringFields = null, searchIndexes = null,
  fieldTypes = null, ranges = null, arrayPaths = null, topValues = null,
  signal, onPhase = () => {} }) {

  const seedSamples = Array.isArray(samples) && samples.length ? samples.slice(0, 3) : null;
  const hints = { knownValues, numericStringFields, searchIndexes, fieldTypes, ranges, arrayPaths, topValues };
  const traceHints = { ...hints, collection, fieldCount: (fields || []).length };
  const ctx = { request, collection, fields };

  const calls = [];
  let seq = 0, groupSeq = 0;
  const nextGroup = () => `g${groupSeq++}`;
  const recordVerify = (sel, round, chosen) => calls.push({
    seq: seq++, kind: 'verify', round,
    status: sel.parsed ? (isGood(chosen, sel.verification) ? 'passed' : 'flagged') : 'parse-fail',
    durationMs: sel.ms, group: nextGroup(),
  });

  // Round 1 — single exact candidate.
  onPhase('Generating the query');
  const t0 = clock();
  const raw0 = await genCandidate(api, buildPipelineMessages({ fields, currentPipeline, request, samples: seedSamples, collection, angle: CANDIDATE_ANGLES[0], ...hints }), signal);
  const genMs = clock() - t0;
  const grp0 = nextGroup();
  if (raw0 == null) {
    calls.push({ seq: seq++, kind: 'generate', round: 1, angle: CANDIDATE_ANGLES[0], status: 'failed', durationMs: genMs, group: grp0 });
    return { pipelineText: '', trace: buildTrace({ request, rounds: [{ kind: 'initial', candidates: [], picked: null }], chosen: null, hints: traceHints, calls }) };
  }
  onPhase('Running the query');
  const c0 = await evalCandidate(api, collection, raw0, CANDIDATE_ANGLES[0], signal);
  calls.push({ seq: seq++, kind: 'generate', round: 1, angle: c0.angle, status: c0.verdict, durationMs: genMs, group: grp0 });

  if (!c0.parsed) { // not a pipeline → apply raw as-is (today's behavior)
    const rounds = [{ kind: 'initial', candidates: [c0], picked: null }];
    return { pipelineText: raw0, trace: buildTrace({ request, rounds, chosen: null, hints: traceHints, calls }) };
  }
  if (!collection) { // can't execute/verify → apply capped (today's behavior)
    const rounds = [{ kind: 'initial', candidates: [c0], picked: c0 }];
    return { pipelineText: c0.pipelineText, trace: buildTrace({ request, rounds, chosen: c0, hints: traceHints, calls }) };
  }

  let chosen = c0;
  let verification = null;
  const rounds = [{ kind: 'initial', candidates: [c0], picked: c0 }];

  // Verify only when the candidate ran ok; error/empty escalate without a verify call.
  if (c0.verdict === 'ok') {
    const sel = await verifyAndSelect(api, ctx, [c0], signal, onPhase);
    chosen = sel.chosen; verification = sel.verification;
    rounds[0].verification = verification;
    recordVerify(sel, 1, chosen);
  }

  const tried = [];
  const recordFailed = (c) => { if (c && c.raw != null && !alreadyTried(tried, c.raw)) tried.push({ raw: c.raw, pipelineText: c.pipelineText, reason: failReason(c) }); };

  for (let round = 2; round <= MAX_ROUNDS && !isGood(chosen, verification); round++) {
    if (round === 2) recordFailed(chosen);
    const angle = CORRECTION_ANGLES[round - 2] || CORRECTION_ANGLES[CORRECTION_ANGLES.length - 1];
    const trigger = chosen.verdict === 'error' ? 'error' : chosen.verdict === 'empty' ? 'empty' : 'mismatch';
    onPhase(`Refining (${round - 1} of ${MAX_ROUNDS - 1})`);
    const fixSamples = chosen.verdict === 'empty' ? (seedSamples || await findSamples(api, collection)) : null;

    const tf = clock();
    const fixRaw = await genCandidate(api, buildFixMessages({ fields, request, attempts: tried, angle, samples: fixSamples, collection, ...hints }), signal);
    const fixMs = clock() - tf;
    const grpF = nextGroup();
    if (fixRaw == null || alreadyTried(tried, fixRaw)) {
      if (fixRaw != null) calls.push({ seq: seq++, kind: 'fix', round, angle, status: 'duplicate', durationMs: fixMs, group: grpF });
      break; // no progress
    }
    onPhase('Running the correction');
    const fix = await evalCandidate(api, collection, fixRaw, angle, signal);
    calls.push({ seq: seq++, kind: 'fix', round, angle, status: fix.parsed ? fix.verdict : 'invalid', durationMs: fixMs, group: grpF });
    if (!fix.parsed) break;

    const cands = [chosen, fix];
    const sel = await verifyAndSelect(api, ctx, cands, signal, onPhase);
    const prevChosen = chosen;
    verification = sel.verification;
    chosen = sel.chosen;
    rounds.push({ kind: 'correction', trigger, candidates: cands, verification, picked: chosen });
    recordVerify(sel, round, chosen);
    recordFailed(fix);
    recordFailed(prevChosen);
  }

  const corrected = rounds.some((r) => r.kind === 'correction');
  return { pipelineText: chosen.pipelineText, trace: buildTrace({ request, rounds, chosen, verification, hints: traceHints, corrected, calls }) };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-ai-pipeline-loop.test.js`
Expected: PASS (all cases above).

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-ai-pipeline-loop.test.js` green. (No commit.)

---

### Task 5: Run-path timeline in the modal + "AI-checked" (`AiRunTrace.jsx`, `console.css`)

Render `trace.calls` as an ordered call-path at the top of the detail modal,
split-capable (parallel lane only when a group has >1 call).

**Files:**
- Modify: `src/mdh/components/AiRunTrace.jsx`
- Modify: `src/console/console.css` (append `.ai-trace-timeline` / `.ai-trace-call*` rules)
- Test: `tests/mdh-ai-run-trace.test.js`

**Interfaces:**
- Consumes: `trace.calls` (from Task 3/4).
- Produces: `<CallPath calls={…} />` rendered inside `AiRunTraceDetails`.

- [ ] **Step 1: Write the failing tests**

In `tests/mdh-ai-run-trace.test.js`, add `calls` to the `trace` fixture and a new describe block:

```js
// add to the `trace` fixture object:
//   calls: [ { seq:0, kind:'generate', round:1, angle:'exact', status:'ok', durationMs:1200, group:'g0' },
//            { seq:1, kind:'verify', round:1, status:'passed', durationMs:900, group:'g1' } ],

describe('AiRunTrace call-path timeline', () => {
  it('renders a linear timeline of LLM calls in the modal', () => {
    const root = mount(AiRunTraceDetails, { trace });
    const tl = root.querySelector('.ai-trace-timeline');
    expect(tl).toBeTruthy();
    expect(tl.querySelectorAll('.ai-trace-call')).toHaveLength(2);
    expect(tl.querySelector('.ai-trace-step-parallel')).toBeNull(); // sequential → no split
    expect(tl.textContent.toLowerCase()).toContain('generate');
    expect(tl.textContent.toLowerCase()).toContain('verify');
  });
  it('renders a parallel group as side-by-side lanes when a group has >1 call', () => {
    const t = { rounds: [], hints: {}, calls: [
      { seq: 0, kind: 'generate', round: 1, status: 'ok', group: 'g0' },
      { seq: 1, kind: 'generate', round: 1, status: 'empty', group: 'g0' },
      { seq: 2, kind: 'verify', round: 1, status: 'passed', group: 'g1' },
    ] };
    const root = mount(AiRunTraceDetails, { trace: t });
    expect(root.querySelector('.ai-trace-step-parallel')).toBeTruthy();
    expect(root.querySelectorAll('.ai-trace-step-parallel .ai-trace-call')).toHaveLength(2);
  });
  it('omits the timeline when there are no calls', () => {
    const root = mount(AiRunTraceDetails, { trace: { rounds: [], hints: {}, calls: [] } });
    expect(root.querySelector('.ai-trace-timeline')).toBeNull();
  });
});
```

Also update the bar summary assertion in the existing fixture from
`'Best of 2 · verified · 12 rows'` to `'Best of 2 · AI-checked · 12 rows'` (and
`correctedTrace.summary` similarly).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: FAIL — no `.ai-trace-timeline`.

- [ ] **Step 3: Implement**

In `src/mdh/components/AiRunTrace.jsx`, add the `CallPath` component and render it
at the top of `AiRunTraceDetails`'s `.ai-trace-body`:

```jsx
const CALL_KIND = { generate: 'Generate', fix: 'Fix', verify: 'Verify' };

function callLabel(c) {
  const dur = typeof c.durationMs === 'number' && c.durationMs >= 1 ? ` · ${Math.round(c.durationMs)}ms` : '';
  return `${CALL_KIND[c.kind] || c.kind}${c.angle ? ` (${c.angle})` : ''} · ${c.status}${dur}`;
}
// Group consecutive calls sharing a concurrency group (size>1 → ran in parallel).
function groupCalls(calls) {
  const groups = [];
  for (const c of calls) {
    const last = groups[groups.length - 1];
    if (last && last.group === c.group) last.calls.push(c);
    else groups.push({ group: c.group, calls: [c] });
  }
  return groups;
}
function CallPath({ calls }) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return (
    <div class="ai-trace-timeline">
      {groupCalls(calls).map((g, i) => (
        <div key={i} class={`ai-trace-step${g.calls.length > 1 ? ' ai-trace-step-parallel' : ''}`}>
          {g.calls.map((c, j) => (
            <div key={j} class={`ai-trace-call ai-trace-call-${c.kind} ai-trace-call-${c.status}`}>{callLabel(c)}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Then, inside `AiRunTraceDetails`, render `<CallPath calls={trace.calls} />` as the
first child of `<div class="ai-trace-body">` (before the `rounds.map(...)`).

Append to `src/console/console.css`:

```css
.ai-trace-timeline { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.ai-trace-step { display: flex; gap: 8px; }
.ai-trace-step-parallel { border-left: 2px dashed var(--accent-border); padding-left: 8px; }
.ai-trace-call { flex: 1; font: 12px/1.4 var(--mono, monospace); padding: 4px 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); }
.ai-trace-call-verify { background: var(--accent-bg); }
.ai-trace-call-ok, .ai-trace-call-passed { border-color: var(--success-border); }
.ai-trace-call-empty, .ai-trace-call-flagged { border-color: var(--warning-border); }
.ai-trace-call-error, .ai-trace-call-invalid, .ai-trace-call-failed, .ai-trace-call-parse-fail { border-color: var(--danger-border); }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/mdh-ai-run-trace.test.js`
Expected: PASS.

- [ ] **Step 5: Green gate** — `npx vitest run tests/mdh-ai-run-trace.test.js` green **and** `npm run build` succeeds. (No commit.)

---

### Task 6: Caller alignment (`PipelineEditor.jsx` test fixtures)

`PipelineEditor` needs no logic change (it already passes `onPhase` and renders
`AiRunTrace`), but its test's mocked trace must match the new shape/summary.

**Files:**
- Test: `tests/mdh-pipeline-editor-ai.test.js`
- (Verify only) `src/mdh/components/PipelineEditor.jsx`

**Interfaces:** none new.

- [ ] **Step 1: Update the test fixture + assertions**

In `tests/mdh-pipeline-editor-ai.test.js`, change the mocked `runAiPipeline` return
to the new trace shape and summary:

```js
const runAiPipeline = vi.fn(async () => ({
  pipelineText: '[{"$limit":5}]',
  trace: { status: 'ok', summary: 'AI-checked · 3 rows', corrected: false, rounds: [], hints: {}, calls: [] },
}));
```

And update the summary assertion in the first test:

```js
expect(root.textContent).toContain('AI-checked · 3 rows');
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run tests/mdh-pipeline-editor-ai.test.js`
Expected: PASS (the wiring is unchanged; only the fixture/summary changed). If it
fails because `PipelineEditor` referenced a now-removed field, fix the reference.

- [ ] **Step 3: Whole-suite + build green gate**

Run: `npm test && npm run build`
Expected: full suite PASS and a clean build. (No commit.)

---

## Self-Review

**Spec coverage:**
- Escalation-gated flow → Task 4. ✓
- Single-candidate verify (N≥1) → Task 4 (`verifyAndSelect`). ✓
- Verify hardening: terse/decision-first → Task 2; lenient parse + best-default → Task 1; compact retry → Task 4. ✓
- Timeline data model (`trace.calls`) → Task 3 (passthrough) + Task 4 (population). ✓
- Timeline UI (split-capable, linear here) + "AI-checked" → Task 5 (+ summary rename in Task 3). ✓
- Backward compatibility (return shape, `MAX_ROWS`, comment, probe, `getSchemaHints`, no-collection, abort/403) → Task 4 preserves; Task 6 confirms the caller. ✓
- Phase labels → Task 4. ✓

**Placeholder scan:** none — every code/test step is complete.

**Type consistency:** `trace.calls` shape `{seq,kind,round,angle?,status,durationMs?,group}` is identical in Tasks 3, 4, 5. `verifyAndSelect` returns `{chosen,verification,parsed,ms}` (Task 4) consumed only within Task 4. `parseVerification` shape `{candidates,best,reasoning?}` consistent across Tasks 1, 4. `buildVerifyMessages({…,compact})` (Task 2) called with `compact` in Task 4. Summary `AI-checked` consistent across Tasks 3, 5, 6.

**Notes:** The superseded `2026-06-26-ai-pipeline-transparency-accuracy.md` plan is left in place for history (its spec is marked superseded). `ANGLES.tolerant` in `llmPipeline.js` remains defined (harmless; `buildPipelineMessages` still supports any angle) — the loop simply only uses `'exact'`; no dead-code removal needed.
