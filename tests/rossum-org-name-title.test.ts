// @vitest-environment jsdom
//
// The organization name in the browser tab title. The SPA rewrites the title on
// every route change, so the tests that matter are the ones proving it comes
// back afterwards and that our own write does not feed itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function loadModule(fetchRossumApi: any) {
  vi.resetModules();
  vi.doMock('../src/rossum/api.js', () => ({ fetchRossumApi }));
  return await import('../src/rossum/features/org-name-title.js');
}

const oneOrg = () => vi.fn().mockResolvedValue({ results: [{ name: 'Acme Corporation' }] });

beforeEach(() => {
  // A FRESH <title> element per test, not just a fresh string: each init()
  // attaches an observer that is never disconnected (it lives as long as the
  // page does), so reusing the element would leave earlier tests' observers
  // rewriting this one's title.
  document.head.innerHTML = '<title>Document List - Rossum</title>';
});

afterEach(() => {
  vi.doUnmock('../src/rossum/api.js');
});

describe('org name in the tab title', () => {
  it('puts the organization first, where a truncated tab still shows it', async () => {
    const { init } = await loadModule(oneOrg());

    await init();

    expect(document.title).toBe('Acme Corporation · Document List - Rossum');
  });

  it('re-applies after the SPA rewrites the title on a route change', async () => {
    const { init } = await loadModule(oneOrg());
    await init();

    document.title = 'Settings - Rossum';

    await vi.waitFor(() => {
      expect(document.title).toBe('Acme Corporation · Settings - Rossum');
    });
  });

  it('does not prefix its own write, however many times the title changes', async () => {
    const { init } = await loadModule(oneOrg());
    await init();

    document.title = 'Settings - Rossum';
    await vi.waitFor(() => {
      expect(document.title).toBe('Acme Corporation · Settings - Rossum');
    });
    document.title = 'Queue - Rossum';
    await vi.waitFor(() => {
      expect(document.title).toBe('Acme Corporation · Queue - Rossum');
    });

    expect(document.title.match(/Acme Corporation/g)).toHaveLength(1);
  });

  it('leaves the title alone when the lookup fails', async () => {
    const { init } = await loadModule(vi.fn().mockRejectedValue(new Error('API 403')));

    await init();

    expect(document.title).toBe('Document List - Rossum');
  });

  it('leaves the title alone when the response carries no organization', async () => {
    const { init } = await loadModule(vi.fn().mockResolvedValue({ results: [] }));

    await init();

    expect(document.title).toBe('Document List - Rossum');
  });
});
