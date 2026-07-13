# Fabry Architect — Chat/Architect mode switch + SOW-spec checks

**Date:** 2026-07-13
**Status:** As-built (implemented + reviewed; §4–§9 describe the shipped design,
consolidated across all iteration rounds)
**Surface:** the Fabry Chat Console app (`src/fabry/`), experimental-gated
(no new gate — Architect lives inside the already-`experimentalUnlocked` app)

## 1. Purpose

Add a Claude-Desktop-style mode switch **[Chat | Architect]** inside the Mr.
Fabry app. **Chat** is the existing chat app, unchanged. **Architect** is a new
sub-app where a solution architect keeps the engagement's **SOW requirements**
(natural-language statements the customer's Rossum implementation must satisfy)
and runs a read-only **check** of each requirement against the live org via Mr.
Fabry. Internal-org dogfood only, same as the rest of the Fabry app.

## 2. Decisions (owner-approved 2026-07-13)

1. A **spec = a natural-language requirement**; **Run** hands each to Mr. Fabry
   (read-only agent) to verify against the live org and reports
   PASS / FAIL / UNCERTAIN with evidence.
2. **One requirement list per org** (the org's implicit SOW) — not multiple
   named SOWs (deferred).
3. Requirements are **hand-written** (add / edit / delete); Mr.-Fabry drafting
   or importing from a pasted SOW is deferred.
4. Stored in a **special system collection in MDH** (Data Storage).

## 3. Verified grounding (codebase; live blocked by a logged-out session)

- The Fabry app is a sidebar + `.fabry-main` pane (`components/App.jsx`); a mode
  swap replaces the main content and the sidebar body.
- MDH's Data Storage client `src/mdh/api.js` is **already initialized at Console
  boot** (`mdhApi.init(domain, token)` in `src/console/index.jsx`) and exposes
  `createCollection`, `find`, `insertOne`, `updateOne`, `deleteOne`,
  `dropCollection`, `getOrgId`, etc. Data Storage collections are **org-scoped
  by the token**. (The whole MDH app is the living proof ordinary collection
  create/insert/find works; a live re-probe returned 401 only because the Work
  Chrome profile's elis session is currently logged out — environmental, not a
  feasibility question.)
- **`__`-prefixed collection name — verification status:** the **client imposes
  no restriction** (`createCollection`, api.js:145, POSTs the name verbatim; no
  validation anywhere in the path) and the **MDH app makes no prefix assumption
  that would break** (collection lists are only `localeCompare`-sorted and
  displayed — no `system.`-style reservation, no prefix hide/exclude filter; a
  `__`-named collection lists and browses like any other). `__`-prefixed
  identifiers already round-trip in Data Storage at the field level
  (`__digest_md5`, importFile.js:219). The DocumentDB backend reserves only the
  `system.` prefix / `$` / null, so `__mrfabry_architect` is a legal name — but
  a **live server-side create of a `__` collection is not yet confirmed** (token
  expired). This is de-risked below (§7): the name is a single cosmetic constant,
  swappable to an unprefixed name with no other change, and its acceptance is a
  pre-ship live gate (§8).
- The Agent API (Mr. Fabry) reads the org read-only (queues/hooks/rules/schema/
  annotations) via its tools; a fresh-chat, cautious-primed check is exactly the
  pattern `deepLoop.js` already uses for the deep-verify critic, and our chats
  default to read-only server-side (backend cross-check,
  `2026-07-10-fabry-chat-console-design.md` §10).
## As-built note (consolidated 2026-07-13)

§1–§3 record the original brief/decisions/grounding. §4–§9 below are the
**shipped design**, consolidated across all iteration rounds (v1 → v2 →
several owner design refinements). The engagement's SOW items are called
**deliverables** (Markdown documents); the term "requirement" survives only in
the Data Storage doc's `kind` field for back-compat.

## 4. Architecture

A `[Chat | Architect]` segmented switch inside the Mr. Fabry app swaps the
`.fabry-main` pane and the sidebar body via a per-tab `fabryMode` signal. Chat
mode is unchanged in behavior. Architect (`src/fabry/architect/`) manages one
per-org list of deliverables in a Data Storage system collection.

- `store.js` — signals `deliverables` (`{id,text,order}[]`), `activeId` (open
  deliverable; per-tab, persisted so it survives a refresh — see wiring),
  `loaded`, `loadError`, `running`, `results` (`{[id]: Result}`); helpers
  `setResult`/`clearResults`/`setActive`. `Result = {verdict:'pass'|'fail'|
  'uncertain'|null, evidence, chatId, ranAt, running?, error?, stale?}`.
- `api.js` — Data Storage wrapper bound to `COLLECTION='__mrfabry_architect'`
  (a single cosmetic constant; no code parses the `__` prefix — swappable):
  `ensureCollection`, `loadDeliverables()→{deliverables,results}` (persisted
  `last*`/`ranAt` become a `stale:true` result), `addDeliverable`,
  `updateDeliverable(id,text,editedAt)`, `deleteDeliverable`, `setOrder(id,order)`,
  `saveResult(id,{verdict,evidence,chatId,ranAt})`. Doc:
  `{_id, kind:'requirement', text /*markdown*/, order, createdAt, editedAt,
  lastVerdict, lastEvidence, lastChatId, ranAt}`.
- `check.js` (pure) — `buildCheckPrompt(text)` (read-only framing +
  `VERDICT: PASS|FAIL|UNCERTAIN` contract) and `parseCheckVerdict(text)`.
- `run.js` (pure) — `runChecks(reqs,{runOne,onResult,concurrency=3,signal})`:
  bounded, abort-aware, error-isolating.
- `actions.js` — impure glue (mirrors `chat.js`): `loadArchitect` (in-flight
  guard; on first open with no active selection, selects the first deliverable),
  `addDeliverable`/`openDeliverable`/`updateDeliverable` (marks stale +
  `editedAt`)/`deleteDeliverable`, `runAll`/`reRun` (fresh cautious read-only
  chat per deliverable → parse verdict → persist via `saveResult`, clear stale;
  monotonic `runId` guard; transient transport errors are memory-only and never
  clobber the doc's last-known-good verdict), `stopRun`, `reorder` (pure) +
  `moveDeliverable`.
- `format.js` (pure) — `deliverableTitle`, `relativeTime`, `summaryLine`.
- `components/` — `MarkdownEditor.jsx` (CodeMirror + `@codemirror/lang-markdown`,
  theme-aware, 12px), `ArchitectSidebar.jsx` (the deliverable list, rendered by
  `Sidebar.jsx` in Architect mode), `DeliverableEditor.jsx` (open-deliverable
  pane), `ArchitectApp.jsx` (editor-or-placeholder; mounts `loadArchitect`).
- **Shared modal** — the MDH modal system was extracted to `src/ui/Modal.jsx`
  (`Modal` + `confirmModal`/`closeModal`/`openModal`/`promptModal`/`setModalTitle`
  + the `modalContent` signal). MDH re-exports it (all its call sites unchanged);
  Fabry `App.jsx` mounts one `<Modal/>`; Architect delete uses `confirmModal`.

Staleness (deterministic, cross-session): a result is stale when `!ranAt` OR
`editedAt > ranAt` OR it was loaded from storage (not produced by a run this
session). A run clears stale + sets `ranAt`; editing sets stale.

## 5. Run / check flow (read-only)

`Run all ▷` (sidebar footer) and per-row `Re-run` (kebab menu) build a `runOne`
`chat.js`-style: `createChat()` → prime `/persona cautious` → send
`buildCheckPrompt(text)` → fold the stream → `parseCheckVerdict`. Each check is
its own fresh chat. Results stream into `results[id]` (running → verdict), then
persist onto the deliverable's own doc (`saveResult`) and clear stale. Read-only
posture: cautious persona + read-only prompt framing + the server-side read-only
default (no `mcp_mode` ever sent). Errors → uncertain (memory-only, never
overwriting a good persisted verdict); the `runId` guard stops a stale run from
clobbering a fresh one. Each check is a real server chat (appears in the Chat
list); "view investigation" opens it. One Run of N deliverables creates N chats
(accepted; filtering deferred).

## 6. UI

- **Switcher (S1):** a segmented pill under the ✦ brand; the inactive tab is
  full-contrast so it never disappears against the track.
- **Sidebar (Architect mode):** the deliverable **list** (`ArchitectSidebar`),
  each row = an inline status dot (✓ met / ✗ not met / ? uncertain / ring
  spinner / hollow = outdated) + title + a **⋮ kebab menu** (Re-run [disabled
  while running] + Delete → shared confirm modal). Rows **drag-reorder**
  (direction-aware drop indicator; order persisted). A **bottom panel (B2)**:
  full-width **Run all ▷ / Stop** (fixed width — no jump), a results **summary**
  ("N deliverables · X met · Y not met", counts scoped to the current list), and
  **＋ New deliverable**.
- **Seamless blend (both modes):** the sidebar has no right divider; the content
  pane is a `--bg-card` card; the active row uses `--bg-card` and runs flush into
  the pane (chat list + deliverable list both break out of the right padding and
  hide their scrollbar). The sidebar **collapse toggle was removed** (always
  expanded; drag-resize kept).
- **Deliverable editor (`DeliverableEditor`):** a **verdict banner (V1)** pinned
  at the top — semantic-tinted (pass/fail/uncertain), collapsible with an obvious
  **"Show evidence ▾ / Hide ▴"**; collapsed it still shows the fresh one-line
  summary or, when stale, the **"last checked {when} · may be outdated — re-run"**
  note; expanding shows the full evidence (via `FabryMarkdown`) + "by Mr. Fabry"
  + "view investigation", and the **whole right side scrolls** (no inner cap).
  Below: a **split** — CodeMirror **Markdown source** (left) | live **rendered
  preview** (right), both at 12px. A separate "Checking…" banner while running.
  When nothing is open → a placeholder.
- Blue scheme; `.fabry-arch-*` / `.fabry-mode-*` in `console.css`; verdict/dot
  colors reuse `--success`/`--danger`/`--warning`; the confirm dialog is the
  shared `.modal-*` styling.

## 7. Storage & safety

- **Read-only Run** against the customer's org (cautious persona + read-only
  framing + server-side default). Architect's ONLY writes are to its own
  `__mrfabry_architect` collection (deliverable content + last-run results +
  order). Verified in the bundle: `grep mcp_mode dist/console/console.js` == 0.
- **Nothing extra at rest in the browser.** Deliverable content AND last-run
  results live server-side per-org on the Data Storage docs. Browser-persisted
  Architect state is only the per-tab, content-free `fabryMode` and
  `fabryArchitectActive` (which deliverable is open) via `console/tabState.js`.
- Collection name is a single cosmetic constant (swappable if the server ever
  rejects the `__` prefix).
- Backward compatibility: Chat mode behavior unchanged (only surface/blend
  styling); v1-shape docs (no `last*`/`editedAt`) load fine; no existing storage
  key changes meaning; whole feature stays behind `experimentalUnlocked`. The
  extracted modal is a pure refactor (MDH re-exports; one modal system).

## 8. Testing

- Pure: `check` (prompt + verdict parse), `run.runChecks` (all-pass/mixed/
  error→uncertain/abort/concurrency/streaming), `format` (title/relativeTime/
  summaryLine), `reorder`.
- `api.js` (mdh mocked): load→{deliverables,results}+stale, add/update(editedAt)/
  delete/saveResult/setOrder shapes.
- `actions.js` (agent+api mocked): stale load, first-open-select + preserve
  restored id, add/open/update(stale)/delete, runAll/reRun persist + clear stale,
  read-only (no write flag), runId guard, error-not-persisted, reorder/move,
  double-load guard.
- `MarkdownEditor` (real CodeMirror in jsdom); components (jsdom + `act()`):
  switcher/pane swap + chat-mode intact; sidebar list + status dots + summary
  (incl. orphan-scoping) + Run-all/Stop + New + drag-reorder + kebab (Re-run,
  Delete→shared modal) + keyboard-guard; DeliverableEditor V1 banner (collapsed
  stale note, expand→evidence, view-investigation), split source|preview, live
  preview; tabState `fabryMode`/`fabryArchitectActive`. MDH modal tests stay
  green through the re-export.
- Full existing Fabry + MDH suites stay green.
- **Live gate (elis, pre-non-dogfood):** confirm the server accepts creating +
  writing the `__mrfabry_architect` collection (client + MDH app verified clean;
  DocumentDB reserves only `system.`); if the name is rejected, swap the
  `COLLECTION` constant.

## 9. Out of scope

Multiple named SOWs; Mr.-Fabry-drafted/imported deliverables; a rendered preview
that is itself editable; exporting a check report; writing fixes (Run is
read-only); scheduled/automatic checks; sharing beyond the shared per-org
collection; surfacing the system collection specially in the MDH app; filtering
architect check-chats out of the Chat-mode sidebar.
