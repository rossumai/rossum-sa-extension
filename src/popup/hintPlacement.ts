// Pure placement for the query-status hint popover.
//
// The popover is `position: fixed`, so these are VIEWPORT coordinates. Fixed is
// load-bearing, not incidental: `#app` sets `overflow: hidden` (popup.css), so an
// absolutely-positioned tip inside the query list would be clipped at the panel's
// edge — exactly where a hint on the last failing query needs to appear. Verified
// that no ancestor of `.mdh-q` sets transform/filter/perspective/will-change,
// any of which would make `fixed` resolve against that ancestor and clip again.
//
// All geometry arrives as plain numbers so this is assertable without a layout
// engine, which jsdom does not have.
const GAP = 6;

/** Viewport coordinates. A DOMRect satisfies these structurally. */
export type AnchorRect = { left: number; top: number; bottom: number };
export type Size = { width: number; height: number };

export function placeHint(
  anchor: AnchorRect,
  tip: Size,
  viewport: Size,
  gap = GAP,
): { top: number; left: number } {
  // Preferred: directly below the status dot, left edges aligned.
  let left = anchor.left;
  let top = anchor.bottom + gap;

  // Flip above when there is no room below AND there is room above. The popup is
  // capped at 600px and a failing query is often near its bottom, so this is the
  // common case rather than an edge case.
  if (top + tip.height > viewport.height && anchor.top - gap - tip.height >= 0) {
    top = anchor.top - gap - tip.height;
  }

  // Clamp into the viewport: right edge first, then left, so a tip wider than the
  // viewport pins to the left edge rather than running off the right.
  left = Math.min(left, viewport.width - tip.width - gap);
  left = Math.max(gap, left);
  top = Math.max(gap, Math.min(top, viewport.height - tip.height - gap));

  return { top, left };
}
