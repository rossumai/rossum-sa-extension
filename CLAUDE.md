# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that enhances Rossum UI, NetSuite UI, and Coupa UI for solution architects during onboarding. Published to Chrome Web Store. Community-supported, not an official Rossum product.

## Build System

Uses **esbuild** to bundle ES modules from `src/` into `dist/`. No other build tools or transpilation.

- `npm run build` — clean build into `dist/`
- `npm run dev` — watch mode (JS only; re-run build for CSS/HTML changes)
- `dist/` is the loadable Chrome extension (gitignored)
- `build.js` orchestrates bundling + static asset copying (manifest.json, icons/, popup HTML/CSS, console HTML/CSS)

esbuild config: `format: 'iife'`, `minify: true`, `jsxFactory: 'h'`, `jsxFragment: 'Fragment'` (Preact JSX).

## Architecture

Six esbuild entry points:

1. **`src/rossum/index.js`** → content script for Rossum pages
2. **`src/netsuite/index.js`** → content script for NetSuite pages
3. **`src/coupa/index.js`** → content script for Coupa pages
4. **`src/popup/popup.jsx`** → extension popup UI (Preact)
5. **`src/console/index.jsx`** → unified Console page (`console/console.html`, opened via `chrome.tabs.create`) — a left app-switcher rail over three apps: Dataset Management (`src/mdh/`), Audit Log Viewer (`src/audit/`), and Galaxy (`src/galaxy/`, a 3D org birdview)
6. **`src/background/index.js`** → MV3 service worker (`background.js`)

