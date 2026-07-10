# DevTools "Rossum" panel — Raw Object Editor (consolidated design)

**Date:** 2026-07-10
**Status:** Implemented (uncommitted on `master`). This is the authoritative, current design.
**Consolidates & supersedes:** the in-page origin + DevTools pivot + v2–v4 incrementals, the "permanent default tab" refinement (batch 9), the numeric sub-resource-link fix, and the two v5 features — **content preview** (`2026-07-10-devtools-content-preview-design.md`) and **inline name hints + prefetch** (`2026-07-10-devtools-inline-names-design.md`). All those incremental specs and their plans are removed; this document and its plan (`2026-07-10-devtools-rossum-panel.md`) are the single authoritative pair. History is summarized at the end.

## Problem & goal

The Rossum dashboard renders only a curated subset of each resource's fields. Many settings a solution architect needs during onboarding live in `settings.*`, `metadata`, thresholds, and feature flags the polished UI never shows. Seeing or changing those today means leaving the app for curl/Postman/the console.

**Goal:** while inspecting a Rossum page, let an SA see the underlying Rossum API resource as JSON, navigate between related resources, and safely edit hidden fields via a confirmed `PATCH`.

## Placement: a Chrome DevTools panel (not an in-page surface)

The feature is a **Chrome DevTools panel named "Rossum"** (`devtools_page` → `chrome.devtools.panels.create`). DevTools is a natural home for a raw-object power tool: per-tab, invisible until DevTools is open, self-gated to Rossum pages, and (being its own extension page) free of the always-injected content script's bundle-size limits. The earlier in-page slide-out panel (built, reviewed, then retired) is gone; only this surface ships.

### Why not reuse DevTools' native Sources editor?

A multi-source investigation (developer.chrome.com, MDN, Chromium docs, GitHub) was run because the Sources panel has a nice native editor with edit / Cmd+F / tabs. **Verdict (adversarially verified): an extension cannot reuse it for edit→PATCH.**

