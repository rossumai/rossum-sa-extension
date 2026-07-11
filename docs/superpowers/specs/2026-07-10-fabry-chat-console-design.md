# Fabry Chat — a Claude-style Mr. Fabry interface in the Console

**Date:** 2026-07-10, consolidated to AS-BUILT 2026-07-11
**Status:** Shipped (experimental-gated). This document reflects the final
implemented state after the 2026-07-11 iteration rounds (design rounds 1–6,
response rendering, Deep Verify). The companion
`2026-07-11-fabry-deep-verify-design.md` holds the Deep Verify design
rationale; its behavior summary here is authoritative where they differ.
**Gate:** `experimentalUnlocked` (5 quick clicks on the popup version hash)

## 1. Purpose

A fifth Console app: a full conversational interface for Mr. Fabry (the Rossum
Agent API). Two jobs, weighted equally: a general org assistant for SAs, and a
dogfood/debug surface for the agent (reasoning, tool activity, per-turn
feedback, token counts as first-class UI). Internal-org dogfood only: the
agent's server-side write tools have no server-side write-lock — that remains
the ship-blocker for anything beyond dogfood.

## 2. Verified platform facts (live, 2026-07-10/11)

- Agent API (rossum-agent-api.tools.rossum.cloud, dev 2.2.0dev0), auth
  `X-Rossum-Token` + `X-Rossum-Api-Url`:
  `POST /chats`; `GET /chats?limit&offset` → `{chats: ChatSummary[], total}`
  (`ChatSummary = {chat_id, timestamp(SECONDS), message_count, first_message,
  preview?, summary?, total_*_tokens, total_steps}`); `GET /chats/{id}` →
  `{messages, created_at, files}` (`Message.content` = string or
  Text/Image parts, `Message.feedback`); `PUT /chats/{id}/feedback`
  `{turn_index, is_positive}`; `GET /chats/{id}/files/{filename}` (auth);
  `GET /commands` (unauthenticated; personas `default`→shown as
  "Autonomous", `cautious`); `POST /chats/{id}/messages` = AI-SDK SSE stream,
  429 documented; images sent as top-level `{content, images:[{media_type,
  data}]}`.
