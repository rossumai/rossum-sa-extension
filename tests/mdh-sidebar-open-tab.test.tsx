// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');
vi.mock('../src/mdh/openCollectionTab.js', () => ({ openCollectionTab: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as store from '../src/mdh/store.js';
import { openCollectionTab } from '../src/mdh/openCollectionTab.js';
import Sidebar from '../src/mdh/components/Sidebar.jsx';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount() {
  const root = document.createElement('div');
  render(<Sidebar />, root);
  await tick(); // let loadCollections' useEffect settle
  return root;
}

function rowFor(root: any, name: any) {
  return Array.from(root.querySelectorAll('.collection-item'))
    .find((el: any) => el.querySelector('.collection-item-name')?.textContent === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listCollections).mockResolvedValue({ result: ['vendors', 'items'] });
  store.collections.value = ['vendors', 'items'];
  store.selectedCollection.value = null;
  store.activeView.value = 'collection';
});

describe('Sidebar open-in-new-tab', () => {
  it('plain click selects in the current tab (does NOT open a new tab)', async () => {
    const root = await mount();
    (rowFor(root, 'vendors') as any).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(store.selectedCollection.value).toBe('vendors');
    expect(openCollectionTab).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl-click opens a new tab and does NOT change the current selection', async () => {
    const root = await mount();
    (rowFor(root, 'items') as any).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('items');
    expect(store.selectedCollection.value).toBeNull();
  });

  it('middle-click (auxclick button 1) opens a new tab', async () => {
    const root = await mount();
    (rowFor(root, 'vendors') as any).dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(openCollectionTab).toHaveBeenCalledWith('vendors');
  });

  it('kebab "Open in new tab" item opens a new tab', async () => {
    const root = await mount();
    const row: any = rowFor(root, 'vendors');
    row.querySelector('.collection-action-menu-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    const item = Array.from(root.querySelectorAll('.collection-action-menu .toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    expect(item).toBeTruthy();
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('vendors');
  });
});

describe('Sidebar right-click context menu', () => {
  it('opens the actions menu at the cursor and suppresses the native menu', async () => {
    const root = await mount();
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 });
    (rowFor(root, 'vendors') as any).dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    await tick();
    const menu = root.querySelector('.collection-action-menu');
    expect(menu).not.toBeNull();
    const item = Array.from(menu!.querySelectorAll('.toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    expect(item).toBeTruthy();
  });

  it('right-click "Open in new tab" opens a new tab for that collection', async () => {
    const root = await mount();
    (rowFor(root, 'items') as any).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 40 }));
    await tick();
    const item = Array.from(root.querySelectorAll('.collection-action-menu .toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('items');
  });

  it('the kebab button still opens the menu (regression)', async () => {
    const root = await mount();
    (rowFor(root, 'vendors') as any).querySelector('.collection-action-menu-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    expect(root.querySelector('.collection-action-menu')).not.toBeNull();
  });
});
