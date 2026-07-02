# MDH Agent Surface — replacing `llmchat` with the Rossum Agent API

- **Date:** 2026-07-02
- **Status:** Design approved; spec under review (pre-implementation)
- **Scope:** Dataset Management (MDH) NL→pipeline feature only
- **Audience:** Internal / dogfood (Rossum SAs), single implementation plan

---

## Revision 2 (2026-07-02) — drop-in box + client-side verify loop

After the initial build (conversational surface), the owner iterated the design. This revision
**supersedes §3, §5–§8** below; §1–§2 (problem, verified API contract) and §4 (read-only) still hold.

Three changes:

1. **Back to a drop-in replacement (hide the chat).** The conversational transcript/bubbles/New-chat
   and all per-collection session state are removed. `AgentBox` is now a single input + a live
   status line + a one-line result note — the old NL box's footprint. **A fresh chat per submit**
   (create → `/persona cautious` → one generation turn), so the read-only framing is re-sent on
   every query (this also eliminates the earlier session-lifecycle bugs and the final review's
   "framing dropped on first-turn retry" finding). No agent session signals in `store.js`.

2. **Verify-and-refine loop restored, client-side (`agent/agentQuery.js`).** The agent GENERATES a
   pipeline; the **client executes it via the extension's own `api.aggregate`** (the proven MDH
   Data Storage client) to verify — this does NOT depend on the agent's own tool auth, which was
   found to 401 on the test token. On a bad result (execution error or 0 rows) the client sends the
   agent a correction turn (the failure + sample docs) in the same chat and re-runs, up to
   `MAX_CORRECTIONS = 2`. `runAgentQuery({api, agentApi, request, collection, fields, samples,
   onPhase, signal}) → { pipelineText, note }`; `note.kind ∈ verified|refined|empty|error|unrun|
   no-pipeline`. Injected `api`/`agentApi` make it unit-testable. This is *stronger* than the old
   `llmchat` loop in one respect (real execution against the org) and equivalent in structure.

3. **JSON-only generation prompt.** `buildGenPrompt` instructs the agent to reply with ONLY a raw
   JSON array (no prose/markdown). Live-verified on Elis: reply dropped from ~311 chars of prose to
   71 chars of pure JSON. `extractPipeline` still guards against any stray prose.

**Progress UI:** status line while running (`Generating… / Running… / Refining (n of 2)…`) + a tiny
post-run note (`verified · N rows` / `refined · N rows` / `applied · 0 matching rows` /
`applied · could not verify` / `no query produced`). No trace panel.

**Read-only:** unchanged in force — `/persona cautious` primed per chat + JSON-only read-only
framing; the client's `api.aggregate` verification is a read. The §4 ship-blocker (a hard
server-side guarantee before real orgs) still stands.

**Retired-CSS cleanup folded in:** removed the dead `.ai-trace*` block (~70 lines) + `.modal-card:has(.ai-trace-body)` left by the deleted `AiRunTrace`, and the now-unused `.agent-transcript/.agent-msg*/.agent-newchat` rules.

---

## Revision 3 (2026-07-02) — prompt rules, read-only guard, iterate, loader, URL

Supersedes the relevant parts of Revision 2. Changes:

