# Galaxy Design Modernization (Design)

**Date:** 2026-06-05
**Status:** Approved-pending-review
**Component:** Console → Galaxy 3D org birdview (`src/galaxy/`)

## 1. Problem / goal

The Galaxy app renders the org as a 3D force-directed graph (three.js + d3-force-3d, CSP-clean hand-rolled scene). Its current look is **visually flat and basic**:

- Nodes are `MeshBasicMaterial` — *unlit*, flat-shaded coloured circles (no depth/shading).
- Thin 1px `LineSegments` edges; dark canvas-sprite labels.
- Transparent canvas over the Console's light `--bg-base`; no lighting, no fog, no glow.
- Overlay panels (Legend / Detail / Navigate / loading) are plain Console cards (white, 1px border, basic shadow).

**Goal:** modernize the *look* — a soft, dimensional, contemporary aesthetic — in **both light and dark themes**. Functionality (data, layout, interactions) is unchanged.

## 2. Chosen design (validated via visual brainstorm)

Direction picked through side-by-side mockups:

- **Scene = "L2 · Soft matte / clay" (light-first).** Rounded, matte, dimensional orbs with soft top-lighting and gentle depth — *not* a dark-space/glow look (the dark "galaxy" and neon directions were explicitly rejected).
- **Overlay = "O2 · Frosted glass."** Translucent, blurred panels through which the scene shows faintly.
- **Both themes.** Light (`--bg-base #f1f1f5`) and dark (`--bg-base #12121e`) re-tonings of the *same* system were both approved.

## 3. Scope

**In:** the Galaxy's visual appearance — 3D materials/lighting/background/depth, edge & label styling, and the overlay panel styling, in light + dark.

**Out (unchanged):** the graph data/REST layer (`api.js`, `graph.js` `buildGraph`), the force layout, all interactions (auto-rotate/idle, hover-dim + neighbour highlight, click-to-pin + focus zoom, type-visibility toggles), the node→type→colour semantic mapping, deep-links, store/signals.

## 4. Architecture

### Part A — 3D scene (`src/galaxy/scene.js`, palette in `graph.js`)

- **Materials:** `MeshBasicMaterial` → **`MeshStandardMaterial`** (`roughness ≈ 0.9`, `metalness 0`) so nodes shade as soft matte orbs. Spheres get more segments (14 → ~24) and a slightly larger `val` so silhouettes read as rounded clay. A very small `emissive` (≈ base colour × 0.06) keeps colours from going muddy in shadow and helps them read on the dark backdrop.
- **Lighting (new — none today):** a `HemisphereLight` (warm sky / cool ground) for soft ambient fill, plus a gentle `DirectionalLight` from the upper-left for the soft top-shading. *Required* — `MeshStandardMaterial` renders black without lights. Lights are theme-constant (the same lighting reads well on both backdrops).
- **Backdrop:** the canvas stays `alpha:true`; the backdrop is the CSS `background: var(--bg-base)` on `.galaxy-stage`/`.galaxy-canvas` — so it follows the theme automatically with no JS.
- **Depth:** add `scene.fog` whose colour matches `--bg-base` (read from computed style at init) so distant nodes fade softly into the backdrop — the soft depth the clay look needs.
- **Edges:** soften `LINK_STYLE` to neutral cool greys, theme-aware (a darker grey on light, a lighter cool grey on dark) so they read on both; containment slightly stronger than reference. Stay `LineSegments` (cheap).
- **Labels:** keep canvas-sprite labels but draw the text in a theme-aware colour (dark on light, light on dark) read from the theme.
- **Cleanup:** drop the now-unused `EffectComposer` + `RenderPass` (L2 needs no post-processing) and render via `renderer.render` directly — slightly smaller bundle, simpler.
- **Palette:** node hues unchanged in both themes (semantic mapping → Legend). Contrast + the small emissive make them pop on dark; no separate per-theme palette.

### Part B — Overlay panels (`src/console/console.css` `.galaxy-*`, minor component tweaks)

- **Frosted glass** for Legend / DetailCard / NavGuide / loading: `background: rgba(...)` over `backdrop-filter: blur(~12px)`, a hairline light border, larger radius (~14px), and a soft layered shadow; refined type/spacing. The scene shows faintly through.
- **Light:** white-translucent glass, dark text. **Dark:** dark-translucent glass (`--bg-card`-toned, ~0.6 alpha) with a hairline light edge (`rgba(255,255,255,.14)`) and light text.
- Implemented mostly as CSS on the existing `.galaxy-*` rules, with the dark variant in the existing `@media (prefers-color-scheme: dark)` block. Component markup is largely unchanged.

### Theme strategy

- **CSS-driven (no JS):** panel styling and the canvas backdrop use theme tokens + the `@media (prefers-color-scheme: dark)` overrides already in `console.css` → automatically correct in both themes.
- **JS-driven scene bits (fog colour, edge colour, label text colour):** read from computed CSS custom properties at scene init. Add a `matchMedia('(prefers-color-scheme: dark)')` change listener that re-applies them (recolour edges, update fog, rebuild label sprites) so a live system-theme flip re-tones the scene without a reload. (Lights + node palette are theme-constant, so they need no re-tone.)

## 5. Feasibility & constraints (verified)

- **CSP:** `MeshStandardMaterial`, lights, and `fog` are core three.js (shader-based, no `eval`) — CSP-clean, same as the existing hand-rolled scene. `backdrop-filter` is plain CSS. No `3d-force-graph`/ngraph involved.
- **Dependencies:** none added (all three.js core). Dropping `EffectComposer`/`RenderPass` likely makes the bundle slightly *smaller*.
- **Interactions intact:** hover-dim lerps `material.color` — works identically on `MeshStandardMaterial`; focus/zoom, pin, visibility toggles, idle-spin unaffected.

## 6. Testing

- `scene.js` is unit-tested via three.js mocks (no WebGL under jsdom). Update the mocks for the new `MeshStandardMaterial` + lights so existing tests stay green; add coverage for the theme-read/re-tone helper (e.g. it picks the dark label/edge/fog colours when `matchMedia` reports dark) using a mocked `matchMedia`/`getComputedStyle`.
- The actual look is **browser-verified** (build `dist/`, open Galaxy in light and dark) — the usual honest caveat: CLI build + unit tests pass, but the final visual is confirmed in the extension.

## 7. Files touched

- **`src/galaxy/scene.js`** — materials, lighting, fog, sphere geometry, theme-read helper + `matchMedia` re-tone, drop composer.
- **`src/galaxy/graph.js`** — soften `LINK_STYLE`; (node palette unchanged).
- **`src/console/console.css`** — `.galaxy-*` panel rules → frosted glass (light) + dark variant in the `@media (prefers-color-scheme: dark)` block; `.galaxy-stage` backdrop `var(--bg-base)`.
- **`src/galaxy/components/{Legend,DetailCard,NavGuide}.jsx`** — minor class/markup tweaks only if needed for the frosted treatment.
- Tests: `tests/galaxy-*` (scene/component) mock updates.

## 8. Out of scope / follow-ups

- New affordances (search, minimap, richer focus animations) — not part of this visual refresh.
- Node-label-on-demand / engine labels — unchanged.
- Any change to graph semantics, edge derivation, or the data layer.
