# Fabry Chat — "Deep verify" autonomous answer→verify→refine loop

> **Consolidated:** the authoritative as-built spec is
> `2026-07-10-fabry-chat-console-design.md` (this Deep Verify feature is summarized
> there and that document governs on any conflict). This file is the detailed
> design/rationale companion.


**Date:** 2026-07-11
**Status:** Shipped (as-built; §3/§2 amended post-review — see notes below).
Consolidated summary lives in `2026-07-10-fabry-chat-console-design.md` §8.
**Surface:** the Fabry Chat Console app (`src/fabry/`), experimental-gated

**As-built amendments (final review + owner rounds):**
- `parseVerdict`: a `VERDICT: FAIL` with no actionable bullets is treated as
  `inconclusive` (no "0 unresolved issues" chip, no empty refine rounds).
- The literal "Investigating" phase chip was dropped — the initial answer
  shows the normal gerund loader; `deepPhase` covers verify/refine only.
- `liveTurn` is nulled the moment a main answer settles, so the critic phase
  never shows a phantom duplicate and Stop-during-critic cannot double-push
  (RED-verified regressions).
- The critic does NOT receive image attachments (deferred; vision claims
  typically verify as inconclusive).

## 1. Purpose & grounding

Owner ask: a minimalistic autonomous agentic loop — Fabry iterates and verifies
its own results, "new chat perhaps". Verified before designing (live probes,
2026-07-11, internal org):

- The Agent API **already runs an autonomous tool loop per message** —
  a single complex question executed 8 internal steps (`ChatSummary.
  total_steps`), many tool calls, ~119k tokens, and produced a correct deep
  answer. Every observed stream is *think → tools → answer*.
- It has **no independent self-verification**: 13 skills, none a critic;
  the `cautious` persona verifies WRITES only; "double-check" instructions
  run in the same context (self-agreement bias, prompt-following).
- Fresh-context verification demonstrably catches real errors in this repo
  (MDH verify-and-refine loop; the SDD adversarial reviews).

Conclusion: the valuable feature is **independent verification in a fresh
chat with optional auto-refine** — not more iteration.

## 2. UX

- **Composer toggle** "Deep verify" (chip next to the persona picker; visible
  in all chats, OFF by default, NOT persisted — a per-session cost decision).
  Tooltip: verifies each answer in a fresh chat and auto-fixes; roughly 2–3×
  tokens and latency per message (grounded in the 119k-token probe).
- While a deep turn runs, the live turn shows **phase chips** (tool-chip
  style): `Investigating` → `Verifying in a fresh chat` → `Refining 1/2` →
  (re-verify) …
- The final answer's footer carries a **verdict chip**:
  - `✓ Independently verified` (accent) — critic returned PASS;
  - `⚠ Reviewer found unresolved issues` (warning) — FAIL after the round
    cap; expandable strip lists the issues;
  - `Verification inconclusive` (muted) — critic errored/429/unparseable.
  Clicking the chip toggles a collapsible strip with the critic's full
  verdict text (rendered via FabryMarkdown).
- Intermediate turns stay visible (honest thread): the reviewer's critique
  goes to the main chat as a synthetic user message prefixed
  `[deep-verify reviewer]`, rendered as a system-style **chip turn** (the
  existing chip rule extends from `/`-prefix to this marker), both live and
  after reload (the server stores it as a plain user message).
- The critic chat is a real server chat and therefore appears in the sidebar
  (transparency; searchable). No special hiding.
- **Stop** aborts the whole loop at any phase; whatever completed stays.

## 3. Loop contract

Per send while deep mode is on (all in `src/fabry/deepLoop.js`, transport
injected):

1. **Answer**: normal main-chat turn (existing send/stream path).
2. **Verify**: `createChat()` (fresh, no shared context) → one message built
   by `buildCriticPrompt(question, answerText)`: instructs the critic to
   adversarially re-check every factual claim USING ITS TOOLS against the
   live org, stay read-only, and reply with first line `VERDICT: PASS` or
   `VERDICT: FAIL` followed by issue bullets. `parseVerdict(text)` is
   tolerant: scans for the first `VERDICT:` line anywhere; missing/other →
   `inconclusive`.
3. **Refine** (on FAIL, max **2** rounds): send to the MAIN chat:
   `[deep-verify reviewer] An independent review found these issues: <bullets>
   Please post a corrected answer.` → stream the corrected answer → verify
   again (each refined answer gets a fresh critic chat; every critic pass
   receives the ORIGINAL user question + the LATEST answer). After round 2
   the verdict stands as-is.
