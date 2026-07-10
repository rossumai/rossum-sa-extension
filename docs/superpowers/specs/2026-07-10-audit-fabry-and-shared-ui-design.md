# Mr. Fabry in the Audit Logs app + shared Fabry UI seed

Date: 2026-07-10
Status: design, awaiting approval

## 1. Goal

Enrich the Console's **Audit Logs** app with a Mr. Fabry (Rossum Agent API)
assistant that **answers questions about audit activity as a citation-free,
reasoned narrative**. The input reuses the MDH ask-box visual design; the
answer reuses the Inspector Diagnosis-panel visual design. When no question has
been asked, Fabry **auto-runs a minimalistic default prompt that summarizes the
latest audit activity**, so the panel is useful on open.

Secondary goal (owner's mid-task idea): begin a **minimalistic shared frontend
design system** by extracting the reusable Fabry UI pieces into `src/ui/`, with
the Audit app as their first consumer. Migrating MDH and the Inspector onto the
shared module is explicitly **out of scope** for this spec (see §10).

### Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Capability | Analyze & answer — a reasoned narrative, not a query-builder |
| Data grounding | Fabry fetches autonomously via its own read-only tools |
| Design-system scope | Seed a small `src/ui/` module now; migrate MDH/Inspector later |
| Placement | Top ask bar + inline collapsible answer panel, above the filters |
| Default state | Auto-run a minimalistic "summarize latest activity" prompt |
| Conversation model | One chat/session: default summary = turn 0; the top box continues it (growing thread) |
| Citations | Citation-free narrative (no evidence model to cite into) |
| D verification | Deferred to the plan's gated first task, with a seed-view fallback |

## 2. Constraints & facts (verified before designing)

- **Transport is already shared and initialized.** `src/mdh/agent/agentApi.js`
  is a singleton `init(domain, token)`'d once at Console boot
  (`src/console/index.jsx`), and the pure `src/mdh/agent/agentStream.js` is
  already imported cross-app (the Inspector uses it). The Audit app reuses both
  as-is — **no transport work, no manifest change** (`host_permissions` already
  covers `https://*.rossum.cloud/*`, matching `rossum-agent-api.tools.rossum.cloud`).
- **The visual design is already shared via CSS.** All classes we reuse
  (`nl-search-*`, `agent-spark`, `inspector-diag-*`, `inspector-followup*`,
  `inspector-modal*`, `inspector-caret`, `inspector-diag-list`) live in the
  shared `src/console/console.css`, which the Audit app already uses. The
  *components* are what's duplicated (the ask input + gerund loader are
  hand-reimplemented in both MDH `AgentBox` and Inspector `FollowupThread`).
- **The agent's read tools are entity-based, not arbitrary HTTP.** Verified
  live (2026-07-02/07): the agent exposes `get {entity, entity_id}` and
  `search {query:{entity,…}}`, and reaches `hook`, `annotation`, `hook_log`.
  It self-confirmed it *cannot* hit arbitrary paths like
  `/annotations/{id}/page_data`. **Whether `search{entity:"audit_log"}` works is
  NOT verified** — plausible (sibling `hook_log` works) but must be confirmed
  live (see §5). This is why the autonomous path carries a fallback.
- **Availability gating pattern (reused).** Both MDH and Inspector probe
  `agentApi.probeAgent()` (`GET /health`, unauthenticated) non-blocking at init
  and gate their AI surface on an `aiAvailable` signal. Audit follows suit.
- **Read-only stance (unchanged repo-wide caveat).** The agent runs
  write-capable tools server-side; client-side read-only is defense-in-depth
  only. This feature only ever *reads*, and the prompt primes `/persona cautious`
  like the Inspector — but the server-side write-lock remains the standing
  ship-blocker for non-dogfood use. No new exposure is introduced here.
