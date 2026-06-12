# Galaxy: keep the graph visible when zoomed out — design

**Date:** 2026-06-12
**Status:** Approved; implemented (spec-review gate waived by user — "go")

## Problem (confirmed, not assumed)

Zooming out makes the whole galaxy fade into the page background. Root cause, verified in `src/galaxy/scene.js`:
- `:85` `THREE.Fog(bgColor, 1, 4000)` — linear fog colored to the page background. Beyond `far`, a node is 100% fog color = the background = invisible.
- `:163` (`fitToView`) sets `fog.near = max(1, dist)`, `fog.far = dist + r*1.5`, tuned to the *fitted* view.
- `fitToView` runs only on open/after-settle, **not on manual zoom**, and OrbitControls has **no `maxDistance`** (∞). Dollying out grows node depth past the frozen `fog.far` → the galaxy fades out. (Past `camera.far = 8000` it would also hard-clip.)

## Decisions (locked with user)

| Decision | Choice |
| --- | --- |
| Approach | **Dynamic fog**: recompute `fog.near/far` every frame from the live camera→target distance, so the galaxy keeps the same relative fog band at any zoom — always visible, far side still dimmed (depth cue preserved). |
| Zoom cap | **Also cap zoom-out** (`OrbitControls.maxDistance`), set generously: `fittedDist × 8` (galaxy still clearly visible, just small, at the limit). |
| Far plane | Widen `camera.far` once in `fitToView` to cover the capped max distance (`max(8000, maxDistance + r*2)`), so the cap never clips. Cleaner than per-frame far updates since the cap bounds the distance. |
| Dimming amount | Keep the existing `r*1.5` far-multiplier (matches today's fitted look); tunable one-liner if less dimming is ever wanted. |

## Implementation (`src/galaxy/scene.js`)

- Pure exported helper `fogRange(dist, r) → { near: Math.max(1, dist), far: dist + r*1.5 }` (unit-testable without WebGL).
- Scene-level `fogRadius` (set by `fitToView`).
- `applyFog()` sets `scene.fog.near/far = fogRange(camera.position.distanceTo(controls.target), fogRadius)`; called every frame in `animate()` after `controls.update()`.
- `fitToView` now sets `fogRadius`, `controls.maxDistance = dist * MAX_ZOOM_OUT_FACTOR` (8), and widens `camera.far` (guarded `updateProjectionMatrix`). It no longer sets fog directly — `animate`'s `applyFog` owns fog from the live distance.

## Backward compatibility

- `fitToView`'s fog math is unchanged (same `fogRange` formula) → the fitted-view look is identical.
- Theme-color path (`:204`) untouched; auto-rotate and the focus tween unaffected.
- Additive per-frame recompute; no graph/data/interaction change beyond the new zoom cap.
- `camera.near` stays `0.1`; the scene has no co-planar surfaces, so the wider far plane doesn't introduce z-fighting in practice.

## Tests

- `tests/galaxy-scene.test.js`: pure `fogRange` suite (near floored at 1, `far = dist + 1.5r`, `far > near`, monotonic in dist); a wiring test that steps two frames and asserts fog `near/far` track the live camera distance (proving it's not frozen); a `fitToView` test asserting a finite positive `maxDistance` and `camera.far ≥ 8000` exceeding the cap. Mock extended with `Vector3.distanceTo` + camera capture.
- Visual confirmation (actually dollying out in the live Galaxy) remains the developer's browser-verification step, per the scene's established test approach (no WebGL under jsdom).

## Out of scope (YAGNI)

No fog removal, no node-opacity changes, no `minDistance` (zoom-in) cap.
