# Popup fits within Chrome's 600px cap — design

**Date:** 2026-07-17
**Status:** Approved (design)
**Scope:** `src/popup/popup.css` (CSS-only; no JS, no storage, no behavior change)

## Problem

On a Rossum annotation page the extension popup grows taller than Chrome allows,
so the **whole popup gets an outer scrollbar** — including when the "Document
locked by …" reviewing-lock banner is visible. The goal: everything fits without
the popup scrolling, and scrolling is permitted **only** when the content
genuinely cannot fit the available height.

## Grounded facts (verified, not assumed)

- **Chrome popup cap = 800×600px, hardcoded in Chromium.** Content beyond 600px
  tall forces the popup body to scroll. (Verified via chromium-extensions
  discussion + Chrome docs.)
- The Rossum popup is the wide layout (`body.popup-wide`, 760px): a two-column
  `content-row` (MDH provenance panel | toggles), with the reviewing-lock banner
  below it, between the header and footer.
- Measured section heights (synthetic harness with the real `popup.css`, no
  customer data):

  | Region | Height |
  |---|---|
  | accent bar | 2px |
  | header | 47px |
  | footer | 33px |
  | reviewing-lock banner (+ its 10px top margin) | 68px |
  | toggles column, natural | ~408px (common) / ~477px (Experimental unlocked) |
  | MDH panel current cap | `max-height: 540px` |

- **The current build already overflows the cap:**
  - No banner, tall MDH: `2 + 47 + 540 + 33` ≈ **622px** → outer-scrolls.
  - With banner, tall MDH: ≈ **693px** → outer-scrolls by ~93px.

  So the fix also repairs the pre-existing no-banner overflow, not only the
  banner case.

## Approach: pin the chrome + banner; scroll the settings area internally

> **Revision v2 (2026-07-17):** the first cut put the last-resort scroll on the
> whole popup (`#app { overflow-y: auto }`). But the Experimental easter-egg is
> commonly unlocked (Fabry dogfooders), so `toggles(477) + chrome(150) ≈ 628px`
> exceeds Chrome's 600px cap — and outer-scrolling the whole popup pushed the
> **footer (version) 28px below the fold**. Chrome's 600px cap is hard, so the
> content *must* fit within 600px; it cannot grow. Fixed by pinning the footer
> (and header + banner) and scrolling only the settings area.

Make `#app` (the Preact render root; `body > #app > accent-bar, header,
#mainContent, footer`) a **height-capped flex column** with `overflow: hidden`
(never outer-scrolls). Pin the accent bar, header, lock banner, and footer as
non-shrinking flex items. Make `#mainContent > .content-row` the **capped scroll
region**: the toggles column and the MDH panel each scroll **internally** when
they exceed the available row height. The MDH card is taken out of flow so its
(tall) content never inflates the row. The popup shrink-wraps to content when
short; when content would exceed 600px, only the settings columns scroll — the
header, lock banner and footer (version) stay visible without scrolling.

### CSS (added to `src/popup/popup.css`)

```css
html, body { height: auto; }

/* Height-capped flex shell. max-height (not height) preserves shrink-wrap;
   the definite cap is the definite height that makes the inner scroll regions
   resolve. overflow:hidden keeps header/banner/footer pinned. */
#app {
  display: flex;
  flex-direction: column;
  max-height: 600px;      /* Chrome popup cap */
  overflow: hidden;
}
.accent-bar, .header, .footer { flex: 0 0 auto; }               /* pinned */
#app > #mainContent { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
#mainContent > .content-row { flex: 1 1 auto; min-height: 0; }   /* capped scroll region */
#mainContent > .reviewing-lock-banner { flex: 0 0 auto; }        /* pinned */

/* Toggles column: scrolls only if it exceeds the capped row height. */
.content-col-toggles { width: 380px; flex-shrink: 0; min-height: 0; overflow-y: auto; scrollbar-width: thin; }

/* MDH column stretches to the row height; its card is out of flow so its
   content never inflates the row, and scrolls internally instead. */
.content-col-mdh { max-height: none; position: relative; overflow: hidden; }
body.popup-wide .content-col-mdh { display: block; }
body.popup-wide .mdh-card {
  position: absolute;
  inset: 10px 0 0 14px;   /* preserve the popup-wide margin (10 top, 14 left) */
  margin: 0;
  display: flex;
  flex-direction: column;
}
.mdh-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
/* The `.content-col-mdh` ::-webkit-scrollbar styling moves to `.mdh-body`. */
```

Notes:
- The existing `.content-col-mdh { max-height: 540px; overflow-y: auto }` and its
  `::-webkit-scrollbar` rules are superseded — the scroll moves to `.mdh-body`.
- The MDH filter input + title now stay pinned while results scroll (a small
  UX improvement that falls out of the card becoming a flex column).

### Measured outcomes (final CSS, verified in agent-browser)

| Scenario | Popup height | Header pinned | Footer (version) visible | Banner visible | Outer popup scroll |
|---|---|---|---|---|---|
| **Experimental unlocked + tall MDH + banner** (628px content) | 600px | ✓ | **✓** | ✓ | **none** (toggles + MDH scroll internally) |
| Tall MDH + banner | 558px | ✓ | ✓ | ✓ | none |
| Tall MDH, no banner | 490px (was ~622 → scrolled) | ✓ | ✓ | n/a | none |
| Short / empty MDH + banner | 558px | ✓ | ✓ | ✓ | none |
| Experimental, no banner | 559px | ✓ | ✓ | n/a | none |
| Narrow non-Rossum popup | 503px | ✓ | ✓ | n/a | none |

The popup never outer-scrolls. When content genuinely exceeds 600px (Experimental
unlocked + lock banner), only the settings columns scroll internally — the
version/footer, lock banner and header remain visible without scrolling.

## Trade-off (accepted)

The MDH panel's default visible height becomes ~408px (aligned to the toggles
column) instead of up to 540px. Nothing is lost — the panel scrolls sooner — and
the two columns now align, giving a more compact popup. In the rare Experimental
+ banner case the toggles column also gains a short internal scroll (~17px).

## Backward compatibility

- Pure CSS. No storage keys, no JS or behavior changes, no new browser features
  (standard flexbox + absolute positioning; no `:has()`).
- Applies only to the Rossum wide popup (`body.popup-wide` + `#mainContent`).
  The narrow popup, NetSuite/Coupa contexts, and the unsupported-site view are
  structurally unchanged (their content is well under 600px).
- Existing popup tests are logic-only (`probeLock`, `isLockedByOther`, tab
  readers, cache, etc.) and are unaffected by a CSS change.

## Verification

1. `npm test` (unit suite stays green).
2. `npm run build` (bundle builds; static `popup.css` copied to `dist/`).
3. Dogfood the real extension on an **internal** org (never a customer org; no
   customer data surfaced): the no-banner tall-MDH case already reproduces the
   >600px overflow, so the fix can be confirmed without the two-user lock state.
   Confirm: no outer scrollbar with a populated MDH panel; the MDH list scrolls
   internally; header/toggles/footer stay put.

## Out of scope

- No changes to the reviewing-lock banner's content or logic (shipped in
  `218cf85`).
- No changes to MDH data loading, features, or any other popup behavior.
