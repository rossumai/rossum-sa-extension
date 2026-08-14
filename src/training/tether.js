// Pure geometry for the training quest card's tether — a dashed connector
// from the card to the current step's target, plus an off-screen hint for
// when the target exists but is scrolled out of view. No DOM, no globals —
// follows the precedent of src/mdh/stageLink.js (this repo's other
// connector-geometry module): return null rather than draw a line to
// nowhere, so the caller degrades to "render nothing" or "render the hint"
// without any of this module knowing about rendering at all.
//
// All rects are plain `{left, top, right, bottom}` in VIEWPORT coordinates
// (as returned by `getBoundingClientRect()`); `viewport` is `{width, height}`.

import { bevelPath } from '../ui/connectorPath.js';

const GAP = 8; // small gap between the target's edge and the tether's arrowhead

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// "Usefully visible" predicate, used by BOTH exports below: any part of the
// rect intersects the viewport rectangle. A rect fully past any edge — scrolled
// up, down, left, or right out of view — counts as not visible at all; that is
// exactly the off-screen-hint case. Any positive overlap counts as visible (a
// target that is only half on screen is still a real, reachable target) — the
// same rule src/mdh/stageLink.js's `sectionInPane` uses for its own pane check.
function isOnScreen(rect, viewport) {
  return intersects(rect, { left: 0, top: 0, right: viewport.width, bottom: viewport.height });
}

// How far the connector runs straight off each end before the diagonal takes
// over. Proportional to the span so a short hop does not get two long legs and
// no diagonal, clamped so a long one does not get two enormous ones — and
// finally capped at half the span, which is what keeps the two legs from
// crossing (and folding the path back on itself) when the card and the target
// are close together.
function stubFor(span) {
  return Math.max(0, Math.min(28, Math.max(8, span * 0.15), span / 2));
}

// `tetherGeometry(cardRect, targetRect, viewport) → {d, arrow} | null`
//
// Returns null when the target is not usefully visible — either off screen
// (see isOnScreen above), or on screen but overlapping the quest card. The
// overlap case is deliberate and distinct from off-screen: the target IS
// visible, but a dashed line ending underneath the very card it starts from
// points at nothing a trainee can act on, so it is treated the same as
// invisible rather than drawn anyway.
export function tetherGeometry(cardRect, targetRect, viewport) {
  if (!cardRect || !targetRect || !viewport) return null;
  if (!isOnScreen(targetRect, viewport)) return null;

  // Aim at the VISIBLE part of the target, not the whole of it. A Rossum
  // document row is a horizontally scrollable element measuring 4263px against
  // a ~1200px viewport (measured live, 2026-08-14), so its right edge and its
  // centre are both far off screen: the connector was anchored at x≈4271 and
  // drew itself into empty space beyond the window. Nothing was visibly wrong —
  // the SVG existed, the path was well-formed, the step simply appeared to have
  // no tether. Clipping to the viewport first is the same idea as
  // stageLink.js's `clampToBox`: an endpoint derived from content extending
  // past its container lands outside that container.
  const target = {
    left: Math.max(targetRect.left, 0),
    top: Math.max(targetRect.top, 0),
    right: Math.min(targetRect.right, viewport.width),
    bottom: Math.min(targetRect.bottom, viewport.height),
  };
  if (intersects(cardRect, target)) return null;

  const targetCx = (target.left + target.right) / 2;
  const targetCy = (target.top + target.bottom) / 2;
  const cardCx = (cardRect.left + cardRect.right) / 2;
  const cardCy = (cardRect.top + cardRect.bottom) / 2;

  // Which axis actually SEPARATES the two rects — not which centre is further
  // away. For a target far wider than the card (that same document row spans
  // the card on both sides) the centres can say "the target is off to one
  // side" while the rects overlap on that axis entirely, and the tether then
  // tries to reach an edge that is nowhere near the trainee's eye. Edge
  // separation cannot lie that way: a zero gap means the axis does not
  // separate them, so the other one must. Both zero is impossible here —
  // that is the overlap case, already returned above.
  const gapX = Math.max(0, target.left - cardRect.right, cardRect.left - target.right);
  const gapY = Math.max(0, target.top - cardRect.bottom, cardRect.top - target.bottom);

  // The card is fixed at the viewport's bottom-right corner, so a genuinely
  // on-screen, non-overlapping target is always up and/or to the left: only
  // the card's left or top edge, and only the target's right or bottom edge,
  // can face it. That matches the "left or top" the design calls for; a
  // right/bottom pairing is not needed.
  // The shape is the MDH Stages connector's, by way of the shared emitter in
  // src/ui/connectorPath.js (owner, 2026-08-14: "use the same geometry as we do
  // in the MDH Stages view"): a straight leg off each end with a single bevel
  // diagonal between them and small rounded bends, rather than the S-curve this
  // drew before. The final leg runs along the arrowhead's own axis, so shaft and
  // head read as ONE arrow — the same rule stageLink.js's `shaftElbow` follows,
  // and for the same reason: a sideways arrival at a head reads as a corner.
  let A; let D; let B; let C; let dir;
  if (gapX >= gapY) {
    A = { x: cardRect.left, y: cardCy };            // card's left edge, vertically centred
    D = { x: target.right + GAP, y: targetCy };     // just past the target's right edge
    dir = 'left';                                   // the head points AT the target
    const stub = stubFor(A.x - D.x);
    B = { x: A.x - stub, y: A.y };
    C = { x: D.x + stub, y: D.y };
  } else {
    A = { x: cardCx, y: cardRect.top };             // card's top edge, horizontally centred
    D = { x: targetCx, y: target.bottom + GAP };    // just past the target's bottom edge
    dir = 'up';
    const stub = stubFor(A.y - D.y);
    B = { x: A.x, y: A.y - stub };
    C = { x: D.x, y: D.y + stub };
  }

  return { d: bevelPath(A, B, C, D), arrow: { x: D.x, y: D.y, dir } };
}

// `offscreenHint(targetRect, viewport) → {direction: 'up'|'down'} | null`
//
// null while the target is on screen (tetherGeometry is the one to ask in
// that case — this function does not know about the card, so it cannot tell
// "visible but overlapping the card" from "usefully visible"; that
// distinction is tetherGeometry's alone). Otherwise, which way the trainee
// should scroll: 'down' when the target's vertical centre sits in the lower
// half of the viewport (including fully below it), 'up' otherwise. A target
// that is off-screen only horizontally (rare — Rossum pages do not scroll
// sideways in normal use) still gets a defensible up/down answer from this
// same rule, since the hint only ever speaks in vertical terms.
export function offscreenHint(targetRect, viewport) {
  if (!targetRect || !viewport) return null;
  if (isOnScreen(targetRect, viewport)) return null;
  const centerY = (targetRect.top + targetRect.bottom) / 2;
  return { direction: centerY >= viewport.height / 2 ? 'down' : 'up' };
}
