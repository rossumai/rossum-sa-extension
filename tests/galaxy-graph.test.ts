import { describe, it, expect } from 'vitest';
import { buildGraph, idFromUrl, NODE_STYLE, LINK_STYLE } from '../src/galaxy/graph.js';

describe('idFromUrl', () => {
  it('parses the trailing numeric id', () => {
    expect(idFromUrl('https://x/api/v1/queues/123')).toBe('123');
    expect(idFromUrl('https://x/api/v1/queues/123/')).toBe('123');
    expect(idFromUrl('https://x/api/v1/queues/123?foo=1')).toBe('123');
  });
  it('returns null for non-strings / no id', () => {
    expect(idFromUrl(null)).toBe(null);
    expect(idFromUrl('https://x/api/v1/queues/')).toBe(null);
    expect(idFromUrl(42)).toBe(null);
  });
});

const RAW = {
  organization: {
    id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme',
    workspaces: ['https://x/api/v1/workspaces/10'],
    users: ['https://x/api/v1/users/1', 'https://x/api/v1/users/2'],
    is_trial: false, sandbox: false,
  },
  workspaces: [
    {
      id: 10, url: 'https://x/api/v1/workspaces/10', name: 'WS A',
      organization: 'https://x/api/v1/organizations/1',
      queues: ['https://x/api/v1/queues/100'],
      autopilot: true,
    },
  ],
  queues: [
    {
      id: 100, url: 'https://x/api/v1/queues/100', name: 'Invoices',
      workspace: 'https://x/api/v1/workspaces/10',
      connector: 'https://x/api/v1/connectors/5',
      dedicated_engine: 'https://x/api/v1/engines/7',
      status: 'running',
      automation_enabled: true, automation_level: 'always',
      default_score_threshold: 0.8,
      hooks: ['https://x/api/v1/hooks/200', 'https://x/api/v1/hooks/201'],
      schema: 'https://x/api/v1/schemas/42',
      inbox: 'https://x/api/v1/inboxes/99',
    },
    {
      id: 101, url: 'https://x/api/v1/queues/101', name: 'Receipts',
      workspace: 'https://x/api/v1/workspaces/10',
      connector: null,
      generic_engine: 'https://x/api/v1/engines/8',
      status: 'importing',
      automation_enabled: false,
    },
    {
      id: 102, url: 'https://x/api/v1/queues/102', name: 'Orphan',
      workspace: 'https://x/api/v1/workspaces/999',
    },
  ],
  hooks: [
    {
      id: 200, url: 'https://x/api/v1/hooks/200', name: 'Validate',
      queues: ['https://x/api/v1/queues/100'], run_after: [],
      type: 'webhook', active: true, events: ['annotation.created'],
    },
    {
      id: 201, url: 'https://x/api/v1/hooks/201', name: 'Export',
      queues: ['https://x/api/v1/queues/100', 'https://x/api/v1/queues/101', 'https://x/api/v1/queues/777'],
      run_after: ['https://x/api/v1/hooks/200'],
      type: 'function', active: true, events: ['annotation.exported'],
    },
  ],
  engines: [
    { id: 7, url: 'https://x/api/v1/engines/7', name: 'My Engine', type: 'extractor', learning_enabled: true, training_queues: [] },
  ],
  connectors: [{ id: 5, url: 'https://x/api/v1/connectors/5', name: 'NetSuite' }],
};

