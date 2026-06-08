// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// scene.js now drives three.js + d3-force-3d directly (no 3d-force-graph). We mock
// the three surface, the three addons, and d3-force-3d so the test runs under jsdom
// (no WebGL) while still exercising the real scene.js control flow: data -> meshes,
// raycaster hover/click picking, idle-spin toggling, and teardown.

// --- shared capture state + vector/color stubs ----------------------------
// vi.mock factories are hoisted above all top-level code, so anything they
// reference must live in a vi.hoisted() block (which runs first). We keep the
// capture buffers and the minimal three vector/color stubs there.
const { captured, Vector2, Vector3, Color, hits } = vi.hoisted(() => {
  class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y) { this.x = x; this.y = y; return this; }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    normalize() { return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    lerpVectors(a, b, t) {
      this.x = a.x + (b.x - a.x) * t;
      this.y = a.y + (b.y - a.y) * t;
      this.z = a.z + (b.z - a.z) * t;
      return this;
    }
  }
  class Color {
    constructor(r = 1, g = 1, b = 1) {
      if (typeof r === 'string' || arguments.length === 1) { this.r = 0; this.g = 0; this.b = 0; }
      else { this.r = r; this.g = g; this.b = b; }
    }
    copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    lerp(c, t) { this.r = this.r + (c.r - this.r) * t; this.g = this.g + (c.g - this.g) * t; this.b = this.b + (c.b - this.b) * t; return this; }
  }
  return {
    captured: {
      rendererInstances: [],
      controlsInstances: [],
      simInstances: [],
      groupInstances: [],
      sceneInstances: [],
      lightInstances: [],
      raycasterInstances: [],
    },
    Vector2, Vector3, Color,
    // Per-test-configurable raycaster hit list, mutated via hits.list.
    hits: { list: [] },
  };
});

// --- three core mock ------------------------------------------------------
vi.mock('three', () => {
  class Scene {
    constructor() { this.added = []; this.fog = null; captured.sceneInstances.push(this); }
    add(o) { this.added.push(o); }
  }
  class Group {
    constructor() { this.added = []; captured.groupInstances.push(this); }
    add(o) { this.added.push(o); }
    remove() {}
  }
  class PerspectiveCamera {
    constructor() { this.position = new Vector3(); this.aspect = 1; this.fov = 60; }
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    constructor() {
      this.domElement = document.createElement('canvas');
      this.domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
      this.disposed = false;
      captured.rendererInstances.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    render() { this.renders = (this.renders || 0) + 1; }
    dispose() { this.disposed = true; }
  }
  class Raycaster {
    constructor() { captured.raycasterInstances.push(this); }
    setFromCamera() {}
    intersectObjects() { return hits.list; }
  }
  class Sprite {
    constructor(material) { this.material = material; this.scale = new Vector3(); this.position = new Vector3(); }
  }
  class SpriteMaterial { constructor() { this.opacity = 1; } }
  class CanvasTexture {}
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material;
      this.position = new Vector3(); this.userData = {};
      this.visible = true;
      this.children = [];
    }
    add(o) { this.children.push(o); }
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); }
  }
  class SphereGeometry { dispose() {} }
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
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attr) { this.attributes[name] = attr; }
    dispose() {}
  }
  class LineSegments {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; }
  }
  class LineBasicMaterial { dispose() {} }
  return {
    Scene, Group, PerspectiveCamera, WebGLRenderer, Raycaster,
    Sprite, SpriteMaterial, CanvasTexture, Mesh, SphereGeometry,
    MeshBasicMaterial, MeshStandardMaterial, HemisphereLight, DirectionalLight, Fog,
    BufferAttribute, BufferGeometry, LineSegments, LineBasicMaterial,
    Vector2, Vector3, Color,
  };
});

// --- three addons mock ----------------------------------------------------
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    constructor() {
      this.autoRotate = false; this.autoRotateSpeed = 0; this.enableDamping = false;
      this.target = new Vector3();
      this._listeners = {};
      captured.controlsInstances.push(this);
    }
    update() {}
    dispose() {}
    addEventListener(type, fn) { this._listeners[type] = fn; }
  },
}));
// --- d3-force-3d mock -----------------------------------------------------
vi.mock('d3-force-3d', () => {
  function makeSim() {
    const sim = {
      force() { return sim; },
      alpha(v) { return v === undefined ? 0 : sim; }, // getter (no-arg) returns a settled alpha
      alphaDecay() { return sim; },
      alphaMin() { return 0.001; },
      tick() { return sim; },
      on() { return sim; },
      stop() { sim.stopped = true; return sim; },
      stopped: false,
    };
    captured.simInstances.push(sim);
    return sim;
  }
  const forceManyBody = () => { const f = { strength: () => f, distanceMax: () => f }; return f; };
  const forceLink = () => { const f = { id: () => f, distance: () => f, strength: () => f }; return f; };
  const forceCenter = () => ({});
  const forceX = () => { const f = { strength: () => f }; return f; };
  const forceY = () => { const f = { strength: () => f }; return f; };
  const forceZ = () => { const f = { strength: () => f }; return f; };
  return { forceSimulation: () => makeSim(), forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ };
});

