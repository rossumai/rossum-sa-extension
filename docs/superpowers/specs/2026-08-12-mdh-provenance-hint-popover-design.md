# MDH provenance: move the query hint out of the layout

**Status:** implemented
**Date:** 2026-08-12
**Origin:** owner request — *"When a stage fails we might see an error such as `400:
"compound.filter[0].queryString.query" cannot be empty`. This causes a layout shift. Let's not
show this error under the stage name … hide it behind the error icon on the left (users can
hover it if they want to see more). The goal of this task is to eliminate the MDH provenance
layout shifts."*

## What was shifting, and what was not

`QueryItem` rendered the hint as a `.mdh-q-detail` span with `flex-basis: 100%` — a full-width
wrap line **inside** the `<li>`, unclamped (`word-break: break-word`). It appeared only once a
replay resolved, so every query row grew by one to several lines mid-render. That is the shift.

Investigated and ruled out as sources, so the fix is not partial:

- **The status dot** is fixed-size (`width/height: 12px`, `flex-shrink: 0`), so the glyph
  changing from `…` to `✓`/`!` moves nothing horizontally.
- **The config condition caption** and the **Row picker** are derived synchronously from the
  config (`condInfo.hasCondition`, `configUsesLineItems`), so they render with their block and
  never appear later.
- **The panel's `loading` → `loaded` swap** is a deliberate whole-state transition, not an
  incremental creep.

So `.mdh-q-detail` was the only incremental shift source — the owner's diagnosis was exact.

## Decisions (owner, 2026-08-12)

1. **All three hint-bearing statuses lose the inline line**, not just `error`. `skipped`
   ("cascade short-circuited before this query") and `gated` ("action_condition gates this
   configuration") resolve on the *same* async replay pass, so leaving them inline would leave
   the shift in place for any short-circuiting cascade — the common case, not the rare one.
   `.mdh-q-detail` and its CSS are deleted outright.
2. **A styled hover popover**, not the native `title`. The dot did already carry the hint in
   its `title`, so native would have been free — the owner chose the styled treatment for its
   instant appearance and monospace error text.

## How it works

`QueryItem` opens a `role="tooltip"` popover anchored to the status dot on hover **and on
focus** — the dot takes `tabIndex={0}` when it has a hint, so the information is not
mouse-only. It closes on leave, blur, Escape, any scroll, and resize. The native `title` is
dropped when a popover carries the hint (two tooltips for one element is worse than either),
and kept for hint-less statuses. `cursor: help` marks the dots that have something behind them.

**`position: fixed` is load-bearing.** `#app` sets `overflow: hidden` (popup.css), so an
absolutely-positioned tip inside the query list would be clipped exactly where a hint on the
last failing query needs to appear. Verified that no ancestor of `.mdh-q` sets
`transform`/`filter`/`perspective`/`will-change` — any of which would make `fixed` resolve
against that ancestor and clip again. (The one `backdrop-filter` in popup.css is on
`.usage-overlay`, itself fixed and unrelated.)

Placement lives in **`src/popup/hintPlacement.js`** as a pure function over plain numbers, so
it is assertable without a layout engine: prefer below the dot with left edges aligned, flip
above when there is no room below *and* room above, then clamp into the viewport — right edge
first, so a tip wider than the viewport pins left rather than running off the right.

**A real bug the tests caught.** The popover mounts hidden, is measured, then placed. That
measuring effect runs after paint, so the pointer can leave (or Escape fire) in between — and a
plain `setTip()` there would resurrect a tooltip the user had already dismissed, with nothing
left to close it again. The placement is therefore a functional update that only places a tip
that is still open. Found by instrumenting the component after four close-path tests failed
together; guessing would have missed it.

## Backward compatibility

No storage keys, signals, usage events or public APIs touched. `STATUS_GLYPH`'s `showHint`
flags are unchanged — they still select which statuses have a hint, only the rendering moved.
The card is shared verbatim by the popup and the side panel, so both get the fix and neither
needs a change. `.mdh-q-detail`'s rules are removed; nothing else referenced them.
