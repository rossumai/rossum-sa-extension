# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that enhances Rossum UI, NetSuite UI, and Coupa UI for solution architects during onboarding. Published to Chrome Web Store. Community-supported, not an official Rossum product.

## Build System

Uses **esbuild** to bundle ES modules from `src/` into `dist/`. No other build tools or transpilation.

- `npm run build` — clean build into `dist/`
- `npm run dev` — watch mode (JS only; re-run build for CSS/HTML changes)
- `dist/` is the loadable Chrome extension (gitignored)
- `build.js` orchestrates bundling + static asset copying (manifest.json, icons/, popup HTML/CSS, console HTML/CSS, devtools HTML/CSS)

esbuild config: `format: 'iife'`, `minify: true`, `jsxFactory: 'h'`, `jsxFragment: 'Fragment'` (Preact JSX).

## Architecture

Nine esbuild entry points, plus two bundles that are never imported by `console.js` and are
script-injected on demand instead — `console/mermaid` (`src/fabry/mermaidEntry.js`, the ~1.5MB
diagram renderer) and `console/doc-print` (`src/docs/printEntry.js`, the print page's own script):

1. **`src/rossum/index.js`** → content script for Rossum pages
2. **`src/netsuite/index.js`** → content script for NetSuite pages
3. **`src/coupa/index.js`** → content script for Coupa pages
4. **`src/popup/popup.jsx`** → extension popup UI (Preact)
5. **`src/console/index.jsx`** → unified Console page (`console/console.html`, opened via `chrome.tabs.create`) — a left app-switcher rail over six apps: Dataset Management (`src/mdh/`), Audit Log Viewer (`src/audit/`), Galaxy (`src/galaxy/`, a 3D org birdview), Inspector (`src/inspector/`), Fabry Chat (`src/fabry/`), and Academy (`src/academy/`, the onboarding training track, the one app gated behind `experimentalUnlocked`)
6. **`src/background/index.js`** → MV3 service worker (`background.js`)
7. **`src/devtools/devtools.js`** → Chrome DevTools registrar (`devtools.html`, creates the "Rossum" panel + forwards `panel.onSearch` to CodeMirror)
8. **`src/devtools/panel.jsx`** → DevTools panel page (`panel.html`)
9. **`src/sidepanel/index.jsx`** → Chrome side panel (`sidepanel/sidepanel.html`, manifest `side_panel.default_path`) hosting the popup's MDH provenance card

The background service worker has three jobs. Job three is **side-panel scoping**
(`syncSidePanelTabs` + a `tabs.onUpdated` listener, see the Side panel section) — it needs a
context that outlives every page, since the decision must be re-made whenever any tab
navigates, with no panel and no popup open. Job one: a content script can't
`chrome.tabs.create` an extension page, so the `dataset-mgmt-suggest` feature
messages the worker (`{ type: 'openDatasetManagement', token, domain }`) and the
worker stages `consoleAuth_<uuid>` (with `app: 'mdh'`) + opens `console/console.html`
— letting us open the Dataset Management from the legacy MDH web app without
`web_accessible_resources`. Job two is being the only sender of opt-in usage counts.
Otherwise the extension is purely content scripts + popup + side panel + opened pages.

### Rossum content script

Reads chrome.storage.local settings, builds a handler array from enabled features, creates a single MutationObserver that walks added subtrees. Feature modules in `src/rossum/features/` each export:
- `init()` (optional) — inject CSS, set up listeners (called once)
- `handleNode(node)` — called for every added DOM element; must be fast (no-op when irrelevant)

To add a new feature: create a module in `features/`, add its storage key to `SETTINGS_KEYS` in `index.js`, wire up `init()`/`handleNode()` in the conditional block, and add a toggle checkbox in `popup.html`/`popup.js`.

### Dataset Management (MDH)

A Preact SPA (`src/mdh/`) for managing Rossum Data Storage collections:

- **`store.js`** — Preact signals for global state: `domain`, `token`, `collections`, `selectedCollection`, `records`, `skip`, `limit`, `activePanel`, `loading`, `error`, `modalContent`
- **`api.js`** — REST client wrapping the Data Storage API (30+ methods: CRUD, aggregation, indexes, search indexes, bulk operations). 30-second timeout via AbortController. 401 → "Session expired".
- **`cache.js`** — LRU cache with 60-second TTL, max 200 entries. Field-level granularity (keyed by collection + field). Supports pinning to exempt active collection from TTL. `invalidateData()` clears query results but preserves index caches.
- **`prefetch.js`** — background preloading: prioritizes active collection/panel, then batches other collections (5 per batch, 200ms delay). Uses AbortController to cancel on selection change.
- **`downloadCollection.js`** — streamed JSON export. Sliding-window worker pool (default 10 workers, 1000-record batches) — each worker pulls the next offset from a shared counter and loops, so a slow batch never blocks the fetch pipeline; only writes wait for in-order predecessors. Buffer-room backpressure caps `pending.size` at `concurrency * 2` so a slow writer can't OOM. Prefers `showSaveFilePicker` so each batch streams to disk; falls back to a Blob built from per-batch string parts (never `JSON.stringify`-ing the full array, which would trip V8's max string length).
- **`hooks/`** — `usePipeline` (sort/filter state → MongoDB aggregation pipeline, placeholder substitution), `useQuery` (executes aggregations with stale-result cancellation via queryId counter), `usePagination` (skip/limit page tracking with cached total count), `useStageCounts` (per-active-stage cumulative `$count` + whole-collection `$collStats` input count with timing; shared by the Aggregate Pipeline Debug panel and the in-view Stages view so both report identical numbers and stay correct when stages are toggled)
- **`src/agent/agentApi.js` + `src/agent/agentStream.js` + `agent/agentQuery.js` + `components/AgentBox.jsx`** — the **drop-in** AI query box ("Mr. Fabry"), which replaced the retired `llmchat` NL→aggregation loop (`aiPipelineLoop.js`/`aiContext.js`/`AiRunTrace.jsx`, deleted). The shared transport (`agentApi.js`/`agentStream.js`) moved out of `src/mdh/agent/` to top-level **`src/agent/`** on 2026-07-11 — it is now imported by MDH, Inspector, Audit, and Fabry Chat; only `agent/agentQuery.js` (the verify-and-refine loop) and `agent/aiContext.js` (schema hints) stay MDH-specific in `src/mdh/agent/`. Engine = the standalone **Rossum Agent API** at `rossum-agent-api.tools.rossum.cloud` (host in `manifest.json` host_permissions) — `agentApi.js` wraps `init(domain, token)`, `probeAgent()` (`GET /health`, unauthenticated; gates `store.aiAvailable`), `createChat()` (`POST /chats`), `streamMessage(chatId, content, {onEvent, signal, images})` (`POST /chats/{id}/messages`, AI-SDK data-stream, `X-Rossum-Token`/`X-Rossum-Api-Url` headers, 90s idle-timeout abort; the optional `images` option sends a top-level `{content, images}` body only when non-empty), and — added for Fabry Chat — `listChats`, `getChat`, `submitFeedback`, `listCommands`, `downloadChatFile`. `agentStream.js` is pure: `createSseParser`/`foldEvents`/`replyText`/`extractPipeline` (accumulate `text-delta` + optional `data-final-answer`; extract a JSON-array pipeline from the reply, fenced/prose-tolerant, never clobbering a prose-only answer); it reuses `llmPipeline.js`'s trimmed pure helpers (`stripFences`/`safeParseArray`/`prependAiComment`/`stripAiComment`). The **verify-and-refine loop is client-side** in `agentQuery.js` (`runAgentQuery`): the agent GENERATES a JSON-only pipeline in a **fresh chat per submit** (primed `/persona cautious`; the prompt carries the CURRENT editor pipeline so follow-ups ITERATE on it, plus rules — ≤50-row `capRows`, no tools — and **data-driven schema hints** from `agent/aiContext.js` `getSchemaHints`: known distinct values, top values, numeric ranges, numeric-string fields, array paths, field types, and the collection's Atlas Search indexes [a cached `$facet` + `listSearchIndexes`], formatted by `schemaHintParts`). The CLIENT then VERIFIES two ways — **mechanically** (execution error / 0 rows via `api.aggregate`) and **semantically** (a second agent turn, `buildVerifyPrompt`/`parseVerdict`, judges whether the ACTUAL result rows answer the request; restored from the old loop) — and on any bad signal (error / empty / semantic mismatch) sends up to 2 correction turns. The final pipeline is applied to the editor **verbatim** (no `🤖 AI request` comment — the transcript modal carries that context). The AI input field **always starts a fresh chat**; `runAgentQuery` returns the `transcript` + the `chatId`. `AgentBox`'s "View transcript" link opens an **interactive** modal (`TranscriptModal`) showing each turn's full text + reasoning AND letting the user **continue the same chat** (`continueAgentQuery` reuses the `chatId`, no re-prime) to iterate on the resulting query — each continuation re-runs the verify-and-refine loop and re-applies the pipeline to the editor. No agent session state lives in `store.js` (only `aiAvailable`). **READ-ONLY is enforced client-side**: `agentQuery.screen()` + `pipelineOps.terminalWriteStage` mean a `$out`/`$merge` pipeline is NEVER executed or applied (note `blocked`), and an agent-emitted `[]` is `declined`; the cautious persona is defense-in-depth only — the agent's own compliance is not a hard server guarantee, so a backend write-lock remains a ship-blocker before non-dogfood use. `AgentBox` is a single input (no transcript, no result note) with an animated rainbow `.nl-search-loading` gerund loader while a query runs; it aborts + stale-guards on collection change and surfaces failures (couldn't-build / write-`blocked` / 401) on the global error banner. UI in `console.css`: `.agent-box`/`.nl-search-wrapper`/`.nl-search-loading`/`.agent-attribution` ("Powered by Mr. Fabry"), reusing `.nl-search-input`.
- **`overviewCharts.js`** — pure (DOM-free, unit-tested) layout/scale math for the Overview "Charts" panel: squarified treemap (`squarify`/`buildTreemap`, area = `storageSize`, top-N + aggregated "Other" tile), index-overhead color scale (`overheadColor` blue→teal→yellow on `totalIndexSize/storageSize`, plus `overheadTextColor` for luminance-adaptive tile text), and a `mode`-aware (linear/sqrt/log) `scaleArea` + `buildScatter` (docs×avg-size). Rendered by `components/OverviewCharts.jsx` (always-on panel above the table; a single scale toggle drives BOTH charts; coordinated treemap↔scatter hover) which `OverviewPanel` mounts — all from the stats already in memory, no extra API calls.
- **`components/`** — 28 JSX components. Modal system: `openModal(title, renderFn)`, `confirmModal(title, msg, onConfirm)`, `promptModal(title, opts, onSubmit)`. `StagesView.jsx` is the in-view full-pipeline debug view — a **third results-view mode** (`RecordList` renders it when the `resultsView` signal is `stages`, beside List/Table; the List/Table/Stages switch is a one-click segmented control `.view-seg`; also reached by clicking a stage row in the Aggregate Pipeline Debug panel, which sets the `inspectTarget` signal to scroll/highlight that stage). NOT a modal (an earlier modal iteration was replaced by this in-view view so the pipeline editor stays visible alongside — which is what enables the hover connector and cursor-follow). An options strip (`.pipeline-inspect-opts`) at the top — **Records per stage** (`10`/`25`/`50` segmented, default 10, `store.stagesSampleSize` → `mdhStagesSampleSize`; drives the per-stage/input `$limit` and re-fetches on change) and an **Auto-scroll** checkbox (default on, `store.stagesAutoscroll` → `mdhStagesAutoscroll`) — sits above a vertical list of stage sections. A section is **content-sized**; the one fixed dimension is the **records band** (`--stage-records-h`, 324px, on `.pipeline-inspect-body`), which is what makes the records the same size in every stage. A **Definitions** checkbox (default off, `store.stagesShowDef` → `mdhStagesShowDef`) shows each active stage's substituted definition (`JSON.stringify(entry.stage, null, 2)` in a `.pipeline-inspect-stagedef` block) — the concrete stage as sent to the DS API; that block **adds** its own height (its real height, capped at 160px and scrolling beyond) rather than subtracting from the records, so a section is 360px with no definition, ~427px with a 3-line one and 520px with a capped one. It was the reverse until 2026-08-11 — a flat `height: 360px` on the section, out of which a capped definition left a card just **108px** of JSON (measured in Chrome), which is the "records rendered very small" the owner reported. The 160px definition cap is therefore load-bearing in a new way: it now bounds how tall a section can GROW, not how much it steals. Each shows **full-width** sample output as side-by-side read-only `RecordCard`s (mouse-wheel scrolls the row horizontally via `horizontalWheelDelta`), **always expanded — not collapsible** (`RecordCard collapsible={false}` → no chevron, inert header, body always shown; the cards **stretch to fill** the records band even when the record is short, scrolling within the body when taller). The **SOURCE card** (formerly "stage 0 / input" — a MongoDB pipeline has NO stage zero) is deliberately a different class of object from the numbered stages: **dashed and unfilled** (`.pipeline-inspect-source`, legible before any word is read), **unnumbered** (labelled `source` + the collection's own name, so the list visibly starts at 1), and **collapsed by default** with a `.pipeline-inspect-start` divider beneath it ("pipeline starts here · N stages", or "2 of 3 stages run" when any is disabled so it can never disagree with the sections below; omitted for an empty pipeline). NOT dimmed with `opacity` the way `.pipeline-inspect-disabled` is — that means "did not run", the wrong idea entirely. Collapsing also SAVES ONE AGGREGATE per Stages open: the sample is fetched only while expanded, while the doc count still shows (that is the `$collStats` probe in `useStageCounts`, not the sample). The toggle is a real `<button>` with `aria-expanded`; state persists as `mdhStagesSourceOpen` (default false), wired like `mdhStagesShowDef`. A per-stage enable/disable checkbox (`onToggleStage`) toggles each active stage. The per-stage query box was removed: **hovering a stage** sets the `hoveredStage` signal, and `StageLinkOverlay.jsx` draws a **dashed** SVG connector (geometry in `stageLink.js`) from that section to the stage's code in the pipeline editor — plus a tinted band behind that stage's editor lines (`.cm-linked-stage`, `JsonEditor`'s `linkedStageField` + `editorRef.highlightStage(entryIndex|null)`, aggregate mode only), so BOTH ends of the link are marked: the hovered section already turns accent-bordered via `.pipeline-inspect-section:hover`. **The link runs THREE WAYS**: hovering a section, hovering a stage in the EDITOR (`editorHoverStage`, fed by a CodeMirror `mousemove` -> `posAtCoords` -> `entryIndexAtOffset`), and the CARET resting in one, all drive the same connector and band via the `caretStage` signal (in-memory, never persisted), persisting while the caret is in a stage and clearing when it leaves every stage or the editor blurs; `hoveredStage` takes precedence while the pointer is over a section, so only one connector is ever drawn. Precedence is hoveredStage > editorHoverStage > caretStage (either pointer beats a resting caret; the two hovers are mutually exclusive). The reveal is ONE-WAY and ANIMATED: hovering a section scrolls the editor to the stage — gated on Auto-scroll AND only when that stage's opening line is OFF SCREEN, in which case the line lands at the TOP of the box, never centred (`smoothScroll.revealScrollTop`, pure: `null` means "already visible, leave the editor alone"; it centred on EVERY hover until 2026-08-14, so a stage the user could already read travelled anyway — the owner's report. A line touching either edge counts as visible, which makes the reveal idempotent. `REVEAL_TOP_INSET` = 6px is load-bearing by 0.3px: the connector's editor endpoint is the line's vertical CENTRE clamped `EDGE_INSET` (8px) inside the clip box, so a flush-top line would sit 7.7px below the edge — MEASURED — and the endpoint's dot would flip to the "it is off screen" arrow for a stage in plain view) — while hovering a stage in the EDITOR never moves the pane (owner, 2026-08-14). Tweened ~180ms ease-out via `src/mdh/smoothScroll.js` (hand-rolled because `behavior:'smooth'` is ~300-500ms and uncontrollable, and CodeMirror's `scrollIntoView` EFFECT has no behaviour option at all — it is always instant; reduced-motion and sub-2px moves jump, one tween per element cancels on retarget). `JsonEditor.scrollerFor()` picks whichever of `.cm-scroller`/`.json-editor` has the LARGER scroll range: **`.cm-scroller` has ZERO range in this layout** (console.css:408 makes the outer `.json-editor` the scroller; the generic `.json-editor .cm-editor{flex:1}` lacks `min-height:0` so `height:100%` never resolves), so writing `view.scrollDOM.scrollTop` silently does nothing. The caret and debug-panel jumps stay instant. The caret path never calls `revealStage` (the caret is on screen by definition — scrolling to it would yank the view from under the user's cursor). `stageLink.js`'s `sectionInPane()` suppresses the LINE when the target section is scrolled out of the pane — `computeStageLink` never checked visibility, which a section-hover can't expose but the caret/editor-hover links can; the band still carries the link. `.pipeline-inspect-section[data-linked]` marks the section end when the pointer is in the editor (its own `:hover` can't fire in that direction). `stageLineRanges` is memoized on the CodeMirror `Text` identity (immutable, so the key can't go stale) because the mousemove handler would otherwise run a whole-doc JSON5 parse per pointer move and resolves its section from `[data-entry]` (stamped on active AND disabled sections), so it draws nothing when the Stages view is closed. `onCursorStage` reports `{entryIndex, activeIndex}|null`: **two index spaces on purpose** — `entryIndexAtOffset` addresses a SECTION (disabled stages have one), `activeStageIndexAtOffset` addresses a stage's OUTPUT (a disabled stage produced none), and the scroll jump needs the latter. Its dedup sentinel starts `undefined`, distinct from `null`, or the first "left all stages" would be swallowed and the link would never clear. The band is deliberately NOT gated on Auto-scroll (that option governs scrolling, and the connector has never been gated either), and the field stores the stage's **entry index** rather than a text range, re-deriving on every edit — mapping the decorations instead would DROP the band when the line break in front of it is deleted, since `LineDecoration` maps with `MapMode.TrackBefore`. Spec: `docs/superpowers/specs/2026-08-12-mdh-stage-link-highlight-design.md` — `JsonEditor`'s `revealStage`/`stageScreenRect` (built on `stageLineRanges` + CodeMirror `coordsAtPos`) scroll the editor to the stage and measure its line. ONE automatic "follow" scroll is left — editor-follows-hover (`revealStage`), gated on `stagesAutoscroll` (Stages-follows-editor-cursor was removed 2026-08-14); the explicit debug-panel click jump (`handleInspectStage`) always scrolls regardless. jsdom has no layout, so `revealStage`'s geometry is NOT unit-testable — the decision is pure and tested (`tests/mdh-smooth-scroll.test.js`), the wiring was measured in a browser against the real component + stylesheet (see the spec's last revision note). **An empty stage gets a Fabry explanation** (`src/mdh/agent/explainEmpty.js` + `components/EmptyStageExplain.jsx`): "No documents at this stage" still shows, and BELOW it a purple Inspector-Diagnosis panel (`--diag-*`, `FabryMark`, two `inspector-esec-skel` shimmer bars + a cycling gerund while it works, then a streaming `FabryNarrative`). Fires AUTOMATICALLY (owner's choice over on-demand) but bounded by `explainSignature` — collection + the stages up to the empty one — so the same empty pipeline is explained once and a moved-on pipeline aborts the stream. **FIRST empty stage only**: once a stage emits nothing every later one almost always does too ($unionWith/$documents excepted), so the useful question is which stage emptied it. `firstEmptyStage` returns -1 while an earlier stage is still LOADING or ERRORED — guessing mid-load would explain the wrong stage. Sends pipeline + counts + `getSchemaHints()` (the same hints the AI query box already sends; derived in the browser, whole documents never leave). Gated on `aiAvailable` (the /health probe), NOT `experimentalUnlocked`. The component owns its own streaming state because StagesView renders every RecordCard in every stage. Rendered as MARKDOWN (`FabryMarkdown`) and placed as a SECTION child after `.pipeline-inspect-body` — NOT inside `.pipeline-inspect-output`, which is a horizontal flex row of record cards where it would sit beside the message at card width; an empty stage also drops the fixed records band (`.pipeline-inspect-body-empty{height:auto}`) since that band exists to keep RECORDS uniform. The prompt OPENS by framing the task as **Master Data Hub in Rossum** (collections in Rossum's Data Storage, queried by MDH matching hooks during extraction) — unframed, the Rossum-persona agent REFUSED outright ("isn't related to the Rossum document processing platform… I'm a Rossum platform specialist"); it also forbids scope commentary, preambles and apologies. It carries the pipeline AS WRITTEN (pre-substitution, `{variables}` intact) beside the AS RUN form plus a set/NOT-SET variable table: `debugEntries` is SUBSTITUTED, and an unset variable renders as an EMPTY STRING (usePipeline.js:237), so the agent otherwise advises loosening a filter when the fix is to fill the variable in. The written form is part of the cache signature (a literal and a variable of the same value run identically but need different advice). All pinned by tests. Shown in FULL (no inner scroll). "No documents at this stage" is a WARNING band (`--warning-bg/-fg/-border` + a ⚠ icon, `flex:1` so it spans the stage) rather than muted italic — with the records band now collapsing for an empty stage there is no wall of whitespace making it obvious. Warning, NOT danger: `--danger` is this pane's colour for a request that FAILED (`.pipeline-inspect-error`), while an empty result means the query ran fine and matched nothing; keeping them apart is what lets a real error stand out. (The header's zero COUNT is still `--danger` via `.pipeline-inspect-zero` — pre-existing, unchanged.) The empty-stage body override MUST stay the compound selector `.pipeline-inspect-body.pipeline-inspect-body-empty` — the single-class version loses to `.pipeline-inspect-body`'s fixed height ~65 lines below it, and jsdom cannot catch that. **Nothing re-investigates for an unchanged pipeline**: the source sample has its OWN effect (adding `sourceOpen` to the stage-preview deps made every toggle clear + refetch all stages, unmounting the panel), and a module-level signature-keyed cache (successes only — caching a failure would strand a transient blip; cap 20, in-memory) covers other remounts. Driven by live `entries` props (no local copy); `overscroll-behavior: none` on its scroll regions (kills the rubber-band).

Auth flow: popup (or background worker) uses `chrome.scripting.executeScript` to run `readAuthInfo` in the Rossum tab's main world → reads `{token, domain}` from `localStorage.secureToken` + `location.origin` → stages a single-use `consoleAuth_<uuid>` key in `chrome.storage.local` carrying `{token, domain, app, createdAt, pending*}` and opens `console/console.html?authId=<uuid>`. On boot, the Console shell reads + immediately removes the staging entry, hands credentials to `sessionStorage` (`consoleToken`/`consoleDomain`/`consoleAuthId`), inits both app API clients, picks the initial app (staging `app` > persisted `consoleActiveApp` > `mdh`), and lazily runs `initMdh()`/`initAudit()` on first activation. Subsequent reloads of the same tab use sessionStorage so the token is never left at rest in `chrome.storage.local`. Navigation state is also per-tab via `sessionStorage` with a `chrome.storage.local` seed (see `src/console/tabState.js`), so multiple Console tabs don't clobber each other's working context on reload. A 24-hour TTL purge sweeps any stale `consoleAuth_` entries (and orphaned `mdhAuth_`/`auditAuth_` entries from older builds) that were never consumed. The MDH sidebar can also open a collection in a new Console tab (kebab "Open in new tab", right-click the collection for the same actions menu at the cursor, or Cmd/Ctrl/middle-click a collection) — `src/mdh/openCollectionTab.js` stages the same single-use `consoleAuth_<uuid>` carrying `pendingCollection` and `chrome.tabs.create`s `console/console.html`, so the new tab opens focused on that collection and restores its last-used pipeline.

### Audit & Activity Console (`src/audit/`)

A focused **Audit Log viewer** over the single Rossum `audit_logs` source. Lives under the Console app rail (entry point `src/console/index.jsx`) and is styled by the shared `console.css`. Auth uses the shared `consoleAuth_<uuid>` staging described above. The app was rebuilt down to this one source (commit `39f124f`, "rebuild Audit as a focused audit-log viewer"); the descriptor architecture below is deliberately built to host more sources (Hook Logs, Workflow Activity, Rules Execution), but only `audit_logs` is registered today (`SOURCES = { audit }` / `SOURCE_ORDER = ['audit']` in `src/audit/sources/index.js`).

Architecture: one generic shell (`ConnectionBar` → `ErrorBanner` → `FiltersBar` → `ResultsTable` + `DetailPanel` → `Pagination`, per `components/App.jsx`) driven by per-source **descriptors** (`src/audit/sources/`), each exporting `{ key, path, paginationMode, supportsServerSearch, filters, buildParams, columns, detail, refs }`. The `audit_logs` descriptor (`sources/auditLogs.jsx`) uses cursor pagination and `supportsServerSearch: false`. Deep-links to the Rossum UI are built by `deeplink.js` from a row's `refs` (`{type, id}` pairs). The source 403s → `UnavailablePanel`. (There is no `TabBar`, `resolve.js` id→name resolver, or `quickSearch.js` in the current single-source build — those belonged to the earlier four-source design.)

### Galaxy (3D org birdview) (`src/galaxy/`)

A Preact app that fetches the live Rossum org over REST and renders it as an explorable 3D force-directed graph. Built directly on **three.js + d3-force-3d + OrbitControls** (NOT `3d-force-graph` — that bundles ngraph's `new Function` codegen which would violate the Console page's default MV3 CSP; the hand-rolled scene is CSP-clean by construction, verified by a `grep` of `dist/console/console.js`). Node types: organization, workspace, queue, hook, engine (5 types; `connector` was intentionally dropped). Edges: **containment** (org→workspace→queue), **reference** (queue→hook by inverting `hook.queues[]`; queue→engine via the unified **`queue.engine`** field — verified live on a customer dev org — falling back to legacy `dedicated_engine`/`generic_engine`), and **run_after** (hook→hook execution chains: a hook with `run_after` predecessors hangs off them via a `runAfter` edge instead of fanning off its queue, bridging through disabled hooks — re-added 2026-06-08 after the initial drop, so `graph.js` `LINK_STYLE` has three edge kinds).

- **`graph.js`** — pure `buildGraph(rawBundle) → {nodes, links}` (URL→id parsing, dedup, missing-ref tolerance) where each node carries a curated `detail` (`[label, value]` pairs from verified API fields). Exports `NODE_STYLE` (rainbow palette keyed to hierarchy depth) + `LINK_STYLE`.
- **`api.js`** — `init`/`get`/`listAll` (follows `pagination.next`)/`fetchOrgResources` (parallel fetch of organizations/workspaces/queues/hooks/engines; per-collection 403→[] tolerance; `onProgress` reports a per-page running count for the loading counter).
- **`scene.js`** — imperative three.js wrapper: `createScene(container) → { setData, onHover, onClick, focus, setIdleSpin, setVisibleTypes, destroy }`. d3-force-3d layout (re-heated on a type toggle so the visible subset reflows); light theme (no bloom); OrbitControls with **auto-rotate off**; raycaster hover-dim + click-to-pin (survives a rotate drag via a click-vs-drag movement threshold); fit-to-visible on open and after settle. Hand-verified in the browser; unit-tested via mocks (no WebGL under jsdom).
- **`index.jsx`** — `initGalaxy()` probes `whoami`, then loads the graph in the background (non-blocking) so the shell paints the rail + loading overlay immediately on open/reload.
- **`store.js`** — signals: `domain`, `token`, `connected`, `graph`, `loading`, `error`, `selectedNodeId`, `hoveredNodeId`, `loadedCount`, `visibleTypes` (+ `toggleType`).
- **`components/`** — `App` (scene bridge via `preact/hooks`), `Legend` (clickable per-type visibility filters), `DetailCard` (curated per-type facts + Open-in-Rossum deep-link for queue/hook), `NavGuide` (mouse-controls hint).

Adding the app touched three hardcoded rail switch-points (`Rail.jsx` APPS, `Console.jsx` render switch, `boot.js` `isValidApp`) plus `console/index.jsx` (imports, `TITLES`, auth wiring, lazy `initGalaxy`). Auth uses the shared `consoleAuth_<uuid>` flow; styled by `console.css` (`.galaxy-*`). No persisted state in v1.

### Inspector (Annotation Diagnosis Report) (`src/inspector/`)

A read-only Console app answering "what happened to this annotation, and why" as a single
progressively-filling **Diagnosis Report** (the earlier six question-tabs were replaced;
spec: `docs/superpowers/specs/2026-07-03-inspector-overhaul-design.md`).

- **`evidence.js`** — pure evidence model: `buildEvidence(input) → {items, verdict}` wraps
  (never re-derives) `culprit.js`/`correlate.js`. Every item = `{id, section, fact,
  reliability, culprit, sourceRef, data}` with stable citation ids that double as the
  attribution keys (`message:<i>`, `blocker:<i>`, `field:<schemaId>`, `label:<id>`,
  `reject`, `export`, `intake:*`, `workflow:*`, `drift:*`, `gap:<kind>` for 403'd sources).
  `computeVerdict` is the deterministic "why not automated" root cause (rejected/export-failed
  outrank automated outrank automation-off outrank blocked; low-score reasons carry
  confidence vs `datapoint.score_threshold ?? queue.default_score_threshold`; no blocker
  recorded → honest `not-recorded`, never a guess). Drift items join the model only after an
  opt-in live run (`live` input), per-row unique ids.
- **`synthesize.js`** — one Fabry chat per annotation (shared transport + `/persona cautious`):
  `buildSynthesisPrompt` serializes the evidence (48k `budgetedJoin` from `promptBudget.js`,
  shared with `agentAttribute.js`) and instructs inline `[e:<id>]` citations + honesty about
  `(unavailable)` items; `parseCitations` splits streamed text into text/cite segments;
  `runSynthesis` streams via `agentStream.js` and returns `{text, reasoning, tools}` (tool
  NAMES only) for the read-only "View investigation" transcript modal.
- **`index.jsx`** — staged lifecycle in `prefetchAndOrchestrate`: **gather** (9 independent
  403-tolerant sources, each ticking `investigation.sourcesDone` + `recomputeEvidence()`)
  → **attribute** (`orchestrate.js`, now awaitable via `Promise.allSettled`) → **synthesize**
  (skipped to terminal `agent-offline` when the agent is down; synthesis failure leaves the
  programmatic report fully usable) → **complete**. All stale writes guarded by `loadId` +
  one `AbortController` per run (aborting also kills synthesis mid-stream). `runRevalidate`
  (start → validate → cancel) stays the only write, opt-in from the Config-drift section;
  its diff (`driftDiff.js`, keyed by `(type, content, id)`) recomputes evidence but never
  re-triggers synthesis.
- **`components/`** — `Report.jsx` assembles the report column; on wide windows (>1160px)
  `App.jsx` wraps it in `.inspector-layout` (grid) beside **`PageRail`** — a sticky rail of
  document-page thumbnails (page image URLs 401 without the Bearer header, so `api.getBlob`
  fetches blobs → object URLs, revoked by `store.clearPagePreviews()` on annotation switch;
  first 4 pages eager + "Load N more"; click opens the annotation in Rossum via the audit
  `buildDeeplink`). Then `ReportHeader`
  (Overview + Timeline), `InvestigationStrip` (Gather ✓ n/m → Attribute k of K → Synthesize,
  live agent activity at right, collapses to a stat line), `VerdictCard` (instant,
  severity-edged), `DiagnosisPanel` (skeleton whenever synthesis hasn't initialized →
  streaming narrative — a takeaway line, "- " bullets, and a "Next step:" line, rendered
  as a real list via `parseNarrative` — with `⌖` citation chips that scroll/flash
  `[data-evidence-id]` anchors, unresolvable ids struck-through — never links → honest
  offline/error notes; purple-tinted panel via `--diag-*` variables, credited "by Mr. Fabry";
  once done, a **follow-up thread**: an AgentBox-style input (`.nl-search-*`/`.agent-spark`,
  gerund loader) continues the SAME synthesis chat via `continueSynthesis`/`askFabry` —
  answers render with citations, one question at a time, aborted on annotation switch),
  then `EvidenceSection`-wrapped sections (Intake & origin, Blockers & messages, Fields
  with confidence-vs-threshold bars, Extension runs ["no log — likely ran"], Labels,
  Rejection, Approval workflow, Export, Config drift) each carrying its own status chip
  (`loaded/attributing/sparse/unavailable/n-a/opt-in`); empty sections show `n/a` and no body.
- **Entry points** — two: paste an id/URL, or click a row on the landing — a compact
  table of annotations recently VIEWED in the Rossum UI (File/Queue/Status/When/Id,
  status pills, relative time, Clear-all [current org only], dashed empty state; id-only
  rows render before the one sideloaded enrichment call resolves names; live-updates via
  `chrome.storage.onChanged`; "← All annotations" above the report tears down via
  `closeAnnotation()` and refreshes the list); (the `/document/<id>` segment is the ANNOTATION id; SPA navigation caught via interval)
  visited annotations are recorded by `src/rossum/features/track-viewed.js` (always-on,
  pure tracker — the floating "Inspect this annotation" button, its popup twin, the
  `inspectAnnotationEnabled` toggle, and the worker's `openInspector` handler were all
  REMOVED 2026-07-04 by owner request) into `rossumViewedAnnotations` via the shared
  dependency-free module `src/inspector/viewed.js`. The `pendingAnnotationId` deep-link
  consumer remains in the console boot (currently producer-less). NOTE: reloading the
  extension does NOT re-inject content scripts into already-open Rossum tabs — reload the
  tab once before expecting tracking/features there.
- Read-only stance unchanged: the agent's read-only framing is defense-in-depth, and the
  server-side write-lock remains the ship-blocker before non-dogfood use.

### Onboarding training (`src/training/`, `src/academy/`)

A guided, gamified onboarding track for new partners ("Partner foundations": 5
missions, ~20 steps), verified from the page the trainee reaches and from the org's
own read-only API state — never from clicks, and the extension never writes to the
org. Precisely: no request it makes can mutate anything. That is **not** the same as
"only GETs" — the mission-5 Data Storage check is a `POST` to
`/svc/data-storage/api/v1/collections/list`, because that service takes queries as
JSON bodies (like a Mongo `find`); it lists collection names and changes nothing.
Audit this claim by looking for mutating verbs and mutating endpoints, not by
looking for non-GET, and do not "fix" that POST into a GET — it would 404. Two surfaces share ONE pure core so "passed" means the same thing regardless of
which one flipped it: the bottom-right **quest card** injected by the Rossum content
script (`src/rossum/features/training-quest.js` + `training-tether.js`), which
polls page state every ~1.5s and on focus while the gate is unlocked and a track is
active; and **Academy**, the sixth Console app (`src/academy/`), where a trainee
starts the track, self-attests, and mints a completion receipt. Both import
`src/training/` directly rather than keeping their own copy of the rules — the
content script can only ever mark `visit`/`api` steps and the Academy can only ever
mark `self` steps, so the two call sites cannot double-mark the same step.

- **`src/training/track.js`** — DATA ONLY, the curriculum. No evaluation logic lives
  here, so rewriting the syllabus never touches `steps.js`, and vice versa. Each step
  carries a `kind`: **`visit`** (matched via `detectResource()` from
  `src/devtools/detect.js` — reusing the DevTools panel's own live-verified route
  table, so a Rossum route change only ever needs fixing in one place), **`api`** (a
  `CHECKS` id from `steps.js`, passing on a delta against a mission-start baseline),
  or **`self`** (the trainee attests from the Academy; the content script can never
  mark one — `academy/store.js` `attestStep` hard-rejects any step whose `kind !==
  'self'`, which is what makes that guarantee load-bearing rather than incidental).
- **Mission-start baseline, and why a delta is mandatory** (`src/training/baseline.js`
  `grew`/`changed`, captured once per mission by `progress.js` `startMission`): an
  `api` step never asks "does X exist" — only "did X change since this mission
  started." Checking bare existence would hand every trainee a free tick for
  anything already in the org before they ever opened the extension (a rule that
  already existed, a schema that already had fields). The baseline is persisted
  **only when every check in the mission captures cleanly**; a half-captured
  baseline is discarded rather than saved, because a missing baseline entry makes
  `evaluateApi` return `false` forever for that check — saving a partial snapshot
  would let one transient network blip at mission start permanently strand that step
  for the rest of the mission (a real defect caught during implementation, fixed
  before it shipped).
- **A tether replaced the single arrow** (`src/rossum/features/training-tether.js`
  + pure geometry in `src/training/tether.js`, following the precedent of
  `src/mdh/stageLink.js`): a dashed connector runs from the quest card to the
  current step's target when it is on screen and clear of the card; when the
  target exists but is scrolled out of view, a small pill names which way to
  scroll instead (`↓ Your next step is below` / `↑ Your next step is above`).
  `tetherGeometry(cardRect, targetRect, viewport)` returns `null` — no line —
  when the target is not **usefully visible**: off the viewport on any edge,
  or on screen but overlapping the card (a connector to something hidden
  under the card teaches nothing).
- **The geometry aims at the target's VISIBLE part, and picks its axis by edge
  separation** — both fixes forced by one live case (2026-08-14, `m1.s3`
  reported as "doesn't have any tether"). A Rossum document row is a
  horizontally scrollable element measuring **4263px** against a ~1200px
  viewport, so its right edge and its centre both sit far off screen. The
  connector was anchored at x≈4271 and drew itself into empty space beyond the
  window: SVG present, path well-formed, nothing visible — indistinguishable
  from an unanchored step. So `tetherGeometry` now clips the target to the
  viewport before any math (the same idea as `stageLink.js`'s `clampToBox`),
  and chooses the horizontal-vs-vertical branch by which axis actually
  SEPARATES the two rects (`gapX`/`gapY`) rather than which centre is further
  off. Centres lie whenever the target is far wider than the card: that row
  spans the card on both sides, so the centre difference claimed a large
  horizontal offset while the rects did not separate on x at all. A zero gap
  cannot lie — it means that axis does not separate them, so the other must
  (both zero is the overlap case, already returned above). Pinned by two tests
  carrying the measured 4263px rect. `offscreenHint` is the one that answers
  "which way", based on the target's vertical centre relative to the
  viewport. Both are pure, DOM-free, unit-tested.
- **The tether draws the MDH Stages connector's shape, from shared code**
  (`src/ui/connectorPath.js`; owner, 2026-08-14: "use the same geometry as we
  do in the MDH Stages view"). `bevelPath` (a straight leg off each end, one
  bevel diagonal between them, small rounded bends) and `arrowHeadPath` were
  EXTRACTED from `src/mdh/stageLink.js` rather than copied, because a copy
  drifts the moment either connector is tuned — the shared emitter is the only
  version of "same geometry" that stays true. What did NOT move is each
  connector's anchoring: `stageLink` works in panel-relative coordinates off
  CodeMirror line rects, `tether.js` in viewport coordinates off the card and a
  DOM target. The extraction is behaviour-preserving for MDH by construction —
  `arrowHeadPath`'s up/down output is byte-identical to the `edgeArrowPath` it
  replaced, vertex order included, and `edgeArrowPath` KEEPS its up/down guard
  (returning null for anything else is that caller's "unclamped, draw the dot"
  contract, not the shape's), all pinned by `tests/ui-connector-path.test.js`
  plus the 49 existing stage-link tests. The tether's last leg runs along the
  arrowhead's own axis for the same reason `shaftElbow` does: a sideways
  arrival at a head reads as a corner rather than as one arrow; `stubFor` caps
  each leg at half the span so the two can never cross and fold the path.
  Styling takes `.stage-link-line`'s language but quieter — 1.5px, dashed
  `5 5`, round joins, opacity .55 — and **no animation at all** (the marching
  dashes and the `prefers-reduced-motion` branch that guarded them were both
  removed; the Stages connector has never animated). It can afford to whisper
  because it is now summoned deliberately (see the gate below). Two departures
  from that stylesheet, both because the tether floats over Rossum's UI rather
  than a panel this repo styles: a faint drop-shadow for legibility on an
  arbitrary backdrop, and a stroke of `#5b8af0` — the quest card's own gradient
  end. It was amber (`#ffd479`), which matched nothing on the blue card and
  washed out on the white dashboard.
- **The tether is drawn ONLY while the card is engaged** (owner, 2026-08-14),
  and engagement is a tracked POINTER POSITION, not `mouseenter` on the card.
  That is forced by `renderCard`, which **removes and recreates** the card
  element on every ~1.5s tick: listeners bound to it die with it, and a fresh
  node inserted under a stationary pointer does not re-fire `mouseenter` — so a
  hover held still would silently lose the tether within two seconds. A
  module-level `pointer` (updated by a passive, rAF-throttled `pointermove`)
  outlives the swap, and since `showTether` re-runs right after each render the
  line simply re-appears; `tests/training-tether.test.js` pins exactly that by
  replacing the card element mid-test. Three signals count as engaged, because
  a position alone cannot answer all of them: `pointer` inside the card's rect;
  `cardEl.matches(':hover')`, which covers the pointer ALREADY resting on the
  card the first time a tether mounts (no `pointermove` has fired yet — jsdom
  answers false rather than throwing, so it is a Chrome-only assist); and focus
  inside the card, since keyboard users cannot hover and the card carries a
  focusable dismiss button. A `pointerout` with no `relatedTarget` (the pointer
  leaving the WINDOW) nulls the position, so a line cannot hang open over a page
  nobody is on. The gate sits ahead of any geometry, so it governs the
  off-screen hint pill exactly as it governs the line — both answer "where do I
  go next", and showing one without the other would be arbitrary.
- **Anchoring gained `data-cy`, and still degrades silently** (`training-tether.js`
  `resolveAnchor`): a step's `anchor` may carry `cy` (matched against
  `[data-cy="…"]`) and/or `hrefIncludes` (matched against real `a[href]`
  elements, unchanged) — `cy` is tried first. Rossum ships ~274 elements
  carrying semantic `data-cy` hooks, the durable handle for controls that are
  not links; LIVE-VERIFIED 2026-08-07: Rossum's own navigation (`/documents`,
  `/extensions/my-extensions`, `/queues/<id>/…`, `/document/<id>`) is built
  from real anchors, not JS-only routing, so both are contracts worth relying
  on — CSS class names are not, and are never matched on. A step is free to
  omit `anchor` entirely (most `self` steps and several detail-page `visit`
  steps do). If the anchor never resolves within the retry window, **nothing
  renders and nothing else happens** — the card's plain-text hint still
  carries the step regardless, because a stale hook must never read as a
  blocked step.
- **The curriculum's `cy` values were HARVESTED, and must be re-harvested, never
  extrapolated** (2026-08-14, elis — 16 of 20 steps anchored). Each value was
  read off the live screen it belongs to and then re-checked through
  `resolveAnchor` itself on that screen, because the values follow **no single
  scheme**: queue-settings tabs are `queue-settings-header-tab-<name>` but the
  Automation-section tabs are `tab-automation.<camelCase>` — with a **dot**,
  which `cssEscape` handles (`CSS.escape` in Chrome, verified live; the jsdom
  fallback leaves it inert inside the quoted attribute selector, and both are
  pinned by tests) — while the Extensions list uses `extensions-*` and Field
  Manager uses `fm-*`. Inferring the next hook from the last one produces a
  selector that silently never resolves, which reads as a broken tether rather
  than as a typo. The anchor points at the control that **performs** the step,
  not at a wayfinding hop (the hint line already names the destination), except
  where the step *is* the navigation (`m1.s1`, `m3.s1`).
- **The four unanchored steps are unanchorable, not unfinished**: Field Manager
  renders ~1481 elements carrying only **four** distinct `data-cy` values, none
  per-field, so `m2.s3` anchors the link *into* it (`/settings/field-manager`,
  which resolves on `/settings` only) and `m2.s4` gets nothing; `m5.*` targets
  Dataset Management, a Console app the content script never runs in, so an
  anchor there could not resolve by construction.
- **`hrefIncludes: '/queues/'` is a trap on the dashboard** and is why `m1.s2`
  prefers `cy: 'sidebar-queue'`: the only `/queues/` link there is the queue's
  **settings gear** (`/queues/<id>/settings/basic`), so the href fallback would
  point at a different destination than the step asks for. Related and still
  open: `/documents` normalises to a `level=queue` view, which `detectResource`
  reads as a queue — so `m1.s2` can tick without the trainee opening one.
- **The gate is `experimentalUnlocked`, and it is the only one** (`src/training/
  gate.js` + `src/training/storage.js` `UNLOCK_KEY`; written by
  `src/popup/components/App.jsx` `onVersionClick`): 5 quick clicks on the popup's
  footer version hash, mirrored live into the Console via
  `chrome.storage.onChanged`. It hides exactly one thing — the Academy, badged
  `EXP` on the rail. Training had its own `trainingUnlocked` key from 2026-08-07
  to 2026-08-11, kept separate so a trainee could not acquire Mr. Fabry's
  write-enabled Architect implement loop as a side effect of starting training.
  That reasoning died with the gate on Fabry: Fabry is public for every user,
  implement loop included, so the trainee has it either way and a second key
  protected nothing while giving the same gesture two names. `trainingUnlocked`
  is orphaned — read by nothing, migrated by nothing, and safe to ignore, because
  the only build that ever wrote it wrote `experimentalUnlocked` in the same
  `chrome.storage.local.set` call, so no profile can hold one without the other.
  An even earlier revision gave training a click target of its own — 5 clicks on
  the header extension name (`.brand-name`) — a 68×18px text span with no
  `cursor: pointer` beside a visually-identical non-clickable badge, which no
  real user could find and which silently re-locked on a retry. Removed in
  favour of the single already-known gesture rather than inventing a
  discoverable replacement; `tests/popup-training-gate.test.js` still guards
  that clicking the brand name writes nothing at all.
- **The receipt's canonical string, and its honest limits** (`src/training/receipt.js`
  + `hmac.js` + `receiptKey.js`, minted by `src/academy/mint.js`): a Crockford-base32
  code, HMAC-SHA256'd via `crypto.subtle`, over the pipe-joined string `RSAT1|
  <trackId>@<trackVersion>|<host>|<userId>|<username>|<missionsPassed>|<selfCount>|
  <dateUtc>` — meaningless without reproducing every field it summarizes. **Every
  field `renderReceipt` prints is signed, the `username` included.** It was omitted
  once (2026-08-07, fixed same day): that made the printed name free-form text, so
  anyone could take a colleague's receipt, swap the name for their own, and have it
  validate — while `TrainerPanel` reports "Valid — issued to {username}" and no
  trainer cross-checks an opaque numeric id. Attributing a completion to a PERSON is
  the receipt's only job.
- **What mint-time re-verification actually buys** (`src/academy/mint.js`; an earlier
  version of this paragraph and of the comment in that file both OVERCLAIMED it):
  minting re-runs every `api` check against LIVE org state and revokes any step whose
  delta no longer holds, so **the org must still exhibit the change now** — a trainee
  cannot mint against an org they never touched, or keep a pass for work they have
  since undone. What it does **not** buy: the live signature is compared against the
  mission-start **baseline**, which lives in the same trainee-editable
  `chrome.storage.local` record — setting a baseline to `[]` (or `0`) makes every
  check pass trivially. Live re-verification raises the floor; it is not a forgery
  guard, and neither is the signature. Other honest limits, stated in-app: the
  signing key (`RECEIPT_KEY`) ships in the bundle and is extractable by design (same
  tradeoff as `src/usage/ga4Config.js`) — it deters casual copying between trainees,
  it is not proof against a determined forger. The receipt is a training artifact,
  not a credential. Mint also refuses to issue a receipt that could never verify:
  an unresolvable user id renders `(id NaN)` and an empty username renders `user |
  (id 42)`, both of which fail `parseReceipt`, so mint validates both and then
  round-trips its own output (`parseReceipt` + `canonicalString` compare) before
  returning `ok`. `tests/training-key-boundary.test.js` pins the key
  to exactly one bundle, `dist/console/console.js` (the Academy mints and checks
  receipts; the content-script quest card never needs the key and must never ship
  it — checked against `dist/`, not just `src/`, since an import alone doesn't paste
  the literal but a bundle does).
- **One new storage key**: `trainingProgress` (`{ [origin]: { trackId, trackVersion,
  startedAt, missions, receipt? } }`, keyed by org **origin** like
  `rossumViewedAnnotations`, capped at 3 orgs via `storage.js` `pruneOrgs` — the
  active origin's slot is always reserved). Training also introduced its own gate
  key, `trainingUnlocked`, from 2026-08-07 to 2026-08-11 (see the gate bullet
  above); it is now retired and orphaned, and the gate is the shared
  `experimentalUnlocked` — see the storage-key list below. `trainingProgress` lives
  in `chrome.storage.local`; `restartTrack`/`clearProgress` drop only the active
  origin's entry. The cap is **soft**: `pruneOrgs` never evicts a record carrying a
  `receipt`, because that record holds the only copy unless the trainee already
  pasted it somewhere, and `startedAt` (written once at track start, never updated)
  cannot tell us whether they did. Ranking by a touch time was the alternative and
  was rejected — it needs a new field written on every save and would still evict
  the receipt of an org the trainee stopped visiting, which is exactly when it is
  most likely to be the only copy.
- **`trainingProgress` is written by BOTH surfaces, so the content script WATCHES it**
  (`training-quest.js` `watchProgress`, guarded like `gateListenerOn`). Two failures
  follow from not doing so, and one `chrome.storage.onChanged` listener fixes both.
  (a) START: `init()` runs once, at content-script injection, and the intended first
  run is unlock-in-popup (no reload) → start the track in an Academy tab → switch
  back, by which time `init()` has already returned at its "no track yet" bail-out.
  The listener is therefore registered **before** that bail-out. (b) STALENESS: the
  loop holds progress in a closure, and every mission but `m3` ends on a `self` step
  that only the Academy can mark, so without a refresh the card sticks on the step
  just attested until a page reload. The listener also fires for the loop's **own**
  writes — deliberately a cheap no-op (assign and return; no fetch, no tick, no
  write, so no cascade). Separately, every write in the loop is **read-modify-write**
  against storage rather than a blind write of the closure (a write only happens on a
  step transition, so it costs one extra read per STEP, not per tick), and a record
  that has disappeared — "Restart track" — stops the loop instead of resurrecting
  the progress the trainee just cleared. The Academy's own writes
  (`academy/store.js attestStep`, `mint.js`) stay **blind** on purpose, and the
  asymmetry is the design: a `self` attestation is unrecoverable (only the trainee
  can assert it), while a `visit`/`api` pass self-heals on the next tick — so the
  expensive direction is protected and the cheap one is not. There is a comment at
  the `attestStep` write site saying so, because symmetry looks like the fix here and
  is not.
- **The loop is generation-guarded** (`training-quest.js`, same pattern as
  `training-tether.js`). A tick suspended on a fetch or a storage write when the
  trainee restarts the track resumes *past* `stop()`; rendering there leaves a frozen
  card that no interval will ever refresh, and `stop()` closes over the module-level
  `intervalHandle`, so a late tick from a dead loop could clear a **successor** loop's
  interval. Every post-await point that touches the DOM or module state checks
  `isCurrent()` first. `init()` also takes a **synchronous** `starting` claim at
  function entry, released at the commit point (`started = true`) so a restart
  arriving mid-fetch can still hand off to a successor — that one is defensive: the
  previous check-then-set was already unsplittable, and is labelled as such in the
  source rather than sold as a bug fix.
- **`collectionAdded`** (mission 5's Data Storage check, `steps.js`) is the one check
  that differs from every other on three axes at once, which is why `CHECKS` carries
  optional `method`/`body`/`auth` fields at all: Data Storage's collections-list
  endpoint is a **POST** to `/svc/data-storage/api/v1/collections/list`, authenticated
  with **`Bearer`** (not the `Token` scheme every other check uses), returning `{
  result: [...] }` — **singular** — live-verified against the shipping MDH client
  (`src/mdh/api.js`, `src/mdh/components/Sidebar.jsx`). It is still a **read** (a
  list query, no id, no mutation) — the one non-`GET` request this feature ever
  issues to the Rossum origin is that list call, not a write.
- **Every `api` check reads EVERY page, and none of them orders** (`steps.js`). Rossum
  list endpoints order by id **ascending**, so a plain `page_size=100` strands
  anything the trainee just created on the last page — not hypothetical: the org this
  track was verified against holds **96 rules and 133 schemas**, so `schemaFieldAdded`
  was already counting the wrong total there. All four `/api/v1/` checks therefore
  carry `paginate: true`, and `collectResponses` follows `pagination.next` to the end
  (capped at 50 pages; absolute `next` urls reduced to path+query, since both fetchers
  take a path). `collectResponses` is the single fetch path shared by baseline
  capture, per-tick evaluation and mint-time re-verification, so all three agree on
  what a check reads. **`ordering=-id` was tried and reverted** — worth knowing,
  because it is the obvious-looking fix: it made `thresholdChanged` *worse* (that
  step asks the trainee to move a threshold on a queue that **already existed**, and
  `changed()` only fires for a queue in both snapshots — newest-first drops exactly
  those), and it was unverifiable, since DRF silently ignores an ordering field it
  does not expose and the delta would then break with no error anywhere.
  `pagination.next` is a contract already followed by shipping code
  (`src/galaxy/api.js` `listAll`). Paging everything also dissolves the
  old-hook-vs-new-hook trade on `hookAttachedToQueue`. Cost on that org: one extra
  GET. See the verification doc §G7 — a closed gate, not an open one.
- **`src/academy/`** — the Console app: `store.js` (signals: `connected`, `progress`,
  `activeMissionId`, `error`, `receiptText`, `mintNote`), `api.js` (`fetchAcademyApi` — the
  Academy's own thin fetcher, taking the same `{method, body, auth}` shape as the
  content script's so `mint.js`'s live re-verification of `collectionAdded` doesn't
  silently downgrade to a Token-authed GET), `mint.js`, and components `App`,
  `MissionList`, `MissionDetail` (renders `teach` as markdown via `FabryMarkdown`,
  and is the only place a `self` step can be attested), `ReceiptPanel`, `TrainerPanel`
  (pastes a receipt back in and reports valid/not-valid — same `verifyReceipt`, same
  key). `App` renders `store.error` as a dismissible strip in **every** branch,
  including `!connected` — that is the one path `initAcademy`'s missing-domain
  message is set on: "Open the Rossum Console from this extension's popup on a
  Rossum tab to access the Academy." (the Academy is reachable only from the
  Console rail; the popup's direct Academy entry point was removed 2026-08-11
  per owner decision). `mintNote` lives in the store, not in
  `ReceiptPanel`'s local state, because a failed mint revokes the step it failed on,
  which makes the track incomplete, which would unmount the panel and destroy the
  note explaining what just happened; `App` keeps the panel mounted while a note is
  pending. The note wording is per-reason (`ReceiptPanel.noteFor`): only
  `no-longer-true` un-ticks anything, so only it tells the trainee to redo work — a
  network blip says the opposite. `store.refreshProgress` selects the first
  incomplete mission (`progress.js` `firstActiveMission`) rather than mission 1, but
  only when nothing is selected, so a background tick never yanks the trainee off the
  mission they are reading. Usage events (`src/usage/event.js`): `sa_console_app_academy`,
  `sa_training_start`, `sa_training_mission_complete` (fired from **either** surface,
  guarded so a mission finishing on a `visit`/`api` step and one finishing on a
  `self` step can never double-count — see Usage data below), `sa_training_receipt_issue`,
  `sa_training_receipt_verify` — all parameterless.
- Nothing about a trainee's org — mission ids aside — is ever recorded: field names,
  schema ids, collection names, and rule/hook contents are never read into a
  signature (`baseline.js`'s `isIdsOnly` invariant), only counts and integer ids.

### Fabry Chat (`src/fabry/`)

A Claude-style chat interface over the Rossum Agent API ("Mr. Fabry") — the fifth
Console app, **public since 2026-08-11**: the rail item (label "Fabry", `beta`
badge like Inspector) renders for every user, with no gate in `Rail.jsx` and no
clause in `boot.js` `pickInitialApp`/`appAfterGateChange`. It rendered only while
`experimentalUnlocked` was set until then; that key now gates the **Academy**
alone, and the live-gate machinery it drives is unchanged and simply serves that
app instead — `chrome.storage.onChanged` mirrors the key into a console-store
signal, and re-locking while the Academy is active falls back to MDH (an inline
gate effect in `console/index.jsx` using `activeApp.peek()`; `boot.js
appAfterGateChange` is the tested pure equivalent). Ungating Fabry was an owner
decision that knowingly made the write-enabled Architect implement loop public
— see that section below. Specs:
`docs/superpowers/specs/2026-07-10-fabry-chat-console-design.md`,
`docs/superpowers/specs/2026-08-11-fabry-public-single-gate-design.md`.

The server owns ALL chat state; the client holds it in signals only:
- **Sidebar** mirrors `GET /chats` verbatim (including machine chats created by
  the other Fabry surfaces), titles via `summary || preview || first_message`
  (`format.js chatTitle`), offset pagination driven by `total`.
- **Open chat** = `GET /chats/{id}` → `thread.js normalizeMessages` (string or
  content-part arrays incl. images; user turns starting with `/` render as
  system-style chips).
- **Send** (`chat.js sendMessage`) = lazy `createChat` on first send + optional
  `/persona cautious` priming turn (persona picker, cautious preselected,
  applies to the next new chat) + `streamMessage` folded per turn
  (`newAcc`/`foldEvents`: reasoning → collapsible Thinking strip, tool events →
  ordered `toolLabel` chips, text → streaming markdown). Composer: Enter/Shift+
  Enter, paste/drop/pick image attachments (≤4, ≤5MB, png/jpeg/gif/webp), `/`
  autocomplete fed by `GET /commands`, Stop while streaming, standing
  write-capability notice.
- **Feedback** 👍/👎 (`PUT /chats/{id}/feedback`): the UI is currently HIDDEN
  (2026-07-13) — `turn_index` addresses the raw stored history but `GET /chats`
  drops text-less tool-only steps, so a thread index mis-targets feedback on
  tool-using turns (live-confirmed). Plumbing kept dormant; re-enable once the
  backend exposes a stable per-message feedback id. **files** = `ChatDetail.files`
  strip + authenticated blob download.
- **Concurrency** (`chat.js`): one module-level AbortController + monotonic
  `loadId` guard every await — a chat switch mid-stream can never write stale
  state; Stop keeps the partial fold as an `interrupted` turn with a "Refresh
  from server" affordance. Errors: 401 → app banner, 429 → inline note, agent
  down → offline state; sidebar/commands failures degrade (hide) silently.
- **Markdown**: `src/ui/fabry/markdown.js` + `FabryMarkdown.jsx` — hand-rolled,
  XSS-inert by construction (block tree → vnodes, never innerHTML), http(s)-only
  links with balanced-paren href scanning, streaming-tolerant (unterminated
  fence → code-so-far). R1 "Aligned" styling (heading scale for the h3–h6 the
  parser emits, indented lists, framed tables, `--bg-code` blocks + language
  tag). Code fences get hand-rolled token highlighting (`src/ui/fabry/
  highlight.js` — python/json/js/bash/sql subset → vnode spans, `.hl-*` classes
  on semantic color tokens); `mermaid` fences render as diagrams via the
  lazy-loaded mermaid bundle (`MermaidBlock.jsx`; diagram renders only once the
  stream is done; invalid/unloadable → honest code-fence fallback). Shared for
  future adoption by the other Fabry surfaces.
- **No chat content at rest**: the only persisted value is the per-tab
  `fabryActiveChat` id (tabState pattern).
- **LIVE-VERIFIED 2026-07-11 (elis)**: feedback `turn_index` = RAW index into
  `ChatDetail.messages` (client maps via `thread.js serverMessageIndex`; the
  server STRIPS command/priming turns from history, so the persona pill only
  shows on live-primed threads, and feedback placement on primed chats was
  observed inconsistent server-side — dev-server 2.2.0dev0 caveat); client
  abort STOPS server-side generation (the user message persists, no reply);
  vision works via top-level `{content, images:[{media_type,data}]}`.
- **Deep verify** (spec `docs/superpowers/specs/2026-07-11-fabry-deep-verify-design.md`):
  composer toggle (session-only signal, never persisted) routes sends through
  `src/fabry/deepLoop.js` — answer → FRESH-chat critic (primed cautious,
  `VERDICT: PASS|FAIL` first-line contract, adversarial tool re-check) →
  `[deep-verify reviewer]` refine messages back to the main chat, cap 2
  rounds; verdict chip (✓ verified / ⚠ issues / inconclusive) + critic strip
  on the final answer. Grounding (live-probed): the agent already runs an
  autonomous per-message TOOL loop server-side (8 steps observed) but has NO
  independent self-verification — fresh-context criticism is the gap this
  fills. Reviewer messages are display CHIPS but COUNTED in
  `serverMessageIndex` (the server STORES them, unlike `/`-commands →
  `Turn.chip` = display, `Turn.command` = index exclusion). Deep-verify is
  **always available** (`store.deepVerifyAllowed` defaults true; its popup
  kill-switch `fabryDeepVerifyEnabled` was REMOVED 2026-07-14); the in-composer
  ✦ toggle (`deepMode`) is the per-message on/off.
- **Agent interactive elements** (spec `docs/superpowers/specs/2026-07-13-fabry-agent-questions-design.md`):
  the agent's `ask_user_question` tool emits a `data-agent-question` event
  (`agentStream.foldEvents` → `acc.questions`); `AssistantTurn` renders it as an
  inline `FabryQuestions` form (free-text / single-select / multi-select),
  answered by ONE message back to the same chat (`chat.js answerQuestions`/
  `formatAnswers`; a plain message IS the answer — verified; questions are NOT
  persisted server-side). Deep verify skips question turns (`deepLoop` returns
  `{skipped}` when `sendMainTurn` reports `verifiable:false`). **Never render
  nothing:** `agentStream.fallbackNotice` + `src/ui/fabry/FabryNotice.jsx`
  (`.fabry-turn-notice*`) turn any UNKNOWN `data-*` element or stream `error`
  into a named notice (with raw payload in a Details expander) — the
  forward-compatible catch-all for future interactive elements.
- Read-only stance unchanged: cautious-default persona + standing notice are
  defense-in-depth; the server-side write-lock remains the ship-blocker before
  non-dogfood use.
- **Architect mode** (spec `docs/superpowers/specs/2026-07-13-fabry-architect-design.md`,
  §Revision v2): a `[Chat | Architect]` segmented toggle in the sidebar (under
  the ✦ brand) driven by the per-tab, content-free `fabryMode` signal swaps
  `.fabry-main` — Chat is byte-identical. Architect (`src/fabry/architect/`)
  keeps one per-org list of **deliverables** (Markdown SOW items) in the
  `_SA_EXTENSION__fabry_architect` Data Storage collection (renamed from
  `__mrfabry_architect` on 2026-08-18 — see *Version history* below for the
  migration, which is NOT a one-shot rename) — one doc per deliverable
  `{_id, kind:'requirement', text /*markdown*/, order, createdAt, editedAt,
  title, titleSource, lastVerdict, lastEvidence, lastChatId, ranAt}`. Both names
  live in `architect/collectionNames.js`, a leaf module with no imports, because
  MDH's sidebar filter needs them too and two literals would silently disagree. The deliverable **list lives in the sidebar** (`ArchitectSidebar`,
  rendered by `Sidebar.jsx` in architect mode). Each row shows a concise **title**
  resolved most-explicit-first by `format.displayTitle` (2026-08-17, owner): a
  manual **Rename…** > **a Markdown heading the deliverable declares on its own
  first non-empty line** > an AI-generated title (read-only `generateTitle`/
  `backfillTitles`, `title.js` prompt) > the derived first line > `Untitled`.
  `headingTitle` copies its pattern from `src/ui/fabry/markdown.js:76` on purpose
  (`^(#{1,4})\s+`, UNTRIMMED) so it accepts exactly what the Preview tab RENDERS
  as a heading — `##### x`, `#x` and an indented `# x` are all plain text there
  and are therefore not names here. Rename and AI generation share the one
  persisted `title` field, so telling them apart needs **`titleSource`**
  (`'manual'`/`'ai'`, `saveTitle`'s third argument): absent on every doc written
  before this change, and `''` reads as AI-generated — which is precisely what
  lets the heading rule reach deliverables that ALREADY EXIST. An older build
  ignores the key and still reads `title`, so the doc stays readable both ways.
  `generateTitle`/`backfillTitles` **skip headed text entirely** (the heading
  already wins, so the chat would be pure waste) — meaning a headed deliverable
  stores NO title at all, which is why both Rename… call sites prefill from
  `displayTitle(d)` and not from `d.title`, or the box opens EMPTY on exactly the
  deliverables the heading names. `EXAMPLE_DELIVERABLE` leads with its heading for
  the same reason: behind the `> 👋` banner the demo would be named after the
  banner. Row also carries a run-status dot + a
  kebab (Re-run / Implement / Rename… / Delete); the footer has **Run all ▷**/Stop
  (the read-only check) — there is **NO "Implement all"** (implement is
  per-deliverable). **Deliverable pane — redesigned 2026-07-15 (Proposal A):** a
  header (title button → rename + a compact status **pill**) over a full-width
  **Edit / Preview toggle** — the CodeMirror `MarkdownEditor` source and the
  `FabryMarkdown` preview are MERGED into one toggled area (both stay mounted,
  `hidden` toggles which shows; `MarkdownEditor.refresh()` re-measures CodeMirror on
  reveal) — over a **tabbed action console `[Check | Refine | Implement]` (Check
  first, default-active)**: Check = verdict + evidence + Re-run + view-investigation;
  Refine = the `RefineDock` bar; Implement = Run/Stop + task list + audit. `Run all`/per-row
  `Re-run ▷` check each deliverable in its own fresh cautious-primed agent chat,
  parse `VERDICT: PASS|FAIL|UNCERTAIN` + evidence (pure `check.js`; concurrency-3
  abort-aware `run.js`; impure glue `actions.js` with a monotonic run-id guard
  mirroring `chat.js`'s `loadId`), then **persist** the result onto the
  deliverable's doc (`saveResult`). On reopen, persisted results show marked
  **outdated** ("last checked {when} · may be outdated — re-run"; staleness =
  `!ranAt || editedAt>ranAt || loaded-not-run-this-session`); editing a
  deliverable marks its result stale. Run is **strictly read-only** against the
  org (cautious persona + read-only framing + server-side read-only default — the
  check/refine paths never send `mcp_mode`; the separate write-enabled **implement
  loop** below is the one place that does); Architect's only writes (from the check)
  are its own deliverable docs
  (content + last result). Nothing extra at rest in the browser (deliverables +
  results live server-side per-org; only `fabryMode` persists; `activeId` is
  in-memory). No new gate — inside the Fabry app, which is public since 2026-08-11.
  That LIVE GATE is now CLOSED (2026-08-18, probed on the internal org): Data
  Storage accepts a `_SA_EXTENSION__`-prefixed collection create (200 ok) and a
  doc write into it, so the prefix convention is safe.
- **Status is the CHECK VERDICT alone — there is no manual state** (owner, 2026-08-19:
  "let's drop the manual labels, let's rely only on the LLM (programatic) labels"). A
  hand-set state per deliverable — localpages' `rough-draft`/`in-progress`/`ready`/
  `verified`/`stale` vocabulary as an Architect property (`stateLabel.js` +
  `StateControl.jsx`, `state`/`stateDate` on the doc, a picker in the pane header) — shipped
  on 2026-08-18 and was REMOVED the next day, so the whole surface is one badge: `CheckBadge`
  in `SpecView.jsx`, rendered in each section header and in the inspector rail. The reason it
  went is worth keeping, because it is the argument against re-adding it: the manual "Verified"
  and the measured "✓ Met" answered the SAME question, so a reader facing both had to decide
  which one to believe, and the one nobody can fake is the one Fabry re-derives from the org.
  `stale` was the third badge and is not a state at all — it qualifies a verdict ("last checked
  4d ago · may be outdated"), so it now renders as a suffix on the pill (`· stale`) with the
  FILL dropped and the verdict's hue kept in text and border: the same claim, visibly not
  fresh. The sidebar dot already spoke only verdict (`dotClass`), so it needed no change.
  Existing documents KEEP their `state`/`stateDate` fields — `mapDocs` simply stops reading
  them, because retiring a feature must never delete customer data — and `printDoc.js` no
  longer prints a state badge (`PDF_KEYS` is `['contents','verdicts']`; the PdfDialog offers
  two options, not three). `docWarnings.js` still catches anyone who types the old markup:
  `<state-label>` and its near-misses (`section-state`, `statelabel`, `StateLabel`, bare
  `state`/`status`) render upstream's dashed-red error pill plus a `file:line` warning, because
  otherwise they render as NOTHING — markdown-it passes the unknown tag through, the sanitizer
  unwraps it, and a browser draws an unrecognised custom element as empty space. That silence
  is what the owner hit with `<section-state>`. The warning now says the element is not
  supported here and that a deliverable's status comes from its check verdict. One nuance
  unchanged: an UNDERSCORED name (`<state_label>`) needs no notice and gets none — an
  underscore is illegal in an HTML tag name, so markdown-it never treats it as HTML and it
  renders as visible literal text.
- **Version history** (`architect/revisionPolicy.js` + `components/HistoryPanel.jsx`, owner
  2026-08-18; spec `docs/superpowers/specs/2026-08-18-architect-version-history-design.md`) — a
  4th action-console tab `[Check | Refine | Implement | ↺ History]` over per-deliverable versions
  stored as SIBLING documents in the same collection: `{_id:'rev_<uuid>', kind:'revision',
  deliverableId, text, at, source}`. `loadDeliverables` queries `kind:'requirement'`, so a
  revision is invisible to this build's normal load AND to every older build — the additive-key
  precedent (`titleSource`, `state`) applied to whole documents. Full text per version, never a
  patch chain: restore is then a plain write and no single entry can corrupt the middle of a
  history. **One version per EDITING SESSION, not per save** — the editor autosaves 600ms after
  typing stops (`SourceColumn.onEdit` in `components/SpecView.jsx`), so per-save versioning would mint dozens per
  paragraph; the first save of a session stores the PRE-EDIT text and later saves in that session
  write nothing. A session ends on an `IDLE_MS` (5 min) pause, a deliverable switch, or a `source`
  change (`'edit'`/`'refine'`/`'restore'`) — a human edit after an accepted Refine is a different
  act. `source` describes the change that SUPERSEDED the stored text, which is what makes a row
  read "at 11:07 a Refine acceptance changed this; here is what it looked like before", and which
  answers "what did Fabry do to my spec" with no separate provenance feature. `CAP` is 40 per
  deliverable and pruning ALWAYS KEEPS THE EARLIEST — it is the only copy of where the document
  started (same reasoning as `storage.js pruneOrgs` never evicting a receipt). Two invariants that
  are easy to break: the snapshot decision is made BEFORE the store is mutated (the version stores
  the text as it WAS), and the insert is deliberately NOT awaited by the save path (a user's text
  must never wait on its history; a failed insert costs one missing entry, not an unsaved edit —
  pinned by a test). The list query PROJECTS `text` OUT, so opening the tab is cheap on a long
  specification; each version's text is fetched only when looked at, and `ensureRevisionText` loads
  the `vs next` side WITHOUT moving the selection. Restore is one click with no confirm dialog
  BECAUSE it is undoable: `source:'restore'` forces a new session, so the pre-restore text is
  snapshotted first. Diffing reuses `src/ui/DiffView.jsx` unmodified. `resetSession()` is called by
  `loadArchitect` — a session carried across a reconnect would fold the first edit into a version
  belonging to the previous org. Incidental fix that came with it: an EXTERNAL text change (restore,
  or an accepted Refine) now repaints the preview — `preview` only followed typing, so the pane
  kept showing superseded text until the next keystroke (the editor was always fine, since
  `MarkdownEditor`'s value effect dispatches the new document).
- **The collection rename is NOT a one-shot rename** (`architect/collectionPlan.js`, pure +
  4-state, owner 2026-08-18: "think about migration strategy for older customers where we cannot
  rename it now"). The hazard is verified in code, not hypothetical: `loadArchitect` calls
  `ensureCollection`, which CREATES the collection when absent (`api.js:9`), so an older build
  elsewhere recreates the legacy collection on its next boot and writes into it. `planCollection({
  hasNew, hasOld })` therefore drives one boot-time step: **new only** → use it; **neither** →
  create; **legacy only** → try the rename, and ON FAILURE keep using the legacy collection
  unchanged and retry next boot (NOT surfaced as an error — that is the "cannot rename now" case);
  **both** → use the new one, ALSO read the legacy one, union by `_id` with the newest edit
  winning, and report the count in a `.fabry-arch-legacy` notice. A rename failing with `target
  namespace exists` is NOT a failure — another tab won the race, so the new collection exists while
  ours did not move, which IS the merge state and is treated as such. Nothing is ever dropped or
  overwritten, and **writes follow the document**: `colFor(id)` routes an update to whichever
  collection the deliverable actually lives in. Adopt-on-write was the approved design and was
  ABANDONED during implementation for a concrete reason — `updateOne` with `upsert` creates a doc
  WITHOUT `kind:'requirement'`, which `loadDeliverables` filters on, so the deliverable would
  silently vanish from the list; a full copy while an older build may still be writing risks
  resurrecting stale text over newer. Consolidating the two collections is deliberately manual.
  LIVE-VERIFIED semantics behind all of this (internal org, throwaway collections, dropped after):
  rename preserves documents; create-existing, rename-onto-existing and rename-missing-source all
  return **HTTP 400** (so `src/mdh/api.js:55` throws and a try/catch is enough — no body
  inspection); and **`find` on a missing collection returns 200 with `result: []`**, so existence is
  NOT detectable by a find and `listCollections` is mandatory (one extra call per Architect boot).
- **Our collections are hidden from Dataset Management** (`src/mdh/hiddenCollections.js`, owner
  2026-08-18). `isHiddenCollection` matches the `_SA_EXTENSION__` prefix plus the legacy Architect
  name explicitly (it cannot be renamed on every org, so it would otherwise be the one visible
  artifact of a half-migrated fleet). Applied at `Sidebar.jsx`'s SINGLE `listCollections` site via
  `store.applyCollectionFilter()`, which SPLITS the sorted list: `rawCollections` keeps what the
  server returned, `collections` is the customer's (what Overview, prefetch and the empty state
  already read, so they cannot disagree), and `hiddenCollections` is ours. Ours are NOT merged back
  in on reveal — they render in an **expandable group pinned below the main list** (owner,
  2026-08-18; `▸ Extension collections (n)`, expanded state = the global
  `mdhShowHiddenCollections`, absent when there are none), built from the SAME
  `collectionRow(name)` renderer, so a hidden collection selects/middle-clicks/right-clicks/kebabs
  like any other. A selection is dropped only when the collection no longer EXISTS — visibility is
  not the test, or selecting one from the group would instantly deselect it — and a restored
  per-tab selection that is one of ours AUTO-EXPANDS the group without persisting, since a
  highlight under a collapsed header reads as no selection. Reachability is REQUIRED rather than a
  nicety — the MDH record editor is currently the only way to hand-edit a deliverable or read a
  stored version. Hiding is decluttering and must never read as a security boundary: the collection
  is plainly visible to anything else holding the org token.
- **The unified specification view** (owner, 2026-08-19; spec
  `docs/superpowers/specs/2026-08-19-architect-unified-specification-view-design.md`, plan
  `docs/superpowers/plans/2026-08-19-architect-unified-specification-view.md`) — the Architect no
  longer shows one deliverable at a time. `SpecView.jsx` renders EVERY deliverable in `order` as a
  `<section data-deliverable data-slug>` inside ONE scroller, so a specification reads top-to-bottom
  and **Cmd+F reaches all of it**. The deliverable list (`ArchitectSidebar`) became pure navigation —
  every deliverable with its headings nested, verdict dot, highlight driven by the scroll spy — while
  keeping the operations nothing else can own (add, drag-reorder, rename, delete, Run all, PDF).
  `DeliverableEditor.jsx` and the bottom action console are **deleted**; their panels live on in
  `InspectorRail.jsx`, and the Check/Implement markup was extracted verbatim into `CheckPanel.jsx` /
  `ImplementPanel.jsx`. The three-way `Editor | Editor and Preview | Preview` switch is now two-way:
  `docView` is `'edit' | 'preview'`, a stored `'split'` maps to `'preview'` (`migrateDocView`), and an
  older build still understands both remaining values — the pref degrades in both directions.
  **Cmd+F is a PREVIEW-mode guarantee, and that is measured, not assumed**: a real CodeMirror with a
  600-line document renders **52** `.cm-line` elements, and a marker near the end is neither in the DOM
  nor findable. So Edit mode gives each deliverable **its own CodeMirror, mounted immediately** and with Markdown
  highlighting (`components/SourceEditor.jsx`; owner, 2026-08-19: fields visible at once, and "I still
  want the Markdown highlighting when editing") — no click-to-activate and no swap, so nothing shifts
  under the reader. MEASURED that this is affordable and well-behaved at CONTENT HEIGHT inside the
  page's scroller: five 700-line editors mount in **70ms**, their inner scroll range is **0** (the page
  owns scrolling, which is what makes the specification one document), and CodeMirror still renders only
  what is visible (**79** line elements out of 3500), so a fast scroll stays cheap. Editors are seeded
  and then SYNCED — a store update that originated in an editor is not dispatched back into it (that
  would move the cursor mid-typing) while a genuinely external one (a restore, an accepted Refine) is —
  and pending edits are held **per deliverable** in a Map, since every section is editable at once and
  a single slot would drop an edit the moment the reader moved fields. Saving still goes through the
  same `updateDeliverable`, so per-session version capture is untouched.
- **Edit-mode navigation goes through CodeMirror, NOT through arithmetic** (`SourceEditor.jsx
  scrollLineIntoView`). Clicking a heading in the list must land on it in either mode (owner,
  2026-08-19), and in source a heading is a LINE — but **CodeMirror estimates the height of lines it has
  not rendered, and the estimate assumes ONE visual line**, so in wrapped prose an unvisited region
  undershoots by thousands of pixels. Measured consequences, in order: `line * lineHeight` was hopeless;
  a mirror element that copies the textarea's metrics worked but died with the textareas; `lineBlockAt`
  arithmetic landed a click on `3.5` at the SECTION START; and a bounded re-measure-and-correct loop
  still drifted two or three headings (`3.5` → `3.8`). What works is CodeMirror's OWN
  `EditorView.scrollIntoView` — VERIFIED to scroll the ANCESTOR scroller when the editor itself has no
  scroll range — followed by one exact correction from `coordsAtPos` once the line is actually rendered.
  All five test entries then land on the clicked heading. The scroll SPY still uses estimated tops, and
  that is fine: they are accurate near the viewport, which is the only place the highlight looks.

  The same estimation moves a SECTION target too, which is a separate jump (a sidebar ROW click, and
  the mode-switch restore) with no line to hand CodeMirror. MEASURED on the five-document fixture: the
  arithmetic said 4725 and the section settled at 5153, so the reader landed **428px short** — and the
  restore that "worked" was landing short in exactly the same way. `SourceColumn`'s `jumpToEl` therefore
  tweens to the computed top and then corrects from the element's live rect (up to three passes,
  2px tolerance), which puts all three test targets at **offBy 0** and holds the restore at 0 across
  Preview → Edit → Preview. A monotonic `seq` makes a newer jump win, so a late correction can never
  yank a reader who has clicked somewhere else. Section geometry is read from RECTS, not `offsetTop`:
  they agree today (4393 == 4393, offsetParent `.docs-pane`) only because that ancestor shares the
  scroller's top edge, and any padding added above `.docs-root` would silently shift every jump.

  **A slug alone cannot say WHICH deliverable's heading was clicked.** Two documents may legitimately
  carry the same heading — `## 2. Scope` in both slugs to `2-scope` in both — so Edit mode scanned in
  document order and landed inside the FIRST one (measured: asking for the second deliverable's
  `2-scope` landed at scrollTop 49, inside the first). Preview disambiguates with the id prefix (F2);
  the source column needs the id itself, so it travels in the shared options argument
  (`scrollToSlug(slug, prefix, { docId })`) and that deliverable is searched first. DocView already
  treated the third argument as options and reads only `instant` from it, so one signature serves both.
- **A mode switch keeps the reader in place.** Switching unmounts one column and mounts another, so the
  new scroller starts at the top and the document appears to jump away. `SpecView` remembers the
  deliverable being read and restores it INSTANTLY when the new column reports itself (an animated
  restore would be the very jump it is avoiding). Measured: the third deliverable stays at the top
  across Preview → Edit → Preview, at 6507 → 6157 → 6507px, each mode's own layout. **Heading ids are namespaced per deliverable**
  (`src/docs/idNamespace.js`, `slug--id`) because they collide otherwise — measured: two deliverables
  containing `## 2. Scope` both render `id="2-scope"`, and in a concatenated page `querySelector`
  returns the first, so every fragment link and outline jump would land in the wrong document. Only
  IDS move; authored hrefs are left exactly as written (prefixing `#2.1` would defeat
  `anchorResolve`'s forgiving matching, whose real id is `slug--21-entities`) and `resolveInPage`
  reconciles them, resolving inside the reader's own section FIRST. Namespacing is applied to the
  ADOPTED COPY, never the cached render, so `render.js` stays byte-faithful to upstream and the cache
  is still shared with the print path. `src/docs/specDocument.js` is that shared assembler, extracted
  from `printDoc.js` so the printed specification and the on-screen one cannot drift; it returns DATA
  (state/verdict), never chrome, because print draws SVG badges and the screen draws `console.css`
  pills. The rail FOLLOWS the scroll (owner) and is safe to do so because of two rules in the pure
  `specTarget.js`: an explicit **pin** wins, and a deliverable with a run in flight **HOLDS** the
  target until it finishes — verified in a browser: with a check running on the section being read,
  scrolling to the end of the document left the rail where it was and showed a "held while this runs"
  badge, then released to the reader's actual position when the run ended. The **inspector** collapses from the document bar (646 → 906px at a 1280px window) and is
  **drag-resizable** from its left edge (`railWidth`, clamp 260–620, persisted as
  `fabryArchRailWidth`; live during the drag, persisted on release — the `sidebarWidth` pattern). The
  **deliverable list is deliberately NOT collapsible** (owner, 2026-08-19: it is the navigation, and
  navigation that can disappear is a trap), so `fabryArchTocOpen` and the toggle that wrote it were
  removed rather than left as an orphan. A word-diff in a
  322px rail is unreadable, so Refine and History carry "⤢ Open at document width", which renders the
  diff in the document column above its section (`ReviewHost` in `SpecView.jsx`, closed by its own
  button, by the rail's "Bring it back", or by Escape) — and the rail then shows a pointer instead of
  mounting the same panel twice, because `HistoryPanel`'s selection is a shared signal that two copies
  would fight over. `ReviewHost` was **referenced and never defined** in the first cut, which threw
  `ReviewHost is not defined` as an unhandled rejection inside Preact's async render and took the whole
  Architect view down with it — silently, since no test ever set a `reviewTarget` and mounting alone
  cannot reach the branch. Three tests now do.
- **The sidebar never repeats a deliverable's own title** (`outline.js outlineWithoutTitle`, owner
  report 2026-08-19). The row shows `displayTitle`, which prefers the document's opening heading — so
  a specification whose document starts `## 1. Overview` (rather than `# 1. Overview`) had the same
  words on the row and again one line below it, because `extractOutline` lists h2 and h3. The opening
  heading is dropped by **LINE**, not by text: two headings can legitimately share a title, and the one
  being removed is specifically the one on the document's first non-empty line.
- **Edit mode carries `.markdown-body` for its BOX** (`SpecView` + `console.css`), rather than
  restating that rule. Copying the wide rule's `padding: 45px` made Edit sit narrower than Preview,
  because the ported sheet also has an `@container (max-width: 767px)` branch that drops the padding to
  **15px** — and a 646px reading column is inside that branch. Measured after the fix: both modes
  `left 312 / right 958 / content 616 / padding 15px`. Restating a ported number is how you drift from
  it; carrying the class cannot.
- **Navigation jumps use the repo's own tween, never `behavior: 'smooth'`** (`DocView jumpTo` →
  `src/mdh/smoothScroll.js animateScrollTop`). MEASURED on the same ~13,000px jump in one continuous
  specification: native `scrollIntoView({ behavior: 'smooth' })` took **≥1481ms** (the sampling window
  ended at 1500ms), the tween **198ms** — Chrome's smooth duration scales with distance, which is
  exactly why a one-page specification felt sluggish (owner report). The target is computed from
  RECTS, not `offsetTop`, so it does not care which ancestor is the offsetParent.
- **The inspector follows a SETTLED target, and the spy geometry is cached** — both because a rail that
  follows the scroll is the expensive consumer. MEASURED over a 60-frame scroll of a 130-heading
  specification: the rail produced **44 DOM mutations → 0** once scroll-driven target changes were
  debounced by `RAIL_SETTLE_MS` (120ms, `store.setSettledTarget`), because switching it remounts a
  panel and re-parses the check evidence as markdown — work nobody can read mid-flight. An explicit
  click (a section header, a list row) passes `{ immediate: true }` and is never delayed. Separately,
  reading 130 headings' `offsetTop` every frame cost **0.136ms**; caching the geometry and invalidating
  it on a `scrollHeight` change (one cheap layout read per frame) plus on resize costs **0.001ms** —
  136× less. `spyTarget` stays live for the cheap consumers (the list highlight); only the rail waits.
- **`chrome.storage.local.get([keys])` returns ONLY the keys it is asked for** — a preference that is
  written but not requested reads back `undefined` for ever. That is how the inspector's width came to
  be saved and never restored (owner report, 2026-08-19): the write was right, the boot read list had
  never been updated. `architect/store.js` now has ONE `PREF_KEYS` list feeding the read, and
  `tests/fabry-architect-store-view.test.js` scans the module for every `set(...)`/`persistBool(...)`
  key and asserts the list covers it, so the next preference cannot regress the same way. (`railWidth`
  is clamped 260–620 and persisted as `fabryArchRailWidth`; the bottom console's
  `fabryArchConsoleHeight` machinery was removed as dead.)
- **Deleting a host deletes its actions — check what went with it.** "Download PDF" lived in the
  deliverable pane, and vanished when the unified view replaced that pane (owner report): nothing
  called `openPdfDialog` any more, and `printAction.js` + `PdfDialog.jsx` sat orphaned while the docs
  claimed the sidebar had kept it. The flow now lives in `architect/pdfAction.js` (`openPdfFlow`) and
  the document bar owns the button; "this deliverable" means the one the rail is on. Its outcome note
  and document warnings render in the bar, as they did in the pane.
- **A scroll listener must be owned by the effect that owns the element** (measured 2026-08-19, and it
  cost a real defect). `DocView` is remounted by a mode switch, which builds a NEW `.docs-root`;
  `SpecView` had attached the spy listener from the parent on `[sections]` deps, which do not change
  across a mode switch — so the listener kept listening to the destroyed node and **the scroll spy
  died permanently after one switch**, while every unit test passed. `DocView` and `SourceColumn` now
  each attach their own listener and pass their live `{ scroller, sectionTops, headingTops }` API INTO
  the callback, so a stale reference is impossible by construction. The same class of bug as the
  `.cm-scroller`-has-no-range trap: invisible to jsdom, obvious in a browser.
- **Collapsing the deliverable list is a GRID-COLUMN change, not a component one**
  (`src/fabry/components/App.jsx`): the Fabry shell sizes the sidebar with
  `gridTemplateColumns: sidebarWidth + 'px 1fr'`, so hiding it means collapsing that column to `0` and
  not rendering `<Sidebar />`. Leaving the sidebar mounted at its old width would simply cover the
  document.
- **Architect implement loop** (ralph-style, write-enabled; spec
  `docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md`, plan
  `docs/superpowers/plans/2026-07-14-architect-implement-loop.md`): an autonomous
  loop that drives each deliverable toward PASS by actually WRITING to the org (the
  read-only check answers "is it done?"; this makes it done). **Gated by the
  per-run Arm dialog alone** since 2026-08-11, when Fabry went public and took
  its `experimentalUnlocked` gate with it (owner decision: "fully public,
  implement included"). It is ON by default within the Fabry app (the popup
  kill-switch
  `fabryArchitectImplementEnabled` was REMOVED 2026-07-14; `store.implementAllowed`
  defaults true). **Task-decomposition loop** (ghuntley "one thing per loop"; folded
  into the same consolidated spec — the earlier separate task-decomposition doc was
  merged in 2026-07-15): per deliverable, one Arm → autonomous. A read-only **PLAN** turn (`plan.buildPlanPrompt`)
  decomposes the deliverable into a small ordered **task list** (the `fix_plan`, persisted
  on the deliverable doc as `implementTasks`), then a **dynamic task loop**: each task →
  a fresh **write-enabled** turn (the SOLE write call site — `implementTaskOne` in
  `actions.js` sends `agentApi.streamMessage(chat, prompt, { mcpMode:'read-write' })`, i.e.
  `mcp_mode` in the MESSAGE body per `rossum-agent api/stream.py resolve_mcp_mode`, DEFAULT
  persona, no priming; enforced by `tests/fabry-write-boundary.test.js` + a bundle grep) →
  `audit.js` records every write → a fresh **read-only per-task check** → PASS or retry
  (≤`maxAttemptsPerTask`) with journal-seeded learnings; the turn may append **discovered**
  prerequisite tasks (dynamic fix_plan). When no task is pending, the existing read-only
  **roll-up check** (`runOne`) verifies the whole deliverable → PASS persists; FAIL appends
  **remediation** tasks (re-plan) and re-loops. The task prompt (`plan.buildTaskPrompt`)
  carries the ralph guardrails — INSPECT-before-assume (failure mode #1) + FULL/no-placeholder
  (#2) + **BACKWARD COMPATIBILITY** + **NEVER lose customer data/documents** (owner) — the
  primary safety, since there is no per-plan human review and no per-op scope (the
  `allowedOps` allowlist was removed 2026-07-14; appropriate for a brownfield, not
  greenfield, org). **Bounds (runaway guards for the autonomous dynamic loop):**
  `maxAttemptsPerTask=5`, `maxPlanTasks=12`, `maxTotalTasks=20` (caps plan+discovered+
  remediation; overflow dropped + surfaced via a note), `maxTotalWrites=50` (global),
  `maxRollupRounds=3`; **Sequential** (writes must not race); always-live **Stop**. Pure
  modules `plan.js` (prompts/parsers)/`audit.js`/`implementLoop.js` (the plan→task→roll-up
  state machine); impure glue + `runId` guard +
  `clearImplementSpinners` in `actions.js`; availability signal `fabryStore.implementAllowed`
  (default true; popup kill-switch removed 2026-07-14). State on the deliverable doc (
  `implementStatus`, `attempts`, `implementJournal` [cap 10], `lastImplement*`) — all
  optional/back-compat; nothing extra at rest in the browser. The roll-up verdict is
  **persisted as the deliverable's Check result** (`saveResult`, disjoint `$set` from
  the implement fields) so the Check tab reflects the post-implementation state on
  reload; a transport-errored roll-up is shown but not persisted (preserves
  last-known-good). UI: sidebar per-row kebab **Implement ▷** (the footer **Run all ▷**
  is the read-only check — there is **NO "Implement all"**); editor **Implement panel**
  in the Check-first tabbed action console (status + task list + audit log). **Live
  gates — VERIFIED on elis 2026-07-14** (against the `rossum-agent`
  backend source + live probe): **G1** ✓ writes are client-enablable via the MESSAGE
  body `mcp_mode:"read-write"` (there is NO server-side write-lock — `resolve_mcp_mode`
  honors the client value with no permission check; the only gates are token validity +
  an api-URL host allowlist); **G2** ✓ a live `create_workspace`+`delete` executed and
  succeeded with the SA token, then self-cleaned; **G3** ✓ read-only holds when
  `mcp_mode` is omitted (so Chat is safe ONLY by client discipline); **G4** ✓ reads are
  generic `get`/`search`, writes are entity-specific (`create_hook`/`patch_schema`/…)
  plus a generic `delete`. **WRITE-BOUNDARY
  INVARIANT (owner):** Chat is strictly read-only; ONLY the Architect implement loop may
  write. Because the backend has no write-lock, this is enforced client-side: no surface
  other than the transport (`agentApi.js`) and `src/fabry/architect/**` may reference
  `read-write` — guarded by `tests/fabry-write-boundary.test.js`. Remaining pre-non-
  dogfood item: a stable customer-facing rollout decision (this is an autonomous
  write-to-prod-org capability; ON by default within the Fabry app, which is
  public since 2026-08-11, Arm-gated per run).

### Document rendering & export — the localpages port (`src/docs/`)

A port of [localpages](https://github.com/mrtnzlml/localpages) (pinned at **`4d43f26`**, per-file
sha1s in the spec) into the **Architect's deliverable pane**: GitHub-faithful Markdown rendering,
GFM alerts, section state labels, anchors, a TOC sidebar, hover previews of in-document sections,
copy buttons and print-quality PDF. (A self-contained static-HTML **ZIP export** was part of the
port and was **REMOVED 2026-08-18** at the owner's request — "PDF should be enough or people can go
directly to the Rossum org" — see Revision v8 of the spec for exactly what went with it.) Spec:
`docs/superpowers/specs/2026-08-17-localpages-port-architect-design.md` (read its **Revision v2**
first — it is the record of what implementation changed). Of localpages' 14 documented features, **11 ported, 1 partially, 2 were dropped** at port time; the
static export was then removed, so **10 remain**. §7 of the spec is the exhaustive ledger.

**`FabryMarkdown` is NOT touched.** Chat, Academy, MDH's empty-stage explanation and the Architect's
own Check-evidence panel keep it, with its deliberate subset (heading shift `#`→`h3`, https-only
links, no images). The ported renderer is used ONLY by the deliverable Preview. Two markdown
renderers in one bundle is the intended state, not an oversight: one renders streaming agent chat,
the other renders documents.

- **`render.js`** ← `render.mjs`, with FOUR marked deltas and everything else verbatim (`highlight`,
  `highlightTodoInSvg`, the anchor slugify, the alerts→anchor→stateLabels order,
  `disable('replacements')`, the whole `link_open` `.md`→`.html` rewrite including its linkify
  `bogus http://foo.md` fixup). The deltas: mermaid is **injected** (beautiful-mermaid is already a
  1.5MB lazy bundle here — importing it would drag it into `console.js`); hljs is the curated
  `./hljs.js`; `env.syncLines` stamps `data-src-line` on **top-level blocks only** (`token.level
  === 0` — stamping nested opens gave 8 anchors for 5 blocks, and a nested element resolves
  `offsetTop` against a different offsetParent); and `wrapStandaloneImages` had to accept a `<p>`
  WITH attributes, because DELTA 3 broke its bare-`<p>` regex and standalone images silently lost
  their `<figure>` in the live pane. `env.syncLines` is live-only, which is what keeps exported
  output byte-identical to upstream's.
- **Section states are NOT document markup here** (owner, 2026-08-18: "add the support for
  state-label, but let's make it part of the Fabry's Architect (not inside the markdown)").
  Upstream's `state-labels.mjs` plugin — which this port originally carried byte-identically,
  with its 25 assertions ported verbatim — has been **removed from the pipeline and deleted**,
  and `<state-label>` in a deliverable now renders a diagnostic instead of a badge. The
  Architect property that briefly replaced it is gone too (2026-08-19) — status is the check
  verdict alone; see *Status is the CHECK VERDICT alone* above and `src/docs/docWarnings.js`
  for the diagnostic. The cost is recorded honestly: `states.md` is no longer byte-equivalent to
  upstream, and `tests/docs-render-equivalence.test.js` says so in a dedicated block rather
  than quietly dropping the fixture.
- **A hook's implementation previews as code, not as escaped JSON** (`resources.js`
  `formatResource` + `highlightCode.js`). Verified from the Rossum API tool contract, not
  guessed: a function hook carries `config: { runtime: "python3.12", code: … }` and a webhook
  carries `config: { url }` with no code — so the modal showed a three-line handler as ONE
  130-character escaped line, which is the "cannot preview the JSON/PY files (the hooks
  implementation)" report. Code is now shown as **Python** (language read from `runtime`
  rather than assumed), everything else as pretty JSON, and the modal's path line names WHICH
  part of the resource is on screen so nobody mistakes a hook's code for the whole object.
  The same highlighter feeds the print page, so a printed hook reads as Python too.
- **An extension is TWO files, so the resource has TWO VIEWS** (owner, 2026-08-18). A prd2
  extension is `<hook>.json` (the whole definition) and `<hook>.py` (its implementation), but
  both resolve to ONE API resource — and since a code-bearing hook prefers its code, the JSON
  definition was unreachable. The view now rides in the resource KEY as `?view=code` /
  `?view=json`, which is the only addressing scheme that survives BOTH paths untouched:
  `apiPathFromHref` already preserves a query and strips a fragment, and the export's `keyFor`
  reduces an href to `pathname + search`, so one marker keys a `<template>` offline exactly as
  it keys a fetch live. `splitResourceView` **removes it before the request**, so nothing
  unrecognised ever reaches the Rossum API — and it claims the parameter ONLY when the value is
  one of ours, so a real `view` parameter (Rossum has none today) would still pass through
  rather than being silently eaten. `formatResource(raw, view)` keeps `view === null` **byte-
  identical to the pre-view behaviour** (code when there is code), so every link and every
  embedded template written before this behaves exactly as it did; it also returns `views`,
  which is what decides whether the modal offers a switcher at all — a queue or a webhook has
  one view and gets none. Asking for `code` on a webhook shows the definition with an explicit
  "no code" note rather than passing one off as the other. `sourceViewer.js` gains a
  `[Code | Definition]` switcher (its SECOND documented delta; `theme.css` DELTA G), and a
  switch is just the same modal reopened on the sibling key, so live and offline take the paths
  they already took. `sourceViewer.js` still reads `data-view`/`data-views` off a
  `<template data-source-path>` when one is present — that was the ZIP export's offline path and
  no longer has a producer in this repo, but the branch is three lines, it is what makes an
  older exported bundle still open, and it is the seam any future offline mode would use. **Authoring:** link
  `/api/v1/hooks/42?view=json` for the definition and `?view=code` (or the bare path) for the
  implementation; a bare link still opens the code and the switcher reaches the rest.
- **`sanitize.js`** (new) — an element/attribute **allowlist** applied to the parsed tree before it
  is adopted, because `html: true` must stay on (it is what makes `<state-label>`, `<details>`,
  `<mark>` and `<div class="wide">` work) and deliverable `text` has **four writers**: the SA, the
  *agent* (`RefineDock.jsx` `accept()` writes a refine proposal straight in), any org-token holder
  writing the Data Storage collection, and this extension's own MDH record editor (nothing filters
  `__`-prefixed collections). The exported HTML carries **no CSP at all** (measured), so the same
  string would execute in the pane and on the print page. Three rules earn their place: an unknown element is
  **unwrapped, not deleted** (deleting subtrees would swallow prose — the `<queue_id>` migration
  hazard below); inside an `<svg>` subtree **everything but `on*`/`<script>`/`javascript:` is
  allowed**, which is what keeps `render.js`'s fence override verbatim, since mermaid emits an
  SVG-internal `<style>` that `highlightTodoInSvg` writes into and every state badge is inline SVG
  with `stroke-dasharray`/`paint-order` geometry no HTML allowlist would name; and `tabindex` is on
  the attribute list because markdown-it-anchor puts it on EVERY heading (omitting it changed every
  heading in every document — caught only by the fixture-idempotence test).
- **The four client behaviours** ← `client/*.js`, each now `init(root, scroller[, navHost])` plus a
  **teardown** (upstream is a page-scoped IIFE; a pane that re-renders on every keystroke must
  unwind). Upstream's timings and caps are untouched (hover 280ms, hide 160ms, `MAX_BLOCKS` 8, copy
  flash 1500ms). `toc.js`'s scroll-spy formula is upstream's own — `rect.top + scrollY - 80 <=
  scrollY` reduces to `rect.top <= 80`, already viewport-relative, so only the base it measures
  against changes. Two Chrome-only APIs needed the repo's usual guards: `CSS.escape` (absent in
  jsdom, same treatment as the training tether) and `scrollIntoView` (stubbed in tests, not guarded
  in the port). `reload.js` is **dropped** — no server to reconnect to, and the preview is live per
  keystroke. Fragment links and relative links are intercepted rather than navigated: on an
  extension page a plain `<a href="other.md">` click would replace the whole Console.
- **`theme.css`** ← `theme.css` with SIX marked deltas and every light colour value verbatim, plus an
  appended dark branch (D3; `github-markdown.css`'s light half computes **identically** to the
  light-only sheet upstream ships — verified across 19 elements × 14 properties). A: the two
  page-level rules (`:root{color-scheme}`, `html,body{margin/padding/background}`) are scoped to
  `.docs-root`, or they would force the whole Console light and paint it white; `scroll-padding-top`
  and `overscroll-behavior-y` are deliberately left global because the Console root never scrolls.
  B/C: `@media`→`@container` and `100vw`→`100cqw`, because in a pane those numbers must measure the
  COLUMN — measured, a wide table came out **904px = pane(936) − 32** where `100vw` would have given
  1248 and overflowed. D: `.docs-pane > .toc` re-homes upstream's `position: fixed; left: 0` to
  absolute inside the pane — measured `paneLeft 344 == tocLeft 344`, where upstream's rule would
  have put it at 0, over the app rail and the Fabry sidebar. F:
  `.section-preview` becomes `position: fixed` (page coordinates are meaningless when an element
  scrolls) — behaviour-preserving precisely because upstream already dismisses the card on any
  scroll, so the two schemes can never visibly differ.
- **Print** — upstream's ENTIRE `@media print` block ports verbatim; `console.css` ADDS the shell
  teardown (app rail, Fabry sidebar, the specification bar, the inspector rail, `#app{height:100vh}`
  and every `overflow:hidden` ancestor between the page and `.docs-root`, plus un-sticking the
  section headers so they print as a band at the top of their section). MEASURED after the unified
  view landed: the five-deliverable fixture prints as **19 flowing pages** with no chrome on page 1,
  where without the teardown it would be one clipped viewport. Every added rule is scoped
  `body:has(.docs-pane)`, so printing MDH, Audit or Chat is untouched; there was no `@media print`
  anywhere in this extension before. `Cmd-P` prints **what is on screen** — in Edit mode that is the
  Markdown source, because Edit and Preview are now separate mounts and there is no hidden preview
  column to reveal (the old pane kept one, and this block used to force it visible). The **⤓ PDF**
  button is the path that always prints the rendered document, in either mode and at any scope.
- **Export (REMOVED 2026-08-18)** — one self-contained `<slug>.html` per deliverable plus a
  generated `index.html`, zipped. Deleted at the owner's request to simplify the surface: PDF
  covers handing a specification over, and anything live is in the org itself. Gone with it:
  `docExport.js`, `page.js`, `zip.js`, `exportClient.js`, `download.js`, `assetsLoader.js`, the
  `console/doc-export-client` esbuild entry, `build.js`'s `doc-assets.js` registrar, and
  **`client/toc.js`** — the in-pane TOC had already moved to the sidebar, so the exported pages
  were that module's last consumer (its 8 tests went too). Three things it had earned stay
  because the live pane or the print page still need them: `slug.js` (slugs address
  cross-document references, not just filenames), `contents.js` (printDoc generates the printed
  contents page from it), and `sanitize.js` — whose justification shifts but does not weaken,
  since the four writers of deliverable `text` are unchanged and the sanitizer still guards what
  the pane and the print page adopt. `resourceFetcher.raw` and `slug.js`'s `mdHref`/`htmlHref`
  were export-only and were removed with it. What is genuinely LOST: offline `<template>`
  embedding of referenced API resources, the `index.html` landing page, org-hosted images as
  `data:` URIs, and the unresolvable-cross-document-link report (`collectBrokenLinks`).
- **PDF / print** (`printDoc.js`, `printEntry.js`, `print.html`, `printAction.js`,
  `PdfDialog.jsx`) — an extension cannot WRITE a .pdf here: `chrome.printing` is ChromeOS-only
  and `chrome.debugger`'s `Page.printToPDF` needs a permission that disables every existing
  install until each user re-approves. So "PDF" is a print-ready page plus the browser's print
  dialog ("Save as PDF" is its default destination), and the dialog says so. Cmd-P on the
  Console **does** work — MEASURED with headless Chrome's `--print-to-pdf`: a long document
  prints to 3 pages standalone and 3 pages in-pane, 204,267 vs 204,208 bytes — but only for the
  deliverable that is OPEN, which is the gap this fills. The page is a REAL extension page, not
  a blob: URL, because a blob inherits the creator's CSP and could never run an inline script;
  its payload is staged single-use in `chrome.storage.session` (`docPrint_<uuid>`, removed on
  read, so specification text never lands at rest). Scope is asked per use; the content options
  are remembered. Three defects that only appeared in real printed output are pinned by tests:
  unwrapping every `<a>` leaves markdown-it-anchor's `#` as literal text (the permalink must be
  REMOVED), the contents page must not describe itself as a self-contained bundle (its
  ZIP-flavoured default note is gone now that print is its only caller), and a
  title must NOT be injected above a document that already names itself.
- **Cross-deliverable hover previews** — upstream's card is same-page only (a localpages page is
  one file); a specification here is many deliverables, so `initSectionPreview` takes
  `resolveExternal(href)`/`onOpenExternal(href)`. A reference to another deliverable previews
  THAT document's section (its opening when there is no fragment), carries provenance, and its
  footer opens that deliverable. Rendered from the store — every deliverable's text is already
  in memory, so a hover costs no request — cached by `slug + text` so an edit invalidates only
  its own entry. Same-document previews were never broken: `eligible()` refuses a link inside
  `.toc`, which is what a naive probe hits first. In-document `#` clicks are intercepted too
  (they used to fall to the browser and append a stray fragment to the Console's URL).
- **The document outline lives in the SIDEBAR, not in the document** (owner, 2026-08-18):
  `src/docs/outline.js` (pure) + `ArchitectSidebar`'s `Outline`, nested under the open
  deliverable so the sidebar is one navigation tree. This is also why the in-pane `.toc` is
  gone — it needs a 1280px column and the pane is ~936px at a 1280px window, so it was hidden
  in practice; `client/toc.js` went with the export that was its last consumer. The
  outline is read from the MARKDOWN (works in Editor mode, needs no layout) and its slugs are
  asserted against the LIVE renderer, because they must match markdown-it-anchor exactly or a
  click scrolls to nothing: duplicates take `-1`/`-2`, the counter spans every heading level,
  and `Ünïcode heading` becomes `ncode-heading`. Clicking navigates whichever surface the
  reader is on (source while editing, preview otherwise — one mode at a time since 2026-08-19,
  so there is no second surface to drag along; `syncScroll.js` and its `lineAtPreviewTop`/
  `previewScrollTop` pair were deleted with the combined mode). TWO bugs worth remembering:
  naming a map variable `h` SHADOWS Preact's `h` factory (the JSX inside compiles to `h(...)`),
  and `scrollToLine` must resolve the scrolling ancestor by overflow AND range — writing
  `scrollTop` to a non-scrolling div is accepted and IGNORED, so the jump did nothing and threw
  nothing (measured: correct 1450px delta, `after: 0`).
- **Callbacks that close over the store must NEVER reach DocView's adopt-effect deps.** They are
  fresh functions every host render, and `setPreview` fires one on every keystroke — so an
  effect that depends on them tears the document down and re-inits every behaviour, which
  CLOSES an open resource modal (`initSourceViewer`'s teardown calls closeModal) and CANCELS the
  280ms hover timer. That one line was behind two "the preview doesn't work" reports; the fix is
  refs, and the lesson is that module harnesses could not see it because they never typed.
- **Which element scrolls a CodeMirror depends on the layout — measure BOTH.** In the old
  deliverable pane `.cm-editor` was bounded and `.cm-scroller` owned the range (349px vs 0); in a
  harness whose wrapper has no definite height `.cm-editor` grows to content and the outer host
  owns it (14,002px vs 0). The `scrollTargetFor` helper that compared them went with that pane —
  the unified view's editors have **no** scroll range at all (measured 0; the page owns scrolling),
  which is why `SourceEditor.scrollLineIntoView` leans on CodeMirror's own `scrollIntoView`, verified
  to scroll the ANCESTOR scroller. The lesson survives its helper: writing scrollTop to the wrong
  element is accepted and IGNORED — no error, no movement — so measure, as `JsonEditor.jsx` does.
- **Fragment references are resolved forgivingly** (`src/docs/anchorResolve.js`): the id for
  `### 2.1 Entities` is `21-entities` (the dot is stripped), so the `#2.1` a human writes matched
  nothing. Resolution order is exact id → normalized equality → leading section number, and the
  prefix branch refuses to continue into a digit so `#2.1` can never resolve to "2.10 Appendix".
  Used by the hover card, fragment clicks and the sidebar outline.
- **Deliverables are pre-rendered in idle time** (`src/docs/renderCache.js` +
  `architect/preload.js`), because the switch cost is RENDERING, not loading — all text arrives in
  the single Data Storage `find`. The cache key includes whether a diagram renderer existed, or a
  document rendered before the 1.5MB bundle landed would be served with code fences where diagrams
  belong. The preloader warms diagram-free documents FIRST and only then waits for the bundle —
  waiting up front measured as nothing cached at all. Two related bugs fixed with it: a switch
  painted the PREVIOUS deliverable's text for one frame (`preview` is now tagged `{id, text}`),
  which also meant the cache was never hit; and `latest.current` is stale after a switch, so the
  outline jump now reads what is on screen.
- **A popup inside an `overflow: hidden` pane must be `position: fixed`** — the deliverable
  header sat inside one, so an absolutely positioned menu was CLIPPED, and with the control at the
  right end its right edge measured **1347px against a 1280px viewport**. The rule to remember is
  the clamp ORDER: right-then-left horizontally (so a too-wide menu shows its start) and
  bottom-then-top vertically — the latter is not cosmetic, the reverse produced `top: -38px` and an
  unreachable first item. `architect/menuPlacement.js` held that logic and was **deleted on
  2026-08-19** together with the header it served: the unified view's only popup is the sidebar
  kebab, which places itself. (`src/mdh/libraryPlacement.js` implements the same pattern and is NOT
  in the working tree — it lives in a stash.)
- **The view switch** (originally the owner's ask for WebStorm's `Editor | Editor and Preview |
  Preview`; **two-way since 2026-08-19**, see the unified-view section) — `.fabry-arch-viewtoggle`
  was already an N-button `aria-pressed` group, so it needed **no new CSS**. `docView` is a
  **global** pref in `architect/store.js` following the width prefs exactly (boot load in a
  `try/catch` for tests). The pane's old toggle reset itself to `'edit'` on every deliverable
  switch; a chosen mode outlives one, deliberately. The combined mode was what first made the
  ported container queries earn their keep — and they still do at the reading column's own width:
  at ~450px the `@container` branches hide the TOC and drop padding to 15px, upstream's own
  narrow-screen behaviour driven by the column instead of the window. `splitRatio` and its
  `fabryArchSplitRatio` key went with the mode (nothing reads the stored value; it is left inert
  rather than migrated).
- **Scroll sync** (editor → preview, combined mode only) is **gone** — `MarkdownEditor`,
  `syncScroll.js` and `DocView`'s `onOutlineScroll`/`anchors` hooks were all deleted with the mode
  they served (2026-08-19; the sync had no producer left, so it was a listener computing nothing).
  What it proved is worth keeping, because it is the same trap MDH records: **`view.scrollDOM
  .scrollTop` does nothing here.** Measured against the shipping CSS of the time, the outer host
  owned a **14,002px** scroll range while `.cm-editor` (computed height `14402px`, so `height:100%`
  never resolved), `.cm-scroller` and the host div all had **0** — so a line's position had to be
  measured from the wrapper's rect minus `view.documentTop`, correct whichever element scrolls, and
  a scroll listener had to subscribe to BOTH candidates rather than resolve one at mount before
  layout settles. Pure mapping + browser-verified measurement: the
  `stageLink.js`/`smoothScroll.js`/`tether.js` split.
- **The 1:1 proof** — `tests/docs-render-equivalence.test.js` renders upstream's own
  `examples/basic/*.md` and compares **byte-for-byte** against HTML generated by localpages itself
  (checked in under `tests/fixtures/localpages/expected/`, live and export mode — "export mode" is
  a `render.js` option, kept because it is what proves fidelity to upstream, not because anything
  still exports). Regenerating those
  fixtures against a newer upstream is how a future localpages change gets migrated. The SANITIZER
  cannot be byte-identical — a DOMParser round-trip rewrites `&#x27;`→`'` and
  `<circle/>`→`<circle></circle>` — so its guard asserts it changes nothing **beyond a round-trip**,
  which is the precise claim and is what caught `tabindex`.
- **Migration hazard worth a sweep**: prose containing bare angle brackets (`<queue_id>`,
  `<invoice_number>`) rendered as literal text under `FabryMarkdown` and is now an unknown HTML
  element — the sanitizer's unwrap rule keeps children, but an empty tag has none, so such a
  placeholder becomes **invisible**. Smart quotes and auto-linked bare URLs also arrive with real
  GFM. Not defects; consequences of rendering actual Markdown.
- **Two known items, deliberately not acted on** (both in the spec): the TOC is hidden at realistic
  pane widths — upstream's 1280px threshold is the same arithmetic in a container, but a 1280px
  window leaves the pane 936px, so it needs a window of roughly 1620px+; and `beautiful-mermaid`
  embeds `@import url('https://fonts.googleapis.com/…Inter…')` inside every diagram's `<style>`, so
  a rendered diagram fetches a Google font in the pane. The second is
  upstream's behaviour too and is **pre-existing in this extension** — Fabry chat already renders
  mermaid the same way — so it was reported rather than changed.

### DevTools panel (Raw Object Editor) (`src/devtools/`)

A Chrome DevTools panel named **"Rossum"** that displays and edits the API resource backing the current Rossum page. The editor fills the panel with compact font (11px) and no header — the tab itself shows the resource identity. Detected resources (`detect.js` `detectResource`): detail routes — **queue** (`/queues/{id}` + async `/queues/{id}/settings/emails` → `queue.inbox`), **hook** (`/extensions/my-extensions/{id}`), **user** (`/settings/users/{id}`), **schema** (`/settings/field-manager/detail/{id}` and queue **Fields** tab via async `queue.schema` fetch), **engine** (`/automation/engines/{id}`), **rule** (`/queues/{q}/settings/rules/{ruleId}/detail` — matched *before* the queue row, first-match-wins), **annotation** (`/document/{id}` and `/annotation/{id}` → `/api/v1/annotations/{id}`); and read-only collection pages — **Hooks** (`/extensions/my-extensions`), **Users** (`/settings/users`), **Labels** (`/settings/labels`), **Organization Groups** (part of `READONLY_COLLECTIONS`, always non-editable). Additional: a **queue** from `/documents?filtering=…&level=queue`, and `/documents?level=all` resolves to **organization** (via `GET /api/v1/organizations` → `results[0].url`). Links open via **Cmd/Ctrl-click** or right-click **"Open in new tab"**, reaching any Rossum API URL including workspace/org and sub-resources (e.g. annotation `content`, read-only). For annotations the panel edits the **annotation object** (metadata/status/labels) via PATCH — datapoint **content** is NOT edited here (that needs the content-operations API). Resource identity uses `keyOf(apiPath)` so sub-resources (different API paths) open as distinct tabs; `readOnly` descriptor flag marks non-editable resources. 404 shows a clearer message (out-of-org, support-access user, or deleted).

- **Registrar & auth flow** — `devtools.js` creates the panel; `panel.jsx` is the panel page. Auth: the panel uses `chrome.devtools.inspectedWindow.eval` to read `{token, domain, pathname, search}` from the inspected Rossum tab's main-world context (no storage staging needed) and re-polls for SPA navigation (`inspected.js` `startBridge`, dedup keyed on domain|pathname|search|token — `search` is included so `/documents?level=all` vs `?…&level=queue` on the same path re-detect). Panel calls `${domain}/api/v1/…` with `Token` auth (reuses extension's existing `host_permissions`). Self-gated: always available on Rossum pages, no popup toggle or experimental unlock.
- **In-panel tabs** — one permanent **default (page) tab** (`.rawjson-tab--page`, visually distinct) follows the inspected page, is pinned first, and is **always visible and never closeable** (seeded at store load via `ensurePageTab()`; `syncPageTab` never drops it; `closeTab`/`closeOtherTabs` preserve it). When no resource is detected it becomes resource-less (labelled "Page") and its **body shows the "Open a Rossum queue, hook, user, …" hint** (there is no separate no-tabs empty state). **Cmd/Ctrl-click** or right-click a Rossum API URL opens a **link tab** (closeable, reorderable via drag-and-drop, pinned after the root via `store.moveTab`). Tab state lives in Preact `store.tabs` / `store.activeId`. Right-click a tab → context menu (`store.tabMenu`): **"Close"** (link tabs only — never offered for the default tab) + **"Close Other Tabs"** (`closeOtherTabs`, keeps the clicked tab *and* the default tab); right-clicking the sole default tab opens no menu.
- **Request bar & Copy as curl** — a **GET-only** omnibox in the panel's **bottom command bar** (`RequestBar.jsx`, mounted in `panel.jsx`'s `.rawjson-bottombar` beside the copy split-button): type any Rossum API path (or a full URL of the current org) and Enter/→ opens it as a tab, reusing the same `resourceFromApiUrl`→`openResourceTab` path a Cmd/click uses. The **`/api/v1/` prefix is assumed** — shown as a dimmed, non-editable adornment, never typed; the input, autocomplete, and picked values are all prefix-free. `requestInput.js` (pure) normalizes input (`normalizeRequestInput` — auto-prepends `/api/v1`, preserves the query string, rejects a different host / `..` / an unresolved `{id}`); `catalog.js` (pure) is a curated endpoint catalog powering fuzzy **autocomplete** (`suggest`, opens **upward**; ↑/↓ wrap, any typed path still fires — no known/unknown gate), with `relPath` (robustly strips a full/partial/host-qualified prefix — so typing `…/v1` never blanks the list) and `shortPath` (prefix-free display/insert); **Cmd/Ctrl-L** focuses the bar. (`isKnownCollection` remains exported for the deferred live-seed but is no longer used by the UI.) A single-resource path (no query) opens **editable**; a list/query/unknown path opens **read-only** via `genericResourceFromPath` (keyed by full apiPath incl. query, so distinct queries are distinct tabs). **Save is a floating pill** (`.rawjson-savepill`) that appears over the JSON editor only while the buffer is dirty (shows an "N unsaved changes" count via `diff.js` `buildPatchBody`, opens the existing diff→confirm→PATCH→reload on click) — it is **not** in the bottom bar, so navigation never competes with saving; read-only/preview tabs never show it. **Copy as curl** is a **split-button** in the bottom bar (`curl.js` `buildCurl`): the main button copies a **redacted** `Authorization: Token $ROSSUM_TOKEN` command (+ a `# export` hint); the caret opens a small upward menu (`store.curlMenu`) with **"Copy with live token"** — the real token (via `api.getContext()`) plus a "treat as a secret" toast. GET-only issuing keeps the bar clear of the write-lock stance; nothing new is persisted; the live token reaches the clipboard only on the explicit warned action. `store.toast` renders transient toasts (shared `showToast`, 2.5s auto-dismiss). The optional live DRF-root catalog seed (`mergeLiveCollections`) ships dormant/tested but is **not wired** pending a live-verify gate (that `GET /api/v1/` returns a browsable collection map). Spec: `docs/superpowers/specs/2026-07-17-devtools-request-bar-curl-design.md`.
- **Core UI** — CodeMirror `JsonCodeEditor` (basicSetup + `@codemirror/lang-json`). Theme-aware — `theme.js` `isDark()` (DevTools `chrome.devtools.panels.themeName`, `prefers-color-scheme` fallback) drives both the CodeMirror syntax colors (custom `HighlightStyle` approximating DevTools, light+dark) and the panel chrome (`data-theme` on the root; `panel.css`). **Cmd/Ctrl-F** is captured at the window capture phase (`keydown` listener) → focus + `openSearchPanel` on `store.views.active` (the DevTools native search bar does not appear; `search.js` was removed).
- **Content preview** — when a resource's body is NOT JSON (by response `Content-Type`; e.g. `documents/{id}/content` returns the original file), `api.getResource` returns a blob descriptor and the tab shows `PreviewPane` instead of the editor: `image/*` → `<img>`, `application/pdf` → `<iframe>` (NOT `<embed>`/`<object>` — the extension-page CSP `object-src 'self'` blocks a `blob:` object), else a file-info card; every preview has **Download** + **Open in browser tab** (both use the `blob:` object URL — a direct `${domain}${apiPath}` nav would 401). Object URL is created/revoked with the component lifecycle. Preview tabs are read-only (no Save). `contentMeta.js` = pure `extFor`/`formatBytes`/`filenameFrom`. `getJson` is kept for JSON-guaranteed calls (`via` resolution + save re-fetch).
- **Inline resource-name hints + prefetch cache** — the editor annotates every visible `/api/v1/<collection>/<id>` reference (scalar fields AND array elements) with the target object's **name**, dimmed at line end (`cmNames.js` ViewPlugin `.rawjson-name`; debounced `refreshNames` effect as names arrive). `nameResolve.js` `makeNameResolver(getJson)` resolves visible links (in-flight dedupe, ~6 concurrency cap, negative-cached errors) via a session `resourceCache.js` (`apiPath → {name, obj, at, status}`, ~200-entry cap). `pickName`: user → `username (first last)` (else `username`, else `email`); documents → `original_file_name`; else `.name`. Because resolving a name fetches the whole object, `resourceCache` doubles as a **prefetch cache**: `loadResource` reuses `deps.getCached` (≤60s `getFresh`) to open a link tab instantly with no network call, and warms `deps.putCached` on any JSON load. Cache is in-memory only (never persisted). Sub-resources (`…/content`, read-only) are never name-resolved.
- **Editing & Save** — edits generate a diff (pure `diff.js` logic) shown in a `DiffConfirm` overlay; user accepts → `PATCH` sent to the API → on success, **reloads the inspected page** (`inspectedWindow.reload`). No Undo. Reuses pure modules `detect.js` (URL→resource descriptor `{type,id,apiPath,label,readOnly}`), `diff.js` (`buildPatchBody`/`diffObjects` — diff-shown == diff-sent), Preact signals `store.js`, and `actions.js` (`loadResource`/`requestDiff`/`saveResource`, dependency-injected with `{getJson, patch}`, with a resource-change guard so a mid-save SPA nav never writes the wrong resource); components `DiffConfirm` and the lean CodeMirror `JsonCodeEditor` are in `src/devtools/`.
- **Fallback** — 403/405 (read-only org or insufficient perms) → the editor is non-editable and Save is hidden (view-only). 404 displays context (out-of-org, support-access user, resource deleted).
- **Nothing leaves the browser** — resource JSON is fetched + displayed + patched inline; no contents persisted, no sync to background/storage.

### Coupa content script

Two strategies: JSON metadata extraction from `#initial_full_react_data` script tag (React pages like invoices) and DOM attribute extraction with `IGNORE_S_CLASSES` filtering (Rails pages like POs).

### Popup

Preact JSX. Detects current site (Rossum/NetSuite/Coupa) and dims irrelevant sections. Two toggle types: storage-backed (persist in chrome.storage.local, reload tab on change) and page-flag-backed (devFeatures/devDebug, written into the page's localStorage via `chrome.scripting.executeScript` without reload). All tab IO uses `chrome.scripting.executeScript` rather than `chrome.tabs.sendMessage` so popup operations survive content-script orphaning across extension upgrades.

The popup also self-detects (Rossum context, annotation URLs only) when the open
annotation is held in `reviewing` by ANOTHER user — `status === 'reviewing' &&
modified_by !== me`, live-verified: `POST /start` on a held annotation 409s
(`conflict_user`), so the viewer is genuinely stuck read-only — and shows a warning
banner (`ReviewingLockBanner.jsx` + pure `reviewingLock.js`): SVG lock icon in a
tinted squircle, "Document locked by {plain name}" (username fallback, else "another user"),
"Read-only while they review", and a one-click **Unlock** button (owner-picked
"variant C one-step" redesign 2026-07-16 — NO confirmation, NO time/staleness line,
NO consequence caption; the earlier `session_timeout` staleness helpers were removed
as dead code). Unlock = `PATCH /annotations/{id} {status:'to_review'}` — the ONLY
non-holder-capable release (`/cancel` 409s for non-holders; patching `queue` to
itself is a no-op); it triggers NO re-extraction and to the holder is
indistinguishable from a normal session timeout (in-flight edit lost, saved edits
kept). On success the popup reloads the Rossum tab (whose frontend then auto-starts
the annotation, so the clicker takes over the lock). No storage keys, no toggle
(always on), degrades to rendering nothing on any failed read. Spec:
`docs/superpowers/specs/2026-07-16-popup-unlock-reviewing-annotation-design.md` (+ v2
revision note).

On Rossum tabs the popup widens (`body.popup-wide`, 760px) and shows the **MDH provenance
card** — "MDH on this screen (beta)" (`components/MdhProvenancePanel.jsx` → `ConfigBlock` →
`QueryItem`, engine in `mdh-provenance.js` + `actionCondition.js`, `chrome.storage.session`
caches with a 5-minute TTL in `cache.js`). For the open annotation it resolves the queue's MDH
matching hooks, substitutes the document's own field values into every configuration's query
cascade, replays each query against Data Storage and marks the outcome (`winner` / `empty` /
`skipped` / `gated` / `error`). This card is **shared with the side panel** (below) — it is the
one component rendered by two surfaces.

**The Row picker is scoped to ONE table — the one holding the config's target field**
(`mdh-provenance.js` `rowScopeForConfig`, owner's rule 2026-08-10, fixing a customer report).
`flattenContent` therefore returns `tables` (`[{schemaId, rowCount, columns}]`, one entry per
multivalue) beside the flat `rowValues`; the older global `rowCount` (the MAXIMUM across every
table) is kept for compatibility but must never drive the picker again. It was the bug: a
document with a 4-row tax table beside 23 line items offered **23** rows to the tax config, and
rows 5+ substituted `''` — so the replay showed a cascade MDH never runs (an
`'{tax_description}' != ''` condition flips to false and every query renders `gated`). A
header-level target falls back to the table its own row placeholders come from (most-referenced
wins), and `null` means no picker. Two consequences worth keeping: row selection lives in
`rowByTable` keyed by table schema_id, so configs on *different* tables no longer drag each
other onto a row number the smaller table doesn't have (configs sharing a table still move
together, which was the useful half); and the stored index is **clamped** to the table's length
rather than trusted. `configUsesLineItems` counts `actionConditionPlaceholders` too — the
condition is evaluated against the selected row, so a config gated only on a row field is
row-scoped just as much as one whose query uses it. Columns are collected **structurally**
(a column counts even with no usable value) because an MDH *target* field is normally empty
until the hook fills it, and the target is precisely what gets looked up. The annotation cache
prefix is at `mdhProv:ann:v4:` for the added `tables`. **Query hints never occupy layout** (2026-08-12): the per-query hint used to render as a `flex-basis:100%` line INSIDE the `<li>`, appearing only once a replay resolved and growing the row by 1-N lines — the layout shift. All three hint-bearing statuses (`error`/`skipped`/`gated`) now show it in a `role="tooltip"` popover anchored to the status dot, on hover AND focus (`tabIndex=0`), closing on leave/blur/Escape/scroll/resize. `position: fixed` is load-bearing (`#app` is `overflow:hidden`; verified no ancestor of `.mdh-q` sets transform/filter/perspective/will-change, which would re-clip it); placement + viewport clamping are pure in `src/popup/hintPlacement.js`. The dot is fixed-size and the config caption/Row picker derive synchronously, so `.mdh-q-detail` was the ONLY incremental shift source — it is deleted.

**LIVE-VERIFIED 2026-08-10 (elis): `GET /annotations/{id}/content?schema_id=a,b` IGNORES the
filter.** A bogus schema_id still returns the entire tree (96 fields), and the response's
`results` key is a byte-identical duplicate of `content`. Nothing may depend on that parameter
narrowing the payload — but the flip side is load-bearing: the panel always receives every
section, table and column, which is why the table behind a config's target can be located with
no second request and no schema-ancestry inference. Also verified there: a multivalue node
carries its own `schema_id` (so the picker can name the table), tuples are `children` entries
with `category:'tuple'`, and every column appears in every tuple even when empty (`value: ""`).

### Side panel (MDH provenance)

A Chrome side panel (`chrome.sidePanel`; the permission is **warning-free**, so adding it does
NOT disable existing installs — unlike a `host_permissions` change) hosting the **same** MDH
provenance card as the popup. The card deliberately lives in **two** places (owner decision
2026-08-07): the popup keeps it unchanged, and the panel adds the persistence a Chrome popup
cannot have — a popup closes on blur and no API prevents that, which is the whole point of the
feature request behind it. Spec:
`docs/superpowers/specs/2026-08-07-mdh-provenance-side-panel-design.md`.

- `src/sidepanel/index.jsx` → `components/App.jsx` resolves the **active tab of its own
  window** and follows it via `tabs.onActivated` (filtered to that window) + `tabs.onUpdated`
  (a `changeInfo.url` on the tracked tab, or on ANY tab while none is tracked yet — the
  recovery arm). **LIVE-VERIFIED 2026-08-07 (elis):** `onUpdated` fires with `changeInfo.url`
  for BOTH `history.pushState` and `history.replaceState`, so those two listeners alone follow
  Rossum's SPA document switches; an earlier 2.5s poll was measured redundant and REMOVED (the
  panel's `visibilityState` is `'visible'` while the page tab has focus, so it had been
  running). Reading `tab.url` needs **no `tabs` permission** (that one warns; the Rossum
  `host_permissions` already expose the URL, same as `findRossumTabs`).
- `targetTab.js` is pure (`annotationIdFromUrl` / `isRossumTab` / `viewState` / `sameTarget`).
  `components/DocumentStrip.jsx` is the only new UI: it names the document being shown —
  `#<id>` immediately, upgraded to the file name when
  `GET /annotations?id=…&sideload=documents` resolves, id retained on any failure.
- `MdhProvenancePanel` is reused **as-is** from `src/popup/`, remounted via
  `key={annotationId}` so its existing load-and-replay effect handles document switches with no
  changes — and so a URL change *within* the same document does not trigger a replay. Its only
  new prop is the optional **`onPin`**: the popup passes a handler
  (`chrome.sidePanel.open({windowId})` + `window.close()`, feature-detected on
  `chrome.sidePanel?.open` so pre-114 Chrome never sees the button), the panel passes none, so
  the pin button is popup-only.
- Styling: `sidepanel.html` links `../popup/popup.css` **first** (one source of truth for the
  card, dark mode included); `sidepanel.css` only neutralises the popup's 380px width and 600px
  cap and adds the `.sp-*` strip/empty-state rules.
- **Scoped to Rossum tabs** (`src/sidepanel/panelScope.js`, pure; applied by the service
  worker). LIVE-VERIFIED 2026-08-07, and none of it is guessable from the API surface: a
  per-tab `enabled:false` does NOT hide a panel opened with `open({windowId})` — only a global
  default OFF plus per-tab `enabled:true` plus `open({tabId})` scopes it. On other tabs the
  panel then reports `visibilityState:'hidden'` with its page kept ALIVE, and returns by itself
  (no re-pinning) on an enabled tab. A global `setOptions({enabled:false})` closes an open panel
  outright; a second Rossum tab is enabled but not open until pinned there; a tab that
  navigates away with the panel open has it closed by Chrome. The worker syncs every tab on
  wake (per-tab FIRST, then the global default — the reverse order briefly closes an open
  panel) and re-decides on `tabs.onUpdated`. **Gotcha:** navigating away to a site we hold no
  host permission for delivers NO url (not in `changeInfo`, not on `tab`) — that absence is the
  "left Rossum" signal, so `panelUpdateFor` reads `tab.url` and acts on `url` OR `status`
  events; keying on `changeInfo.url` left departed tabs enabled forever.
- Reuse over extraction: the panel imports the MDH modules from `src/popup/` rather than
  hoisting them to a shared directory (the way `src/agent/` was hoisted). It would still have
  to import `utils.js`/`tab-readers.js` from `src/popup/` anyway, so the move buys partial
  tidiness at the cost of churn. Extract when a third consumer appears.

## Chrome Storage Keys

- Feature toggles: `schemaAnnotationsEnabled`, `expandFormulasEnabled`, `expandReasoningFieldsEnabled`, `scrollLockEnabled`, `resourceIdsEnabled`, `netsuiteFieldNamesEnabled`, `coupaFieldNamesEnabled` (the short-lived `inspectAnnotationEnabled` toggle was removed 2026-07-04 along with the floating button, and the in-page `rawObjectEditorEnabled` toggle was removed 2026-07 with the in-page Raw Object Editor surface; the `fabryDeepVerifyEnabled` + `fabryArchitectImplementEnabled` popup toggles were removed 2026-07-14 — both features are now ON by default within the Fabry app, which is public since 2026-08-11; any stored values are orphaned; the `annotateForMeEnabled` toggle and the whole Annotate-for-me feature were REMOVED 2026-07-20 — proven not feasible: vision box precision capped ~0.4 IoU and the write path never had a server-side read-only guarantee; any stored `annotateForMeEnabled` value is orphaned)
- Hidden-features unlock: `experimentalUnlocked` — flipped by 5 quick clicks on the popup's version hash; the extension's ONE gate, hiding the Academy Console app (live via `chrome.storage.onChanged`). It gated the Fabry Console app until 2026-08-11, when Fabry went public; it was formerly also the second half of the Annotate-for-me double-gate, removed with that feature 2026-07-20. It absorbed the retired `trainingUnlocked` key — see Onboarding training state below.
- Console staging auth: `consoleAuth_<uuid>` (single-use, 24h TTL, removed on first read; carries `app` + optional DS pipeline prefill)
- Console state: `consoleActiveApp` — per-tab (see MDH state below: session-first read with a `chrome.storage.local` seed)
- Side panel state: **none** — Chrome remembers open/closed per window. The panel shares the popup's `mdhProvenanceFilter` (the card's schema-ID filter) and its `mdhProv:*` `chrome.storage.session` caches
- MDH state: `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`, `mdhOverviewChartsScale`, `mdhResultsView`, `mdhStagesAutoscroll`, `mdhStagesSampleSize`, `mdhStagesShowDef`, `mdhStagesSourceOpen`, `mdhShowHiddenCollections` (reveal this extension's own collections in the sidebar) are **global** (shared across tabs, persisted in `chrome.storage.local`). The **navigation** keys `mdhActiveView`, `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch` (and the Console-level `consoleActiveApp`), plus `fabryActiveChat` (per-tab, content-free server chat id for the Fabry Chat app), `fabryMode` (per-tab, content-free Chat|Architect sub-app selection), and `fabryArchitectActive` (per-tab, content-free open-deliverable id for Architect), are **per-tab**: read session-first from `sessionStorage`, written to BOTH `sessionStorage` (this tab's truth on reload) and `chrome.storage.local` (cross-session seed for a freshly-opened tab), via `src/console/tabState.js`. `mdhLastPipeline::<scope>::<collection>` is keyed per-org **and per-collection** (legacy un-collection-scoped `mdhLastPipeline::<scope>` entries from older builds are orphaned, not migrated).
- Audit state: `auditActiveSource`, `auditFiltersBySource`
- Galaxy state: none (no persisted state in v1)
- Fabry Chat state: `fabrySidebarWidth` is a **global** layout pref (sidebar drag-resize, clamp 200–420; the sidebar collapse toggle was removed, so the former `fabrySidebarOpen` key is orphaned/unused); `fabryArchPdfOptions` (`{contents,verdicts}` — what a printed specification includes; the scope is asked per use, these are remembered) is a **global** pref; `fabryArchDocView` is now **`edit`|`preview`** (a stored `split` maps to `preview`), `fabryArchRailOpen` (default true) and `fabryArchRailWidth` (default 322, clamp 260–620) are the inspector's collapse and width — also global. There is deliberately no list-collapse pref: the deliverable list is always shown. `fabryArchSplitRatio` and `fabryArchConsoleHeight` are **orphaned** (2026-08-19): the combined mode and the bottom console they sized no longer exist, and nothing reads or migrates them; `fabryActiveChat` (open chat id), `fabryMode` (Chat|Architect sub-app selection), and `fabryArchitectActive` (open Architect deliverable id) are the only other persisted values — all per-tab (tabState pattern) and content-free; chat content/images/transcripts and Architect deliverable text/evidence never touch storage (server-owned; privacy constraint — deliverables, their last results AND their version history live in the `_SA_EXTENSION__fabry_architect` Data Storage collection, in-memory otherwise)
- Inspector state: `rossumViewedAnnotations` — annotations the user OPENED IN THE ROSSUM UI (`{id, origin, at}`, deduped by (origin,id), newest-first, cap 12), written by the always-on `track-viewed` content-script feature (pure tracker, no DOM) and read by the Inspector landing, which also live-refreshes via `chrome.storage.onChanged`, which filters to the connected org's origin (cap 8 shown) and enriches file/queue/status via ONE sideloaded call (`/annotations?id=<csv>&sideload=documents,queues` — verified live). Clear-all removes only the current origin's entries. Opening the Inspector lands on this list — only an explicitly staged `pendingAnnotationId` (deep-link) auto-loads. (Legacy keys `inspectorRecents` [investigated-recents, retired 2026-07-04] and the older per-tab `consoleInspectorAnn` are orphaned, not migrated.)
- AI pipeline input availability: cached in **`sessionStorage`** (key `mdhAiAvailable_<org>`), NOT `chrome.storage` — ephemeral per-session result of the `/internal/llmchat` probe, so availability is never persisted at rest.
- Onboarding training state: `trainingProgress` (per-org-origin progress + any issued receipt, capped at 3 orgs). The gate is the shared `experimentalUnlocked` above; the former `trainingUnlocked` key (2026-08-07 to 2026-08-11) is orphaned, never migrated — no profile can hold it without `experimentalUnlocked`, so nothing was lost.
- Usage data (**opt-in, off by default**): `usageConsent` (`true`/`false`/**absent** — absent means *never answered*, which is why `App.jsx` reads it separately from the `!!`-coercing `STORAGE_TOGGLES` loop), `usageClientId` (random uuid, minted **lazily by the worker on the first event** — not at consent time, so nothing durable depends on a message reaching it — and **deleted on revoke** together with `usageSessionId`, so a re-opt-in is unlinkable), `usageAsked` (`true` once the consent overlay has ever been **shown** — separate from `usageConsent` so the ask appears exactly once and never nags); plus `usageSessionId` in `chrome.storage.session`. `usageSnapshotDay` (the UTC `YYYY-MM-DD` marker for the retired once-a-day config snapshot) is **orphaned** as of 2026-08-19 — read by nothing, written by nothing, and deliberately NOT cleaned up from existing profiles (same convention as `trainingUnlocked` and `fabryArchSplitRatio`).

## Usage data (opt-in)

Answers "which features are actually used" so unused ones get deleted instead of maintained. **The service worker is the ONLY sender.** Specs: `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md` (the original build) and `docs/superpowers/specs/2026-08-19-usage-tracking-simplification-design.md` (the 2026-08-19 simplification, which is what the bullets below describe).

- **`src/usage/event.js`** (pure) — the closed vocabulary of **44** names (`EVENT_NAMES`, `sa_<surface>_<action>`) + `buildPayload()`. **Every event is just a name**: there is no `params` argument and no allowlist, because no caller can supply a field — the leak guard is **structural** rather than validated. (It WAS a `PARAM_SPEC` allowlist until 2026-08-19; the last caller-supplied param, `feature`, left with the popup's toggle events.) The payload is always `{ ext_ver, session_id, engagement_time_msec }`. **`session_id` and `engagement_time_msec` cannot be removed** — Google requires both for user activity to reach GA4's standard reports, so dropping either stops the property counting users. The old 25-param and 130KB caps are **gone because they are unreachable by construction** (a 36-char uuid + a ≤40-char name + three fixed fields ≈ 250 bytes); restoring them would guard nothing. The GA4 name-format regex moved from a per-send branch to a test over `EVENT_NAMES`, since a closed literal list is checkable once. Adding an event = adding it here **and** to `PRIVACY.md` (a test enforces the pairing).
- **`src/usage/track.js`** — `track(name)` / `trackOnce(name)`, **single-argument since 2026-08-19**: `chrome.runtime.sendMessage`, never awaited, never throws, always returns `undefined`. `trackOnce` collapses the MutationObserver-driven overlay features to one event per page load. Feature modules call these at the point where the feature has **acted**. Enablement is no longer reported at all — see the losses bullet below.
- **`src/usage/collect.js`** — worker side: consent gate (`usageConsent !== true` → silent drop, no id, no fetch), session id, and the single GA4 Measurement Protocol `fetch`. The **client id is minted lazily here** on the first event. **`src/popup/usageConsent.js`** owns the consent WRITE, straight to `chrome.storage.local` — NEVER via a worker message: measured 2026-08-03, the message path left `usageConsent` ABSENT right after the click and present only ~50ms later (worker cold start), so closing + reopening the popup inside that window read "off". Nothing durable may depend on a message reaching the worker; lazy minting also heals profiles the old flow left with consent but no id. Reads an **explicit key list**, never `getLocal(null)` (the local store also holds staged `consoleAuth_*` tokens). The module-level **serialization queue is still load-bearing and must not be deleted as dead weight**: the lazy client-id mint is a check-then-act across an await, so a burst on a fresh profile would otherwise mint several ids and send events under different identifiers. Any `params` on an incoming message is **ignored, never forwarded** — which is what makes an orphaned content script from an older build harmless after an upgrade.
- **`src/usage/ga4Config.js`** — `MEASUREMENT_ID` / `API_SECRET`, holding the **real** property values. Extractable from the bundle by design (accepted: roadmap signal, not a security input), which is why the property is dedicated to this extension and forged events are detectable against the published vocabulary. Rotating costs a full Chrome-review release, because the secret is baked in.
- **No manifest change.** VERIFIED 2026-08-03 by probe: the worker's `fetch` to `https://www.google-analytics.com/mp/collect` returns 204 with **no** host permission for that host.
- **Consent UI** — `src/popup/components/UsageStrip.jsx` (renamed from `UsageCard.jsx` on 2026-08-19). **ONE surface, two modes.** It replaced a blocking modal overlay that was both the first ask and the reopened review; `UsageCard`, `.usage-overlay`, the scrim, the dialog/`aria-modal` semantics and `overlayMode` are all **deleted** — 143 lines of CSS and a 68-line component. A wall in front of the product is a poor way to earn a yes, and once the ask is non-blocking there is nothing left for a modal to do. `.usage-strip` sits **in flow** at the top of the popup body, sized and spaced like a `.card` with only an accent left border marking it out, rendered **outside** the `site` branch in `App.jsx` so it reaches people whose tab is not Rossum/NetSuite/Coupa. **There are no modes in the markup**: `reviewing` decides only WHETHER the strip is on screen, and the two renderings are byte-identical (pinned by an `outerHTML` comparison test). It briefly carried a `Currently on/off` line and a `×`; removing both left the modes with nothing to distinguish them, so the distinction went too. With no close button, the way out of a review that changed nothing is the footer control that opened it — `UsageFooterButton` takes `onToggle`, and `App.jsx` passes `setReviewingUsage((v) => !v)`. There is still no way to dismiss the FIRST ask without answering, by design: both its buttons are answers and it blocks nothing meanwhile. **The strip persists until ANSWERED, and that is forced by it not blocking**: `stripVisible({ consent, reviewing })` (pure) is true for `consent === null` or an explicit `reviewing`, using the deliberate three-valued state in `App.jsx` (`undefined` = storage unresolved, `null` = never answered, `true`/`false` = answered). Keying it on `usageAsked` instead would show it exactly once, and a strip nobody is forced to look at, shown once, is simply missed — strictly worse than the modal it replaced. **Timing is unchanged**: `consent` resolves on the first popup open, so that is still when it first appears. `usageAsked` also keeps its exact meaning ("the ask has been shown") and its only job (making the footer control reachable) — but `App.jsx` guards its write with `asked === false`, which is **load-bearing rather than defensive**: the strip is on screen for EVERY open until answered, so without it the flag would be re-written each time (caught by `tests/popup-training-gate.test.js`, which seeds `usageAsked: true` precisely to keep that write out of its assertions). The `askOnScreen` prop deliberately omits `reviewing` — a footer reopen is not a fresh ask. **The ledger is a LINK, not an in-popup block** (owner, 2026-08-19, to cut vertical space in a popup Chrome caps at 600px). A collapsed `<details>` ledger was built first and removed; the argument for keeping it — that "feature name, extension version, a random ID" is the most persuasive content on the surface, so sending people to a markdown file to find it may cost acceptances — was raised and decided the other way. `PRIVACY.md` is now the ONLY place the ledger lives. **`Currently on/off` went with it**, and is not missed: the footer control the user clicked to get here already reads `Usage data on`/`Usage data off` with a state dot, so the setting is adjacent rather than lost. `Reversible any time.` lived in that block and went too; `PRIVACY.md` carries the authoritative version. `.usage-strip-actions` being `display: flex` is **load-bearing for both** the button spacing and the right-aligned link (`margin-left: auto` is inert without it). That rule was deleted by accident on 2026-08-19 while removing an adjacent block, and **every one of the 3388 tests stayed green** while the link sat flush against "No thanks" — jsdom has no layout, so nothing in the suite could see it. `tests/popup-usage-strip-css.test.js` now reads the stylesheet as text and asserts the rule, which is crude but is the only thing here that catches this class of bug. The strip is **106px** at 380px and **89px** on a Rossum tab (measured) — one paragraph and one action row, with the unnumbered `What's sent ›` link riding the far end of the action row at zero vertical cost. One consequence, accepted: a failed `chrome.storage` read sets `consent = null`, so the strip SHOWS where the old fallback stayed silent — harmless now that the ask blocks nothing. `UsageFooterButton` sits in the **footer** (the only region rendered on every page), renders as soon as `asked` is true **even if unanswered** (otherwise there is no way back in), and does **NOT** flip the setting — it toggles the strip, so a change of mind happens next to the explanation. Known quirk, pre-existing and not worsened: for a user who has been asked but never answered, the strip is on screen unconditionally, so the footer button toggles `reviewing` with no visible effect. Copy is in **"we" voice** (owner-supplied draft, 2026-08-03; it superseded an earlier no-first-person instruction — that guard test was removed). **Vocabulary is unified on "usage data"** across strip, footer, `PRIVACY.md`, README and the store sentence. The UI never says **telemetry**/measuring/tracking/counting — a test fails on those stems. "telemetry" is excluded deliberately: the 2021 Audacity revolt happened against an opt-in, off-by-default telemetry feature, so the word itself is the risk with a technical audience (Google's *Measurement Protocol* keeps its product name in `PRIVACY.md`). Headings `What's sent` / `What's NEVER sent`; button `Share usage data`; footer `Usage data on`/`Usage data off`. Says **extension**, never "plugin" (test-guarded). Engineering names use the same plain prefix: `src/usage/`, `usageConsent`, `sa-usage` (renamed from `src/telemetry/` 2026-08-03). `App.jsx` withholds first paint until `storageValues`, `consent` **and** `asked` resolve.
- **`PRIVACY.md` is the single source for the event list** — no in-popup expander (prototyped, rejected: it duplicated every entry into the bundle). The endpoint constants live in `ga4Config.js`, NOT `event.js`, so the worker's bundle is the only one that names the analytics host. Note the older claim that this keeps `event.js` "importable from any surface" described a hypothetical: VERIFIED 2026-08-19, **nothing under `src/` imports `event.js`** — only `collect.js` and the tests do. The split is kept for the repo's pure-module/impure-glue convention, not because a second importer exists.

- **Every event fires where the feature ACTED, never where it attached, mounted or was refused.** Audited across all 44 call sites on 2026-08-19 and four sites were corrected: `sa_rossum_scroll_lock` fired inside `initScrollLock` (i.e. on every Rossum page carrying a sidebar — a disguised *enablement* count, exactly what deleting the snapshot was meant to stop) and now fires from `armLockWindow`'s `restoreTo`, only when the position really moves; `sa_audit_search` counted every next-page click, because `Pagination.jsx` patches `page`/`cursor` through the same `filtersBySource` object the tracking effect watches — the signature is now `store.searchSignature`, which drops those two keys (the effect still re-queries on a page turn; only the COUNTING skips it); `sa_mdh_stages_view` counts the TRANSITION into the view rather than the click, since the segmented control has no `v === view` guard and re-fired on the already-active button, and the debug-panel row click fired on every stage jump. It was briefly made `trackOnce` by analogy to `sa_mdh_query_run` and that was **reverted the same day** — the analogy is wrong: `runQuery` is auto-invoked on every keystroke, sort, filter and page change, so no user intent maps onto a call, whereas opening Stages is a deliberate click and collapsing it threw away exactly the "how often" the event exists to report; and `sa_audit_fabry_ask` / `sa_inspector_followup` moved below their "one at a time" streaming guards, where `fabry/chat.js` and `architect/actions.js` already had theirs. The audit also turned up a **pre-existing bug in the feature itself, now fixed**: `scroll-lock.js`'s scroll handler called `markUserScrollActive()` BEFORE reading `now`, so `now <= userScrollUntil` always held and **its restore branch was unreachable** — the listener only ever recorded the position, and the only thing keeping the feature alive was `armLockWindow`'s pre-emptive write. The case the file header actually describes (Rossum resets scrollTop *later* in the lock window) was never corrected. The handler now reads the user-activity window before touching it (`const userDriven = now <= userScrollUntil`) and extends it only when the run is already the user's — which still covers MOMENTUM scrolling, where scroll events keep arriving with no further wheel/touch/key input. **Consequence worth knowing:** a scroll with no preceding input event is no longer adopted as the saved position, because attributing someone else's scroll to the user is precisely how Rossum's reset used to be recorded as intent.
- **What the 2026-08-19 simplification gave up, knowingly.** "Enabled but never used" can no longer be told apart from "never discovered" — the daily `sa_config_snapshot` and its 8 GA4 custom metrics are gone, and GA4's Active Users supplies the install denominator instead. `devFeaturesEnabled` and `devDebugEnabled` are now **completely unmeasured**: they are page flags written into the page's own localStorage, so the extension cannot observe their use and the removed toggle event was their only signal. Historical `sa_config_snapshot` / `sa_popup_toggle_*` rows stay in GA4 forever and simply stop growing, because GA4 offers neither rename nor backfill — which is also why **no surviving name was renamed**.
- **Guards** — `tests/usage-boundary.test.js`: only **`src/usage/ga4Config.js`** may name `google-analytics.com` (endpoints live with the credentials so `event.js` stays importable by any surface), asserted against `src/` **and** the built `dist/` — where it also asserts `dist/background.js` *does* contain the host, so it cannot pass against a stale build. `tests/usage-console-events.test.js`: every `sa_*` literal in `src/` must exist in the vocabulary — a typo'd name is silently dropped and would read as "nobody uses this feature". Since 2026-08-19 the boundary test also **pins the payload shape to `PRIVACY.md`'s "containing exactly" promise** (every name must build exactly `{ ext_ver, session_id, engagement_time_msec }`) and requires every name to appear in the document **in backticks**. That first guard exists because deleting `PARAM_SPEC` removed the visible allowlist that used to make the promise self-evident — without it a future fourth field would silently falsify a published privacy policy. Both were verified falsifiable by mutation, not just observed green.

## CSS Architecture

- **Console** (`console.css`): CSS custom properties for all colors, surfaces, typography shared by the Console's apps (Dataset Management, Audit, and Galaxy — Galaxy adds `.galaxy-*` rules). Includes `.app-rail*` rules for the left app-switcher rail. Dark mode via `@media (prefers-color-scheme: dark)` overriding `:root` variables. Semantic color variables: `--accent`, `--success`, `--warning`, `--danger` plus `-hover`, `-bg`, `-fg`, `-border` variants. (`mdh.css` was renamed to `console.css`; `audit.css` was removed — the Audit app now uses `console.css`.)
- **Document styling** (the localpages port): `console.html` links three more sheets AFTER the two above — `github-markdown.css` (GitHub's own, light+dark), `hljs-github.css` (highlight.js light + dark wrapped in a media query, concatenated by `build.js`), and `doc-theme.css` (the ported `src/docs/theme.css`). They are scoped in practice to `.markdown-body` / `.docs-*` / `.toc` / `.state-*` / `.source-*` / `.section-preview` / `.code-copy-btn`; the only class names shared with `console.css` are `active`/`failed`, and both sheets only ever use them compound or descendant-scoped, so neither leaks into the other (checked, and worth re-checking before adding a bare class to either).
- **Popup** (`popup.css`): Separate variable system, also supports dark mode.
- **Content scripts**: Inject styles dynamically via `init()` functions (styles only in DOM when feature enabled). All classes prefixed `rossum-sa-extension-*`.
- **CodeMirror**: Custom highlight themes (light + dark) in `JsonEditor.jsx` matching the JSON tree renderer colors via `@lezer/highlight` tags.

## Dependencies

- **preact** + **@preact/signals** — UI rendering and reactive state for the popup and Console apps (MDH, Audit, Galaxy)
- **codemirror** + **@codemirror/lang-json** + **@codemirror/lang-markdown** + **@codemirror/theme-one-dark** — JSON/pipeline editor with MongoDB operator autocompletion (lang-json); the unified specification view's per-deliverable Markdown source editors (`components/SourceEditor.jsx`, lang-markdown — content-height, page-scrolled, one per deliverable)
- **markdown-it** + **markdown-it-github-alerts** + **markdown-it-anchor** + **highlight.js** + **github-markdown-css** — the localpages port's document renderer (see that section). Pinned to EXACT versions (no carets) because the golden-file equivalence test compares byte-for-byte against upstream localpages' own output; a minor bump could change rendering with no code change. markdown-it + both plugins + hljs core-and-11-grammars = 219,393 B bundled (+12.2% on console.js); the full hljs grammar set would have been 1,080,512 B. All verified CSP-clean (zero `new Function`, zero `eval`)
- **json5** — lenient JSON parsing (allows trailing commas, unquoted keys in pipeline editor)
- **beautiful-mermaid** — diagram rendering for Fabry chat replies (replaced the 3.3MB `mermaid` package). SYNCHRONOUS `renderMermaidSVG(text, themeOpts)` (flat `{bg, fg, accent, ...}` theme read live from the console tokens — `themeFromTokens`); escapes label text itself (probe-verified); throws on invalid input → code-fence fallback. Ships one flat ~1.5MB module (no tree-shakable subpaths), so it's bundled as its OWN lazy entry (`src/fabry/mermaidEntry.js` → `dist/console/mermaid.js`, registers `window.__fabryMermaidSvg`) script-injected on the first mermaid fence (`src/ui/fabry/mermaidLoader.js`); output parsed via DOMParser text/html (no innerHTML sinks)
- **three** + **d3-force-3d** — WebGL rendering + force-directed layout for the Galaxy app. The scene is hand-rolled on these directly; `3d-force-graph` was deliberately avoided (its bundled ngraph engine uses `new Function`, which the Console page's default MV3 CSP forbids). Adds ~360KB to `console.js`.
- **esbuild** (dev) — bundler

## Key Patterns

- **A raw control byte in a source file makes it invisible to git AND to grep.** `SpecView.jsx`
  carried a memo cache key written with LITERAL `\x00`/`\x01` delimiters instead of the two-character
  escapes, and the consequences were both silent: `git diff --numstat` reported `-  -` (git had staged
  a 345-line component as a **binary blob** — no line diff, no blame, no textual merge), and ugrep's
  `-I` skipped the file entirely, so every `grep` across `src/` came back clean while the largest new
  component went unread. That is how a `ReviewHost` referenced-but-never-defined survived a review
  pass. Two cheap checks: `file <path>` on a source file must not say `data`, and
  `git diff --numstat` must show real line counts. Write control characters as escapes.
- Most features are gated behind chrome.storage.local toggles controlled via popup. The `closable-tooltips`, `dataset-mgmt-suggest`, and `track-viewed` features are always on (no toggle, no storage key) and are not advertised in the popup UI. `dataset-mgmt-suggest` self-gates on the legacy MDH web app path (`/svc/master-data-hub/web/`).
- Rossum entry point builds handlers array from enabled settings — disabled features add zero overhead
- NetSuite and Coupa content scripts are self-contained single files (no MutationObserver pattern)
- **Annotation-URL parsing has ONE home: `src/rossum/annotationUrl.js`.** It answers two
  deliberately separate questions — `annotationIdFromPath` (is this DASHBOARD ROUTE an
  annotation? anchored, so an API path must not match) and `annotationIdFromInput` (what did a
  human paste? bare id / dashboard URL / API URL). Adopted by the side panel, Inspector
  `IdInput`, DevTools `detect.js` (via the exported `ANNOTATION_PATH_RE`), `track-viewed`, and
  MDH `PlaceholderInputs` (`parseAnnotationId` is an alias). It replaced six sites carrying four
  regexes that disagreed (`track-viewed` missed `/annotation/`, `PlaceholderInputs` missed the
  singular, `detect.js` missed the plural). **`src/popup/tab-readers.js` keeps its own copy on
  purpose** — its functions are serialized into the page by `executeScript` and cannot close
  over an import; both carry a comment saying change one, change the other.
- **MDH placeholder grammar has ONE home: `src/mdh/placeholderSyntax.js`** (`VAR_RE` whole /
  `VAR_RE_G` embedded). The popup/side-panel provenance engine imports it rather than keeping
  the identical private pair it used to have — both model the SAME server-side substitution, so
  a change to one that missed the other was a silent divergence. Safe to share the `/g`
  instance: every consumer uses `matchAll`/`replace`, never a stateful `exec` loop. (Still
  duplicated and NOT yet reconciled: `unquoteArg`/`applyModifier` exist in both
  `mdh/hooks/usePipeline.js` and `popup/mdh-provenance.js`, and their no-modifier/unknown paths
  genuinely differ — `String(val)` vs pass-through. Reconciling changes behaviour, so it is a
  deliberate follow-up, not an oversight.)

## JSX escape sequences

Unicode escapes (`\uXXXX`) DO NOT work in JSX raw text children or JSX attribute values — they render as the six literal characters `\u2013`, not as the intended glyph. This is because JSX text is parsed as HTML-like content, not as a JS string literal.

Three safe ways to render unicode glyphs in JSX:

1. **Wrap in a JS expression:** `{'\u2013'}` (the braces make it a JS string literal).
2. **Use the literal character directly:** `–` (paste the actual character into the source).
3. **Use an HTML entity** in text children: `&ndash;` (works in JSX text but not in attributes).

What DOES work: `\uXXXX` inside template literals and regular strings (`const label = 'foo \u2013 bar'`), inside `title=` attributes when the whole value is an expression (`title={\`foo \u2013 bar\`}`), and inside `style` strings.

Common offenders: en-dash `\u2013` / em-dash `\u2014`, ellipsis `\u2026`, arrows `\u2192`, chevrons `\u25BE` / `\u25B6`, checkmarks `\u2713`. When mixing with expressions (e.g., `{a}\u2013{b}`), the escape gets rendered literally — write `{a}{'\u2013'}{b}` instead.
## Versioning

Fully automated via `build.js` — no manual version bumping. At build time:

- `git rev-parse --short HEAD` → short commit hash (e.g., `2d935b1`)
- `git rev-list --count HEAD` → total commit count, split into Chrome-compatible `major.minor` (each segment 0–65535)
- `manifest.json` in `dist/` gets `"version"` (commit-count) and `"version_name"` (git hash) injected
- Popup reads `chrome.runtime.getManifest().version_name` at runtime to display the hash

Source `manifest.json` has a placeholder `"version": "0.0"` — never edit it manually.

## Release Process

Releases are automated via the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`), triggered manually:

1. Go to the repo's **Actions** tab → **Release** → **Run workflow** (on `master`).
2. The `test` job runs `npm ci → npm run build → npm test`. If it fails, nothing
   is published.
3. On green tests, the `release` job rebuilds, zips `dist/`, and uploads +
   publishes to the Chrome Web Store (public). Chrome review still applies
   (usually days).

One-time credential setup (Google Cloud OAuth + the five `CWS_*` GitHub secrets)
is documented in [`docs/chrome-web-store-release.md`](docs/chrome-web-store-release.md).

Notes:
- The version is derived from the git commit count (see Versioning), so each new
  commit yields a higher, valid version automatically. Re-running the workflow
  from the **same commit** fails the upload (duplicate version) — advance a
  commit to re-release.
- The manual ZIP-and-upload via the Developer Dashboard is still available as a
  fallback if the workflow is unavailable.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