The background service worker exists for a single job: a content script can't
`chrome.tabs.create` an extension page, so the `dataset-mgmt-suggest` feature
messages the worker (`{ type: 'openDatasetManagement', token, domain }`) and the
worker stages `consoleAuth_<uuid>` (with `app: 'mdh'`) + opens `console/console.html`
— letting us open the Dataset Management from the legacy MDH web app without
`web_accessible_resources`. Otherwise the extension is purely content scripts +
popup + opened pages.

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
- **`agent/agentApi.js` + `agent/agentStream.js` + `agent/agentQuery.js` + `components/AgentBox.jsx`** — the **drop-in** AI query box ("Mr. Fabry"), which replaced the retired `llmchat` NL→aggregation loop (`aiPipelineLoop.js`/`aiContext.js`/`AiRunTrace.jsx`, deleted). Engine = the standalone **Rossum Agent API** at `rossum-agent-api.tools.rossum.cloud` (host in `manifest.json` host_permissions) — `agentApi.js` wraps `init(domain, token)`, `probeAgent()` (`GET /health`, unauthenticated; gates `store.aiAvailable`), `createChat()` (`POST /chats`), and `streamMessage(chatId, content, {onEvent, signal})` (`POST /chats/{id}/messages`, AI-SDK data-stream, `X-Rossum-Token`/`X-Rossum-Api-Url` headers, 90s idle-timeout abort). `agentStream.js` is pure: `createSseParser`/`foldEvents`/`replyText`/`extractPipeline` (accumulate `text-delta` + optional `data-final-answer`; extract a JSON-array pipeline from the reply, fenced/prose-tolerant, never clobbering a prose-only answer); it reuses `llmPipeline.js`'s trimmed pure helpers (`stripFences`/`safeParseArray`/`prependAiComment`/`stripAiComment`). The **verify-and-refine loop is client-side** in `agentQuery.js` (`runAgentQuery`): the agent GENERATES a JSON-only pipeline in a **fresh chat per submit** (primed `/persona cautious`; the prompt carries the CURRENT editor pipeline so follow-ups ITERATE on it, plus rules — ≤50-row `capRows`, no tools — and **data-driven schema hints** from `agent/aiContext.js` `getSchemaHints`: known distinct values, top values, numeric ranges, numeric-string fields, array paths, field types, and the collection's Atlas Search indexes [a cached `$facet` + `listSearchIndexes`], formatted by `schemaHintParts`). The CLIENT then VERIFIES two ways — **mechanically** (execution error / 0 rows via `api.aggregate`) and **semantically** (a second agent turn, `buildVerifyPrompt`/`parseVerdict`, judges whether the ACTUAL result rows answer the request; restored from the old loop) — and on any bad signal (error / empty / semantic mismatch) sends up to 2 correction turns. The final pipeline is applied to the editor **verbatim** (no `🤖 AI request` comment — the transcript modal carries that context). The AI input field **always starts a fresh chat**; `runAgentQuery` returns the `transcript` + the `chatId`. `AgentBox`'s "View transcript" link opens an **interactive** modal (`TranscriptModal`) showing each turn's full text + reasoning AND letting the user **continue the same chat** (`continueAgentQuery` reuses the `chatId`, no re-prime) to iterate on the resulting query — each continuation re-runs the verify-and-refine loop and re-applies the pipeline to the editor. No agent session state lives in `store.js` (only `aiAvailable`). **READ-ONLY is enforced client-side**: `agentQuery.screen()` + `pipelineOps.terminalWriteStage` mean a `$out`/`$merge` pipeline is NEVER executed or applied (note `blocked`), and an agent-emitted `[]` is `declined`; the cautious persona is defense-in-depth only — the agent's own compliance is not a hard server guarantee, so a backend write-lock remains a ship-blocker before non-dogfood use. `AgentBox` is a single input (no transcript, no result note) with an animated rainbow `.nl-search-loading` gerund loader while a query runs; it aborts + stale-guards on collection change and surfaces failures (couldn't-build / write-`blocked` / 401) on the global error banner. UI in `console.css`: `.agent-box`/`.nl-search-wrapper`/`.nl-search-loading`/`.agent-attribution` ("Powered by Mr. Fabry"), reusing `.nl-search-input`.
- **`overviewCharts.js`** — pure (DOM-free, unit-tested) layout/scale math for the Overview "Charts" panel: squarified treemap (`squarify`/`buildTreemap`, area = `storageSize`, top-N + aggregated "Other" tile), index-overhead color scale (`overheadColor` blue→teal→yellow on `totalIndexSize/storageSize`, plus `overheadTextColor` for luminance-adaptive tile text), and a `mode`-aware (linear/sqrt/log) `scaleArea` + `buildScatter` (docs×avg-size). Rendered by `components/OverviewCharts.jsx` (always-on panel above the table; a single scale toggle drives BOTH charts; coordinated treemap↔scatter hover) which `OverviewPanel` mounts — all from the stats already in memory, no extra API calls.
- **`components/`** — 28 JSX components. Modal system: `openModal(title, renderFn)`, `confirmModal(title, msg, onConfirm)`, `promptModal(title, opts, onSubmit)`. `StagesView.jsx` is the in-view full-pipeline debug view — a **third results-view mode** (`RecordList` renders it when the `resultsView` signal is `stages`, beside List/Table; the List/Table/Stages switch is a one-click segmented control `.view-seg`; also reached by clicking a stage row in the Aggregate Pipeline Debug panel, which sets the `inspectTarget` signal to scroll/highlight that stage). NOT a modal (an earlier modal iteration was replaced by this in-view view so the pipeline editor stays visible alongside — which is what enables the hover connector and cursor-follow). An options strip (`.pipeline-inspect-opts`) at the top — **Records per stage** (`10`/`25`/`50` segmented, default 10, `store.stagesSampleSize` → `mdhStagesSampleSize`; drives the per-stage/input `$limit` and re-fetches on change) and an **Auto-scroll** checkbox (default on, `store.stagesAutoscroll` → `mdhStagesAutoscroll`) — sits above a vertical list of fixed-height stage sections. Each shows **full-width** sample output as side-by-side read-only `RecordCard`s (mouse-wheel scrolls the row horizontally via `horizontalWheelDelta`), **always expanded — not collapsible** (`RecordCard collapsible={false}` → no chevron, inert header, body always shown; the cards **stretch to fill** the section height even when the record is short, scrolling within the body when taller). Stage **0 / input** carries an explanatory hint ("entire collection, before any stage runs"). A per-stage enable/disable checkbox (`onToggleStage`) toggles each active stage. The per-stage query box was removed: **hovering a stage** sets the `hoveredStage` signal, and `StageLinkOverlay.jsx` draws a **dashed** SVG connector (geometry in `stageLink.js`) from that section to the stage's code in the pipeline editor — `JsonEditor`'s `revealStage`/`stageScreenRect` (built on `stageLineRanges` + CodeMirror `coordsAtPos`) auto-scroll the editor to the stage and measure its line. The two automatic "follow" scrolls — editor-follows-hover (`revealStage`) and Stages-follows-editor-cursor (`DataPanel.handleCursorStage` → `inspectTarget`) — are both gated on `stagesAutoscroll`; the explicit debug-panel click jump (`handleInspectStage`) always scrolls regardless. Driven by live `entries` props (no local copy); `overscroll-behavior: none` on its scroll regions (kills the rubber-band).

