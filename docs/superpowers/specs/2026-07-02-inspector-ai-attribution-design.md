# Inspector — AI-reasoned attribution + explanation ("ask Mr. Fabry who did it")

- **Date:** 2026-07-02
- **Status:** Design approved; spec under review (pre-implementation)
- **Scope:** Console → Inspector app, the two regex-heuristic attribution panels only
- **Audience:** Internal / dogfood (Rossum SAs)

---

## 1. Problem & intent

The Inspector answers "why is this annotation in this state" across read-only panels. Most
attributions are **verified facts** already in the data (`rule_id`/`hook_id` on a message, a
`workflow_activities` rejection, the `rejected_by` user, a `low_score` score-vs-threshold). But two
panels attribute via **brittle regex scans of hook source + settings JSON** (`src/inspector/culprit.js`):

- **Labels** — which extension applied a label: `extractLabelHooks` / `labelIdsInBlob` /
  `hookReferencesLabelName` / `labelExtensionCandidates` / `extensionAttribution` (`LABEL_APPLY_SIG`).
- **Rejected** (automated-hook case) — which hook rejected the doc: `detectRejectCapability` /
  `rankRejectCandidates` (behind the opt-in "Investigate" button).

These `grep`-style scans can't read a webhook at all, misattribute when the label id/name is
computed or comes from a variable, and only pattern-match rather than *reason about* the hook's
logic. They also never explain *why* in plain language, and the reliability distinction
(`REL.VERIFIED` vs `REL.BEST_EFFORT`) is computed but hidden by `ReliabilityBadge`.

**Intent (the earlier "A + C", scoped):** replace those two heuristic attributions with the
Rossum Agent API ("Mr. Fabry"), which reads the actual hook code / settings / logs (and this
annotation's field values) and returns **both** a reasoned attribution (culprit + confidence)
**and** a plain-language explanation — in one call. Verified attributions stay deterministic and
instant (revisit later).

## 2. Verified facts (grounded)

- Inspector is a per-annotation, read-only Console app (`src/inspector/`). Panels read shared
  signals (`store.data`, `store.enrichment`); no props. Its only write is the opt-in `revalidate`
  in `BlockedPanel` (`api.js:113`).
- Heuristic attribution lives entirely in `culprit.js`: label attribution (`~:182–246`) and
  reject-candidate ranking (`~:335–412`). Everything else in `culprit.js` (verified message/
  rejection/blocker attribution, `fieldProvenance`, `buildPipeline`, `exportHookCandidates`,
  `matchConfigsForField`) is fact- or config-based and stays.
- `api.js` already exposes `getHook` (`:80`, currently unused — returns a hook incl. its code),
  `listHooks` (`:92`), `listRules` (`:94`), `listHookLogs` (`:89`) — enough to gather the evidence
  to seed the agent client-side, no new endpoints.
- The agent transport is reusable as-is: `agentApi.init/createChat/streamMessage` +
  `agentStream` (`createSseParser`/`foldEvents`/`replyText`), already initialized in the console
  shell (`console/index.jsx:123`). Base host `rossum-agent-api.tools.rossum.cloud`; read-only
  persona `/persona cautious`; the agent has read-only Rossum MCP tools (`rossum_get_hook`,
  `list_hook_logs`, etc.) as an optional evidence source.

## 3. Goals / non-goals

**Goals**
- Replace the Labels applied-by-extension attribution and the Rejected automated-hook attribution
  with an agent that reasons over real code/logs; surface a confidence + a plain-language why.
- Auto-run on panel open (only these two panels); one agent call → `{culprit, confidence, explanation}`.
- Reuse the existing agent transport; keep the code isolated in `src/inspector/agentAttribute.js`.
- Delete the retired regex helpers + their tests.

**Non-goals (v1)**
- Touching verified attributions (Blocked low-score, workflow/human rejection, provenance sources).
- Cross-panel "investigate the whole annotation" synthesis (that was option B — deferred).
- Entry assist / "find the annotation" (option D — deferred).
- Any write action; any change to the `revalidate` flow.

## 4. Scope

**Replaced by the agent (auto on panel open):**
1. **Labels → applied-label attribution.** For each *applied* label, "which extension applied it,
   and why." (The "governed by a rule but not applied" list uses rule-target config, not code
   regex — it stays.)
2. **Rejected → automated-hook culprit.** When `classifyRejection` yields the automated case (not
   workflow, not human), "which hook rejected this, and why." Replaces the opt-in
   `rankRejectCandidates` "Investigate" step — now automatic.

**Unchanged (verified, instant):** everything else, including `classifyRejection`'s workflow/human
branches, all of `BlockedPanel`/`ProvenancePanel`/`PipelinePanel`/`ExportPanel`.

## 5. Architecture & components

- **`src/inspector/agentAttribute.js` (new, orchestrator + pure helpers; injected `api`/`agentApi`):**
  - `buildAttributionPrompt({ kind, annotation, target, candidates, logs, fields })` — `kind` is
    `'label'` or `'reject'`; produces a read-only, JSON-only prompt seeded with: the annotation
    summary, the target (the applied label / the rejection), the candidate hooks (id, name, type,
    events, **code + settings**), relevant hook-log lines, and this annotation's field values.
  - `parseAttribution(text)` → `{ culprit: {kind,id,name}|null, confidence: 'high'|'medium'|'low',
    explanation }` | null (lenient JSON extraction, like `agentQuery.parseVerdict`).
  - `runAttribution({ agentApi, kind, context, onPhase, signal })` → `{ verdict, transcript }`:
    `createChat` → prime `/persona cautious` → one turn → `parseAttribution`. Reuses
    `agentApi`/`agentStream`.
  - `gatherLabelContext(api, store, labelId)` / `gatherRejectContext(api, store)` — assemble
    candidates + evidence from the loaded `store.data`/`enrichment`, fetching candidate hook code
    via `api.getHook` where `hooksById` lacks it, and hook logs via the existing enrichment.
