// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import App from '../src/sidepanel/components/App.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const R = 'https://org.rossum.app';
let root: any;
let listeners: any;
let activeTab: any;

function stubChrome() {
  listeners = { activated: [], updated: [] };
  return {
    windows: { getCurrent: vi.fn(async () => ({ id: 7 })) },
    tabs: {
      query: vi.fn(async () => (activeTab ? [activeTab] : [])),
      onActivated: {
        addListener: (fn: any) => listeners.activated.push(fn),
        removeListener: (fn: any) => { listeners.activated = listeners.activated.filter((f: any) => f !== fn); },
      },
      onUpdated: {
        addListener: (fn: any) => listeners.updated.push(fn),
        removeListener: (fn: any) => { listeners.updated = listeners.updated.filter((f: any) => f !== fn); },
      },
    },
    // A token-less context makes the card resolve to a message with no network.
    scripting: {
      executeScript: vi.fn(async () => [{
        result: { token: null, domain: R, annotationId: null, queueId: null },
      }]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.0', version_name: 'test' }) },
  };
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  activeTab = { id: 1, windowId: 7, url: `${R}/document/1250417` };
  vi.stubGlobal('chrome', stubChrome());
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('side panel App', () => {
  it('renders the MDH card and the strip for a Rossum document tab', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.sp-strip')).not.toBeNull();
    expect(root.textContent).toContain('#1250417');
    expect(root.textContent).toContain('MDH on this screen');
  });

  it('offers no pin button in the panel (that button is popup-only)', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.mdh-pin-btn')).toBeNull();
  });

  it('shows the empty state when the active tab is not Rossum', async () => {
    activeTab = { id: 1, windowId: 7, url: 'https://example.com/' };
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('No Rossum tab here'));
    expect(root.querySelector('.mdh-card')).toBeNull();
  });

  it('re-keys the card when the tab navigates to another document', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));
    // Counted on a CARD-only signal: reading mdhProvenanceFilter is the card's
    // mount effect and nothing else does it, so a second read proves a remount.
    // (executeScript would not — the strip's context read also calls it.)
    const mounts = () => vi.mocked(chrome.storage.local.get).mock.calls
      .filter(([key]) => key === 'mdhProvenanceFilter').length;
    // The strip paints the id before the card's mount effect lands, so wait for
    // the FIRST mount — otherwise the baseline is 0 and the initial mount alone
    // would satisfy the assertion.
    await waitFor(() => mounts() === 1);

    activeTab = { id: 1, windowId: 7, url: `${R}/document/999` };
    listeners.updated.forEach((fn: any) => fn(1, { url: activeTab.url }, activeTab));

    await waitFor(() => root.textContent.includes('#999'));
    await waitFor(() => mounts() === 2);
  });

  it('does not remount the card for a URL change within the same document', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));
    const mounts = () => vi.mocked(chrome.storage.local.get).mock.calls
      .filter(([key]) => key === 'mdhProvenanceFilter').length;
    await waitFor(() => mounts() === 1);

    activeTab = { id: 1, windowId: 7, url: `${R}/document/1250417?sidebar=open` };
    listeners.updated.forEach((fn: any) => fn(1, { url: activeTab.url }, activeTab));

    // Wait until the new URL has actually been picked up, then assert the card
    // was NOT rebuilt: a full replay pass is the expensive part and the
    // annotation did not change.
    await waitFor(() => vi.mocked(chrome.tabs.query).mock.calls.length > 1);
    expect(mounts()).toBe(1);
  });

  it('follows a tab switch inside its own window', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));

    activeTab = { id: 2, windowId: 7, url: `${R}/document/555` };
    listeners.activated.forEach((fn: any) => fn({ tabId: 2, windowId: 7 }));

    await waitFor(() => root.textContent.includes('#555'));
  });

  it('ignores tab activity in another window', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));
    const queries = () => vi.mocked(chrome.tabs.query).mock.calls.length;
    const before = queries();

    // Foreign window first, then a legitimate one in OUR window. Waiting on the
    // legitimate switch to land is the condition that proves the foreign event
    // has already been processed (or ignored) — no sleeping on the clock, which
    // this repo bans because it races preact's after-paint effects under load.
    listeners.activated.forEach((fn: any) => fn({ tabId: 9, windowId: 99 }));
    activeTab = { id: 2, windowId: 7, url: `${R}/document/555` };
    listeners.activated.forEach((fn: any) => fn({ tabId: 2, windowId: 7 }));

    await waitFor(() => root.textContent.includes('#555'));
    // Exactly one extra query: the foreign window's event produced none.
    expect(queries()).toBe(before + 1);
  });

  // The panel follows SPA navigation purely through onUpdated — verified live
  // that Chrome fires it with changeInfo.url for pushState AND replaceState, so
  // there is no poll. This is the one gap that closes: with nothing tracked yet,
  // a navigation must still be able to bring the panel back to life.
  // Same measurement that drives the worker: a tab leaving Rossum for a site we
  // hold no permission for reports NO url anywhere, only a status. Gating on
  // changeInfo.url alone would keep the card pinned to a document the user has
  // already navigated away from.
  it('follows a tracked tab that navigates away with no readable URL', async () => {
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('#1250417'));

    activeTab = { id: 1, windowId: 7 };
    listeners.updated.forEach((fn: any) => fn(1, { status: 'loading' }, activeTab));

    await waitFor(() => root.textContent.includes('No Rossum tab here'));
    expect(root.querySelector('.mdh-card')).toBeNull();
  });

  it('falls back to the focused window when windows.getCurrent fails', async () => {
    chrome.windows.getCurrent = vi.fn(async () => { throw new Error('no window'); });
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(root.textContent).toContain('#1250417');
  });

  it('recovers when no tab was resolvable at boot', async () => {
    activeTab = null;
    render(h(App, {}), root);
    await waitFor(() => root.textContent.includes('No Rossum tab here'));
    await waitFor(() => listeners.updated.length > 0);

    activeTab = { id: 4, windowId: 7, url: `${R}/document/321` };
    listeners.updated.forEach((fn: any) => fn(4, { url: activeTab.url }, activeTab));

    await waitFor(() => root.textContent.includes('#321'));
  });

  it('removes its listeners on unmount', async () => {
    render(h(App, {}), root);
    await waitFor(() => listeners.activated.length > 0 && listeners.updated.length > 0);
    render(null, root);
    await waitFor(() => listeners.activated.length === 0 && listeners.updated.length === 0);
  });

  it('reports the open exactly once', async () => {
    render(h(App, {}), root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    const opens = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .filter(([msg]: any) => msg?.name === 'sa_sidepanel_open');
    expect(opens.length).toBe(1);
  });
});
