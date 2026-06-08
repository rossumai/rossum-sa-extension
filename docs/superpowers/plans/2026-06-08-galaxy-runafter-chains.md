# Galaxy run_after pipeline chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show hook `run_after` ordering in the Galaxy 3D graph: a chain hangs off the queue head as a pipeline (`Queue → A → B → C`) instead of every hook fanning off the queue, and clicking the queue highlights the whole chain.

**Architecture:** `graph.js` changes the queue→hook edge rule (queue→hook only when `run_after` is empty; otherwise `predecessor → hook` edges of a new `runAfter` kind) and adds `LINK_STYLE.runAfter`. `scene.js` adds a directed run_after adjacency for a transitive (click-only) highlight, and renders run_after edges with a source→target brightness gradient (no 3D arrowheads).

**Tech Stack:** three.js + d3-force-3d (hand-rolled scene), Preact, Vitest (jsdom, THREE mocked).

**Spec:** `docs/superpowers/specs/2026-06-08-galaxy-runafter-chains-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** pure tests (`galaxy-graph.test.js`) = plain imports. Scene tests (`galaxy-scene.test.js`) = jsdom with THREE fully mocked; `scene.setData({nodes,links})`, then drive picking via `hits.list = [{object:{userData:{id}}}]` + dispatch `pointerdown`+`click` (or `pointermove` for hover) on `captured.rendererInstances[0].domElement`; read mesh dim via `group.added` mesh `material.opacity`, and edge colors via `linkSeg.geometry.attributes.color.array` (RGBA, stride 8/link).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/galaxy/graph.js` | modify | Build rule: queue→hook only for empty-`run_after` hooks; `predecessor→hook` `runAfter` edges otherwise. Add `LINK_STYLE.runAfter`. |
| `src/galaxy/scene.js` | modify | Directed `raFwd`/`raRev` adjacency; transitive (click-only) highlight; run_after edge gradient. |
| `tests/galaxy-graph.test.js` | modify | Update the flipped assertions; add runAfter/DAG cases + `LINK_STYLE.runAfter`. |
| `tests/galaxy-scene.test.js` | modify | Queue-click + hook-click chain highlight; hover stays 1-hop; run_after edge gradient. |

No new files; no node-type changes.

---

## Task 1: graph.js — build rule + run_after link style

**Files:**
- Modify: `src/galaxy/graph.js`
- Test: `tests/galaxy-graph.test.js`

- [ ] **Step 1: Update the failing/affected graph tests**

In `tests/galaxy-graph.test.js`, the fixture's hook 201 (`Export`) has `run_after: ['https://x/api/v1/hooks/200']` and `queues: [100, 101, 777]`. Under the new rule it gets NO queue edges and instead chains off hook 200. **Replace** the `'inverts hook.queues[] into queue -> hook reference links and skips unknown queues'` test (currently asserting queue→hook:201 references) with:

```js
  it('links queue -> hook only for empty-run_after hooks; chains run_after hooks off their predecessor', () => {
    // hook 200 (Validate) has empty run_after -> anchors to its queue.
    expect(has('queue:100', 'hook:200', 'reference')).toBe(true);
    // hook 201 (Export) has run_after:[200] -> NO queue edges, even though it lists queues 100/101.
    expect(has('queue:100', 'hook:201', 'reference')).toBe(false);
    expect(has('queue:101', 'hook:201', 'reference')).toBe(false);
    // instead it chains off its predecessor (200 -> 201), directional.
    expect(has('hook:200', 'hook:201', 'runAfter')).toBe(true);
    // unknown queue 777 yields no edge.
    expect(g.links.some((l) => l.source === 'queue:777')).toBe(false);
  });
```

Add a focused DAG/branching test and a LINK_STYLE check at the end of the `buildGraph` describe (before its closing `});`):

