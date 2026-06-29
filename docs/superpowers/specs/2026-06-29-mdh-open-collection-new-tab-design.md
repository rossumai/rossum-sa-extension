# MDH — Open Collection in a New Tab — Design

**Date:** 2026-06-29
**Status:** Approved (pending implementation plan)

## Problem

Users requested the ability to view multiple MDH collections side by side in
separate browser tabs. Today the MDH app is a single-collection SPA: clicking a
collection in the sidebar switches the *current* tab's selection
(`selectCollection` in `src/mdh/components/Sidebar.jsx`). There is no way to open
a collection in a *new* browser tab.

The recently-shipped per-tab navigation state (each Console tab keeps its own
`mdhSelectedCollection` etc. via `sessionStorage`, with `chrome.storage.local` as
a cross-session seed — see `src/console/tabState.js`) is the enabler: two Console
tabs can now hold different collections without clobbering each other on reload.

## Goal

A discoverable, low-friction way to open a chosen collection in a new browser
tab, pre-focused on that collection, reusing the existing tab-open machinery.
Purely additive; plain-click behavior unchanged.

## Non-goals

- Opening Overview or Operation Logs in a new tab (collections only; can extend later).
- Deduplicating tabs (opening a collection already shown elsewhere just opens
  another tab — multiple tabs is the point).
- Cloning the current tab's *live, unsaved* editor text into the new tab. The new
  tab restores the collection's last-*saved* pipeline (decision below).
- Any change to the manifest, permissions, or `web_accessible_resources`.

## Key facts (verified against the code, not assumed)

- A Console tab is opened by staging a single-use `consoleAuth_<uuid>` entry in
  `chrome.storage.local` carrying `{ token, domain, app, pendingCollection?,
  pendingPipeline?, … , createdAt }` and opening
  `console/console.html?authId=<uuid>`. The popup does this in
  `src/popup/utils.js` `openConsoleTab`; the service worker does it in
  `src/background/index.js` `openDatasetManagement`.
- `chrome.tabs.create` requires **no** `"tabs"` permission (the manifest has only
  `storage`/`activeTab`/`scripting`); the popup already calls it. The Console page
  is an extension-page context like the popup, so it can call it too. Opening the
  extension's own `console.html` from an extension page is same-origin → no
  `web_accessible_resources` needed.
- `initMdh` already honors a staged `pendingCollection`: it sets
  `activeView='collection'`, `selectedCollection=pendingCollection`,
  `activePanel='data'`, and — because no `pendingPipeline` is staged — its boot
  path then restores that collection's `mdhLastPipeline::<scope>::<collection>`
  via `bootPrefillFor`. So staging only `pendingCollection` yields exactly the
  desired "open the collection with its last-used pipeline" behavior with no new
  boot logic.
- Unconsumed `consoleAuth_<uuid>` entries are swept by the existing 24h
  stale-auth purge (`computeStaleAuthRemovals`).
- `chrome.tabs.create`/`chrome.tabs.getCurrent` from the Console page will be
  confirmed in-browser during implementation; `window.open(getURL(url),
  '_blank')` is a drop-in fallback (same-origin extension page, user-gesture) if
  needed — the deps-injection below makes swapping trivial.

## Decisions (from brainstorming)

- **Trigger:** both a discoverable kebab-menu item ("Open in new tab") AND the
  power-user gesture Cmd/Ctrl-click (and middle-click) on a collection row. Both
  routes call the same open helper. Plain click is unchanged.
- **New-tab query:** the new tab restores that collection's last-used pipeline
  (the per-collection `mdhLastPipeline` shipped previously). For the
  currently-viewed collection this means the current query carries over (it
  auto-saves on edit, ~400ms debounce); other collections open with their own
  last query. No live editor text is staged.

## Design

### Part A — `src/mdh/openCollectionTab.js` (new)

Deps-injected, mirroring `src/background/index.js`'s `openDatasetManagement(msg,
deps)` so the chrome/crypto surface is mockable in tests.

```js
import { token, domain } from './store.js';

// Pure + testable: the staging entry and target URL for opening `collection`
// in a fresh Console tab focused on MDH.
export function buildOpenTabRequest({ token, domain, collection, uuid, now }) {
  return {
    authKey: `consoleAuth_${uuid}`,
    authEntry: { token, domain, app: 'mdh', pendingCollection: collection, createdAt: now },
    url: `console/console.html?authId=${uuid}`,
  };
}

const realDeps = {
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
  getURL: (p) => chrome.runtime.getURL(p),
  storageSet: (obj) => chrome.storage.local.set(obj),
  getCurrentTab: () => chrome.tabs.getCurrent(),
  tabsCreate: (opts) => chrome.tabs.create(opts),
};

