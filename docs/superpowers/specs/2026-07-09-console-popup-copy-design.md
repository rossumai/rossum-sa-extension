# Console-aware popup copy

**Date:** 2026-07-09
**Status:** Design approved, ready for implementation plan
**Area:** `src/popup/`

## Problem

When the active tab is the extension's own **Console** page
(`console/console.html`), the popup shows the same panel it shows for any random
website: the lede "This tab isn't supported by the extension."
(`src/popup/components/App.jsx:66,92`). That framing is wrong — the Console is
part of this extension, not an unsupported site.

## Verified facts (grounding)

1. **The popup opens on any tab.** `manifest.json` declares
   `action.default_popup` with no tab restriction; `popup.jsx:5` resolves the
   active tab via `chrome.tabs.query({active, lastFocusedWindow})`.
2. **Site detection.** `App.jsx:105` calls `detectSite(tab.url)`
   (`utils.js:8`) → `'rossum' | 'netsuite' | 'coupa' | null`. The Console URL is
   `chrome.runtime.getURL('console/console.html')` =
   `chrome-extension://<own-id>/console/console.html`, which matches none of the
   site patterns, so `detectSite` returns `null` and `App` renders
   `<UnsupportedSite>`.
3. **URL access.** `manifest.json` grants `activeTab`, which exposes the active
   tab's `url` when the user invokes the action (opens the popup). So the popup
   can read the Console tab's URL without a new permission. No `tabs` permission
   is added.
4. **The switcher already works on the Console.** The `findRossumTabs()` effect
   (`App.jsx:115-118`) runs whenever `!site`, so on the Console the "Switch to
   one of your open Rossum tabs" list already populates when Rossum tabs are
   open. The only thing wrong today is the lede copy.
5. **Own-id match is exact.** `chrome.runtime.getURL` embeds this extension's id,
   so a `startsWith` check matches only our own Console page — never another
   extension's pages (different id) and never a real site.
6. **No test asserts the lede string.** Confirmed no test references "isn't
   supported"; `tests/popup-utils.test.js` covers `detectSite`/`findRossumTabs`
   and already stubs `chrome.runtime.getURL`.

## Design

### `src/popup/utils.js` — new helper

```js
// True when the URL is this extension's own Console page. getURL embeds our
// extension id, so this matches only our Console — not other extensions or sites.
export function isConsoleTab(url) {
  return !!url && url.startsWith(chrome.runtime.getURL('console/console.html'));
}
```

Placed next to `detectSite`. The Console tab URL carries a `?authId=...` query,
which `startsWith` tolerates.

### `src/popup/components/App.jsx` — wire it

- When `!site`, compute `const isConsole = isConsoleTab(tab?.url);` and pass it:
  `<UnsupportedSite tabs={rossumTabs} isConsole={isConsole} />`. (Prop named
  `isConsole`, not `console`, to avoid shadowing the global `console`.)
- Import `isConsoleTab` from `../utils.js` (add to the existing import).

### `UnsupportedSite` — lede swap only

Signature becomes `function UnsupportedSite({ tabs, isConsole })`. In **both**
branches (has-tabs and no-tabs), the lede line changes:

```jsx
<p class="unsupported-lede">
  {isConsole ? "You're on the Rossum Console." : "This tab isn't supported by the extension."}
</p>
```

"Rossum Console" matches the popup's existing button label (`App.jsx:224`).
Nothing else changes: the "Switch to one of your open Rossum tabs:" heading + tab
list, the "It works on: … Open one of these sites to get started." fallback, and
the "Also works on NetSuite and Coupa." footnote all stay exactly as today.

## Testing

- `tests/popup-utils.test.js`: add an `isConsoleTab` describe block — true for
  `chrome-extension://abc/console/console.html` and `...?authId=x` (with the
  existing `getURL: (p) => \`chrome-extension://abc/${p}\`` mock); false for a
  Rossum URL, another extension's page (`chrome-extension://zzz/console/...`),
  empty, and undefined.
- New `tests/popup-unsupported-site.test.js` (jsdom, render via
  `h(UnsupportedSite, props)`): `isConsole=true` with tabs → lede "You're on the
  Rossum Console." AND the tab list still renders; `isConsole=true` with no tabs
  → lede changes AND the "It works on" fallback still renders; `isConsole=false`
  → lede unchanged "This tab isn't supported by the extension.".
  (`UnsupportedSite` is not exported today — export it for the test.)

## Backward compatibility

- No new storage keys, no manifest change, no new permission.
- Only the Console tab's popup rendering changes (unsupported lede → Console
  lede). Every other tab (Rossum/NetSuite/Coupa/other sites) is unaffected.
- The tab switcher and fallback behavior are unchanged.

## Out of scope

- Any Console-specific actions in the popup (open-another-Console, app links) —
  explicitly declined; copy-only.
- Showing site toggles on the Console (they can't act on an extension page).
- Reconciling the broader Console/Dataset-Management/Master-Data-Hub naming.