- **Store:** `store.attributions` — a signal map keyed by finding (`label:<id>`, `reject`) holding
  `{ status: 'loading'|'done'|'error'|'unavailable', verdict?, error? }`. Reset on annotation
  change (tie to `loadId`).
- **Panels:** `LabelsPanel` and `RejectedPanel` render the agent verdict for the in-scope finding —
  a `CulpritChip` from `verdict.culprit`, the `explanation`, and a **confidence badge** — with a
  "reasoning…" state while `status==='loading'`. They trigger `runAttribution` on mount for each
  in-scope finding (guarded so it runs once per finding per annotation).
- **`ReliabilityBadge`:** extended to render the agent's `confidence` (high/medium/low), finally
  surfacing the certainty the UI hides today.
- **Retire:** `extractLabelHooks`, `labelIdsInBlob`, `hookReferencesLabelName`,
  `labelExtensionCandidates`, `extensionAttribution`, `LABEL_APPLY_SIG`, `detectRejectCapability`,
  `rankRejectCandidates` (and now-unused helpers) from `culprit.js`, plus their tests.

## 6. Data flow (one in-scope finding)

1. Panel mounts → for each in-scope finding not already attributed, set `store.attributions[key] =
   {status:'loading'}` and call `runAttribution`.
2. `gather*Context` assembles candidates + seeded evidence (fetching hook code via `api.getHook` as
   needed).
3. `runAttribution`: fresh chat → `/persona cautious` → one turn with `buildAttributionPrompt` →
   stream (status from `foldEvents`) → `parseAttribution`.
4. On result → `store.attributions[key] = {status:'done', verdict}`; panel renders chip +
   confidence + explanation. Unparseable/prose → `status:'done'` with a null culprit + the raw text
   as the explanation (never fabricate a culprit).
5. Annotation change (new `loadId`) → clear `store.attributions`.

## 7. Prompt + verdict contract

Read-only, JSON-only. The prompt states: "You are investigating a Rossum annotation, read-only —
never modify anything. Given the applied label / the rejection, the candidate extensions (with
their code + settings) and the relevant logs, determine which extension is responsible and why.
Reason about the code's actual logic (a webhook you can't see is opaque — say so). Reply with ONLY
`{ "culprit": {"kind": "hook|rule|webhook|manual|unknown", "id": <id|null>, "name": "<name>"},
"confidence": "high|medium|low", "explanation": "<one short paragraph>" }`." `parseAttribution` is
lenient; a missing/`unknown` culprit is rendered as "unattributed", never guessed.

## 8. Read-only posture (gating)

The Inspector is forensic; the agent must **never** write and must never touch `revalidate`.
Enforced by the cautious persona + read-only framing (same interim posture as MDH). The hard
server-side read-only guarantee remains the ship-blocker before any real (non-dogfood) org.

## 9. Availability & the no-fallback tradeoff (⚠️ confirm at review)

Gated on `probeAgent()`/`aiAvailable`. Per the approved "auto on panel open" choice, when the agent
is unavailable the two in-scope findings show an explicit **"AI attribution unavailable"** state —
the regex heuristics are **deleted, not kept as a fallback**. Consequence: with the agent host down
these two panels lose their attribution entirely (a regression vs. today's offline regex). This is
the accepted design; a slim deterministic safety net is an easy future add if desired. **Flagged for
the spec-review decision.**

## 10. Evidence & data residency

Primary evidence is **seeded client-side** (candidate hook code/settings, logs, field values) so the
common case doesn't depend on the agent's own MCP tool auth (which 401'd on the API test token). The
agent may still pull more via read-only tools. Hook code + annotation field values are sent to
`rossum.cloud` — same data-residency posture as MDH (accepted for internal/dogfood).

## 11. Error handling

- Agent 401 → surface the reconnect message; finding shows "unavailable".
- Stream/timeout error → finding `status:'error'` with a retry affordance; other panels unaffected.
- Abort in-flight attribution on annotation change / unmount (existing `loadId`/abort patterns).
- `gatherContext` failures degrade to whatever evidence loaded (never throw the panel).

## 12. Testing

- `agentAttribute` unit tests (pure): `buildAttributionPrompt` (read-only + JSON-only + seeds
  candidates/logs/fields for both kinds), `parseAttribution` (valid / unknown-culprit / unparseable),
  and `runAttribution` with injected mock `agentApi` (verdict returned; abort).
- `gather*Context` tests with a mock `api`/store (assembles candidates, fetches missing hook code).
- Panel tests (mocked `runAttribution`): loading → attributed chip + confidence + explanation;
  unavailable state; unparseable → unattributed.
- Remove the retired regex-heuristic tests; keep tests for the verified `culprit.js` paths.

## 13. Open items

1. **No-fallback vs. slim deterministic safety net** (§9) — confirm at review.
2. Read-only hard guarantee (§8) — ship-blocker before non-dogfood, same as MDH.
3. Confirm `api.getHook` returns the hook `.code` for webhook vs. function hooks (verify during
   implementation; affects how much the agent can reason vs. must call it "opaque webhook").
