# DevTools "Rossum" panel — Raw Object Editor (consolidated implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented (uncommitted on `master`). This consolidates the incremental DevTools plans (in-page origin, DevTools pivot, v2–v4), the batch-9 "permanent default tab" refinement, the numeric sub-resource-link fix, and the two v5 features (content preview — Task 9; inline names + prefetch — Task 10) into one build record / rebuild guide describing the **final** architecture. Spec: `docs/superpowers/specs/2026-07-10-devtools-rossum-panel-design.md`.

**Goal:** A Chrome DevTools panel ("Rossum") that detects the API resource behind the inspected Rossum page, shows it as an editable CodeMirror JSON editor, navigates between related resources via link tabs, and PATCHes edits through a diff-confirm flow.

**Architecture:** A `devtools_page` registrar creates a `panels.create` panel. The panel reads `{token,domain,pathname,search}` from the inspected tab via `inspectedWindow.eval` (polled for SPA nav), detects the resource, fetches it same-origin with `Token` auth, and edits via whole-top-level-key PATCH. Preact + signals for the tabbed shell; CodeMirror 6 for the editor. Pure modules (`detect`, `resourceFromApiUrl`, `diff`) are unit-tested; the panel/editor are jsdom-tested; live routes and real DevTools interactions are dogfood checks.

**Tech Stack:** Preact + @preact/signals, CodeMirror 6 (`basicSetup`, `@codemirror/lang-json`, `@codemirror/search`, `@codemirror/language`, `@lezer/highlight`), esbuild (IIFE), Vitest + jsdom.

## Global Constraints

- **No assumptions — verify live (dev org only), never a customer org; never surface customer names/data.** Ship a route/type only once its dashboard route + API `apiPath` are confirmed.
- **Backward compatible & additive:** no external contracts, storage keys, entry points, or feature contracts change. `manifest.json` gains only `devtools_page`; no new permissions.
- **Read-only is client-side defense-in-depth only;** a server-side write-lock is the ship-blocker before non-dogfood use.
- **Correctness over guessing:** a wrong resource is worse than no resource (no positional/ambiguous mapping).
- **Nothing leaves the browser:** same-origin Rossum API calls only; no persistence of resource contents; no logging.
- Tests: Vitest `tests/devtools-*.test.js`, render via `h(Component, null)` (raw JSX in `.test.js` breaks oxc), condition-based `waitFor` (no fixed-timeout flushes). Full suite green after each task.

## File structure (final)

```
src/devtools/
  devtools.html / devtools.js   registrar: panels.create('Rossum', icon, 'devtools/panel.html')
  panel.html / panel.jsx        shell: tab bar → error → body → footer; link/tab menus; DiffConfirm overlay
  panel.css                     theme-aware styles (data-theme + prefers-color-scheme)
  inspected.js                  startBridge(onCtx): eval {token,domain,pathname,search}; poll SPA nav; dedup
  api.js                        init/getJson/getResource/patch (getResource: JSON vs blob by Content-Type)
  detect.js                     detectResource({pathname,search}) → descriptor | null
  resourceFromApiUrl.js         resourceFromApiUrl(url) → descriptor | null; READONLY_COLLECTIONS; numeric sub-paths
  store.js                      signals: tabs[] (incl. preview), activeId, linkMenu, tabMenu, views.active; tab helpers
  actions.js                    loadResource (cache-first) / requestDiff / saveResource / openResourceTab (deps-injected)
  diff.js                       buildPatchBody / diffObjects (pure)
  JsonCodeEditor.jsx            per-tab CodeMirror editor; link decoration + name hints; theme highlight
  cmLinks.js                    CM extension: underline Rossum API URLs; Cmd/Ctrl+click + right-click; rossumUrlRe()
  cmNames.js                    CM extension: dimmed line-end resource-name hints (viewport-scoped)
  PreviewPane.jsx               non-JSON content preview (image/pdf/file-info + Download/Open)
  contentMeta.js                pure: extFor / formatBytes / filenameFrom
  resourceCache.js              pickName + session cache {apiPath→{name,obj,at,status}} (names + prefetch)
  nameResolve.js                makeNameResolver(getJson): nameFor / ensure (dedupe + concurrency); singleton
  DiffConfirm.jsx               diff render + confirm/cancel overlay
  theme.js                      isDark() from DevTools themeName, prefers-color-scheme fallback
tests/devtools-*.test.js        one per module
```