// Stage single-use auth carrying the target collection, then open a new Console
// tab next to the current one. No-op when not connected. Positioning is
// best-effort; the staged entry is consumed on boot (or swept by the 24h purge).
export async function openCollectionTab(collection, deps = realDeps) {
  if (!collection || !token.value || !domain.value) return;
  const req = buildOpenTabRequest({
    token: token.value, domain: domain.value, collection,
    uuid: deps.uuid(), now: deps.now(),
  });
  await deps.storageSet({ [req.authKey]: req.authEntry });
  const opts = { url: deps.getURL(req.url) };
  try {
    const cur = await deps.getCurrentTab();
    if (cur && typeof cur.index === 'number') {
      opts.index = cur.index + 1;
      opts.windowId = cur.windowId;
    }
  } catch { /* positioning is optional */ }
  deps.tabsCreate(opts);
}
```

Note: `chrome.tabs.getCurrent()` returns the Console page's own tab; reading
`.index`/`.windowId` does not require the `"tabs"` permission (only
`url`/`title`/`favIconUrl`/`pendingUrl` are gated). A failure or undefined result
falls through to opening at the browser-default position.

### Part B — `src/mdh/components/Sidebar.jsx` (modify)

Import `openCollectionTab`. Two routes, both calling `openCollectionTab(name)`:

1. **Kebab menu** — add a first item to the existing action menu (which has Copy
   name / Rename / Drop):

```jsx
<button
  class="toolbar-menu-item"
  onClick={() => { const n = menuOpenFor; setMenuOpenFor(null); openCollectionTab(n); }}
>Open in new tab {'↗'}</button>
```

2. **Row gesture** — modify the collection row handlers (currently
   `onClick={() => selectCollection(name)}`):

```jsx
onClick={(e) => {
  if (e.metaKey || e.ctrlKey) { e.preventDefault(); openCollectionTab(name); }
  else selectCollection(name);
}}
onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openCollectionTab(name); } }}
onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
```

`onMouseDown` for the middle button suppresses the browser's autoscroll cursor;
`onAuxClick` (button 1 = middle) performs the open. Plain click is unchanged.

The `↗` glyph is rendered via a JS-expression string (`{'↗'}`) per the
project's JSX-escape rule (raw `\uXXXX` in JSX text renders literally).

### Error handling

- `openCollectionTab` no-ops when `collection` is falsy or `token`/`domain` are
  empty (not connected) — the affordance never produces a broken tab.
- Tab positioning is wrapped in try/catch; failure opens the tab at the default
  position rather than throwing.
- Staging uses the same single-use + 24h-purge lifecycle as every other Console
  open, so an unopened/abandoned entry is cleaned up.

## Testing (TDD)

- `tests/mdh-open-collection-tab.test.js`:
  - `buildOpenTabRequest` (pure): `authKey === 'consoleAuth_<uuid>'`; `authEntry`
    is `{ token, domain, app: 'mdh', pendingCollection, createdAt }`; `url ===
    'console/console.html?authId=<uuid>'`.
  - `openCollectionTab` (stub deps): stages the entry under the right key, calls
    `tabsCreate` with `{ url: <getURL output>, index: cur.index + 1, windowId }`;
    no-ops when `token`/`domain` unset; tolerates `getCurrentTab` rejecting
    (still calls `tabsCreate` without `index`).
- Sidebar wiring test (jsdom; mock the `openCollectionTab` module):
  - kebab "Open in new tab" item calls `openCollectionTab(name)`;
  - Cmd/Ctrl-click on a row calls `openCollectionTab(name)` and NOT
    `selectCollection`; plain click still selects;
  - (optional) middle `auxclick` calls `openCollectionTab(name)`.

Full suite (`npm test`) stays green; `npm run build` succeeds. In-browser
manual check: kebab item, Cmd/Ctrl-click, and middle-click each open a new tab
focused on the chosen collection with its last-used pipeline, positioned next to
the current tab.

## Files touched

- **New:** `src/mdh/openCollectionTab.js` (+ `tests/mdh-open-collection-tab.test.js`)
- `src/mdh/components/Sidebar.jsx` — import helper; kebab item; row
  click/aux/mousedown handlers (+ Sidebar wiring test, new or extending an
  existing sidebar test file)
- `src/console/console.css` — optional minor style for the menu-item glyph
  (only if needed for alignment)
- `CLAUDE.md` — one-line note in the MDH/Sidebar description that a collection
  can be opened in a new tab (kebab item or Cmd/Ctrl/middle-click), reusing the
  `consoleAuth_<uuid>` + `pendingCollection` staging.

## Backward compatibility

- No manifest/permission change, no `web_accessible_resources`, no new storage
  keys (reuses the existing `pendingCollection` staging field and the
  `consoleAuth_<uuid>` lifecycle).
- Plain-click selection, the existing kebab actions, and all other open flows are
  unchanged. The feature is inert unless the user invokes the new affordances.
