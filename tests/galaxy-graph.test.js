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
      type: 'function', active: false, events: ['annotation.exported'],
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
  const has = (s, t, kind) => g.links.some((l) => l.source === s && l.target === t && l.kind === kind);

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
    const org = g.nodes.find((n) => n.id === 'organization:1');
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
  it('inverts hook.queues[] into queue -> hook reference links and skips unknown queues', () => {
    expect(has('queue:100', 'hook:200', 'reference')).toBe(true);
    expect(has('queue:100', 'hook:201', 'reference')).toBe(true);
    expect(has('queue:101', 'hook:201', 'reference')).toBe(true);
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
    expect(org.detail).toContainEqual(['Workspaces', '1']);
  });
  it('org node detail contains Users count', () => {
    const org = g.nodes.find((n) => n.id === 'organization:1');
    expect(org.detail).toContainEqual(['Users', '2']);
  });
  it('queue node detail includes Status and Hooks rows', () => {
    const q = g.nodes.find((n) => n.id === 'queue:100');
    expect(q.detail).toContainEqual(['Status', 'running']);
    expect(q.detail).toContainEqual(['Hooks', '2']);
  });
  it('engine node created from engines list has the real name and Type detail', () => {
    const eng = g.nodes.find((n) => n.id === 'engine:7');
    expect(eng.name).toBe('My Engine');
    expect(eng.detail).toContainEqual(['Type', 'extractor']);
  });
  it('engine node not in engines list gets a fallback name (engine:8)', () => {
    const eng = g.nodes.find((n) => n.id === 'engine:8');
    expect(eng.name).toBe('Engine 8');
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
    expect(g.nodes.find((n) => n.id === 'organization:1').name).toBe('organization 1');
  });
  it('does not throw on null/undefined input', () => {
    expect(buildGraph(null)).toEqual({ nodes: [], links: [] });
    expect(buildGraph(undefined)).toEqual({ nodes: [], links: [] });
  });
  it('exposes a style for every node type and link kind', () => {
    for (const t of ['organization', 'workspace', 'queue', 'hook', 'engine']) {
      expect(typeof NODE_STYLE[t].color).toBe('string');
      expect(NODE_STYLE[t].val).toBeGreaterThan(0);
    }
    for (const k of ['containment', 'reference']) {
      expect(typeof LINK_STYLE[k].color).toBe('string');
      expect(LINK_STYLE[k].width).toBeGreaterThan(0);
    }
  });
  it('does not create run_after links', () => {
    const g = buildGraph({
      organization: null, workspaces: [], queues: [],
      hooks: [
        { id: 200, url: 'https://x/api/v1/hooks/200', name: 'A', queues: [], run_after: [] },
        { id: 201, url: 'https://x/api/v1/hooks/201', name: 'B', queues: [], run_after: ['https://x/api/v1/hooks/200'] },
      ],
    });
    expect(g.links.some((l) => l.kind === 'run_after')).toBe(false);
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
    expect(g.nodes.find((n) => n.id === 'engine:7').name).toBe('Named Engine');
  });
});