---

### Task 1: Pure diff engine (`diff.js`)

**Files:** Create `src/devtools/diff.js`; Test `tests/devtools-diff.test.js`.

- `diffObjects(original, edited)` → `{ changed:[{key,before,after,leaves}], added:[…], removed:[…] }`, top-level keys by deep-equality with a leaf-level breakdown; recurse only when both sides are objects (a nested type change replaces wholesale, never a partial merge that loses data).
- `buildPatchBody(original, edited)` → `{ body }` where `body` carries the **whole current value of each changed/added top-level key**; removals are surfaced in the diff but **not** in `body`; unchanged keys absent. Diff-shown == diff-sent.

**Tests:** changed/added/removed classification; editing one key inside `settings` yields a body carrying the entire `settings`; untouched meta keys absent; nested type change doesn't lose data; removal surfaced not applied.

---

### Task 2: URL→resource mapping (`resourceFromApiUrl.js`)

**Files:** Create `src/devtools/resourceFromApiUrl.js`; Test `tests/devtools-resourcefromurl.test.js`.

- Regex `/(?:…)?\/api\/v1\/([a-z_]+)\/(\d+)((?:\/[a-z_]+)*)\/?(?:[?#]|$)/`; host/query/trailing tolerant; non-API string → `null`.
- Known collections → `{type,label}` (queues→Queue, schemas→Schema, hooks→Hook, workspaces→Workspace, engines→Engine, rules→Rule, annotations→Annotation, users→User, organizations→Organization, inboxes→inbox, organization_groups→'Organization group'). Unknown → generic `{type:collection, label:titleSingular(collection)}` (`titleSingular` handles `-ies`/`-es`/`-s`: `pages`→Page, `email_templates`→Email template).
- Sub-path present → `apiPath` includes it, `label = TitleCase(last segment)`, `readOnly:true`.
- `READONLY_COLLECTIONS = new Set(['organization_groups'])`: no-sub URL in the set → `readOnly:true`.

**Tests:** known + generic + sub-path (readonly, label from last segment) + `organization_groups` readonly + `titleSingular` edge cases + non-match null.

---

### Task 3: Tabs store (`store.js`)

**Files:** Create `src/devtools/store.js`; Test `tests/devtools-store.test.js`.

- Signals: `tabs=signal([])`, `activeId=signal(null)`, `linkMenu=signal(null)`, `tabMenu=signal(null)`; non-signal `views={active:null}`; `nextTabId()`.
- Tab shape: `{id,source:'page'|'link',resource,original,buffer,loading,saving,error,readOnly,dirty,diffPreview}`.
- `keyOf(resource)`: `via:'queue'`→`schema-via-queue:{q}`, `via:'queue-inbox'`→`inbox-via-queue:{q}`, `via:'org'`→`org:current`, else `apiPath || type:id`.
- `activeTab`, `patchTab` (immutable), `setActive` (clears both menus), `openTab(resource,source='link')` (dedup by key → focus; else push+activate), `nextTabId`.
- **Permanent default tab:** `ensurePageTab()` (create a resource-less page tab at index 0 if none; set `activeId` if null) — **called once at module load to seed**. `syncPageTab(resource)` never drops the page tab: creates it if missing; resource `null` → reset to resource-less (`changed` true only if it had a resource); different key → reset with the resource; same key → no-op. `closeTab(id)` **refuses `source==='page'`**; else remove + activate a neighbor; clears menus. `closeOtherTabs(id)` keeps the clicked tab **and** all page tabs; `activeId=id` (guarded to an existing id); clears menus. `moveTab(dragId,dropId)` reorders link tabs; no-op if either is the page tab (root pinned first).

