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

Nine esbuild entry points:

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
script (`src/rossum/features/training-quest.js` + `training-pointer.js`), which
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
- **Anchoring is href-only, and degrades silently** (`training-pointer.js`
  `resolveAnchor`): the pointer arrow matches a step's `anchor.hrefIncludes`
  substring against real `a[href]` elements only. LIVE-VERIFIED 2026-08-07: Rossum's
  own navigation (`/documents`, `/extensions/my-extensions`, `/queues/<id>/…`,
  `/document/<id>`) is built from real anchors, not JS-only routing, so this is a
  contract worth relying on — CSS class names are not, and are never matched on. A
  step is free to omit `anchor` entirely (most `self` steps and several detail-page
  `visit` steps do). If the anchor never resolves within the retry window, **no
  arrow renders and nothing else happens** — the card's plain-text hint still
  carries the step regardless, because a stale selector must never read as a
  blocked step.
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
  `training-pointer.js`). A tick suspended on a fetch or a storage write when the
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
  `__mrfabry_architect` Data Storage system collection — one doc per deliverable
  `{_id, kind:'requirement', text /*markdown*/, order, createdAt, editedAt,
  lastVerdict, lastEvidence, lastChatId, ranAt}` (the collection name is a single
  cosmetic constant in `architect/api.js` — no code parses the `__` prefix,
  swappable). The deliverable **list lives in the sidebar** (`ArchitectSidebar`,
  rendered by `Sidebar.jsx` in architect mode). Each row shows a concise **title**
  (`format.displayTitle` — an AI-generated title via read-only `generateTitle`/
  `backfillTitles` [`title.js` prompt; persisted `title`], or a manual **Rename…**
  from the kebab; falls back to the Markdown first line) + a run-status dot + a
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
  LIVE GATE before non-dogfood use: confirm the server accepts a `__`-prefixed
  collection create + doc write on elis (client + MDH app verified clean;
  DocumentDB reserves only `system.` — swap the constant if rejected).
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
- MDH state: `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`, `mdhOverviewChartsScale`, `mdhResultsView`, `mdhStagesAutoscroll`, `mdhStagesSampleSize`, `mdhStagesShowDef`, `mdhStagesSourceOpen` are **global** (shared across tabs, persisted in `chrome.storage.local`). The **navigation** keys `mdhActiveView`, `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch` (and the Console-level `consoleActiveApp`), plus `fabryActiveChat` (per-tab, content-free server chat id for the Fabry Chat app), `fabryMode` (per-tab, content-free Chat|Architect sub-app selection), and `fabryArchitectActive` (per-tab, content-free open-deliverable id for Architect), are **per-tab**: read session-first from `sessionStorage`, written to BOTH `sessionStorage` (this tab's truth on reload) and `chrome.storage.local` (cross-session seed for a freshly-opened tab), via `src/console/tabState.js`. `mdhLastPipeline::<scope>::<collection>` is keyed per-org **and per-collection** (legacy un-collection-scoped `mdhLastPipeline::<scope>` entries from older builds are orphaned, not migrated).
- Audit state: `auditActiveSource`, `auditFiltersBySource`
- Galaxy state: none (no persisted state in v1)
- Fabry Chat state: `fabrySidebarWidth` is a **global** layout pref (sidebar drag-resize, clamp 200–420; the sidebar collapse toggle was removed, so the former `fabrySidebarOpen` key is orphaned/unused); `fabryArchConsoleHeight` is a **global** layout pref too (the Architect deliverable pane's action-console height — fixed so tabs don't jump, drag-resizable via its top-edge grip, clamp 140–620); `fabryActiveChat` (open chat id), `fabryMode` (Chat|Architect sub-app selection), and `fabryArchitectActive` (open Architect deliverable id) are the only other persisted values — all per-tab (tabState pattern) and content-free; chat content/images/transcripts and Architect deliverable text/evidence never touch storage (server-owned; privacy constraint — deliverables + their last results live in the `__mrfabry_architect` Data Storage collection, in-memory otherwise)
- Inspector state: `rossumViewedAnnotations` — annotations the user OPENED IN THE ROSSUM UI (`{id, origin, at}`, deduped by (origin,id), newest-first, cap 12), written by the always-on `track-viewed` content-script feature (pure tracker, no DOM) and read by the Inspector landing, which also live-refreshes via `chrome.storage.onChanged`, which filters to the connected org's origin (cap 8 shown) and enriches file/queue/status via ONE sideloaded call (`/annotations?id=<csv>&sideload=documents,queues` — verified live). Clear-all removes only the current origin's entries. Opening the Inspector lands on this list — only an explicitly staged `pendingAnnotationId` (deep-link) auto-loads. (Legacy keys `inspectorRecents` [investigated-recents, retired 2026-07-04] and the older per-tab `consoleInspectorAnn` are orphaned, not migrated.)
- AI pipeline input availability: cached in **`sessionStorage`** (key `mdhAiAvailable_<org>`), NOT `chrome.storage` — ephemeral per-session result of the `/internal/llmchat` probe, so availability is never persisted at rest.
- Onboarding training state: `trainingProgress` (per-org-origin progress + any issued receipt, capped at 3 orgs). The gate is the shared `experimentalUnlocked` above; the former `trainingUnlocked` key (2026-08-07 to 2026-08-11) is orphaned, never migrated — no profile can hold it without `experimentalUnlocked`, so nothing was lost.
- Usage data (**opt-in, off by default**): `usageConsent` (`true`/`false`/**absent** — absent means *never answered*, which is why `App.jsx` reads it separately from the `!!`-coercing `STORAGE_TOGGLES` loop), `usageClientId` (random uuid, minted **lazily by the worker on the first event** — not at consent time, so nothing durable depends on a message reaching it — and **deleted on revoke** together with `usageSessionId`, so a re-opt-in is unlinkable), `usageSnapshotDay` (UTC `YYYY-MM-DD` marker for the once-a-day config snapshot), `usageAsked` (`true` once the consent overlay has ever been **shown** — separate from `usageConsent` so the ask appears exactly once and never nags); plus `usageSessionId` in `chrome.storage.session`.

## Usage data (opt-in)

Answers "which features are actually used" so unused ones get deleted instead of maintained. **The service worker is the ONLY sender.** Spec: `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md`.

- **`src/usage/event.js`** (pure) — the closed event vocabulary (`EVENT_NAMES`, `sa_<surface>_<action>`) + the param **allowlist**. `buildPayload()` rejects any param key not on the list and any value outside its enum, so a feature author has no channel to attach free-form data. Adding an event = adding it here **and** to `PRIVACY.md` (a test enforces the pairing).
- **`src/usage/track.js`** — `track(name, params?)` / `trackOnce(name, params?)`: `chrome.runtime.sendMessage`, never awaited, never throws, always returns `undefined`. `trackOnce` collapses the MutationObserver-driven overlay features to one event per page load. Feature modules call these at the point where the feature has **acted**, not where it was enabled (enablement is the snapshot's job).
- **`src/usage/collect.js`** — worker side: consent gate (`usageConsent !== true` → silent drop, no id, no fetch), session id, and the single GA4 Measurement Protocol `fetch`. The **client id is minted lazily here** on the first event. **`src/popup/usageConsent.js`** owns the consent WRITE, straight to `chrome.storage.local` — NEVER via a worker message: measured 2026-08-03, the message path left `usageConsent` ABSENT right after the click and present only ~50ms later (worker cold start), so closing + reopening the popup inside that window read "off". Nothing durable may depend on a message reaching the worker; lazy minting also heals profiles the old flow left with consent but no id. Reads an **explicit key list**, never `getLocal(null)` (the local store also holds staged `consoleAuth_*` tokens). The daily `sa_config_snapshot` **piggybacks on the first event of the day** — a scheduled alternative would need `chrome.alarms`, and adding a permission would disable every existing install until each user re-approved.
- **`src/usage/ga4Config.js`** — `MEASUREMENT_ID` / `API_SECRET`, holding the **real** property values. Extractable from the bundle by design (accepted: roadmap signal, not a security input), which is why the property is dedicated to this extension and forged events are detectable against the published vocabulary. Rotating costs a full Chrome-review release, because the secret is baked in.
- **No manifest change.** VERIFIED 2026-08-03 by probe: the worker's `fetch` to `https://www.google-analytics.com/mp/collect` returns 204 with **no** host permission for that host.
- **Consent UI** — `src/popup/components/UsageCard.jsx` exports two pieces. `UsageCard` is a **blocking overlay over the whole popup** (`.usage-overlay`, `position: fixed; inset: 0`) rendered **outside** the `site` branch in `App.jsx`, so it reaches people whose tab is not Rossum/NetSuite/Coupa; fixed positioning escapes `#app { overflow: hidden }`, so it neither gets clipped by nor contributes to Chrome's 600px cap. Body = the "two-column ledger" (`.usage-ledger`, Sent | Never), which discloses the random client id; the foot links to `PRIVACY.md` with a deliberately **unnumbered** label ("See all events"), so it can't disagree with the vocabulary as events are added. The overlay is shown **exactly once**: `overlayMode({ asked, reviewing })` (pure, unit-tested) returns `'ask'` only while `usageAsked` is absent, and `App.jsx` writes `usageAsked: true` the moment it renders — closing it unanswered leaves counting off and never re-asks. `UsageFooterButton` sits in the **footer** (the only region rendered on every page), renders as soon as `asked` is true **even if unanswered** (otherwise there is no way back in), and does **NOT** flip the setting: it **reopens the overlay** (`reviewingUsage`, in-memory only). The one-time ask has **no dismiss**; the reopened overlay adds a `Currently on/off.` line and IS dismissible via `×` or scrim click. Copy is in **"we" voice** (owner-supplied draft, 2026-08-03; it superseded an earlier no-first-person instruction — that guard test was removed). **Vocabulary is unified on "usage data"** across card, footer, `PRIVACY.md`, README and the store sentence. The UI never says **telemetry**/measuring/tracking/counting — a test fails on those stems. "telemetry" is excluded deliberately: the 2021 Audacity revolt happened against an opt-in, off-by-default telemetry feature, so the word itself is the risk with a technical audience (Google's *Measurement Protocol* keeps its product name in `PRIVACY.md`). Headings `What's sent` / `What's NEVER sent`; button `Share usage data`; footer `Usage data on`/`Usage data off`. Says **extension**, never "plugin" (test-guarded). Engineering names use the same plain prefix: `src/usage/`, `usageConsent`, `sa-usage` (renamed from `src/telemetry/` 2026-08-03). `App.jsx` withholds first paint until `storageValues`, `consent` **and** `asked` resolve.
- **`PRIVACY.md` is the single source for the event list** — no in-popup expander (prototyped, rejected: it duplicated all 41 entries into the bundle). The endpoint constants live in `ga4Config.js`, NOT `event.js`, so the vocabulary stays importable from any surface without dragging the analytics host into that surface's bundle.

- **Guards** — `tests/usage-boundary.test.js`: only **`src/usage/ga4Config.js`** may name `google-analytics.com` (endpoints live with the credentials so `event.js` stays importable by any surface), asserted against `src/` **and** the built `dist/` — where it also asserts `dist/background.js` *does* contain the host, so it cannot pass against a stale build. `tests/usage-console-events.test.js`: every `sa_*` literal in `src/` must exist in the vocabulary — a typo'd name is silently dropped and would read as "nobody uses this feature".

## CSS Architecture

- **Console** (`console.css`): CSS custom properties for all colors, surfaces, typography shared by the Console's apps (Dataset Management, Audit, and Galaxy — Galaxy adds `.galaxy-*` rules). Includes `.app-rail*` rules for the left app-switcher rail. Dark mode via `@media (prefers-color-scheme: dark)` overriding `:root` variables. Semantic color variables: `--accent`, `--success`, `--warning`, `--danger` plus `-hover`, `-bg`, `-fg`, `-border` variants. (`mdh.css` was renamed to `console.css`; `audit.css` was removed — the Audit app now uses `console.css`.)
- **Popup** (`popup.css`): Separate variable system, also supports dark mode.
- **Content scripts**: Inject styles dynamically via `init()` functions (styles only in DOM when feature enabled). All classes prefixed `rossum-sa-extension-*`.
- **CodeMirror**: Custom highlight themes (light + dark) in `JsonEditor.jsx` matching the JSON tree renderer colors via `@lezer/highlight` tags.

## Dependencies

- **preact** + **@preact/signals** — UI rendering and reactive state for the popup and Console apps (MDH, Audit, Galaxy)
- **codemirror** + **@codemirror/lang-json** + **@codemirror/lang-markdown** + **@codemirror/theme-one-dark** — JSON/pipeline editor with MongoDB operator autocompletion (lang-json); the Fabry Architect deliverable Markdown-source editor (`MarkdownEditor.jsx`, lang-markdown; ~+100KB to `console.js`)
- **json5** — lenient JSON parsing (allows trailing commas, unquoted keys in pipeline editor)
- **beautiful-mermaid** — diagram rendering for Fabry chat replies (replaced the 3.3MB `mermaid` package). SYNCHRONOUS `renderMermaidSVG(text, themeOpts)` (flat `{bg, fg, accent, ...}` theme read live from the console tokens — `themeFromTokens`); escapes label text itself (probe-verified); throws on invalid input → code-fence fallback. Ships one flat ~1.5MB module (no tree-shakable subpaths), so it's bundled as its OWN lazy entry (`src/fabry/mermaidEntry.js` → `dist/console/mermaid.js`, registers `window.__fabryMermaidSvg`) script-injected on the first mermaid fence (`src/ui/fabry/mermaidLoader.js`); output parsed via DOMParser text/html (no innerHTML sinks)
- **three** + **d3-force-3d** — WebGL rendering + force-directed layout for the Galaxy app. The scene is hand-rolled on these directly; `3d-force-graph` was deliberately avoided (its bundled ngraph engine uses `new Function`, which the Console page's default MV3 CSP forbids). Adds ~360KB to `console.js`.
- **esbuild** (dev) — bundler

## Key Patterns

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