- The only top-level surface an extension can add is a `chrome.devtools.panels.create()` iframe — no hook into the native Sources editor.
- Extension sidebar panes are **read-only** (`setObject` renders a tree; only `onShown`/`onHidden`, no edit/change event).
- `panels.openResource(url, line)` is navigation-only.
- `chrome.debugger`/CDP instruments the inspected **page**, not the DevTools frontend.
- Workspaces / Local Overrides round-trip Sources edits to **local disk, never HTTP**, with no programmatic control.
- `inspectedWindow.Resource` + `onResourceContentCommitted` is the only native edit-commit callback, but it operates only on resources already loaded in the page (can't host arbitrary fetched JSON).

**Therefore a custom `panels.create()` + CodeMirror panel is the correct and only path** for editable JSON with PATCH-back.

## Gating

Self-gated: the panel is always available on Rossum pages, with **no popup toggle and no experimental unlock** (DevTools is already a deliberate power-user surface). The in-page feature's `rawObjectEditorEnabled` toggle and `patchRossumApi` helper were removed.

## Architecture (`src/devtools/`)

```
devtools.html / devtools.js   # registrar: panels.create('Rossum', icon, 'devtools/panel.html')
panel.html / panel.jsx        # panel shell (tab bar → error → body → footer; menus; DiffConfirm overlay)
panel.css                     # panel styles (theme-aware via data-theme + prefers-color-scheme)
inspected.js                  # startBridge: read {token,domain,pathname,search} from the inspected tab; poll for SPA nav
api.js                        # {init, getJson, getResource, patch}; getResource branches JSON vs blob by Content-Type
detect.js                     # detectResource({pathname,search}) → resource descriptor | null
resourceFromApiUrl.js         # resourceFromApiUrl(url) → descriptor | null (link-nav; READONLY_COLLECTIONS; numeric sub-paths)
store.js                      # Preact signals: tabs[] (incl. preview), activeId, linkMenu, tabMenu, views.active
actions.js                    # loadResource / requestDiff / saveResource / openResourceTab (deps-injected; cache-first)
diff.js                       # buildPatchBody / diffObjects (pure)
JsonCodeEditor.jsx            # lean CodeMirror JSON editor (per-tab; link decoration + name hints; theme highlight)
cmLinks.js                    # CodeMirror extension: underline Rossum API URLs; Cmd/Ctrl+click + right-click; rossumUrlRe()
cmNames.js                    # CodeMirror extension: dimmed line-end resource-name hints (viewport-scoped)
PreviewPane.jsx               # non-JSON content preview (image/pdf/file-info + Download/Open); owns the blob object URL
contentMeta.js                # pure: extFor / formatBytes / filenameFrom (for content preview)
resourceCache.js              # pickName + session cache {apiPath→{name,obj,at,status}} (names + prefetch)
nameResolve.js                # makeNameResolver(getJson): nameFor / ensure (dedupe + concurrency); singleton
DiffConfirm.jsx               # diff render + confirm/cancel overlay
theme.js                      # isDark() from DevTools themeName, prefers-color-scheme fallback
```

Build: `manifest.json` has `"devtools_page": "devtools/devtools.html"` (no new permissions — `host_permissions` already covers Rossum hosts; DevTools APIs need none). `build.js` adds entry points `devtools/devtools` and `devtools/panel` and copies `devtools.html`, `panel.html`, `panel.css`.

## Auth & inspected-tab bridge (`inspected.js`, `api.js`)

A DevTools panel runs on the extension origin with no same-origin token. `startBridge(onCtx)` uses `chrome.devtools.inspectedWindow.eval` to read `{ token: localStorage.secureToken, domain: location.origin, pathname, search }` from the inspected tab's main world, and **polls** (Rossum is an SPA) — re-firing `onCtx` only when the key `domain|pathname|search|token` changes (`search` is included so `/documents?level=all` vs `?…&level=queue` on the same path re-detect). `api.init(domain, token)` stores them; `getJson`/`patch` call `${domain}/api/v1/…` with `Authorization: Token <token>` (the dashboard proxies `/api/v1` on its own origin; an extension page with `host_permissions` may make this cross-origin call). Verified live against a dev org.

## Resource detection (`detect.js`)

`detectResource({pathname, search})` returns `{type, id, apiPath, label, readOnly?, via?, queueId?, queueApiPath?}` or `null`. Special cases are matched **before** the general route table (first-match-wins):

- `/documents?level=all` → `{type:'organization', via:'org', label:'Organization'}` (resolved via `GET /api/v1/organizations` → `results[0].url`).
- `/documents?filtering=…&level=queue` with a single queue id → that **queue**.
- `/queues/{q}/settings/fields[/…]` → `{type:'schema', via:'queue', queueApiPath, label:'Schema'}` (resolved via `queue.schema`).
- `/queues/{q}/settings/emails[/…]` → `{type:'inbox', via:'queue-inbox', queueApiPath, label:'Inbox'}` (resolved via `queue.inbox`; `null` inbox → honest error).
- Exact-match read-only **collection** pages (no id, `readOnly:true`): `/extensions/my-extensions` → Hooks, `/settings/users` → Users, `/settings/labels` → Labels.

General detail routes (`ROUTES`, order matters):

- **rule** — `/queues/{q}/settings/rules/{ruleId}/detail` (matched **before** the queue row).
- **queue** — `/queues/{id}`.
- **hook** — `/extensions/my-extensions/{id}`.
- **user** — `/settings/users/{id}`.
- **schema** — `/settings/field-manager/detail/{id}` (direct route; the Fields tab uses the `via:'queue'` resolve above).
- **engine** — `/automation/engines/{id}`.
- **annotation** — `/document/{id}` and `/annotation/{id}` → `/api/v1/annotations/{id}` (the `/document/{id}` segment carries the **annotation** id). The panel edits the annotation **object** (metadata/status/labels) via PATCH; datapoint **content** is not edited here.

Dashboard URL routes are not API paths — they were mapped by grepping the elis.rossum.ai bundle (data-free) and verified live. Workspace and organization have no detail route (reached only via link-nav). Types are shipped only once their route + `apiPath` are confirmed against a dev org (correctness over guessing).

## Link navigation & `resourceFromApiUrl.js`

`resourceFromApiUrl(url) → descriptor | null` parses any `…/api/v1/<collection>/<id>(/<sub>*)` (query/trailing tolerant), so link-nav reaches **any** resource — including workspace/organization that have no page route.

- Known collections map to a clean `{type,label}`; unknown → generic `{type: collection, label: TitleCase(singular)}` (`titleSingular` handles `-ies`/`-es`/`-s`, e.g. `pages`→`Page`, `email_templates`→`Email template`).
- A **sub-path** (word and/or numeric segments, e.g. `/annotations/123/content` or a specific datapoint `/annotations/123/content/19453284337`) yields `apiPath` including the sub-path and `readOnly:true` (sub-resources are not PATCH-editable via this flow). Label = TitleCase of the last segment, or — when the last segment is a numeric id — `"<PrecedingSegment> <id>"` (e.g. `"Content 19453284337"`) so multiple datapoint tabs stay distinct.
- `READONLY_COLLECTIONS = new Set(['organization_groups'])`: viewable (GET 200) but not PATCH-editable, so marked `readOnly` up front (editing is disabled instead of failing on save). Extensible as more are found; the 403/405-on-save fallback remains the net.

**`store.keyOf(resource)`** is apiPath-based: `via:'queue'`→`schema-via-queue:{q}`, `via:'queue-inbox'`→`inbox-via-queue:{q}`, `via:'org'`→`org:current`, else `apiPath || type:id`. Sub-resources get distinct keys (so an annotation's `content` opens as its own tab instead of deduping onto the parent).

## Tabs model (`store.js`, `panel.jsx`)

Tab state is `tabs = signal([])` + `activeId = signal(null)`; each tab is `{ id, source:'page'|'link', resource, original, buffer, loading, saving, error, readOnly, dirty, diffPreview }`.

- **One permanent default (page) tab** (`.rawjson-tab--page`, visually distinct, pinned first): **always visible and never closeable.** It is seeded at store load (`ensurePageTab()`), and the invariant is enforced by the store — `syncPageTab` never drops it, `closeTab` refuses it, `closeOtherTabs` preserves it, `moveTab` keeps it at index 0. It follows the inspected page: when a resource is detected it shows it (label `"Queue 123"`); when none is detected it becomes **resource-less** (label `"Page"`) and its **body shows the hint** ("Open a Rossum queue, hook, user, …") — there is no separate no-tabs empty state.
- **Link tabs** (`source:'link'`, closeable) open on Cmd/Ctrl+click or right-click "Open in new tab" of a Rossum API URL in the editor. Pinned after the root; reorderable by **drag-and-drop** (`moveTab`, root stays first). Re-opening an already-open resource focuses it without clobbering unsaved edits (`openResourceTab` loads only if new).
- **Tab context menu** (`tabMenu`): **"Close"** (link tabs only — never offered for the default tab) + **"Close Other Tabs"** (keeps the clicked tab *and* the default tab). Right-clicking the sole default tab opens no menu.
- `openTab` dedups by `keyOf`. `closeTab` activates a neighbor. `setActive`/`closeTab`/`closeOtherTabs` clear both menus; outside-mousedown and Escape dismiss them.

## Editor (`JsonCodeEditor.jsx`, `cmLinks.js`, `panel.css`)

- CodeMirror `EditorView` with `basicSetup` + `@codemirror/lang-json`, one per active tab (keyed by tab id). **No header** — the tab shows the resource identity. Compact **11px** font, fills the panel edge-to-edge.
- **Theme-aware:** `theme.js` `isDark()` (DevTools `chrome.devtools.panels.themeName`, `prefers-color-scheme` fallback) selects a custom **`HighlightStyle`** (light + dark) approximating the rest of DevTools' JSON palette (`@codemirror/language` `HighlightStyle.define` + `syntaxHighlighting`, `@lezer/highlight` tags); a transparent editor background lets the panel `--bg` (theme-driven via `data-theme`) show through in both modes. `oneDark`/`theme-one-dark` was removed. Chrome exposes only the DevTools theme **name** (not its tokens), so this is a close approximation, dogfood-tuned.
- **Link decoration** (`cmLinks.js` `rossumLinks(onFollowLink, onContextLink)`): underlines strings matching a Rossum API URL. **Cmd/Ctrl+click** within one → `onFollowLink(url)` (opens/focuses a link tab). **Right-click** within one → `onContextLink(url,x,y)` → a `.rawjson-linkmenu` "Open in new tab". Plain click still edits.
- A change listener writes the tab's `buffer`/`dirty` (external sync guarded so a programmatic reload doesn't mark dirty). `store.views.active` holds the active `EditorView` for search.
- **Inline name hints** (`cmNames.js` `rossumNames`): see the dedicated section below.

## Inline resource-name hints & prefetch cache (`cmNames.js`, `nameResolve.js`, `resourceCache.js`)

The editor annotates each **visible** `/api/v1/<collection>/<id>` reference (scalar fields **and** array elements) with the target object's **name**, dimmed at the line end (`.rawjson-name`; multiple per line joined with `·`). Auto-resolved for visible links only, so it fetches just what you look at.

- **`resourceCache.js`** — `pickName(type,obj)` (pure) + a session, in-memory cache `apiPath → {name, obj, at, status}` (~200-entry cap, oldest-evicted; never persisted). `pickName`: user → `"username (First Last)"` (else `username`, else `email`); `documents` → `original_file_name`; else `.name`; no name → no hint. `getFresh(apiPath, ≤60s)` returns the object only while fresh; `nameFor` returns `{status,name}`.
- **`nameResolve.js`** — `makeNameResolver(getJson)` → `nameFor`/`ensure`: resolves a nameable single-id URL (skips sub-resources like `…/content` and read-only descriptors) with **in-flight dedupe**, a **concurrency cap (~6)**, multi-subscriber notify, and **negative-cached errors** (no refetch, no hint). A singleton bound to `api.getJson` is used by the editor. NOTE: one resolver instance per session (the cache is shared; two live instances could drop a subscriber) — production mounts one editor at a time.
- **`cmNames.js`** — a `ViewPlugin` that scans `visibleRanges`, adds a dimmed line-end `Decoration.widget` for resolved names, calls `ensure(url, refresh)` for unresolved ones, and rebuilds on a **debounced `refreshNames` `StateEffect`** as names arrive (no dispatch→build storm: settled error/no-name links never re-`ensure`). Reuses `cmLinks`' `rossumUrlRe()`.
- **Prefetch reuse** — because resolving a name fetches the whole object, `resourceCache` doubles as a prefetch: `loadResource` checks `deps.getCached(apiPath)` (a `getFresh` hit) and opens the link tab **instantly** with no network call, and warms `deps.putCached(apiPath, obj)` **only on a genuine fetch** of a JSON result (re-putting a hit would reset its freshness clock). Dependency-injected → existing tests that omit these deps keep the exact prior load behavior. A ≤60s baseline is no staler than a normally-loaded tab.

## Content preview (`api.getResource`, `PreviewPane.jsx`, `contentMeta.js`)

Some references return a file, not JSON (e.g. `documents/{id}/content`). `api.getResource(apiPath)` does one fetch and branches on the response **Content-Type**: `*/json` → `{kind:'json',data}` (the editor, as before); anything else → `{kind:'blob', contentType, size, filename, blob}`. `getJson` is retained for JSON-guaranteed calls (`via` resolution + save re-fetch).

- `loadResource` stores a blob result on `tab.preview` (read-only; clears `original`/`buffer`); JSON leaves `preview:null`. Render precedence: hint → loading → **preview** → editor; the footer/Save render only for `resource && !preview`.
- **`PreviewPane.jsx`** — `image/*` → `<img>`, `application/pdf` → `<iframe>` (**not** `<embed>`/`<object>` — the MV3 extension-page CSP `object-src 'self'` blocks a `blob:` object; `frame-src` is unrestricted), else a file-info card (type · size · filename). Every preview has **Download** + **Open in browser tab**, both on the `blob:` object URL (opening `${domain}${apiPath}` directly would 401 — a plain nav carries no `Token`). The object URL is created/revoked with the component lifecycle (no leak).
- **`contentMeta.js`** (pure) — `extFor(contentType)`, `formatBytes(n)`, `filenameFrom(contentDisposition, apiPath, contentType)` (RFC 5987 `filename*` charset-prefix tolerant; path+ext fallback).
- A **failed load** of a read-only-by-descriptor resource stays read-only (the catch defaults `readOnly` from the descriptor), so a binary endpoint never falls through to an editable editor.

## Search: Cmd/Ctrl+F (capture-phase)

Cmd/Ctrl+F is intercepted by a **capture-phase `keydown` listener** on `window` in the panel: if there's an active editor (`store.views.active`), it `preventDefault()` + `stopImmediatePropagation()`, focuses the view, and calls `openSearchPanel` (CodeMirror's own search) — so DevTools' native search bar does not surface. `basicSetup`'s `searchKeymap` remains (in-editor search when focused). The earlier `panel.onSearch` forwarding (v2) was tried and **reversed** — it made DevTools show its own bar; `devtools.js` registers no `onSearch` and `search.js` was removed. Real-panel "no native bar" is a dogfood check (not unit-testable).

