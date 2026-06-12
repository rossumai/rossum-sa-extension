// Pure transform: REST resource bundle -> { nodes, links } for the 3D scene (three.js + d3-force-3d).
// No DOM, no three.js. Tolerates missing/renamed refs by omitting edges.

// Rainbow keyed to hierarchy depth: top (organization) -> bottom (engine).
export const NODE_STYLE = {
  organization: { color: '#e5484d', val: 11 }, // red — top of the hierarchy
  workspace:    { color: '#ea7317', val: 7 },  // orange
  queue:        { color: '#16a34a', val: 4 },  // green
  hook:         { color: '#2563eb', val: 5 },  // blue
  engine:       { color: '#9333ea', val: 5 },  // violet — leaf
};
export const LINK_STYLE = {
  // Soft neutral cool greys; containment slightly stronger than reference.
  // Two-theme contract: `color` is the light-theme edge colour, `colorDark` the
  // dark-theme one. The scene selects between them based on the active theme.
  containment: { color: 'rgba(120,128,150,0.85)', colorDark: 'rgba(128,138,176,0.85)', width: 1.4 },
  reference:   { color: 'rgba(150,158,178,0.55)', colorDark: 'rgba(96,108,150,0.6)',   width: 0.6 },
  // run_after pipeline edge (predecessor -> successor). The scene renders it
  // directional via a source->target brightness gradient.
  runAfter:    { color: '#6366f1', colorDark: '#818cf8', width: 1.2 },
};

// Trailing numeric id out of a Rossum hyperlinked URL ('.../queues/123' -> '123').
export function idFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

function nodeId(type, rawId) {
  return `${type}:${rawId}`;
}

function pairs(...rows) {
  return rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)]);
}
function detailFor(type, o) {
  if (type === 'organization') return pairs(
    ['Workspaces', (o.workspaces || []).length],
    ['Users', (o.users || []).length],
    ['Trial', o.is_trial ? 'Yes' : 'No'],
    ['Sandbox', o.sandbox ? 'Yes' : 'No'],
  );
  if (type === 'workspace') return pairs(
    ['Queues', (o.queues || []).length],
    ['Autopilot', o.autopilot ? 'On' : 'Off'],
  );
  if (type === 'queue') return pairs(
    ['Status', o.status],
    ['Automation', o.automation_enabled ? (o.automation_level || 'on') : 'off'],
    ['Score threshold', o.default_score_threshold],
    ['Hooks', (o.hooks || []).length],
    ['Schema', idFromUrl(o.schema)],
    ['Inbox', idFromUrl(o.inbox)],
  );
  if (type === 'hook') return pairs(
    ['Type', o.type],
    ['Active', o.active ? 'Yes' : 'No'],
    ['Events', (o.events || []).join(', ')],
    ['Queues', (o.queues || []).length],
    ['Runs after', (o.run_after || []).length],
    ['Description', o.description],
  );
  if (type === 'engine') return pairs(
    ['Type', o.type],
    ['Learning', o.learning_enabled ? 'On' : 'Off'],
    ['Training queues', (o.training_queues || []).length],
    ['Description', o.description],
  );
  return [];
}

