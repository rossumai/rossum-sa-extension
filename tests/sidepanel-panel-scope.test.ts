import { describe, it, expect, vi } from 'vitest';
import {
  SIDE_PANEL_PATH,
  openPanelForTab,
  panelOptionsFor,
  panelUpdateFor,
} from '../src/sidepanel/panelScope.js';
import { syncSidePanelTabs } from '../src/background/index.js';

const R = 'https://org.rossum.app/document/5';

describe('panelOptionsFor', () => {
  it('enables the panel on a Rossum tab, with the path', () => {
    expect(panelOptionsFor(7, R)).toEqual({ tabId: 7, path: SIDE_PANEL_PATH, enabled: true });
    expect(panelOptionsFor(7, 'https://elis.rossum.ai/queues/2').enabled).toBe(true);
    expect(panelOptionsFor(7, 'http://localhost:3000/document/1').enabled).toBe(true);
  });

  it('disables it everywhere else', () => {
    expect(panelOptionsFor(7, 'https://example.com/')).toEqual({ tabId: 7, enabled: false });
    expect(panelOptionsFor(7, 'chrome://newtab/').enabled).toBe(false);
  });

  // A tab we hold no host permission for reports no URL at all. Unknown must
  // mean disabled — never guessed from a title or a pending URL.
  it('disables a tab whose URL is not readable', () => {
    expect(panelOptionsFor(7, undefined)).toEqual({ tabId: 7, enabled: false });
    expect(panelOptionsFor(7, '')).toEqual({ tabId: 7, enabled: false });
  });
});

// These shapes are transcribed from a live recording (Chrome, 2026-08-07) of
// chrome.tabs.onUpdated while a tab navigated into and back out of Rossum.
describe('panelUpdateFor', () => {
  it('enables on a navigation INTO Rossum (url + tab.url both present)', () => {
    const tab = { url: R };
    expect(panelUpdateFor(9, { status: 'loading', url: R }, tab)).toEqual({
      tabId: 9,
      path: SIDE_PANEL_PATH,
      enabled: true,
    });
  });

  // The critical case: leaving for a site we hold no permission for delivers NO
  // url at all. Keying on changeInfo.url would ignore this and leave the tab
  // enabled forever — observed live before the fix.
  it('disables on a navigation AWAY, where no URL is readable', () => {
    expect(panelUpdateFor(9, { status: 'loading' }, { id: 9 })).toEqual({
      tabId: 9,
      enabled: false,
    });
    expect(panelUpdateFor(9, { status: 'complete' }, { id: 9 })).toEqual({
      tabId: 9,
      enabled: false,
    });
  });

  it('ignores title and favicon churn', () => {
    expect(panelUpdateFor(9, { title: 'Rossum' }, { url: R })).toBeNull();
    expect(panelUpdateFor(9, { favIconUrl: 'https://x/f.ico' }, { url: R })).toBeNull();
    expect(panelUpdateFor(9, {}, { url: R })).toBeNull();
  });

  it('trusts tab.url over a stale changeInfo.url', () => {
    expect(
      panelUpdateFor(9, { status: 'complete', url: R }, { url: 'https://example.com/' }),
    ).toEqual({ tabId: 9, enabled: false });
  });
});

describe('syncSidePanelTabs', () => {
  it('enables Rossum tabs, disables the rest, and sets the global default LAST', async () => {
    const setOptions = vi.fn(async (_opts) => {});
    const queryTabs = vi.fn(async () => [
      { id: 1, url: R },
      { id: 2, url: 'https://example.com/' },
      { id: 3 },
    ]);

    await syncSidePanelTabs({ queryTabs, setOptions });

    expect(setOptions.mock.calls.map(([o]) => o)).toEqual([
      { tabId: 1, path: SIDE_PANEL_PATH, enabled: true },
      { tabId: 2, enabled: false },
      { tabId: 3, enabled: false },
      // Global default last: doing it first would briefly close a panel already
      // open on a Rossum tab whose per-tab option is not written yet.
      { enabled: false },
    ]);
  });

  it('skips entries without a numeric tab id', async () => {
    const setOptions = vi.fn(async (_opts) => {});
    const queryTabs = vi.fn(async () => [{ url: R }, null]);

    await syncSidePanelTabs({ queryTabs, setOptions });

    expect(setOptions.mock.calls.map(([o]) => o)).toEqual([{ enabled: false }]);
  });
});

describe('openPanelForTab', () => {
  it('enables the tab before opening it', async () => {
    const order: any = [];
    const api = {
      setOptions: vi.fn(async (o) => {
        order.push(['setOptions', o]);
      }),
      open: vi.fn(async (o) => {
        order.push(['open', o]);
      }),
    };

    await openPanelForTab(42, api);

    expect(order).toEqual([
      ['setOptions', { tabId: 42, path: SIDE_PANEL_PATH, enabled: true }],
      ['open', { tabId: 42 }],
    ]);
  });

  // Opening per TAB rather than per window is what keeps the panel scoped:
  // a window-scoped panel ignores per-tab enablement entirely (verified live).
  it('never opens by windowId', async () => {
    const api = { setOptions: vi.fn(async () => {}), open: vi.fn(async (_o) => {}) };
    await openPanelForTab(42, api);
    expect(api.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(api.open.mock.calls[0][0].windowId).toBeUndefined();
  });
});