import { createScene } from '../src/galaxy/scene.js';

const SAMPLE = {
  nodes: [
    { id: 'org:1', type: 'organization', rawId: '1', name: 'Org', color: '#ffb648', val: 14 },
    { id: 'queue:1', type: 'queue', rawId: '1', name: 'Q', color: '#29d4c5', val: 5 },
  ],
  links: [{ source: 'org:1', target: 'queue:1', kind: 'containment' }],
};

describe('createScene (three.js + d3-force-3d)', () => {
  let container, scene, rafSpy, cancelSpy, themeState, mqListeners;

  beforeEach(() => {
    for (const k of Object.keys(captured)) captured[k] = [];
    hits.list = [];
    themeState = { dark: false };
    mqListeners = [];
    window.matchMedia = (q) => ({
      matches: themeState.dark,
      media: q,
      addEventListener: (_t, fn) => mqListeners.push(fn),
      removeEventListener: (_t, fn) => { const i = mqListeners.indexOf(fn); if (i >= 0) mqListeners.splice(i, 1); },
    });
    // jsdom has no canvas 2D backend; labelSprite() (org/workspace labels) needs one,
    // incl. the rounded backing pill (beginPath/roundRect/fill).
    vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '', fillStyle: '', textBaseline: '',
      measureText: () => ({ width: 42 }),
      fillText: () => {},
      beginPath: () => {}, roundRect: () => {}, rect: () => {}, fill: () => {},
    });
    // Stub the render loop so animate() does not recurse during the test.
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(123);
    cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    scene = createScene(container);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.matchMedia;
    if (container.parentNode) container.parentNode.removeChild(container);
  });

  it('constructs without throwing and appends a canvas to the container', () => {
    expect(captured.rendererInstances).toHaveLength(1);
    expect(container.querySelector('canvas')).toBe(captured.rendererInstances[0].domElement);
  });

  it('setData creates a mesh per node and starts a d3 simulation', () => {
    scene.setData(SAMPLE);
    const group = captured.groupInstances[0];
    // 2 node meshes + 1 LineSegments for links.
    const meshLikeWithUserData = group.added.filter((o) => o && o.userData && o.userData.id);
    expect(meshLikeWithUserData).toHaveLength(2);
    expect(meshLikeWithUserData.map((m) => m.userData.id).sort()).toEqual(['org:1', 'queue:1']);
    expect(captured.simInstances).toHaveLength(1);
  });

  it('onHover reports the picked node id, or null when nothing is hit', () => {
    scene.setData(SAMPLE);
    const seen = [];
    scene.onHover((id) => seen.push(id));
    const canvas = captured.rendererInstances[0].domElement;

    hits.list = [{ object: { userData: { id: 'queue:1' } } }];
    canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 10, clientY: 10 }));

    hits.list = [];
    canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 10, clientY: 10 }));

    expect(seen).toEqual(['queue:1', null]);
  });

  it('onClick reports null on empty click and focuses (reports id) on a hit', () => {
    scene.setData(SAMPLE);
    const seen = [];
    scene.onClick((id) => seen.push(id));
    const canvas = captured.rendererInstances[0].domElement;

    // A real click = pointerdown + click at (nearly) the same spot.
    hits.list = [];
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 5, clientY: 5 }));

    hits.list = [{ object: { userData: { id: 'queue:1' } } }];
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 5, clientY: 5 }));

    expect(seen).toEqual([null, 'queue:1']);
  });

  it('ignores the click that ends a drag (pointer moved), preserving the selection', () => {
    scene.setData(SAMPLE);
    const seen = [];
    scene.onClick((id) => seen.push(id));
    const canvas = captured.rendererInstances[0].domElement;
    hits.list = [];
    // Press at one point, release far away (a rotate/pan drag) -> the trailing
    // click must be ignored so a pinned selection survives mouseup.
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 220, clientY: 180 }));
    expect(seen).toEqual([]);
  });

  it('focus(id) eases to the node and reports it; unknown id is a no-op', () => {
    scene.setData(SAMPLE);
    const seen = [];
    scene.onClick((id) => seen.push(id));
    scene.focus('queue:1');
    expect(seen).toEqual(['queue:1']);
    expect(() => scene.focus('nope:1')).not.toThrow();
    expect(seen).toEqual(['queue:1', null]);
  });

  it('setIdleSpin toggles the OrbitControls autoRotate flag', () => {
    const controls = captured.controlsInstances[0];
    scene.setIdleSpin(false);
    expect(controls.autoRotate).toBe(false);
    scene.setIdleSpin(true);
    expect(controls.autoRotate).toBe(true);
  });

  it('destroy cancels the frame, disposes the renderer, removes the canvas; twice is safe', () => {
    const renderer = captured.rendererInstances[0];
    expect(container.querySelector('canvas')).toBe(renderer.domElement);
    scene.destroy();
    expect(cancelSpy).toHaveBeenCalled();
    expect(renderer.disposed).toBe(true);
    expect(container.querySelector('canvas')).toBe(null);
    expect(() => scene.destroy()).not.toThrow();
  });

  it('after setData all meshes are visible by default', () => {
    scene.setData(SAMPLE);
    const group = captured.groupInstances[0];
    const nodeMeshes = group.added.filter((o) => o && o.userData && o.userData.id);
    expect(nodeMeshes).toHaveLength(2);
    for (const m of nodeMeshes) expect(m.visible).toBe(true);
  });

  it('setVisibleTypes({ queue: false }) hides the queue mesh but leaves org visible', () => {
    scene.setData(SAMPLE);
    scene.setVisibleTypes({ queue: false });
    const group = captured.groupInstances[0];
    const nodeMeshes = group.added.filter((o) => o && o.userData && o.userData.id);
    const orgMesh = nodeMeshes.find((m) => m.userData.id === 'org:1');
    const queueMesh = nodeMeshes.find((m) => m.userData.id === 'queue:1');
    expect(orgMesh.visible).toBe(true);
    expect(queueMesh.visible).toBe(false);
  });

  it('setVisibleTypes with all types visible restores all meshes to visible', () => {
    scene.setData(SAMPLE);
    scene.setVisibleTypes({ queue: false });
    scene.setVisibleTypes({ organization: true, workspace: true, queue: true, hook: true, engine: true });
    const group = captured.groupInstances[0];
    const nodeMeshes = group.added.filter((o) => o && o.userData && o.userData.id);
    for (const m of nodeMeshes) expect(m.visible).toBe(true);
  });

  it('setVisibleTypes re-heats the layout (reflow) by restarting the simulation', () => {
    scene.setData(SAMPLE);
    expect(captured.simInstances).toHaveLength(1); // initial layout
    scene.setVisibleTypes({ queue: false });
    expect(captured.simInstances).toHaveLength(2); // re-ran the sim on the visible subset
  });

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
    const linkSeg = group.added.find((o) => o && o.geometry && o.geometry.attributes && o.geometry.attributes.color);
    expect(orgMesh.children.length).toBe(1);          // exactly one label sprite
    const labelBefore = orgMesh.children[0];
    const edge0Before = linkSeg.geometry.attributes.color.array[0]; // containment R channel

    themeState.dark = true;
    mqListeners.forEach((fn) => fn()); // simulate the OS flipping to dark

    expect(sceneObj.fog.color).not.toBe(oldFogColor);              // fog recolored to the new bg
    expect(orgMesh.children.length).toBe(1);                        // label swapped in place, not duplicated
    expect(orgMesh.children[0]).not.toBe(labelBefore);             // label sprite is a NEW object
    expect(linkSeg.geometry.attributes.color.array[0]).not.toBe(edge0Before); // edges re-toned to colorDark
  });

  it('attaches a label to engine nodes (every node type is labeled)', () => {
    scene.setData({
      nodes: [{ id: 'engine:7', type: 'engine', rawId: '7', name: 'My Engine', color: '#9333ea', val: 5, detail: [] }],
      links: [],
    });
    const group = captured.groupInstances[0];
    const engineMesh = group.added.find((o) => o && o.userData && o.userData.id === 'engine:7');
    expect(engineMesh).toBeTruthy();
    expect(engineMesh.userData.label).toBeTruthy(); // label sprite attached
    expect(engineMesh.children.length).toBe(1);     // exactly one label sprite
  });

  it('dims non-selected nodes (sphere + label) when a node is selected', () => {
    // org -> queue -> hook: selecting org highlights org + its neighbour queue,
    // leaving hook (not adjacent to org) as the non-selected node that dims.
    scene.setData({
      nodes: [
        { id: 'org:1', type: 'organization', rawId: '1', name: 'Org', color: '#ffb648', val: 14 },
        { id: 'queue:1', type: 'queue', rawId: '1', name: 'Q', color: '#29d4c5', val: 5 },
        { id: 'hook:9', type: 'hook', rawId: '9', name: 'H', color: '#2563eb', val: 6 },
      ],
      links: [
        { source: 'org:1', target: 'queue:1', kind: 'containment' },
        { source: 'queue:1', target: 'hook:9', kind: 'reference' },
      ],
    });
    const group = captured.groupInstances[0];
    const meshOf = (id) => group.added.find((o) => o && o.userData && o.userData.id === id);
    const labelOf = (id) => meshOf(id).userData.label;
    const linkSeg = group.added.find((o) => o && o.geometry && o.geometry.attributes && o.geometry.attributes.color);
    const edgeAlpha = (i) => linkSeg.geometry.attributes.color.array[i * 8 + 3]; // vertex-0 alpha of link i (RGBA stride 8)
    const edgeR = (i) => linkSeg.geometry.attributes.color.array[i * 8];         // vertex-0 R of link i
    const relEdgeRBefore = edgeR(0); // org->queue R at rest (base colour)
    const canvas = captured.rendererInstances[0].domElement;

    hits.list = [{ object: { userData: { id: 'org:1' } } }];
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 5, clientY: 5 }));

    // Selected node + its neighbour stay fully opaque; the non-selected node fades.
    expect(meshOf('org:1').material.opacity).toBe(1);            // selected sphere: full
    expect(meshOf('hook:9').material.opacity).toBeLessThan(1);   // non-selected sphere: faded
    expect(labelOf('org:1').material.opacity).toBe(1);           // selected label: full
    expect(labelOf('queue:1').material.opacity).toBe(1);         // neighbour label: full
    expect(labelOf('hook:9').material.opacity).toBeLessThan(1);  // non-selected label: dimmed
    // Edges: link 0 (org->queue, within selection) stays opaque AND is recoloured
    // toward the highlight ink; link 1 (queue->hook, irrelevant) fades almost away
    // so the relevant edge clearly reads in a dense graph.
    expect(edgeAlpha(0)).toBeGreaterThan(edgeAlpha(1));
    expect(edgeAlpha(1)).toBeLessThan(0.3);
    expect(edgeR(0)).not.toBe(relEdgeRBefore); // relevant edge recoloured (highlighted), not just left as-is

    // Clearing the selection (click on empty space) restores everything to full.
    hits.list = [];
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new window.MouseEvent('click', { clientX: 5, clientY: 5 }));
    expect(meshOf('hook:9').material.opacity).toBe(1);
    expect(labelOf('hook:9').material.opacity).toBe(1);
    expect(edgeAlpha(1)).toBeGreaterThan(0.5); // irrelevant edge restored to baseline opacity
  });

  it('auto-rotates on load, pauses on interaction, and resumes after 15s idle', () => {
    vi.useFakeTimers();
    const c = captured.controlsInstances[0];
    expect(c.autoRotate).toBe(true);          // rotates on load
    c._listeners.start();                      // user grabs/zooms/clicks the galaxy
    expect(c.autoRotate).toBe(false);          // paused
    c._listeners.end();                         // interaction ended -> 15s idle timer armed
    vi.advanceTimersByTime(14000);
    expect(c.autoRotate).toBe(false);          // still paused before 15s
    vi.advanceTimersByTime(1500);
    expect(c.autoRotate).toBe(true);           // resumes after 15s of inactivity
    vi.useRealTimers();
  });

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

  it('clicking a hook also lights the queue it belongs to (the path back to the queue)', () => {
    scene.setData(CHAIN);
    clickNode('hook:C'); // tail of the chain, two hops from the queue via the head
    expect(meshById('queue:1').material.opacity).toBe(1); // queue lit -> the chain's home is clear
    expect(meshById('hook:A').material.opacity).toBe(1);  // head (the path back)
  });

  it('hovering a queue highlights the whole chain (same as a click)', () => {
    scene.setData(CHAIN);
    hoverNode('queue:1');
    expect(meshById('hook:A').material.opacity).toBe(1);          // head
    expect(meshById('hook:B').material.opacity).toBe(1);          // deep chain lit on hover too
    expect(meshById('hook:C').material.opacity).toBe(1);
    expect(meshById('hook:Z').material.opacity).toBeLessThan(1);  // unrelated still dims
  });

  it('hovering a hook highlights its whole chain + the queue (same as a click)', () => {
    scene.setData(CHAIN);
    hoverNode('hook:C');
    expect(meshById('hook:A').material.opacity).toBe(1);          // path back through the chain
    expect(meshById('queue:1').material.opacity).toBe(1);         // and the home queue
  });

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
});
