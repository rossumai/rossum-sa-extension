# Inspector Overhaul — Diagnosis Report design

Date: 2026-07-03
Status: approved design, pre-implementation
Scope: `src/inspector/` (Console app), plus entry points in `src/rossum/features/`, `src/background/`, `src/popup/`

## 1. Summary

Replace the Inspector's six isolated question-tabs with a single **Diagnosis Report**:
a one-column, progressively-filling investigation of one annotation. A programmatic
**evidence model** renders instantly (verified facts never wait on AI); the Rossum
Agent ("Mr. Fabry") then synthesizes a **narrative diagnosis with claim→evidence
citations** on top. The report visibly communicates that the investigation is ongoing
(staged progress: Gather → Attribute → Synthesize) and what each section's state is.

Pains addressed (user-confirmed): fragmented story across tabs; answer depth/quality;
missing questions (intake, why-not-automated, config drift, approval workflow);
leveraging Mr. Fabry more, with a nicer visual story.

## 2. Non-goals

- No queue-norm comparison ("is this blocker unusual for this queue") — future work.
- No chat input on the report (option "hybrid report+chat" was considered and not chosen).
- No new writes. `revalidate` (start → validate → cancel) stays the only write, opt-in.
- No change to the dogfood-only stance: a server-side read-only guarantee for the
  agent remains the ship-blocker before non-dogfood use (inherited decision).
- No migration of the removed tab UI state (it was ephemeral `useState`; nothing persisted).

## 3. Current state (verified in code, 2026-07-03)

- Six tabs (`components/App.jsx`): Why blocked / Why rejected / Why labels / Why export
  failed / Extensions / Field provenance; plus Overview + Timeline strips.
- Attribution cascade: verified self-declared facts (`culprit.js`) → programmatic
  correlation (`correlate.js`: request_id → hook/rule logs; rule-action targets) →
  per-finding AI residual (`orchestrate.js` + `agentAttribute.js`, one chat per finding,
  JSON verdict, once-per-key, abortable, no fallback when agent offline).
- Verified gaps found during exploration:
  - `pendingAnnotationId` deep-link consumer exists (`src/console/index.jsx`) but has
    **no producer**; the empty-state copy references a nonexistent button.
  - `loadEnrichment('audit')` and `listEmails` are wired but never called/rendered.
  - Field-targeted messages/blockers carry `datapointId` but no panel resolves it to a
    schema id / field label (`orchestrate.js` has a `m.datapointId ? null : null` placeholder).
  - Tabs never cross-reference evidence; no end-to-end "why not automated" answer.
  - Pipeline "no log" under-communicates "probably ran fine" (logs are a sparse
    failure overlay per live-verified retention behavior).

## 4. Architecture

### 4.1 Evidence model (`src/inspector/evidence.js`, new, pure)

`buildEvidence({ annotation, blocker, content, queue, schema, document, enrichment,
resolved, workflowRuns, workflowSteps, relations, parentDocument, email, live })` →

```js
{
  items: [
    { id: 'blocker:0',           // stable, addressable (used by citations)
      section: 'blockers',       // which report section renders it
      fact: '…one-line human fact…',
      reliability: 'verified' | 'best-effort' | 'unavailable',
      culprit: {kind,id,name} | null,
      sourceRef: '/api/v1/…',    // where the fact came from
      data: {…} },               // section-specific payload for rendering
  ],
  verdict: { … },                // §4.2
}
```

Evidence ids reuse the existing attribution keys where they exist (`message:<i>`,
`blocker:<i>`, `field:<schemaId>`, `label:<id>`, `reject`, `export`) plus new
namespaces (`intake:*`, `workflow:*`, `drift:*`, `timeline:*`). `evidence.js` **calls**
`culprit.js`/`correlate.js`; their function contracts do not change (existing tests
keep passing). Residual AI attribution results are merged into the matching evidence
item when they land.

Fix folded in: messages/blockers with a `datapointId` are resolved to their
`schema_id` + schema label via the content tree + schema (data already loaded), so
field-targeted findings finally name their field.

### 4.2 Programmatic verdict ("why not automated") — computed in `evidence.js`

