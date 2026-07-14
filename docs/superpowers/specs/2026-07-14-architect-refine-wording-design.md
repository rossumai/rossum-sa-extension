# Architect — "Refine wording" with Mr. Fabry (iterative, instruction-driven) — design

**Date:** 2026-07-14
**Status:** approved (all decisions confirmed in brainstorming)
**Revision v2 (2026-07-14):** the refine UI moved from a shared Modal to a **docked
inline bar** ("Proposal A", owner-chosen from 3 browser mockups) built on the
design-system **AI input** (`FabryInput`). The core (iterative `refineTurn`, cumulative
diff, Accept-to-write, read-only) is unchanged. Sections below describe v2.

**Revision v3 (2026-07-14):** a refine turn now handles the agent's **interactive
elements**. A turn returns EITHER a proposal OR `questions` (the `ask_user_question`
tool); questions render inline via the shared `FabryQuestions` and are answered in the
SAME chat (`answerRefine` → `formatAnswers`), which may yield the proposal or another
round. Also **guards a destructive Accept**: an empty (or question-only) reply is never
shown as a diff and cannot be accepted — it shows an honest note instead of blanking the
deliverable.

## Goal

Give each Architect deliverable a "Refine wording" action: the user tells Mr. Fabry
**how** to refine the requirement Markdown (in their own words), Fabry returns a full
revised version, and the user reviews a **clear word-level diff** and must **approve**
before anything is written. The user drives the wording — Fabry never changes the
requirement autonomously.

## Decisions (owner-confirmed)

- **User-driven, iterative:** the user provides **instructions** to Fabry rather than
  having the specification changed automatically. Each instruction produces a new
  proposal; more instructions build on the last one (same chat), so the user converges
  on the wording they want.
- **Scope:** wording — improve grammar/clarity/structure and follow the instruction,
  but **preserve meaning, intent, names, fields, queues, thresholds, numbers** beyond
  what an instruction (or an obvious typo) explicitly changes.
- **Org access:** org-grounded, **read-only** — Fabry MAY inspect the live org to get
  names/identifiers accurate (same read-only stance as the check).
- **Affordance (v2):** a **docked inline bar** at the bottom of the open deliverable
  pane — no modal. Built on the design-system **AI input** (`FabryInput`, `size="sm"`):
  ✦ spark, gradient focus ring, gerund loader. Always present (the bar IS the
  affordance); mirrors the inline-Fabry pattern already used in Chat and Inspector.
- **Diff:** word-level inline, **cumulative** (original deliverable → Fabry's latest
  proposal), so the user always sees the total change they're about to accept.

## Flow (v2 — docked bar)

1. A docked bar (`.fabry-arch-dock`, `position: sticky; bottom: 0`) sits at the bottom
   of the deliverable pane. Its `FabryInput` is **disabled when the deliverable is
   empty** (placeholder tells the user to add text first).
2. The user types an instruction and presses Enter → `send()` calls
   `refineTurn({ chatId, deliverableText, instruction, signal })` (actions.js). First
   turn: fresh `createChat()` → prime `/persona cautious` → `buildRefineFirst(text,
   instruction)`. Follow-ups (before Accept/Discard): reuse the chat →
   `buildRefineNext(instruction)` (rules + prior proposals are in chat context), so
   Fabry builds on its last proposal. Returns `{ chatId, proposal }` or `null` if aborted.
   While busy the input shows the gerund loader.
3. A turn returns EITHER a proposal OR **questions** (interactive elements). When a
   **proposal** exists (and is non-empty and differs), a **diff card**
   (`.fabry-arch-refine-card`) rises **above the bar** with the cumulative
   `<DiffView before={deliverable.text} after={proposal}>`, "by Mr. Fabry", and
   **Discard** / **Accept changes**. When the agent asks **questions** instead, the card
   renders `<FabryQuestions>` (shared) + Discard (no Accept — nothing to accept yet);
   submitting answers → `answerRefine({ chatId, answers })` (a plain message to the same
   chat), which yields the proposal or a further round of questions. An **empty /
   question-only reply** is never shown as a diff and Accept stays disabled (honest note),
   so Accept can never blank the deliverable.
4. **Accept** (enabled only when the proposal differs) → `updateDeliverable(id,
   proposal)` (persists + marks the check result **stale**) then resets the bar; the new
   text becomes the base. `MarkdownEditor`'s value-sync effect updates CodeMirror (its
   dispatch fires `onChange`, keeping the debounce ref/preview consistent — no clobber).
   **Discard** → resets the session (aborts any in-flight turn, back to the original
   base). The bar stays put for the next instruction.
5. Session reset on deliverable switch is handled by **keying `RefineDock` on
   `deliverable.id`** (remount → fresh state; the unmount effect aborts the prior turn).
