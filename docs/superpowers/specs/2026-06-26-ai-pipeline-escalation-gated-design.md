# MDH AI pipeline — escalation-gated loop + verify hardening + run-path timeline

**Date:** 2026-06-26
**Status:** Draft — pending user review
**Supersedes:** `2026-06-26-ai-pipeline-transparency-accuracy-design.md` (and its plan).
That design (always-2 candidates + judge + 2-parallel-fix corrections) is the
starting point; this spec is the result of an objective review of it plus a
**live dogfood** of its verifier against a real org's `/internal/llmchat`.
**Area:** MDH AI pipeline input — `llmPipeline.js`, `aiPipelineLoop.js`,
`aiContext.js`, `components/AiRunTrace.jsx`, `components/PipelineEditor.jsx`,
`console.css`.

## Problem / goal

The current (uncommitted) loop generates **2 angle-varied candidates in
parallel**, runs one llmchat **judge** over both, and self-corrects with **2
parallel fixes per round**. A review + live dogfood established:

- **The judge genuinely works.** It reads the *pipeline text* and cross-checks
  the result sample against the request, and reliably caught injected errors —
  wrong operator (`$lt` vs `$gt`), missing `$sort` on a top-N, wrong field, and
  the numeric-string lexical-compare trap (`{$gt:"10000"}` matching `"9999"`) —
  **including when both candidates share the same error** (no correct candidate
  to contrast). So the headline accuracy mechanism is sound.
- **But the always-2 machinery is wasteful.** Because llmchat is deterministic,
  the two angles frequently produce **identical** pipelines (observed
  byte-identical on multiple requests). The 2nd generation is usually wasted,
  yet the happy path always pays **3 llmchat calls** (2 generate + 1 verify) vs
  a single-candidate baseline's **1**.
- **The real weak link is verdict fragility.** A *truncated* verify response
  makes `parseVerification` return `null` → the loop falls back to the mechanical
  best with `verification = null` → `isGood(c, null)` accepts any `ok`-verdict
  candidate. A correctly-detected error is then silently accepted. Observed in
  ~1 of 8 live verify calls (verbose `issue`/`reasoning` overran the output).
- **Non-issues confirmed:** prompt sizes are small (gen ≤ ~4 KB, verify ≤ ~3 KB;
  sample docs ~0.4 KB), so the prompt ceiling is not a concern here; the verifier
  score is **bimodal** (wrong 0–15, right 95–100), so the `VERIFY_MIN_SCORE = 50`
  gate sits safely in the gap.

(Findings recorded in memory `reference-mdh-ai-loop-live-dogfood`. The dogfood used
reference/config tables + synthetic verifier probes — no customer data.)

**Goals:**

1. **Escalation-gate** the expensive machinery: run the cheap path by default,
   escalate only on a real signal — without losing the proven accuracy net.
2. **Harden the verdict capture** so a correctly-detected error is never lost to
   truncation.
3. **Add a run-path timeline** to the existing detail modal (the path of LLM
   calls) — split-capable, but it branches **only** when LLM calls genuinely run
   in parallel (none do in this design → it renders linear; no faked splits).
4. **Preserve backward compatibility** throughout.

## Verified facts (the design is built on these; nothing assumed)

- **`/internal/llmchat` contract** (memory `reference_rossum_internal_llm_endpoints`,
  re-confirmed live 2026-06-26): user-role messages only; all params ignored
  (no temperature/model/n); reply = last element of `response.messages`; 30 s
  timeout; per-org feature-flagged → the `aiAvailable` probe gates the input.
  Deterministic per prompt ⇒ candidate diversity comes only from prompt
  variation, and multiple candidates = multiple parallel calls.
- **Concurrency today:** `getSchemaHints` runs `$facet` ‖ `listSearchIndexes`
  (Data Storage calls), cached per collection (`aiContext.js`). The *loop's*
  only LLM-call concurrency was the always-2 generate / 2-fix `Promise.all`
  batches — removed by this redesign.