Deterministic resolution, no AI, renders instantly with a `verified` badge:

1. `annotation.automated === true` → "automated" (and exported/confirmed state).
2. Queue automation off (`automation_level: 'never'` / disabled) → config cause.
3. Else walk `automation_blocker.content[]`:
   - `error_message` → the specific blocking error messages with their verified culprits.
   - `low_score` → the specific fields with confidence vs threshold
     (`datapoint.score_threshold ?? queue.default_score_threshold` — live-verified).
   - other typed blockers with best-effort culprits from `details.detail[0]`.
4. No blocker resource and not automated → honest "not recorded" statement
   (correctness-over-guessing; never invent a cause).

### 4.3 Progressive investigation lifecycle

New `investigation` signal in `store.js`: `{ stage, sources: {done, total}, … }` with
stages **gathering → attributing → synthesizing → complete** (or `agent-offline`,
which ends after attributing with programmatic results only).

1. **Gather** — core GETs (annotation, blocker, content, queue, schema, document) render
   the skeleton + verdict immediately; enrichment sources (workflow activities, notes,
   hook logs, rule logs, workflow runs/steps, relations, parent doc, email, labels,
   rules, hooks) each land independently; every report section has its own state chip:
   `pending → loaded / unavailable / n-a`. No whole-page spinner.
2. **Attribute** — existing `orchestrate.js` runs unchanged (programmatic correlation
   synchronously, per-finding AI in background); live phase chips as today; results
   merge into evidence items.
3. **Synthesize** — starts when the attribute stage settles (all attribution promises
   resolved; their transport already carries a 90s idle-timeout abort — no new timeout
   machinery). One Fabry chat per annotation (§4.4). Streams into the diagnosis panel.
4. **Complete** — progress strip collapses to a stat line
   ("7 sources · 4 attributions · 1 unavailable").

Abort semantics: switching annotations aborts gather/attribute/synthesize via the
existing `attrController`/`loadId` guard pattern, extended to synthesis.

### 4.4 Synthesis (`src/inspector/synthesize.js`, new)

- `buildSynthesisPrompt(evidence)` — serializes the evidence model compactly
  (id + fact + reliability + culprit per item; verdict first). Reuses the head/middle/tail
  budgeting (`budgetedJoin`, 48k cap with omission notes) **extracted from
  `agentAttribute.js` into a shared helper** so both callers use one implementation.
  Instructions: read-only framing; write a short narrative diagnosis; **cite evidence
  ids inline** using `[e:<id>]` markers; explicitly state what is `unavailable` rather
  than guessing; end with the single actionable conclusion. Fabry may use its own
  read-only tools for residual gaps, but any claim not backed by a citation renders
  as unverified.
- `runSynthesis({agentApi, evidence, onPhase, onText, signal})` — fresh chat, primed
  `/persona cautious` (same transport as `agentAttribute.js`), streams text deltas;
  `onPhase` reports live agent activity for the strip.
- `parseCitations(text)` — pure; splits streamed text into
  `[{text} | {cite: '<evidence-id>'}]` segments. A citation that doesn't resolve to a
  known evidence id renders as a visibly-unverified marker (not a link).
- Transcript: the synthesis turn's reasoning + tool activity is kept (accumulator
  already collects it) and shown in a read-only "View investigation" modal. No chat
  continuation in v1.

### 4.5 Config drift (`src/inspector/driftDiff.js`, new, pure)

Stays **opt-in** (validate takes a brief reviewing lock — a user-consented side effect).
Output upgraded from a raw count to a real diff of persisted vs live messages, matched
by `(type, content, datapoint id)` tuples: added / removed / unchanged, plus the
`matched_trigger_rules` list. Renders in the Drift section; if run before synthesis
starts, the diff joins the evidence model (`drift:*`) and the narrative can cite it.
Running it later does NOT trigger a re-synthesis in v1 — the diff renders in its
section only.

## 5. UI — single-column Diagnosis Report

Layout approved via browser mockup (single-column over two-column). Top to bottom:

1. **ReportHeader** — merged Overview + status Timeline (id, file name, queue/schema
   chips, status pill, step timeline with gaps).
