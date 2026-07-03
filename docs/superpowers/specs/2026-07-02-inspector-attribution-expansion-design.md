# Inspector — attribution expansion (programmatic-first, AI-for-the-gap) + prefetch orchestrator

- **Date:** 2026-07-02
- **Status:** Design approved (pre-spec-review)
- **Scope:** Console → Inspector app — Blocked (messages + non-standard blockers), Export, Field provenance; plus a load-time attribution orchestrator
- **Audience:** Internal / dogfood (Rossum SAs)

---

## 1. Problem & intent

The Inspector already AI-attributes two findings (hook rejection, applied non-rule labels). The rest of the
app still leaves gaps where it can't attribute a cause: **error/warning messages with no self-declared
producer**, **non-standard automation-blocker types**, **ambiguous export failures**, and **fields whose
source is `connector`/`rules` or an unnamed `data_matching`**. The rule of thumb: **if a cause can be
determined programmatically and reliably, do that (VERIFIED/BEST_EFFORT, instant); otherwise fall back to
the agent.** Additionally, because the agent is slow, attribution should be **prefetched on annotation load**
so any tab is already warm when opened.

## 2. Verified facts (grounded this session + code)

Confirmed live (read-only, org 1 on elis.rossum.ai):
- **Hook logs carry `request_id` AND `uuid` (identical), plus `hook_id`, `action`, `event`, `status`,
  `status_code`, `log_level`, `message`, `start`/`end`.** (`GET /api/v1/hooks/logs?annotation=`.)
- **Blockers**: `low_score` (per-datapoint, `schema_id`) + `automation_disabled` (annotation-level) — both
  already VERIFIED by `explainBlocker`.