```js
  it('exposes a runAfter link style', () => {
    expect(LINK_STYLE.runAfter).toBeTruthy();
    expect(typeof LINK_STYLE.runAfter.color).toBe('string');
  });

  it('handles run_after DAGs: multiple roots anchor; a multi-predecessor hook gets one edge per predecessor', () => {
    const g2 = buildGraph({
      organization: null, workspaces: [], engines: [], connectors: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q', workspace: null }],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'R1', queues: ['https://x/api/v1/queues/1'], run_after: [] },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'R2', queues: ['https://x/api/v1/queues/1'], run_after: [] },
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'Merge', queues: ['https://x/api/v1/queues/1'],
          run_after: ['https://x/api/v1/hooks/10', 'https://x/api/v1/hooks/11'] },
      ],
    });
    const has2 = (s, t, k) => g2.links.some((l) => l.source === s && l.target === t && l.kind === k);
    expect(has2('queue:1', 'hook:10', 'reference')).toBe(true);   // root 1 anchors
    expect(has2('queue:1', 'hook:11', 'reference')).toBe(true);   // root 2 anchors
    expect(has2('queue:1', 'hook:12', 'reference')).toBe(false);  // merge has run_after -> no queue edge
    expect(has2('hook:10', 'hook:12', 'runAfter')).toBe(true);    // both predecessors
    expect(has2('hook:11', 'hook:12', 'runAfter')).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/galaxy-graph.test.js`
Expected: FAIL — the updated assertions expect `runAfter` edges / no queue edge for hook 201, but the current code still emits queue→hook:201 references and never emits `runAfter`.

- [ ] **Step 3: Add `LINK_STYLE.runAfter`**

In `src/galaxy/graph.js`, add to the `LINK_STYLE` object (after the `reference` entry):
```js
  // run_after pipeline edge (predecessor -> successor). The scene renders it
  // directional via a source->target brightness gradient.
  runAfter:    { color: '#6366f1', colorDark: '#818cf8', width: 1.2 },
```

- [ ] **Step 4: Change the queue→hook build rule**

