// Polyfills for jsdom limitations that surface during tests.
//
// jsdom does not implement `Range.prototype.getClientRects` or
// `getBoundingClientRect`. CodeMirror's measure cycle calls these from inside
// `RectangleMarker.forRange` to render selection markers (via the
// `drawSelection` extension that ships with `basicSetup`). The call runs
// asynchronously in an rAF callback, so depending on macrotask scheduling
// it may fire mid-test — producing a `TypeError: textRange(...).getClientRects
// is not a function` that breaks the Preact render that test was about to
// assert against. Returning empty/zero results lets the measure cycle
// complete without throwing (zero-size results are something CodeMirror
// already handles gracefully).

const ZERO_RECT = Object.freeze({
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON() { return {}; },
});

function emptyRectList() {
  const list = [];
  list.item = () => null;
  return list;
}

if (typeof window !== 'undefined' && window.Range) {
  if (!window.Range.prototype.getClientRects) {
    window.Range.prototype.getClientRects = emptyRectList;
  }
  if (!window.Range.prototype.getBoundingClientRect) {
    window.Range.prototype.getBoundingClientRect = () => ({ ...ZERO_RECT });
  }
}