Auth flow: popup (or background worker) uses `chrome.scripting.executeScript` to run `readAuthInfo` in the Rossum tab's main world → reads `{token, domain}` from `localStorage.secureToken` + `location.origin` → stages a single-use `consoleAuth_<uuid>` key in `chrome.storage.local` carrying `{token, domain, app, createdAt, pending*}` and opens `console/console.html?authId=<uuid>`. On boot, the Console shell reads + immediately removes the staging entry, hands credentials to `sessionStorage` (`consoleToken`/`consoleDomain`/`consoleAuthId`), inits both app API clients, picks the initial app (staging `app` > persisted `consoleActiveApp` > `mdh`), and lazily runs `initMdh()`/`initAudit()` on first activation. Subsequent reloads of the same tab use sessionStorage so the token is never left at rest in `chrome.storage.local`. Navigation state is also per-tab via `sessionStorage` with a `chrome.storage.local` seed (see `src/console/tabState.js`), so multiple Console tabs don't clobber each other's working context on reload. A 24-hour TTL purge sweeps any stale `consoleAuth_` entries (and orphaned `mdhAuth_`/`auditAuth_` entries from older builds) that were never consumed. The MDH sidebar can also open a collection in a new Console tab (kebab "Open in new tab", right-click the collection for the same actions menu at the cursor, or Cmd/Ctrl/middle-click a collection) — `src/mdh/openCollectionTab.js` stages the same single-use `consoleAuth_<uuid>` carrying `pendingCollection` and `chrome.tabs.create`s `console/console.html`, so the new tab opens focused on that collection and restores its last-used pipeline.

### Audit & Activity Console (`src/audit/`)

A unified Audit & Activity console — a descriptor-driven shell over four Rossum log sources: Audit Logs (`audit_logs`), Hook Logs (`hooks/logs`), Workflow Activity (`workflow_activities`), and Rules Execution (`rules_execution_logs`). Lives under the Console app rail (entry point `src/console/index.jsx`) and is styled by the shared `console.css`. Auth uses the shared `consoleAuth_<uuid>` staging described above.

Architecture: one generic shell (`TabBar` → `FiltersBar` → `ResultsTable` → `DetailPanel` → `Pagination`) driven by per-source **descriptors** (`src/audit/sources/`), each exporting `{ key, path, paginationMode, supportsServerSearch, filters, columns, detail, buildParams, refs }`. Sources use either cursor pagination (audit_logs, workflow_activities) or offset pagination (hooks/logs, rules_execution_logs). A cached id→name resolver (`resolve.js`, 60s LRU, signal-backed) resolves hook/queue/user IDs to human names. Deep-links to the Rossum UI are built by `deeplink.js`. Each source 403s independently → per-source `UnavailablePanel`. Client-side quick filtering over the loaded page is handled by `quickSearch.js` (still used by `ResultsTable`).

### Galaxy (3D org birdview) (`src/galaxy/`)