- **Privacy.** Audit rows contain usernames (emails) and object ids. In the
  autonomous model the agent fetches these server-side under the org's own
  token — the identical trust boundary MDH (collection records) and the
  Inspector (annotation field values) already cross. No customer data enters
  this spec, commits, or assistant output; all examples are generic.

## 3. Shared UI seed — `src/ui/`

New, minimal, store-agnostic components. They emit the **existing** `console.css`
class names, so there is no visual change and (almost) no new CSS.

- **`src/ui/GerundLoader.jsx`** — the animated rotating-gerund loader. Owns its
  own interval tick while mounted (kills the duplicated `gi`/`setInterval`
  logic). Props: `gerunds: string[]`, `intervalMs?` (default 2400). Renders the
  existing `.nl-search-loading` / `.nl-gerund` / `.nl-gerund-in` / `.nl-gerund-out`
  crossfade markup.
- **`src/ui/fabry/FabryInput.jsx`** — controlled ask input. Renders `✦`
  `.agent-spark` + `.nl-search-input` inside `.nl-search-wrapper`, with
  `GerundLoader` shown while busy. Props: `value`, `onInput`, `onSubmit`,
  `busy`, `placeholder`, `gerunds`. Enter submits, Escape clears (matches
  existing behavior). Dumb — no store imports.
