# Inspector Overhaul — §8 live verification notes

Run: 2026-07-03. No live Rossum session was available (MCP `rossum_whoami` →
not connected; no dev-org token provided at execution time). Per plan Task 0,
every check is recorded UNVERIFIED and the implementation ships the degraded
(honest) behavior. Re-run instructions are exact; no customer names or data may
be recorded here — key names and types only.

**Re-run 2026-07-04** with an owner-provided api.elis.rossum.ai token (read-only
GETs, shapes only). Outcome: the org holds none of the needed specimens —
V1: zero emails in the org; V2: zero workflow_runs/activities; V3: the sampled
blocker had only standard types (1× automation_disabled + 15× low_score), no
`details.detail`; V4: zero retained hook logs on the sampled queue (consistent
with the known sparse-retention behavior) — so V1–V5 REMAIN UNVERIFIED and the
degraded-honest defaults stand. **New verified fact from the same session** (via
the "(r || []) is not iterable" bugfix): in the SCHEMA tree, a `multivalue`'s
`children` is a single tuple OBJECT while sections/tuples carry arrays; the
CONTENT tree uses arrays everywhere. `fieldThresholds` now normalizes this
(regression-tested).

| # | Check | Status | Effect of UNVERIFIED |
|---|-------|--------|----------------------|
| V1 | Populated email shape (`annotation.email` → `GET /emails/<id>`: which of `from`/`sender`/`subject` exist) | **UNVERIFIED** | `intakeEvidence` extracts sender/subject defensively; absent/unknown shape → generic "arrived as an email attachment" with no sender line (Task 4 behavior). |
| V2 | `workflow_run` statuses beyond `approved`; `step_started.assignees[]` with human approvers | **UNVERIFIED** | Workflow section renders `workflow_status` verbatim and shows assignees only when present — no status vocabulary is hardcoded (Task 4 behavior). |
| V3 | Blocker `details.detail[0].rule_name/hook_name` populated shape | **UNVERIFIED** | `explainBlocker`'s existing best-effort branch stays as-is (REL.BEST_EFFORT); no new dependence added. |
| V4 | `message.detail.request_id` per-invocation vs shared | **UNVERIFIED** | `correlateMessage` keeps its current documented tier (hook match = REL.VERIFIED with the in-code caveat, `src/inspector/correlate.js`); if later proven shared, downgrade to REL.BEST_EFFORT (one-line change). |
| V5 | Agent citation compliance on a near-cap evidence prompt | **UNVERIFIED** | DiagnosisPanel's fallback is the shipped safety net: text with no parsable `[e:<id>]` markers renders as plain narrative; unresolvable ids render struck-through, unclickable (Task 13 behavior). |

## Re-run instructions (read-only; dev org only; synthetic data)

1. Establish a session: `rossum_set_token` (MCP) or `Authorization: Bearer` curl.
2. V1: `GET /api/v1/annotations/<id>` (email-ingested) → `GET <email url>` — record key NAMES/types only.
3. V2: `GET /api/v1/workflow_runs?annotation=<id>` + `GET /api/v1/workflow_activities?annotation=<id>` — record `workflow_status` values seen and whether `step_started.assignees[]` is populated.
4. V3: find an annotation with a rule-sourced blocker → `GET <automation_blocker url>` — record whether `content[].details.detail[0]` carries `rule_name`/`hook_name`. (Creating a throwaway rule is a WRITE — requires explicit owner approval first.)
5. V4: on an annotation with ≥2 hook-produced messages, compare `messages[].detail.request_id` with `GET /api/v1/hooks/logs?annotation=<id>` `request_id`/`uuid`.
6. V5: send `buildSynthesisPrompt(bigSyntheticEvidence)` through `agentApi` on a fresh chat; record marker compliance.