2. **InvestigationStrip** — `Gather ✓ 7/7 → Attribute ◐ 2 of 4 → Synthesize ○`, with
   Mr. Fabry's live activity text at the right ("reading the code of '<hook name>'…").
3. **VerdictCard** — programmatic verdict (§4.2), left-edge severity color, verified badge.
4. **DiagnosisPanel** — states: skeleton (waiting on attribution) → streaming text with
   citation chips (chips scroll to + flash the evidence item) → complete with stat line
   + "View investigation" transcript link; or `agent-offline` / `failed` notes with the
   programmatic report fully usable underneath.
5. **Evidence sections** (collapsible `EvidenceSection` wrapper, each with a status chip
   `loaded / attributing / logs sparse / unavailable / n/a / opt-in`):
   - **Intake & origin** (new) — arrival story: email attachment / upload / split parent
     / archive extraction (`attachment_status`, `document.parent`), duplicate relations,
     einvoice flag, sender (when email shape verifies).
   - **Blockers & messages** — today's BlockedPanel content, now naming the targeted
     field for datapoint-scoped items.
   - **Fields** — provenance table + confidence-vs-threshold bars; MDH config attribution
     as today.
   - **Extension runs** — pipeline phases; "no log" relabeled
     "no log — likely ran (only failures are logged)".
   - **Labels** — as today (rule-applied verified; residual AI).
   - **Rejection** — as today (workflow/manual/hook taxonomy); n/a state when never rejected.
   - **Approval workflow** (new) — run status, current step, step list with modes,
     assignees from `step_started` activities.
   - **Export** — as today; n/a when no export attempted.
   - **Config drift** (new) — opt-in button + diff render (§4.5).
6. Landing state (input + recents) unchanged.

Empty-state copy fixed to match reality (button now exists — §7).

Styling: existing `console.css` variables and `.inspector-*` conventions; new classes
for the strip, verdict, diagnosis, citation chips, section chips, confidence bars.
Dark mode via the existing variable overrides.

## 6. Data / API additions (`src/inspector/api.js`)

All best-effort (`safeListAll` / 403-404-tolerant):

- `listWorkflowRuns(annotationId)` — `/api/v1/workflow_runs?annotation=`
- `listWorkflowSteps(workflowId)` — `/api/v1/workflow_steps?workflow=`
- `getRelation(url)` — from `annotation.relations[]` (only `type:"duplicate"` used;
  `edit` relations ignored for intake, per verified lineage semantics)
- `getEmail(url)` — from `annotation.email` (shape verification pending, §8)
- The existing unused `listEmails` (queue-scoped outgoing emails) is **removed** —
  intake uses `getEmail(annotation.email)` instead. `loadEnrichment('audit')` stays
  unused for v1 — audit logs remain out of scope.

## 7. Entry points (deep-link producer)

- **Content script**: new `src/rossum/features/inspect-annotation.js` — self-gates on
  annotation routes (`/document/<id>`), injects a small "Inspect this annotation"
  button, messages the background worker
  `{type: 'openInspector', token, domain, annotationId}`.
- **Background worker**: new handler stages `consoleAuth_<uuid>` with
  `{app: 'inspector', pendingAnnotationId, token, domain, createdAt}` and opens
  `console/console.html?authId=…` — the consumer already exists (`console/index.jsx`).
- **Popup**: when the active tab URL is an annotation page, show "Inspect this
  annotation" → `openConsoleTab(tab, {...auth, pendingAnnotationId}, 'inspector')`.