- **Feedback `turn_index` = raw index into `ChatDetail.messages`**
  (per-message storage, probe-verified). The server **strips `/`-command
  turns and their acks** from history but **stores plain user messages**
  (incl. Deep Verify's reviewer messages) — hence the client's
  `Turn.chip` (display) vs `Turn.command` (index exclusion) split in
  `thread.js serverMessageIndex`.
- **Client abort stops server-side generation** (user message persists, no
  reply is stored). Chat list is per user+org (single-org verified).
- The agent runs an autonomous per-message TOOL loop server-side (8 steps
  observed on one hard question, ~119k tokens) but has NO independent
  self-verification (13 skills, none a critic; cautious persona verifies
  writes only) — the gap Deep Verify (§8) fills.
- No rename/delete chat endpoints. Titles: server-generated `summary` (its
  summarizer sometimes misfires on machine chats) → `preview` →
  `first_message`; client sanitizes markdown junk for display
  (`format.js sanitizeTitle`).

## 3. Architecture

- `src/agent/agentApi.js` + `agentStream.js` — shared transport (moved from
  `src/mdh/agent/`; `agentQuery.js`/`aiContext.js` stay MDH-specific), plus
  `listChats/getChat/submitFeedback/listCommands/downloadChatFile` and the
  `images` option on `streamMessage`.
- `src/fabry/` — the app: `store.js` (signals), `chat.js` (orchestration:
  one module-level AbortController + monotonic `loadId`; every await is
  stale-guarded; `finally` resets only when still owner), `thread.js`
  (server Message → Turn view model; `serverMessageIndex`), `format.js`
  (`tsToMs` [seconds heuristic], `relativeTime`, `sanitizeTitle`,
  `chatTitle`), `search.js` (sidebar filter + highlight segments),
  `personas.js` (display names for wire values), `starters.js` (greeting
  prompts), `deepLoop.js` (§8), `mermaidEntry.js` (lazy bundle entry),
  `components/` (App, Sidebar, Thread, AssistantTurn, Composer, CommandMenu,
  ChatHeader, FilesStrip).
- `src/ui/fabry/` — shared rendering: `markdown.js` + `FabryMarkdown.jsx`
  (hand-rolled subset → vnodes, XSS-inert by construction, http(s)-only
  links w/ balanced-paren href scan, streaming-tolerant), `highlight.js`
  (hand-rolled tokenizer → `.hl-*` vnode spans; python/json/js/bash/sql),
  `MermaidBlock.jsx` + `mermaidLoader.js` (§7).
- Server owns ALL chat content; client persists only: per-tab
  `fabryActiveChat` (chat id), global prefs `fabrySidebarOpen`/
  `fabrySidebarWidth`, and the popup keys `experimentalUnlocked`/
  `fabryDeepVerifyEnabled`. No chat content, images, transcripts, or
  verification output at rest.

## 4. Shell integration & gating

Rail entry `fabry` ("Fabry", ✦ icon, **beta badge** like Inspector/Galaxy —
owner choice; the `exp` flag only gates). Gate consumers: Rail APPS filter,
`pickInitialApp({…, fabryUnlocked})`, and a live `chrome.storage.onChanged`
effect (`activeApp.peek()`) that kicks an active Fabry back to MDH on
re-lock. Older builds fall back via `isValidApp`. Lazy `initFabry()` (probe →
commands → chat list → per-tab chat restore). **Re-activation refresh:**
switching Console apps remounts the Fabry component; a mount effect reloads
the chat list (skipped on first boot while the probe is pending — `initFabry`
owns the initial load). Agent offline → terminal offline state (Inspector
precedent, no retry button).

## 5. UI (final after design rounds 1–6)

- **Look:** V1 "Refined Flat" + gradient ✦ band header; the whole Fabry
  chrome uses the console's BLUE scheme (`--accent`/`--info-*`; the earlier
  purple `--diag-*` was replaced — syntax-token colors keep their own
  palette).
- **Layout/scroll:** `.fabry-main` is THE scroll region (page-level
  scrollbar at the pane edge); ✦ band sticky top; composer sticky bottom;
  content centered at 860px; NO horizontal page scroll — wide tables/code/
  diagrams scroll inside their own frames; thin themed scrollbars.
- **Sidebar (F1 "Search-first"):** collapsible (`«`/`»`, 52px icon rail) and
  drag-resizable (200–420px, persisted); ghost "＋ New chat"; pinned search
  filtering loaded chats live with `<mark>` highlights, Esc/× clears,
  "N of M loaded chats match" status; flat recency list (no date groups),
  two-line rows (sanitized title + relative time), soft `--info-bg` active
  fill; **infinite scroll** (no Load more button; near-bottom auto-loads,
  quiet loading row); scrollbar thumb invisible until list hover.
- **Header band:** ✦ mark, sanitized title, persona pill (only when set this
  session — the server strips persona turns from history), quiet token
  total.
- **Thread:** user turns as right-tinted blocks (images inline); `/`-command
  and `[deep-verify` reviewer turns render as system-style chips; assistant
  turns = collapsible Thinking strip (open while streaming) → ordered
  tool-label chips → streaming markdown → footer (👍/👎 via raw-index
  feedback, Copy, Deep-Verify verdict chip §8). Interrupted turns show
  "Refresh from server". Pin-to-bottom scrolls the main pane only when
  near-bottom. New-chat greeting: ✦ + title + 4 Rossum-specific **starter
  prompt cards** (`starters.js` — org map / extension health / stuck
  documents / queue deep-dive; deliberately NO audit-log starter — the agent
  has no audit tool) that send on click.
- **Composer:** single-row pill (autogrow ≤180px, Enter sends /
  Shift+Enter newline), image attach via button/paste/drop (≤4, ≤5MB,
  png/jpeg/gif/webp), `/` command autocomplete from `GET /commands`,
  solid-accent Send ⇄ Stop. **While streaming, the input stays enabled for
  drafting the next message** ("Prepare your next message…"; Enter is a
  no-op until done) and the gerund verbs render in the SAME row as the Deep
  verify toggle (verbs left, toggle right). Persona picker
  (Cautious | Autonomous segmented + hint) only on new chats, hidden while
  streaming. Standing notice: Fabry can read the org and, as Autonomous, act
  on it; Cautious asks before every write.
