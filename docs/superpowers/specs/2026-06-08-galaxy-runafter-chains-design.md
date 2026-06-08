# Galaxy: run_after pipeline chains

**Date:** 2026-06-08
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user (visual companion)

## 1. Goal

Make hook `run_after` ordering visible in the Galaxy 3D org graph. Instead of fanning every hook directly off its queue (which hides the execution order), a run_after chain hangs off the queue as a pipeline: `Queue → A → B → C`, with the chained hooks linked to their predecessors rather than the queue. Clicking the queue highlights the whole chain.

## 2. Verified facts (grounding)

- `hook.run_after` is an array of hook URLs that must run before this hook (the pipeline-ordering DAG). Confirmed in code: `graph.js` `detailFor('hook')` reads `(o.run_after || []).length` ("Runs after").
- The Galaxy **originally had** a `hook → hook` run_after edge but it was **intentionally dropped per maintainer feedback** (`docs/superpowers/specs/2026-06-04-galaxy-3d-org-birdview-design.md`, line 15). The original intent was "run_after links a distinct style/color to read as a pipeline chain" (same spec, line 136). This feature reintroduces it, decluttered.
- Today (`graph.js`, ~lines 132–139): for every hook, for every `qUrl` in `hook.queues`, an edge `queue → hook` of kind `reference` is added — so all hooks fan off the queue, no ordering shown.
- `LINK_STYLE` (`graph.js`) currently has two kinds: `containment` and `reference`, each `{ color, colorDark, width }`. The scene picks `color`/`colorDark` by theme.
- `scene.js` renders links as a single `THREE.LineSegments` with a **per-vertex RGBA** buffer (stride 8 = 2 verts × RGBA) over a base **per-vertex RGB** buffer (stride 6). `applyTheme` currently sets *both* vertices of each edge to the *same* edge color (solid edges). Per-edge alpha is used to fade non-highlighted edges.
- Highlight today (`scene.js`): selecting/hovering a node `id` builds `highlight = {id} ∪ adjacency.get(id)` — **1-hop only** (`adjacency` is an undirected Map built in `buildAdjacency`). `applyHighlight` dims everything not in the set. `focusOn(id)` frames the node + its 1-hop neighbors.

## 3. Decisions

| Decision | Choice |
|---|---|
| Topology | "Chain off the head" (no synthetic node). `Queue → head`, then `pred → succ` run_after edges. |
| Queue-link rule | A hook links to its queue(s) **iff `run_after` is empty**. Hooks with `run_after` link only to their predecessor(s). |
| run_after edge | New link kind `runAfter`, distinct color, **directional via a source→target brightness gradient** (no 3D arrowheads). |
| Queue-click highlight | 1-hop neighbors **+ forward-transitive `run_after` closure** from the head hooks (whole chain), rest dims. |
| Hook-click highlight | The hook's **whole chain** (transitive both directions over `run_after`) + its 1-hop neighbors. |
| Other-node click | Unchanged (1-hop). Camera framing unchanged (1-hop) for all. |

## 4. Graph build (`graph.js`)

Replace the queue→hook reference loop (current lines ~132–139) with:

```js
// Reference: queue -> hook ONLY for hooks that start a pipeline (empty run_after).
// Hooks WITH run_after hang off their predecessor(s) via a `runAfter` edge instead,
// so the chain reads as a pipeline rather than fanning off the queue.
for (const hk of raw?.hooks || []) {
  const hkId = nodeId('hook', hk.id ?? idFromUrl(hk.url));
  const runsAfter = hk.run_after || [];
  if (runsAfter.length === 0) {
    for (const qUrl of hk.queues || []) {
      const qRef = idFromUrl(qUrl);
      if (qRef) addLink(nodeId('queue', qRef), hkId, 'reference');
    }
  } else {
    for (const predUrl of runsAfter) {
      const predRef = idFromUrl(predUrl);
      if (predRef) addLink(nodeId('hook', predRef), hkId, 'runAfter'); // predecessor -> this hook
    }
  }
}
```

- Edge direction: `addLink(pred, hk, 'runAfter')` → `source = predecessor`, `target = successor` (the hook that runs after). This is the flow direction and drives the gradient.
- DAGs handled naturally: every empty-`run_after` hook anchors to its queue(s); a hook with N predecessors gets N incoming `runAfter` edges; a shared predecessor fans out. `addLink` already drops edges to missing nodes, so cross-queue / missing predecessors are tolerated (edge omitted).
- The queue→engine and queue→hook(head) edges remain `reference`; org→workspace→queue remain `containment`. No node-type changes.