- **Provenance `src`** values seen: `human`, `score`, `not_found`, `NA`. (`not_found` currently has no entry
  in the panel's `SRC_LABEL` map — a small existing display gap to fix.)

Grounded from authoritative code + API tool contracts + prior verified memory (the org had no
messages/rejections/export-failures to observe, and its only annotation is `exported`/non-startable; per the
approved decision these are pinned via TDD fixtures and re-checked against real data during implementation):
- **Messages self-attribute** via `detail.{hook_id | rule_id}`, `detail.request_id`, `detail.is_exception`,
  top-level `id` (= datapoint id for field-scoped) — exactly what `classifyMessage` reads.
- **`rules_execution_logs`** carry `{rule_id, rule_name, annotation_id, trigger_event, execution_result,
  execution_error, request_id}`.

**Ship-gate to confirm during implementation (§9):** whether a hook-log `request_id`/`uuid` is **per hook
invocation** (so a message's `detail.request_id` maps to exactly one hook) or **shared across a whole
validation run** (ambiguous). The cascade is designed to be safe either way: if the id proves ambiguous, the
request_id step is skipped and the finding falls through to the next signal.

## 3. Goals / non-goals

**Goals**
- Fill the four attribution gaps using a **programmatic-first cascade**, AI only when no deterministic signal
  exists. Verified/best-effort programmatic attributions stay instant and never call the agent.
- **Prefetch orchestrator**: on annotation load, fetch all enrichment in parallel, compute all findings, run
  programmatic attributions synchronously, and launch AI attributions in the background — so panels render
  instantly and the slow AI work is already in flight. Panels become pure renderers of `store.attributions`.
- Reuse the existing agent transport + `runAttribution` + live-progress (`onPhase`) + `CulpritChip` +
  `ReliabilityBadge`. Hoist the existing reject/label attribution launches into the orchestrator (same
  result, launched earlier) so all attribution lives in one place.

**Non-goals (this iteration)**
- Any write to the customer org; any change to the `revalidate` flow.
- Pipeline "explain a failed step" and the Overview/Timeline narrative synthesis (still deferred).
- A server-side read-only guarantee for the agent (unchanged ship-blocker before non-dogfood use).

## 4. Scope — the four gaps + the cascade

Every finding resolves via this cascade; the first tier that yields a culprit wins:

**A. Blocked → messages** (per message that `classifyMessage` leaves `culprit == null`):
1. `detail.rule_id`/`hook_id` present → VERIFIED (already handled by `classifyMessage`; not a gap).
2. **`request_id` → hook log** (`msg.requestId === log.request_id || log.uuid`) → `{kind:'hook', id, name}`,
   VERIFIED (pending §9 cardinality; else skipped).
3. **`rules_execution_logs`** for this annotation sharing the `request_id` → `{kind:'rule', id, name}`,
   BEST_EFFORT.
4. **AI** — agent reads the queue's extension code/logs + the message text/level/field and reasons which
   extension produced it.

**B. Blocked → non-standard blockers** (blocker `type` not in `low_score`/`automation_disabled`/
`error_message`, and no `details.detail[0].rule_name`/`hook_name`):
1. Standard types → VERIFIED (kept).
2. **AI** — explain what the blocker type means + the likely cause (reasoning from hooks/rules on the queue).

**C. Export** (when `exportHookCandidates` cannot name the failing hook — multiple export hooks, none in the
logs — or the recorded error text is opaque):
1. Failing hook found in logs → VERIFIED (kept), incl. its error text.
2. **AI** — reason which export extension most likely failed and explain the error in plain language.

**D. Field provenance** (per field whose `primary` source is `rules`, `connector`, or `data_matching`
without a config that names it — i.e. `matchConfigsForField` empty):
1. `data_matching` named by an MDH config → VERIFIED (kept).
2. **`rules`** → a `rules_execution_logs` success for this annotation whose rule's action targets this
   `schema_id` → `{kind:'rule', id, name}`, BEST_EFFORT.
3. **AI (batched)** — one call for all remaining ambiguous fields → an array of `{schema_id, culprit,
   confidence, explanation}`.

Unchanged/VERIFIED and never sent to AI: standard blockers, self-attributed messages, workflow/manual
rejection, rule-applied labels, in-log export failures, `human`/`score`/`formula`/named-`data_matching`
provenance, the whole pipeline view, Overview, Timeline.

## 5. Architecture & components

- **`src/inspector/correlate.js` (new, pure, unit-tested):** programmatic correlation.
  - `correlateMessage(msg, { hookLogs, ruleLogs, hooksById })` → `{ culprit, reliability } | null` (tiers 2–3
    above; hook-log match preferred over rule-log). `msg` is a `classifyMessage` result.
  - `correlateField(schemaId, { ruleLogs, rules })` → `{ culprit, reliability } | null` (tier D2).
  - No DOM, no network; takes already-loaded data.
- **`src/inspector/orchestrate.js` (new):** the load-time driver.
  - `computeFindings(store)` → `[{ key, kind, payload }]` for every finding needing attribution
    (`message:<i>`, `blocker:<i>`, `export`, `field:<schema_id>`, plus the existing `reject` and
    `label:<id>`), derived from `store.data`/`enrichment`.
  - `orchestrateAttributions({ store, api, agentApi, signal })` — called on annotation load after enrichment
    is fetched: for each finding, try `correlate*` (or the existing verified paths); on a programmatic hit,
    `store.setAttribution(key, { status:'done', verdict, source:'programmatic' })`; otherwise, when
    `aiAvailable`, launch `runAttribution`/batch in the background (guarded once-per-key, `onPhase` live
    progress, abort on annotation change). Fields batch into one AI call.
  - Enrichment prefetch: on load, fetch `hookLogs`, `notes`, `workflow`, `ruleLogs`, plus `loadQueueHooks` +
    `loadLabelContext` in parallel (all already `safe`/403-tolerant), then run the orchestrator.
- **`src/inspector/agentAttribute.js` (extend):** `buildAttributionPrompt` gains `kind` values
  `'message'`, `'blocker'`, `'export'`; add `buildFieldBatchPrompt(fields, context)` + `parseFieldBatch(text)`
  (array of `{schema_id, culprit, confidence, explanation}`) + `runFieldBatchAttribution(...)`. Each new
  single-kind prompt is read-only + JSON-only, seeded like the existing ones (candidates w/ code+settings,
  logs, fields) plus the finding-specific target (the message text/level/field; the blocker type/field; the
  export error + export-event hooks).
- **`src/inspector/attributionContext.js` (extend):** `gatherMessageContext`, `gatherBlockerContext`,
  `gatherExportContext`, `gatherFieldsContext` — each wraps candidate gathering (reuse
  `activeQueueHooksWithCode`) + the finding's target; never throws (→ empty context).
- **`src/inspector/store.js` (extend):** `attributions` now also holds `message:<i>` / `blocker:<i>` /
  `export` / `field:<schema_id>` entries. Entry shape gains an optional `source: 'programmatic' | 'ai'` and
  reuses `{ status, verdict, phase?, error? }`. Reset per annotation (already wired).
- **Panels → pure renderers:**
  - `BlockedPanel` `MsgRow` and each blocker card render `store.attributions[key]`: programmatic verdict
    (CulpritChip + verified/best-effort badge) or AI verdict (CulpritChip + confidence + explanation, live
    `phase` while loading), or the existing self-attributed culprit when present.
  - `ExportPanel` renders the `export` attribution when the programmatic path is ambiguous.
  - `ProvenancePanel` renders the `field:<schema_id>` attribution for ambiguous fields (adds `not_found` to
    `SRC_LABEL`).
  - `RejectedPanel`/`LabelsPanel` keep rendering their `reject`/`label:<id>` entries but **no longer launch**
    the attribution themselves — the orchestrator does. (Same visible result; launched at load.)
- **`ReliabilityBadge`/`CulpritChip`:** unchanged; reused for programmatic (verified/best-effort) and AI
  (high/medium/low) tiers.

## 6. Verdict & prompt contracts

- Single-finding AI verdict (message/blocker/export) = the existing `{ culprit:{kind,id,name}|null,
  confidence:'high'|'medium'|'low', explanation }`; `parseAttribution` reused. Blocker "explain" may return a
  null culprit with an explanation (that's valid — the value is the explanation).
- Field batch verdict = `{ fields: [{ schema_id, culprit|null, confidence, explanation }] }`; missing entries
  render as unattributed (never fabricated).
- Programmatic verdict = `{ culprit, reliability, explanation? }` with `source:'programmatic'` — rendered with
  the verified/best-effort badge, no agent call.
- All AI prompts: read-only framing (`/persona cautious` + "never modify / reject / revalidate"), JSON-only,
  seeded with candidate extension code/settings/logs + this annotation's compact fields + the finding target.

## 7. Prefetch, cost & concurrency

- On annotation load the orchestrator runs once (keyed to the load id / `annotationId`), aborting any prior
  run. Programmatic attributions are synchronous and free. AI attributions launch in the background only for
  findings with no programmatic answer and only when `aiAvailable`.
- Fields are **batched** into a single AI call. Messages/blockers/export are per-finding (typically few).
- No silent cap that hides work: if the finding count is large, still launch all (dogfood scale); revisit a
  concurrency cap only if it proves necessary. Every AI launch is abortable on annotation change.

## 8. Read-only posture

Unchanged and paramount: the agent and all new code only READ (already-loaded data + `getHook`/`listHooks`/
`listRules`/`listHookLogs`/`listRuleExecutionLogs`), never write, never touch `revalidate`. Programmatic
correlation is pure over already-fetched data. `/persona cautious` + read-only prompt framing remain
defense-in-depth; the server-side write guarantee stays the pre-prod ship-blocker.

## 9. Open items / implementation-time verification

1. **`request_id` cardinality** (§2) — confirm per-invocation vs per-run before trusting tier-2 message
   correlation as VERIFIED; if shared, skip that tier (fall through to rule-log / AI). Pin with a fixture and,
   if possible, a live check on a real annotation that has messages.
2. **Field batch volume** — if a queue routinely has many ambiguous fields, confirm the single batched prompt
   stays within a reasonable size; chunk if needed.
3. Read-only hard guarantee (§8) — unchanged ship-blocker before non-dogfood use.

## 10. Testing

- `correlate.js` (pure): `correlateMessage` hook-log match (by `request_id` and by `uuid`), rule-log match,
  preference order, no-match → null; `correlateField` rule-action-targets-field match, no-match → null.
- `orchestrate.js`: `computeFindings` enumerates the right findings from a fixture; `orchestrateAttributions`
  sets programmatic verdicts synchronously, launches AI only for the residual, guards once-per-key, aborts on
  annotation change (mocked `api`/`agentApi`).
- `agentAttribute.js`: new-kind prompts (read-only + JSON-only + seeds); `parseFieldBatch` (valid / partial /
  unparseable → no fabrication).
- Panels (mocked orchestrator/store): BlockedPanel renders programmatic vs AI vs self-attributed message
  culprits + live phase; ExportPanel ambiguous → AI verdict; ProvenancePanel ambiguous field → attribution +
  `not_found` label; Rejected/Labels still render their entries (now orchestrator-fed).
- Backward-compat: verified paths (standard blockers, self-attributed messages, in-log export, named
  provenance, workflow/manual rejection, rule labels) unchanged and never trigger an agent call.
