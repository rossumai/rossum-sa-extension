// Pure geometry for the Stages-view → pipeline-editor connector line.
//
// Given the editor stage's line rect (from CodeMirror coordsAtPos) and the hovered
// Stages-view section rect (both in viewport coordinates), plus the data panel's
// own viewport rect, return the line endpoints in panel-relative coordinates — or
// null when the editor stage has no on-screen rect (e.g. still scrolling into view).
//
// Endpoint 1 anchors just after the opening `{` of the stage's code line;
// endpoint 2 anchors at the left edge of the hovered section, near its header.
// `d` is a beveled connector: a horizontal run off the `{` (extended past the
// stage operator), a single diagonal (never strictly vertical), then a short
// horizontal into the stage. Small rounded bends at the two corners.
const START_GAP = 8; // start the line a bit further right of the '{', not right against it

// Is the target section actually on screen inside the Stages pane's scroller?
// Any vertical overlap counts: a half-visible section is still a real target.
// Kept as the honest "is it visible" predicate (src/training/tether.js cites it
// for its own pane check), but it no longer decides whether to draw: the link is
// clamped to the pane instead — see EDGE_INSET below.
export function sectionInPane(sectionRect, paneRect) {
  if (!sectionRect || !paneRect) return false;
  return sectionRect.bottom > paneRect.top && sectionRect.top < paneRect.bottom;
}

// How far inside the pane the clamped endpoint sits, so the arrow head is fully
// within the scroller rather than straddling its edge.
const EDGE_INSET = 8;

// `paneRect` is optional; omit it and nothing clamps.
//
// The connector is drawn over the WHOLE data panel, so an endpoint computed from
// a section scrolled out of the Stages pane lands outside that pane — over the
// options toolbar above it, or past its bottom edge. That used to suppress the
// line entirely (`sectionInPane` in the caller). Since the editor stopped
// scrolling the pane (2026-08-14) the section frequently IS off screen and stays
// there, so suppression meant no line at all; the owner asked to keep the tether.
//
// So the endpoint is pinned into the pane's band instead and `edge` reports which
// way the section actually lies ('up' | 'down' | null), letting the caller draw an
// arrow rather than the usual dot: the line ends at a boundary, not at a
// destination. Clamping also fixes a case suppression never caught — a section
// overlapping the pane passes `sectionInPane`, yet its header anchor can still be
// above the pane top, which drew over the toolbar.
// Pins `y` into a box's band and says which way it had to move. Shared by both
// ends, which have the same failure for the same reason: an endpoint measured
// from content that has scrolled out of its own scroller lands outside it, and
// this connector is drawn over the WHOLE data panel, so nothing clips it. The
// far end used to be suppressed instead (`sectionInPane` in the caller) — fine
// while the pane still scrolled the section into view, useless once it stopped.
// The near end was never handled at all: CodeMirror keeps reporting coordinates
// for a stage scrolled out of the editor (measured: 297px above the box), and
// the line ran up over the pipeline header's buttons.
//
// A box shorter than the two insets has no band; collapsing to its midpoint
// keeps the endpoint inside rather than pushing it past the edge it was meant to
// stop at.
function clampToBox(y, boxRect) {
  if (!boxRect) return { y, edge: null };
  let lo = boxRect.top + EDGE_INSET;
  let hi = boxRect.bottom - EDGE_INSET;
  if (lo > hi) lo = hi = (boxRect.top + boxRect.bottom) / 2;
  const clamped = Math.min(Math.max(y, lo), hi);
  return { y: clamped, edge: clamped === y ? null : (clamped > y ? 'up' : 'down') };
}

// `paneRect` (the Stages scroller) and `clipRect` (the editor's visible box) are
// both optional; omit them and that end never clamps.
//
// A clamped end reports its direction — `edge` for the section end, `startEdge`
// for the editor end — so the caller draws an arrow pointing at what is off
// screen instead of the usual dot: the line stops at a boundary, not at a
// destination. Clamping the far end also fixes a case suppression never caught —
// a section overlapping the pane passes `sectionInPane`, yet its header anchor
// can still sit above the pane top, which drew over the options toolbar.
export function computeStageLink(editorLineRect, sectionRect, panelRect, paneRect, clipRect) {
  if (!editorLineRect || !sectionRect || !panelRect) return null;
  const x1 = editorLineRect.left - panelRect.left + START_GAP; // a bit right of the '{'
  const hx = (editorLineRect.hEnd ?? editorLineRect.left) - panelRect.left; // past the operator
  const x2 = sectionRect.left - panelRect.left;

  const startAnchor = (editorLineRect.top + editorLineRect.bottom) / 2; // the '{' line's middle
  const start = clampToBox(startAnchor, clipRect);
  const endAnchor = sectionRect.top + 16;                               // near the section header
  const end = clampToBox(endAnchor, paneRect);

  const y1 = start.y - panelRect.top;
  const y2 = end.y - panelRect.top;
  return {
    x1, y1, x2, y2,
    edge: end.edge,
    startEdge: start.edge,
    d: connectorPath(x1, y1, hx, x2, y2, end.edge, start.edge),
  };
}