A Preact app that fetches the live Rossum org over REST and renders it as an explorable 3D force-directed graph. Built directly on **three.js + d3-force-3d + OrbitControls** (NOT `3d-force-graph` — that bundles ngraph's `new Function` codegen which would violate the Console page's default MV3 CSP; the hand-rolled scene is CSP-clean by construction, verified by a `grep` of `dist/console/console.js`). Node types: organization, workspace, queue, hook, engine (5 types; `connector` and the `run_after` edge were intentionally dropped). Edges: **containment** (org→workspace→queue) and **reference** (queue→hook by inverting `hook.queues[]`; queue→engine via the unified **`queue.engine`** field — verified live on a customer dev org — falling back to legacy `dedicated_engine`/`generic_engine`).

- **`graph.js`** — pure `buildGraph(rawBundle) → {nodes, links}` (URL→id parsing, dedup, missing-ref tolerance) where each node carries a curated `detail` (`[label, value]` pairs from verified API fields). Exports `NODE_STYLE` (rainbow palette keyed to hierarchy depth) + `LINK_STYLE`.
- **`api.js`** — `init`/`get`/`listAll` (follows `pagination.next`)/`fetchOrgResources` (parallel fetch of organizations/workspaces/queues/hooks/engines; per-collection 403→[] tolerance; `onProgress` reports a per-page running count for the loading counter).
- **`scene.js`** — imperative three.js wrapper: `createScene(container) → { setData, onHover, onClick, focus, setIdleSpin, setVisibleTypes, destroy }`. d3-force-3d layout (re-heated on a type toggle so the visible subset reflows); light theme (no bloom); OrbitControls with **auto-rotate off**; raycaster hover-dim + click-to-pin (survives a rotate drag via a click-vs-drag movement threshold); fit-to-visible on open and after settle. Hand-verified in the browser; unit-tested via mocks (no WebGL under jsdom).
- **`index.jsx`** — `initGalaxy()` probes `whoami`, then loads the graph in the background (non-blocking) so the shell paints the rail + loading overlay immediately on open/reload.
- **`store.js`** — signals: `domain`, `token`, `connected`, `graph`, `loading`, `error`, `selectedNodeId`, `hoveredNodeId`, `loadedCount`, `visibleTypes` (+ `toggleType`).
- **`components/`** — `App` (scene bridge via `preact/hooks`), `Legend` (clickable per-type visibility filters), `DetailCard` (curated per-type facts + Open-in-Rossum deep-link for queue/hook), `NavGuide` (mouse-controls hint).

Adding the app touched three hardcoded rail switch-points (`Rail.jsx` APPS, `Console.jsx` render switch, `boot.js` `isValidApp`) plus `console/index.jsx` (imports, `TITLES`, auth wiring, lazy `initGalaxy`). Auth uses the shared `consoleAuth_<uuid>` flow; styled by `console.css` (`.galaxy-*`). No persisted state in v1.

### Coupa content script

Two strategies: JSON metadata extraction from `#initial_full_react_data` script tag (React pages like invoices) and DOM attribute extraction with `IGNORE_S_CLASSES` filtering (Rails pages like POs).

### Popup

