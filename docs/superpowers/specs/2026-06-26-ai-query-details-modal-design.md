# "AI query details" modal — clarity redesign

**Date:** 2026-06-26
**Status:** Draft — pending user review
**Area:** MDH AI pipeline input → the "AI query details" modal
(`src/mdh/components/AiRunTrace.jsx`, `src/console/console.css`).
**Approved mockup:** a clickable HTML mockup (synthetic data) was reviewed and
approved before this spec; this spec captures that design.

## Problem / goal

The detail modal (`AiRunTraceDetails`) doesn't make it clear **how the AI
progressed, why, or what the terms mean**. Today it renders two parallel
representations of the same run in different vocabularies — a jargon **timeline**
(`Generate (exact) · ok · 1200ms`) and **per-round candidate cards** (`exact`,
`score 90`, `✓ picked`/`★ applied`) — plus a terse context line. The original
request isn't restated, the approach/score/verdict terms are unexplained, and the
result rows the AI actually checked are hidden.

**Goal:** a single, humanized, **structured-and-explained** step-by-step trace —
keep the structured layout (not prose), humanize every label, explain the jargon
in place, and surface the result sample. **Decided with the user (2026-06-26):**
structured-and-explained (not narrative prose); **unify** the timeline + round
cards into one step list; **show the result sample, collapsed**; **omit per-step
durations**; the "Refined" step node uses the warning hue.

This is a **render-only** change: the trace data model, `buildTrace`, the loop,
and the collapsed `AiRunTrace` bar are unchanged.

## Data model used (unchanged — all fields already exist)

`trace` (from `buildTrace`, verified in `llmPipeline.js`):

| Field | Used for |
|-------|----------|
| `request` | the "You asked" header |
| `status` (`ok`/`empty`/`error`/`unverified`) | outcome banner tone |
| `corrected` (bool) | the `self-corrected` tag |
| `verifierReasoning` | (final reasoning; per-round `reasoning` preferred per step) |
| `calls[]` `{seq,kind:'generate'|'fix'|'verify',round,angle?,status,durationMs?,group}` | **drives the ordered step list** |
| `rounds[]` `{kind,trigger?('empty'|'error'|'mismatch'),reasoning?,candidates[]}` | per-step detail (joined to calls) |
| `rounds[].candidates[]` `{angle,pipelineText,verdict,rowCount,error?,sample?,answersRequest?,score?,issue?,picked,applied}` | query, result sample, score, issue, why |
| `hints` `{collection,fields,knownValues[],numericStrings[],searchIndexes[],typedFields,ranges,arrayPaths[]}` | the context line |

`durationMs` and `group` are intentionally **not** rendered (no timing; no
parallel branches exist in the gated loop).

## Design

### Layout (top → bottom, inside `.modal-body`)

1. **Request + outcome header.** An uppercase `You asked` label + the request in
   quotes; below it a tinted **outcome banner** (success/warning/danger ground)
   with an icon, a plain sentence, and a `self-corrected` tag when `corrected`.
2. **One unified step list** — a vertical spine of numbered nodes with connectors;
   one step per entry in `trace.calls`, humanized (below).
