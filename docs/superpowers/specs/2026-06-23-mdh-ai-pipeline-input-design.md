# MDH AI Pipeline Input — restore the colourful NL input, powered by `internal/llmchat`

**Date:** 2026-06-23
**Status:** Design — awaiting review
**Area:** `src/mdh/` (Dataset Management, Console app)

## Goal

Restore the natural-language pipeline input that lived in the MDH pipeline editor
(removed 2026-06-03, commit `d99e48c`): a text box below the pipeline toolbar where
the user types a plain-English request and the aggregation pipeline is generated or
modified for them, wrapped in the original animated styling (spinning conic-gradient
border + multi-colour shimmer "Generating pipeline…" label + purple glow).

The original was powered by Chrome's on-device **Gemini Nano** (`LanguageModel` Web
Platform API), which was deleted wholesale. This restores the **UI/UX verbatim** but
swaps the engine to the Rossum platform endpoint **`POST /api/v1/internal/llmchat`**,
self-hiding wherever that endpoint is feature-flagged off.

## Verified facts (live probe against `a customer dev org`, 2026-06-23)

`llmchat` was probed live with an `organization_group_admin` token. The contract:

| Aspect | Behavior |
| --- | --- |
| Endpoint | `POST {baseDomain}/api/v1/internal/llmchat` (same base + auth as the existing `getOrgId()`/`token_info` call — **not** the `/svc/data-storage` `serviceBase`) |
| Auth | `Authorization: Bearer <token>` — the session token MDH already holds |
| Body | `{"messages":[{"role":"user","content":"<everything>"}]}` |
| Required field | `messages` — empty body → `400 {"messages":["This field is required."]}` |
| Role constraint | Input must contain **only `user`** messages. A `system` message (or a replayed assistant turn) → `400 {"detail":"Cannot communicate with chatbot at the moment"}`. There is **no custom-system-prompt control**; instructions must be folded into the user content. |
| Model / temperature | **No control** — unknown params are silently ignored. |
| Response (200) | The conversation echoed back with the model's reply **appended as the last element**, with role `"system"`: `{"messages":[<input…>,{"role":"system","content":"<reply>"}]}`. Extract `messages.at(-1).content`. |
| Output quality | A folded MongoDB-expert prompt returned a clean, correct pipeline JSON array (`$sort`/`$limit`/`$project`). May or may not include code fences → strip defensively. |
| Availability | **Enabled on a customer dev org.** It is **per-org feature-flagged** (older notes saw 403 elsewhere), so the feature must degrade gracefully where it is off. |

