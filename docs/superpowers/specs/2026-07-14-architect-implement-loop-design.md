# Architect — autonomous "Implement" loop (ralph-style, write-enabled) — design

**Date:** 2026-07-14 (consolidated 2026-07-15)
**Status:** implemented & shipped (internal-org dogfood); live gates G1–G4 verified on elis 2026-07-14.
**Surface:** the Fabry Chat Console app, Architect mode (`src/fabry/architect/`),
experimental-gated. Additive to the shipped Architect (SOW deliverables +
read-only check + refine-wording).
**Prior art:** `2026-07-13-fabry-architect-design.md` (Architect + read-only check),
`2026-07-14-architect-refine-wording-design.md` (iterative refine).

> **This is the single authoritative spec for the implement loop.** It consolidates
> the original implement-loop design and the task-decomposition design (which
> reversed the original "no decomposition" call) into one, updated to what actually
> shipped: **task decomposition is IN**, per-deliverable **`allowedOps` is OUT**, the
> gate is a **double** gate (experimental + Arm, ON by default), and writes are
> enabled via the **message body** `mcp_mode`, not `createChat`. The implementation
> plan (`docs/superpowers/plans/2026-07-14-architect-implement-loop.md`) captured the
> original approach and is superseded by this document where they differ.

## 1. Purpose

