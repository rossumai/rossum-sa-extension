# Annotation Inspector — Design Spec

- **Date:** 2026-06-18
- **Status:** Approved for planning
- **Component:** new Console app in `rossum-sa-extension`
- **Author context:** Solution-architect tooling; community Chrome extension (MV3).

> Every data-model claim in this spec was verified live against a real Rossum org
> (`api.elis.rossum.ai`) on 2026-06-18, or cited from the maintained `rossum-sa`
> references. Claims that could **not** be verified are explicitly marked
> `[BEST-EFFORT]` or `[LIMITATION]` — the tool never guesses a culprit.

---

## 1. Problem & goal

Rossum surfaces validation **messages**, **automation blockers**, **rejections**,
and **export failures** on an annotation, but the UI does not tell a solution
architect *where each one came from* — which extension, rule, workflow, or setting
produced it. Debugging today means manually cross-referencing hooks, rules, logs,
and queue settings.

**Goal:** a read-first forensics view that, given one annotation, answers four
"why" questions and — above all — **names the culprit** for each issue, with an
honest reliability label on every fact.

## 2. Scope

In scope (all four confirmed with the user):

1. **Why blocked from automation** — messages + automation-blocker items → producer.
2. **Why rejected** — manual / workflow / hook taxonomy → culprit + reason.
3. **Why a field holds its value** — per-field source provenance.
4. **Why export failed** — failing export extension + error.

Plus two cross-cutting capabilities:

- **Inline culprit chips** on each item (message / blocker / rejection / field value), naming the responsible hook / rule / workflow / user / engine / setting. (An earlier top-level consolidated "Culprits" summary was removed — the inline chips cover attribution.)
- A **"full detective + capability scan"** investigation for the one case where the platform does not directly record the culprit (hook-driven rejection).

**Non-goals (v1):** editing/fixing the annotation; org-wide analytics ("all docs blocked by hook X"); an in-page DOM overlay (deferred — see §4.2); bulk/multi-annotation views.

## 3. Verified data model (the foundation)

### 3.1 Messages — `annotation.messages[]`
Top-level array; **not** in the content tree (`/content` carries only datapoints with `validation_sources` + `rir_confidence`). Each item:

```
{ type: "error"|"warning"|"info",
  content: "<text>",
  id?: "<datapoint_id>",          // present when field-targeted; it is the DATAPOINT id (string)
  detail: { hook_id, hook_name,    // set for hook-emitted
            rule_id, rule_name,    // set for rule-emitted (hook_name then = "rules", hook_id = null)
            request_id, timestamp, is_exception } }
```

**Every message names its producer** via `detail.hook_id`+`hook_name` *or* `detail.rule_id`+`rule_name`. `is_exception:true` = a hook crash; `false` = a normal validation message. **[VERIFIED — error exceptions live; rule message via controlled experiment.]**

### 3.2 Automation blockers — `automation_blocker` URL → `/v1/automation_blockers/{id}`
`content[]` items each `{ type, level: "datapoint"|"annotation", schema_id, samples[], details }`:
- `low_score`: `samples[].{datapoint_id, details:{score, threshold}}`. Threshold = field `score_threshold` **??** queue `default_score_threshold`. **[VERIFIED]**
- `error_message`: `details.message_content[]` (strings) → join to `messages[]` by content. **[VERIFIED]**
- `automation_disabled`: queue `automation_enabled:false` / `automation_level:"never"`. **[VERIFIED]**
- rule/hook-sourced blockers may carry the producer name best-effort via `details.detail[0].hook_name|rule_name`. **[BEST-EFFORT — handled by `content_walker.py`; not present in seed data.]**
- Items carry **both** `type` and `level`. The `type` vocabulary is **open-ended** ("expect it to grow") → degrade gracefully on unknown types. **[VERIFIED + reference.]**

### 3.3 Rejection taxonomy — culprit by signature
The `/reject` body (from OPTIONS) accepts `note_content` (≤4096) and a **writable** `automatically_rejected` boolean. **`note` is silently dropped — wrong key.** **[VERIFIED]**

| Type | Signature | Culprit | Reason | Reliability |
|---|---|---|---|---|
| **Manual** | `rejected_by`=user, `automatically_rejected`=false, no workflow activity | the user | linked `/notes` (type:rejection) | Verified |
| **Workflow** | `rejected_by`=null, `workflow_activities` has `action:"rejected"` | workflow + step (`workflow_activities`) | `workflow_activities.note` | Verified |
| **Hook / extension** | `automatically_rejected`=true, `rejected_by`=service identity, no workflow activity | acting identity (Verified); **exact extension** via `/reject` `request_id`→hook_logs | linked `/notes` if `note_content` passed | identity Verified; exact extension **[BEST-EFFORT]** |
| **Platform/system** | e.g. no-attachment bounce, inbox `document_rejection_conditions` | system mechanism | outbound email/template | Best-effort |

