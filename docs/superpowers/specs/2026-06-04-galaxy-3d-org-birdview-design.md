# Galaxy — 3D Org Birdview Console App (Design Spec)

**Date:** 2026-06-04
**Status:** ✅ Implemented (2026-06-05). This document captures the original design intent; several decisions changed during implementation — see **§0 Implementation deltas** for the as-built reality.
**Topic:** A new Console app that renders a Rossum organization and its resources as an explorable 3D force-directed network ("galaxy").

---

## 0. Implementation deltas (as-built, 2026-06-05)

The feature shipped. These points override the original design where they differ:

- **Render tech: raw three.js + d3-force-3d + OrbitControls**, NOT `3d-force-graph`. Bundling `3d-force-graph` pulled in ngraph's `new Function` codegen; it was verified runtime-safe under the default CSP, but to guarantee a clean published bundle (Chrome Web Store) the maintainer chose to drop the library and hand-roll the scene. Result: bundle ~1.3 MB (−36%); `grep` of `dist/console/console.js` for `eval(`/`new Function(`/`WebAssembly` is **0**.
- **Light theme, not dark "space".** Bloom removed (washes out a light background); the scene/overlays reuse the Console's CSS variables. Node palette is a **rainbow keyed to hierarchy depth** (org red → workspace orange → queue green → hook blue → engine violet).
- **Scope: `connector` and the `run_after` edge were dropped** (maintainer feedback). Final node types: organization, workspace, queue, hook, engine. Engines are **fetched** (`/engines`) so they show real names + details; the queue→engine ref uses the **unified `queue.engine` field** (verified live on ferguson-dev; legacy `dedicated_engine`/`generic_engine` are fallbacks — this was the one wrong assumption the live check caught).
- **Interactions beyond the design:** auto-rotate **off**; fit-to-visible on open + after settle; hover-dim with **click-to-pin** (survives a rotate drag via a click-vs-drag movement threshold); click frames the node + its neighbors (not a tight zoom); **clickable-Legend type filters** with layout **reflow** (sim re-heats on the visible subset); a **loading counter** of objects fetched; a curated **detail panel** per type (grounded in verified live fields).
- **Deep-links:** queue + hook only (the routes present in `audit/deeplink.js`). workspace/engine/organization routes remain unverified against the live UI and are intentionally omitted (the button hides for unknown types) — see §12.
- Tests: **726 passing**, incl. `tests/galaxy-*.test.js` (store, api, graph, scene, app, detailcard, legend, init, navguide).

---

## 1. Summary

Galaxy is a new app in the unified Console's left app-switcher rail (alongside Dataset Management and Audit). It fetches the live Rossum organization over the REST API — using the token/domain the Console shell already holds — and renders it as a rotating, explorable **3D force-directed network**: glowing nodes for resources, luminous links for relationships.

**Primary purpose: demo wow-factor.** The bar is "visually striking, smooth to rotate, impressive on a screen." The scene must be backed by real org data (it is a birdview of an actual org), but exhaustive drill-down, search, and config-audit features are explicitly *not* goals for v1.

App id: `galaxy`. Rail label: `Galaxy`.

## 2. Decisions locked during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Primary purpose | Wow-factor demo | Prioritize aesthetics + smooth rotation over drill-down/search/audit. |
| Scope of nodes | Backbone (org → workspace → queue) + Extensions & pipeline (hooks, connectors, engines + `run_after` edges) | Schemas, inboxes, users/groups, annotations, documents excluded → ~150 nodes for a medium org. |
| Target scale | Medium org: ~5–20 workspaces, ~30–150 queues, ~100–400 total nodes | Drives the rendering/LOD choices. |
| Metaphor | Network galaxy (3D force-directed graph) | The Rossum model genuinely *is* a graph; highest "alive" factor. |
| Render tech | `3d-force-graph` library (on three.js) + bloom | Purpose-built for this metaphor; fastest path to wow. CSP-safe `d3` engine only. |
| Layout | Hierarchy-seeded force layout that settles + idle camera auto-rotate | Structure stays readable; great left running on a demo screen. |
| Interactions | Hover-highlight, click→detail card, deep-link to Rossum. (Search + type filters declined.) | The "explore as needed" payoff without UI clutter. |
| Labels | Org + workspace always-on; everything else on hover/focus | Readable at a few hundred nodes. |