In `src/galaxy/graph.js`, replace the current "Reference: queue -> hook (invert hook.queues[])" loop with:
```js
  // Reference: queue -> hook, but ONLY for hooks that start a pipeline (empty
  // run_after). A hook WITH run_after hangs off its predecessor(s) via a
  // `runAfter` edge instead of fanning off the queue, so the chain reads as a
  // pipeline. Branching DAGs work: every root (empty run_after) anchors to its
  // queue(s); a hook with N predecessors gets N incoming runAfter edges.
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
(The queue→engine `reference` loop and org/workspace/queue `containment` loops are unchanged.)

- [ ] **Step 5: Run to verify pass + whole suite**

Run: `npx vitest run tests/galaxy-graph.test.js` → PASS (updated + new cases).
Run: `npm test` → full suite PASS (no other test depends on the old hook-201 behavior).

---

## Task 2: scene.js — transitive (click-only) chain highlight

**Files:**
- Modify: `src/galaxy/scene.js`
- Test: `tests/galaxy-scene.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/galaxy-scene.test.js` (inside the top-level `describe`, after the existing tests). These reuse the file's `captured`/`hits` harness:

```js
  // Shared chain fixture: Q -> A (head) -> B -> C run_after chain, plus unrelated Z.
  const CHAIN = {
    nodes: [
      { id: 'queue:1', type: 'queue', rawId: '1', name: 'Q', color: '#16a34a', val: 5 },
      { id: 'hook:A', type: 'hook', rawId: '7', name: 'A', color: '#2563eb', val: 5 },
      { id: 'hook:B', type: 'hook', rawId: '8', name: 'B', color: '#2563eb', val: 5 },
      { id: 'hook:C', type: 'hook', rawId: '9', name: 'C', color: '#2563eb', val: 5 },
      { id: 'hook:Z', type: 'hook', rawId: '6', name: 'Z', color: '#2563eb', val: 5 },
    ],
    links: [
      { source: 'queue:1', target: 'hook:A', kind: 'reference' },
      { source: 'hook:A', target: 'hook:B', kind: 'runAfter' },
      { source: 'hook:B', target: 'hook:C', kind: 'runAfter' },
    ],
  };
  const meshById = (id) => captured.groupInstances[0].added.find((o) => o && o.userData && o.userData.id === id);
  const clickNode = (id) => {
    const canvas = captured.rendererInstances[0].domElement;
    hits.list = [{ object: { userData: { id } } }];
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 5, clientY: 5 }));
  };
  const hoverNode = (id) => {
    const canvas = captured.rendererInstances[0].domElement;
    hits.list = [{ object: { userData: { id } } }];
    canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 5, clientY: 5 }));
  };

  it('clicking a queue highlights the whole run_after chain (transitive, not just 1-hop)', () => {
    scene.setData(CHAIN);
    clickNode('queue:1');
    expect(meshById('hook:A').material.opacity).toBe(1); // head (1-hop)
    expect(meshById('hook:B').material.opacity).toBe(1); // 2 hops — lit via run_after
    expect(meshById('hook:C').material.opacity).toBe(1); // 3 hops — lit via run_after
    expect(meshById('hook:Z').material.opacity).toBeLessThan(1); // unrelated — dimmed
  });

  it('clicking a hook in a chain highlights the whole chain both directions', () => {
    scene.setData(CHAIN);
    clickNode('hook:B');
    expect(meshById('hook:A').material.opacity).toBe(1); // upstream
    expect(meshById('hook:C').material.opacity).toBe(1); // downstream
    expect(meshById('hook:Z').material.opacity).toBeLessThan(1);
  });

  it('hovering a queue stays 1-hop (transitive is click-only)', () => {
    scene.setData(CHAIN);
    hoverNode('queue:1');
    expect(meshById('hook:A').material.opacity).toBe(1);          // head is a 1-hop neighbor
    expect(meshById('hook:C').material.opacity).toBeLessThan(1);  // deep chain NOT lit on hover
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/galaxy-scene.test.js`
Expected: FAIL — today's 1-hop highlight leaves `hook:B`/`hook:C` dimmed on a queue click.

- [ ] **Step 3: Add the directed run_after adjacency**

In `src/galaxy/scene.js`, next to `const adjacency = new Map();` (~line 102), add:
```js
  const raFwd = new Map(); // predId -> Set(succId)  (run_after, forward)
  const raRev = new Map(); // succId -> Set(predId)  (run_after, backward)
```
Replace `buildAdjacency` with:
```js
  function buildAdjacency() {
    adjacency.clear(); raFwd.clear(); raRev.clear();
    for (const l of links) {
      const s = endId(l.source), t = endId(l.target);
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s).add(t); adjacency.get(t).add(s);
      if (l.kind === 'runAfter') {
        if (!raFwd.has(s)) raFwd.set(s, new Set());
        raFwd.get(s).add(t);
        if (!raRev.has(t)) raRev.set(t, new Set());
        raRev.get(t).add(s);
      }
    }
  }
```

- [ ] **Step 4: Make the highlight transitive on click**

In `src/galaxy/scene.js`, replace `setHighlight` (currently `function setHighlight(id) { highlight.clear(); if (id) { highlight.add(id); for (const nb of adjacency.get(id) || []) highlight.add(nb); } applyHighlight(); }`) with:
```js
  // Walk a set of directed maps from the seeds, adding every reachable node to `highlight`.
  function bfsInto(seeds, maps) {
    const stack = [...seeds];
    while (stack.length) {
      const cur = stack.pop();
      for (const m of maps) {
        for (const nx of m.get(cur) || []) {
          if (!highlight.has(nx)) { highlight.add(nx); stack.push(nx); }
        }
      }
    }
  }
  function setHighlight(id, transitive) {
    highlight.clear();
    if (id) {
      highlight.add(id);
      for (const nb of adjacency.get(id) || []) highlight.add(nb);
      if (transitive) {
        const type = typeById.get(id);
        if (type === 'queue') {
          // forward through run_after from the queue's hook neighbours (chain heads)
          const seeds = [...highlight].filter((x) => typeById.get(x) === 'hook');
          bfsInto(seeds, [raFwd]);
        } else if (type === 'hook') {
          bfsInto([id], [raFwd, raRev]); // the whole chain this hook belongs to
        }
      }
    }
    applyHighlight();
  }
```
Then in `onClick`, change the highlight call for a hit from `setHighlight(id);` to `setHighlight(id, true);` (the `else` branch's `setHighlight(null);` and `onMove`'s `setHighlight(id);` stay as-is — hover and clears remain 1-hop / empty).

- [ ] **Step 5: Run to verify pass + whole suite**

Run: `npx vitest run tests/galaxy-scene.test.js` → PASS (chain lights on click; hover stays 1-hop).
Run: `npm test` → full suite PASS (existing 1-hop tests still pass — hover and non-queue/hook clicks are unchanged; the existing `dims` test clicks `org:1`, whose type isn't queue/hook, so it stays 1-hop).
Run: `npm run build` → clean.

---

## Task 3: scene.js — directional gradient for run_after edges

**Files:**
- Modify: `src/galaxy/scene.js`
- Test: `tests/galaxy-scene.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/galaxy-scene.test.js`:
```js
  it('draws run_after edges with a source->target gradient (reference edges stay solid)', () => {
    scene.setData({
      nodes: [
        { id: 'queue:1', type: 'queue', rawId: '1', name: 'Q', color: '#16a34a', val: 5 },
        { id: 'hook:A', type: 'hook', rawId: '7', name: 'A', color: '#2563eb', val: 5 },
        { id: 'hook:B', type: 'hook', rawId: '8', name: 'B', color: '#2563eb', val: 5 },
      ],
      links: [
        { source: 'queue:1', target: 'hook:A', kind: 'reference' }, // link 0
        { source: 'hook:A', target: 'hook:B', kind: 'runAfter' },   // link 1
      ],
    });
    const linkSeg = captured.groupInstances[0].added.find((o) => o && o.geometry && o.geometry.attributes && o.geometry.attributes.color);
    const arr = linkSeg.geometry.attributes.color.array; // RGBA, stride 8/link; v0 at i*8, v1 at i*8+4
    // reference (link 0): both vertices equal -> solid
    expect(arr[0]).toBeCloseTo(arr[4]);
    expect(arr[1]).toBeCloseTo(arr[5]);
    expect(arr[2]).toBeCloseTo(arr[6]);
    // runAfter (link 1): source vertex differs from target vertex -> gradient present
    const diff = Math.abs(arr[8] - arr[12]) + Math.abs(arr[9] - arr[13]) + Math.abs(arr[10] - arr[14]);
    expect(diff).toBeGreaterThan(0.01);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/galaxy-scene.test.js -t 'gradient'`
Expected: FAIL — today both vertices of every edge get the same color, so the runAfter link's `diff` is ~0.

- [ ] **Step 3: Add `edgeVertexColor` and use it in both fill sites**

In `src/galaxy/scene.js`, add right after `edgeColor`:
```js
  // Per-vertex base colour. run_after edges get a source->target brightness
  // gradient (predecessor/source end faded toward the backdrop, successor/target
  // end full) so flow direction reads without 3D arrowheads. Other kinds: solid.
  function edgeVertexColor(kind, v) {
    const c = edgeColor(kind);
    if (kind !== 'runAfter' || v === 1) return c; // target (successor) end = full colour
    const dimC = dark ? DIM_COLOR_DARK : DIM_COLOR_LIGHT;
    const amt = 0.55; // how far the source (predecessor) end fades toward the backdrop
    return { r: c.r * (1 - amt) + dimC.r * amt, g: c.g * (1 - amt) + dimC.g * amt, b: c.b * (1 - amt) + dimC.b * amt };
  }
```
In the **initial link fill** (the `links.forEach((l, i) => { const c = edgeColor(l.kind); for (const v of [0, 1]) { ... } })` block), move the color lookup inside the vertex loop so each vertex uses `edgeVertexColor`:
```js
    links.forEach((l, i) => {
      for (const v of [0, 1]) {
        const c = edgeVertexColor(l.kind, v);
        const rgb = i * 6 + v * 3, rgba = i * 8 + v * 4;
        baseLinkColors[rgb] = c.r; baseLinkColors[rgb + 1] = c.g; baseLinkColors[rgb + 2] = c.b;
        linkRGBA[rgba] = c.r; linkRGBA[rgba + 1] = c.g; linkRGBA[rgba + 2] = c.b; linkRGBA[rgba + 3] = EDGE_ALPHA;
      }
    });
```
In **`applyTheme`**, replace its base-color loop (`links.forEach((l, i) => { const c = edgeColor(l.kind); for (const o of [0, 3]) { ... } })`) with the per-vertex form:
```js
      links.forEach((l, i) => {
        for (const v of [0, 1]) {
          const c = edgeVertexColor(l.kind, v);
          const rgb = i * 6 + v * 3;
          baseLinkColors[rgb] = c.r; baseLinkColors[rgb + 1] = c.g; baseLinkColors[rgb + 2] = c.b;
        }
      });
```
(`applyHighlight` already reads `baseLinkColors` per vertex, so the gradient survives highlighting/dimming unchanged.)

- [ ] **Step 4: Run to verify pass + whole suite + build**

Run: `npx vitest run tests/galaxy-scene.test.js` → PASS (gradient present for runAfter, solid for reference; the re-tone test still passes — it asserts the edge is recolored on a theme flip, which still holds).
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 4: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture the `Test Files N passed` line). Run: `npm run build` → clean.

- [ ] **Step 2: CSP sanity**

Run: `grep -c 'new Function\|eval(' dist/console/console.js` → expect `0` (no dynamic codegen; the change is pure graph/scene logic).

- [ ] **Step 3: Manual QA in Chrome (needs a live token + an org with run_after hooks)**

Load `dist/`, open the Console → Galaxy on an org where some hooks have `run_after`. Verify:
- A queue with a hook chain shows `Queue → A → B → C` (the chained hooks hang off their predecessors, not the queue); standalone hooks still sit directly on the queue.
- run_after edges are visually distinct (indigo) with a direction-implying gradient (dim at the predecessor end, bright at the successor).
- Clicking the queue dims everything except the queue + the whole chain (to its end). Clicking a mid-chain hook lights the whole chain both ways. Hovering (not clicking) stays 1-hop.
- Toggling `hook` off in the Legend hides the chain edges too. Light + dark mode both read well.

- [ ] **Step 4: Report**

Summarize suite + build results and the manual-QA outcome (the org used, that a chain rendered as a pipeline, and the click-highlight worked). Don't claim done without the manual check (jsdom has no real 3D/layout).

---

## Self-Review (completed during planning)

- **Spec coverage:** build rule (queue→hook iff empty run_after; pred→hook runAfter) — Task 1 ✓; `LINK_STYLE.runAfter` — Task 1 ✓; directional gradient (no arrowheads) — Task 3 ✓; transitive queue-click highlight — Task 2 ✓; hook-click whole-chain — Task 2 ✓; hover stays 1-hop (click-only) — Task 2 ✓; DAG/multi-root — Task 1 test ✓; visibility (endpoint-based, free) — no code needed (confirmed in spec) ✓; `focus()` untouched — not modified ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type/name consistency:** `runAfter` is the link `kind` everywhere (graph.js `addLink`, `LINK_STYLE.runAfter`, scene `buildAdjacency` check, `edgeVertexColor`, tests); `raFwd`/`raRev` defined in Task 2 and used only in `setHighlight`; `setHighlight(id, transitive)` — `onClick` passes `true`, `onMove`/clears omit it (falsy); `edgeVertexColor(kind, v)` matches both fill sites; `bfsInto(seeds, maps)` consistent. The graph test fixture's existing `run_after` on hook 201 is handled by updating (not appending to) the affected assertion.