- **Public surface:** `runAiPipeline(...) → { pipelineText, trace }`, consumed by
  `PipelineEditor.handleNlSubmit`, which applies `pipelineText` via
  `prependAiComment` and stores `trace`. `MONGO_SYSTEM_INSTRUCTION`,
  `ensureRowLimit` / `MAX_ROWS = 50`, the `// 🤖 AI request:` comment, the
  `aiAvailable` probe, and `getSchemaHints`'s cache are established and stay.
- **Live behavior** (dev org, 2026-06-26): happy-path latency ~4–5 s for 3 calls
  (gen ~1.1–2.4 s, verify ~2.0–2.5 s); verify returned parseable JSON 7/8 times.

## Design

### 1 · Escalation-gated flow (`aiPipelineLoop.js`)

Replaces the always-2 + always-verify round 1.

```
getSchemaHints (cached; $facet ‖ search-index — Data Storage, NOT in the timeline)
        │
   Generate 1  (exact angle)
        │
   Execute (ensureRowLimit cap)
        ├─ error / empty ───────────────────────────────→ escalate (correction)
        └─ ok → Verify (single candidate)
                   ├─ passes (answersRequest !== false && score ≥ 50) → APPLY
                   └─ flags ─────────────────────────────→ escalate (correction)
```

- **Happy path = 2 llmchat calls** (1 generate + 1 verify), ~3.5 s. Keeps the
  proven wrong-but-nonempty safety net while dropping the wasted 2nd candidate.
- **`error` / `empty` skip verify** (nothing to check) and go straight to
  correction — today's mechanical triggers, preserved.
