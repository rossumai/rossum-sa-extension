// Imperative 3D force-directed graph on three.js + d3-force-3d (no 3d-force-graph
// / ngraph — CSP-clean by construction). Hand-verified in the browser (no WebGL
// under jsdom); unit-tested via mocks.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ } from 'd3-force-3d';
import { LINK_STYLE } from './graph.js';

const LABEL_PX_PER_UNIT = 6;
const DEPTH = { organization: 0, workspace: 1, queue: 2, engine: 3, hook: 3 };

function labelSprite(text, color, bg) {
  const padX = 11, padY = 6, font = 28, radius = 8;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width;
  canvas.width = w + padX * 2; canvas.height = font + padY * 2;
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  // Subtle rounded backing so the label stays legible over bright orbs / busy
  // regions of the scene; theme-toned to match the page background.
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
    else ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.fill();
  }
  ctx.fillStyle = color || '#243044'; ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, canvas.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthWrite: false, transparent: true }));
  sprite.scale.set(canvas.width / LABEL_PX_PER_UNIT, canvas.height / LABEL_PX_PER_UNIT, 1);
  return sprite;
}
function rgbaColor(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s || '');
  if (!m) return new THREE.Color(0x8899cc);
  const [r, g, b] = m[1].split(',').map(Number);
  return new THREE.Color(r / 255, g / 255, b / 255);
}
const DIM_COLOR_LIGHT = new THREE.Color(0.58, 0.61, 0.69); // non-selected fade target on a light backdrop
const DIM_COLOR_DARK = new THREE.Color(0.18, 0.19, 0.24);  // ...and on a dark backdrop (so they recede into it, not brighten)
const DIM_AMT = 0.88; // 0 = no dim, 1 = fully faded; high = non-selected recede strongly but stay faintly visible
const NODE_DIM_OPACITY = 0.18; // non-selected spheres fade to this — opacity (not the colour lerp) is what actually makes a lit sphere recede
const LABEL_DIM_OPACITY = 0.15; // non-selected labels fade to this while a node is selected/hovered
const EDGE_ALPHA = 0.9;      // edge opacity with no selection (baseline)
const EDGE_ON_ALPHA = 1.0;   // relevant edges (within the selection's neighbourhood) — popped to full
const EDGE_DIM_ALPHA = 0.06; // irrelevant edges — faded almost to nothing so the relevant ones read in a dense graph
const EDGE_HI_LIGHT = new THREE.Color(0.16, 0.21, 0.33); // strong ink — relevant edges on a light backdrop
const EDGE_HI_DARK = new THREE.Color(0.86, 0.90, 1.0);   // ...and bright on a dark backdrop
const EDGE_HI_AMT = 0.7; // how far relevant edges shift toward the highlight ink (keeps a hint of kind tint)

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

