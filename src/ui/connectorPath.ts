// Shared, DOM-free path emitters for this repo's connector lines — the beveled
// "A --leg-- B ==diagonal== C --leg-- D" shape with small rounded bends, and the
// little filled triangle that terminates one.
//
// Extracted from src/mdh/stageLink.js (the Stages-view → pipeline-editor
// connector) when the training quest card's tether became a second consumer:
// the owner asked for the tether to use "the same geometry as the MDH Stages
// view", and sharing the emitter is the only version of that which stays true
// — a copy drifts the moment either one is tuned. What is NOT shared is each
// connector's own anchoring: stageLink works in panel-relative coordinates off
// CodeMirror line rects, tether.js in viewport coordinates off the card and a
// DOM target. Those are genuinely different problems; only the drawn shape is
// common, so only the drawn shape moved here.
//
// Every coordinate is in whatever space the caller is already using; nothing
// here reads the DOM or assumes an origin.

/** A point in whatever coordinate space the caller is already using. */
export type Point = { x: number; y: number };

export const f = (n: number): string => n.toFixed(1);

const unit = (from: Point, to: Point) => {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, len };
};

// A --[leg]-- B ==[bevel diagonal]== C --[leg]-- D, with a small quadratic round
// at each bend. Two radii, not one: each bend can only give up as much as its own
// leg has, and tying both to the shorter leg would square off the other corner.
export function bevelPath(A: Point, B: Point, C: Point, D: Point): string {
  const ab = unit(A, B),
    bc = unit(B, C),
    cd = unit(C, D);
  const r1 = Math.max(0, Math.min(5, ab.len, bc.len * 0.4));
  const r2 = Math.max(0, Math.min(5, cd.len, bc.len * 0.4));
  return (
    'M ' +
    f(A.x) +
    ' ' +
    f(A.y) +
    ' L ' +
    f(B.x - r1 * ab.x) +
    ' ' +
    f(B.y - r1 * ab.y) + // first leg
    ' Q ' +
    f(B.x) +
    ' ' +
    f(B.y) +
    ' ' +
    f(B.x + r1 * bc.x) +
    ' ' +
    f(B.y + r1 * bc.y) + // round into the diagonal
    ' L ' +
    f(C.x - r2 * bc.x) +
    ' ' +
    f(C.y - r2 * bc.y) + // the bevel diagonal
    ' Q ' +
    f(C.x) +
    ' ' +
    f(C.y) +
    ' ' +
    f(C.x + r2 * cd.x) +
    ' ' +
    f(C.y + r2 * cd.y) + // round into the last leg
    ' L ' +
    f(D.x) +
    ' ' +
    f(D.y)
  ); // last leg into the end
}

// A small filled triangle whose apex points `dir`, sitting at (x, y).
//
// The vertical cases emit BYTE-IDENTICAL output to the `edgeArrowPath` this was
// lifted from, vertex order included, so extracting it could not have moved a
// pixel in the Stages view — which is what the 26 stage-link tests assert. The
// horizontal cases are the plain transpose of that same formula: apex ARROW_H
// along the pointing axis, base 1px behind it, ±ARROW_W to either side.
const ARROW_H = 6,
  ARROW_W = 5;
export type ArrowDir = 'up' | 'down' | 'left' | 'right';

export function arrowHeadPath(x: number, y: number, dir: string | null): string | null {
  if (dir === 'up' || dir === 'down') {
    const d = dir === 'up' ? -1 : 1;
    return (
      'M ' +
      f(x) +
      ' ' +
      f(y + d * ARROW_H) +
      ' L ' +
      f(x + ARROW_W) +
      ' ' +
      f(y - d * 1) +
      ' L ' +
      f(x - ARROW_W) +
      ' ' +
      f(y - d * 1) +
      ' Z'
    );
  }
  if (dir === 'left' || dir === 'right') {
    const d = dir === 'left' ? -1 : 1;
    return (
      'M ' +
      f(x + d * ARROW_H) +
      ' ' +
      f(y) +
      ' L ' +
      f(x - d * 1) +
      ' ' +
      f(y + ARROW_W) +
      ' L ' +
      f(x - d * 1) +
      ' ' +
      f(y - ARROW_W) +
      ' Z'
    );
  }
  return null;
}
