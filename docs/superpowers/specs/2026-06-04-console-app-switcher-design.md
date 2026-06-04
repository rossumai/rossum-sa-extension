# Console app switcher — design

**Date:** 2026-06-04
**Status:** Approved (design); pending spec review → implementation plan

## Overview

Today the extension ships two independent standalone pages, each its own esbuild
entry point, bundle, HTML shell, and stylesheet:

- **Dataset Management** (`src/mdh/`, `mdh.html` / `mdh.js` / `mdh.css`)
- **Audit Log Viewer** (`src/audit/`, `audit.html` / `audit.js` / `audit.css`)

They are opened as separate tabs from two popup buttons (*Data Storage*, *Audit
Logs*), share the same Rossum credentials (`token` + `domain`), and already share
a near-identical design-token system (`audit.css` is annotated "kept in sync with
src/mdh/mdh.css").

This change merges them into **one page** behind a Slack-style left **app rail**
that switches between the two apps **in place** (no reload, shared session). The
new entry point is named **`console`**. Dataset Management's behavior is
unchanged; Audit Log Viewer adopts the Dataset Management stylesheet.

## Goals

1. A single page hosting an icon+label rail on the far left that switches between
   **Dataset Management** and **Audit Log Viewer** with no page reload.
2. Dataset Management looks and behaves exactly as it does today.
3. Audit Log Viewer is re-themed onto the Dataset Management stylesheet (it already
   uses the same tokens, so this is consolidation, not a redesign).
4. The two popup buttons are preserved; each opens the unified page on its app.
5. The last-used app is remembered across reload/reopen; a popup button forces its
   app.

## Non-goals

- No change to Dataset Management features, panels, or layout (beyond gaining the
  rail to its left).
- No change to the Audit Log Viewer's data model, API usage, filters, or
  pagination — only its styling host and boot wiring.
- No new `web_accessible_resources`; the page is still opened via
  `chrome.tabs.create` from the popup and the background worker.
- No redesign of the popup itself beyond re-pointing its two launch buttons.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Architecture | One page, switch in place (unified shell) |
| Entry point name | `console` → new `src/console/` shell; `dist/console/console.{html,js,css}` |
| Rail style | Icon + short label (~76px), light surfaces, token-driven, dark-mode-aware |
| Rail labels | **"Data"** / **"Audit"** (full names as `title` tooltips) |
| Popup | Keep both buttons — *Data Storage* → Dataset Mgmt, *Audit Logs* → Audit |
| Reopen/reload | Remember last-used app (`consoleActiveApp`); a popup button forces its app |
| Switch/mount strategy | Mount only the active app's view (scroll resets on switch; state preserved via signals) |
| Dataset Management | Behavior unchanged; `App.jsx` untouched |
| Audit styling | Adopt the unified `console.css` |

## Current-state facts (grounded in code)

- **`src/mdh/index.jsx`** `boot()`: resolves auth (`mdhAuth_<uuid>` staging →
  `sessionStorage` `mdhToken`/`mdhDomain`/`mdhAuthId`), `purgeStaleAuthEntries()`
  (24h TTL), `api.init(domain, token)`, restores `mdhActiveView` /
  `mdhSelectedCollection` / `mdhActivePanel` / `mdhOpsSearch` / last-pipeline,
  applies pipeline prefill (`pendingCollection`/`pendingPipeline`/
  `pendingVariables`), `await api.healthz()` → `connected`, `render(<App
  connected/>)`, then registers operations-polling, persist effects, and a
  prefetch effect.
- **`src/audit/index.jsx`** `boot()`: resolves auth (`auditAuth_<uuid>` →
  `auditToken`/`auditDomain`/`auditAuthId`), purge (24h TTL), `api.init`, restores
  `auditFilters` / `auditPageSize`, `await api.whoami()` → `connected`,
  `render(<App connected/>)`, then persist effects and a query effect
  (`fetchPage`).
- Both `App.jsx` take a `connected` prop and render `<div class="app-root">`. MDH
  adds a `<Sidebar/>` (260px Collections list) before `<main>`; Audit has only
  `<main>`.
- `#app { display:flex; height:100vh }` → `.app-root { display:flex; flex:1 }`.
  These plus `:root` tokens, `body`, `.connection-bar`, `.empty-state`,
  `.error-banner` are defined identically in both stylesheets.
- **`build.js`**: entry points include `mdh/mdh: src/mdh/index.jsx` and
  `audit/audit: src/audit/index.jsx`; `mkdirSync` makes `dist/mdh` + `dist/audit`;
  `cpSync` copies both HTML + both CSS files.
- **`src/popup/utils.js`**: `openMdhTab(tab, authData)` stages `mdhAuth_<uuid>` and
  opens `mdh/mdh.html?authId=…`; `openAuditTab(tab, authData)` stages
  `auditAuth_<uuid>` and opens `audit/audit.html?authId=…`. `openMdhTab` passes
  through `pendingCollection`/`pendingPipeline`.
- **`src/popup/components/App.jsx`**: `onDataStorage = () =>
  fetchAuthAndOpen(openMdhTab)`, `onAuditLogs = () =>
  fetchAuthAndOpen(openAuditTab)`.
- **`src/background/index.js`**: `openDatasetManagement` stages `mdhAuth_<uuid>`
  and opens `mdh/mdh.html?authId=…`, positioned next to the opener tab. Triggered
  by the `dataset-mgmt-suggest` content-script message
  `{ type:'openDatasetManagement', token, domain }`.
- **Tests asserting exact strings** (must be updated): `tests/popup-utils.test.js`
  (`mdhAuth_uuid-1`, `mdh/mdh.html?authId=`, `auditAuth_uuid-1`,
  `audit/audit.html?authId=`, `pendingCollection`/`pendingPipeline` passthrough);
  `tests/background.test.js` (`mdhAuth_UUID`, `mdh/mdh.html?authId=UUID`).
- `manifest.json` contains no references to `mdh.html` / `audit.html` (pages are
  opened via `chrome.runtime.getURL` at runtime) — no manifest change required.

## Target module layout

```
src/console/                 NEW shell — the only page entry point
  index.jsx                  single boot: resolve shared auth, pick initial app, lazy-init apps, render
  store.js                   activeApp signal ('mdh' | 'audit'); per-app init state
  console.css                moved from mdh.css + Audit-only rules folded in + rail styles
  console.html               #app, <title>Rossum SA</title>, links console.css + console.js
  components/
    Console.jsx              renders <Rail/> + the active app's view (with connecting state)
    Rail.jsx                 two icon+label buttons; active highlighted; sets activeApp

src/mdh/      Dataset Management app. App.jsx and all components/* UNCHANGED.
              index.jsx repurposed: export initMdh(ctx) (today's post-auth boot body); no top-level boot()/render.
src/audit/    Audit Log Viewer app. Components unchanged in behavior; styled via console.css.
              index.jsx repurposed: export initAudit() (today's post-auth boot body); no top-level boot()/render.
```

Removed: `src/mdh/mdh.html`, `src/mdh/mdh.css`, `src/audit/audit.html`,
`src/audit/audit.css`, and the `mdh/mdh` + `audit/audit` esbuild entry points.

## Shell boot & shared auth

A single app-neutral staging key replaces the two prefixes:

```
consoleAuth_<uuid> = {
  token, domain,
  app,                         // 'mdh' | 'audit' — initial app (popup button wins)
  createdAt,
  pendingCollection?, pendingPipeline?, pendingVariables?   // DS pipeline-prefill passthrough
}
```

`src/console/index.jsx`:

1. `resolveAuthId()` — read `authId` from URL (then strip it) or `consoleAuthId`
   from sessionStorage. Persist to `consoleAuthId`.
2. Read `consoleAuth_<uuid>` from `chrome.storage.local`; if present, it is
   single-use — consume it, copy `token`/`domain` into sessionStorage
   (`consoleToken`/`consoleDomain`), and remove the staging entry. Otherwise read
   `consoleToken`/`consoleDomain` from sessionStorage (reload case).
3. `purgeStaleAuthEntries()` sweeps stale `consoleAuth_` entries (24h TTL) and
   one-time sweeps any orphaned `mdhAuth_` / `auditAuth_` / `mdhToken` / `mdhDomain`
   from older builds.
4. If no `token`/`domain`: render the shell with a not-connected state (rail still
   shown; both apps render their existing not-connected message).
5. Set `domain`/`token` signals in **both** app stores and call `api.init(domain,
   token)` on **both** app API clients.
6. **Initial app** = staging `app` (if provided) → else persisted
   `consoleActiveApp` → else `'mdh'`. Set `activeApp`.
7. `initMdh(ctx)` / `initAudit()` run lazily on first activation (see below). The
   initially-active app is initialized (and its connection check awaited) before
   first render, matching today's no-flash behavior.
8. `render(<Console/>, #app)`.

`ctx` passed to `initMdh` carries only the DS pipeline-prefill fields
(`pendingCollection` / `pendingPipeline` / `pendingVariables`) from the staging
entry. Each `init` still reads its own persisted `chrome.storage.local` keys, so
the app modules stay otherwise self-contained.

## Per-app init contract & switching

`initMdh(ctx)` and `initAudit()` contain exactly today's post-auth `boot()` bodies,
minus auth resolution, `api.init`, and the final `render` (those move to the
shell). Each:

- reads its own persisted keys and applies them,
- runs its own connection check (MDH `healthz`, Audit `whoami`) and sets a
  `connected` signal in its store,
- registers its effects (persist effects, plus the expensive ones).

Rules:

- Each `init` runs **once**, memoized per app, the first time that app becomes
  active. Re-activating an app does **not** re-run `init` (avoids double-registered
  effects / duplicate polling).
- The shell renders **only the active app's view**. App data state lives in
  module-level `@preact/signals`, so it survives switching; persisted keys survive
  reload. Accepted tradeoff: DOM scroll position resets on switch.
- **Expensive effects are gated on `activeApp`** so a backgrounded app does no
  network work:
  - MDH operations-polling: already gated on `activeView === 'operations'`; add an
    `activeApp === 'mdh'` guard.
  - MDH prefetch effect: gated on `activeApp === 'mdh'`.
  - Audit query effect (`fetchPage`): gated on `activeApp === 'audit'`. On
    re-activation it re-runs for the current filters/page.
- `App.jsx` for both apps is **unchanged**: it keeps its `connected` prop. The
  shell's `Console` component reads `mdhStore.connected.value` /
  `auditStore.connected.value` (reactively) and passes it as the prop.
- First activation of the **secondary** app shows a brief centered "connecting"
  state (reusing existing overlay/empty-state styling) until its connection check
  resolves, to avoid a not-connected flash.

## `Console.jsx` (shell view)

Renders into `#app` (a flex row):

```
<Fragment>
  <Rail/>
  {activeApp === 'mdh'
    ? <MdhApp connected={mdhStore.connected.value} />
    : <AuditApp connected={auditStore.connected.value} />}
</Fragment>
```

(With the per-app "connecting" state substituted for the app view while its first
init is in flight.) Updates `document.title` to the active app's name
("Dataset Management — Rossum SA" / "Audit Logs — Rossum SA").

## `Rail.jsx`

- Container: `flex:none`, ~76px wide, `var(--bg-sidebar)` background,
  `border-right: 1px solid var(--border)`, vertical flex, centered, padded.
- Two buttons, each a column: rounded-square icon tile (inline SVG — a
  stack/database glyph for Data, a list/clipboard glyph for Audit) + a small label
  ("Data" / "Audit"). `title` = full app name.
- Active button: `var(--accent)` fill, white icon, primary-color label. Inactive:
  muted surface (`var(--bg-hover)`), secondary-color label.
- `onClick` sets `activeApp`. All colors via existing tokens, so the rail is light
  in light mode and flips automatically in dark mode.

## Popup & background rewiring

- `src/popup/utils.js`: replace `openMdhTab` / `openAuditTab` with a single
  `openConsoleTab(tab, authData, app)` that stages `consoleAuth_<uuid> =
  { ...authData, app, createdAt }` and opens
  `chrome.runtime.getURL('console/console.html?authId=<uuid>')` at `index+1`. The
  `pending*` DS-prefill fields ride along inside `authData`.
- `src/popup/components/App.jsx`: `onDataStorage = () =>
  fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth, 'mdh'))`;
  `onAuditLogs = () => fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth,
  'audit'))`. Any other call site of `openMdhTab` (e.g. the pipeline-prefill
  "Open in Dataset Management" path) is updated to `openConsoleTab(..., 'mdh')`.
- `src/background/index.js`: `openDatasetManagement` stages `consoleAuth_<uuid>`
  with `app:'mdh'` and opens `console/console.html?authId=…`, preserving the
  next-to-opener positioning and the stage-then-create ordering. The
  `dataset-mgmt-suggest` message contract is unchanged.

## Stylesheet consolidation

`src/console/console.css` = current `mdh.css` (moved) with the Audit-only rules
folded in and the rail rules added:

- Fold in from `audit.css`: `--type-doc/ann/user` tokens (light + dark),
  `.filters` / `.filters-row` / `.filters-actions`, `.results-wrap` /
  `.results-empty` / `.results-table` (thead/tbody), `.unavailable-*`,
  `.connection-meta`, `.connection-dot.busy` + `@keyframes pulse`, and any
  Audit-specific `RecordDetail` / `Pagination` rules.
- Shared rules (`:root` base tokens, `body`, `#app`, `.app-root`,
  `.connection-bar`, `.connection-dot`(+`.error`), `.empty-state`,
  `.error-banner`) already match between the two files → keep one definition;
  reconcile any minor drift in favor of the MDH version.
- Add `.app-rail` and child rules.
- Delete `src/mdh/mdh.css` and `src/audit/audit.css`.

## Build changes (`build.js`)

- `entryPoints`: remove `mdh/mdh` and `audit/audit`; add
  `console/console: src/console/index.jsx`.
- `mkdirSync` dirs: replace `dist/mdh` + `dist/audit` with `dist/console`.
- `cpSync`: remove the four MDH/Audit HTML+CSS copies; add
  `src/console/console.html` → `dist/console/console.html` and
  `src/console/console.css` → `dist/console/console.css`.

## Tests

- Update `tests/popup-utils.test.js`: assert `openConsoleTab` stages
  `consoleAuth_uuid-1 = { token, domain, app, createdAt }` and opens
  `console/console.html?authId=uuid-1` at `index+1`, for both `app:'mdh'` and
  `app:'audit'`; keep the `pending*` passthrough assertion.
- Update `tests/background.test.js`: assert `consoleAuth_UUID` with `app:'mdh'` and
  `console/console.html?authId=UUID`.
- Existing MDH and Audit app/component tests keep passing (app code behavior
  unchanged).
- Add tests:
  - **Shell auth resolution** — consumes `consoleAuth_<uuid>`, hands token/domain to
    sessionStorage, removes the staging entry; falls back to sessionStorage on
    reload; initial-app precedence (staging `app` > `consoleActiveApp` > `'mdh'`).
  - **`consoleActiveApp` persistence** — switching apps writes the key; boot restores
    it (unless a popup `app` overrides).
  - **Rail** — renders two buttons, marks the active one, and switching `activeApp`
    swaps the rendered app view.
- `npm test` (vitest) must be fully green before the work is considered done.

## Docs

Update `CLAUDE.md`:
- Architecture: collapse entry points from seven to six (one `console` page entry
  replacing the `mdh` + `audit` entries); describe the shell + rail + two sub-apps;
  update the auth-flow paragraph to the `consoleAuth_<uuid>` model.
- Chrome Storage Keys: replace `mdhAuth_`/`auditAuth_` staging keys with
  `consoleAuth_<uuid>`; add `consoleActiveApp`; keep the per-app state keys.
- CSS Architecture: `mdh.css` → `console.css`; note `audit.css` removed.
- Background service worker paragraph: `mdh.html` → `console/console.html`.

## Migration / cleanup

- No data migration. Staging entries are single-use with a 24h TTL; the new boot's
  purge sweeps orphaned `mdhAuth_`/`auditAuth_`/`mdhToken`/`mdhDomain` left by a
  prior build, so an in-place extension upgrade self-cleans.
- Persisted per-app state keys (`mdhActiveView`, `auditFilters`, etc.) are reused
  as-is.

## Risks & mitigations

- **Double-registered effects** if an app's `init` runs more than once → memoize
  `init` per app; never re-run on re-activation.
- **Background network work** from a hidden app → gate the polling / query /
  prefetch effects on `activeApp`.
- **Not-connected flash** on first switch to the secondary app → show a "connecting"
  state until its connection check resolves; await the initial app's check before
  first render (matches today).
- **CSS drift** while merging two stylesheets → fold Audit-only rules into a clearly
  delimited section; de-dupe shared rules to the MDH definition; verify both apps
  render in light and dark mode after the merge.
- **Test string coupling** → update `popup-utils` and `background` tests in lockstep
  with the URL/key rename.
