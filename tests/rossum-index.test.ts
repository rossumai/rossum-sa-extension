// @vitest-environment jsdom
//
// Integration test for the Rossum content-script entry point. Mocks all
// feature modules so we can assert the orchestration: which inits run,
// which handlers get wired into the MutationObserver, and that added
// subtrees are walked correctly.
//
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function loadEntry(settings: any) {
  vi.resetModules();
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(settings),
      },
    } as any,
  } as any;
}

// The Rossum header as the org name sees it: a <header> holding the user-panel button.
function headerMarkup() {
  const header = document.createElement('header');
  const userpanel = document.createElement('button');
  userpanel.dataset.cy = 'userpanel';
  header.append(userpanel);
  return header;
}

const ORG_LIST = { results: [{ name: 'Acme Corporation' }] };
const orgPill = () => document.querySelector('.rossum-sa-extension-org-name');

describe('rossum content-script entry', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    // The entry observes document.body — make sure one exists.
    // The org name reads the page's session token before it asks for anything.
    window.localStorage.setItem('secureToken', 'tok');
  });

  afterEach(() => {
    vi.doUnmock('../src/rossum/api.js');
  });

  it('always observes for closable-tooltips even when all toggles are off', async () => {
    loadEntry({});
    const observeSpy = vi.fn();
    globalThis.MutationObserver = vi.fn(function (this: any) {
      this.observe = observeSpy;
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    // closable-tooltips is unconditional, so the observer is always attached.
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const [target, opts] = observeSpy.mock.calls[0];
    expect(target).toBe(document.body);
    expect(opts).toEqual({ subtree: true, childList: true });
    // closable-tooltips init injects its stylesheet on load.
    expect(document.getElementById('rossum-sa-extension-closable-tooltips-style')).not.toBeNull();
  });

  it('observes document.body once any feature is enabled', async () => {
    loadEntry({ schemaAnnotationsEnabled: true });
    const observeSpy = vi.fn();
    globalThis.MutationObserver = vi.fn(function (this: any) {
      this.observe = observeSpy;
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(observeSpy).toHaveBeenCalledTimes(1);
    const [target, opts] = observeSpy.mock.calls[0];
    expect(target).toBe(document.body);
    expect(opts).toEqual({ subtree: true, childList: true });
  });

  it('walks added subtrees and invokes every registered handler per element', async () => {
    loadEntry({ schemaAnnotationsEnabled: true, expandFormulasEnabled: true });
    let observerCallback: any;
    globalThis.MutationObserver = vi.fn(function (this: any, cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    // Build a real subtree: parent > child1, child2 > grandchild.
    const parent = document.createElement('div');
    const child1 = document.createElement('span');
    const child2 = document.createElement('section');
    const grandchild = document.createElement('button');
    parent.append(child1, child2);
    child2.append(grandchild);

    // Intercept DOM traversal: every processNode visit walks .matches and
    // .querySelector. We use a matches() spy on every element as a proxy
    // for "was visited by handleSchemaId or similar".
    const visited = new Set();
    for (const el of [parent, child1, child2, grandchild]) {
      const orig = el.matches.bind(el);
      el.matches = ((sel: string) => {
        visited.add(el);
        return orig(sel);
      }) as typeof el.matches;
    }

    observerCallback([{ addedNodes: [parent] }]);

    // All four elements in the added subtree should have been visited.
    expect(visited.has(parent)).toBe(true);
    expect(visited.has(child1)).toBe(true);
    expect(visited.has(child2)).toBe(true);
    expect(visited.has(grandchild)).toBe(true);
  });

  it('ignores non-element added nodes (text nodes, comments)', async () => {
    loadEntry({ schemaAnnotationsEnabled: true });
    let observerCallback: any;
    globalThis.MutationObserver = vi.fn(function (this: any, cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    const textNode = document.createTextNode('hello');
    // Should not throw, as the entry filters to Node.ELEMENT_NODE.
    expect(() => observerCallback([{ addedNodes: [textNode] }])).not.toThrow();
  });

  it('injects schema-ids CSS only when that feature is enabled', async () => {
    loadEntry({ schemaAnnotationsEnabled: true });
    globalThis.MutationObserver = vi.fn(function (this: any) {
      this.observe = vi.fn();
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    const styles = document.head.querySelectorAll('style');
    const hasSchemaStyle = Array.from(styles).some((s) =>
      s.textContent.includes('rossum-sa-extension-schema-id'),
    );
    expect(hasSchemaStyle).toBe(true);
  });

  it('does not inject schema-ids CSS when the feature is disabled', async () => {
    loadEntry({ expandFormulasEnabled: true });
    globalThis.MutationObserver = vi.fn(function (this: any) {
      this.observe = vi.fn();
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    const styles = document.head.querySelectorAll('style');
    const hasSchemaStyle = Array.from(styles).some((s) =>
      s.textContent.includes('rossum-sa-extension-schema-id'),
    );
    expect(hasSchemaStyle).toBe(false);
  });

  it('names the organization in the header with every toggle off — it defaults on', async () => {
    loadEntry({});
    vi.doMock('../src/rossum/api.js', () => ({
      fetchRossumApi: vi.fn(),
      fetchRossumApiFresh: vi.fn().mockResolvedValue(ORG_LIST),
    }));
    let observerCallback: any;
    globalThis.MutationObserver = vi.fn(function (this: any, cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    }) as any;

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));
    const header = headerMarkup();
    document.body.append(header);
    observerCallback([{ addedNodes: [header] }]);

    await vi.waitFor(() => {
      expect(orgPill()?.textContent).toBe('Acme Corporation');
    });
  });

  it('sweeps a header already on the page, with no mutation at all', async () => {
    loadEntry({});
    vi.doMock('../src/rossum/api.js', () => ({
      fetchRossumApi: vi.fn(),
      fetchRossumApiFresh: vi.fn().mockResolvedValue(ORG_LIST),
    }));
    globalThis.MutationObserver = vi.fn(function (this: any) {
      this.observe = vi.fn();
    }) as any;
    // The SPA finished rendering before the content script ran: nothing is ever
    // "added", so only an initial sweep can find this header.
    document.body.append(headerMarkup());

    await import('../src/rossum/index.js');

    await vi.waitFor(() => {
      expect(orgPill()?.textContent).toBe('Acme Corporation');
    });
  });

  it('names nothing, and asks for nothing, when its toggle is explicitly false', async () => {
    loadEntry({ orgNameEnabled: false });
    const fetchRossumApiFresh = vi.fn().mockResolvedValue(ORG_LIST);
    vi.doMock('../src/rossum/api.js', () => ({ fetchRossumApi: vi.fn(), fetchRossumApiFresh }));
    let observerCallback: any;
    globalThis.MutationObserver = vi.fn(function (this: any, cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    }) as any;
    const header = headerMarkup();
    document.body.append(header);

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));
    observerCallback([{ addedNodes: [header] }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(orgPill()).toBeNull();
    expect(fetchRossumApiFresh).not.toHaveBeenCalled();
  });
});