export function createScene(container) {
  const w = () => container.clientWidth || 800;
  const h = () => container.clientHeight || 600;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, w() / h(), 0.1, 8000);
  camera.position.set(0, 80, 600);

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
  scene.fog = new THREE.Fog(new THREE.Color(cssVar('--bg-base', prefersDark() ? '#12121e' : '#f1f1f5')), 1, 4000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w(), h());
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 0.3; // very slow ambient spin (~200s per orbit at ~60fps)
  controls.autoRotate = true;     // rotate on load; paused on interaction, resumes after idle

  const group = new THREE.Group();
  scene.add(group);

  let nodes = [], links = [];
  const meshes = new Map();
  const adjacency = new Map();
  const highlight = new Set();
  const typeById = new Map(); // node id -> type, for visibility filtering
  const nodeById = new Map(); // node id -> node object, for link position resolution
  let visibleTypes = {};       // {} means "all visible"; a type set to false is hidden
  let dark = prefersDark();    // current OS color scheme; refreshed in setData + on a live flip
  let linkGeom = null, linkLines = null, baseLinkColors = null;
  let sim = null;
  let hoverCb = () => {}, clickCb = () => {};
  let raf = null, idleTimer = null;
  let focusTween = null;
  let pinnedId = null; // set by a click; freezes hover so the dim stays while rotating
  let downX = 0, downY = 0; // pointerdown position, to tell a real click from a rotate/pan drag
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const endId = (e) => (typeof e === 'object' && e ? e.id : e);
  const isVisible = (type) => visibleTypes[type] !== false;

  function buildAdjacency() {
    adjacency.clear();
    for (const l of links) {
      const s = endId(l.source), t = endId(l.target);
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s).add(t); adjacency.get(t).add(s);
    }
  }
  function disposeGraph() {
    if (sim) { sim.stop(); sim = null; }
    for (const m of meshes.values()) { group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    meshes.clear();
    typeById.clear();
    nodeById.clear();
    if (linkLines) { group.remove(linkLines); linkGeom.dispose(); linkLines.material.dispose(); linkLines = null; linkGeom = null; baseLinkColors = null; }
    pinnedId = null;
    highlight.clear();
  }

  function fitToView(ease) {
    const vis = nodes.filter((n) => isVisible(n.type));
    if (!vis.length) return;
    let cx = 0, cy = 0, cz = 0;
    for (const n of vis) { cx += n.x; cy += n.y; cz += n.z; }
    cx /= vis.length; cy /= vis.length; cz /= vis.length;
    let r = 1;
    for (const n of vis) {
      const dx = n.x - cx, dy = n.y - cy, dz = n.z - cz;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    r += 60; // padding
    const fov = (camera.fov * Math.PI) / 180;
    const dist = r / Math.tan(fov / 2);
    if (scene.fog) { scene.fog.near = Math.max(1, dist); scene.fog.far = dist + r * 1.5; }
    const center = new THREE.Vector3(cx, cy, cz);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const toPos = center.clone().add(dir.multiplyScalar(dist));
    if (ease) {
      focusTween = { fromPos: camera.position.clone(), toPos, fromTarget: controls.target.clone(), toTarget: center, t: 0 };
    } else {
      camera.position.copy(toPos);
      controls.target.copy(center);
    }
  }

  function edgeColor(kind) {
    const s = LINK_STYLE[kind];
    return rgbaColor(s && (dark ? (s.colorDark || s.color) : s.color));
  }
  function labelColorFor() { return dark ? '#e6e6f2' : '#243044'; }
  function labelBgFor() { return dark ? 'rgba(18,18,30,0.72)' : 'rgba(241,241,245,0.78)'; }
  // Build + position a label sprite for a mesh and store it on userData.
  // Single source of truth used by both initial render (setData) and re-tone (applyTheme).
  function attachLabel(mesh) {
    const s = labelSprite(mesh.userData.name, labelColorFor(), labelBgFor());
    s.position.set(0, mesh.userData.val + 4, 0);
    mesh.add(s);
    mesh.userData.label = s;
  }
  // Re-tone the theme-dependent scene colours (fog, edges, labels) in place — used
  // when the OS flips light/dark while the Galaxy is open, without disturbing the
  // layout or camera. (Panels/backdrop re-tone on their own via CSS media queries.)
  function applyTheme() {
    dark = prefersDark();
    if (scene.fog) scene.fog.color = new THREE.Color(cssVar('--bg-base', dark ? '#12121e' : '#f1f1f5'));
    if (linkGeom && baseLinkColors) {
      links.forEach((l, i) => {
        const c = edgeColor(l.kind);
        for (const o of [0, 3]) { baseLinkColors[i * 6 + o] = c.r; baseLinkColors[i * 6 + o + 1] = c.g; baseLinkColors[i * 6 + o + 2] = c.b; }
      });
    }
    for (const m of meshes.values()) {
      const old = m.userData.label;
      if (!old) continue;
      m.remove(old);
      if (old.material) {
        if (old.material.map && old.material.map.dispose) old.material.map.dispose();
        if (old.material.dispose) old.material.dispose();
      }
      attachLabel(m);
    }
    // Re-apply node/edge/label dim with the new theme onto the freshly rebuilt
    // labels — also pushes the recoloured baseLinkColors into the geometry,
    // honouring any active selection (e.g. a node pinned across a theme flip).
    applyHighlight();
  }

  function setData(data) {
    disposeGraph();
    nodes = data.nodes.map((n) => {
      const d = DEPTH[n.type] ?? 2;
      const a = (parseInt(n.rawId, 10) || 0) * 2.4;
      const r = d * 80;
      return { ...n, x: Math.cos(a) * r, y: (d - 1) * 60, z: Math.sin(a) * r };
    });
    links = data.links.map((l) => ({ ...l }));
    buildAdjacency();

    dark = prefersDark();
    for (const n of nodes) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(n.val, 24, 24),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(n.color), roughness: 0.9, metalness: 0, transparent: true }),
      );
      mesh.userData = { id: n.id, base: new THREE.Color(n.color), name: n.name, val: n.val, label: null };
      if (n.type === 'organization' || n.type === 'workspace' || n.type === 'queue' || n.type === 'hook') {
        attachLabel(mesh);
      }
      group.add(mesh); meshes.set(n.id, mesh);
      typeById.set(n.id, n.type);
      nodeById.set(n.id, n);
    }

    linkGeom = new THREE.BufferGeometry();
    linkGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(links.length * 6), 3));
    // Base per-vertex RGB (stride 6/link) is the source of truth for edge colour;
    // the rendered attribute is RGBA (stride 8/link) so each edge can fade on its
    // own (per-edge alpha) when a selection dims the irrelevant ones.
    baseLinkColors = new Float32Array(links.length * 6);
    const linkRGBA = new Float32Array(links.length * 8);
    links.forEach((l, i) => {
      const c = edgeColor(l.kind);
      for (const v of [0, 1]) {
        const rgb = i * 6 + v * 3, rgba = i * 8 + v * 4;
        baseLinkColors[rgb] = c.r; baseLinkColors[rgb + 1] = c.g; baseLinkColors[rgb + 2] = c.b;
        linkRGBA[rgba] = c.r; linkRGBA[rgba + 1] = c.g; linkRGBA[rgba + 2] = c.b; linkRGBA[rgba + 3] = EDGE_ALPHA;
      }
    });
    linkGeom.setAttribute('color', new THREE.BufferAttribute(linkRGBA, 4));
    linkLines = new THREE.LineSegments(linkGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
    group.add(linkLines);

    runSim(nodes, links); // pre-settles + fits synchronously
    applyVisibility();
  }

  // (Re)start the force simulation on a subset of nodes/links. Passing only the
  // VISIBLE subset (on a type toggle) makes the remaining nodes reflow to fill the
  // freed space. Fresh id-based link copies let forceLink resolve cleanly against
  // simNodes without mutating the render `links` (positions resolve via nodeById).
  function runSim(simNodes, simLinks) {
    if (sim) sim.stop();
    const fresh = simLinks.map((l) => ({ source: endId(l.source), target: endId(l.target) }));
    sim = forceSimulation(simNodes, 3)
      .force('charge', forceManyBody().strength(-140).distanceMax(400))
      .force('link', forceLink(fresh).id((d) => d.id).distance(45))
      .force('center', forceCenter())
      .force('x', forceX(0).strength(0.07))
      .force('y', forceY(0).strength(0.07))
      .force('z', forceZ(0).strength(0.07))
      .alpha(1).alphaDecay(0.025)
      .stop(); // settle synchronously below instead of animating over several seconds
    // Pre-settle the layout so the graph appears already laid out AND framed on the
    // first paint — no slow fly-in / delayed zoom (bounded loop as a safety cap).
    let guard = 0;
    while (sim.alpha() > sim.alphaMin() && guard++ < 500) sim.tick();
    fitToView(false);
  }

  function applyVisibility() {
    for (const [id, m] of meshes) m.visible = isVisible(typeById.get(id));
  }
  function applyHighlight() {
    const active = highlight.size > 0;
    const dimC = dark ? DIM_COLOR_DARK : DIM_COLOR_LIGHT;
    const hiC = dark ? EDGE_HI_DARK : EDGE_HI_LIGHT;
    for (const [id, m] of meshes) {
      const dimmed = active && !highlight.has(id);
      if (dimmed) m.material.color.copy(m.userData.base).lerp(dimC, DIM_AMT);
      else m.material.color.copy(m.userData.base);
      // Opacity is what actually makes a non-selected node recede — a lit sphere
      // whose albedo is merely greyed still reads as a bright ball. depthWrite is
      // turned off on the faded ones so they read as see-through ghosts, not occluders.
      m.material.opacity = dimmed ? NODE_DIM_OPACITY : 1;
      m.material.depthWrite = !dimmed;
      // Fade the labels of non-selected nodes so the selection's labels stand out.
      const lbl = m.userData.label;
      if (lbl && lbl.material) lbl.material.opacity = dimmed ? LABEL_DIM_OPACITY : 1;
    }
    if (linkGeom) {
      const col = linkGeom.attributes.color.array; // RGBA, stride 8/link; baseLinkColors is RGB, stride 6
      links.forEach((l, i) => {
        const relevant = active && highlight.has(endId(l.source)) && highlight.has(endId(l.target));
        // idle -> base colour; relevant -> shift toward the high-contrast ink and go
        // fully opaque (this is what makes them pop); irrelevant -> grey toward the
        // backdrop and fade out via alpha.
        let tint = null, amt = 0, alpha = EDGE_ALPHA;
        if (active) {
          if (relevant) { tint = hiC; amt = EDGE_HI_AMT; alpha = EDGE_ON_ALPHA; }
          else { tint = dimC; amt = DIM_AMT; alpha = EDGE_DIM_ALPHA; }
        }
        for (const v of [0, 1]) {
          const rgb = i * 6 + v * 3, rgba = i * 8 + v * 4;
          col[rgba]     = tint ? baseLinkColors[rgb]     * (1 - amt) + tint.r * amt : baseLinkColors[rgb];
          col[rgba + 1] = tint ? baseLinkColors[rgb + 1] * (1 - amt) + tint.g * amt : baseLinkColors[rgb + 1];
          col[rgba + 2] = tint ? baseLinkColors[rgb + 2] * (1 - amt) + tint.b * amt : baseLinkColors[rgb + 2];
          col[rgba + 3] = alpha;
        }
      });
      linkGeom.attributes.color.needsUpdate = true;
    }
  }
  function syncPositions() {
    for (const n of nodes) { const m = meshes.get(n.id); if (m) m.position.set(n.x, n.y, n.z); }
    if (linkGeom) {
      const p = linkGeom.attributes.position.array;
      links.forEach((l, i) => {
        const a = nodeById.get(endId(l.source));
        const b = nodeById.get(endId(l.target));
        if (!a || !b) { for (let k = 0; k < 6; k++) p[i * 6 + k] = 0; return; }
        const hidden = !isVisible(a.type) || !isVisible(b.type);
        p[i * 6] = a.x; p[i * 6 + 1] = a.y; p[i * 6 + 2] = a.z;
        if (hidden) { p[i * 6 + 3] = a.x; p[i * 6 + 4] = a.y; p[i * 6 + 5] = a.z; }
        else { p[i * 6 + 3] = b.x; p[i * 6 + 4] = b.y; p[i * 6 + 5] = b.z; }
      });
      linkGeom.attributes.position.needsUpdate = true;
    }
  }
  function stepFocus() {
    if (!focusTween) return;
    focusTween.t = Math.min(1, focusTween.t + 0.04);
    const e = 1 - Math.pow(1 - focusTween.t, 3);
    camera.position.lerpVectors(focusTween.fromPos, focusTween.toPos, e);
    controls.target.lerpVectors(focusTween.fromTarget, focusTween.toTarget, e);
    if (focusTween.t >= 1) focusTween = null;
  }
  function animate() {
    raf = requestAnimationFrame(animate);
    stepFocus();
    controls.update();
    syncPositions();
    renderer.render(scene, camera);
  }
  animate();

  function resize() {
    camera.aspect = w() / h(); camera.updateProjectionMatrix();
    renderer.setSize(w(), h());
  }
  window.addEventListener('resize', resize);

  function pick(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...meshes.values()].filter((m) => m.visible), false);
    return hits.length ? hits[0].object.userData.id : null;
  }
  function setHighlight(id) {
    highlight.clear();
    if (id) { highlight.add(id); for (const nb of adjacency.get(id) || []) highlight.add(nb); }
    applyHighlight();
  }
  function onMove(ev) {
    if (pinnedId) return; // a click pinned the selection; keep the dim fixed so the user can rotate
    const id = pick(ev);
    setHighlight(id);
    hoverCb(id);
  }
  function onDown(ev) { downX = ev.clientX; downY = ev.clientY; }
  function onClick(ev) {
    // Ignore the click that ends a rotate/pan drag (pointer moved beyond a small
    // threshold) so the pinned selection + dim + detail survive on mouseup.
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
    const id = pick(ev);
    if (id) {
      pinnedId = id;
      setHighlight(id);
      focusOn(id);
    } else {
      pinnedId = null;
      setHighlight(null);
      clickCb(null);
    }
  }
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('click', onClick);
  // Auto-rotate idle behavior: any active interaction (drag/zoom/click/touch fires
  // OrbitControls 'start') pauses the spin; it resumes 15s after the interaction ends.
  // Plain hover does NOT fire 'start', so it doesn't pause the rotation.
  controls.addEventListener('start', () => { controls.autoRotate = false; if (idleTimer) clearTimeout(idleTimer); });
  controls.addEventListener('end', () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { controls.autoRotate = true; }, 15000); });
  // Re-tone the 3D scene if the OS color scheme flips while the Galaxy is open.
  const themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onThemeChange = () => applyTheme();
  if (themeMq && themeMq.addEventListener) themeMq.addEventListener('change', onThemeChange);

  function focusOn(id) {
    const n = nodes.find((x) => x.id === id);
    if (!n) { clickCb(null); return; }
    // Frame the clicked node AND its direct neighbors so the whole local picture
    // stays visible, rather than zooming tightly onto the single node.
    const nbrs = adjacency.get(id) || new Set();
    let r = 60; // floor so a lone/low-degree node isn't zoomed in too hard
    for (const p of nodes) {
      if (p.id === id || nbrs.has(p.id)) {
        const dx = p.x - n.x, dy = p.y - n.y, dz = p.z - n.z;
        r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    r += 80; // padding so neighbors sit comfortably inside the frame
    const fov = (camera.fov * Math.PI) / 180;
    const dist = r / Math.tan(fov / 2);
    const center = new THREE.Vector3(n.x, n.y, n.z);
    const dir = camera.position.clone().sub(controls.target).normalize();
    focusTween = {
      fromPos: camera.position.clone(), toPos: center.clone().add(dir.multiplyScalar(dist)),
      fromTarget: controls.target.clone(), toTarget: center, t: 0,
    };
    clickCb(id);
  }

  return {
    setData,
    onHover(cb) { hoverCb = cb || (() => {}); },
    onClick(cb) { clickCb = cb || (() => {}); },
    focus(id) { focusOn(id); },
    setIdleSpin(on) { controls.autoRotate = !!on; },
    setVisibleTypes(vis) {
      visibleTypes = vis || {};
      applyVisibility();
      if (pinnedId && !isVisible(typeById.get(pinnedId))) {
        pinnedId = null;
        highlight.clear();
        applyHighlight();
        clickCb(null);
      }
      // Reflow: re-run the layout on only the visible nodes so the remaining ones
      // spread into the space freed by the hidden types.
      const visNodes = nodes.filter((n) => isVisible(n.type));
      const visLinks = links.filter((l) => isVisible(typeById.get(endId(l.source))) && isVisible(typeById.get(endId(l.target))));
      runSim(visNodes, visLinks);
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener('resize', resize);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      if (themeMq && themeMq.removeEventListener) themeMq.removeEventListener('change', onThemeChange);
      disposeGraph();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
    },
  };
}