**Tests:** openTab dedup/activate; closeTab neighbor; patchTab; keyOf variants; sub-resource distinct key (no dedup onto parent); syncPageTab create/same/different/null transitions; **default tab always present, never closeable** (closeTab refuses it; closeOtherTabs keeps it); ensurePageTab idempotent; moveTab reorder + page-tab pinned + no-op cases.

---

### Task 4: API layer (`api.js`) + inspected bridge (`inspected.js`)

**Files:** Create `src/devtools/api.js`, `src/devtools/inspected.js`; Test `tests/devtools-api.test.js`, `tests/devtools-inspected.test.js`.

- `api.init(domain,token)`; `getJson(apiPath)` → `fetch(${domain}${apiPath}, {headers:{Authorization:`Token ${token}`}})` → JSON or throw `{status, body}`; `patch(apiPath,body)` → same with `method:'PATCH'`, JSON body; invalid-path guard.
- `startBridge(onCtx)` → `chrome.devtools.inspectedWindow.eval` returns `JSON.stringify({token:localStorage.secureToken, domain:location.origin, pathname, search})`; poll (~1s); fire `onCtx(ctx)` only when key `domain|pathname|search|token` changes; return a stop fn.

**Tests:** api builds `${domain}${apiPath}`, Token header, `.status`/`.body` on error, invalid-path guard (fetch mocked). inspected: eval mocked → parses ctx; poll fires only on key change; `search` participates in the key.

---

### Task 5: Detection (`detect.js`)

**Files:** Create `src/devtools/detect.js`; Test `tests/devtools-detect.test.js`.

- Special cases **before** the route table: `/documents?level=all`→`{type:'organization',via:'org'}`; `/documents?…&level=queue` single queue→queue; `/queues/{q}/settings/fields`→`{via:'queue'}` (schema); `/queues/{q}/settings/emails`→`{via:'queue-inbox'}` (inbox); exact-match read-only list routes (`/extensions/my-extensions`→Hooks, `/settings/users`→Users, `/settings/labels`→Labels).
- `ROUTES` (first-match-wins): rule (`/queues/{q}/settings/rules/{r}/detail`) **before** queue (`/queues/{id}`); hook; user; schema (`/settings/field-manager/detail/{id}`); engine (`/automation/engines/{id}`); annotation (`/document/{id}` and `/annotation/{id}`, both → `/api/v1/annotations/{id}`).