## 3. Grounded context (verified, not assumed)

These facts were verified against the repo and the API surface before this spec was written:

### 3.1 How a Console app is added (verified against source)
The rail is a **hardcoded `APPS` array**, not a plugin registry. A new app must touch **three switch points that must all agree** or the app is silently dropped:
1. `src/console/components/Rail.jsx` — add an inline SVG icon + an entry to `APPS` (`{ id, label, title, icon }`).
2. `src/console/components/Console.jsx` — extend the render switch to map `app === 'galaxy'` to its root (read its `connected` signal; render `<Connecting/>` while `null`, else `<GalaxyApp connected={c}/>`).
3. `src/console/boot.js` — extend `isValidApp` to accept `'galaxy'` (else a staged/persisted `galaxy` id falls back to `mdh`).

Plus, in `src/console/index.jsx`: import `* as galaxyApi`, `* as galaxyStore`, `initGalaxy`; add `galaxy` to the `TITLES` map; in the no-credentials branch set `galaxyStore.connected.value = false`; in the connected branch set `galaxyStore.domain/token` and call `galaxyApi.init(domain, token)`; add a branch to `ensureInited(app)` memoized behind a `galaxyInited` flag.

Optional launch path: a popup button (`src/popup/components/App.jsx`) calling `openConsoleTab(tab, auth, 'galaxy')`. Otherwise reachable by clicking the rail item after opening the Console.

No `build.js` entry point and no `manifest.json` change are required — the app is bundled transitively into `console.js` via the `console/index.jsx` import chain.

### 3.2 Auth flow (shared, verified)
The Console shell resolves auth once (single-use `consoleAuth_<uuid>` staging entry → moved to `sessionStorage`, key purged) and feeds every app `store.domain`, `store.token`, then calls `api.init(domain, token)`. A new app **must not** read `localStorage.secureToken` itself and **must not** leave the token at rest. It exposes `domain`, `token`, `connected` (tri-state `signal(null)`) signals + `api.init(domain, token)`; the shell drives them.

### 3.3 REST client convention (template: `src/audit/api.js`)
- `init(domain, token)` → `baseDomain`, `authHeader = 'Bearer ' + token`.
- `get(path, {signal})` → `fetch(baseDomain + path, { headers: { Authorization, Accept: 'application/json' } })`, 30s timeout via `AbortController`, `401`→reconnect error, `403`→`err.featureUnavailable = true`.
- `buildQuery(params)`, `extractParam(url, name)`, `normalizePage(pagination, mode)`.
- Rossum list responses carry a `pagination` object with `total`, `next`, `previous`; references between resources are returned as **absolute hyperlinked URLs** (parse the trailing id).
- `whoami` hits `/api/v1/auth/user/`.

### 3.4 Deep-link builder (`src/audit/deeplink.js`, verified)
`ROUTES[type] = (id) => path`; `buildDeeplink(origin, type, id)` returns an absolute URL or `null` (unknown type / missing id → no link). Currently covers `annotation`, `queue`, `hook`. Routes are explicitly marked *unverified against the live UI*. We extend `ROUTES` with the additional node types; unknown types degrade gracefully (button hidden).