- **Files strip** above the composer when `ChatDetail.files` is non-empty
  (authenticated blob download).

## 6. Send / errors

Send: lazy `createChat` → optional `/persona cautious` priming turn (visible
chip + ack) → streamed turn folded into `liveTurn` → sidebar refresh.
Open chat: abort in-flight, render server history. Errors: 401 → app banner;
429 → inline note (draft preserved); stream idle-timeout/Stop → interrupted
turn + refresh affordance; sidebar/commands failures degrade silently.

## 7. Response rendering (round 4: R1 "Aligned")

Heading scale for the parser's h3–h6 (16.5/14.5/13/12), indented lists,
framed tables (header row, row separators, tabular-nums), `--bg-code` blocks
with a language tag, hr rule, 8px block rhythm. **Syntax highlighting:**
hand-rolled tokenizer (`highlight.js`) → vnode spans on semantic color
tokens. **Mermaid:** `beautiful-mermaid` (the one added dependency) —
synchronous `renderMermaidSVG` themed live from console tokens (`bg` =
`--bg-base`: the SVG has no background rect, diagrams sit on the page;
`surface` = `--bg-card` node fill); label text is escaped by the library
(probe-verified); parsed via DOMParser text/html (no innerHTML sinks);
invalid → code-fence fallback; render gated on stream completion. The
package is one flat ~1.5MB module, so it ships as its own lazy bundle
(`dist/console/mermaid.js`, script-injected on first mermaid fence —
importing it directly doubles console.js).

## 8. Deep Verify (2026-07-11 addition; detail spec: `2026-07-11-fabry-deep-verify-design.md`)

Composer toggle (session-only, never persisted) routes each send through
`deepLoop.js`: main-chat answer → **fresh-chat critic** (ALWAYS primed
`/persona cautious` + read-only framing regardless of the main chat's
persona; `VERDICT: PASS|FAIL` contract (first matching line anywhere); a FAIL with no actionable
bullets is treated as **inconclusive**) → on FAIL a `[deep-verify reviewer]`
message returns to the main chat (≤2 refine rounds; each critic pass gets the
ORIGINAL question + LATEST answer). Final answer carries a verdict chip
(✓ verified / ⚠ N unresolved issues / inconclusive) with an expandable
critic strip. Phase chip in the thread while verifying/refining ("Verifying
in a fresh chat…", "Refining n/2…"; the initial answer shows the normal
loader — the spec's literal "Investigating" chip was consciously dropped).
Critic errors (429/network) → inconclusive, never auto-retried; Stop aborts
the whole loop cleanly (the settled answer stays; `liveTurn` is nulled the
moment an answer settles, so no phantom/duplicate turns). Kill switch:
`fabryDeepVerifyEnabled` (popup Experimental toggle, DEFAULT ON — only a
stored `false` disables; mirrored live; forces the toggle off/hidden).
Known limitation: the critic doesn't receive image attachments (vision
claims typically come back inconclusive).

## 9. Testing & verification

~120 Fabry-related tests across transport, pure modules (markdown/highlight/
deepLoop/thread/format/search), components (jsdom, h(), flush(); three files
override the suite's no-op rAF polyfill to flush effects), incl. RED-verified
concurrency regressions (stale-guard chat switch; Stop-during-critic).
Live-verified on the internal org repeatedly (agent-browser recipe):
streaming/tools/markdown/diagrams, feedback placement re-checked server-side
after the indexing fix, abort semantics, gate & kill-switch live flips,
deep-verify full loop, infinite scroll, alignment metrics.

## 10. Out of scope / deferred

Chat rename/delete (no API); hiding critic chats from the sidebar; server-side
critic; multi-critic panels; critic image pass-through; signal-aware critic
`createChat` (Stop during creation can orphan an empty server chat); origin
tags for machine chats (F2 concept — deliberately not built with F1);
persisted drafts; the standing server-side write-lock work.