## Edit → diff → confirm → save (`diff.js`, `actions.js`, `DiffConfirm.jsx`)

- **Baseline** `O` = the fetched object; **edited** `E` = `JSON.parse(buffer)` (parse error blocks Save, shown inline).
- **Diff** classifies top-level keys as changed/added/removed (deep-equality) with a leaf-level breakdown. **PATCH body = the whole current value of each changed/added top-level key, verbatim** — because Rossum PATCH replaces a top-level key wholesale (nested objects are not deep-merged server-side), sending the complete sub-tree guarantees no untouched nested field is dropped. Unchanged meta keys (`id`, `url`, `modified_at`, …) are never in the diff. **Removals** are surfaced explicitly, not auto-applied (PATCH can't cleanly delete a key). Diff shown == diff sent.
- On confirm → `PATCH` → re-`GET` (reset baseline to the server's canonical result) → **reload the inspected page**, but **only when the saved tab is the page tab** (`source==='page'`); link-tab saves don't reload. **No Undo.** A resource-change guard (by tab id, keyed on `keyOf`) ensures a mid-save SPA nav never writes the wrong resource.

## Read-only & errors (`actions.js`)

- Descriptor `readOnly` (sub-resources, `READONLY_COLLECTIONS`, list pages) → the editor is non-editable and Save is hidden from the start.
- `403`/`405` on load → read-only fallback (view, no Save). `400` on save → the server's validation message verbatim, buffer preserved. `401` → "Session expired — reload the Rossum page." `404` → context-rich ("another organization, a support-access user, or deleted"). `via` resolution failures → honest "This queue has no schema/inbox." / "Could not resolve the organization."

## Data handling

Nothing leaves the browser: resource JSON is fetched, displayed, and PATCHed inline via same-origin Rossum API calls the SA is already authorized to make. No resource contents are persisted to `chrome.storage` or logged. No customer names or customer data leave the browser.

## Testing

Vitest, `tests/devtools-*.test.js`, `h(Component, null)`, condition-based `waitFor`; `tests/setup.js` polyfills the Range APIs CodeMirror needs under jsdom. Covered: `detect` (all routes incl. ordering + special cases), `resourceFromApiUrl` (known/generic/sub-path/readonly/non-match), `diff` (classification + nested preservation + removal-surfaced), `store` (tab helpers, permanent-default-tab invariant, keyOf, moveTab), `actions` (load incl. via-resolution, save→reload-page-tab-only, resource-change guard, read-only, no undo), `api`, `inspected` (bridge dedup), `theme`, `cmLinks` (link decoration + Cmd/Ctrl+click + right-click), `JsonCodeEditor` (smoke, edit→dirty, parse-error), `panel` (tab bar, menus, Cmd+F capture, empty-state-in-default-tab, read-only). **Not unit-testable (dogfood):** editor fill/font/color visual, live routes, real right-click, real Cmd+F "no native bar", real drag.

## Backward compatibility

The whole feature is uncommitted and additive: no external contracts change, no existing storage keys/entry points/feature contracts are touched. `manifest.json` gains `devtools_page` only. The in-page surface's removals (`rawObjectEditorEnabled` toggle, `patchRossumApi`) leave only orphaned stored values, harmless. Full suite green.

## Out of scope

Annotation datapoint-content **editing** (annotations edit the object only; content opens read-only); name hints inside the **preview** pane (binary has no references); name hints for read-only collections like `organization_groups` (excluded by the `!readOnly` nameable filter — a known minor gap); a **persisted/cross-session** name cache; list pagination beyond the first page; a paste-a-URL explorer; NetSuite/Coupa. **Ship-blocker:** the agent/read-only stance here is client-side defense-in-depth; a **server-side write-lock remains the owner's ship-blocker before non-dogfood use.**

## History (superseded, condensed)

- **v0 (in-page):** slide-out panel injected by the Rossum content script, `{ }` trigger, double-gated toggle, `<textarea>` editor, Tree+Raw views. Built + reviewed, then **retired** in the DevTools pivot.
- **DevTools pivot:** re-homed to a `panels.create` panel + lean CodeMirror editor; in-page surface + toggle removed.
- **v2:** rename to "Rossum"; remove Undo; reload-on-save; in-panel tabs + link-nav; schema-via-fields; (the native-Sources research verdict); `onSearch` (later reversed).
- **v3:** full-space smaller editor; sub-resource links + apiPath `keyOf`; right-click "Open in new tab"; list pages + `/documents?level=all`→organization; remove the editor header.
- **v4:** 11px font; DevTools-approx custom highlight colors; tab "Close Other Tabs" menu; Cmd+F capture-phase (reversing `onSearch`); `organization_groups` read-only; emails→inbox; visually separate the root tab; drag-and-drop reorder.
- **batch 9:** the default (page) tab is now permanent — always visible, never closeable, hint rendered in its body when no object is selected.
- **numeric sub-resource links:** `resourceFromApiUrl` accepts numeric sub-path segments (e.g. `…/content/19453284337`) so datapoint-content links open (labelled `"Content <id>"`).
- **v5-A (content preview):** non-JSON responses render as image/PDF/file-info instead of the JSON editor (content-type driven; `getResource`/`PreviewPane`/`contentMeta`).
- **v5-B (inline names + prefetch):** dimmed inline resource-name hints on visible references; the objects fetched for names double as a prefetch cache for instant link-open (`cmNames`/`nameResolve`/`resourceCache`).
