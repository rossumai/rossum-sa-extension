// A complete DOMRect from the edges a layout test actually cares about.
//
// jsdom has no layout, so these tests stub getBoundingClientRect outright — but DOMRect
// also carries x, y and toJSON, and a stub that omits them is not one. Deriving width and
// height from the edges keeps a stub self-consistent, which matters because the geometry
// under test reads both (stageLink.ts uses hEnd/left/right AND width).
export function rect(r: {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width?: number;
  height?: number;
}): DOMRect {
  const width = r.width ?? r.right - r.left;
  const height = r.height ?? r.bottom - r.top;
  const out = { ...r, width, height, x: r.left, y: r.top };
  return { ...out, toJSON: () => ({ ...out }) };
}