// A small filled triangle marking a clamped endpoint, apex pointing the way the
// section lies. Panel-relative, like every other coordinate here. null for an
// unclamped endpoint, which keeps the round dot.
const ARROW_H = 6, ARROW_W = 5;
export function edgeArrowPath(x, y, edge) {
  if (edge !== 'up' && edge !== 'down') return null;
  const dir = edge === 'up' ? -1 : 1;
  return 'M ' + f(x) + ' ' + f(y + dir * ARROW_H)
    + ' L ' + f(x + ARROW_W) + ' ' + f(y - dir * 1)
    + ' L ' + f(x - ARROW_W) + ' ' + f(y - dir * 1)
    + ' Z';
}

// Offset of the stage operator's ':' — the first ':' at/after `fromOffset` and
// before `beforeOffset` (the stage's end). The operator key is the first member
// of the stage object, so its ':' is the first one — even when the pipeline is
// pretty-printed and the operator sits on the line BELOW the '{'. -1 if none.
export function operatorColonOffset(text, fromOffset, beforeOffset) {
  const i = text.indexOf(':', fromOffset);
  return (i !== -1 && i < beforeOffset) ? i : -1;
}

const f = (n) => n.toFixed(1);

// A --[leg]-- B ==[bevel diagonal]== C --[leg]-- D, with a small quadratic round
// at each bend ("small bends"). A is the editor end, D the section end; each LEG
// is axis-aligned and takes one of two forms:
//
//   horizontal — the default. Off the `{` it runs out past the stage operator
//     (to `hx`) so the line leaves the code rather than the brace; into a section
//     it enters from the left, the way a reader's eye does. Both end in a dot.
//   vertical — used when that end is CLAMPED to its box (`startDir` / `endDir`).
//     That end carries an arrowhead instead of a dot, and a sideways arrival at a
//     vertical head reads as a corner rather than as one arrow, so the leg runs
//     along the head's own axis: shaft and head become a single arrow (owner,
//     2026-08-14: "the tether leaving the arrow is too abrupt and immediately
//     going to the left"). The horizontal run past the operator is dropped there —
//     an off-view code line gives it nothing to align with.
//
// The diagonal covers the bulk of the span and is never strictly vertical when
// both legs are horizontal (B.x < C.x). Either end may be clamped independently,
// so all four combinations are just different legs through the same emitter.
function connectorPath(x1, y1, hx, x2, y2, endDir, startDir) {
  // The END elbow first: an unclamped start leg is clamped against its x.
  const C = isClamped(endDir)
    ? shaftElbow(x2, y2, endDir)
    : { x: x2 - endStubFor(x1, x2), y: y2 };
  const B = isClamped(startDir)
    ? shaftElbow(x1, y1, startDir)
    : { x: Math.max(x1 + 6, Math.min(hx, C.x - 8)), y: y1 };
  return bevelPath({ x: x1, y: y1 }, B, C, { x: x2, y: y2 });
}

const isClamped = (dir) => dir === 'up' || dir === 'down';
const endStubFor = (x1, x2) => Math.max(6, Math.min(24, (x2 - x1) * 0.15)); // short stub into the stage

// Every arrowhead gets its full shaft, unconditionally.
//
// It used to shorten — and vanish — whenever the line approached from the side its
// head points at, to stop the shaft doubling back past that head. The guard was
// wrong twice over. It fired in the ordinary case of BOTH ends clamped the same
// way: the Stages pane's band starts below the editor's, because its options strip
// pushes it down, so a line between two up-arrows always "arrives from above". And
// there it produced the very defect the shaft exists to prevent — the tether
// turning sideways at the head (owner, 2026-08-14: "the right side goes immediately
// to the left instead of continuing a bit vertically"). What it was avoiding is
// 14px of dip against a horizontal span of several hundred, the two panes being far
// apart, which reads as a shallow cable passing under a marker rather than as a
// hook. Overshoot is bounded by SHAFT by construction.
const SHAFT = 14;

// The elbow for a clamped end: one SHAFT along the head's axis, on the VISIBLE side
// of it — below an up-arrow, above a down-arrow. Both ends share this rule, because
// the start's line LEAVES its head that way and the end's ARRIVES that way, which
// are the same segment described from either end.
const shaftElbow = (x, y, dir) => ({ x, y: y + (dir === 'up' ? SHAFT : -SHAFT) });

const unit = (from, to) => {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, len };
};

// Two radii, not one: each bend can only give up as much as its own leg has, and
// tying both to the shorter leg would square off the other corner. With two
// horizontal legs (each >= 6 by construction) this yields the same radius the
// single-radius version did, so the unclamped connector is unchanged.
function bevelPath(A, B, C, D) {
  const ab = unit(A, B), bc = unit(B, C), cd = unit(C, D);
  const r1 = Math.max(0, Math.min(5, ab.len, bc.len * 0.4));
  const r2 = Math.max(0, Math.min(5, cd.len, bc.len * 0.4));
  return 'M ' + f(A.x) + ' ' + f(A.y)
    + ' L ' + f(B.x - r1 * ab.x) + ' ' + f(B.y - r1 * ab.y)                          // first leg
    + ' Q ' + f(B.x) + ' ' + f(B.y) + ' ' + f(B.x + r1 * bc.x) + ' ' + f(B.y + r1 * bc.y) // round into the diagonal
    + ' L ' + f(C.x - r2 * bc.x) + ' ' + f(C.y - r2 * bc.y)                          // the bevel diagonal
    + ' Q ' + f(C.x) + ' ' + f(C.y) + ' ' + f(C.x + r2 * cd.x) + ' ' + f(C.y + r2 * cd.y) // round into the last leg
    + ' L ' + f(D.x) + ' ' + f(D.y);                                                 // last leg into the end
}