### 3.5 Rendering feasibility (verified)
- Console page runs under the **default MV3 CSP** (`script-src 'self'`). WebGL is a canvas API, not governed by CSP; three.js core + addons contain no `eval`/`new Function`/`WebAssembly`/dynamic `import()` → CSP-safe with **no manifest change**.
- `3d-force-graph` v1.80.0 (pulls `three` ≥0.179, `three-forcegraph`, `three-render-objects`, `kapsule`) bundles cleanly under the repo's esbuild (`bundle`, `minify`, `format:'iife'`). Bundle impact ≈ **360KB gzip / 1.32MB raw** added to `console.js`.
- **CSP landmine:** `3d-force-graph`'s `ngraph` force engine uses `new Function` and would be **blocked**. We use the **default `d3` engine only** and never call `.forceEngine('ngraph')`.

### 3.6 Build constraints (verified)
esbuild only — no TypeScript/Babel. Every `.jsx` must `import { h } from 'preact'` (and `Fragment` when needed). Preact + `@preact/signals` for UI/state. Reuse `console.css` (add scoped rules under `.app-root`); use existing CSS custom properties + dark-mode `:root` overrides. Namespace all `chrome.storage.local` keys with the `galaxy` prefix.

## 4. The resource graph

### 4.1 Node types
`organization`, `workspace`, `queue`, `hook`, `connector`, `engine`.

### 4.2 Edges
| Edge | Source field (to verify live) | Kind |
|---|---|---|
| org → workspace | `workspace.organization` | containment |
| workspace → queue | `queue.workspace` | containment |
| queue → hook | invert `hook.queues[]` (N:M) | reference |
| hook → hook | `hook.run_after[]` (the pipeline DAG) | reference / ordering |
| queue → connector | `queue.connector` | reference |
| queue → engine | `queue.dedicated_engine` / `queue.generic_engine` | reference |

⚠️ **Grounding caveat:** the exact ref field names above are grounded in the API tool descriptions + the Rossum reference skill, **not yet verified against a live org** (no token was connected during design). The **first implementation step** is to confirm these against a real org and adjust `graph.js` accordingly. A missing/renamed field must degrade to "no edge," never a crash.

## 5. Architecture & modules

Follows the established MDH/Audit per-app pattern under `src/galaxy/`:

```
src/galaxy/
  store.js               @preact/signals: domain, token, connected(null),
                         graph({nodes,links}), loading, error,
                         selectedNode, hoveredNode, + view prefs
  api.js                 init(domain,token); get(path); listAll(path) — follows
                         pagination.next to fully enumerate a collection
  graph.js               PURE: buildGraph(raw) -> {nodes, links}
                         (URL->id parsing, type/color assignment, edge inversion)
  scene.js               imperative wrapper around 3d-force-graph:
                         instance + bloom composer + d3 forces + hierarchy seeding
                         + OrbitControls autoRotate + hover/click wiring
  index.jsx              initGalaxy(): restore prefs from chrome.storage.local,
                         whoami connection probe -> connected, register
                         persistence effects (run-once, gated)
  components/App.jsx      default App({connected}); renders scene container +
                         overlays; bridges signals <-> scene.js via preact effects
  components/DetailCard.jsx   focused-node card + "Open in Rossum" button
  components/Legend.jsx       color -> resource-type legend overlay
```

Shared edits outside `src/galaxy/`: the 3 wiring points (§3.1), the `console/index.jsx` import/auth lines, `audit/deeplink.js` ROUTES extension, optional popup launch button, and `console.css` additions.

### 5.1 Separation of concerns
- `graph.js` is **pure data** (no DOM, no three.js) → fully unit-testable.
- `scene.js` is **imperative rendering** isolated behind a small interface (`mount(el)`, `setData({nodes,links})`, `onHover(cb)`, `onClick(cb)`, `focus(nodeId)`, `setIdleSpin(bool)`, `destroy()`). The Preact layer never touches three.js directly.
- `App.jsx` bridges the two: `effect()`s push `store.graph` into `scene.setData`, and scene callbacks write back to `store.hoveredNode`/`selectedNode`.

## 6. The scene (rendering detail)

