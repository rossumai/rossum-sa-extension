# Fabry Chat — agent interactive elements (clarifying questions + unknown-element fallback)

> **Consolidated:** the authoritative as-built spec is
> `2026-07-10-fabry-chat-console-design.md` (this agent interactive elements feature is summarized
> there and that document governs on any conflict). This file is the detailed
> design/rationale companion.


**Date:** 2026-07-13
**Status:** Approved design, pre-implementation
**Surface:** the Fabry Chat Console app (`src/fabry/` + shared `src/agent/`,
`src/ui/fabry/`), experimental-gated

## 1. Problem & grounding

A live event stream (the SOW-price-increase prompt, and "Ask me a question via
data-agent-question") **rendered nothing** in the Fabry chat. Root cause,
verified live 2026-07-13 (internal org, browser-side session):

- When the agent calls its `ask_user_question` tool, the stream emits a
  `data-agent-question` event and **no `text-delta`** (`hasText: false`), then
  `finish`. Our `foldEvents` has no case for `data-agent-question`, so the turn
  accumulates empty text → `replyText(acc)` is `''` → the assistant turn renders
  a blank `FabryMarkdown`. The agent's questions are silently dropped.
- **Event shape:** `{type: 'data-agent-question', data: {questions:
  [{question: string, options: {value, label, description}[], multi_select}]}}`.
  `options` is usually `[]` (free-text); when present, each option is an
  **object** `{value, label, description}` (live-verified 2026-07-13 + backend
  `api/models.py:162-175`) — NOT a bare string. The UI renders `label` (with
  `description` as a hover title) and sends back the `label` text (the backend's
  cautious write-approval matches the literal label string; `FabryQuestions`
  also accepts a plain-string option defensively).
- **Answering is a plain next message** to the SAME chat — verified by answering
  a live question with an ordinary follow-up; the agent continued correctly. No
  special endpoint or payload.
- **Questions are NOT persisted.** `GET /chats/{id}` after answering shows the
  original prompt, then the answer, then the reply — the question turn is gone
  (like `/persona` command turns). So the interactive form lives ONLY in the
  session's live turn; there is nothing to reconstruct from history.
- **The interactive surface is exactly one tool today.** `/list-agent-tools`
  returns 12 non-interactive tools (create_task, execute_python,
  generate_mock_pdf, load_skill, load_tool, run_grep, run_jq, search_elis_docs,
  search_knowledge_base, update_task, write_file, list_tasks); `ask_user_question`
  is a framework tool not in that list. Future interactive elements will almost
  certainly arrive as new AI-SDK `data-*` custom parts (e.g.
  `data-agent-confirmation`), which we cannot enumerate in advance.

**Design principle (owner):** the fix is not "handle `data-agent-question`" — it
is **"never render nothing."** Support questions as a first-class interactive
form today, and degrade every *unknown* interactive element (and stream errors)
to a clear, named message instead of a blank turn.

## 2. Scope

A follow-up enhancement to the shipped Fabry chat. No changes to persistence,
gating, the send/abort machinery, or the transport beyond the stream fold and
tool labels. Two user-visible capabilities:

1. **Clarifying questions** — render `data-agent-question` as an inline
   interactive form; the user answers; answers go back as one message.
2. **Fallback layer** — a turn that finishes with nothing renderable resolves to
   an error notice, an unsupported-element notice (named + raw payload), or a
   quiet "(no response)" note — never blank.

## 3. Stream layer (`src/agent/agentStream.js`)

- `newAcc()` gains `questions: null`, `unhandled: []`, `error: null`.
- `foldEvents` cases:
  - `case 'data-agent-question': acc.questions = e.data?.questions || acc.questions; break;`
  - `case 'error': case 'tool-output-error':` → append the event's message/errorText to `acc.error` (string; first non-empty wins, joined if several).
  - **default:** if `e?.type` is a string starting with `data-` and not one we handle (`data-final-answer`, `data-agent-question`), push `{type, data: e.data}` into `acc.unhandled` (deduped by type). Non-`data-*` unknowns stay ignored as today.
- `replyText(acc)` unchanged (finalAnswer ?? text).
- New pure helper `fallbackNotice(acc)` → `null` when the turn has renderable
  text (`replyText` non-empty) OR questions; otherwise the notice to show, in
  priority order: `{kind:'error', text}` if `acc.error`, else
  `{kind:'unsupported', types, payloads}` if `acc.unhandled` non-empty, else
  `{kind:'empty'}`. Text and questions are rendered independently by the turn
  (both, if both present); `fallbackNotice` only decides the
  nothing-renderable case. Pure, unit-tested.

## 4. View model (`src/fabry/thread.js`, `chat.js`)

- The pushed assistant turn (in `chat.js accTurn`) carries `questions`
  (`acc.questions`), `unhandled` (`acc.unhandled`), and `error` (`acc.error`)
  alongside the existing fields. `normalizeMessages` (history) never sets these
  (questions aren't persisted; a reloaded turn is plain text) — they exist only
  on live-streamed turns this session.
- **Deep verify skips question turns.** A question turn has no factual answer to
  verify. Mechanism: `chat.js`'s injected `sendMainTurn` returns
  `{text, verifiable}` (`verifiable = false` when the streamed answer is a
  question turn — `acc.questions` present; the refine-path answer is always
  verifiable). `deepLoop.js runDeepTurn`, after its FIRST `sendMainTurn`, if
  `answer.verifiable === false`, returns the sentinel `{skipped: true}` before
  any critic pass. `chat.js` treats `{skipped: true}` like a normal completed
  send: it attaches NO `turn.deep` (no verdict chip) and `sendMessage` returns
  `true`. This is distinct from the abort path (`runDeepTurn` returns `null` →
  `sendMessage` returns `false`), so a question turn never restores the
  composer draft. Verification resumes on the answer's turn.

## 5. Answer flow (`src/fabry/chat.js`)

- New action `answerQuestions(answers)` where `answers` is
  `[{question: string, answer: string}]` (one per asked question; multi-select
  answers are joined with ", "). It formats a single message:
  - one question → just the answer text (natural);
  - multiple → numbered `"1. <question>\n   → <answer>\n2. …"` so the agent maps
    answers to questions unambiguously.
  Then routes through the existing `sendMessage(text)` (streams, refreshes the
  sidebar, and — if deep mode is on — the *answer's* turn verifies normally).
- On submit, the question form marks itself answered (renders the chosen answers
  read-only, disabled); the user's answer then appears as the next user turn.
  Nothing is persisted; on reload the whole exchange is server-shaped (original
  prompt → answer → reply).

## 6. Components

- **`src/fabry/components/FabryQuestions.jsx`** (new) — presentational form for
  one turn's `questions`. Per question: free-text (`options: []`) → text input;
  single-select (`options` non-empty, `!multi_select`) → option buttons;
  multi-select → checkboxes. Owns local answer state; a Submit button (disabled
  until every question has an answer) calls `onSubmit(answers)`. After submit it
  renders the chosen answers read-only. Styled `.fabry-q-*` on the blue scheme.
- **`src/fabry/components/AssistantTurn.jsx`** — after the markdown body, when
  `turn.questions` render `FabryQuestions` (wired to `answerQuestions`); the
  feedback footer is suppressed on an unanswered question turn (no answer to
  rate). When the turn has no text and no questions, render the fallback
  (below). Streaming turns never render questions (they arrive on `finish`).
- **`src/ui/fabry/FabryNotice.jsx`** (new, small) — the fallback renderer used
  by AssistantTurn, driven by `fallbackNotice(acc)`'s
  `kind: 'error' | 'unsupported' | 'empty'`.
  - `error`: red `.fabry-notice-error`, the error text.
  - `unsupported`: `.fabry-notice-warn` — "Mr. Fabry used an interactive element
    this version of the extension doesn't support yet (`<type>`). Update the
    extension, or continue this chat in the Rossum agent UI." + a "Details"
    `<details>` with the raw payload JSON (never parsed/guessed).
  - `empty`: quiet `.fabry-notice-muted` "(no response)".

## 7. Tool labels (`src/agent/agentStream.js` TOOL_LABELS)

Add human labels so the tool chips this feature surfaces read clearly:
`ask_user_question` → "asking you a question", `write_file` → "writing a file",
`search_knowledge_base` → "searching the knowledge base", `search_elis_docs` →
"searching the API docs", `create_task`/`update_task`/`list_tasks` → "tracking
tasks", `execute_python` → "running a script", `generate_mock_pdf` →
"generating a test document", `load_tool` → "loading tools", `run_grep`/`run_jq`
→ "processing output". Unlabeled tools keep the existing heuristic.

## 8. Error handling

- Answer send reuses `sendMessage`'s taxonomy (401 → app banner, 429 → inline,
  abort → interrupted turn). If `answerQuestions` fails, the form re-enables so
  the user can retry.
- Stream `error` events surface via the fallback (§6) rather than being dropped.
- An `unhandled` element that arrives ALONGSIDE renderable text (agent said
  something and used a new element) renders the text normally plus the
  unsupported notice — the text is never hidden by the fallback.

## 9. Testing

- `agentStream`: fold `data-agent-question` → `acc.questions`; fold an unknown
  `data-foo` → `acc.unhandled`; fold `error` → `acc.error`; `fallbackNotice`
  returns null when text or questions exist, else error → unsupported → empty
  in priority.
- `FabryQuestions`: free-text / single-select / multi-select render; Submit
  disabled until answered; `onSubmit` payload shape; read-only after submit.
- `chat.js`: a question turn is pushed with `turn.questions` and (deep mode on)
  gets NO verdict; `answerQuestions` formats one- vs multi-question messages and
  calls `sendMessage`; an unsupported/error turn carries the right fields.
- `FabryNotice`: three kinds render; unsupported shows the type name + details.
- `AssistantTurn`: question turn renders the form + suppresses feedback;
  text-less error/unsupported/empty turns render the notice, never blank.
- **Live gates (elis):** both original prompts — (a) SOW email → the agent asks
  for the customer name/context → form renders → answering continues the draft;
  (b) "Ask me a question…" → question renders and is answerable. Confirm a
  reloaded chat shows the server-shaped exchange (no orphaned form).

## 9b. Backend cross-check (verified 2026-07-13 against the rossum-agent source; static unless noted)

Findings from reading the backend (`rossum-agent` + sibling `rossum-mcp`),
folded in as as-built facts:

- **LLM model:** main agent = an AWS Bedrock application-inference-profile ARN
  commented **"Opus 4.6"** (`bedrock_client.py:8`, `get_model_id()`,
  env-overridable `AWS_BEDROCK_MODEL_ARN`; `MAX_OUTPUT_TOKENS = 128000  # Opus
  4.6 limit`, adaptive extended thinking); used by the main loop AND the
  sub-agents (no separate critic model). A second model, **"Haiku 4.5"** ARN
  (`bedrock_client.py:9`), is used ONLY for one-sentence chat-title summaries
  (`api/stream.py`), never for tool-calling. No raw Anthropic model slug exists
  in the repo — identity is the ARN + source comments (the cited ARN is a
  dev-eu profile; prod may differ).
- **Write-lock — the standing "no server-side write-lock" ship-blocker is
  OUTDATED.** Two real server-side layers exist: (a) the cautious persona is a
  code-level gate (`cautious_gate.py`) that blocks each write tool call pending
  confirmation — not prompt-only; (b) the MCP server disables all
  `tags={"write"}` tools in read-only mode, and our chats default to read-only
  (`chat_models.py ChatMetadata.mcp_mode="read-only"`) because we never send
  `mcp_mode`. Caveats: fastmcp's runtime `disable()` was not executed in the
  check; prod config may differ; cautious pre-approval is keyed by tool-NAME
  (not per-args); and the read-only default is IMPLICIT (a future FE change that
  sent `mcp_mode:"read-write"` would silently remove it — worth an explicit
  guard/comment before relying on it).
- **Feedback `turn_index` is misaligned for tool/question turns (LIVE-CONFIRMED,
  pre-existing bug from the shipped Fabry Chat).** `turn_index` indexes the RAW
  stored history, but `GET /chats/{id}` drops text-less tool-only steps. Live:
  a one-queue answer that used a tool sat at GET-projection index 1 but RAW
  index 2 (a hidden tool step at raw 1); `PUT turn_index=1` hit the hidden step,
  `=2` hit the answer, `=3` → 404. Our `serverMessageIndex` computes the
  projection index → mis-targets feedback whenever the answer involved a tool
  call (the common case). NOT fully FE-fixable (the projection omits the hidden
  steps we'd need to count); a proper fix needs the backend to expose a stable
  per-message feedback id/raw index. Tracked as an open decision (disable the
  thumbs UI vs. caveat vs. backend ask) — see §10.
- Confirmed exactly: `/persona` never enters history; a plain next message IS a
  question's answer (no special endpoint); top-level `{content, images}`; the
  full wire vocabulary (incl. top-level `error`; NO `tool-output-error` — tool
  failures ride inside `tool-output-available` text); `ask_user_question` is the
  only user-interactive tool. Two informational custom parts we now ignore
  rather than false-alarm on: `data-task-snapshot`, `data-file-created`.

## 10. Out of scope

- Persisting or reconstructing question forms from history (server doesn't keep
  them).
- Speculatively rendering unknown `data-*` elements as anything other than the
  named notice + raw payload.
- New interactive element types beyond questions (they'll hit the fallback until
  explicitly supported — which is the point). `data-task-snapshot` /
  `data-file-created` are known-informational and ignored (not rendered); live
  surfacing (task plan, generated-file links) is a future enhancement.
- **Feedback `turn_index` correctness (§9b) — DECIDED 2026-07-13: hide the
  thumbs + backend ask.** The 👍/👎 buttons are removed from `AssistantTurn`
  (Copy + deep-verify chip stay); the plumbing (`sendFeedback`,
  `serverMessageIndex`, `submitFeedback`) is kept dormant with pointer comments
  for a one-line re-enable. **Backend ask (agent team):** expose a stable
  per-message feedback target — either the raw-history index or an opaque id —
  on each `GET /chats/{id}` message, so a client can address `PUT /feedback`
  without counting the text-less tool-only steps the projection hides. Until
  then, the FE cannot map a visible turn to its raw `turn_index`.
- Rendering options as native checkboxes (spec earlier said "checkboxes"; the
  as-built uses accessible toggle buttons with the option `label` + `description`
  hover — functionally equivalent).
