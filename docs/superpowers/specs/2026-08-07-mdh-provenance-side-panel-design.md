# MDH provenance in a Chrome side panel

**Status:** approved, ready to implement
**Date:** 2026-08-07
**Origin:** a Chrome Web Store feature request — *"Make a window lock switch … Sometimes I
want to lock the debugging screen that shows queries in Rossum. But if I click away it is
hidden. Would appreciate a switch to make it stay on a page while I'm scrolling Rossum's
annotation screen."*

## What the request means

The "debugging screen that shows queries" is the popup card **"MDH on this screen (beta)"**
(`src/popup/components/MdhProvenancePanel.jsx`). For the open annotation it resolves the
queue's Master Data Hub matching hooks, substitutes the document's own field values into each
configuration's query cascade, replays every query against Data Storage, and marks the outcome
per query (`winner` / `empty` / `skipped` / `gated` / `error`, `mdh-provenance.js`).

It disappears because Chrome closes an action popup on focus loss. **No API can keep a popup
open** — the fix has to be a different surface. What is lost on every dismissal:

- transient panel state — the line-item **Row** selection and scroll position (only the
  schema-ID filter is persisted, `MdhProvenancePanel.jsx:58-67`);
- the view itself when **"Open in Dataset Management"** is clicked (`ConfigBlock.openQuery` →
  `chrome.tabs.create` activates a new tab → popup dies) — it breaks exactly when used;
- vertical room: the popup is hard-capped at 600px (`popup.css:80`).

Network cost is largely absorbed already — hooks, schema types, annotation values and replay
results are cached in `chrome.storage.session` with a 5-minute TTL (`src/popup/cache.js`).

## Decision

Host the **same panel** in a **Chrome side panel**, and **keep the popup exactly as it is**.
The MDH provenance panel deliberately lives in two places for now (owner decision,
2026-08-07). No functionality moves out of the popup; nothing is deleted.

Rejected alternatives (owner reviewed a rendered mockup of the side panel before deciding):

| Option | Why not |
| --- | --- |
| In-page floating overlay injected by the content script | Overlays the dense annotation UI, needs shadow-DOM isolation and SPA-rerender resilience. The repo already retired one in-page panel in the DevTools pivot (`2026-07-10-devtools-rossum-panel-design.md:164`). |
| A tab in the existing DevTools "Rossum" panel | Requires DevTools open, eats a large slice of the window, and is itself hidden whenever the user switches to Elements/Console/Network — plausibly the original complaint. |
| Detached `chrome.windows.create({type:'popup'})` | Chrome has no always-on-top; clicking the page drops the window behind. Only works on a second monitor. |

## Verified facts this design rests on

| Fact | Source |
| --- | --- |
| A side panel stays open while the user interacts with the page and across tab switches | `chrome.sidePanel` API reference |
| `chrome.sidePanel.open(options)` requires `tabId` **or** `windowId`, and "may only be called in response to a user action" | same |
| The **`sidePanel` permission triggers no user-facing warning** | Chrome permissions list |
| The **`tabs` permission DOES warn** ("Read your browsing history") | same |
| "When a new permission that triggers a warning is added, the extension will be disabled until the user accepts" | Chrome permission-warnings doc |
| `tab.url` is readable without `tabs` when the extension holds a host permission for that URL — already relied on by `findRossumTabs` (`src/popup/utils.js`) | existing code + Chrome docs |
| Manifest key shape is `"side_panel": { "default_path": "…" }` | `chrome.sidePanel` reference |

Consequence for **backward compatibility**: adding `sidePanel` does **not** disable existing
installs, and we must **never** add `tabs` to get URLs — host permissions already cover every
Rossum origin.

## Architecture

A ninth esbuild entry point, `src/sidepanel/index.jsx` → `dist/sidepanel/sidepanel.js`, paired
with `sidepanel.html` + `sidepanel.css`. The page links **`../popup/popup.css` first** and then
its own stylesheet, so the card's appearance has exactly one source of truth and cannot drift
between the two surfaces; `sidepanel.css` only neutralises the popup's fixed `width` / 600px
`max-height` and lets the card fill the window.

```
sidepanel.html
  └─ App                         src/sidepanel/components/App.jsx
       ├─ DocumentStrip          src/sidepanel/components/DocumentStrip.jsx   (new)
       └─ MdhProvenancePanel     src/popup/components/MdhProvenancePanel.jsx  (reused as-is)
            └─ ConfigBlock → QueryItem                                        (reused as-is)
```

**Reuse over extraction.** The panel, `ConfigBlock`, `QueryItem`, `mdh-provenance.js`,
`actionCondition.js` and `cache.js` stay in `src/popup/`; the side panel imports them. The
alternative — hoisting them to a shared `src/mdhprov/` the way `src/agent/` was hoisted — was
weighed and rejected for this change: the panel would still have to import `utils.js`
(`runInTab`, `openConsoleTab`, `detectSite`) and `tab-readers.js` from `src/popup/` anyway, so
the move buys partial tidiness at the cost of touching the popup the owner asked to leave
alone. Extract when a third consumer appears.