`LINK_STYLE` gains a third entry:
```js
runAfter: { color: '#6366f1', colorDark: '#818cf8', width: 1.2 }, // indigo pipeline; between containment(1.4) and reference(0.6)
```

## 5. run_after edge rendering (`scene.js`)

- `edgeColor(kind)` (theme-aware) handles `'runAfter'` like the others (returns the themed color).
- **Direction via gradient:** where edge colors are written into the base/rendered link buffers (the `applyTheme` loop and the initial fill), a `runAfter` edge sets its **source** vertex to a dimmed shade (≈45% lerp toward the dim/background color) and its **target** vertex to the full `runAfter` color; `containment`/`reference` keep both vertices equal (current behavior). The brightness flows toward the successor.
- Per-edge alpha / dim-on-highlight is unchanged and applies to `runAfter` edges too.
- **No arrowhead geometry** (3D cones/sprites) — out of scope; the gradient + layout convey direction.

## 6. Highlight (`scene.js`)

Build directed run_after adjacency in `buildAdjacency` alongside the existing undirected `adjacency`:
- `raFwd`: `Map<predId, Set<succId>>` and `raRev`: `Map<succId, Set<predId>>`, from links where `kind === 'runAfter'`.

`setHighlight(id)` gains a `transitive` flag — `setHighlight(id, transitive)`:
```
set = { id } ∪ adjacency(id)                 // 1-hop neighbors (workspace/engine/standalone/heads, or a hook's neighbors)
if (transitive):
  type = typeById.get(id)
  if (type === 'queue'):
      seeds = hooks currently in `set`        // the queue's chain heads + standalone hooks
      BFS forward over raFwd from seeds → add every reachable successor   // the full chain(s)
  else if (type === 'hook'):
      BFS over raFwd (forward) AND raRev (backward) from id → add the whole weakly-connected run_after chain
// non-transitive, or other types: just the 1-hop set
```
**Transitive runs on CLICK only** (the user said "clicked"): `onClick` calls `setHighlight(id, true)` (and pins); `onMove` (hover) calls `setHighlight(id, false)` — hover stays 1-hop as today. `applyHighlight` consumes the set unchanged (dims everything else).

The public `focus(id)` is unchanged — verified it only re-frames the camera (`focusOn`), it does NOT set the highlight, so no `transitive` plumbing is needed there. Standalone hooks contribute nothing to the BFS (no run_after edges), so they behave as today. `focusOn` framing is unchanged (1-hop); the dimming already makes far chain members pop.

## 7. Edge cases

- Multi-root chain (two empty-`run_after` hooks both feeding `C`): both roots → queue; `C` has two incoming `runAfter` edges; queue-click highlights both roots + `C`.
- Diamond (`C.run_after=[A,B]`, `D.run_after=[C]`): edges `A→C`, `B→C`, `C→D`; forward BFS from the queue's roots reaches all.
- Hook on multiple queues with empty run_after: anchors to each queue (unchanged multi-edge behavior).
- Hiding `hook` via the Legend: **confirmed** — `applyVisibility`/reflow filters links by endpoint-type visibility (`isVisible(typeById.get(endId(l.source))) && isVisible(...target...)`), kind-agnostic, so run_after edges (hook→hook) hide automatically when hooks are hidden. No extra work.
- A hook whose predecessor isn't in the graph (filtered/cross-queue): the `runAfter` edge is omitted; the hook may be unanchored (acceptable, matches the codebase's missing-ref tolerance).

## 8. Files & tests

**Modify**
- `src/galaxy/graph.js` — the build rule (§4) + `LINK_STYLE.runAfter`.
- `src/galaxy/scene.js` — `runAfter` in `edgeColor`; gradient in the link-color fill; `raFwd`/`raRev` in `buildAdjacency`; type-aware `computeHighlight`.

**Tests**
- `tests/galaxy-graph.test.js` — empty run_after → `queue→hook` reference edge; non-empty run_after → NO queue edge + `pred→hook` `runAfter` edge (correct source/target); DAG (two predecessors → two incoming edges; multi-root → both anchor); standalone hook unchanged; assert edge `kind`s.
- `tests/galaxy-scene.test.js` — clicking a queue with a chain highlights the full chain (the chain's tail mesh is NOT dimmed); clicking a mid-chain hook highlights the whole chain (head + tail not dimmed); a node with no chain still does 1-hop. (Uses the existing THREE mock + the dim-opacity assertions already in the file.)

## 9. Non-goals

- No synthetic "pipeline" node (option B chosen).
- No 3D arrowhead geometry (gradient conveys direction).
- No `connector` node / no other dropped edges revived.
- Camera framing stays 1-hop (not re-framed to the whole chain).
- No DetailCard changes (hooks already show "Runs after: N").