export function buildGraph(raw) {
  const nodes = [];
  const links = [];
  const present = new Set(); // node ids that exist, so we never link to a missing node

  function addNode(type, rawId, name, detail) {
    if (rawId == null) return null;
    const id = nodeId(type, String(rawId));
    if (present.has(id)) return id;
    present.add(id);
    const style = NODE_STYLE[type] || { color: '#ffffff', val: 5 };
    nodes.push({ id, type, rawId: String(rawId), name: name || `${type} ${rawId}`, color: style.color, val: style.val, detail: detail || [] });
    return id;
  }
  function addLink(sourceId, targetId, kind) {
    if (!sourceId || !targetId) return;
    if (!present.has(sourceId) || !present.has(targetId)) return;
    links.push({ source: sourceId, target: targetId, kind });
  }

  // Index every hook (including disabled ones) by id, for run_after bridging.
  const hookById = new Map();
  for (const hk of raw?.hooks || []) {
    const k = hk.id ?? idFromUrl(hk.url);
    if (k != null) hookById.set(String(k), hk);
  }
  const isDisabledHook = (id) => hookById.get(String(id))?.active === false;
  // Resolve a hook's run_after predecessor ids, bridging THROUGH disabled hooks:
  // a disabled predecessor is replaced by its own resolved predecessors,
  // transitively. Enabled/unknown ids pass through. `visited` guards cycles.
  function effectivePredIds(predIds, visited) {
    const out = [];
    for (const pid of predIds) {
      const id = String(pid);
      if (isDisabledHook(id)) {
        if (visited.has(id)) continue;
        visited.add(id);
        const dhPreds = (hookById.get(id).run_after || []).map(idFromUrl).filter((x) => x != null);
        for (const e of effectivePredIds(dhPreds, visited)) out.push(e);
      } else {
        out.push(id);
      }
    }
    return out;
  }

  // Organization (single root).
  const orgId = raw?.organization ? addNode('organization', raw.organization.id ?? idFromUrl(raw.organization.url), raw.organization.name, detailFor('organization', raw.organization)) : null;

  // Workspaces.
  for (const ws of raw?.workspaces || []) {
    addNode('workspace', ws.id ?? idFromUrl(ws.url), ws.name, detailFor('workspace', ws));
  }
  // Engines (from the fetched engines list — named). addNode dedupes, so an engine
  // already added here is NOT overwritten by the queue-fallback below.
  for (const e of raw?.engines || []) {
    addNode('engine', e.id ?? idFromUrl(e.url), e.name, detailFor('engine', e));
  }
  // Queues (+ engines derived from queue refs as a fallback for any engine not in the list).
  for (const q of raw?.queues || []) {
    addNode('queue', q.id ?? idFromUrl(q.url), q.name, detailFor('queue', q));
    // Modern Rossum queues carry a unified `engine` field; older ones used
    // dedicated_engine / generic_engine (verified live: ferguson-dev uses `engine`).
    const engUrl = q.engine || q.dedicated_engine || q.generic_engine;
    const engId = idFromUrl(engUrl);
    if (engId) addNode('engine', engId, `Engine ${engId}`);
  }
  // Hooks. Disabled hooks (active === false) are not rendered; they stay in
  // `hookById` only so run_after chains can bridge through them (below).
  for (const hk of raw?.hooks || []) {
    if (hk.active === false) continue;
    addNode('hook', hk.id ?? idFromUrl(hk.url), hk.name, detailFor('hook', hk));
  }

  // Containment: org -> workspace.
  for (const ws of raw?.workspaces || []) {
    const wsId = nodeId('workspace', ws.id ?? idFromUrl(ws.url));
    const parent = orgId || (ws.organization ? nodeId('organization', idFromUrl(ws.organization)) : null);
    addLink(parent, wsId, 'containment');
  }
  // Containment: workspace -> queue. Reference: queue -> engine.
  for (const q of raw?.queues || []) {
    const qId = nodeId('queue', q.id ?? idFromUrl(q.url));
    const wsRef = idFromUrl(q.workspace);
    if (wsRef) addLink(nodeId('workspace', wsRef), qId, 'containment');
    const engRef = idFromUrl(q.engine || q.dedicated_engine || q.generic_engine);
    if (engRef) addLink(qId, nodeId('engine', engRef), 'reference');
  }
  // Reference: queue -> hook, but ONLY for hooks that start a pipeline (empty
  // run_after). A hook WITH run_after hangs off its predecessor(s) via a
  // `runAfter` edge instead of fanning off the queue, so the chain reads as a
  // pipeline. Branching DAGs work: every root (empty run_after) anchors to its
  // queue(s); a hook with N predecessors gets N incoming runAfter edges.
  for (const hk of raw?.hooks || []) {
    if (hk.active === false) continue; // disabled hooks render nothing
    const hkId = nodeId('hook', hk.id ?? idFromUrl(hk.url));
    const anchorToQueues = () => {
      for (const qUrl of hk.queues || []) {
        const qRef = idFromUrl(qUrl);
        if (qRef) addLink(nodeId('queue', qRef), hkId, 'reference');
      }
    };
    const directPredIds = (hk.run_after || []).map(idFromUrl).filter((x) => x != null);
    if (directPredIds.length === 0) {
      anchorToQueues(); // pipeline root
      continue;
    }
    // Bridge through any disabled predecessors, then link from the survivors.
    const bridgedThroughDisabled = directPredIds.some(isDisabledHook);
    let drewEdge = false;
    for (const predId of effectivePredIds(directPredIds, new Set())) {
      const predNode = nodeId('hook', predId);
      if (present.has(predNode)) { addLink(predNode, hkId, 'runAfter'); drewEdge = true; } // predecessor -> this hook
    }
    // If bridging removed every predecessor, this hook is effectively a root —
    // anchor it to its queue(s) so it does not float. Scoped to the bridge case,
    // so a merely-missing predecessor keeps its existing (floating) behavior.
    if (!drewEdge && bridgedThroughDisabled) anchorToQueues();
  }

  return { nodes, links };
}