describe('buildGraph', () => {
  const g = buildGraph(RAW);
  const ids = g.nodes.map((n) => n.id).sort();
  const has = (s: any, t: any, kind: any) => g.links.some((l) => l.source === s && l.target === t && l.kind === kind);

  it('creates one node per resource plus engines derived from queue refs', () => {
    expect(ids).toEqual([
      'engine:7', 'engine:8',
      'hook:200', 'hook:201',
      'organization:1',
      'queue:100', 'queue:101', 'queue:102',
      'workspace:10',
    ]);
  });
  it('tags nodes with type, name, rawId and a color', () => {
    const org = g.nodes.find((n) => n.id === 'organization:1')!;
    expect(org).toMatchObject({ type: 'organization', name: 'Acme', rawId: '1' });
    expect(typeof org.color).toBe('string');
    expect(org.val).toBeGreaterThan(0);
  });
  it('links org -> workspace -> queue (containment)', () => {
    expect(has('organization:1', 'workspace:10', 'containment')).toBe(true);
    expect(has('workspace:10', 'queue:100', 'containment')).toBe(true);
    expect(has('workspace:10', 'queue:101', 'containment')).toBe(true);
  });
  it('omits a containment link when the referenced workspace is missing', () => {
    expect(g.links.some((l) => l.target === 'queue:102' && l.kind === 'containment')).toBe(false);
  });
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
  it('links queue -> derived engine', () => {
    expect(has('queue:100', 'engine:7', 'reference')).toBe(true);
    expect(has('queue:101', 'engine:8', 'reference')).toBe(true);
  });
  it('never throws on an empty bundle', () => {
    expect(buildGraph({ organization: null, workspaces: [], queues: [], hooks: [], engines: [], connectors: [] }))
      .toEqual({ nodes: [], links: [] });
  });

  // detail assertions
  it('org node detail contains Workspaces count', () => {
    const org = g.nodes.find((n) => n.id === 'organization:1');
    expect(org!.detail).toContainEqual(['Workspaces', '1']);
  });
  it('org node detail contains Users count', () => {
    const org = g.nodes.find((n) => n.id === 'organization:1');
    expect(org!.detail).toContainEqual(['Users', '2']);
  });
  it('queue node detail includes Status and Hooks rows', () => {
    const q = g.nodes.find((n) => n.id === 'queue:100')!;
    expect(q.detail).toContainEqual(['Status', 'running']);
    expect(q.detail).toContainEqual(['Hooks', '2']);
  });
  it('engine node created from engines list has the real name and Type detail', () => {
    const eng = g.nodes.find((n) => n.id === 'engine:7')!;
    expect(eng.name).toBe('My Engine');
    expect(eng.detail).toContainEqual(['Type', 'extractor']);
  });
  it('engine node not in engines list gets a fallback name (engine:8)', () => {
    const eng = g.nodes.find((n) => n.id === 'engine:8');
    expect(eng!.name).toBe('Engine 8');
  });
});

