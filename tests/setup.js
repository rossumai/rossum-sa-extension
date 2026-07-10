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

// jsdom does not implement ResizeObserver. RecordTable observes its wrap to keep
// the computed filler (last) column sized to the pane. A no-op stub lets the
// component mount under jsdom (layout-dependent behavior is verified in-browser).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not always provide requestAnimationFrame in a worker context. Some
// components (CodeMirror measure cycles, Preact after-paint effects) schedule a
// rAF from inside an async task; when it's missing the call throws as an
// *unhandled rejection* that vitest attributes to whichever file happens to be
// running — a flake that only surfaces under full-suite load as test ordering
// shifts. Define a guarded no-op (only where missing): it stops the throw
// without invoking the callback, matching the pre-polyfill reality (the throw
// meant the callback never ran), so there is no behavior change or cascade.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
}

