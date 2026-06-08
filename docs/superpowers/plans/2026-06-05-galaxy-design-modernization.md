# Galaxy Design Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Galaxy 3D org-birdview a modern look — soft matte "clay" lit orbs with depth, softened theme-aware edges/labels, and frosted-glass overlay panels — in both light and dark themes, with no functional changes.

**Architecture:** Three surgical edits. (1) `src/galaxy/scene.js`: swap unlit `MeshBasicMaterial` for lit `MeshStandardMaterial`, add Hemisphere + Directional lights and depth `Fog`, make fog/edge/label colors theme-aware (read from CSS tokens, re-toned on an OS theme flip), drop the now-unused `EffectComposer`/`RenderPass`. (2) `src/galaxy/graph.js`: soften `LINK_STYLE` to neutral cool greys and add per-theme `colorDark`. (3) `src/console/console.css`: convert the three floating `.galaxy-*` panels to frosted glass via new `--glass-*` tokens (light + dark). Interactions, layout, data, and component markup are unchanged.

**Tech Stack:** Preact, three.js `^0.184.0` (namespace import; core classes only — CSP-clean), d3-force-3d `^3.0.6`, esbuild (iife, minify), Vitest `^4.1.4` + jsdom (three.js mocked; no WebGL under jsdom), CSS custom properties with `@media (prefers-color-scheme: dark)`.