- **`src/ui/fabry/FabryNarrative.jsx`** — streaming narrative **body** renderer
  (not the panel chrome). Consumes `parseNarrative(text)` and renders takeaway
  paragraph + `- ` bullet list (`.inspector-diag-list`) + `Next step:` line +
  streaming caret (`.inspector-caret`) inside `.inspector-diag-body`. Props:
  `text`, `streaming`, `resolveCite?`. **`resolveCite` is optional**: when
  omitted (Audit's case), cite segments render as plain text; the prop exists so
  the deferred Inspector migration can plug its evidence-scroll resolver back in
  with no component change.
- **`src/ui/fabry/FabryTranscript.jsx`** — read-only "investigation" modal
  (reasoning `<pre>` + tool-name list), the simpler of the two existing
  transcript surfaces. Reuses `.inspector-modal*` / `.inspector-code-block` /
  `.inspector-note`. Props: `reasoning`, `tools`, `onClose`.
- **`src/ui/fabry/narrative.js`** — canonical pure `parseNarrative` /
  `parseCitations` (line-aware paragraph/bullet blocks with citation segments,
  streaming-safe). Copied verbatim from `inspector/synthesize.js`.
  **Deliberate temporary duplication:** the Inspector keeps its own copy for now
  so this spec does not touch a shipping app; the duplicate is removed when the
  Inspector migrates onto `src/ui/` (§10).

The shared components reuse `src/mdh/agent/agentStream.js` (`newAcc`,
`foldEvents`, `replyText`, `toolLabel`) and `agentApi.js` unchanged. Relocating
`agent/*` out of `src/mdh/` is deferred (§10).

## 4. Audit app integration

### 4.1 `src/audit/fabry.js` (mirrors `inspector/synthesize.js`)

Pure prompt builders + injected-transport runners:

- `DEFAULT_QUESTION` — the minimalistic default: *"Summarize the latest activity
  in this organization's audit log: the most recent events, who did what, and
  anything notable."*
- `buildAuditPrompt({ question, filters, rows, mode })` where `mode` is
  `'autonomous'` or `'seeded'` (the §5 fallback). Contents:
  - Read-only forensic framing ("never modify anything — only read and reason").
  - Current-view context: the active filter values (object type / action /
    object id / username / timestamp range) so answers can align with what the
    user is looking at. For the default summary the request is org-wide "latest
    activity"; the filters are context, not a hard constraint.
  - `mode:'autonomous'` → "use your read-only tools to fetch the recent audit
    log entries you need." `mode:'seeded'` → embeds a capped sample of the
    currently-loaded rows (a simple row/char cap local to `fabry.js`; reusing
    the Inspector's `promptBudget.js` is optional and would be part of the §10
    migration, not this spec) and instructs Fabry not to claim beyond them.
  - Output format identical to the Inspector's: a one-line takeaway, 3–6 `- `
    bullets in story order, a `Next step:` line. **Explicitly citation-free**:
    "plain text, no markdown headings, no `[e:…]` citations."
- `runAuditQuery({ agentApi, question, filters, rows, mode, onPhase, onText, signal })`
  — fresh chat, prime `/persona cautious`, stream `buildAuditPrompt`, fold
  events, return `{ text, reasoning, tools, chatId }`. Same structure as
  `runSynthesis`.
- `continueAuditQuery({ agentApi, chatId, question, onPhase, onText, signal })`
  — a follow-up in the SAME chat (no re-prime), lighter prompt (read-only
  framing + "answer concisely, plain text, no citations"). Same structure as
  `continueSynthesis`.

The exact prompt wording is finalized **after** the §5 spike confirms the tool
path; until then the autonomous instruction follows the Inspector-attribution
wording that is already proven to make the agent fetch `hook_log`/rules/code.

### 4.2 `src/audit/store.js` additions

- `aiAvailable = signal(false)` — set by the `probeAgent()` result.
- `fabry = signal({ status, chatId, turns, error })`:
  - `status`: `'idle' | 'running' | 'done' | 'error' | 'offline' | 'dismissed'`.
  - `turns`: `[{ id, question: string|null, text, reasoning, tools, state:'streaming'|'done'|'error' }]`.
    `question:null` marks the auto default-summary turn (rendered under a
    "Latest activity" label); every other turn is a user Q&A.
  - Ephemeral — **no new `chrome.storage` keys, no persistence, no migration**.
- A `resetFabry()` helper (clear turns + chatId) used by disconnect and the `↻`
  control; `fabry` is also reset by the store's existing reset path.

### 4.3 `src/audit/index.jsx` wiring

- In `initAudit`, after the `whoami` connect succeeds, probe non-blocking:
  `agentApi.probeAgent().then(ok => store.aiAvailable.value = ok).catch(()=>{})`.
  (`agentApi` is already `init`'d at Console boot; Audit just imports it.)
- **Eager default-summary trigger (final, overhauled 2026-07-10):** a
  once-guarded `effect` in `initAudit` fires `runDefaultSummary()` when the
  agent is reachable AND the first audit query has landed
  (`aiAvailable && availability === 'available'`; both signals read
  unconditionally so the effect subscribes to both) — eager because the
  summary's **takeaway line doubles as the collapsed bar's live preview** (one
  agent call powers both surfaces). `FabryPanel`'s toggle keeps an idle fallback
  for the rare expand-before-rows case; `runDefaultSummary` no-ops unless idle.
  One `AbortController` for the active Fabry turn (stale-guards writes).
  Filter-driven table refetch is untouched and does NOT abort Fabry.

### 4.4 `src/audit/components/FabryPanel.jsx` + `App.jsx`

- `FabryPanel` is the **"V2 Fabry band"** (design overhaul 2026-07-10, picked
  from three browser-mockup variants): a slim purple band with the Inspector
  Diagnosis identity (`--diag-*` gradient/border/fg), attached above the
  filters card. **No `×`/`↻` controls.**
  - **Collapsed by default** — one `.audit-fabry-bar` line: the Fabry mark
    (`✦`, `.audit-fabry-mark` — the same four-pointed spark that fronts every
    Fabry ask input; deliberately NOT the generic `✨`) + `Audit insights` +
    `by Mr. Fabry` credit + a **live one-line preview**. **No expansion
    chevron** (owner choice 2026-07-10: users discover expansion by clicking;
    the hover underline + `aria-expanded` remain)
    (`.audit-fabry-preview`, ellipsized): the summary's takeaway (first line of
    turn 0), streaming in as it generates; `summarizing the loaded page…` while
    empty-streaming; `summary unavailable` on error/empty; an italic static
    hint (`.audit-fabry-hint`) only before anything has run. Preview and hint
    never render while open. (`previewText` in `FabryPanel.jsx`.)
  - When **expanded** (`.audit-fabry-body`) — **chat order**: the turn thread
    first (turns separated by dashed `--diag-border` rules), then the
    `FabryInput` ask bar **at the bottom**. "View investigation"
    (`FabryTranscript`) sits in the bar as a SIBLING of the toggle button
    (never nested), shown when open with a done turn.
  - The **turn thread**: each turn renders its label ("Latest activity" for the
    summary turn, else `You: <question>`) then `FabryNarrative`. A skeleton
    (`.inspector-esec-skel`) shows before the first token; `error` renders the
    honest `.inspector-empty` note.
  - `FabryInput` submits → push a `{question, state:'streaming'}` turn. If a
    `chatId` already exists (turn 0 established it) call `continueAuditQuery`;
    else start a fresh chat via `runAuditQuery` (seeds current rows). Input
    disabled while any turn is streaming (`busy`).
  - **CSS** (all under `.audit-fabry` scope in `console.css`): the band
    gradient, bar/toggle/preview/hint rules, plus the two fixes that repair the
    earlier broken build — input offsets for the ✦ spark (padding-left 27px,
    spark left 10px, loader offsets — mirrors `.inspector-ask`) and narrative
    paragraph rhythm (`.audit-fabry .inspector-diag-body p` margins, restoring
    what was lost with the removed `.inspector-diag` wrapper).
- `App.jsx` mounts `<FabryPanel/>` inside `.audit-body`, **above `FiltersBar`**
  (in the header region), only when `aiAvailable.value`. Not-connected and
  audit-403 (`UnavailablePanel`) states are unchanged — no Fabry surface there.

### 4.5 CSS

Reuse existing classes. Add only a thin audit-scoped wrapper
(e.g. `.audit-fabry`) for placement/spacing in `console.css`, using existing
palette variables. No class renames, no dark-mode-specific new rules beyond what
the reused classes already provide.

## 5. Autonomous fetch — the gated verification (plan step 0)

The autonomous grounding depends on an **unverified** capability:
`search`/`get` reaching the `audit_log` entity. The implementation plan's first
task is a **live spike** on an internal, non-customer org:

1. Create a chat, send the default audit prompt.
2. Observe `tool-input-start` events: confirm the agent calls a tool that
   returns real audit logs, and record the tool name + accepted params
   (object type / id / timestamp filters).

**Gate outcomes:**
- **Pass** → keep `mode:'autonomous'`; finalize the prompt wording.
- **Fail / unreachable** → switch the default and asks to `mode:'seeded'`:
  seed a budget-capped sample of the currently-loaded audit rows into the prompt
  and drop the "fetch more" instruction. The feature still ships, scoped to the
  loaded view, and the panel copy stays honest about that scope.

Either way, **nothing ships on an unverified assumption**. The spike needs a
live session and will be run when the plan reaches it (owner runs it, or
authorizes an internal-org agent-browser dogfood).

**VERIFIED RESULT (2026-07-10, owner-run live):** the agent **cannot** reach
audit logs. Fabry self-reported its read-only toolset is `get` /
`get_annotation_content` / `search`, none of which expose an audit-log endpoint,
and it correctly refused to invent activity. → **The gate FAILED; `FABRY_MODE` is
`'seeded'`.** The default summary and every question seed the currently-loaded
audit rows into the prompt; the autonomous "use your read-only tools to fetch"
instruction is not used. Scope is honestly the loaded view; `↻` re-seeds the
current view. (Because the agent has no audit tool at all, autonomous mode is not
a future option here unless the agent's toolset changes.)

## 6. Lifecycle & error handling

- **Abort:** one controller per active turn; aborted on new submit-while-busy is
  prevented by disabling input, on disconnect, and on Audit teardown.
- **Agent offline:** `probeAgent()` false → `aiAvailable` false → no Fabry UI at
  all; the app is byte-identical to today. If the agent drops mid-run, the turn
  ends `state:'error'` with the honest `.inspector-empty` note; the programmatic
  audit table is unaffected.
- **401 during a Fabry turn:** surface on the existing audit `ErrorBanner`
  (session-wide), consistent with the app's other 401 handling.
- **Stale guard:** turns carry an id; a completed stream only writes if its
  controller is still current (mirrors the Inspector's `loadId`/signal guards).

## 7. Backward compatibility

- No manifest change; no new `chrome.storage` keys; no persisted-state schema
  change → no migration path needed.
- Existing Audit behavior (filters, table, detail, pagination, cursor paging,
  403 → `UnavailablePanel`, not-connected empty state) is untouched.
- The Inspector and MDH are **not modified** (their `parseNarrative` copies and
  their Fabry components stay as-is). The only cross-app reuse is the
  already-shared `agentApi`/`agentStream`.

## 8. Testing

Vitest, following repo conventions (`.test.js` with `h()` + `vi.mock`, no
vitest-config broadening; condition-based `waitFor`, not fixed timeouts):

- `src/ui/fabry/narrative.test.js` — `parseNarrative`/`parseCitations`:
  bullets vs paragraphs, streaming partial last line, cite segments, empty input.
- `src/audit/fabry.test.js` — `buildAuditPrompt` for `autonomous` and `seeded`
  modes (read-only framing present, no-citation instruction present, filters
  embedded, seeded rows budget-capped); `runAuditQuery`/`continueAuditQuery`
  fold a mocked event stream into `{text, reasoning, tools, chatId}`.
- `src/ui/fabry/FabryInput.test.js` — Enter fires `onSubmit`; busy hides value +
  shows loader; Escape clears.
- `src/ui/fabry/FabryNarrative.test.js` — renders takeaway/bullets/next-step;
  streaming caret present iff `streaming`; no `resolveCite` → cite text is plain.
- `src/audit/components/FabryPanel.test.js` — auto-runs the default once when
  `aiAvailable` flips true; appends a turn on submit; `↻` resets; `[×]`
  dismisses; offline/error render the honest note (agentApi + fabry.js mocked).
- `src/ui/GerundLoader.test.js` — renders a gerund; advances on tick.

Then `npm run build` (dogfood-loadable dist per the standing rule that tests run
against `src/` but the loaded extension runs `dist/`).

## 9. File inventory

**New:** `src/ui/GerundLoader.jsx`, `src/ui/fabry/FabryInput.jsx`,
`src/ui/fabry/FabryNarrative.jsx`, `src/ui/fabry/FabryTranscript.jsx`,
`src/ui/fabry/narrative.js`, `src/audit/fabry.js`,
`src/audit/components/FabryPanel.jsx`, plus the tests in §8.

**Modified:** `src/audit/store.js` (aiAvailable + fabry signal + resetFabry),
`src/audit/index.jsx` (probe + auto-run effect + abort), `src/audit/components/App.jsx`
(mount FabryPanel), `src/console/console.css` (thin `.audit-fabry` wrapper).

**Unchanged:** `manifest.json`, `src/mdh/**`, `src/inspector/**`, storage schema.

## 10. Out of scope (deferred to their own specs)

- Migrating MDH `AgentBox` and Inspector `DiagnosisPanel`/`FollowupThread` onto
  `src/ui/` (behavior-preserving, regression-tested) and removing the duplicated
  `parseNarrative`.
- Relocating `agent/*` from `src/mdh/agent/` to a neutral `src/agent/`.
- Persisting the Fabry conversation across reloads/tabs.
- NL → filter-builder behavior (the "build & run the query" capability we did
  not choose) and Rossum deep-link citation chips (the citation option we did
  not choose).
