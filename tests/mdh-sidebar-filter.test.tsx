// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = globalThis.chrome || {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/openCollectionTab.js', () => ({ openCollectionTab: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as store from '../src/mdh/store.js';
import Sidebar from '../src/mdh/components/Sidebar.jsx';
import { COLLECTION, LEGACY_COLLECTION } from '../src/fabry/architect/collectionNames.js';

// A query that hits the extension's own collection and nothing the customer owns. Derived
// rather than hardcoded, so a rename of COLLECTION cannot silently make it match 'vendors'
// too — the precondition below fails loudly instead.
const GROUP_QUERY = COLLECTION.slice(1, 6);
if ('vendors'.toLowerCase().includes(GROUP_QUERY.toLowerCase())) {
  throw new Error(`GROUP_QUERY ${GROUP_QUERY} also matches the customer fixture 'vendors'`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
// Wait on the condition, never on a fixed delay (see mdh-sidebar-hidden-group.test.tsx).
async function waitFor(fn: any, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await tick();
  }
}

let mounted: any = null;
async function mount() {
  const root = document.createElement('div');
  mounted = root;
  render(<Sidebar />, root);
  await waitFor(() => store.rawCollections.value.length > 0);
  await tick();
  return root;
}

const names = (root: any) =>
  [...root.querySelectorAll('.collection-item-name')].map((e) => e.textContent);
const input = (root: any) => root.querySelector('.collection-filter-input') as HTMLInputElement;
const clearBtn = (root: any) => root.querySelector('.collection-filter-clear');

async function type(root: any, value: string) {
  const el = input(root);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

afterEach(() => {
  if (mounted) {
    render(null, mounted);
    mounted = null;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  store.selectedCollection.value = null;
  store.showHiddenCollections.value = false;
  store.activeView.value = 'collection';
  store.rawCollections.value = [];
  store.hiddenCollections.value = [];
  store.collections.value = [];
});

describe('Sidebar — filter the collection list by name', () => {
  it('narrows the list as characters are typed, and reports how many of how many', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({
      result: ['wc_po_eurofins_uat', 'wc_supplier_eurofins_uat', 'wc_supplier_master'],
    });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 3);
    expect(root.querySelector('.sidebar-count')!.textContent).toBe('(3)');

    await type(root, 'supplier');
    expect(names(root)).toEqual(['wc_supplier_eurofins_uat', 'wc_supplier_master']);
    expect(root.querySelector('.sidebar-count')!.textContent).toBe('(2 / 3)');
  });

  it('matches case-insensitively and anywhere in the name', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['Vendors', 'items_uat'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);

    await type(root, 'DOR');
    expect(names(root)).toEqual(['Vendors']);
  });

  it('clears with the × button, restoring the full list', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);

    // no × offered until there is something to clear
    expect(clearBtn(root)).toBe(null);

    await type(root, 'vend');
    expect(names(root)).toEqual(['vendors']);
    const btn = clearBtn(root);
    expect(btn).toBeTruthy();
    // The escapes in the source have to reach the DOM as characters — see the JSX escape
    // trap in CLAUDE.md, where \uXXXX in raw JSX text renders as six literal characters.
    expect(btn.textContent).toBe('\u00d7');
    expect(input(root).getAttribute('title')).toContain('\u2014');

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(names(root)).toEqual(['items', 'vendors']);
    expect(input(root).value).toBe('');
  });

  it('clears on Escape', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);

    await type(root, 'vend');
    expect(names(root)).toEqual(['vendors']);

    input(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(names(root)).toEqual(['items', 'vendors']);
    expect(input(root).value).toBe('');
  });

  it('says so when nothing matches, instead of showing an unexplained empty list', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);

    await type(root, 'zzz');
    expect(root.querySelectorAll('.collection-item')).toHaveLength(0);
    const empty = root.querySelector('.collection-filter-empty')!;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/zzz/);
  });

  it('leaves the current selection alone — filtering hides rows, it does not deselect', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => store.selectedCollection.value === 'items');

    await type(root, 'vend');
    expect(names(root)).toEqual(['vendors']);
    expect(store.selectedCollection.value).toBe('items');
  });

  it('narrows the extension-collections group too, and opens it so a match is visible', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));
    // collapsed to start with
    expect(root.querySelector('.collection-hidden-group .collection-item')).toBe(null);

    await type(root, GROUP_QUERY);
    const group = root.querySelector('.collection-hidden-group')!;
    expect(group).toBeTruthy();
    expect(group.querySelector('.collection-hidden-toggle')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(
      [...group.querySelectorAll('.collection-item-name')].map((e: any) => e.textContent),
    ).toEqual([COLLECTION]);
    // the customer's own collection does not match, so the main list is empty
    expect(
      root.querySelectorAll('.collection-list')[0].querySelectorAll('.collection-item'),
    ).toHaveLength(0);
  });

  it('hides the group entirely when the filter excludes all of ours', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));

    await type(root, 'vend');
    expect(root.querySelector('.collection-hidden-group')).toBe(null);
    expect(names(root)).toEqual(['vendors']);
  });

  it('does not persist the filter — it is transient view state, held in the component', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const setSpy = vi.fn();
    const realSet = chrome.storage.local.set;
    (chrome.storage.local as any).set = setSpy;
    try {
      const root = await mount();
      await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
      await type(root, 'vend');
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      (chrome.storage.local as any).set = realSet;
    }
  });

  it('emphasises the matched run inside each name, and only that run', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['wc_supplier_eurofins_uat'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 1);
    // nothing emphasised while the list is unfiltered
    expect(root.querySelector('.collection-item-hit')).toBe(null);

    await type(root, 'SUPP');
    const hits = [...root.querySelectorAll('.collection-item-hit')].map((e: any) => e.textContent);
    // the name's own casing survives, not the query's
    expect(hits).toEqual(['supp']);
    // and the row still reads as the whole, unaltered name
    expect(names(root)).toEqual(['wc_supplier_eurofins_uat']);
  });

  it('emphasises every occurrence in a name', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['uat_x_uat'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 1);

    await type(root, 'uat');
    expect(root.querySelectorAll('.collection-item-hit')).toHaveLength(2);
    expect(names(root)).toEqual(['uat_x_uat']);
  });

  it('offers no filter box on an org with no collections at all', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
    const root = document.createElement('div');
    mounted = root;
    render(<Sidebar />, root);
    await tick();
    expect(input(root)).toBe(null);
  });

  it('emphasises matches inside the extension-collections group as well', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));

    await type(root, GROUP_QUERY);
    const group = root.querySelector('.collection-hidden-group')!;
    expect(
      [...group.querySelectorAll('.collection-item-hit')].map((e: any) => e.textContent),
    ).toEqual([GROUP_QUERY]);
  });

  it('reports the group count as matched-of-total while filtering', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({
      result: ['vendors', COLLECTION, LEGACY_COLLECTION],
    });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));
    const groupCount = () =>
      root.querySelector('.collection-hidden-group .sidebar-count')!.textContent;
    expect(groupCount()).toBe('(2)');

    // a query that hits exactly one of the two extension collections
    const only = COLLECTION.length > LEGACY_COLLECTION.length ? COLLECTION : LEGACY_COLLECTION;
    const other = only === COLLECTION ? LEGACY_COLLECTION : COLLECTION;
    expect(other.toLowerCase().includes(only.toLowerCase())).toBe(false); // precondition
    await type(root, only);
    expect(groupCount()).toBe('(1 / 2)');
  });

  // Finding 1 of the review: the caret force-opens while filtering, so a click on it could
  // not change what is on screen — but it still wrote mdhShowHiddenCollections, persisting
  // the INVERSE of the user's intent for the next session.
  it('does not let the caret write a preference it cannot honour while filtering', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));
    expect(store.showHiddenCollections.value).toBe(false);

    await type(root, GROUP_QUERY);
    const toggle = root.querySelector('.collection-hidden-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const setSpy = vi.fn();
    const realSet = chrome.storage.local.set;
    (chrome.storage.local as any).set = setSpy;
    try {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await tick();
      expect(setSpy).not.toHaveBeenCalled();
      expect(store.showHiddenCollections.value).toBe(false);
      expect(root.querySelector('.collection-hidden-toggle')!.getAttribute('aria-expanded')).toBe(
        'true',
      );
    } finally {
      (chrome.storage.local as any).set = realSet;
    }
  });

  it('keeps the caret working once the filter is cleared', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));

    await type(root, GROUP_QUERY);
    await type(root, '');
    root
      .querySelector('.collection-hidden-toggle')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(store.showHiddenCollections.value).toBe(true);
  });

  // Finding 2 of the review: the created collection becomes the selection, but under an
  // active filter its row is not in the list — an active selection with no visible row.
  it('clears the filter when a collection is created, so the new selection is on screen', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
    await type(root, 'vend');
    expect(names(root)).toEqual(['vendors']);

    const plus = [...root.querySelectorAll('.icon-btn')].find(
      (b: any) => b.getAttribute('title') === 'New collection',
    )!;
    plus.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => store.modalContent.value);

    // the listing that follows the create includes the new collection
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items', 'zzz_new'] });
    const modalRoot = document.createElement('div');
    render(store.modalContent.value!.render(), modalRoot);
    const nameInput = modalRoot.querySelector('input.input') as HTMLInputElement;
    nameInput.value = 'zzz_new';
    [...modalRoot.querySelectorAll('button')]
      .find((b: any) => b.textContent === 'Create')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => store.selectedCollection.value === 'zzz_new');
    await tick();
    expect(input(root).value).toBe('');
    expect(names(root)).toContain('zzz_new');
    render(null, modalRoot);
  });

  it('clears the filter when a collection is renamed, for the same reason', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
    await type(root, 'vend');

    // open the row's kebab menu and pick Rename
    root
      .querySelector('.collection-action-menu-btn')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    [...root.querySelectorAll('.toolbar-menu-item')]
      .find((b: any) => b.textContent === 'Rename')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => store.modalContent.value);

    vi.mocked(api.listCollections).mockResolvedValue({ result: ['suppliers', 'items'] });
    const modalRoot = document.createElement('div');
    render(store.modalContent.value!.render(), modalRoot);
    const nameInput = modalRoot.querySelector('input.input') as HTMLInputElement;
    nameInput.value = 'suppliers';
    [...modalRoot.querySelectorAll('button')]
      .find((b: any) => b.textContent === 'Rename')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => store.rawCollections.value.includes('suppliers'));
    await tick();
    expect(input(root).value).toBe('');
    render(null, modalRoot);
  });

  // Finding 4 of the review. jsdom has no layout, so this pins only the CLASS CONTRACT the
  // stylesheet keys off — the geometry itself (a lone group match sitting under the filter box
  // instead of ~500px below it, with the nav footer still pinned) was verified in a browser.
  it('marks the filtering sidebar and an empty main list, the hooks the layout fix needs', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', COLLECTION] });
    const root = await mount();
    await waitFor(() => root.querySelector('.collection-hidden-group'));
    const aside = root.querySelector('aside.sidebar')!;
    const mainList = () => root.querySelectorAll('.collection-list')[0];
    expect(aside.className).not.toContain('sidebar-filtering');
    expect(mainList().className).not.toContain('is-empty');

    // only the extension collection matches, so the main list renders no rows
    await type(root, GROUP_QUERY);
    expect(aside.className).toContain('sidebar-filtering');
    expect(mainList().className).toContain('is-empty');

    // a filtered list WITH rows keeps flex: 1, so it must not be marked empty
    await type(root, 'vend');
    expect(aside.className).toContain('sidebar-filtering');
    expect(mainList().className).not.toContain('is-empty');
  });

  // Finding 5 of the review: the Escape handler used to stopPropagation, which silently
  // swallowed Escape for any document-level listener (the shared Modal registers one).
  it('lets Escape reach document-level listeners as well as clearing the filter', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);
    await type(root, 'vend');

    // The container has to be IN the document for anything to bubble to it — a detached
    // root would make this pass no matter what the handler does.
    document.body.appendChild(root);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    try {
      input(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
      expect(seen).toHaveBeenCalled();
      expect(input(root).value).toBe('');
    } finally {
      document.removeEventListener('keydown', seen);
      root.remove();
    }
  });

  // Finding 6 of the review: a whitespace-only query narrows nothing, so the accent state,
  // the tooltip and the clear button must all agree that there is nothing to clear.
  it('treats a whitespace-only query as no filter at all, consistently', async () => {
    vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.collection-item').length === 2);

    await type(root, '   ');
    expect(names(root)).toEqual(['items', 'vendors']);
    expect(root.querySelector('.collection-filter-wrap')!.className).not.toContain('has-value');
    expect(input(root).getAttribute('title')).toBe('');
    expect(clearBtn(root)).toBe(null);
  });
});