> **Project conventions (override skill defaults):**
> - **Do NOT git-commit between tasks. Stay on `master`; no branches/worktrees.** Commit only if the user explicitly asks. Each task therefore ends with a *verification checkpoint* (run tests / build) instead of a commit.
> - Tests are `.test.js` rendering Preact via `h(Component, props)` (never raw JSX in test files) — the oxc test config forbids it.
> - `MeshStandardMaterial`, `HemisphereLight`, `DirectionalLight`, `Fog` are accessed as `THREE.*` (namespace import already in place) — **no new import lines** and **no new dependencies**.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/galaxy/graph.js` | Pure REST→{nodes,links} transform; owns `NODE_STYLE`/`LINK_STYLE` | Modify `LINK_STYLE` only (soften + add `colorDark`). `NODE_STYLE` untouched. |
| `src/galaxy/scene.js` | Imperative three.js scene (createScene) | Materials, lights, fog, theme helpers + re-tone, drop composer. |
| `src/console/console.css` | Console theme tokens + all `.galaxy-*` rules | Add `--glass-*` tokens (light + dark); frost the 3 floating panels. |
| `tests/galaxy-scene.test.js` | Unit tests for `createScene` via three.js mocks | Extend the `three` mock (new classes/capture), add 3 tests, drop composer mock. |
| `tests/galaxy-graph.test.js` | Unit tests for `buildGraph` + style exports | One added assertion (`colorDark` is a string). |

No changes to: `App.jsx`, `Legend.jsx`, `DetailCard.jsx`, `NavGuide.jsx` (markup/classes unchanged — the frosted look is pure CSS), `store.js`, `api.js`, `index.jsx`, `build.js`, `manifest.json`, `package.json`, or the other galaxy tests.

---

## Task 1: Soften `LINK_STYLE` (graph.js) + add per-theme dark variant

**Files:**
- Modify: `src/galaxy/graph.js:12-15`
- Test: `tests/galaxy-graph.test.js:168-177`

**Context:** `LINK_STYLE` currently uses a saturated blue for containment (`rgba(60,95,180,1)`) and a grey for reference. The refresh softens both to neutral cool greys (lighter, semi-transparent) and adds a `colorDark` variant for dark mode. `scene.js` (Task 2) will pick `color` vs `colorDark` by theme. The existing test asserts only that `.color` is a string and `.width > 0`, so keeping those keys preserves it; we add a `colorDark` assertion as the anchor.

- [ ] **Step 1: Add the failing assertion for `colorDark`**

In `tests/galaxy-graph.test.js`, in the test `'exposes a style for every node type and link kind'` (line ~168), add the `colorDark` check inside the existing `for (const k of ['containment', 'reference'])` loop:

```js
    for (const k of ['containment', 'reference']) {
      expect(typeof LINK_STYLE[k].color).toBe('string');
      expect(typeof LINK_STYLE[k].colorDark).toBe('string');
      expect(LINK_STYLE[k].width).toBeGreaterThan(0);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/galaxy-graph.test.js -t "exposes a style"`
Expected: FAIL — `expected undefined to be a string` (no `colorDark` yet).

- [ ] **Step 3: Soften `LINK_STYLE` and add `colorDark`**

In `src/galaxy/graph.js`, replace lines 12-15:

```js
export const LINK_STYLE = {
  containment: { color: 'rgba(60,95,180,1)', width: 1.4 },
  reference:   { color: 'rgba(95,110,150,1)', width: 0.6 },
};
```

with:

```js
export const LINK_STYLE = {
  // Soft neutral cool greys; containment slightly stronger than reference.
  // `color` = light theme, `colorDark` = dark theme (scene.js picks by theme).
  containment: { color: 'rgba(120,128,150,0.85)', colorDark: 'rgba(128,138,176,0.85)', width: 1.4 },
  reference:   { color: 'rgba(150,158,178,0.55)', colorDark: 'rgba(96,108,150,0.6)',   width: 0.6 },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/galaxy-graph.test.js`
Expected: PASS (all `buildGraph` + style tests green).

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npx vitest run tests/galaxy-graph.test.js`
Expected: all green. Do **not** commit.

---

## Task 2: Modernize the 3D scene (scene.js) — lit clay material, lights, fog, theme-aware colors

**Files:**
- Modify: `src/galaxy/scene.js` (multiple regions — see edits below)
- Test: `tests/galaxy-scene.test.js` (extend mock + add tests)

**Context:** This is the core visual change. `scene.js` is an imperative three.js wrapper returning `{ setData, onHover, onClick, focus, setIdleSpin, setVisibleTypes, destroy }`. It currently renders flat unlit spheres through an `EffectComposer` with only a `RenderPass`. We make orbs lit matte clay (`MeshStandardMaterial` + lights), add depth `Fog` tinted to the page background, soften and theme the edges/labels, and render directly (drop the composer). The scene is tested via a `vi.mock('three', …)` factory; jsdom has **no WebGL and no `matchMedia`**, so all theme reads must feature-detect. The test mock must gain the new three classes before the source compiles against them. We update the test first (TDD: new tests go red), then implement.

### Step group A — extend the test mock and add the new tests (test-first)

- [ ] **Step 1: Add capture buckets for scene + lights**

In `tests/galaxy-scene.test.js`, inside `vi.hoisted(() => { … })`, replace the `captured` object literal:

```js
    captured: {
      rendererInstances: [],
      controlsInstances: [],
      composerInstances: [],
      simInstances: [],
      groupInstances: [],
      raycasterInstances: [],
    },
```

with:

```js
    captured: {
      rendererInstances: [],
      controlsInstances: [],
      composerInstances: [],
      simInstances: [],
      groupInstances: [],
      sceneInstances: [],
      lightInstances: [],
      raycasterInstances: [],
    },
```

> Keep `composerInstances` and the `EffectComposer`/`RenderPass` mocks for now — they stay valid until the source stops importing the composer (step group B). They are removed in Step 19, once dead. Removing them earlier would make `createScene` throw in `beforeEach`.

- [ ] **Step 2: Teach the `three` mock the new classes + tracking**

In the `vi.mock('three', () => { … })` factory:

(a) Replace `class Scene { add() {} }` with:

```js
  class Scene {
    constructor() { this.added = []; this.fog = null; captured.sceneInstances.push(this); }
    add(o) { this.added.push(o); }
  }
```

(b) In `class WebGLRenderer`, add a `render` method (used now that the composer is gone):

```js
    render() { this.renders = (this.renders || 0) + 1; }
```

(c) In `class Mesh`, add a `remove` method (label re-tone removes the old sprite child):

```js
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); }
```

(d) Replace `class MeshBasicMaterial { … }` block — keep `MeshBasicMaterial`, and add the four new classes right after it:

```js
  class MeshBasicMaterial {
    constructor(opts = {}) { this.color = opts.color || new Color(); }
    dispose() {}
  }
  class MeshStandardMaterial {
    constructor(opts = {}) { this.color = opts.color || new Color(); this.roughness = opts.roughness; this.metalness = opts.metalness; }
    dispose() {}
  }
  class HemisphereLight { constructor() { captured.lightInstances.push(this); } }
  class DirectionalLight { constructor() { this.position = new Vector3(); captured.lightInstances.push(this); } }
  class Fog { constructor(color, near, far) { this.color = color; this.near = near; this.far = far; } }
```

(e) Add the new classes to the factory's returned object — replace:

```js
  return {
    Scene, Group, PerspectiveCamera, WebGLRenderer, Raycaster,
    Sprite, SpriteMaterial, CanvasTexture, Mesh, SphereGeometry, MeshBasicMaterial,
    BufferAttribute, BufferGeometry, LineSegments, LineBasicMaterial,
    Vector2, Vector3, Color,
  };
```

with:

```js
  return {
    Scene, Group, PerspectiveCamera, WebGLRenderer, Raycaster,
    Sprite, SpriteMaterial, CanvasTexture, Mesh, SphereGeometry,
    MeshBasicMaterial, MeshStandardMaterial, HemisphereLight, DirectionalLight, Fog,
    BufferAttribute, BufferGeometry, LineSegments, LineBasicMaterial,
    Vector2, Vector3, Color,
  };
```

- [ ] **Step 3: (Deferred) leave the composer mocks in place**

Do **not** remove the `EffectComposer`/`RenderPass` `vi.mock` calls yet — `scene.js` still imports them at this point, so they must stay or `createScene` will instantiate the real composer against the mocked `three` and throw. They are removed in Step 19, after step group B drops the import. (Leave the `OrbitControls` mock intact throughout.) No edit in this step.

- [ ] **Step 4: Stub `matchMedia` in `beforeEach` and add a theme-flip control**

jsdom has no `window.matchMedia`. Add a controllable stub so the scene's theme listener can be exercised. Update the `describe` state declaration:

```js
  let container, scene, rafSpy, cancelSpy;
```

to:

```js
  let container, scene, rafSpy, cancelSpy, themeState, mqListeners;
```

Then, at the **top** of `beforeEach` (before `scene = createScene(container)` at line ~201), add:

```js
    themeState = { dark: false };
    mqListeners = [];
    window.matchMedia = (q) => ({
      matches: themeState.dark,
      media: q,
      addEventListener: (_t, fn) => mqListeners.push(fn),
      removeEventListener: (_t, fn) => { const i = mqListeners.indexOf(fn); if (i >= 0) mqListeners.splice(i, 1); },
    });
```

In `afterEach`, after `vi.restoreAllMocks();`, add:

```js
    delete window.matchMedia;
```

- [ ] **Step 5: Add the three new behavior tests**

Append these inside the `describe('createScene (three.js + d3-force-3d)', …)` block (e.g. after the `destroy` test):

```js
  it('adds hemisphere + key lights and depth fog for the lit clay look', () => {
    expect(captured.lightInstances).toHaveLength(2);
    expect(captured.sceneInstances[0].fog).toBeTruthy();
  });

  it('renders directly via the WebGLRenderer (no EffectComposer)', () => {
    expect(captured.rendererInstances[0].renders).toBeGreaterThan(0);
  });

  it('re-tones fog and rebuilds labels when the OS color scheme flips', () => {
    scene.setData(SAMPLE);
    const sceneObj = captured.sceneInstances[0];
    const oldFogColor = sceneObj.fog.color;
    const group = captured.groupInstances[0];
    const orgMesh = group.added.find((o) => o && o.userData && o.userData.id === 'org:1');
    expect(orgMesh.children.length).toBe(1); // exactly one label sprite

    themeState.dark = true;
    mqListeners.forEach((fn) => fn()); // simulate the OS flipping to dark

    expect(sceneObj.fog.color).not.toBe(oldFogColor); // fog recolored to the new bg
    expect(orgMesh.children.length).toBe(1);          // label swapped in place, not duplicated
  });
```

- [ ] **Step 6: Run the scene tests to verify the new ones fail**

Run: `npx vitest run tests/galaxy-scene.test.js`
Expected: the three new tests FAIL — `lightInstances` empty / `fog` null / `renders` undefined / `applyTheme` not wired. All pre-existing tests still PASS (the mock additions are backward-compatible and the composer mock is untouched).

### Step group B — implement the scene changes

- [ ] **Step 7: Remove the EffectComposer + RenderPass imports**

In `src/galaxy/scene.js`, replace lines 5-8:

```js
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ } from 'd3-force-3d';
```

with:

```js
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ } from 'd3-force-3d';
```

- [ ] **Step 8: Add theme-read helpers (module scope) + label color param**

In `src/galaxy/scene.js`, replace the `labelSprite` function (lines 14-27) — add a `color` parameter:

```js
function labelSprite(text, color) {
  const pad = 8, font = 28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width;
  canvas.width = w + pad * 2; canvas.height = font + pad * 2;
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = color || '#243044'; ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthWrite: false, transparent: true }));
  sprite.scale.set(canvas.width / LABEL_PX_PER_UNIT, canvas.height / LABEL_PX_PER_UNIT, 1);
  return sprite;
}
```

Then, immediately after the `DIM_AMT` line (line 35, `const DIM_AMT = 0.8; …`), insert the two helpers:

```js

// Read a Console theme CSS custom property at runtime (so the scene matches the
// page's light/dark backdrop). Falls back when unavailable (e.g. jsdom in tests).
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}
// Current OS color scheme. Feature-detected — jsdom has no matchMedia.
function prefersDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch { return false; }
}
```

- [ ] **Step 9: Add lights + fog at scene setup**

In `createScene`, after `camera.position.set(0, 80, 600);` (line 43), insert:

```js

  // Soft matte "clay" lighting: a hemisphere fill (warm sky / cool ground) so
  // shadowed sides never go black, plus a gentle key light from the upper-left for
  // depth. MeshStandardMaterial renders black without lights, so these are required.
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x9aa6b8, 2.4);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(-0.6, 1, 0.8);
  scene.add(keyLight);
  // Depth fade into the page background — colour read from the Console theme token
  // so it matches light/dark; near/far are refined per-graph in fitToView().
  scene.fog = new THREE.Fog(new THREE.Color(cssVar('--bg-base', '#f1f1f5')), 1, 4000);
```

- [ ] **Step 10: Add the `dark` state flag**

Replace the `visibleTypes` declaration (line 67):

```js
  let visibleTypes = {};       // {} means "all visible"; a type set to false is hidden
```

with:

```js
  let visibleTypes = {};       // {} means "all visible"; a type set to false is hidden
  let dark = prefersDark();    // current OS color scheme; refreshed in setData + on a live flip
```

- [ ] **Step 11: Add edge/label color helpers + `applyTheme()`**

Insert these three functions immediately before `function setData(data) {` (line 126):

```js
  function edgeColor(kind) {
    const s = LINK_STYLE[kind];
    return rgbaColor(s && (dark ? (s.colorDark || s.color) : s.color));
  }
  function labelColorFor() { return dark ? '#e6e6f2' : '#243044'; }
  // Re-tone the theme-dependent scene colours (fog, edges, labels) in place — used
  // when the OS flips light/dark while the Galaxy is open, without disturbing the
  // layout or camera. (Panels/backdrop re-tone on their own via CSS media queries.)
  function applyTheme() {
    dark = prefersDark();
    if (scene.fog) scene.fog.color = new THREE.Color(cssVar('--bg-base', '#f1f1f5'));
    if (linkGeom && baseLinkColors) {
      links.forEach((l, i) => {
        const c = edgeColor(l.kind);
        for (const o of [0, 3]) { baseLinkColors[i * 6 + o] = c.r; baseLinkColors[i * 6 + o + 1] = c.g; baseLinkColors[i * 6 + o + 2] = c.b; }
      });
      applyHighlight(); // pushes baseLinkColors into the geometry, honouring any active dim
    }
    const col = labelColorFor();
    for (const m of meshes.values()) {
      const old = m.userData.label;
      if (!old) continue;
      m.remove(old);
      if (old.material) {
        if (old.material.map && old.material.map.dispose) old.material.map.dispose();
        if (old.material.dispose) old.material.dispose();
      }
      const s = labelSprite(m.userData.name, col);
      s.position.set(0, m.userData.val + 4, 0);
      m.add(s); m.userData.label = s;
    }
  }
```

- [ ] **Step 12: Use lit material + smoother geometry + theme labels in `setData`**

Replace the node-creation loop in `setData` (lines 137-146):

```js
    for (const n of nodes) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(n.val, 14, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(n.color) }));
      mesh.userData = { id: n.id, base: new THREE.Color(n.color) };
      if (n.type === 'organization' || n.type === 'workspace' || n.type === 'queue' || n.type === 'hook') {
        const s = labelSprite(n.name); s.position.set(0, n.val + 4, 0); mesh.add(s);
      }
      group.add(mesh); meshes.set(n.id, mesh);
      typeById.set(n.id, n.type);
      nodeById.set(n.id, n);
    }
```

with:

```js
    dark = prefersDark();
    for (const n of nodes) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(n.val, 24, 24),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(n.color), roughness: 0.9, metalness: 0 }),
      );
      mesh.userData = { id: n.id, base: new THREE.Color(n.color), name: n.name, val: n.val, label: null };
      if (n.type === 'organization' || n.type === 'workspace' || n.type === 'queue' || n.type === 'hook') {
        const s = labelSprite(n.name, labelColorFor()); s.position.set(0, n.val + 4, 0); mesh.add(s);
        mesh.userData.label = s;
      }
      group.add(mesh); meshes.set(n.id, mesh);
      typeById.set(n.id, n.type);
      nodeById.set(n.id, n);
    }
```

- [ ] **Step 13: Build edge colours via the theme helper**

Replace the link-colour loop in `setData` (lines 151-154):

```js
    links.forEach((l, i) => {
      const c = rgbaColor(LINK_STYLE[l.kind] && LINK_STYLE[l.kind].color);
      for (const o of [0, 3]) { baseLinkColors[i * 6 + o] = c.r; baseLinkColors[i * 6 + o + 1] = c.g; baseLinkColors[i * 6 + o + 2] = c.b; }
    });
```

with:

```js
    links.forEach((l, i) => {
      const c = edgeColor(l.kind);
      for (const o of [0, 3]) { baseLinkColors[i * 6 + o] = c.r; baseLinkColors[i * 6 + o + 1] = c.g; baseLinkColors[i * 6 + o + 2] = c.b; }
    });
```

- [ ] **Step 14: Make the fog depth adapt to each graph in `fitToView`**

In `fitToView`, after `const dist = r / Math.tan(fov / 2);` (line 114), insert:

```js
    if (scene.fog) { scene.fog.near = Math.max(1, dist); scene.fog.far = dist + r * 1.5; }
```

(This keeps the front of the graph crisp and gently fades the back, proportionally to the graph's size, every time the layout is (re)fit.)

- [ ] **Step 15: Render directly (drop the composer) + remove its creation/resize**

(a) Remove the composer creation — replace lines 55-58:

```js
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const group = new THREE.Group();
```

with:

```js
  const group = new THREE.Group();
```

(b) In `animate()`, replace `composer.render();` (line 237) with:

```js
    renderer.render(scene, camera);
```

(c) In `resize()`, replace `renderer.setSize(w(), h()); composer.setSize(w(), h());` (line 243) with:

```js
    renderer.setSize(w(), h());
```

- [ ] **Step 16: Wire the OS theme-flip listener**

After the OrbitControls `'start'`/`'end'` listeners (line 289), insert:

```js
  // Re-tone the 3D scene if the OS color scheme flips while the Galaxy is open.
  const themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onThemeChange = () => applyTheme();
  if (themeMq && themeMq.addEventListener) themeMq.addEventListener('change', onThemeChange);
```

- [ ] **Step 17: Clean up the listener + drop composer disposal in `destroy`**

Replace this block in `destroy()` (lines 344-347):

```js
      disposeGraph();
      controls.dispose();
      if (composer.dispose) composer.dispose();
      renderer.dispose();
```

with:

```js
      if (themeMq && themeMq.removeEventListener) themeMq.removeEventListener('change', onThemeChange);
      disposeGraph();
      controls.dispose();
      renderer.dispose();
```

- [ ] **Step 18: Run the scene tests to verify all pass**

Run: `npx vitest run tests/galaxy-scene.test.js`
Expected: PASS — all pre-existing tests plus the three new ones (lights+fog, direct render, theme flip). The `EffectComposer`/`RenderPass` mocks are now dead (the source no longer imports them) but harmless.

- [ ] **Step 19: Remove the now-dead EffectComposer/RenderPass mocks + capture bucket**

`scene.js` no longer imports the composer, so delete the two `vi.mock` calls:

```js
vi.mock('three/addons/postprocessing/EffectComposer.js', () => ({
  EffectComposer: class {
    constructor() { this.passes = []; this.rendered = 0; captured.composerInstances.push(this); }
    addPass(p) { this.passes.push(p); }
    render() { this.rendered++; }
    setSize() {}
    dispose() {}
  },
}));
vi.mock('three/addons/postprocessing/RenderPass.js', () => ({ RenderPass: class {} }));
```

and remove the now-unused `composerInstances: [],` line from the `captured` object in `vi.hoisted`. (No test references it anymore.)

- [ ] **Step 20: Verification checkpoint (no commit)**

Run: `npx vitest run tests/galaxy-scene.test.js tests/galaxy-graph.test.js`
Expected: all green. Do **not** commit.

---

## Task 3: Frosted-glass overlay panels (console.css)

**Files:**
- Modify: `src/console/console.css` — `:root` (line ~35), dark `@media` block (line ~70), `.galaxy-legend` (2653), `.galaxy-detail-card` (2717), `.galaxy-help` (2856)

**Context:** The three floating panels (Legend bottom-left, Detail card top-right, Navigate help top-left) are currently opaque `var(--bg-card)` cards. We convert them to frosted glass — translucent background + `backdrop-filter: blur`, a hairline light border, a larger radius, and a soft layered shadow — driven by new `--glass-*` tokens so light/dark are handled by the existing media-query token system. The full-screen `.galaxy-loading` and `.galaxy-error` overlays are intentionally left opaque (they cover the scene during load/error; frosting them is pointless). No CSS test framework exists — this task is verified by build + manual inspection in both themes.

- [ ] **Step 1: Add `--glass-*` tokens to the light `:root`**

In `src/console/console.css`, in the light `:root` block, after the `--shadow: 0 1px 3px rgba(0, 0, 0, 0.06);` line (line 35), add:

```css
  --glass-bg: rgba(255, 255, 255, 0.55);
  --glass-border: rgba(255, 255, 255, 0.85);
  --glass-shadow: 0 8px 30px rgba(20, 32, 54, 0.16);
```

- [ ] **Step 2: Add the dark `--glass-*` overrides**

In the `@media (prefers-color-scheme: dark)` block's `:root`, after the `--shadow: 0 1px 3px rgba(0, 0, 0, 0.3);` line (line ~70), add:

```css
    --glass-bg: rgba(26, 26, 46, 0.62);
    --glass-border: rgba(255, 255, 255, 0.14);
    --glass-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
```

- [ ] **Step 3: Frost the Legend panel**

Replace the opening of `.galaxy-legend` (lines 2653-2660):

```css
.galaxy-legend {
  position: absolute;
  bottom: 16px;
  left: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 8px 12px;
```

with:

```css
.galaxy-legend {
  position: absolute;
  bottom: 16px;
  left: 16px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
  padding: 8px 12px;
```

- [ ] **Step 4: Frost the Detail card**

Replace `.galaxy-detail-card` (lines 2717-2728):

```css
.galaxy-detail-card {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 280px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow), 0 4px 16px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  z-index: 2;
}
```

with:

```css
.galaxy-detail-card {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 280px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
  overflow: hidden;
  z-index: 2;
}
```

- [ ] **Step 5: Frost the Navigate help panel**

Replace the opening of `.galaxy-help` (lines 2856-2864):

```css
.galaxy-help {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 2;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 10px 12px;
```

with:

```css
.galaxy-help {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 2;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
  padding: 10px 12px;
```

- [ ] **Step 6: Build and verify the CSS copied cleanly**

Run: `npm run build`
Expected: build succeeds; `dist/console/console.css` contains `--glass-bg` and `backdrop-filter: blur(12px)` (grep to confirm: `grep -c "glass-bg" dist/console/console.css` → ≥ 4 occurrences: 1 light token + 1 dark token + uses).

---

## Task 4: Full verification (tests, build, CSP, manual)

**Files:** none (verification only)

**Context:** Final gate before handing back. Confirms the whole suite is green, the bundle builds and stays CSP-clean (no `new Function`/`eval` introduced — we only added three.js core classes), and the look is correct in a real browser in both themes (the honest caveat: jsdom can't render WebGL, so the visual is confirmed manually).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green (the skill release-process requires a fully green suite). Pay attention to `galaxy-*` and any test that imports `scene.js`/`graph.js`. If flaky, re-run; do not paper over a real failure.

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: clean build into `dist/`.

- [ ] **Step 3: Confirm CSP-clean (no codegen introduced)**

Run: `grep -nE "new Function|eval\(" dist/console/console.js || echo "CSP-clean: no codegen"`
Expected: prints `CSP-clean: no codegen` (the modernization adds only three.js core lighting/material/fog — no new codegen path; `3d-force-graph`/ngraph remains absent).

- [ ] **Step 4: Manual browser verification — light mode**

Load `dist/` as an unpacked extension, open a Rossum tab, launch the Console → Galaxy. With the OS in **light** mode, confirm:
  - Orbs render as soft, dimensional matte spheres (shaded, not flat discs); the rainbow palette is intact and Legend dots match.
  - Edges are soft neutral grey; labels (org/workspace/queue/hook) are dark and legible.
  - The three panels (Legend, Detail card after a click, Navigate help) are frosted — translucent with a blur, hairline light edge, rounded corners, soft shadow.
  - Interactions are unchanged: hover-dim + neighbour highlight, click-to-pin + focus zoom, idle auto-rotate (pauses on drag, resumes after 15s), type-visibility toggles + reflow.
  - Distant nodes fade gently into the background (fog), with no hard clipping.

- [ ] **Step 5: Manual browser verification — dark mode**

Switch the OS to **dark** mode (ideally with the Galaxy already open, to exercise the live re-tone) and confirm:
  - Backdrop is the deep Console dark (`#12121e`); orbs pop against it; labels flip to light and stay legible; edges shift to the lighter cool grey.
  - Panels become dark translucent glass with a subtle light hairline and light text.
  - If the Galaxy was already open during the flip, fog/edges/labels re-tone without a reload (the live `matchMedia` re-tone); panels/backdrop re-tone via CSS.

- [ ] **Step 6: Note the bundle-size delta (informational)**

Compare `dist/console/console.js` size before/after (dropping `EffectComposer`/`RenderPass`, adding only core lights/material/fog). Expected: roughly flat or slightly smaller. Record the number in the handoff note.

- [ ] **Step 7: Final checkpoint (no commit)**

Confirm: `npm test` green, `npm run build` clean, CSP grep clean, both themes verified. Report results to the user. Do **not** commit unless the user asks.

---

## Notes / deliberate decisions

- **Node sizes unchanged.** Sphere *radius* stays `n.val` (governed by `NODE_STYLE`); only segment count rises 14→24 for a rounder silhouette. This avoids rippling into the label offset (`n.val + 4`) and focus-framing math. The "clay" quality comes from lighting + smoothness, not size.
- **No emissive on the orbs.** The `HemisphereLight` ambient fill keeps shadowed sides from going black, so the matte look needs no emissive — and avoiding emissive keeps the hover-dim (`material.color` lerp toward grey) reading cleanly.
- **Edge styling source of truth.** Both light + dark edge colours live in `graph.js` `LINK_STYLE` (`color`/`colorDark`); `scene.js` only *picks* by theme. `.width` is retained (and still unused by the single shared `LineSegments`, as before) to preserve the existing export contract and test.
- **Lighting/fog tuning values** (hemisphere `2.4`, key `1.8`, fog `near=dist`, `far=dist + r*1.5`) are sensible starting points; fine-tune in the browser (Steps 4-5 of Task 4). They do not affect unit tests (three.js is mocked).
- **Theme-flip scope.** A live OS flip re-tones the 3D scene (fog/edges/labels via `applyTheme`) and the CSS (panels/backdrop via media queries). Lights and the node palette are theme-constant by design.
- **Light `--glass-border` is intentionally a bright white hairline (`rgba(255,255,255,0.85)`),** matching the approved mockup. On the near-white `--bg-base` it is deliberately subtle — a glass-edge *highlight*, not the separator. Panel separation comes from `--glass-shadow` (a soft drop shadow) + the blur. Do not "fix" it to a dark border without re-confirming the design; verify panel edges read well in the light-mode browser pass (Task 4 Step 4) instead.