- **Engine:** `3d-force-graph`, default `d3` force engine.
- **Hierarchy seeding:** seed initial positions by depth — org at center, workspaces on an inner shell, queues on an outer shell, extensions near their queues — then let the d3 sim relax and cool to a stable layout (not perpetual drift).
- **Bloom:** add `UnrealBloomPass` (from `three/addons`) to the lib's `.postProcessingComposer()` for the neon glow.
- **Idle auto-rotate:** enable OrbitControls `autoRotate`; pause on user interaction, resume after a short idle timeout.
- **Node visuals:** glowing spheres, size by type (org largest → queue smallest), color by type (org amber, workspace blue, queue cyan, hook violet, connector green, engine pink).
- **Link visuals:** containment links brighter/thicker; reference links thinner; `run_after` links a distinct style/color to read as a pipeline chain.

## 7. Interactions

- **Hover:** node + directly-connected neighbors brighten while the rest dims; show the node's label (lib `nodeLabel`).
- **Click → detail card:** camera eases to focus the node; `DetailCard.jsx` shows name, type, and a few key facts (e.g. a queue's connector + engine + attached-hook count). An **Open in Rossum** button uses `buildDeeplink(origin, type, id)`; hidden when no route exists for the type.
- **Orbit / zoom / drag:** provided by the library.
- Labels per §2 (org + workspace always-on via canvas-texture label sprites; rest on hover/focus).

## 8. Error handling & edge cases

- `connected` tri-state drives the shell's `<Connecting/>`. Probe via `/api/v1/auth/user/` in `initGalaxy`.
- `401` → reconnect message ("Open a Rossum page and click Galaxy again to reconnect").
- `403` on a single resource collection → that node type is simply absent (partial galaxy), never a hard failure.
- Network/timeout → error overlay with a Retry action.
- **Big-org guard (no silent truncation):** above a node-count threshold (well beyond "medium"), disable bloom + always-on labels and cap rendered nodes to stay smooth, showing a visible "showing N of M resources" note.
- **Inactive-app gating:** all rAF / simulation / fetch work self-gates on `activeApp.value === 'galaxy'` so the app costs nothing when another Console app is active.

## 9. Testing

- `graph.test.js` — pure `buildGraph` against fixture REST payloads: edge inversion (`hook.queues[]` → queue→hook), `run_after` DAG, URL→id parsing, and tolerance of missing/renamed refs. Plain `.test.js` per the repo's vitest convention (no raw JSX; `h()` + `vi.mock` where components are involved).
- `api.test.js` — `listAll` pagination loop + `401`/`403` handling with `fetch` mocked.
- `scene.js` (WebGL) is verified by hand (no WebGL in jsdom); it is kept thin and config-heavy so little logic is untested. Use condition-based `waitFor` (not fixed timeouts) in any jsdom-rendered component test, per the repo's flaky-test lesson.

## 10. Dependencies & build impact

- Add `3d-force-graph` (+ transitive `three`, `three-forcegraph`, `three-render-objects`, `kapsule`).
- ≈ 360KB gzip added to `console.js`. No esbuild config change, no `manifest.json`/CSP change.
- Update CLAUDE.md: add `src/galaxy/` under Architecture, list `galaxy*` storage keys, and note the new dependency.

## 11. Out of scope (YAGNI for v1)

Search; type-visibility filters; live metrics / health overlays; schemas, inboxes, users/groups, annotations, documents; write actions; camera-position persistence; multi-org views.

## 12. Open items to verify during implementation

1. **Live ref field names** (§4.2 caveat) — confirm against a real org, fix `graph.js`.
2. **Rossum UI routes** for the new deep-link types (`workspace`, `connector`, `engine`, `organization`) — like the existing `queue`/`hook` routes, currently unverified.
3. **Engine nodes** — whether to fetch a `/dedicated_engines` + `/generic_engines` list for names, or derive engine nodes from distinct `queue` engine refs.
4. **Label sprite approach** — custom canvas-texture sprites vs. adding `three-spritetext` (extra small dep); prefer no extra dep if the custom sprite looks acceptable.