describe('buildGraph — additional coverage', () => {
  it('de-dupes an engine referenced by two queues into a single node, with both links', () => {
    const g = buildGraph({
      organization: null, workspaces: [], connectors: [], hooks: [],
      queues: [
        { id: 100, url: 'https://x/api/v1/queues/100', name: 'A', dedicated_engine: 'https://x/api/v1/engines/7' },
        { id: 101, url: 'https://x/api/v1/queues/101', name: 'B', dedicated_engine: 'https://x/api/v1/engines/7' },
      ],
    });
    expect(g.nodes.filter((n) => n.id === 'engine:7')).toHaveLength(1);
    expect(g.links.filter((l) => l.target === 'engine:7' && l.kind === 'reference')).toHaveLength(2);
  });
  it('falls back to a "<type> <id>" name for a nameless resource', () => {
    const g = buildGraph({
      organization: { id: 1, url: 'https://x/api/v1/organizations/1' },
      workspaces: [], queues: [], hooks: [], connectors: [],
    });
    expect(g.nodes.find((n) => n.id === 'organization:1')!.name).toBe('organization 1');
  });
  it('does not throw on null/undefined input', () => {
    expect(buildGraph(null)).toEqual({ nodes: [], links: [] });
    expect(buildGraph(undefined)).toEqual({ nodes: [], links: [] });
  });
  it('exposes a style for every node type and link kind', () => {
    for (const t of ['organization', 'workspace', 'queue', 'hook', 'engine']) {
      expect(typeof (NODE_STYLE as any)[t].color).toBe('string');
      expect((NODE_STYLE as any)[t].val).toBeGreaterThan(0);
    }
    for (const k of ['containment', 'reference']) {
      expect(typeof (LINK_STYLE as any)[k].color).toBe('string');
      expect(typeof (LINK_STYLE as any)[k].colorDark).toBe('string');
      expect((LINK_STYLE as any)[k].width).toBeGreaterThan(0);
    }
  });
  it('chains a run_after hook off its predecessor as a runAfter edge (camelCase kind, never hyphenated)', () => {
    const g = buildGraph({
      organization: null, workspaces: [], queues: [],
      hooks: [
        { id: 200, url: 'https://x/api/v1/hooks/200', name: 'A', queues: [], run_after: [] },
        { id: 201, url: 'https://x/api/v1/hooks/201', name: 'B', queues: [], run_after: ['https://x/api/v1/hooks/200'] },
      ],
    });
    expect(g.links.some((l) => l.source === 'hook:200' && l.target === 'hook:201' && l.kind === 'runAfter')).toBe(true);
    expect(g.links.some((l) => (l.kind as string) === 'run_after')).toBe(false); // the link kind is camelCase `runAfter`
  });
  it('derives an engine node + link from the unified queue.engine field', () => {
    const g = buildGraph({
      organization: null, workspaces: [], hooks: [],
      queues: [{ id: 100, url: 'https://x/api/v1/queues/100', name: 'Q', engine: 'https://x/api/v1/engines/381' }],
    });
    expect(g.nodes.some((n) => n.id === 'engine:381')).toBe(true);
    expect(g.links.some((l) => l.source === 'queue:100' && l.target === 'engine:381' && l.kind === 'reference')).toBe(true);
  });
  it('named engine from engines list is not overwritten by queue fallback addNode', () => {
    const g = buildGraph({
      organization: null, workspaces: [], hooks: [],
      engines: [{ id: 7, url: 'https://x/api/v1/engines/7', name: 'Named Engine', type: 'extractor', learning_enabled: false, training_queues: [] }],
      queues: [{ id: 100, url: 'https://x/api/v1/queues/100', name: 'Q', dedicated_engine: 'https://x/api/v1/engines/7' }],
    });
    expect(g.nodes.filter((n) => n.id === 'engine:7')).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === 'engine:7')!.name).toBe('Named Engine');
  });

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
    const has2 = (s: any, t: any, k: any) => g2.links.some((l) => l.source === s && l.target === t && l.kind === k);
    expect(has2('queue:1', 'hook:10', 'reference')).toBe(true);   // root 1 anchors
    expect(has2('queue:1', 'hook:11', 'reference')).toBe(true);   // root 2 anchors
    expect(has2('queue:1', 'hook:12', 'reference')).toBe(false);  // merge has run_after -> no queue edge
    expect(has2('hook:10', 'hook:12', 'runAfter')).toBe(true);    // both predecessors
    expect(has2('hook:11', 'hook:12', 'runAfter')).toBe(true);
  });
});