### Following the tab

The popup reads its context once, on open, because that is its whole life. A panel that
outlives a click must track the tab instead. `App` resolves the **active tab of its own
window** and re-resolves on:

1. `chrome.tabs.onActivated` (filtered to this window),
2. `chrome.tabs.onUpdated` with a `changeInfo.url`, for the tracked tab **or** when no tab is
   tracked yet (the recovery path for a panel that opened before any tab was resolvable).

Rossum is an SPA, so document switches are history navigations rather than loads. This design
originally carried a 2.5s `visibilityState`-gated poll because whether `onUpdated` fires for
every such navigation was **not** something to assume. Gate G3 measured it: `onUpdated` fires
with `changeInfo.url` for **both `history.pushState` and `history.replaceState`**, so the poll
was **removed** — a permanent timer kept "just in case" against a question that has now been
answered is unearned complexity. `webNavigation` was never an option: it triggers a permission
warning.

Re-render is keyed, not manual: `<MdhProvenancePanel key={annotationId} …>` remounts the card
when — and only when — the annotation actually changes, so the existing load-and-replay effect
runs unmodified. `pickTarget` / `annotationIdFromUrl` / `viewState` live in a pure
`src/sidepanel/targetTab.js` and carry the unit tests.

### DocumentStrip

The one new piece of UI, and the only thing the mockup added: a persistent panel has to say
*which* document it is showing. It renders a live dot, the file name, `#<annotationId>`, and a
"following this tab" hint; with no document open it says so and the card shows its existing
"Open a document" empty state. The file name is best-effort — `#<id>` paints immediately and
upgrades when `GET /annotations?id=<id>&sideload=documents` resolves (the list-plus-sideload
form verified live for the Inspector landing); any failure leaves the id, which already
identifies the document unambiguously.

### Scoping the panel to Rossum tabs

Added 2026-08-07 after the first build shipped globally. Everything below was measured in a
real browser, because Chrome's behaviour here is not what the API surface suggests:

| Question | Measured answer |
| --- | --- |
| Does a per-tab `enabled:false` hide a panel opened with `open({windowId})`? | **No.** It stays visible on every tab, even across a navigation. |
| What does scope it? | Global default **off** (`setOptions({enabled:false})`) plus per-tab `enabled:true`, opened with **`open({tabId})`**. |
| What happens on a non-enabled tab? | The panel page reports `visibilityState: 'hidden'`; it is kept **alive**, so nothing is refetched. |
| Does it come back? | **Yes, by itself** on returning to an enabled tab. No re-pinning. |
| Does a global `setOptions({enabled:false})` close an open panel? | **Yes**, immediately — the page is destroyed. |
| A second Rossum tab? | Enabled (so it is offerable there) but **not** open until pinned there — Chrome's open state is per tab. |
| A tab that navigates away from Rossum with the panel open? | Chrome **closes** the panel. |

So: `panelScope.js` (pure) decides per tab, the **service worker** applies it — the only
context that outlives every page and can re-decide while neither panel nor popup is open. It
syncs all tabs on wake (per-tab first, then the global default off: reversing that order would
briefly close a panel already open on a Rossum tab) and re-decides on `tabs.onUpdated`.

The subtle part, and a bug this caught: **navigating a tab away from Rossum to a site we hold
no host permission for delivers no URL at all** — not in `changeInfo`, not on the `tab`. Only
`{status:'loading'}`, `{}`, `{status:'complete'}` arrive. Keying the decision on
`changeInfo.url` therefore left a departed tab `enabled` forever (observed live). The decision
reads `tab.url`, where *absence* is the "left Rossum" signal, and the event is acted on when
`changeInfo` carries a `url` **or** a `status` (title/favicon churn is ignored).

### Opening it

A **pin button** in the card header, beside Refresh, rendered **only when an `onPin` prop is
passed** — the popup passes one, the side panel does not. The popup's handler is
`openPanelForTab(tab.id, chrome.sidePanel)` — enable that tab, then `open({tabId})`, never
`{windowId}` (a window-scoped panel ignores per-tab scoping entirely) — followed by
`window.close()`, and the
button is rendered only when `chrome.sidePanel?.open` exists, so a pre-Chrome-114 browser
simply never sees it. This is the single additive change to the popup; it removes nothing.
Chrome's own side-panel dropdown remains a second way in.

The usage event `sa_sidepanel_open` is fired **by the panel on boot**, not by the popup button
— the popup can be destroyed before a `sendMessage` reaches the worker (the cold-start race
already documented for `usageConsent`), and firing on boot also counts opens that came from
Chrome's dropdown.