Preact JSX. Detects current site (Rossum/NetSuite/Coupa) and dims irrelevant sections. Two toggle types: storage-backed (persist in chrome.storage.local, reload tab on change) and page-flag-backed (devFeatures/devDebug, written into the page's localStorage via `chrome.scripting.executeScript` without reload). All tab IO uses `chrome.scripting.executeScript` rather than `chrome.tabs.sendMessage` so popup operations survive content-script orphaning across extension upgrades.

## Chrome Storage Keys

- Feature toggles: `schemaAnnotationsEnabled`, `expandFormulasEnabled`, `expandReasoningFieldsEnabled`, `scrollLockEnabled`, `resourceIdsEnabled`, `netsuiteFieldNamesEnabled`, `coupaFieldNamesEnabled`
- Console staging auth: `consoleAuth_<uuid>` (single-use, 24h TTL, removed on first read; carries `app` + optional DS pipeline prefill)
- Console state: `consoleActiveApp` — per-tab (see MDH state below: session-first read with a `chrome.storage.local` seed)
- MDH state: `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`, `mdhOverviewChartsScale`, `mdhResultsView`, `mdhStagesAutoscroll`, `mdhStagesSampleSize` are **global** (shared across tabs, persisted in `chrome.storage.local`). The **navigation** keys `mdhActiveView`, `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch` (and the Console-level `consoleActiveApp`) are **per-tab**: read session-first from `sessionStorage`, written to BOTH `sessionStorage` (this tab's truth on reload) and `chrome.storage.local` (cross-session seed for a freshly-opened tab), via `src/console/tabState.js`. `mdhLastPipeline::<scope>::<collection>` is keyed per-org **and per-collection** (legacy un-collection-scoped `mdhLastPipeline::<scope>` entries from older builds are orphaned, not migrated).
- Audit state: `auditActiveSource`, `auditFiltersBySource`
- Galaxy state: none (no persisted state in v1)
- Inspector state: `inspectorRecents` — recently-inspected annotations (rich entries: `{id, fileName, queue, status, at}`, deduped by id, most-recent-first, cap 8), **global** in `chrome.storage.local` (cross-session/cross-tab; loaded at init, recorded on each successful load, shown in the landing states only). Opening the Inspector lands on this recents list — it does **not** auto-open a previously-inspected annotation; only an explicitly staged `pendingAnnotationId` (a deep-link) auto-loads. (The old per-tab `consoleInspectorAnn` sessionStorage last-id + its persist/restore were removed — the recents list supersedes them.)
- AI pipeline input availability: cached in **`sessionStorage`** (key `mdhAiAvailable_<org>`), NOT `chrome.storage` — ephemeral per-session result of the `/internal/llmchat` probe, so availability is never persisted at rest.

## CSS Architecture

- **Console** (`console.css`): CSS custom properties for all colors, surfaces, typography shared by the Console's apps (Dataset Management, Audit, and Galaxy — Galaxy adds `.galaxy-*` rules). Includes `.app-rail*` rules for the left app-switcher rail. Dark mode via `@media (prefers-color-scheme: dark)` overriding `:root` variables. Semantic color variables: `--accent`, `--success`, `--warning`, `--danger` plus `-hover`, `-bg`, `-fg`, `-border` variants. (`mdh.css` was renamed to `console.css`; `audit.css` was removed — the Audit app now uses `console.css`.)
- **Popup** (`popup.css`): Separate variable system, also supports dark mode.
- **Content scripts**: Inject styles dynamically via `init()` functions (styles only in DOM when feature enabled). All classes prefixed `rossum-sa-extension-*`.
- **CodeMirror**: Custom highlight themes (light + dark) in `JsonEditor.jsx` matching the JSON tree renderer colors via `@lezer/highlight` tags.

## Dependencies

- **preact** + **@preact/signals** — UI rendering and reactive state for the popup and Console apps (MDH, Audit, Galaxy)
- **codemirror** + **@codemirror/lang-json** + **@codemirror/theme-one-dark** — JSON/pipeline editor with MongoDB operator autocompletion
- **json5** — lenient JSON parsing (allows trailing commas, unquoted keys in pipeline editor)
- **three** + **d3-force-3d** — WebGL rendering + force-directed layout for the Galaxy app. The scene is hand-rolled on these directly; `3d-force-graph` was deliberately avoided (its bundled ngraph engine uses `new Function`, which the Console page's default MV3 CSP forbids). Adds ~360KB to `console.js`.
- **esbuild** (dev) — bundler

## Key Patterns

- Most features are gated behind chrome.storage.local toggles controlled via popup. The `closable-tooltips` and `dataset-mgmt-suggest` features are always on (no toggle, no storage key) and are not advertised in the popup UI. `dataset-mgmt-suggest` self-gates on the legacy MDH web app path (`/svc/master-data-hub/web/`).
- Rossum entry point builds handlers array from enabled settings — disabled features add zero overhead
- NetSuite and Coupa content scripts are self-contained single files (no MutationObserver pattern)

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