describe('buildGraph — disabled hooks', () => {
  const has = (g: any, s: any, t: any, kind: any) => g.links.some((l: any) => l.source === s && l.target === t && l.kind === kind);
  const ids = (g: any) => g.nodes.map((n: any) => n.id);

  it('does not render a disabled hook (no node)', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q' }],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'On', queues: ['https://x/api/v1/queues/1'], run_after: [], active: true },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'Off', queues: ['https://x/api/v1/queues/1'], run_after: [], active: false },
      ],
    });
    expect(ids(g)).toContain('hook:10');
    expect(ids(g)).not.toContain('hook:11');
  });

  it('keeps a hook whose `active` field is absent (conservative)', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [], queues: [],
      hooks: [{ id: 10, url: 'https://x/api/v1/hooks/10', name: 'Legacy', queues: [], run_after: [] }],
    });
    expect(ids(g)).toContain('hook:10');
  });

  it('bridges A -> B(disabled) -> C into A -> C', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q' }],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'A', queues: ['https://x/api/v1/queues/1'], run_after: [], active: true },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'B', queues: ['https://x/api/v1/queues/1'], run_after: ['https://x/api/v1/hooks/10'], active: false },
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'C', queues: ['https://x/api/v1/queues/1'], run_after: ['https://x/api/v1/hooks/11'], active: true },
      ],
    });
    expect(ids(g)).not.toContain('hook:11');                       // B removed
    expect(has(g, 'hook:10', 'hook:12', 'runAfter')).toBe(true);   // bridged A -> C
    expect(has(g, 'hook:11', 'hook:12', 'runAfter')).toBe(false);  // no edge via removed B
    // C has a real (bridged) predecessor, so it does NOT also anchor to its queue.
    expect(has(g, 'queue:1', 'hook:12', 'reference')).toBe(false);
    // A is a root, so it anchors to its queue (unchanged behavior).
    expect(has(g, 'queue:1', 'hook:10', 'reference')).toBe(true);
  });

  it('bridges through a chain of two disabled hooks A -> B(dis) -> C(dis) -> D into A -> D', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [], queues: [],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'A', queues: [], run_after: [], active: true },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'B', queues: [], run_after: ['https://x/api/v1/hooks/10'], active: false },
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'C', queues: [], run_after: ['https://x/api/v1/hooks/11'], active: false },
        { id: 13, url: 'https://x/api/v1/hooks/13', name: 'D', queues: [], run_after: ['https://x/api/v1/hooks/12'], active: true },
      ],
    });
    expect(ids(g)).not.toContain('hook:11');
    expect(ids(g)).not.toContain('hook:12');
    expect(has(g, 'hook:10', 'hook:13', 'runAfter')).toBe(true);
  });

  it('anchors an enabled successor of a disabled ROOT to its queue (no orphan)', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q' }],
      hooks: [
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'B', queues: ['https://x/api/v1/queues/1'], run_after: [], active: false },
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'C', queues: ['https://x/api/v1/queues/1'], run_after: ['https://x/api/v1/hooks/11'], active: true },
      ],
    });
    expect(ids(g)).not.toContain('hook:11');
    expect(has(g, 'queue:1', 'hook:12', 'reference')).toBe(true); // re-anchored, not floating
  });

  it('mixed predecessors: keeps the enabled one and bridges the disabled one', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [], queues: [],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'P', queues: [], run_after: [], active: true },
        { id: 20, url: 'https://x/api/v1/hooks/20', name: 'X', queues: [], run_after: [], active: true },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'D', queues: [], run_after: ['https://x/api/v1/hooks/20'], active: false },
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'C', queues: [],
          run_after: ['https://x/api/v1/hooks/10', 'https://x/api/v1/hooks/11'], active: true },
      ],
    });
    expect(has(g, 'hook:10', 'hook:12', 'runAfter')).toBe(true); // enabled predecessor kept
    expect(has(g, 'hook:20', 'hook:12', 'runAfter')).toBe(true); // bridged through disabled D
    expect(ids(g)).not.toContain('hook:11');
  });

  it('preserves today behavior: an enabled hook with a MISSING (non-disabled) predecessor still floats', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q' }],
      hooks: [
        { id: 12, url: 'https://x/api/v1/hooks/12', name: 'C', queues: ['https://x/api/v1/queues/1'],
          run_after: ['https://x/api/v1/hooks/999'], active: true },
      ],
    });
    // predecessor 999 is absent (not disabled) -> no edge AND no queue anchor (unchanged).
    expect(g.links.length).toBe(0);
    expect(ids(g)).toContain('hook:12');
  });

  it('queue "Hooks" count excludes disabled hooks', () => {
    const g = buildGraph({
      organization: null, workspaces: [], engines: [],
      queues: [{ id: 1, url: 'https://x/api/v1/queues/1', name: 'Q',
        hooks: ['https://x/api/v1/hooks/10', 'https://x/api/v1/hooks/11'] }],
      hooks: [
        { id: 10, url: 'https://x/api/v1/hooks/10', name: 'On', queues: ['https://x/api/v1/queues/1'], run_after: [], active: true },
        { id: 11, url: 'https://x/api/v1/hooks/11', name: 'Off', queues: ['https://x/api/v1/queues/1'], run_after: [], active: false },
      ],
    });
    const q = g.nodes.find((n) => n.id === 'queue:1');
    expect(q!.detail).toContainEqual(['Hooks', '1']); // only the enabled hook is counted
  });
});