4. Attach `{verdict: 'pass'|'fail'|'inconclusive', issues: string[],
   criticText, criticChatId}` to the FINAL answer turn (in-memory only —
   nothing persisted client-side; the critic chat itself lives server-side).

Error taxonomy: critic 429/network/idle-timeout → `inconclusive`, never
retried automatically, never blocks the answer; abort → loop stops, `loadId`
guards stale writes (same machinery as `chat.js`); 401 anywhere → app-level
error as today.

Safety: the critic chat is primed `/persona cautious` with a read-only
framing in the prompt; refine messages are text-only, so the loop adds no
write pressure beyond the user's chosen persona in the main chat.

## 4. Settings kill switch (owner addition)

- New popup toggle in the **Experimental** section: "Fabry: allow deep-verify
  loops" — storage key `fabryDeepVerifyEnabled`, **default ON** (only a
  stored `false` disables; the `inspectAnnotationEnabled` precedent).
- The Console mirrors it live (same `chrome.storage.onChanged` pattern as
  `experimentalUnlocked`) into a `deepVerifyAllowed` signal in the Fabry
  store. When disabled: the composer toggle is not rendered, and an active
  `deepMode` is forced off (a running loop finishes its current phase, then
  refine/verify steps are skipped).
- Note: the whole Fabry app already sits behind `experimentalUnlocked`; this
  switch only governs the loop feature within it.

## 5. Code shape

- `src/fabry/deepLoop.js` — NEW, pure orchestration: `runDeepTurn({question,
  images, sendMainTurn, runCriticTurn, onPhase, maxRounds = 2})`; exports
  `buildCriticPrompt`, `parseVerdict`. Dependency-injected like
  `agentQuery.js`, unit-tested for pass/fail-refine-pass/fail-cap/
  inconclusive/abort paths.
- `src/fabry/store.js` — `deepMode` (session signal, default false),
  `deepVerifyAllowed` (mirrors storage, default true), `deepPhase`
  (`null | {phase: 'verify'|'refine', round}`) for the chips.
- `src/fabry/chat.js` — `sendMessage` routes through the deep loop when
  `deepMode && deepVerifyAllowed`; existing single-turn path unchanged
  otherwise. Verdict attach + phase signal writes live here (store side
  effects stay out of deepLoop).
- `src/fabry/thread.js` — the chip concept splits into DISPLAY vs INDEXING:
  command turns (`/`-prefixed) are chips AND excluded from
  `serverMessageIndex` (the server strips them from history); reviewer turns
  (`[deep-verify` prefix) are chips for DISPLAY ONLY — the server stores them
  as plain user messages, so they MUST stay counted in `serverMessageIndex`
  (otherwise feedback lands on the wrong turn). Concretely: `Turn.chip`
  stays the display flag; a new `Turn.command` flag drives the index
  exclusion (command implies chip; reviewer chips have `command: false`).
  The ack-after-chip exclusion keys on `command`, not `chip`.
- `src/fabry/components/Composer.jsx` — the toggle chip; `AssistantTurn.jsx`
  — verdict chip + collapsible strip; `Thread.jsx` — phase chips on the live
  turn (from `deepPhase`).
- Popup — one checkbox in the Experimental section wired to
  `fabryDeepVerifyEnabled`.
- CSS — `.fabry-deep-*` (toggle chip, verdict chips, strip) on the blue
  scheme tokens.

## 6. Testing

- `deepLoop` unit tests (mock transports): PASS first try; FAIL → refine →
  PASS; FAIL ×3 → cap with issues surfaced; critic error → inconclusive;
  abort mid-verify; round counter in onPhase calls.
- `parseVerdict` golden tests (first-line, buried line, missing, lowercase).
- Component tests: toggle renders only when allowed; kill switch forces
  deepMode off; verdict chip states + strip expand; reviewer chip rendering
  (live + normalized-from-server); feedback indexing unaffected by the
  reviewer chip.
- Live verification gates: critic actually uses tools in the fresh chat
  (event stream shows tool calls); a seeded-wrong answer gets caught
  (ask Fabry to answer, then verify — needs a question where the critic can
  find the truth); 429 path if reproducible.

## 7. Out of scope

- Persisting deep-mode or any verification content client-side.
- Hiding critic chats from the sidebar (server owns the list).
- Server-side critic (tracked as the better long-term home — an agent-team
  ask).
- Parallel multi-critic panels (SDD-style) — v1 is one critic per round.
