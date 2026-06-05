// Imperative 3D force-directed graph on three.js + d3-force-3d (no 3d-force-graph
// / ngraph — CSP-clean by construction). Hand-verified in the browser (no WebGL
// under jsdom); unit-tested via mocks.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ } from 'd3-force-3d';
import { LINK_STYLE } from './graph.js';

const LABEL_PX_PER_UNIT = 6;
const DEPTH = { organization: 0, workspace: 1, queue: 2, engine: 3, hook: 3 };

function labelSprite(text) {
  const pad = 8, font = 28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width;
  canvas.width = w + pad * 2; canvas.height = font + pad * 2;
  ctx.font = `${font}px -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = '#243044'; ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
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
const DIM_COLOR = new THREE.Color(0.58, 0.61, 0.69);
const DIM_AMT = 0.8; // 0 = no dim, 1 = fully grey; partial keeps nodes visible

export function createScene(container) {
  const w = () => container.clientWidth || 800;
  const h = () => container.clientHeight || 600;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, w() / h(), 0.1, 8000);
  camera.position.set(0, 80, 600);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w(), h());
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 0.3; // very slow ambient spin (~200s per orbit at ~60fps)
  controls.autoRotate = true;     // rotate on load; paused on interaction, resumes after idle

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const group = new THREE.Group();
  scene.add(group);

  let nodes = [], links = [];
  const meshes = new Map();
  const adjacency = new Map();
  const highlight = new Set();
  const typeById = new Map(); // node id -> type, for visibility filtering
  const nodeById = new Map(); // node id -> node object, for link position resolution
  let visibleTypes = {};       // {} means "all visible"; a type set to false is hidden
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

    linkGeom = new THREE.BufferGeometry();
    linkGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(links.length * 6), 3));
    baseLinkColors = new Float32Array(links.length * 6);
    links.forEach((l, i) => {
      const c = rgbaColor(LINK_STYLE[l.kind] && LINK_STYLE[l.kind].color);
      for (const o of [0, 3]) { baseLinkColors[i * 6 + o] = c.r; baseLinkColors[i * 6 + o + 1] = c.g; baseLinkColors[i * 6 + o + 2] = c.b; }
    });
    linkGeom.setAttribute('color', new THREE.BufferAttribute(baseLinkColors.slice(), 3));
    linkLines = new THREE.LineSegments(linkGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
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
    for (const [id, m] of meshes) {
      if (active && !highlight.has(id)) m.material.color.copy(m.userData.base).lerp(DIM_COLOR, DIM_AMT);
      else m.material.color.copy(m.userData.base);
    }
    if (linkGeom) {
      const col = linkGeom.attributes.color.array;
      links.forEach((l, i) => {
        const on = !active || (highlight.has(endId(l.source)) && highlight.has(endId(l.target)));
        for (const o of [0, 3]) {
          col[i * 6 + o]     = on ? baseLinkColors[i * 6 + o]     : baseLinkColors[i * 6 + o]     * (1 - DIM_AMT) + DIM_COLOR.r * DIM_AMT;
          col[i * 6 + o + 1] = on ? baseLinkColors[i * 6 + o + 1] : baseLinkColors[i * 6 + o + 1] * (1 - DIM_AMT) + DIM_COLOR.g * DIM_AMT;
          col[i * 6 + o + 2] = on ? baseLinkColors[i * 6 + o + 2] : baseLinkColors[i * 6 + o + 2] * (1 - DIM_AMT) + DIM_COLOR.b * DIM_AMT;
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
    composer.render();
  }
  animate();

  function resize() {
    camera.aspect = w() / h(); camera.updateProjectionMatrix();
    renderer.setSize(w(), h()); composer.setSize(w(), h());
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
      disposeGraph();
      controls.dispose();
      if (composer.dispose) composer.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
    },
  };
}