- Feature gating: popup toggle `inspectAnnotationEnabled`, **default on** (storage-backed,
  consistent with the repo's feature-toggle pattern; not always-on). The toggle gates
  only the content-script injection; the popup's own button always shows when the
  active tab is an annotation page.
- The `/document/<id>` path segment is the **annotation** id (established convention,
  matches `IdInput.parseId`).

## 8. Pre-implementation live verification (no assumptions)

Run against a dev org with synthetic data; any failing check degrades its evidence
item to an honest `unavailable` (never a guess). No customer names or data may appear
in specs, fixtures, commits, or verification notes.

| # | Check | Why it matters |
|---|-------|----------------|
| V1 | Populated email shape: `annotation.email` → `GET /emails/<id>` (sender, subject) | Intake sender line |
| V2 | `workflow_run` statuses beyond `approved`; human assignees on `step_started` | Workflow section states |
| V3 | Blocker `details.detail[0]` hook/rule name populated shape | Best-effort blocker culprits |
| V4 | `message.detail.request_id`: per-invocation vs shared across a validation run | `correlateMessage` reliability tier (verified vs best-effort) |
| V5 | Agent citation compliance on a near-cap evidence prompt | Citation UX viability; fallback = render plain narrative without chips |

Already verified (2026-06-18/19 live research, re-checked against memory):
`attachment_status` values, `document.parent`, duplicate relations, confidence/threshold
fallback chain, validate response shape, hook-log path/fields/retention, rejection
taxonomy, label model, MDH config target matching.

## 9. Error handling

- Every source load independent + 403/404-tolerant; failed source ⇒ section
  `unavailable` with reason, and the evidence model records the gap so the synthesis
  prompt states it explicitly (Fabry never narrates over missing data silently).
- Synthesis failure / agent offline ⇒ diagnosis slot shows an honest note; the
  programmatic report (verdict + evidence) is fully usable without it.
- Annotation switch aborts everything in flight (`loadId` + `AbortController` guards,
  extended to synthesis); stale writes are dropped as today.
- `revalidate` 409 (annotation being reviewed by someone) surfaces as a visible note.
- Unresolvable citation ids render as unverified markers, never links.

## 10. Backward compatibility

- `inspectorRecents` key + entry shape unchanged (renderer tolerates added fields).
- `consoleAuth_<uuid>` staging contract unchanged; `pendingAnnotationId` is an optional
  field the consumer already reads; single-use + 24h TTL purge semantics untouched.
- Rail id `inspector`, `boot.js isValidApp`, Console shell wiring unchanged.
- `culprit.js` / `correlate.js` public functions unchanged (wrapped, not rewritten).
- `revalidate` remains the only write path.
- New storage key `inspectAnnotationEnabled` is additive (popup toggle).
- Removed: the tab bar (ephemeral UI state only). No persisted Inspector state existed
  besides recents.

## 11. Privacy & read-only stance

- Evidence serialization is sent only to the Rossum-internal Agent API — the same trust
  boundary as today's attribution prompts. No third-party calls.
- All fixtures/examples synthetic. Never leak customer names or customer data in code,
  tests, docs, or commit messages.
- Read-only framing (`/persona cautious` + prompt instructions) is defense-in-depth,
  not a guarantee; the server-side write-lock remains the ship-blocker before any
  non-dogfood rollout (unchanged, inherited from the MDH agent decision).

## 12. Testing

- **Pure**: `evidence.js` per-section builders + verdict tree; `driftDiff`;
  `buildSynthesisPrompt` budget/omission; `parseCitations` (incl. unresolvable ids,
  streaming-boundary splits); intake classification (each `attachment_status` value,
  split parent, duplicate relation).
- **Components**: DiagnosisPanel all states; InvestigationStrip stages;
  EvidenceSection chips; new Intake/Workflow/Drift sections; header/timeline merge.
- **Orchestration**: stage transitions, per-section progressive fill, abort mid-stage,
  agent-offline path, synthesis-after-attribution ordering.
- Conventions: `.test.js` files rendering via `h(Component, null)` (no raw JSX);
  condition-based `waitFor` (no fixed timeouts); synthetic fixtures only.

## 13. Decisions log (user-confirmed)

- Approach A (evidence model + one synthesis run) over agent-led investigation and
  incremental tabs — with the explicit progressive-investigation requirement.
- Single-column layout over two-column sticky diagnosis (chosen from browser mockups).
- New questions in scope: intake & origin, why-not-automated verdict, config drift
  diff, approval workflow state.
- Entry points: both content-script button and popup button (toggle-gated, default on).
- Drift check stays opt-in (reviewing-lock side effect).
- Fabry's role grows (narrative synthesis + visible live activity) but never gates
  the verified tier.
