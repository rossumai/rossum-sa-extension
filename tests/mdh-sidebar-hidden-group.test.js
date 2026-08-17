// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/openCollectionTab.js', () => ({ openCollectionTab: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as store from '../src/mdh/store.js';
import Sidebar from '../src/mdh/components/Sidebar.jsx';
import { COLLECTION, LEGACY_COLLECTION } from '../src/fabry/architect/collectionNames.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
// loadCollections is async and the render follows it, so a single macrotask is not enough —
// wait on the CONDITION (see the repo's flaky fixed-timeout lesson) rather than on a delay.
async function waitFor(fn, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await tick();
  }
}
let mounted = null;
async function mount() {
  const root = document.createElement('div');
  mounted = root;
  render(h(Sidebar, null), root);
  // every case here depends on the listing having been applied
  await waitFor(() => store.rawCollections.value.length > 0);
  await tick();
  return root;
}
const names = (root, sel = '.collection-item-name') => [...root.querySelectorAll(sel)].map((e) => e.textContent);
const group = (root) => root.querySelector('.collection-hidden-group');

afterEach(() => { if (mounted) { render(null, mounted); mounted = null; } });

beforeEach(() => {
  vi.clearAllMocks();
  store.selectedCollection.value = null;
  store.showHiddenCollections.value = false;
  store.activeView.value = 'collection';
  store.rawCollections.value = [];
  store.hiddenCollections.value = [];
  store.collections.value = [];
});

describe('Sidebar — this extension own collections live in a group below the list', () => {
  it('keeps them out of the main list and offers them collapsed underneath', async () => {
    api.listCollections.mockResolvedValue({ result: ['vendors', COLLECTION, 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
    // main list: the customer own collections only
    expect(names(root)).toEqual(['items', 'vendors']);
    const g = group(root);
    expect(g).toBeTruthy();
    const toggle = g.querySelector('.collection-hidden-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toMatch(/Extension collections/);
    expect(toggle.textContent).toMatch(/\(1\)/);
    // collapsed: no rows rendered at all
    expect(g.querySelector('.collection-item')).toBe(null);
  });

  it('expands to real rows — same renderer, so they behave like any other collection', async () => {
    api.listCollections.mockResolvedValue({ result: ['vendors', COLLECTION, LEGACY_COLLECTION] });
    const root = await mount();
    const toggle = group(root).querySelector('.collection-hidden-toggle');
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    const rows = [...group(root).querySelectorAll('.collection-item')];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.querySelector('.collection-item-name').textContent).sort())
      .toEqual([LEGACY_COLLECTION, COLLECTION].sort());
    // the kebab actions menu comes along, since it is the same row markup
    expect(rows[0].querySelector('.collection-action-menu-btn')).toBeTruthy();
    // clicking one selects it like any other collection
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect([LEGACY_COLLECTION, COLLECTION]).toContain(store.selectedCollection.value);
  });

  it('shows no group at all on an org that has none of ours', async () => {
    api.listCollections.mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
    expect(group(root)).toBe(null);
  });

  it('never auto-selects one of ours when nothing is selected', async () => {
    // ours sorts FIRST here ('_' before letters), so an auto-select over the raw list would
    // land the user in the extension own collection on first open.
    api.listCollections.mockResolvedValue({ result: [COLLECTION, 'vendors'] });
    store.activeView.value = 'collection';
    await mount();
    await waitFor(() => store.selectedCollection.value);
    expect(store.selectedCollection.value).toBe('vendors');
  });
});