**Tests:** one case per route with correct `{type,id,apiPath,label}`; ordering (rule before queue, list routes don't shadow detail routes, `level=all` vs `level=queue`); via descriptors; list pages read-only no-id; unknown routes → null.

---

### Task 6: Actions (`actions.js`)

**Files:** Create `src/devtools/actions.js`; Test `tests/devtools-actions.test.js`.

- `deps = { getJson, patch, reload }`.
- `resolveResource(resource,deps)`: `via:'queue'`→GET queue→`resourceFromApiUrl(queue.schema)` (else `{noSchema}`); `via:'queue-inbox'`→`queue.inbox` (else `{noInbox}`); `via:'org'`→GET `/api/v1/organizations`→`results[0].url` (else `{noOrg}`).
- `loadResource(tabId,deps)`: resolve `via` if present, GET `apiPath`, set `original`/`buffer`, honor descriptor `readOnly`; **resource-change guard** (bail if the tab's key changed across awaits); catch chain: noSchema/noInbox/noOrg → 404 → 403/405 (read-only) → 401 → generic.
- `requestDiff(tabId)`: parse buffer → `diffPreview` (or inline parse error).
- `saveResource(tabId,deps)`: `buildPatchBody`; empty-body → clear; else PATCH → re-GET → reset baseline → clear preview → **`deps.reload()` only when `cur.source==='page'`**; resource-change guard; 400/401/403/405 errors.
- `openResourceTab(resource,deps)`: openTab as `'link'`; **load only if it wasn't already open** (re-click focuses without clobbering unsaved edits). No `undo`.

**Tests:** load incl. via-resolution (mock getJson returns a queue with `schema`/`inbox`, or an org list); readOnly honored; resource-change guard by tab id; save→reload asserted for the page tab and **not** for link tabs; empty-body no-PATCH; error mapping; openResourceTab no-clobber; no undo export.

---

### Task 7: Lean editor (`JsonCodeEditor.jsx`) + links (`cmLinks.js`) + theme (`theme.js`)

**Files:** Create `src/devtools/JsonCodeEditor.jsx`, `src/devtools/cmLinks.js`, `src/devtools/theme.js`; Test `tests/devtools-jsoneditor.test.js`, `tests/devtools-cmlinks.test.js`, `tests/devtools-theme.test.js`.

- `theme.js` `isDark()`: `chrome.devtools.panels.themeName === 'dark'`, else `matchMedia('(prefers-color-scheme: dark)')`.
- `JsonCodeEditor({tabId, onFollowLink, onContextLink})`: one `EditorView` (`basicSetup` + `json()` + `cmLinks` + custom `lightHL`/`darkHL` `HighlightStyle` by `isDark()` + a transparent-background `surfaceTheme`). Reads the tab by id; docChanged → `patchTab` dirty (external-sync guard so programmatic reload doesn't dirty); sets/clears `store.views.active`. No pipeline gutter/completions. (No `oneDark`.)
- `cmLinks.js` `rossumLinks(onFollowLink,onContextLink)`: `ViewPlugin`/`MatchDecorator` underlines Rossum API URLs; `mousedown` with `metaKey`/`ctrlKey` over a URL → `onFollowLink(url)`; `contextmenu` over a URL → `preventDefault` + `onContextLink(url,x,y)`; `urlAt(view,pos)` helper.

**Tests:** editor smoke (mounts under jsdom via `setup.js`), edit updates `buffer`/`dirty`, parse-error surfaced, external sync doesn't dirty; theme `isDark` branches; cmLinks decoration + metaKey mousedown → `onFollowLink`, contextmenu over link → `onContextLink` + preventDefault, not-over-link → no-op.

---

### Task 8: Panel shell (`panel.jsx`, `panel.css`, `DiffConfirm.jsx`, `devtools.js`, html) + registrar & build

**Files:** Create `src/devtools/panel.jsx`, `panel.css`, `DiffConfirm.jsx`, `devtools.js`, `devtools.html`, `panel.html`; Modify `manifest.json`, `build.js`; Test `tests/devtools-panel.test.js`, `tests/devtools-diffconfirm.test.js`.

- `devtools.js`: `chrome.devtools.panels.create('Rossum', 'icons/48-blue-crunch.png', 'devtools/panel.html')` — plain registrar, **no `onShown`/`onSearch`**.
- `panel.jsx`:
  - Mount effect: set `data-theme`; document `mousedown`/Escape dismiss for `linkMenu`+`tabMenu`; **capture-phase `window` `keydown`** → Cmd/Ctrl+F: if `store.views.active`, `preventDefault`+`stopImmediatePropagation`+focus+`openSearchPanel`; `startBridge` → `api.init` + `detectResource` + `syncPageTab` + `loadResource` when `changed && next`; clean up all listeners + stop bridge.
  - Render (single path): **TabBar** → error banner → **body** (`!active.resource` → hint; loading → "Loading…"; else `JsonCodeEditor`) → **footer** (only when `active.resource`: Save [dirty-gated] or read-only note) → **menus** (one keyed array: `linkMenu` "Open in new tab"; `tabMenu` — "Close" only for non-page tabs, "Close Other Tabs" when `tabs.length>1`, using a `menuTab` lookup) → `DiffConfirm` overlay. `active = activeTab() || tabs[0]`; a defensive `!active` crash-guard (unreachable — seeded at load).
  - `TabBar`: each tab a chip (`.rawjson-tab`, `.rawjson-tab--page` for the root, `active` highlight); label `"{label} {id}"` or `"Page"` when resource-less; link tabs `draggable` + `onDragStart/Over/Drop`→`moveTab`; page tab not draggable, no ✕; `onContextMenu` opens `tabMenu` unless it's the sole default tab (nothing to close).
- `panel.css`: theme variables + `data-theme` dark; flex-fill body/editor; `.cm-editor{font-size:11px}`; `.rawjson-tab--page` (tint + heavier divider); `.rawjson-linkmenu`/`.rawjson-tabmenu`.
- `DiffConfirm.jsx`: leaf-level diff render + Confirm/Cancel.
- `manifest.json`: add `"devtools_page":"devtools/devtools.html"`. `build.js`: entry points `devtools/devtools`, `devtools/panel`; copy `devtools.html`, `panel.html`, `panel.css`.

**Tests:** hint renders in the default tab (tab bar visible, label "Page", no ✕); tab bar render/switch/close; page tab no ✕; readOnly note + Save hidden; Save→diff overlay; no Undo; link menu render+open+dismiss(+setActive/closeTab clear); tab menu Close (link only) + Close Other Tabs (keeps page tab) + dismiss + sole-default-tab opens no menu; drag reorder via moveTab; Cmd+F capture (real editor → preventDefault+focus; no active view → no preventDefault). DiffConfirm render + confirm/cancel.

---

### Task 9: Content preview (`api.getResource`, `PreviewPane.jsx`, `contentMeta.js`)

**Files:** Create `src/devtools/contentMeta.js`, `src/devtools/PreviewPane.jsx`; Modify `src/devtools/api.js` (`getResource`), `store.js` (`tab.preview:null`), `actions.js` (blob branch), `panel.jsx` (render precedence + footer + `deps.getResource`), `panel.css`; Tests `tests/devtools-{contentmeta,preview}.test.js` + `api`/`actions`/`panel` additions.

- `api.getResource(apiPath)` — one fetch, branch on `Content-Type`: `/\bjson\b/i` → `{kind:'json',data}`; else `{kind:'blob', contentType, size, filename, blob}` (`filenameFrom` from `Content-Disposition` else path+`extFor`). Error `{status,body}` identical to `getJson`. `getJson` kept for `via` resolution + save re-fetch.
- `contentMeta.js` (pure): `extFor` (pdf/png/jpg/svg/gif/webp/doc/docx/xls/xlsx/csv/txt/zip/xml + `image/*` fallback), `formatBytes`, `filenameFrom` (RFC 5987 `filename*` charset-prefix tolerant).
- `loadResource`: blob result → `tab.preview` + `readOnly:true` + clear `original`/`buffer`; JSON → `preview:null`. The **catch** defaults `readOnly` from the tab's descriptor (a failed load of a read-only-by-descriptor resource stays read-only) + clears `preview`.
- `PreviewPane.jsx` (keyed by tab id): `image/*`→`<img>`, `application/pdf`→`<iframe>` (**not** `<embed>`/`<object>` — MV3 `object-src 'self'` blocks a `blob:` object), else file-info card; Download + Open-in-tab on the object URL; object URL created in `useEffect([blob])`, revoked on unmount/blob-change.
- `panel.jsx`: body precedence `!resource→hint | loading | preview→PreviewPane | editor`; footer only for `resource && !preview`.

**Tests:** `getResource` json/blob/missing-CT/error; `contentMeta` helpers; `loadResource` blob→preview+readOnly + failed-readOnly-descriptor stays read-only; `PreviewPane` img/iframe/card + Download/Open + one-createObjectURL-revoked-on-unmount (hermetic, `URL.createObjectURL` stubbed); panel preview tab renders `PreviewPane` + no Save. Dogfood: real image/PDF render, `blob:` iframe under CSP, live `documents/{id}/content` content-type.

### Task 10: Inline name hints + prefetch cache (`resourceCache.js`, `nameResolve.js`, `cmNames.js`)

**Files:** Create `src/devtools/resourceCache.js`, `nameResolve.js`, `cmNames.js`; Modify `cmLinks.js` (export `rossumUrlRe()`), `JsonCodeEditor.jsx` (add `rossumNames`), `actions.js` (cache-first + warm), `panel.jsx` (`deps.getCached`/`putCached`), `panel.css` (`.rawjson-name`); Tests `tests/devtools-{resourcecache,nameresolve,cmnames}.test.js` + `actions`/`jsoneditor` additions.

- `resourceCache.js` — `pickName(type,obj)` (user → `"username (First Last)"`|username|email; documents → `original_file_name`; else `.name`) + cache `apiPath→{name,obj,at,status}` (~200 cap, oldest-evict): `nameFor`, `getFresh(≤60s, done-only)`, `put(apiPath,obj)` (derives name), `setStatus`, `clear`.
- `nameResolve.js` — `makeNameResolver(getJson, cap=6)` → `nameFor`/`ensure`: `nameable()` (single id, `!readOnly`) skips sub-resources; in-flight dedupe; per-instance `pending`/`queue`/`active` pump; multi-subscriber notify; negative-cache errors. Singleton bound to `api.getJson` (one instance/session).
- `cmNames.js` — `ViewPlugin` scanning `visibleRanges` (via `rossumUrlRe()`): dimmed line-end `.rawjson-name` widgets for resolved names (per-line, `·`-joined); `ensure(url, scheduleRefresh)` for unresolved; debounced `refreshNames` `StateEffect` rebuild; settled error/no-name never re-`ensure`.
- `JsonCodeEditor` adds `rossumNames(resolver.nameFor, resolver.ensure)` (always on).
- `actions.loadResource` — cache-first: `deps.getCached?.(apiPath)` hit → `{kind:'json'}` (instant, no fetch); warm `deps.putCached?.(apiPath, data)` **only on a genuine JSON fetch** (not a hit — avoids resetting the freshness clock). Dependency-injected (absent in existing tests → unchanged behavior).

**Tests:** `pickName` (user format + fallbacks, documents, name-less→null); cache put/nameFor/getFresh-TTL/setStatus/cap-evict; resolver nameable filter, fetch-once+notify, concurrent dedupe (all subscribers), error-cache-no-refetch, concurrency cap; `cmNames` resolved→widget / loading→ensure-no-widget / non-nameable→skip / no-display-name→skip / multi-per-line `·` / async pop-in via refresh effect; `loadResource` cache-hit (no getResource, no re-warm) / miss→fetch+warm / blob→no-warm; editor integration (pre-warmed cache → `.rawjson-name` appears). Dogfood: live name fields, async pop-in, instant-open feel.

**Known deferred (documented):** name hints for read-only collections (`organization_groups`) are skipped by the `!readOnly` filter; multi-resolver-instance safety (singleton assumption documented in-code).

---

## Self-review checklist

- [ ] Every spec section maps to a task (detection incl. all special cases + ordering; link-nav + sub-resources; permanent default tab; capture Cmd+F; readOnly incl. `organization_groups`; emails→inbox; drag reorder; save→reload-page-tab-only).
- [ ] No placeholders; types/signatures consistent across tasks (`keyOf`, `deps`, `syncPageTab` return shape).
- [ ] Dogfood-only items called out (visual font/color, live routes, real right-click/Cmd+F/drag) — not asserted in unit tests.
- [ ] Full suite green; `dist/` rebuilt for browser dogfood (tests run against `src/`, the loaded extension runs `dist/`).