- **Corrections** (≤ 2 rounds; `MAX_ROUNDS = 3` total): **progressive single
  fix**, one candidate per round, angle deepening: round 2 = `minimal` (smallest
  change that fixes it), round 3 = `rethink` (rebuild from scratch). Each fix
  prompt carries the **specific problem** (backend error message, or `empty` +
  real sample docs, or the verifier's `issue`) **plus the full attempt history**
  (`tried[]`, dedup on raw output, stop on no-progress). Each round:
  `fix → execute → verify → re-check isGood`. Stop on good / no-progress / cap.
- **No-collection path** (unchanged): generate 1, apply capped, no execute / no
  verify. The timeline shows the single generate call.
- **Nothing parseable** (unchanged): apply the first raw output as-is.

### 2 · Single-candidate verify (`aiPipelineLoop.js`)

`verifyAndSelect` is generalized to **N ≥ 1** candidates: with one candidate it
asks the judge for `{ answersRequest, score, issue }` (no "best" to select) and
returns that judgment; with ≥ 2 (only reachable if a future round parallelizes)
it also selects. The live dogfood confirmed the judge evaluates a lone candidate
correctly. `isGood` and `VERIFY_MIN_SCORE = 50` are unchanged.

### 3 · Verify hardening — fixes the lost-verdict weak link (`llmPipeline.js`)

1. **Terse output:** `buildVerifyMessages` instructs a short `issue` and short
   `reasoning`, and requests the JSON with the **decision fields first**
   (`candidates`, `best`) and `reasoning` last, so the load-bearing fields are
   least likely to be truncated.
2. **Lenient parse:** `parseVerification` first tries strict `JSON.parse`
   (today's path); on failure it attempts a **tolerant recovery** — extract the
   `candidates` array and `best` from a truncated/partial object (e.g. close an
   unterminated string/array and re-parse the salvageable prefix). For a
   **single candidate**, a missing/`null` `best` defaults to `1` (observed live:
   a lone-candidate verdict came back with `best: null`). Returns the validated
   shape or `null`.
3. **Compact retry once on parse-fail:** if a verify response still won't parse,
   re-issue the verify call **once with a compact prompt variant** —
   `buildVerifyMessages({ compact: true })` drops the `issue` and `reasoning`
   fields, asking only for `{ candidates:[{index,answersRequest,score}], best }`,
   so the output is short and truncation-resistant. **Why compact, not identical:**
   llmchat is deterministic, so re-sending the *same* prompt would reproduce the
   *same* truncation — the retry only helps if the prompt produces shorter output.
   On a second failure → today's mechanical fallback (`verification = null`).

This closes the path where a correct judgment is discarded because the response
was cut off.

### 4 · Run-path timeline — data model (`llmPipeline.js`, `buildTrace`)

`trace` gains an additive, serializable **`calls`** array describing the ordered
**LLM calls** of the run, derived from the existing `rounds` plus per-call
durations recorded by the loop:

```js
calls: [
  { seq, kind: 'generate' | 'fix' | 'verify', round, angle?, status, durationMs?, group },
  …
]
```

- `group` = the concurrency batch a call was dispatched in. Calls issued together
  (one `Promise.all`) share a `group`; sequential calls get distinct groups. In
  this design each round issues **one** generate/fix and **one** verify, so every
  group has a single member.
- A `verify` node appears **only when a verify call was actually made**. A round
  that ended on `error`/`empty` (which skip verify) contributes just its
  `generate`/`fix` node — the `calls` array reflects calls that really happened.
- `status` (derived): for `generate`/`fix` — the resulting candidate's verdict
  (`ok` / `empty` / `error` / `invalid`) or `failed` (llmchat returned null);
  for `verify` — `passed` / `flagged` / `parse-fail` / `failed`.
- `durationMs` — best-effort wall-clock per call, captured in the loop via
  `performance.now()` (guarded: omitted when no clock is available, e.g. under
  test). Not asserted in tests.

The renderer (below) lays groups in sequence and **branches a group into parallel
lanes only when it has > 1 call**. Here that never happens → a single linear
track. Data Storage calls (schema-hint prefetch, candidate executes) are **not**
included — the timeline is LLM calls only, by decision.

### 5 · Run-path timeline — UI (`components/AiRunTrace.jsx`, `console.css`)

`AiRunTraceDetails` (the existing "AI query details" modal) gains a **call-path
section** above the per-round candidate detail: an ordered vertical track of
nodes, one per LLM call, each showing `kind` + round + `angle` (if any) +
outcome + duration. A self-corrected run shows the correction's `fix`/`verify`
calls in sequence with a "self-corrected" marker. A group with > 1 call would
render as side-by-side lanes that rejoin (split-capable) — not exercised by this
design. The compact one-line bar → modal trigger is unchanged. Copy fix: the
collapsed summary's **"verified"** becomes **"AI-checked"** (it means "an LLM
reviewed the result + sample", not "proven correct"). Phase labels in the loader
are updated to the new flow ("Generating", "Checking the result", "Refining").
The trace stays ephemeral (component state; cleared on collection change / new
submit). New CSS lives under `.ai-trace-*` (timeline rules `.ai-trace-call*`).

### 6 · Backward compatibility

- `runAiPipeline(...)` still returns `{ pipelineText, trace }`; `trace.calls` is
  **additive** on top of the existing `trace` shape. Existing consumers reading
  `pipelineText` / `trace.summary` / `trace.rounds` are unaffected.
- Unchanged in signature/behavior: `MONGO_SYSTEM_INSTRUCTION`, `ensureRowLimit` /
  `MAX_ROWS`, `prependAiComment` / `stripAiComment` (the AI comment),
  `probeLlmChat` / `classifyProbe` (the `aiAvailable` probe), `getSchemaHints`
  (signature + per-collection cache).
- Preserved fallback paths: no-collection single-candidate apply; nothing-parseable
  apply-first-raw; `403` mid-session → `aiAvailable = false`; `AbortError`
  propagation; verifier-down / unparseable → mechanical fallback (now after one
  retry).
- The exported tunables change to reflect the new flow: `CANDIDATE_ANGLES`
  becomes a single happy-path angle (`['exact']`) and `CORRECTION_ANGLES` stays
  `['minimal','rethink']` but is consumed **one per round** (progressive), not in
  parallel. `MAX_ROUNDS = 3`, `VERIFY_MIN_SCORE = 50`, `SAMPLE_ROWS = 3` retained.

### Module layout

| File | Change |
|------|--------|
| `src/mdh/aiPipelineLoop.js` | Rewrite the round-1 path to single-candidate generate → execute → (verify-or-escalate); progressive single-fix corrections; capture per-call `durationMs` + `group`; build `trace.calls`. |
| `src/mdh/llmPipeline.js` | `buildVerifyMessages` terse + decision-first JSON; `parseVerification` lenient recovery; `buildTrace` emits `calls`; `verifyAndSelect` semantics doc for N≥1 (the function lives in the loop, helper text here). |
| `src/mdh/aiContext.js` | Unchanged (schema-hint prefetch is not in the timeline). |
| `src/mdh/components/AiRunTrace.jsx` | Render the call-path timeline in the modal; "verified" → "AI-checked". |
| `src/mdh/components/PipelineEditor.jsx` | Phase labels; pass through unchanged otherwise. |
| `src/console/console.css` | `.ai-trace-call*` timeline styles. |

## Out of scope

- Data Storage calls in the timeline; faked or forced splits.
- Wall-clock-accurate timing guarantees (durations are best-effort, untested).
- A user-facing candidate-count / rounds setting (constants).
- Changing the llmchat transport, the probe, or `aiAvailable`.
- Persisting the trace across reloads (ephemeral by design).
- Re-introducing parallel generation/fixes (explicitly rejected for cost).

## Testing (vitest, deterministic; house convention)

**Pure (`tests/mdh-llm-pipeline.test.js`):**
- `buildVerifyMessages` requests decision-first JSON and terse fields.
- `parseVerification`: strict valid → object; **truncated/partial** (unterminated
  trailing `reasoning`) → recovers `candidates` + `best`; prose/garbage → `null`.
- `buildTrace` emits `calls` in the right order, kinds, rounds, `group`s, and
  derived `status`es for happy / corrected / fallback runs.

**Loop (`tests/mdh-ai-pipeline-loop.test.js`):**
- Happy path: 1 generate + 1 verify (2 llmchat); applies the capped candidate;
  `trace.calls` = `[generate(ok), verify(passed)]`.
- `error`/`empty` → no verify on that round → correction; `error → fix → ok`.
- Verifier flags an `ok`-but-wrong candidate → one correction → improved applied;
  `trace.corrected === true`.
- Progressive angles: round 2 uses `minimal`, round 3 uses `rethink`; cap at
  `MAX_ROUNDS = 3` (≤ 2 corrections); no-progress (`samePipeline`) stops early.
- Worst-case llmchat count = 6 (3 × [gen/fix + verify]).
- Verify parse-fail → **one retry**; still-fail → mechanical fallback (never worse
  than today); a caught error survives a *truncated-but-recoverable* response.
- No-collection → single generate, no execute/verify, applied capped;
  `trace.calls` = `[generate]`. AbortError + 403 still propagate.
- `MAX_ROWS` cap enforced on every executed/applied pipeline.

**Context (`tests/mdh-ai-context.test.js`):** unchanged behavior still passes.

**Render (`tests/mdh-ai-run-trace.test.js`):** the modal renders the linear
call-path (generate → verify [→ fix → verify]) with outcomes; a `> 1`-member
group (constructed in the test) renders parallel lanes; "AI-checked" wording;
fallback trace renders without verifier reasoning.

**Whole-suite:** full `npm test` + `npm run build` green.

## Cost & latency

- Happy path: **2** llmchat calls (was 3), ~3.5 s.
- Worst case: **6** llmchat calls (was up to 9), + **1** only when a verify
  response needs a parse-fail retry.
- Accuracy net **kept** and made **more robust** (lenient parse + retry).