6. Errors (429 / offline / agent error) → inline `.fabry-arch-dock-err` line; abort →
   silently dropped. A same-wording reply → an inline "try another instruction" hint.

## New / changed pieces

- **`src/ui/textDiff.js`** (pure): `tokenize(s)` (words + whitespace runs) and
  `diffWords(a, b)` → `[{type:'same'|'add'|'del', text}]` via LCS over tokens
  (O(n·m); deliverables are short — coarse `del(a)+add(b)` fallback above a token cap).
- **`src/ui/DiffView.jsx` + `DiffView.module.css`** (design-system component): renders
  the segments — `same` plain, `add` as `<ins>` (success tint), `del` as `<del>`
  (danger tint, line-through), `white-space: pre-wrap`, monospace (it's Markdown source).
- **`src/ui/fabry/FabryInput.jsx`**: gains an optional `disabled` prop
  (`disabled={busy || disabled}`) — backward-compatible (defaults falsy); lets the dock
  disable itself for an empty deliverable.
- **`src/fabry/architect/refine.js`** (pure): `buildRefineFirst(text, instruction)`,
  `buildRefineNext(instruction)`, `parseRefinedText(reply)` (trim + unwrap one
  surrounding code fence). Rules: wording only + preserve meaning + read-only + "return
  ONLY the complete revised Markdown after each instruction, no fences/preamble".
- **`refineTurn({ chatId, deliverableText, instruction, signal })`** in `actions.js`
  (replaces the earlier one-shot `refineDeliverable`/`cancelRefine`); returns
  `{ chatId, proposal }` OR `{ chatId, questions }`. **`answerRefine({ chatId, answers,
  signal })`** (v3) sends the answers to the same chat via `chat.js formatAnswers` (no
  import cycle — chat.js doesn't depend on architect) and returns the same shape.
- **`src/fabry/architect/components/RefineDock.jsx`** (v2/v3, replaces `RefineDialog.jsx`):
  the docked inline bar — a `FabryInput` + hint, and a card that shows EITHER the diff
  (+ Accept/Discard) OR the shared `FabryQuestions` (+ Discard). Holds the session (chat
  id, proposal, questions, busy, error, `AbortController`); aborts on unmount. Guards the
  empty/question-only reply so Accept can't blank the deliverable.
- **`DeliverableEditor`**: the tools-row button is gone; it renders
  `<RefineDock key={deliverable.id} deliverable={deliverable} />` at the pane bottom.

## Backward compatibility / safety

- No storage changes; existing check/run/staleness untouched (Accept reuses
  `updateDeliverable`, which already marks the result stale).
- Read-only stance preserved (cautious persona + read-only framing; org-grounded but
  never writes to the org). The refine sends the deliverable's own text + the user's
  instruction to the same agent the check already uses — no new trust boundary.
- All prompts, examples, and tests use **generic Rossum content only** (no customer data).

## Testing

- `tests/ui-text-diff.test.js`: identical → all `same`; word change → `del`+`add`;
  `same`+`del` reconstructs `a`, `same`+`add` reconstructs `b`.
- `tests/ui-diff-view.test.js`: renders `<ins>`/`<del>` with the module classes.
- `tests/fabry-architect-refine.test.js`: `buildRefineFirst` carries preserve-meaning +
  read-only + return-only rules + the text + instruction; `buildRefineNext` is
  instruction-only; `parseRefinedText` strips fences.
- `tests/fabry-architect-actions.test.js`: `refineTurn` first turn opens a cautious chat
  and applies the first instruction; a follow-up reuses the chat (no re-setup).
- `tests/ui-fabry-input.test.js`: the `disabled` prop disables the input even when not
  busy (value still shown, no loader).
- `tests/fabry-architect-refine-dock.test.js`: renders the AI input (enabled with text,
  disabled when empty); an instruction shows the diff + enables Accept, Accept applies
  via `updateDeliverable`; a follow-up reuses the chat id; Discard clears the card and
  starts a fresh chat (no write); a turn's **questions render inline** (no diff/Accept)
  and answering calls `answerRefine` + shows the resulting diff; an **empty proposal** is
  never a diff and can't be accepted.
- `tests/fabry-architect-actions.test.js`: `refineTurn` surfaces `questions`;
  `answerRefine` sends the formatted answers to the same chat and returns a proposal (or
  a follow-up question).
- `tests/fabry-architect-app.test.js`: the docked bar renders inline (no modal) with its
  AI input enabled for a deliverable with text and disabled when empty; no agent call
  until an instruction is sent.
- Verified against the built `console.css`/`console.base.css` in the browser (docked bar
  stays pinned while the pane scrolls; diff card + Accept/Discard). Full suite green;
  rebuild `dist/`.