1. **Enriched generation prompt (`buildGenPrompt`)** — ported the retired llmchat rules: default **≤50-row cap** (mechanically enforced by `capRows`, not just instructed), use **exact stored values** from the samples, **`$toInt` inside `$expr`** for digit-string fields, **`$search`/regex** for free text, extended-JSON date/ObjectId guidance, an explicit **"do NOT call tools"** (the client executes/verifies, so the agent is a pure generator — also cuts verbosity + avoids its tool-auth 401s), and a hard **JSON-only** output rule.
2. **Iterate on the current query** — the current editor pipeline (`stripAiComment(getValue())`) is passed as `currentPipeline` and included in the prompt ("Current pipeline: …; modify it, or replace entirely if the request is new"), restoring the old modify-in-place behavior. Fresh chat per submit is retained; the *editor* carries iteration state, not a chat session.
3. **READ-ONLY enforced client-side (fixes a review Critical)** — `agentQuery.screen()` runs `pipelineOps.terminalWriteStage` on every generated/refined candidate: a `$out`/`$merge` pipeline is **never executed or applied** (note `blocked`), an agent-emitted `[]` is `declined` (never run as a return-everything pipeline). `verify()` carries the same guard. The client's `api.aggregate` is the one used app-wide, which itself refuses to auto-run writes.
4. **Collection-change abort + stale guard (fixes a review Important)** — `AgentBox` aborts an in-flight run on collection change and drops results if the collection changed mid-run, so a slow query never clobbers the wrong collection's editor.
5. **UI** — removed the result note; restored + enhanced the animated rainbow `.nl-search-loading` loader (spinning conic border + shimmer + glow pulse + gentle bob, rotating playful gerunds), respecting `prefers-reduced-motion`. Failures (couldn't-build / write-`blocked` / 401) surface on the global error banner.
6. **Agent URL → `https://rossum-agent-api.tools.rossum.cloud/api/v1`** — added `https://*.rossum.cloud/*` to `manifest.json` host_permissions (a new host needs an extension RELOAD, not just a page refresh, or Chrome enforces CORS). Live-verified: health OK + a generation turn returns terse JSON.

The §4 read-only ship-blocker still stands as a defense-in-depth caveat, but the write-stage guard now gives a real client-side read-only guarantee for what the extension executes/applies.

---

## Revision 4 (2026-07-02) — restored schema hints + semantic verification; dropped the AI comment

An audit against the retired `llmchat` implementation found two capabilities the drop-in redesign
had dropped; both are now restored (additively — the read-only guard, drop-in UI, and transcript stay):

1. **Data-driven schema hints** — restored as `src/mdh/agent/aiContext.js` (`getSchemaHints`,
   self-contained detectors): known distinct values of low-card fields, top-N values, numeric
   ranges, numeric-string-field detection, array paths, a field-type map, and the collection's
   Atlas Search index list (a cached `$facet` + `listSearchIndexes`). `AgentBox` fetches them
   before the run and passes them as `hints`; `agentQuery.schemaHintParts` formats them into the
   generation prompt. This is why the agent can use exact stored values, `$toInt` on the right
   fields, and `$search` with a real index name (it can't discover indexes itself — tools are off).
2. **Semantic result verification** — restored in the loop: after the mechanical check passes
   (ran, ≥1 row), a second agent turn (`buildVerifyPrompt`/`parseVerdict`) judges whether the
   ACTUAL sample rows answer the request (`answersRequest` + 0–100 `score` + `issue`). A fail
   (or score < `VERIFY_MIN_SCORE` = 50) becomes a `mismatch` verdict that drives a correction
   turn, within the same ≤2-refinement budget. Lenient: an unparseable verdict does not block.

Also: the applied pipeline no longer gets a `🤖 AI request` comment prepended — the transcript
modal now carries that context. Live-verified on `rossum.cloud`: hinted generation returns a
terse pipeline using the exact known value, and the verifier returns a parseable JSON verdict.

---

## Revision 5 (2026-07-02) — fresh chat per input; continue-in-transcript to iterate

- The AI **input field always starts a fresh chat** (unchanged: `runAgentQuery` creates one per
  submit), and now returns the `chatId` alongside `{pipelineText, note, transcript}`. `AgentBox`
  keeps a `session = { chatId, transcript, ctx:{collection,fields,samples,hints} }`.
- The transcript modal is now **interactive** (`TranscriptModal`): it shows the run's conversation
  and has a **"continue" input** that calls `continueAgentQuery` — which reuses the existing
  `chatId` (no new chat, no `/persona` re-prime; the agent keeps prior context) and runs the same
  generate→verify(mechanical+semantic)→refine loop on a copy of the transcript. Each continuation
  applies the refined pipeline to the editor and propagates the grown transcript back to `AgentBox`.
- Refactor: the loop body is extracted into a shared `runLoop`; `runAgentQuery` (createChat +
  prime + runLoop) and `continueAgentQuery` (runLoop on an existing chat) both use it.
- Live-verified on `rossum.cloud`: a follow-up "now only those over 10000" in the same chat kept
  the prior `status:open` + sort + limit and added `total_amount > 10000`.

---

## 1. Problem & intent

MDH's "Describe a query in plain English" box currently translates natural language into a
MongoDB aggregation pipeline via Rossum's **internal `llmchat`** endpoint
(`{customerOrg}/api/v1/internal/llmchat`). That path is a *stateless, one-shot, deterministic
text completion*; the client wraps it in an agentic loop (`aiPipelineLoop.js`) and gathers
schema hints itself (`aiContext.js`).

We want to **evolve this box into an embedded agent surface** backed by the new **Rossum Agent
API** (`https://rossum-agent-api.tools.r8.lol/api/v1`) — a stateful, autonomous, tool-using
Rossum agent. The agent introspects the collection itself (via its MCP tools), self-corrects,
and can hold a multi-turn conversation, letting the box grow from a one-shot translator into a
compact conversational query copilot.

This spec **fully replaces** the `llmchat` path (no fallback, no engine toggle).

## 2. Verified facts (live, 2026-07-02)

All of the following were verified against the live service with a **test token on the Elis
internal org** (`https://api.elis.rossum.ai/v1`). **No customer data was sent; no writes were
performed.**

**Transport / auth**
- Base URL: `https://rossum-agent-api.tools.r8.lol/api/v1` (FastAPI/uvicorn, `2.2.0dev0`,
  postgres-backed — i.e. an **internal, dev-versioned** service).
- Auth headers: `X-Rossum-Token: <raw token>` + `X-Rossum-Api-Url: <org API base>` (e.g.
  `https://<org>.rossum.app/api/v1`). Invalid token → `401 {"detail":"Invalid Rossum API token"}`.
- The extension already holds both pieces (session token + domain). `host_permissions` already
  includes `https://*.r8.lol/*`; the manifest sets **no** `content_security_policy`, so the
  default MV3 CSP does not restrict `connect-src`. The server enforces a **CORS origin
  allowlist** (rejected a fake `chrome-extension://` origin), but Chrome **bypasses CORS** for
  host-permitted fetches from an extension page, so this does not block us. *(Reachability from a
  non-Rossum network was NOT verified — acceptable under the internal/dogfood scope.)*

**Endpoints used**
- `POST /chats` → `201 {chat_id, created_at}`. **Accepts any JSON body and ignores unknown
  fields** (`{read_only:true}`, `{mode:...}`, `{tools:[]}`, `{persona:...}` all returned normal
  chats) — so create-chat body params are **not** reliable controls.
- `POST /chats/{id}/messages` with body `{"content": "<text>"}` → **streaming** response (AI-SDK
  data-stream protocol; see below). Body field is `content` (not `message`).
- `GET /chats/{id}` → `{chat_id, messages:[{role,content,feedback}], created_at, files}` —
  history is **persisted server-side** (retrieved verbatim). Also: `GET /chats` (list),
  `PUT /chats/{id}/feedback`, `GET /chats/{id}/files/{name}`, `GET /commands`, `GET /health`
  (public, no auth).

**Streaming protocol** — `text/event-stream`, lines of `data: <json>` then `data: [DONE]`:
```
start
reasoning-start / reasoning-delta {delta} / reasoning-end        (id per block)
tool-input-start      {toolCallId, toolName}
tool-input-available  {toolCallId, toolName, input}
tool-output-available {toolCallId, output}
text-start / text-delta {delta} / text-end                       (id per block)
data-final-answer     {data:{text}}      ← the complete final answer text
finish
[DONE]
```

**Behavior**
- The agent is **persona-constrained to Rossum topics**: a generic MongoDB question was refused;
  a request framed as a Rossum Data Storage / MDH task was answered with a correct pipeline.
- It **autonomously uses tools/skills** (observed it call `load_skill` then `list_datasets` on
  its own to answer a collection question).
- Final answers may be **fenced** (```` ```json ... ``` ````) — MDH's existing `stripFences`
  handles this.
- It is **non-deterministic** (reasons first) and **slower** than `llmchat` (~5.8 s for a
  trivial one-turn reply; multi-tool turns longer).
- **Availability is decoupled from the per-org `llmchat` feature flag** — the agent answered on
  Elis, where `llmchat` is `403`. (The agent's model runs in the agent service, not the org.)
- Personas: `/persona` command exposes `default` ("acts autonomously") and `cautious` ("plans
  first, asks before writes, verifies"). Persona is a **`/commands` slash command**, set by
  sending it as message `content`; there is no verified create-chat persona param. **Verified
  2026-07-02:** a new chat starts as `default`; sending `/persona cautious` switches it and the
  switch **persists across subsequent turns** in the session (a later `/persona` reports
  `cautious (active)`). The `cautious` persona self-describes: *"Write operations are gated by a
  confirmation prompt — when a write tool is [called]…"* (its modeled behavior; that the gate is
  actually enforced server-side still needs owner confirmation — §4).
- **Slash-command turns emit reply text via `text-delta` only, with NO `data-final-answer`;**
  ordinary turns include a `data-final-answer`. So the client must accumulate `text-delta`
  between `text-start`/`text-end` as the reply and treat `data-final-answer` as an optional
  convenience/duplicate.

## 3. Goals / non-goals

**Goals**
- Replace `llmchat` with the Agent API as the engine behind MDH's NL query box.
- Keep the surface **compact** (no permanent new column; expands transiently, collapses).
- Support **multi-turn follow-ups** on a persisted chat session ("now only over $10k").
- Preserve the **bridge principle**: the agent writes pipelines *into MDH's existing JSON
  editor*; MDH executes and renders results (List/Table/Stages, saved queries) unchanged.
- Retire the now-unused `llmchat` machinery cleanly.

**Non-goals (v1)**
- Rehydrating chat history from the server on reload.
- A user-facing engine toggle or `llmchat` fallback.
- Exposing slash-commands / skills / file downloads / feedback UI (future).
- Guaranteeing customer-network reachability of `tools.r8.lol`.

## 4. Read-only safety constraint (gating)

**Hard requirement:** the feature must **never modify anything in the customer organization or
any data**. Read-only only.

**Reality:** the agent runs its own **write-capable** MCP tools (`data_storage_*`, `rossum_*`
create/update/delete) **server-side**, autonomously, using the token we pass — which is the
user's full-permission session token. The stream surfaces a tool call only *after* it executed,
so **the client cannot intercept or prevent a write.** A client-side app cannot unilaterally
guarantee read-only.

**Decided posture (interim, for internal/dogfood on a test org):**
- Open every session by setting the **`cautious` persona** (send `/persona cautious`) **and**
  prefixing the working context with an explicit **read-only instruction** ("You may only read /
  aggregate / introspect. Never create, update, delete, or modify any data or configuration. If a
  task would require a write, explain instead of doing it.").
- **Never send an approval turn** — if the agent asks before a write (the cautious contract), the
  turn simply ends without approval.

**Ship-blocker (must resolve before this is pointed at any real org):** confirm a **hard**
guarantee with the agent-service owners — either (1) a verified server-side **read-only mode /
tool allowlist**, or (2) confirmation that the `cautious` persona's **write-confirmation gate is
enforced server-side** (the persona already *self-describes* one — "Write operations are gated by
a confirmation prompt", verified 2026-07-02 — so this narrows to confirming the gate is real, not
merely modeled, and that our never-approve stance blocks the write), or (3) pass a **read-scoped
(viewer-role) Rossum token** so the Rossum/Data-Storage API rejects any write (403) regardless of
agent behavior. Until one holds, the feature stays on internal/dogfood test orgs only. Tracked
in §10.

## 5. Architecture & components

Approach: **thin streaming client + agent-as-brain, MDH-as-hands.** New code lives under
`src/mdh/agent/` (small, focused modules following existing MDH conventions).

- **`agentStream.js` (pure, DOM-free, unit-tested).** Incremental SSE parser: feed it raw chunk
  text, it yields typed events and maintains accumulators (`reasoning`, `text`, current tool).
  Exposes a `toolLabel(toolName)` map → human status strings (`list_datasets`→"listing
  datasets…", `data_storage_aggregate`/`data_storage_find`→"querying the collection…",
  `load_skill`→"consulting reference…", default→"working…"). No network → fully testable.
- **`agentApi.js` (transport).** `createChat()`, `streamMessage(chatId, content, {onEvent,
  signal})` using `fetch` + `ReadableStream` reader (decode → feed `agentStream`), `getChat(id)`,
  `probeAgent()` (`GET /health` → boolean). Sends `X-Rossum-Token`/`X-Rossum-Api-Url`. Abortable
  via `AbortController`. **Timeout:** not the 30 s Data-Storage cap — use an **idle/inactivity**
  timeout (reset on each event) plus an overall ceiling, since agent turns legitimately run long.
  Exact server-side cap to be observed during implementation.
- **Store signals (`store.js`).** `agentChatId` (per tab+collection), `agentMessages[]`
  (`{role, text, status?, pipelineApplied?, rowCount?}`), `agentStreaming` (bool), `agentStatus`
  (current live label). `aiAvailable` is retained but now driven by `probeAgent()`.
- **`components/AgentBox.jsx`.** Replaces the body of `.nl-search-row` in `PipelineEditor.jsx`.
  Compact: input always visible; a collapsible transcript above it; a single live status line
  while streaming; an "applied ✓ (N rows)" affordance after a pipeline lands; a **New chat**
  control. On the opening turn of a session it primes persona + read-only framing (§4).

Retired: `aiPipelineLoop.js`, `aiContext.js`, `components/AiRunTrace.jsx`, `api.llmChat` /
`api.probeLlmChat`, and the prompt-building half of `llmPipeline.js`
(`buildPipelineMessages`/`buildFixMessages`/`buildVerifyMessages`/`parseVerification`/
`ensureRowLimit`/schema-hint blocks). **Kept** (still used): the pure helpers `stripFences`,
`safeParseArray`, `prependAiComment`/`stripAiComment`, `samePipeline` — moved to a small
`pipelineText.js` if that leaves `llmPipeline.js` empty.

## 6. Data flow (one submit)

1. User types a request, hits Enter in `AgentBox`.
2. Ensure a chat session for the current `(tab, collection)`: if none, `createChat()`, store
   `agentChatId`, and prime persona + read-only framing.
3. Append the user turn to `agentMessages`; set `agentStreaming=true`.
4. `streamMessage(chatId, content, {onEvent, signal})`:
   - `reasoning-*` / `tool-input-start` → update `agentStatus` (compact live label).
   - `text-delta` → **accumulate** into the assistant bubble (this is the authoritative reply
     text; slash-command turns have only these, no `data-final-answer`).
   - `data-final-answer` → capture as the final text **if present** (optional convenience).
5. On `finish`/`[DONE]`: the reply text = `data-final-answer` if present, else the accumulated
   `text-delta`. Extract a pipeline from it (`stripFences` → `safeParseArray`).
   - **Pipeline found** → `editorRef.setValue(prependAiComment(pipelineText, request))`; MDH's
     existing onChange runs it; show "applied ✓ (N rows)" once the results view reports a count.
   - **No pipeline** (prose / clarifying question) → render the text as an assistant bubble;
     **do not touch the editor.**
6. Follow-up turns reuse the same `chatId` (multi-turn context lives server-side).

## 7. Session lifecycle

- One chat per `(tab, collection)`, held **in memory for the session** (in a signal).
- **Reset** (drop `agentChatId`, clear `agentMessages`) on collection change or explicit **New
  chat**.
- **Not** rehydrated from the server on reload in v1 (YAGNI). No new persisted storage keys.

## 8. Compact UI / real-estate

- Collapsed default = today's footprint: a single input row. No permanent extra column.
- While streaming: one status line (`▸ <label>…`); the transcript is a compact, scrollable,
  collapsible region that appears with the conversation and can be collapsed back.
- After apply: a small "applied ✓ (N rows)" chip; the editor + results are the primary surface.
- **Attribution:** a small, unobtrusive **"Powered by Mr. Fabry"** credit line on the surface
  (e.g. under the input or in the transcript header). "Mr. Fabry" is the internal name for the
  agent; acceptable to show given the internal/dogfood scope. Not a customer name.
- Reuses existing `.nl-search-*` styling in `console.css` where possible; new `.agent-*` rules
  kept minimal.

## 9. Error handling

- **Host unreachable / `probeAgent` fails** → `aiAvailable=false` → box hidden (today's behavior
  for an unavailable engine).
- **`401`** → existing "Session expired. Open a Rossum page and click Data Storage again to
  reconnect." message.
- **Stream error / idle timeout** → surface a non-destructive error; **leave the editor intact**;
  keep the chat session so the user can retry.
- **Abort** on collection change / component unmount (existing `nlAbortRef` pattern).
- **Malformed final text** (no parseable pipeline) → treated as prose (see §6.5), never clobbers
  the editor.

## 10. Open items / must-verify-before-ship

1. **Read-only hard guarantee (BLOCKER for real orgs).** Resolve one of the three paths in §4
   with the agent-service owners before enabling anywhere a write could touch a real org. Path 2
   is now the most promising (the `cautious` persona self-describes a write-confirmation gate);
   confirm that gate is enforced server-side, not merely modeled.
2. ~~Persona-setting mechanism~~ — **RESOLVED 2026-07-02.** `/persona cautious` sent as a message
   switches the persona and it persists across subsequent turns in the session. Prime it on the
   opening turn of each session.
3. **Server-side turn timeout.** Observe the actual cap to tune the idle/overall timeouts.
4. **Reachability** from non-Rossum networks — out of scope for dogfood, revisit before wider use.

## 11. Testing strategy

- **`agentStream` unit tests:** feed recorded SSE fixtures (reasoning, multi-tool, fenced final
  answer, split-across-chunk boundaries, `[DONE]`) → assert accumulated text + status labels.
- **Pipeline extraction tests:** fenced/bare/no-pipeline final answers → correct apply/skip.
- **`AgentBox` UI test** with a **mocked transport** (per the repo's `h()`/`vi.mock` convention):
  submit → status updates → editor `setValue` called with the applied pipeline; no-pipeline →
  editor untouched.
- **Remove** tests for retired modules (`mdh-ai-*` loop/context tests, `AiRunTrace`).
- Keep the full suite green; rebuild `dist/` for browser dogfooding.

## 12. Docs / memory

- Update `CLAUDE.md` (MDH section) to describe the agent surface + the read-only posture.
- Add a `reference` memory capturing the verified Agent API contract (URL, headers, endpoints,
  stream vocab, ignored body params, persona mechanism) and a `project` memory for this work.
- **Do not commit** during the run (per standing preference); leave artifacts in the working tree.