Architect keeps a per-org list of **deliverables** (Markdown SOW items) and
**checks** each one read-only against the live org (PASS / FAIL / UNCERTAIN — "is it
done?"). This adds the other half: an **Implement** loop whose goal is to make the
org actually *satisfy* each deliverable ("make it done") — a browser-native
adaptation of the "ralph" agentic loop. Internal-org dogfood only.

## 2. Pattern grounding (ralph + ghuntley)

- **ralph** (https://github.com/snarktank/ralph): a **fresh-context iteration
  system**. Each cycle spawns a clean AI instance; cross-iteration memory lives in
  git history, `prd.json` (stories with a boolean `passes`), and `progress.txt`
  (append-only learnings). Per iteration: pick the top story where `passes:false` →
  implement that **one** thing → verify → commit only if green → mark passed → append
  learnings → repeat until `COMPLETE`.
- **ghuntley** (https://ghuntley.com/ralph/): *"one thing per loop. Only one thing."*
  Documented failure modes we design against: **#1** the agent assumes something is
  missing and rebuilds it (→ duplicates); **#2** placeholder / "just enough to pass"
  implementations. His hardest lesson: a unit of work must be small enough for one
  focused context window — a whole SOW deliverable is the "build the dashboard"
  anti-pattern, so we **decompose** it.
- **Our twist — brownfield write-to-prod.** ralph is greenfield-on-git: a bad
  iteration is never committed and the branch resets. Here the implement step makes
  **real, possibly irreversible** org writes with **no free rollback**, and there is
  **no per-plan human review**. So the loop is **hard-bounded**, **audited**,
  **Arm-gated**, always **Stoppable**, and the write prompt carries explicit
  brownfield **guardrails** (§7) as the primary safety.

### ralph → Architect mapping

| ralph | Architect implement loop |
|---|---|
| `prd.json` stories + `passes` | the deliverable list; `verdict === 'pass'` is `passes:true` |
| one story per iteration | **one task per turn** (the deliverable is decomposed into a `fix_plan`) |
| `progress.txt` learnings | per-task **journal** seeded into the next attempt |
| git history (committed work) | the **org itself** + a per-write **audit log** |
| `ralph.sh` | `implementLoop.js` (browser, bounded) |
| fresh instance per iteration | **fresh write chat per task attempt**; memory via the journal |
| verify (typecheck/tests) | **fresh read-only check chat** per task + a deliverable roll-up (`check.js`) |
| commit only if green | persist `passing` **only when the roll-up check PASSes** |
| repeat / `COMPLETE` | loop until PASS **or** a bound trips |

## 3. Verified backend grounding (facts, not assumptions)

Sources: the `rossum-agent` backend source + live probes on elis 2026-07-14
(`reference_rossum_agent_api_contract.md`).

- **There is NO server-side write-lock.** `resolve_mcp_mode` (`api/stream.py`) reads
  `mcp_mode` from the **message body** and honors the client value with no permission
  check; the only gates are token validity + an api-URL host allowlist (`auth.py`).
  Chats are read-only **only because the client omits the field** — so read-only is a
  **client discipline**, not a server guarantee. → the **write-boundary invariant**
  (§5) is the enforcement.
- **Personas** (`/persona`): `default` is autonomous (no per-write gate); `cautious`
  blocks each write pending a "Yes, proceed" confirmation (`cautious_gate.py`). The
  implement write turn uses **`default` with no priming** (cautious would re-introduce
  the gate we deliberately turned off). Every read-only turn keeps `/persona cautious`.
- **Every write is observable client-side** via `tool-input-available` /
  `tool-output-available` stream events (`agentStream.foldEvents`) → an audit journal
  is feasible (`audit.js`).
- **The read-only check is a ready-made verify gate.** `check.js`
  (`buildCheckPrompt`/`parseCheckVerdict`) + `runOne` (fresh cautious read-only chat)
  are unchanged and become the loop's "tests/CI".
- **Live gates — VERIFIED on elis 2026-07-14:** **G1** ✓ writes are client-enablable
  via message-body `mcp_mode:"read-write"` (no server lock). **G2** ✓ a live
  `create_workspace`+`delete` executed with the SA token, then self-cleaned. **G3** ✓
  read-only holds when `mcp_mode` is omitted (Chat is safe by client discipline).
  **G4** ✓ reads are generic `get`/`search`; writes are entity-specific
  (`create_hook`/`patch_schema`/…) plus a generic `delete`.

## 4. Decisions (owner-approved; final)

1. **Browser/extension only** — the loop runs inside the Fabry Architect app.
2. **Write-enabled autonomous agent** — Fabry writes to the org directly via
   `mcp_mode:"read-write"`; it iterates unattended until the check passes.
3. **Autonomous, but armed + bounded + audited** — `default` persona (no per-write
   prompt to stall on), a one-time **Arm** confirm before any writes, hard **bounds**,
   a per-write **audit journal**, and an always-live **Stop**.
4. **Task decomposition (dynamic `fix_plan`)** — per deliverable: a read-only PLAN
   turn decomposes it into a small ordered task list; a dynamic task loop implements
   one task per turn and may append discovered prerequisites; a deliverable roll-up
   verifies the whole. *(This reverses the original spec's "whole-deliverable, single
   chat / no decomposition" call — owner re-opened it per ghuntley's "one thing.")*
5. **No per-deliverable write scope (`allowedOps` removed).** A brownfield prod org
   is not an allowlistable greenfield; instruction guardrails (§7) are the safety.
   *(This removes the original spec's `allowedOps` + `screenOp` + `suggestScope`.)*
6. **Chat is strictly read-only; only Architect's implement loop may write** — the
   write-boundary invariant (§5).
7. **The Data Storage deliverable doc is the ralph state store** (§8).

## 5. The write path + write-boundary invariant

- Transport (`src/agent/agentApi.js`): `streamMessage(chatId, content, { …, mcpMode })`
  adds `mcp_mode` to the message body **only when `mcpMode` is truthy**; the default
  body is byte-identical to the prior read-only behavior. `createChat()` posts `{}`
  (no `mcp_mode` — earlier designs put it on create; that was wrong, the backend reads
  it from the message).
- **The SOLE write call site is `implementTaskOne` in `src/fabry/architect/actions.js`**,
  which sends `streamMessage(chat, prompt, { mcpMode:'read-write' })`. Every other
  turn — plan, per-task check, roll-up check, refine, title generation, and all of
  Chat / Inspector / Audit / MDH / deep-verify / annotate-for-me — omits `mcpMode` and
  is read-only.
- **Enforcement (client-side, since the backend has no lock):** the token `read-write`
  may appear in `src/` only in `src/agent/agentApi.js` (the transport) or
  `src/fabry/architect/**`. Guarded by `tests/fabry-write-boundary.test.js` (walks all
  of `src/`, fails on any other occurrence) + a bundle check (`mcp_mode` appears once
  in `dist/console/console.js`).

## 6. Loop state machine (per deliverable, after one Arm)

Pure `runImplement(deliverables, { planOne, implementTaskOne, checkTaskOne,
checkDeliverable, onEvent, …bounds, signal })` in `implementLoop.js` (transport
injected; sequential across deliverables — writes must not race; abort-aware via a
`null`-return convention; emits per-task + per-deliverable `onEvent(id, patch)`).

**Task model** (persisted on the deliverable doc — the deliverable IS the `fix_plan`):
`tasks: [{ id, text, acceptance, status:'pending'|'doing'|'done'|'failed', attempts,
origin:'plan'|'discovered'|'remediation' }]`.

- **PLAN (read-only, `default` persona):** `buildPlanPrompt` → inspect the org, emit an
  ordered JSON task list (each with a one-line `acceptance`), `parsePlan` (fenced/prose
  tolerant), cap `maxPlanTasks`. A tiny deliverable yields a 1-task plan (subsumes the
  old whole-deliverable path).
- **TASK LOOP (dynamic, until-dry):** while a pending task exists and bounds hold:
  1. next pending task → `doing`.
  2. **implement** — fresh **write** chat (`mcpMode:'read-write'`, `default` persona,
     no priming), `buildTaskPrompt(deliverable, task, { journal, doneTasks })` carrying
     the §7 guardrails + "do THIS task only". Each write recorded by `audit.js`. A
     trailing `NEW TASKS:` section → `parseDiscovered` appends bounded prerequisite
     tasks (`origin:'discovered'`).
  3. **verify** — fresh **read-only** chat, `buildTaskCheckPrompt(task.text,
     task.acceptance)` → PASS → `done`; else retry (≤ `maxAttemptsPerTask`) with the
     journal seeded (fresh context + compounding learnings = ralph's `progress.txt`);
     on exhaust → `failed` (loop continues; a failed prerequisite can be re-added).
- **ROLL-UP (read-only):** the existing deliverable check (`runOne`). PASS → `passing`.
  FAIL → append **remediation** tasks (bounded) and re-enter the task loop, up to
  `maxRollupRounds`; then `failed`. A transport-errored roll-up → `uncertain` and does
  **not** spend another write round.

The roll-up verdict is applied to the deliverable's **Check result** and **persisted**
(§8) so the Check tab reflects the post-implementation state and survives reload.

## 7. Bounds & safety

- **Bounds (hard runaway guards for the autonomous, self-expanding plan):**
  `maxAttemptsPerTask = 5`, `maxPlanTasks = 12`, `maxTotalTasks = 20` (caps plan +
  discovered + remediation; overflow dropped + surfaced via a note, never silently),
  `maxTotalWrites = 50` (global circuit-breaker), `maxRollupRounds = 3`.
- **Sequential** execution (writes must not race). **Always-live Stop** (aborts
  mid-turn via the `runId` guard + `AbortController`, exactly like `stopRun`).
- **One-time Arm** confirm before any writes (plain "this writes to the live org,
  autonomous, bounded, audited" warning). **Per-write audit journal** (tool + redacted
  target id/name — never full payloads).
- **Instruction guardrails (the primary brownfield safety — applied to EVERY write
  turn, since there is no per-plan human review):**
  1. **INSPECT before assuming** something is missing (ralph failure #1 → duplicates).
  2. **FULL, no placeholder/stub** implementation (ralph failure #2).
  3. **BACKWARD COMPATIBILITY** — prefer additive changes; do not break existing
     queues/hooks/rules/schemas/fields others depend on.
  4. **NEVER lose customer DATA or DOCUMENTS** (owner) — never delete/truncate
     annotations, documents, datasets, uploads, data-bearing fields; never drop
     collections; prefer create/patch over delete; if it seems to require destroying
     data, STOP and explain instead.

## 8. State store (Data Storage doc) & backward compatibility

Extend the `__mrfabry_architect` deliverable doc — **all new fields optional**, so v1
docs load unchanged and no storage key changes meaning:

```
{ _id, kind:'requirement', text, order, createdAt, editedAt, title,
  lastVerdict, lastEvidence, lastChatId, ranAt,            // check result (unchanged)
  // --- implement / ralph state (all optional/back-compat) ---
  implementStatus,        // idle|planning|running|passing|failed|blocked|uncertain
  attempts,               // total task attempts this run
  implementTasks: [ { id, text, acceptance, status, attempts, origin } ],  // the fix_plan
  implementJournal: [ … ],   // capped last K (JOURNAL_CAP = 10)
  lastImplementWrites, lastImplementSummary, lastImplementChatId, implementRanAt }
```

`saveResult` (check fields) and `saveImplementResult` (implement fields) write
**disjoint** `$set` field sets, so the post-implement check persist never clobbers
implement state. All server-side, per-org. Nothing extra at rest in the browser
beyond the existing per-tab ids (`fabryMode`, `fabryArchitectActive`) + the global
layout pref `fabryArchConsoleHeight`.

## 9. UI (Proposal A pane, 2026-07-15)

- **Sidebar (`ArchitectSidebar`):** the deliverable list; each row = a run-status dot +
  an AI-generated/renamable **title** (`format.displayTitle`) + a kebab
  (Re-run / **Implement ▷** [Arm-gated] / Rename… / Delete). Footer = **Run all ▷**/Stop
  (the read-only check) + New. **There is NO "Implement all"** — implement is
  per-deliverable.
- **Deliverable pane (`DeliverableEditor`):** a **neutral** header (title button →
  rename + a compact status **pill**) over a full-width **Edit / Preview** toggle (the
  CodeMirror `MarkdownEditor` source and the `FabryMarkdown` preview both mounted,
  `hidden` toggles which shows; `refresh()` re-measures CodeMirror on reveal) over a
  **tabbed action console `[Check | Refine | Implement]`** (Check **first**,
  default-active). The console is a **fixed height** (so tabs don't jump) and
  **drag-resizable** via a top-edge grip (`store.consoleHeight`, global
  `fabryArchConsoleHeight`, clamp 140–620).
  - **Check** = verdict + evidence + Re-run + view-investigation.
  - **Refine** = the `RefineDock` bar.
  - **Implement** = Run/Stop + the task list (per-task status + origin) + the audit log.
- **Verdict color lives loudest in the footer console** (where the eye goes during
  analysis): a bold colored top rail on the console + a tinted verdict banner in the
  Check panel (green/red/amber by PASS/FAIL/UNCERTAIN). The header stays neutral (pill
  only). Styling: `.fabry-arch-*` in `console.css`, reusing `--success`/`--danger`/
  `--warning`.

## 10. Gates & privacy

- **Double-gated:** `experimentalUnlocked` (the whole Fabry app) + the per-run **Arm**
  confirm. Implement is **ON by default** within the experimental Fabry app —
  `store.implementAllowed` defaults `true`; the popup kill-switch
  `fabryArchitectImplementEnabled` was **removed** 2026-07-14 (as was the deep-verify
  toggle `fabryDeepVerifyEnabled` — both features now default-on). *(This replaces the
  original spec's triple gate.)*
- The existing **read-only Run all / Re-run check is unchanged** and stays the default
  surface. Implement is a separate, armed action.
- **Privacy — never leak customer names/data:** spec, prompts, examples, and tests use
  **generic Rossum content only** (queues/hooks/rules/schema-fields/VAT). The journal +
  audit log stay in the org's own `__mrfabry_architect` collection (the org's own data
  staying in the org); nothing extra leaves the browser.

## 11. Testing

- **Pure:** `plan` (plan/task/task-check prompts carry the guardrails + acceptance;
  `parsePlan`/`parseDiscovered` fenced/prose tolerant, no-op-marker safe, cap-respecting);
  `implementLoop` state machine (plan→tasks→pass; per-task retry; discovered-task append
  + `maxTotalTasks` cap surfaced; roll-up FAIL → remediation → re-loop; `maxRollupRounds`;
  `maxTotalWrites` breaker; `planOne`-throw fails only that deliverable; roll-up
  transport error → `uncertain`, no extra write round; abort); `audit` (`isWriteTool`
  fail-safe classifier, `summarizeArgs` redaction, `makeAuditFolder`).
- **Transport/glue (agent + api mocked):** the task-implement turn is the ONLY turn
  with `mcpMode:'read-write'`; plan/checks/roll-up are read-only; task persistence;
  `runId` guard; roll-up verdict **persisted** as the Check result (and a transport-
  errored roll-up shown but NOT persisted — preserve last-known-good); `stopImplement`
  aborts + clears spinners.
- **Components (jsdom):** Arm dialog (bounds + warning); Implement panel (task list,
  audit log, Stop); Check-first tab order; verdict color in the footer console (header
  neutral); console fixed-height + drag-resize + clamp; AI title + rename; sidebar has
  no "Implement all".
- **Guards:** `write-boundary` test green; bundle `mcp_mode` == 1; full suite green;
  rebuild `dist/`.

## 12. Out of scope

Human-reviewed/edited plans (owner chose autonomous); "Implement all" multi-deliverable
runs; parallel task execution (sequential — writes must not race); git-style rollback /
undo tooling (the audit journal records, it does not reverse); scheduled/background
loops; multi-org; exporting a build report. **Remaining pre-non-dogfood item:** a stable
customer-facing rollout decision — this is an autonomous write-to-prod capability
(ON by default within the experimental Fabry app, Arm-gated per run).
