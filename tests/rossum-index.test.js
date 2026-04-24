// @vitest-environment jsdom
//
// Integration test for the Rossum content-script entry point. Mocks all
// feature modules so we can assert the orchestration: which inits run,
// which handlers get wired into the MutationObserver, and that added
// subtrees are walked correctly.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';

function loadEntry(settings) {
  vi.resetModules();
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(settings),
      },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
    },
  };
}

describe('rossum content-script entry', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    // The entry observes document.body — make sure one exists.
  });

  it('does not observe when all features are disabled (dev-flags still init)', async () => {
    loadEntry({});
    const observeSpy = vi.fn();
    globalThis.MutationObserver = vi.fn(function () { this.observe = observeSpy; });

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(observeSpy).not.toHaveBeenCalled();
    // initDevFlags always runs.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it('observes document.body once any feature is enabled', async () => {
    loadEntry({ schemaAnnotationsEnabled: true });
    const observeSpy = vi.fn();
    globalThis.MutationObserver = vi.fn(function () { this.observe = observeSpy; });

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(observeSpy).toHaveBeenCalledTimes(1);
    const [target, opts] = observeSpy.mock.calls[0];
    expect(target).toBe(document.body);
    expect(opts).toEqual({ subtree: true, childList: true });
  });

  it('walks added subtrees and invokes every registered handler per element', async () => {
    loadEntry({ schemaAnnotationsEnabled: true, expandFormulasEnabled: true });
    let observerCallback;
    globalThis.MutationObserver = vi.fn(function (cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    });

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
      el.matches = (sel) => { visited.add(el); return orig(sel); };
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
    let observerCallback;
    globalThis.MutationObserver = vi.fn(function (cb) {
      observerCallback = cb;
      this.observe = vi.fn();
    });

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    const textNode = document.createTextNode('hello');
    // Should not throw, as the entry filters to Node.ELEMENT_NODE.
    expect(() => observerCallback([{ addedNodes: [textNode] }])).not.toThrow();
  });

  it('injects schema-ids CSS only when that feature is enabled', async () => {
    loadEntry({ schemaAnnotationsEnabled: true });
    globalThis.MutationObserver = vi.fn(function () { this.observe = vi.fn(); });

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
    globalThis.MutationObserver = vi.fn(function () { this.observe = vi.fn(); });

    await import('../src/rossum/index.js');
    await new Promise((r) => setTimeout(r, 0));

    const styles = document.head.querySelectorAll('style');
    const hasSchemaStyle = Array.from(styles).some((s) =>
      s.textContent.includes('rossum-sa-extension-schema-id'),
    );
    expect(hasSchemaStyle).toBe(false);
  });
});
