// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { Panel } from '../src/devtools/panel.jsx';
import JsonCodeEditor from '../src/devtools/JsonCodeEditor.jsx';
import * as store from '../src/devtools/store.js';
import * as api from '../src/devtools/api.js';

async function waitFor(fn: any, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor timed out');
}

const RES = { type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' };
const RES2 = { type: 'hook', id: '2', apiPath: '/api/v1/hooks/2', label: 'Hook' };

function mount() {
  const root = document.createElement('div');
  render(<Panel />, root);
  return root;
}
function rerender(root: any) {
  render(<Panel />, root);
}

beforeEach(() => {
  store.tabs.value = [];
  store.activeId.value = null;
  store.linkMenu.value = null;
  store.tabMenu.value = null;
  store._resetToast();
  store.curlMenu.value = false;
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};
});

describe('DevTools Panel', () => {
  it('shows the hint in the default tab when no Rossum resource is detected', () => {
    store.syncPageTab(null); // permanent default tab, no resource
    const root = mount();
    expect(root.querySelector('.rawjson-empty-hint')).not.toBeNull();
    // The default tab is always visible.
    expect(root.querySelector('.rawjson-tabbar')).not.toBeNull();
    const pageTab = root.querySelector('.rawjson-tab--page')!;
    expect(pageTab).not.toBeNull();
    expect(pageTab.querySelector('.rawjson-tab-label')!.textContent).toBe('Page');
    // The default tab has no close button.
    expect(pageTab.querySelector('.rawjson-tab-close')).toBeNull();
  });

  it('shows no Save pill for a read-only tab (even when dirty)', () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { id: 1 }, buffer: '{"id":2}', dirty: true, readOnly: true });
    const root = mount();
    expect(root.querySelector('.rawjson-savepill')).toBeNull();
    expect(root.querySelector('.rawjson-save')).toBeNull();
  });

  it('shows the Save pill with a change count only when the buffer is dirty', () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, {
      original: { name: 'A' },
      buffer: JSON.stringify({ name: 'B' }),
      dirty: true,
    });
    const root = mount();
    const pill = root.querySelector('.rawjson-savepill');
    expect(pill).not.toBeNull();
    expect(pill!.textContent.toLowerCase()).toContain('unsaved');
    expect(root.querySelector('.rawjson-save')).not.toBeNull();
  });

  it('shows no Save pill when the tab is clean', () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { name: 'A' }, buffer: '{"name":"A"}', dirty: false });
    const root = mount();
    expect(root.querySelector('.rawjson-savepill')).toBeNull();
  });

  it('Save opens the diff overlay', async () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, {
      original: { name: 'A' },
      buffer: JSON.stringify({ name: 'B' }),
      dirty: true,
    });
    const root = mount();
    root.querySelector<HTMLElement>('.rawjson-save')!.click();
    for (let i = 0; i < 50 && !root.querySelector('.rawjson-diff-overlay'); i++)
      await Promise.resolve();
    expect(root.querySelector('.rawjson-diff-overlay')).not.toBeNull();
  });

  it('never renders an Undo button', () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { name: 'A' } });
    const root = mount();
    expect(root.querySelector('.rawjson-undo')).toBeNull();
  });

  it('renders a PreviewPane (not the editor) and no Save for a preview tab', () => {
    const t = store.openTab(
      {
        type: 'documents',
        id: '5',
        apiPath: '/api/v1/documents/5/content',
        label: 'Content',
        readOnly: true,
      },
      'page',
    );
    store.patchTab(t.id, {
      preview: {
        kind: 'blob',
        contentType: 'application/pdf',
        size: 3,
        filename: 'd.pdf',
        blob: { size: 3 },
      },
      readOnly: true,
    });
    const root = mount();
    expect(root.querySelector('.rawjson-preview')).not.toBeNull();
    expect(root.querySelector('.cm-editor')).toBeNull();
    expect(root.querySelector('.rawjson-save')).toBeNull();
  });

  it('still renders the editor + Save for a JSON tab', () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { name: 'A' }, buffer: '{"name":"A"}', dirty: true });
    const root = mount();
    expect(root.querySelector('.rawjson-preview')).toBeNull();
    expect(root.querySelector('.rawjson-save')).not.toBeNull();
  });

  describe('tab bar', () => {
    it('renders a tab per open resource and highlights the active one', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const root = mount();
      const tabEls = root.querySelectorAll('.rawjson-tab');
      expect(tabEls.length).toBe(2);
      expect(root.querySelector('.rawjson-tab.active')!.textContent).toContain('Hook');
    });

    it('clicking a tab switches the active resource shown', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const root = mount();
      expect(root.querySelector('.rawjson-tab.active .rawjson-tab-label')!.textContent).toContain(
        'Hook',
      );
      const tabEls = [...root.querySelectorAll('.rawjson-tab')];
      const firstTab = tabEls.find((el) => el.textContent.includes('Queue'));
      (firstTab as HTMLElement).click();
      rerender(root);
      expect(root.querySelector('.rawjson-tab.active .rawjson-tab-label')!.textContent).toContain(
        'Queue',
      );
      expect(store.activeId.value).toBe(a.id);
    });

    it('closing a link tab (x) removes it and activates a neighbor; the page tab has no close button', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const root = mount();
      // page tab: no close button
      const pageTabEl = [...root.querySelectorAll('.rawjson-tab')].find((el) =>
        el.textContent.includes('Queue'),
      );
      expect(pageTabEl!.querySelector('.rawjson-tab-close')).toBeNull();
      // link tab: has a close button that removes it
      const linkTabEl = [...root.querySelectorAll('.rawjson-tab')].find((el) =>
        el.textContent.includes('Hook'),
      );
      linkTabEl!.querySelector<HTMLElement>('.rawjson-tab-close')!.click();
      rerender(root);
      expect(root.querySelectorAll('.rawjson-tab').length).toBe(1);
      expect(store.tabs.value.length).toBe(1);
      expect(store.activeId.value).toBe(a.id);
    });
  });

  it('capture-phase Cmd+F with real editor calls preventDefault and focus', async () => {
    // Mount a real editor so store.views.active is a genuine EditorView.
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { buffer: '{"a":1}' });
    const edRoot = document.createElement('div');
    document.body.appendChild(edRoot);
    render(<JsonCodeEditor tabId={t.id} />, edRoot);
    await waitFor(() => store.views.active);
    const view = store.views.active;
    const focusSpy = vi.spyOn(view, 'focus');
    // Mount Panel to install the capture keydown listener.
    const panelRoot = mount();
    // Dispatch capture-phase Cmd+F.
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
    // Assert store.views.active is a real EditorView (has .state property).
    expect(view).not.toBeNull();
    expect(view.state).not.toBeUndefined();
    focusSpy.mockRestore();
    // Cleanup.
    render(null, edRoot);
    render(null, panelRoot);
    edRoot.remove();
    panelRoot.remove();
  });

  it('capture-phase Cmd+F without active view does NOT prevent default', async () => {
    // Mount Panel without any active editor.
    const panelRoot = mount();
    // Dispatch capture-phase Cmd+F when store.views.active is null.
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // Cleanup.
    render(null, panelRoot);
    panelRoot.remove();
  });

  describe('context menu', () => {
    it('renders the context menu when linkMenu is set and clicking it opens a tab and clears the menu', async () => {
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      store.linkMenu.value = { url: 'https://acme.rossum.app/api/v1/schemas/9', x: 10, y: 10 };
      const root = mount();
      await waitFor(() => root.querySelector('.rawjson-linkmenu'));
      const menu = root.querySelector<HTMLElement>('.rawjson-linkmenu')!;
      expect(menu).not.toBeNull();
      expect(menu.style.left).toBe('10px');
      expect(menu.style.top).toBe('10px');
      const button = menu.querySelector('button')!;
      expect(button).not.toBeNull();
      expect(button.textContent).toContain('Open in new tab');
      button.click();
      await waitFor(() => !store.linkMenu.value);
      expect(store.linkMenu.value).toBeNull();
      expect(store.tabs.value.length).toBeGreaterThan(1);
    });

    it('an outside mousedown clears the link menu even if not currently rendered', async () => {
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      store.linkMenu.value = { url: 'https://acme.rossum.app/api/v1/schemas/9', x: 1, y: 1 };
      const root = mount();
      expect(store.linkMenu.value).not.toBeNull();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await waitFor(() => !store.linkMenu.value);
      expect(store.linkMenu.value).toBeNull();
    });

    it('setActive clears the link menu', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.linkMenu.value = { url: 'https://acme.rossum.app/api/v1/schemas/9', x: 1, y: 1 };
      expect(store.linkMenu.value).not.toBeNull();
      store.setActive(a.id);
      expect(store.linkMenu.value).toBeNull();
    });

    it('closeTab clears the link menu', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.linkMenu.value = { url: 'https://acme.rossum.app/api/v1/schemas/9', x: 1, y: 1 };
      expect(store.linkMenu.value).not.toBeNull();
      store.closeTab(b.id);
      expect(store.linkMenu.value).toBeNull();
    });
  });

  describe('tab context menu', () => {
    it('renders the tab menu when tabMenu is set and shows Close + Close Other Tabs when multiple tabs exist', async () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      const root = mount();
      await waitFor(() => root.querySelector('.rawjson-tabmenu'));
      const menu = root.querySelector<HTMLElement>('.rawjson-tabmenu')!;
      expect(menu).not.toBeNull();
      expect(menu.style.left).toBe('5px');
      expect(menu.style.top).toBe('5px');
      const buttons = menu.querySelectorAll('button');
      expect(buttons.length).toBe(2);
      expect(buttons[0].textContent).toContain('Close');
      expect(buttons[1].textContent).toContain('Close Other Tabs');
    });

    it('clicking Close Other Tabs closes other link tabs but keeps the page tab', async () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const c = store.openTab(
        { type: 'user', id: '3', apiPath: '/api/v1/users/3', label: 'User' },
        'link',
      );
      store.patchTab(c.id, { original: { id: 3 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      const root = mount();
      await waitFor(() => root.querySelector('.rawjson-tabmenu'));
      const menu = root.querySelector('.rawjson-tabmenu');
      const closeOtherBtn = [...menu!.querySelectorAll('button')].find((btn) =>
        btn.textContent.includes('Close Other Tabs'),
      );
      closeOtherBtn!.click();
      rerender(root);
      expect(store.tabs.value.length).toBe(2);
      expect(store.tabs.value.some((t) => t.id === a.id)).toBe(true); // page tab kept
      expect(store.tabs.value.some((t) => t.id === b.id)).toBe(true);
      expect(store.tabs.value.some((t) => t.id === c.id)).toBe(false);
      expect(store.activeId.value).toBe(b.id);
      expect(store.tabMenu.value).toBeNull();
    });

    it('the tab menu Close button closes a link tab', async () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      const root = mount();
      await waitFor(() => root.querySelector('.rawjson-tabmenu'));
      const menu = root.querySelector('.rawjson-tabmenu');
      const closeBtn = [...menu!.querySelectorAll('button')].find(
        (btn) => btn.textContent.trim() === 'Close',
      );
      expect(closeBtn).not.toBeUndefined();
      closeBtn!.click();
      rerender(root);
      expect(store.tabs.value.some((t) => t.id === b.id)).toBe(false);
      expect(store.tabMenu.value).toBeNull();
    });

    it('an outside mousedown clears the tab menu', async () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      const root = mount();
      expect(store.tabMenu.value).not.toBeNull();
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await waitFor(() => !store.tabMenu.value);
      expect(store.tabMenu.value).toBeNull();
    });

    it('the page tab context menu never offers Close (it is not closeable)', async () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: a.id, x: 5, y: 5 };
      const root = mount();
      await waitFor(() => root.querySelector('.rawjson-tabmenu'));
      const menu = root.querySelector('.rawjson-tabmenu')!;
      const closeBtn = [...menu.querySelectorAll('button')].find(
        (btn) => btn.textContent.trim() === 'Close',
      );
      expect(closeBtn).toBeUndefined(); // no plain "Close" for the page tab
      // With other tabs present it still offers "Close Other Tabs".
      const closeOthers = [...menu.querySelectorAll('button')].find((btn) =>
        btn.textContent.includes('Close Other Tabs'),
      );
      expect(closeOthers).not.toBeUndefined();
    });

    it('right-clicking the sole default tab opens no menu (nothing to do)', () => {
      store.syncPageTab(null);
      const root = mount();
      const pageTabEl = root.querySelector('.rawjson-tab--page');
      pageTabEl!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(store.tabMenu.value).toBeNull();
    });

    it('setActive clears the tab menu', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      expect(store.tabMenu.value).not.toBeNull();
      store.setActive(a.id);
      expect(store.tabMenu.value).toBeNull();
    });

    it('closeTab clears the tab menu', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      store.tabMenu.value = { id: b.id, x: 5, y: 5 };
      expect(store.tabMenu.value).not.toBeNull();
      store.closeTab(b.id);
      expect(store.tabMenu.value).toBeNull();
    });

    it('page tab has the rawjson-tab--page class and is not draggable', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const root = mount();
      const pageTab = [...root.querySelectorAll('.rawjson-tab')].find((el) =>
        el.textContent.includes('Queue'),
      );
      expect(pageTab!.classList.contains('rawjson-tab--page')).toBe(true);
      expect((pageTab as HTMLElement).draggable).toBe(false);
    });

    it('link tabs have the draggable attribute', () => {
      const a = store.openTab(RES, 'page');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const root = mount();
      const linkTab = [...root.querySelectorAll('.rawjson-tab')].find((el) =>
        el.textContent.includes('Hook'),
      );
      expect((linkTab as HTMLElement).draggable).toBe(true);
    });

    it('dragging a link tab before another reorders them via moveTab', () => {
      const a = store.openTab(RES, 'link');
      store.patchTab(a.id, { original: { id: 1 } });
      const b = store.openTab(RES2, 'link');
      store.patchTab(b.id, { original: { id: 2 } });
      const c = store.openTab(
        { type: 'user', id: '3', apiPath: '/api/v1/users/3', label: 'User' },
        'link',
      );
      store.patchTab(c.id, { original: { id: 3 } });
      expect(store.tabs.value.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
      store.moveTab(c.id, a.id);
      expect(store.tabs.value.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    });
  });

  describe('Copy as curl', () => {
    it('copies a redacted curl for the active resource', async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve());
      (globalThis.navigator as any).clipboard = { writeText };
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      const root = mount();
      root.querySelector<HTMLElement>('.rawjson-curl')!.click();
      await waitFor(() => writeText.mock.calls.length > 0);
      expect(writeText.mock.calls[0][0]).toContain('$ROSSUM_TOKEN');
      expect(writeText.mock.calls[0][0]).toContain('/api/v1/queues/1');
    });

    it('shows a success toast once the clipboard write resolves', async () => {
      (globalThis.navigator as any).clipboard = { writeText: () => Promise.resolve() };
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      const root = mount();
      root.querySelector<HTMLElement>('.rawjson-curl')!.click();
      await waitFor(() => root.querySelector('.rawjson-toast'));
      expect(root.querySelector('.rawjson-toast')!.textContent).toMatch(/curl copied/);
    });

    it('shows a failure toast (not a success one) when the clipboard write rejects', async () => {
      (globalThis.navigator as any).clipboard = {
        writeText: () => Promise.reject(new Error('denied')),
      };
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      const root = mount();
      root.querySelector<HTMLElement>('.rawjson-curl')!.click();
      await waitFor(() => root.querySelector('.rawjson-toast'));
      const text = root.querySelector('.rawjson-toast')!.textContent;
      expect(text).toMatch(/copy failed/i);
      expect(text).not.toMatch(/copied$/);
    });

    it('copies with the live token from the split-button caret menu', async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve());
      (globalThis.navigator as any).clipboard = { writeText };
      api.init('https://elis.rossum.app', 'tok_live_123');
      const t = store.openTab(RES, 'page');
      store.patchTab(t.id, { original: { id: 1 } });
      store.curlMenu.value = true;
      const root = mount();
      const menuBtn = [...root.querySelectorAll('.rawjson-curlmenu button')].find((b) =>
        /live token/i.test(b.textContent),
      );
      expect(menuBtn).not.toBeNull();
      (menuBtn as HTMLElement).click();
      await waitFor(() => writeText.mock.calls.length > 0);
      expect(writeText.mock.calls[0][0]).toContain('tok_live_123');
    });
  });

  it('surfaces a request-bar error via the auto-clearing toast', async () => {
    store.syncPageTab(null);
    const root = mount();
    const input = root.querySelector<HTMLInputElement>('.rawjson-reqbar-input')!;
    // Try to submit an invalid URL to trigger an error
    input.value = 'https://other-org.rossum.app/api/v1/queues/1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => root.querySelector('.rawjson-toast'));
    expect(root.querySelector('.rawjson-toast')).not.toBeNull();
  });
});