Key gotchas, all **[VERIFIED live]**:
- **`automatically_rejected` is NOT a reliable manual/auto flag** — a *workflow* auto-reject leaves it `false`. Detect type by the full signature, not this flag.
- **Native rules CANNOT reject** — the only action types are `show_message`, `add_automation_blocker`, `show_hide_field`. A rule is never a rejection culprit (only a message/blocker culprit).
- **`rejected_at`/`rejected_by` persist after un-reject** and are *historical*. "Currently rejected" = `status=="rejected"`; the fields/activities describe rejection history.
- The rejection **reason** is a `/v1/notes/{id}` resource `{type:"rejection", content, creator, created_at, annotation}` — retrievable, but only exists if a `note_content` was supplied; otherwise **[LIMITATION] reason not recorded by the API** (state it, don't guess).
- Audit logs are **eventually-consistent** and can be **empty** for workflow rejects — `workflow_activities` is authoritative there.

### 3.4 Field value provenance
Per datapoint: `validation_sources` (e.g. `["score","human"]`, also `connector` = hook-written) + `rir_confidence`. Deterministic source per field; a `connector` value is expandable to the writing hook **[BEST-EFFORT, via hook logs].** **[VERIFIED]**

### 3.5 Export failure
Annotation `export_failed_at` + `status:"failed_export"` (Verified). The failing export extension + its error come from hook logs for the `annotation_content.export` event **[BEST-EFFORT — model clear; not live-verified].**

### 3.6 Two-tier read model
- **Persisted tier** (cheap, read-only, no lock): `GET /annotations/{id}` (status, rejection fields, `export_failed_at`, `messages`, `automation_blocker` URL), the blocker resource, `/content`. Fully attributed. **This is the default.**
- **Live tier** (`POST /content/validate`, needs a reviewing session start→validate→cancel): re-evaluates rules + `user_update` hooks against *current* config; returns `{matched_trigger_rules, messages, suggested_operations, updated_datapoints}` with the same attribution. A bare validate **does not persist**. Used only by the opt-in "Re-evaluate" action to catch config drift. **[VERIFIED]**

## 4. Architecture

### 4.1 Placement — new Console app `inspector`
Lives beside `mdh`/`audit`/`galaxy` under `src/console/index.jsx`; no new esbuild entry point. Touches the same **four hardcoded rail switch-points** Galaxy did:
- `src/console/components/Rail.jsx` — APPS list (icon + label `inspector`).
- `src/console/Console.jsx` — render switch case.
- `src/console/boot.js` — `isValidApp` accepts `inspector`.
- `src/console/index.jsx` — imports, `TITLES`, auth wiring, lazy `initInspector()` on first activation.

New tree `src/inspector/`:
- `store.js` — signals: `domain`, `token`, `annotationId`, `annotation`, `blocker`, `content`, `enrichment` (audit/hook/rule/workflow/notes/emails, lazy), `loading`, `error`, `liveResult`.
- `api.js` — REST client (see §4.3).
- `resolve.js` — id→name cache (60s LRU) for hooks/rules/users/queues, mirroring the audit app's resolver.
- `culprit.js` — **pure, DOM-free** logic: message→producer mapping, blocker→explanation mapping, rejection-signature classifier, provenance bucketer, reject-capability scan + candidate ranking. Unit-tested.
- `components/` — `App`, `Overview`, `Timeline`, `BlockedPanel`, `RejectedPanel` (with `CulpritHero` + `Investigate`), `ProvenancePanel`, `ExportPanel`, `ReliabilityBadge`, `CulpritChip`, `IdInput`.
- Styled by shared `console.css` (`.inspector-*`), dark-mode aware via the existing `:root` variables.

### 4.2 Entry & auth
- **Popup launcher (primary):** when the active tab is a Rossum annotation, a "Inspect this annotation" button. Reuses `src/popup/tab-readers.js` `readCurrentContext` (already parses `annotationId`/`queueId` from the tab URL) and the existing **`consoleAuth_<uuid>` staging flow** with `app:'inspector'` + prefill `annotationId`, opened by the background worker (`chrome.tabs.create`, mirroring `dataset-mgmt-suggest`/MDH). Token never left at rest beyond the single-use, 24h-TTL staging key.
- **Manual entry:** the app accepts a pasted annotation id **or** Rossum URL, so it works standalone and on reload (sessionStorage creds).
- **In-page button: deferred** to a later iteration (would require content-script injection into Rossum's SPA — the fragility we chose to avoid).

### 4.3 Data layer & fetch strategy
`api.js` methods (all `Bearer`, 30s AbortController, 401→"Session expired", 403/empty-tolerant):
- Core (always): `getAnnotation`, `getAutomationBlocker(url)`, `getContent`, plus resolves `getQueue` (automation settings + thresholds + `rejection_config`), `getSchema` (field thresholds/labels), `getHook`/`getRule`/`getUser` (names + deep-links).
- Enrichment (lazy, per-panel, best-effort): `listAuditLogs(object_type=annotation, object_id)`, `listHookLogs(annotation, [timestamp window])`, `listRuleExecutionLogs(annotation_id)`, `listWorkflowActivities(annotation)`, `listNotes(annotation)`, `listEmails(queue, outgoing)`.
- Live tier: `revalidate(annotationId)` = start → `POST /content/validate` → cancel-in-finally. Explicit, opt-in, warns about the brief reviewing lock.

Fetch order: core read paints the report immediately; enrichment fetches fire lazily when a panel needs them and render with a "may be delayed/expired" note on 403/empty.

### 4.4 State
Preact signals in `store.js`; the report is a pure function of `annotation` + `blocker` + `content` + resolved names + (lazy) `enrichment`. No persisted state in v1 (Console state key `consoleActiveApp` already exists; add `inspector` as a valid value).

## 5. The report UI

**Container structure (required):** the Console shell is `#app { display:flex }` → `.app-root { display:flex; flex:1 }` (a flex **row**). So the app must nest its content the way the other apps do — `<div class="app-root"><main class="main"><div class="inspector-root">…</div></main></div>` — where `.main` is the flex column (`overflow:hidden`) and `.inspector-root` is the scrolling body (`flex:1; min-height:0; overflow-y:auto`). Putting stacked content directly on `.app-root` lays it out as a horizontal row (regression-tested in `tests/inspector-components.test.js`).

1. **Overview header** — `#id`, document name, queue, status pill, `automated`, modifier, schema/document ids.
2. **Status timeline** — assembled from annotation timestamps (`created_at`→`modified_at`→`confirmed_at`/`rejected_at`/`exported_at`/`export_failed_at`), overlaid with `audit_logs` transitions and `workflow_activities`; clearly marked **eventually-consistent**.
3. **Why blocked** — blocker items (each explained + culprit chip) and the messages list (each with producer chip, `is_exception` badge, `request_id`, deep-link, and a best-effort "hook log" link). Opt-in **Re-evaluate with current rules** (live tier).
5. **Why rejected** — taxonomy classifier picks Manual / Workflow / Hook; renders a **culprit hero** + signature facts + reason (from `/notes` or the explicit "not recorded" state). The Hook case offers **Investigate** (§6).
6. **Field provenance** — table of fields → source (= culprit) + confidence; `connector` expandable to the writing hook (best-effort).
7. **Why export failed** — culprit hero (failing export extension) + `export_failed_at` + error from hook logs (best-effort) + the "logs expired → no guess" fallback.

## 6. Culprit-finding model (cross-cutting)

- **Errors/messages & rule/hook blockers:** culprit is read directly (`detail.hook_id`/`rule_id`, or blocker producer name). **Deterministic.**
- **low_score / automation_disabled:** culprit = the extraction engine / queue config (deterministic explanation with score vs threshold, or the queue setting).
- **Rejection:** by the §3.3 taxonomy. Manual → user; Workflow → workflow+step (`workflow_activities`); Hook → acting identity (deterministic) and the **exact extension best-effort**.
- **Full detective + capability scan** (chosen) — for the hook-rejection / export-failure best-effort cases:
  1. Correlate the `/reject` (or export) `request_id` + a `rejected_at`/`export_failed_at` time window against `hook_logs` to name the extension that ran. **Grounded on logs.**
  2. Scan the queue's extensions for **reject capability**: a `function` hook whose code calls `/reject` → "code calls /reject"; a hook with no such call → "no reject call"; a **`webhook` → "capability unknown"** (opaque endpoint — never asserted). Rank suspects by (request_id match > ran-in-window > capable).
  3. **Honesty rule:** when logs are expired and no candidate matches, state *"automated reject by `<identity>` at `<T>` — specific extension no longer in logs"* rather than inventing one. Webhook capability is always "unknown," never a guess. **[LIMITATION made explicit in UI.]**

## 7. Reliability model
Every fact carries one badge, consistently applied:
- **Verified** — read directly from the annotation/blocker/workflow_activities; deterministic.
- **Best-effort** — depends on logs/email; may be delayed or expired.
- **No guess / Unavailable** — the API does not record it; the tool states the limit.

## 8. Backward compatibility
Defensive handling for the variants found live and in the references:
- Message `detail`: hook-shape vs rule-shape (read both `hook_id`/`hook_name` and `rule_id`/`rule_name`; `hook_name:"rules"` denotes a rule).
- Blocker `details`: `message_content` **or** `content`; `detail[0].hook_name` **or** `rule_name` (may be absent → `""`); `type` **and** `level` both present; **open-ended `type` vocabulary** (graceful unknown rendering).
- Rejection: do **not** rely on `automatically_rejected`; classify by full signature. Reason key is `note_content` (not `note`); reason lives in `/notes`.
- Legacy vs native rules: a "validation message" may come from a native Rule (`rules_execution_logs`, `rule_name`) **or** the legacy Business Rules Validation Store extension (a hook, `hooks/logs`, `hook_name`) — check both surfaces.
- `queue.engine` ?? legacy `dedicated_engine`/`generic_engine` if tracing a `low_score`/`extension` blocker to its engine.
- MDH match/check configs under `settings.configurations` (modern) ?? `settings.configs` (legacy) if ever explaining MDH-match messages.

## 9. Testing strategy
- `culprit.js` (message→producer, blocker→explanation, rejection classifier, provenance bucketer, reject-capability scan + candidate ranking) is **pure/DOM-free** → unit-tested like `overviewCharts.js`/`graph.js`. Cover every taxonomy branch and every backward-compat variant from §8.
- Component behavior via jsdom tests using the project's `h(Component)` + `vi.mock` convention and condition-based `waitFor` (no fixed-timeout flakes; see `reference_vitest_flaky_fixed_timeouts`).
- API client: mock fetch; assert 403/empty tolerance, 401 handling, the live-tier start/validate/cancel-in-finally ordering, and that core read never triggers a write.
- CSP: confirm `dist/console/console.js` stays clean (the app uses no `new Function`/eval).

## 10. Out of scope / future
- In-page overlay button; org-wide "blocked by X" analytics; bulk views; writing fixes; persisting Inspector state.

## 11. Known limitations (verified, surfaced honestly in the UI)
- **Rejection reason** often unrecoverable (only exists as a `/notes` resource if `note_content` was supplied).
- **Exact hook for a hook-driven reject / export failure** is best-effort and degrades when logs expire (retention) or for opaque webhooks.
- **Audit logs are eventually-consistent** and can be empty (notably for workflow rejects) — `workflow_activities` is authoritative there.
- **`rejected_at`/`rejected_by` are historical**, not current state.

## Appendix A — live verification log (2026-06-18, org 214757)
- Messages carry source: hook exceptions `detail.{hook_id,hook_name,request_id,is_exception:true}` (ann 133641827); rule message via throwaway rule → `detail.{rule_id,rule_name,hook_name:"rules",is_exception:false}`, top-level `id` = datapoint id; both seen in the `/content/validate` response (`matched_trigger_rules`,`messages`,`suggested_operations`,`updated_datapoints`); bare validate does not persist.
- Blocker `86334303`: `low_score`(recipient_name, score 0.58/threshold 0.80, datapoint 18584171174), `error_message`(message_content[4]), `automation_disabled`; queue `automation_enabled:false`/`automation_level:"never"`/`default_score_threshold:0.8`.
- Rejection: `/reject` OPTIONS → `note_content` + writable `automatically_rejected`; manual reject set `rejected_by`+`rejected_at`, `automatically_rejected:false`; `note_content` → `/v1/notes/{id}` (type:rejection); `automatically_rejected:true` sticks; un-reject via `PATCH status:to_review` (rejected_at/by persist; PATCH null → 400). Real workflow-rejected ann 135308224: `automatically_rejected:false`, `rejected_by:null`, `workflow_activities` `rejected` note "Automatically rejected as no workflow step matched.", audit_logs total 0.
- Rule actions limited to show_message/add_automation_blocker/show_hide_field (no reject). Email-safe: queue `email_notifications.recipient:null`, ann had no inbound email, outgoing count 0→0 throughout.
- Org left clean except disclosed residual: ann 133641827 now has historical `rejected_at`/`rejected_by` set (cannot be cleared); status restored to `to_review`, messages byte-identical.