3. **Context line** — humanized `hints` ("What the AI knew: collection vendors ·
   12 fields · sample values for state, country · search index default").
4. **Glossary** — a `<details>` collapsed by default ("What these terms mean")
   defining approach, score/checked, and "what the AI knew".

### The step list — driven by `trace.calls`, joined to `rounds`

A pure, testable helper `buildStepViews(trace) → Step[]` produces the render
model; the component maps it to DOM. For each call in `trace.calls` (already
ordered), in order:

- **`generate` / `fix`** → a **Wrote a query** / **Refined the query** step.
  Join to its candidate: `cand = rounds[call.round-1]?.candidates.find(c => c.angle === call.angle)`
  (angle is unique within a round's candidates — verified: round 1 = `[exact]`;
  a correction = `[incumbent, fix]` with distinct angles). From `cand`: the
  result chip (from `call.status`/`cand.verdict`), the collapsible `pipelineText`,
  and the collapsible `sample`. A `fix` whose `call.status` is `failed`/`duplicate`
  has **no** candidate (the loop recorded the call but added no round) → render the
  chip + a short note, no collapsibles.
- **`verify`** → a **Checked the result** step. `round = rounds[call.round-1]`;
  `chosen = round?.candidates.find(c => c.picked)`. Chip from `call.status`
  (+ `chosen.score`); the `why` is `round.reasoning` (the verifier's own words).

Node index = 1-based position in the step list. Node hue: write → accent ring,
refine → warning ring, check → filled accent.

### Humanization maps (the "explained" half — all derived, no new data)

**Step action** (`call.kind`): `generate`→ "Wrote a query"; `fix`→ "Refined the
query"; `verify`→ "Checked the result".

**Approach** (`call.angle`, shown as a pill + a one-line note on write/refine):

| angle | pill | note |
|-------|------|------|
| `exact` | direct approach | Translated your request literally, matching stored values exactly. |
| `tolerant` | format-tolerant | Allowed for value/format differences (case, codes, text matching). |
| `minimal` | minimal fix | Smallest change to the previous attempt that could fix it. |
| `rethink` | rebuilt | Rewrote the query from scratch with a different strategy. |

**Result chip** (write/refine — from `verdict`/`status`):

| verdict/status | chip text | tone |
|---|---|---|
| `ok` | `{rowCount} rows` (`1 row` singular) | ok (green) |
| `empty` | `0 rows · no matches` | warn |
| `error` | `database error` | bad (red) |
| `invalid` | `not a valid query` | bad |
| `unrun` | `ready · not run` | neutral |
| `failed` | `couldn't write a query` | bad |
| `duplicate` | `repeated a previous attempt` | neutral |

**Check chip** (verify — from `call.status` + chosen `score`):

| status | chip text | tone |
|---|---|---|
| `passed` | `looks right · {score}/100` (omit `· N/100` if no score) | ok |
| `flagged` | `doesn't fully match` | warn |
| `parse-fail` | `couldn't verify automatically` | neutral |
| `failed` | `check failed` | neutral |

**The "why"**:
- **Refine step** `why`: `Retried because ` + the round `trigger` → `empty`:
  "the previous query returned no rows"; `error`: "the previous query hit a
  database error"; `mismatch`: "the check found: " + the **incumbent's** `issue`
  (`rounds[round-1].candidates.find(c => c.angle !== call.angle)?.issue`).
- **Check step** `why`: the round's `reasoning` (verbatim verifier reasoning),
  shown when present.

### Outcome banner derivation

- `status==='ok'` + final verify `passed` → `✓ Applied a checked query — {n} rows`.
- `status==='ok'` + not checked (no passed verify, e.g. no-collection / fallback)
  → `✓ Applied a query — {n} rows (not checked)`.
- `status==='empty'` → `⚠ Applied — 0 rows (no matches)` (warn ground).
- `status==='error'` → `✕ Query failed: {truncated error}` (danger ground).
- `status==='unverified'` with a chosen pipeline → `Query ready — not run` (neutral).
- no chosen pipeline → `✕ No usable query produced` (danger).
- Append a `self-corrected` tag when `trace.corrected`.

"Checked" = the last `verify` call in `trace.calls` has `status==='passed'`.

### Result sample rendering

Collapsed `<details>` ("Show results (3 of {rowCount})"). Renders `cand.sample`
(≤3 rows) as a compact table: columns = the union of the sample rows' top-level
keys in first-seen order, **excluding `_id`**; cells stringify scalars and
JSON-encode nested/array values, with `tabular-nums` for alignment. Values may be the user's own
data — rendered in the user's own browser only, never exported. (Tests use
synthetic rows.)

### Edge / empty states

- `trace` null → render nothing (unchanged guard).
- `trace.calls` empty/absent (older trace) → skip the step list, still render the
  request + outcome header + context (graceful fallback; no crash).
- A round/candidate not found for a call → render the step from the call alone
  (action + humanized status chip), no collapsibles.

### Component structure

| File | Change |
|------|--------|
| `src/mdh/components/AiRunTrace.jsx` | Replace `AiRunTraceDetails`'s body (timeline + rounds) with the unified step list. Add pure exported `buildStepViews(trace)` + small label maps (`APPROACH`, `APPROACH_NOTE`, `verdictChip`, `checkChip`, `refineWhy`, `outcomeBanner`). Remove `CallPath`/`groupCalls`/`callLabel`, `roundTitle`/`verdictLabel`/`TRIGGER_WHY`, `hintsLine` is reworked. `AiRunTrace` (the bar) and `DOT_CLASS` are unchanged. |
| `src/console/console.css` | Replace the `.ai-trace-timeline`/`.ai-trace-step*`/`.ai-trace-call*` + `.ai-trace-round*`/`.ai-trace-cand*` rules with the new step-spine + chip + collapsible + glossary rules (`.ai-trace-*`). Reuse existing tokens only (`--accent`, `--success`/`--warning`/`--danger` + `-bg`/`-fg`, `--border`, `--bg-code`, `--text-*`, `--font-mono`, `--radius`). The `.modal-card:has(.ai-trace-body)` max-width rule stays. |

`buildStepViews` is pure (no DOM) → unit-testable directly; the component render
is covered by jsdom tests.

## Out of scope

- Any change to `buildTrace`, the loop, `trace.calls`/`rounds`/`hints` shape, or
  the collapsed `AiRunTrace` bar / its summary.
- Per-step timing display (durations stay in the data, unrendered).
- New persisted state; the modal stays ephemeral.
- Re-introducing a separate timeline strip.

## Testing (vitest)

**Pure (`tests/mdh-ai-run-trace.test.js`, extend):**
- `buildStepViews`: a happy-path trace (generate `ok` + verify `passed`) →
  2 steps `[write, check]` with the right actions, approach `direct approach`,
  chips `N rows` / `looks right · 95/100`; the write step exposes `pipelineText`
  + `sample`.
- A self-corrected trace (generate `empty` → fix `ok` → verify `passed`) →
  3 steps `[write, refine, check]`; refine `why` contains "returned no rows";
  refine approach `minimal fix`.
- A `mismatch`-triggered refine → `why` contains the incumbent's `issue`.
- A `failed`/`duplicate` fix call (no candidate) → a step with the right chip and
  no `pipelineText`/`sample`.
- `outcomeBanner`: ok-checked / ok-not-checked / empty / error / unverified /
  no-chosen → correct text + tone; `self-corrected` tag when `corrected`.
- Empty `calls` → `buildStepViews` returns `[]` (header still renders).

**Render (jsdom, same file):**
- The modal shows the request, the outcome banner, the numbered steps, the
  humanized chips, a collapsed `<details>` for query and for results, and the
  collapsed glossary; clicking a `<summary>` reveals its content.
- No `verified` literal remains; the bar test (collapsed summary, `self-corrected`
  tag, opens modal) still passes.

**Whole-suite + build:** `npm test` + `npm run build` green.
