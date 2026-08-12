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
// The connector is drawn over the whole data panel, so without this a link to a
// section scrolled out of the pane runs off toward nothing — over the toolbar,
// or past the pane's edge. Hovering a SECTION can never hit that (you can only
// hover what you can see), but the caret and the editor-hover link can. Any
// vertical overlap counts: a half-visible section is still a real target.
export function sectionInPane(sectionRect, paneRect) {
  if (!sectionRect || !paneRect) return false;
  return sectionRect.bottom > paneRect.top && sectionRect.top < paneRect.bottom;
}

export function computeStageLink(editorLineRect, sectionRect, panelRect) {
  if (!editorLineRect || !sectionRect || !panelRect) return null;
  const x1 = editorLineRect.left - panelRect.left + START_GAP; // a bit right of the '{'
  const y1 = (editorLineRect.top + editorLineRect.bottom) / 2 - panelRect.top;
  const hx = (editorLineRect.hEnd ?? editorLineRect.left) - panelRect.left; // past the operator
  const x2 = sectionRect.left - panelRect.left;
  const y2 = (sectionRect.top + 16) - panelRect.top; // near the section header
  return { x1, y1, x2, y2, d: connectorPath(x1, y1, hx, x2, y2) };
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

// (x1,y1) --[horizontal to hx]-- P1 ==[bevel diagonal]== P2 --[stub]-- (x2,y2)
// The first horizontal runs from just after the `{` out to hx (past the operator
// name); the diagonal then covers the bulk of the span and is never strictly
// vertical (P1.x < P2.x); a short stub enters the stage. Corners are softened
// with a small quadratic round ("small bends"). Works whether the stage is below
// or above the `{` (the diagonal slopes either way).
function connectorPath(x1, y1, hx, x2, y2) {
  const endStub = Math.max(6, Math.min(24, (x2 - x1) * 0.15)); // short stub into the stage
  const p2x = x2 - endStub;
  // First horizontal ends at hx, clamped to leave room for the diagonal + stub.
  const p1x = Math.max(x1 + 6, Math.min(hx, p2x - 8));
  const p1y = y1, p2y = y2;
  const dlen = Math.hypot(p2x - p1x, p2y - p1y) || 1;
  const ux = (p2x - p1x) / dlen, uy = (p2y - p1y) / dlen; // unit vector along the diagonal
  const r = Math.max(0, Math.min(5, p1x - x1, endStub, dlen * 0.4)); // corner round radius
  return 'M ' + f(x1) + ' ' + f(y1)
    + ' L ' + f(p1x - r) + ' ' + f(p1y)                        // first horizontal (past the operator)
    + ' Q ' + f(p1x) + ' ' + f(p1y) + ' ' + f(p1x + r * ux) + ' ' + f(p1y + r * uy) // round into the diagonal
    + ' L ' + f(p2x - r * ux) + ' ' + f(p2y - r * uy)          // the bevel diagonal
    + ' Q ' + f(p2x) + ' ' + f(p2y) + ' ' + f(p2x + r) + ' ' + f(p2y)               // round into the last stub
    + ' L ' + f(x2) + ' ' + f(y2);                             // last horizontal stub into the stage
}