### States

| Condition | Panel shows |
| --- | --- |
| No active tab resolvable | "Open a Rossum tab in this window." |
| Active tab is not a Rossum tab (or its URL is not readable) | same message |
| Rossum tab, no annotation in the URL | strip says "No document open"; card renders its existing empty state |
| Rossum tab with `/document/<id>` or `/annotation/<id>` | strip + the card exactly as in the popup |

## What is NOT in scope

- No change to how the panel computes anything — the replay engine, caches, filter persistence
  and "Open in Dataset Management" behave identically in both surfaces.
- ~~No per-tab enable/disable via `sidePanel.setOptions`~~ — **reversed 2026-08-07** at the
  owner's request; see "Scoping the panel to Rossum tabs" below. The original reasoning
  (simpler, one less worker responsibility) was right about the cost and wrong about the
  value: a panel that sits open on every unrelated tab is the complaint the feature exists to
  fix, only displaced.
- No `minimum_chrome_version`. Old Chrome ignores an unknown manifest key/permission with a
  warning and keeps working; the pin button is feature-detected. Declaring a minimum would
  strand those installs on an old version instead.
- Nothing new persisted. No storage key is added: Chrome itself remembers whether the panel is
  open, per window.

## Testing

| File | Covers |
| --- | --- |
| `tests/sidepanel-target-tab.test.js` | `annotationIdFromUrl` (both URL shapes, non-Rossum, no id), `viewState`, `sameTarget` |
| `tests/sidepanel-app.test.js` | unsupported-tab state; card renders for a Rossum tab; remount on annotation change; no remount on an unrelated URL change; listeners removed on unmount |
| `tests/sidepanel-document-strip.test.js` | id-only paint, name upgrade, failure keeps the id, "no document" state |
| `tests/popup-mdh-pin.test.js` | pin button renders only with `onPin`; click calls it; absent when the prop is absent (the side-panel case) |
| `tests/sidepanel-manifest.test.js` | `sidePanel` permission + `side_panel.default_path` present, **and the permission set contains no warning-triggering permission** (`tabs`, `webNavigation`, `history`, `<all_urls>`) — the backward-compatibility guard |

Component tests stub `chrome.scripting.executeScript` to return a token-less context, so the
card resolves to a message without touching the network. Waits are condition-based
(`waitFor`), never fixed timeouts — repo rule.

## Live gates

These were **not** assumed; each was checked in a real browser (Chrome, unpacked `dist/`, the
`elis` internal org) on **2026-08-07**. The profile had no Rossum session, which turned out to
be sufficient — a token-less read renders "Not signed in to Rossum.", and that message is
itself proof the injection reached the page.

- **G1 — PASSED.** Clicking the popup's pin button opened the panel:
  `chrome-extension://…/sidepanel/sidepanel.html` appeared as a live page target, and the
  popup closed (which only happens after `open()` resolves). *Caveat: dogfooded with
  `popup.html` hosted in a tab, the repo's standing popup-dogfood technique — the same
  extension-page click gesture, but not literally the toolbar popup. The fallback if it ever
  fails there is a `commands` shortcut or `contextMenus` item, both warning-free.*
- **G2 — PASSED.** From inside the panel, `chrome.tabs.query({active: true, windowId})`
  returned the **Rossum page tab** (`https://elis.rossum.ai/`), not the panel
  (`resolvedTabIsSelf: false`); the card rendered "Not signed in to Rossum.", proving
  `chrome.scripting.executeScript` ran against that tab; the strip rendered; and no pin button
  appeared in the panel.
- **G3 — PASSED, and it changed the design.** `history.pushState` **and**
  `history.replaceState` both fire `tabs.onUpdated` with `changeInfo.url`, and the strip
  followed to `#1250417` then `#777`. The 2.5s poll was therefore **removed**; its only
  remaining justification (no tab tracked yet) is now handled by the `!tabRef.current` arm of
  the `onUpdated` listener, with its own unit test. Also measured: the panel's
  `document.visibilityState` is `'visible'` while the page tab holds focus — so the poll
  *would* have run, i.e. it was genuinely redundant rather than dormant.
- **G4 — NOT YET CHECKED (publishing-time).** That updating an existing install does not
  disable it. Documented (`sidePanel` triggers no warning) but worth confirming on the Web
  Store draft, which flags new permissions before publishing.

## Backward compatibility

- Popup: functionally unchanged; gains one feature-detected button.
- Manifest: one warning-free permission and one new key. No `host_permissions` change — the
  field that *does* disable installs.
- Storage: no key added, changed or orphaned.
- Existing surfaces (content scripts, Console, DevTools panel): untouched.
- `PRIVACY.md` gains one event, keeping the test-enforced pairing with `EVENT_NAMES` intact.