**Cheap availability probe (no model generation):** `POST {}` returns `400` ("messages
required") when the endpoint is reachable, and a non-400 (403/401/404/5xx) when it is
gated or unavailable. This distinguishes available-vs-gated without spending a model call.

## Current-code facts the design relies on (verified 2026-06-23)

- `src/mdh/api.js` — `init(domain, token)` stores `baseDomain` + `authHeader`. The internal-endpoint
  pattern already exists in `getOrgId()` (`fetch(\`${baseDomain}/api/v1/internal/token_info\`,
  {headers:{Authorization: authHeader}})` with `combinedSignal()` for a 30s timeout + abort).
  The generic `post()` helper targets `serviceBase` (Data Storage) and is therefore **not** reused here.
- `src/console/console.css` — already defines `--bg-input` (light `#ffffff` / dark `#0d0d18`) and
  `--accent`; the original `.nl-search-input.loading` CSS used `var(--bg-input)` and restores **as-is**.
  There are **no leftover `nl-search`/`ai-*` rules** (clean restore, no collisions).
- `src/mdh/components/PipelineEditor.jsx` — already holds `editorRef`, imports `records`/`sampledFields`,
  and computes the field set as `new Set([...extractFieldNames(records.value), ...sampledFields.value])`
  (line 46). The NL input belonged here originally and restores here.
- `src/mdh/store.js` — Preact signals (`domain`, `token`, `records`, `sampledFields`, …). A new
  `aiAvailable` signal is added.
- `src/console/index.jsx` → `initMdh()` in `src/mdh/index.jsx` is where the eager probe fires.

## Architecture

Three small, independently testable units, plus three wiring edits.

### New units

1. **`src/mdh/llmPipeline.js`** (new, pure — no DOM, no network) — the prompt/parsing logic:
   - `buildPipelineMessages({ fields, currentPipeline, request }) → [{role:'user', content}]`
     — folds the MongoDB-expert instruction + available fields + current pipeline + request into a
     single user message (the only role `llmchat` accepts).
   - `extractReply(response) → string` — `response?.messages?.at(-1)?.content ?? ''`.
   - `stripFences(text) → string` — removes a leading ```` ```json ```` / trailing ```` ``` ````
     (restored verbatim from the original handler's regex).
   - `classifyProbe(status) → boolean` — `status === 400` ⇒ available; anything else ⇒ unavailable.

2. **`src/mdh/api.js`** additions (transport only, mirroring `getOrgId()`):
   - `llmChat(messages, { signal }) → Promise<object>` — POSTs `{ messages }` to
     `${baseDomain}/api/v1/internal/llmchat`; reuses `combinedSignal()` (30s timeout + external abort);
     throws `apiError(message, status)` on `!res.ok` so the caller sees the status (e.g. 403).
   - `probeLlmChat() → Promise<boolean>` — `POST {}` and return `classifyProbe(res.status)`; defensive
     try/catch returning `false` on any network/parse error (never throws — same shape as `getOrgId()`).

3. **`aiAvailable` signal** in `src/mdh/store.js` — defaults `false`; set by the init probe.

### Wiring edits

4. **`src/mdh/index.jsx` (`initMdh`)** — after `api.init`, fire the probe **non-blocking**
   (`probeLlmChat().then(ok => { aiAvailable.value = ok })`), gated by a per-org sessionStorage cache
   (`mdhAiAvailable_<orgId|domain>`) so a tab reload within the session doesn't re-probe. The probe must
   never block or break boot — a hang/error simply leaves `aiAvailable` `false`.

5. **`src/mdh/components/PipelineEditor.jsx`** — restore the NL input row, gated on `aiAvailable.value`,
   placed directly under `pipeline-header` and above the `JsonEditor`. State: `nlQuery`, `nlLoading`,
   `nlInputRef`, plus an `AbortController` ref. `handleNlSubmit()` (restored from the original):
   - builds context = `fieldsFn()` (the existing merged field set) + `editorRef.current.getValue()`;
   - `const messages = buildPipelineMessages({ fields, currentPipeline, request })`;
   - `const res = await api.llmChat(messages, { signal })`;
   - `editorRef.current.setValue(stripFences(extractReply(res)).trim())` — **direct replace**, with
     CodeMirror undo as the safety net (original behavior);
   - errors: `AbortError` ignored; a `403` (feature turned off mid-session) sets `aiAvailable.value=false`
     (hides the input); other errors surface inline via the existing `error` signal.
   - The single in-flight request is enforced by `disabled={nlLoading}` (original behavior); the controller
     aborts on unmount.

6. **`src/console/console.css`** — restore verbatim: `@property --ai-angle`, `@keyframes ai-border-spin`,
   `@keyframes ai-text-shimmer`, `.nl-search-row`, `.nl-search-wrapper`, `.nl-search-input`,
   `.nl-search-input.loading`, `.nl-search-loading`. (`mdh.css` → `console.css` rename only; `var(--bg-input)`
   already resolves.)

## Data flow

```
user types request + Enter
  → handleNlSubmit() reads fieldsFn() + editorRef value
  → buildPipelineMessages(...)            (llmPipeline.js, pure)
  → api.llmChat(messages, {signal})       (api.js → POST {baseDomain}/api/v1/internal/llmchat)
  → extractReply(res) → stripFences(...)  (llmPipeline.js, pure)
  → editorRef.current.setValue(...)        (CodeMirror; undo available)
```

Availability:
```
initMdh() → sessionStorage cache hit?  → set aiAvailable, done
          → else probeLlmChat() (POST {}, non-blocking) → classifyProbe(status) → set aiAvailable + cache
```

## Error handling

- **Endpoint gated (403):** probe returns false → input never renders. If it flips off mid-session, a live
  403 from `llmChat` sets `aiAvailable=false` and hides the input.
- **Chatbot down (`400 "Cannot communicate with chatbot"`) / 5xx / timeout:** surfaced inline via the `error`
  signal ("AI request failed: …"); the input stays available for a retry.
- **Malformed model output (not a JSON array):** the raw text is still written to the editor; CodeMirror's
  JSON5 validation flags it and the user can edit or undo (original behavior — no client-side JSON parse gate).
- **Abort:** new submit/unmount aborts the in-flight request; `AbortError` is swallowed.
- **Boot safety:** the probe is fire-and-forget with the standard 30s `combinedSignal` timeout and cannot throw
  into `initMdh`.

## Backward compatibility

- Purely additive. No change to existing pipeline editing, query execution, completions, saved queries, or any
  storage key. No popup toggle (MDH is a Console app; popup toggles are content-script-only).
- `aiAvailable` defaults `false`; with the endpoint absent/erroring, behavior is byte-identical to today.
- Auth reuses the existing `token`/`domain`. The probe is authoritative for the **actual runtime session token**
  (the live verification used an API token; the runtime uses the session token — the probe covers any difference).
- New sessionStorage key `mdhAiAvailable_<org>` is ephemeral (not chrome.storage); documented in CLAUDE.md's
  storage-keys section as part of this change.

## Testing

Vitest, following repo conventions (`.test.js`, `h(Component)`, `vi.mock`; no live network):

- `llmPipeline.test.js` — `buildPipelineMessages` (single user message, instructions + fields + pipeline +
  request present), `extractReply` (last-message content; empty/garbage tolerant), `stripFences` (fenced &
  unfenced), `classifyProbe` (400→true, 403/500/0→false).
- `mdh-api.test.js` additions — `llmChat` posts to the `baseDomain` internal path with the messages body and
  parses the reply; throws with `.status` on 403; `probeLlmChat` maps 400→true and non-400/throw→false.
  (Mock `fetch`, mirroring the existing suite.)
- Component-level: a focused test that `PipelineEditor` renders the NL row only when `aiAvailable` is true.

No test performs a live `llmchat` call.

## Agentic self-correction loop (added 2026-06-23, scope expansion)

After generating a pipeline, the AI **executes it against the selected collection and iterates** until it works.
Live-verified on a customer dev org: `llmchat` fixes both hard errors and 0-row semantic misses when fed the outcome,
and does **not** thrash on a legitimately-empty query (it returns the identical pipeline → the no-progress guard stops).

- **Verdict per attempt** (`verdictFor({ok,rowCount})`): backend error ⇒ `error`; executed but 0 rows ⇒ `empty`
  (the only auto-detectable "suspect" signal); otherwise ⇒ `ok`.
- **Sample seeding (precision):** the INITIAL prompt includes up to 3 in-memory sample documents
  (`records.value`, zero extra fetch) so the model uses stored value forms (e.g. `NET30`/`EA`, not `net 30`/`each`)
  on the first try. Live-verified to fix value-format misses with no regressions (a customer dev org, 2026-06-23), and to
  cut retries. Backward-compatible (omitted when no records are loaded).
- **Schema hints (precision, `aiContext.js` → `getSchemaHints`, cached per collection):** the prompt also carries
  (1) **distinct values** of low-cardinality string fields (one cached `$facet`, ≤25 distinct, high-card fields
  pruned by in-memory cardinality first) so coded values are exact (fixes "roll"→`RL`, "pieces"→`PC` — the latter a
  *wrong-but-nonempty* result the loop can't detect); (2) **string-of-digits fields** (free, from records) so numeric
  comparisons convert via `$toInt`/`$expr` (fixes the silent lexicographic `vendorId` bug); (3) **Atlas Search index
  awareness** so free-text/description matching uses `$search` (first stage, synonym/analyzer indexes) while exact
  filters stay `$match`. Live-verified combined with no regression (a customer dev org, 2026-06-23). All degrade to no-ops
  on fetch failure or missing data.
- **Correction** (`buildFixMessages`): a fresh single **user** message (respects the user-role-only constraint —
  no replayed assistant turns) embedding the previous pipeline + the problem + the same schema hints. On an `empty`
  retry, sample documents are included (the in-memory seed if present, else `api.find(collection,{limit:3})`).
- **Row cap:** `ensureRowLimit` guarantees ≤50 rows — appends `{$limit:50}` when the model omits one (e.g. the
  empty/nonsense pipeline), trusting an existing `$limit` (so 'top 5' keeps `$limit:5`). The model is also instructed
  to cap at 50. Measured: a $limit keeps even a full-scan `$group` sub-second; unbounded is 3.5s+. The loop tracks the
  model's RAW output (for fix-context + no-progress compare) separately from the capped applied text.
- **Guardrails:** `MAX_AI_ATTEMPTS = 3` (1 generate + ≤2 fixes); **stop on no-progress** (corrected pipeline equals
  the previous, canonicalised); **one empty-retry max**; probe execution capped via `withProbeLimit` (append
  `{$limit:50}` unless `$count` present); fully abortable; no verification path when no collection is selected or
  the output isn't a JSON array (apply as-is, original behavior).
- **No status notices.** The applied pipeline and its normal execution are the only feedback (the loop self-corrects
  silently and always applies the best pipeline it reached). The loader shows rotating whimsical MongoDB/Rossum-themed
  gerunds (e.g. "Aggregating…", "Consulting the Hub…", "Reconciling line items…") while it works — not the literal
  Claude-Code verbs.
- **Editor comment.** The applied pipeline is prepended with `// 🤖 AI request: <the user's request>` (JSON5 strips
  it on execution; any prior AI comment is removed before re-sending the pipeline as context).
- **Isolation:** the loop is a single function `runAiPipeline({api, request, fields, collection, currentPipeline,
  signal, onPhase})` in `src/mdh/aiPipelineLoop.js`; pure helpers (`buildFixMessages`, `verdictFor`,
  `safeParseArray`, `withProbeLimit`, `samePipeline`, `PROBE_LIMIT`) live in `llmPipeline.js`. The component handler
  just calls `runAiPipeline` and applies `{pipelineText, notice}`.
- **Semantic correctness (non-empty-but-wrong)** remains human-in-the-loop: the user types a follow-up request and
  the current pipeline is re-sent as context.

## Out of scope (explicitly not restored)

The wider removed AI subsystem: `aiKnowledge.js`, the `AiInsight` overlays, the "Feature preview" modal, and the
on-device Gemini Nano engine (`ai.js`). Only the pipeline NL input is restored. Multi-turn conversation is not
built (the endpoint 400s on replayed turns; one-shot generation with the current pipeline in-context already
supports iterative modification).
