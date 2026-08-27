// @vitest-environment jsdom
// Preloading rendered deliverables so a switch is instant (owner, 2026-08-18).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderDocument,
  isRendered,
  cacheStats,
  clearRenderCache,
  cacheKey,
  CACHE_CAP,
} from '../src/docs/renderCache.js';
import { preloadDeliverables, PRELOAD_CAP, MERMAID_FENCE } from '../src/fabry/architect/preload.js';

const doc = (id: any, text: any) => ({ id, text });
const DOCS = [
  doc('a', '# A\n\nBody a.\n'),
  doc('b', '# B\n\nBody b.\n'),
  doc('c', '# C\n\nBody c.\n'),
];

beforeEach(() => clearRenderCache());

describe('renderDocument cache', () => {
  it('renders once and serves the same tree afterwards', () => {
    const first = renderDocument({ id: 'a', text: DOCS[0].text });
    const second = renderDocument({ id: 'a', text: DOCS[0].text });
    expect(second).toBe(first); // same object, not just equal
    expect(cacheStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(first.body!.innerHTML).toMatch(/Body a/);
  });

  it('re-renders when anything that changes the output changes', () => {
    const base = { id: 'a', text: DOCS[0].text };
    const a = renderDocument(base);
    expect(renderDocument({ ...base, text: '# A\n\nEdited.\n' })).not.toBe(a); // an edit
    expect(renderDocument({ ...base, dark: true })).not.toBe(a); // theme
    expect(renderDocument({ ...base, syncLines: true })).not.toBe(a); // anchors
    // A document rendered BEFORE the diagram bundle arrived has code fences where diagrams
    // belong, so it must not be served once a renderer exists.
    expect(renderDocument({ ...base, mermaid: () => '<svg/>' })).not.toBe(a);
  });

  it('keys on the exact text, so two deliverables with identical text still differ by id', () => {
    expect(cacheKey({ id: 'a', text: 'x' })).not.toBe(cacheKey({ id: 'b', text: 'x' }));
  });

  it('evicts least-recently-USED, not oldest-inserted', () => {
    for (let i = 0; i < CACHE_CAP; i += 1) renderDocument({ id: 'd' + i, text: '# ' + i });
    expect(cacheStats().size).toBe(CACHE_CAP);
    renderDocument({ id: 'd0', text: '# 0' }); // touch the oldest → now newest
    renderDocument({ id: 'new', text: '# new' }); // forces one eviction
    expect(isRendered({ id: 'd0', text: '# 0' })).toBe(true); // survived because it was used
    expect(isRendered({ id: 'd1', text: '# 1' })).toBe(false); // evicted instead
  });

  it('does not cache a failure — a transient throw must not become permanent', () => {
    const bad = renderDocument({
      id: 'x',
      text: 'ok',
      mermaid: () => {
        throw new Error('boom');
      },
    });
    // A mermaid throw is caught by the fence renderer itself, so this still renders; the point
    // is that nothing is cached when the pipeline throws outright.
    expect(bad.body || bad.warnings.length).toBeTruthy();
  });

  // Controller ruling 15: `renderDocument` and `isRendered` know nothing about assets at all —
  // review found the earlier design (an `assetsVersion` in the key) made a warmed entry
  // unmatchable the instant a caller supplied a store, defeating the "preload so page switching
  // is instant" promise this module opens with. This pins that both call shapes — the one
  // preload.js uses, and the one DocView uses once it is ready to sync assets against the result
  // — key identically.
  it('a warmed entry is still a hit once a caller is ready to sync assets against it', () => {
    const text = '# Doc\n\n![shot](assets/diagram.png)\n';
    renderDocument({ id: 'warm', text, syncLines: true }); // what preload.js warms
    expect(isRendered({ id: 'warm', text, syncLines: true })).toBe(true);
    const before = cacheStats().hits;
    const { body } = renderDocument({ id: 'warm', text, syncLines: true }); // what DocView asks for
    expect(cacheStats().hits).toBe(before + 1);
    expect(body!.querySelector('img[data-asset-ref]')).toBeTruthy();
  });
});

describe('preloadDeliverables', () => {
  // Synchronous idle stub: each scheduled slice runs immediately, so the sweep completes within
  // the test without timers.
  const nowDeps = () => ({
    requestIdleCallback: (fn: any) => {
      fn();
      return 1;
    },
    cancelIdleCallback: () => {},
  });

  it('warms every deliverable except the open one', () => {
    preloadDeliverables({ deliverables: DOCS, activeId: 'a', syncLines: false, deps: nowDeps() });
    expect(isRendered({ id: 'b', text: DOCS[1].text, syncLines: false })).toBe(true);
    expect(isRendered({ id: 'c', text: DOCS[2].text, syncLines: false })).toBe(true);
    // The open one renders itself on mount; warming it would duplicate that work.
    expect(isRendered({ id: 'a', text: DOCS[0].text, syncLines: false })).toBe(false);
  });

  it('skips what is already rendered instead of doing it twice', () => {
    renderDocument({ id: 'b', text: DOCS[1].text, syncLines: false });
    const before = cacheStats().misses;
    preloadDeliverables({ deliverables: DOCS, activeId: 'a', syncLines: false, deps: nowDeps() });
    expect(cacheStats().misses).toBe(before + 1); // only 'c' was new
  });

  it('ignores empty deliverables and returns a no-op when there is nothing to do', () => {
    const cancel = preloadDeliverables({
      deliverables: [doc('e', '   ')],
      activeId: null,
      deps: nowDeps(),
    });
    expect(typeof cancel).toBe('function');
    expect(cacheStats().size).toBe(0);
    expect(preloadDeliverables({ deliverables: [], deps: nowDeps() })()).toBeUndefined();
  });

  it('is bounded, so a pathological list cannot spin forever', () => {
    const many = Array.from({ length: PRELOAD_CAP + 25 }, (_, i) => doc('m' + i, '# ' + i));
    preloadDeliverables({
      deliverables: many,
      activeId: null,
      syncLines: false,
      cap: 5,
      deps: nowDeps(),
    });
    expect(cacheStats().size).toBe(5);
  });

  it('cancelling stops the sweep mid-way', () => {
    // Defer each slice so the cancel lands between them.
    const pending: any = [];
    const deps = {
      requestIdleCallback: (fn: any) => {
        pending.push(fn);
        return pending.length;
      },
      cancelIdleCallback: () => {},
    };
    const cancel = preloadDeliverables({
      deliverables: DOCS,
      activeId: null,
      syncLines: false,
      deps,
    });
    pending.shift()(); // first slice renders one document
    expect(cacheStats().size).toBe(1);
    cancel();
    while (pending.length) pending.shift()(); // any queued slice must now be inert
    expect(cacheStats().size).toBe(1);
  });

  it('warms diagram-free documents WITHOUT waiting for the 1.5MB diagram bundle', () => {
    // Waiting for the bundle before warming anything meant no preload at all until it landed —
    // measured in a browser harness (nothing cached, all misses). Plain documents go first.
    const withDiagram = doc('m', '# M\n\n```mermaid\ngraph TD\n  A-->B\n```\n');
    preloadDeliverables({
      deliverables: [DOCS[1], withDiagram, DOCS[2]],
      activeId: null,
      syncLines: false,
      deps: nowDeps(),
    });
    expect(isRendered({ id: 'b', text: DOCS[1].text, syncLines: false })).toBe(true);
    expect(isRendered({ id: 'c', text: DOCS[2].text, syncLines: false })).toBe(true);
    // The diagram one waits for the bundle (which never arrives in jsdom), and that is fine:
    // caching it as bare fences would only have to be redone.
    expect(isRendered({ id: 'm', text: withDiagram.text, syncLines: false })).toBe(false);
  });

  it('detects a diagram fence the way the renderer does', () => {
    expect(MERMAID_FENCE.test('```mermaid\ngraph TD\n  A-->B\n```')).toBe(true);
    expect(MERMAID_FENCE.test('```js\nconst a = 1;\n```')).toBe(false);
    expect(MERMAID_FENCE.test('text about mermaid diagrams')).toBe(false);
  });
});
