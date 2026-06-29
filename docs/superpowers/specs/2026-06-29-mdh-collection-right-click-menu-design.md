# MDH — Right-Click "Open in New Tab" on Collections — Design

**Date:** 2026-06-29
**Status:** Approved (pending implementation plan)

## Problem

Users want to right-click a collection in the MDH left navigation and get an
"Open in new tab" option. Today the collection rows are `<div>`s with JS click
handlers, so right-clicking shows the browser's default (empty) menu, not an
"Open in new tab" affordance.

## Decision context (verified)

True browser-native links (`<a href>` → native right-click menu, native
Cmd/Ctrl/middle-click, keyboard a11y) are **not achievable** without changing
where the auth token lives: the browser's native "open in new tab" navigates
straight to the `href` and runs none of our JS, so it cannot stage credentials
at click time, and a freshly-opened Console tab has no `consoleAuth_<uuid>`
staging entry and empty per-tab `sessionStorage` → it lands not-connected
(`resolveBootAuth` in `src/console/boot.js` returns no token). The token is never
in `chrome.storage.session` and the Console page never re-reads it from a Rossum
tab. Making links self-authenticating would require an auth-storage change
(e.g. moving the token into `chrome.storage.session`) — explicitly out of scope
for this task.

Chosen direction: a **custom right-click context menu** that reuses the existing
sidebar actions menu, opened at the cursor. It delivers the requested
"right-click → Open in new tab" with no auth-model change, and composes with the
already-implemented Cmd/Ctrl-click + middle-click + kebab "Open in new tab"
(uncommitted). It is not the browser's native menu, and it does not make
Cmd/Ctrl-click browser-native — an accepted trade-off.

## Goal

Right-clicking a collection row opens the existing actions menu (Open in new tab
/ Copy name / Rename / Drop) anchored at the pointer, with the browser's default
context menu suppressed.

## Non-goals

- Real `<a href>` anchors / browser-native open behaviors / keyboard-native
  opening (would need the auth-storage change above).
- Any change to the auth model, manifest, permissions, or storage keys.
- Viewport edge-flip for the menu (the existing kebab menu has none; keep parity).

## Design

Confined to `src/mdh/components/Sidebar.jsx`. The component already has all the
needed machinery: `menuOpenFor` (collection name) + `menuPos` state, the
fixed-position `.collection-action-menu` (whose first item is **Open in new tab**
→ `openCollectionTab(name)`, then Copy name / Rename / Drop), and a
close-on-outside-click / close-on-scroll effect keyed on `menuOpenFor`. Today
only the `⋮` kebab button opens it via `toggleMenu`, which sets
`menuPos = { top: r.bottom + 4, right: window.innerWidth - r.right }`.

Two changes:

1. **Row right-click handler.** Add to the collection row (the
   `cols.map((name) => (<div …>))` element, which currently has
   `onClick`/`onAuxClick`/`onMouseDown`):

   ```jsx
   onContextMenu={(e) => {
     e.preventDefault();
     setMenuPos({ top: e.clientY, left: e.clientX });
     setMenuOpenFor(name);
   }}
   ```

   `e.preventDefault()` suppresses the browser's default menu. Setting
   `menuPos`/`menuOpenFor` opens the existing actions menu at the cursor (it
   always opens/repositions on right-click — no toggle).

2. **Generalize `menuPos` to anchor by `left` OR `right`.** The kebab path keeps
   emitting `{ top, right }` (opens leftward from the row's right edge,
   unchanged). The right-click path emits `{ top, left }` (opens down-right from
   the cursor, the conventional direction). The menu's inline style chooses
   whichever is present. Change the menu `style` from:

   ```jsx
   style={`position:fixed;top:${menuPos.top}px;right:${menuPos.right}px`}
   ```

   to:

   ```jsx
   style={`position:fixed;top:${menuPos.top}px;` + (menuPos.left != null ? `left:${menuPos.left}px` : `right:${menuPos.right}px`)}
   ```

Everything else is reused unchanged: the menu markup, the `openCollectionTab`
wiring on "Open in new tab", and the outside-click/scroll close effect (which
keys on `menuOpenFor`, so it closes a right-click-opened menu too).

### Interaction notes

- Right-click is button 2; the existing `onMouseDown` only `preventDefault`s
  button 1 (middle-click autoscroll), so it doesn't interfere. Right-click does
  not fire `click`, so `selectCollection`/`openCollectionTab`-on-click are not
  triggered.
- Right-clicking anywhere on the row (including the kebab button, which is a
  child) opens the menu at the cursor — acceptable and consistent.

## Error handling / edge cases

- No new async or external calls; the handler is synchronous state-setting.
- Menu may render partially off-screen when the cursor is near the viewport's
  right/bottom edge — same limitation as today's kebab menu; not addressed
  (documented non-goal).

## Backward compatibility

- Purely additive: only adds the right-button trigger and a more general
  `menuPos` shape. Plain click, Cmd/Ctrl-click, middle-click, and the kebab
  button are unchanged. No auth/manifest/storage change.

## Accessibility note

Right-click is mouse-only, so this adds no keyboard path; the kebab `⋮` button
remains the keyboard/screen-reader route to the same actions. (Keyboard-native
opening was the anchor approach, out of scope here.)

## Testing

Extend `tests/mdh-sidebar-open-tab.test.js` (it already mounts `Sidebar`, mocks
`api.js`, and mocks the `openCollectionTab` module):

- Dispatch a cancelable `contextmenu` MouseEvent (`clientX`/`clientY`) on a
  collection row → assert `event.defaultPrevented === true` (native menu
  suppressed) and that `.collection-action-menu` renders containing
  "Open in new tab".
- Click that "Open in new tab" item → `openCollectionTab(name)` called with the
  right collection.
- Regression: the kebab `⋮` button still opens the menu (existing behavior
  intact).

Full suite (`npm test`) stays green; `npm run build` succeeds. In-browser manual
check: right-clicking a collection shows the actions menu at the cursor with
"Open in new tab" working; the browser's default menu does not appear.

## Files touched

- `src/mdh/components/Sidebar.jsx` — `onContextMenu` handler + `menuPos`
  left/right generalization.
- `tests/mdh-sidebar-open-tab.test.js` — right-click cases (+ kebab regression).
- `CLAUDE.md` — extend the sidebar/open-in-new-tab note to mention right-click
  opens the same actions menu at the cursor.
