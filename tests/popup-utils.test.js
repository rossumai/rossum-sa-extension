// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInTab, openConsoleTab, detectSite, findRossumTabs, activateTab } from '../src/popup/utils.js';

let executeScriptMock;
let storageSetMock;
let tabsCreateMock;
let tabsQueryMock;
let tabsUpdateMock;
let windowsUpdateMock;
let windowCloseSpy;

beforeEach(() => {
  executeScriptMock = vi.fn();
  storageSetMock = vi.fn((_obj, cb) => { cb && cb(); });
  tabsCreateMock = vi.fn();
  tabsQueryMock = vi.fn();
  tabsUpdateMock = vi.fn().mockResolvedValue();
  windowsUpdateMock = vi.fn().mockResolvedValue();
  windowCloseSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
  globalThis.chrome = {
    scripting: { executeScript: executeScriptMock },
    storage: { local: { set: storageSetMock } },
    tabs: { create: tabsCreateMock, query: tabsQueryMock, update: tabsUpdateMock },
    windows: { update: windowsUpdateMock },
    runtime: { getURL: (path) => `chrome-extension://abc/${path}` },
  };
  // Stable UUIDs so we can assert keys.
  let n = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` });
});

describe('runInTab', () => {
  it('forwards tabId, function, and args to chrome.scripting.executeScript', async () => {
    const fn = function () { return 7; };
    executeScriptMock.mockResolvedValue([{ result: 'ok' }]);

    const out = await runInTab(42, fn, ['a', 'b']);

    expect(out).toBe('ok');
    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 42 },
      func: fn,
      args: ['a', 'b'],
    });
  });

  it('returns null when executeScript rejects (no host permission, tab gone, etc.)', async () => {
    executeScriptMock.mockRejectedValue(new Error('Cannot access chrome:// URL'));

    expect(await runInTab(1, () => 1)).toBeNull();
  });

  it('returns null when result frame is missing', async () => {
    executeScriptMock.mockResolvedValue(undefined);
    expect(await runInTab(1, () => 1)).toBeNull();

    executeScriptMock.mockResolvedValue([]);
    expect(await runInTab(1, () => 1)).toBeNull();

    executeScriptMock.mockResolvedValue([{}]);
    expect(await runInTab(1, () => 1)).toBeNull();
  });

  it('passes empty args array by default', async () => {
    executeScriptMock.mockResolvedValue([{ result: null }]);
    await runInTab(1, () => 1);
    expect(executeScriptMock.mock.calls[0][0].args).toEqual([]);
  });
});

describe('openConsoleTab', () => {
  it('stages consoleAuth_<uuid> with the app and opens the console tab', () => {
    const tab = { id: 99, index: 4 };
    const auth = { token: 'tok', domain: 'https://x.rossum.ai' };

    openConsoleTab(tab, auth, 'mdh');

    expect(storageSetMock).toHaveBeenCalledTimes(1);
    const [storageObj] = storageSetMock.mock.calls[0];
    expect(Object.keys(storageObj)).toEqual(['consoleAuth_uuid-1']);
    const entry = storageObj['consoleAuth_uuid-1'];
    expect(entry.token).toBe('tok');
    expect(entry.domain).toBe('https://x.rossum.ai');
    expect(entry.app).toBe('mdh');
    expect(typeof entry.createdAt).toBe('number');

    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=uuid-1',
      index: 5,
    });
  });

  it('stages app:"audit" when opened for the Audit Log Viewer', () => {
    openConsoleTab({ id: 7, index: 2 }, { token: 'a', domain: 'https://x.rossum.app' }, 'audit');
    const entry = storageSetMock.mock.calls[0][0]['consoleAuth_uuid-1'];
    expect(entry.app).toBe('audit');
    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=uuid-1',
      index: 3,
    });
  });

  it('passes through pendingCollection / pendingPipeline metadata', () => {
    openConsoleTab(
      { id: 1, index: 0 },
      { token: 't', domain: 'd', pendingCollection: 'invoices', pendingPipeline: '[]' },
      'mdh',
    );
    const entry = storageSetMock.mock.calls[0][0]['consoleAuth_uuid-1'];
    expect(entry.pendingCollection).toBe('invoices');
    expect(entry.pendingPipeline).toBe('[]');
  });
});

describe('detectSite', () => {
  it('detects Rossum URLs (rossum.ai, rossum.app, r8.lol, localhost:3000)', () => {
    expect(detectSite('https://elis.rossum.ai/queues')).toBe('rossum');
    expect(detectSite('https://test.rossum.app/extensions')).toBe('rossum');
    expect(detectSite('https://foo.r8.lol/x')).toBe('rossum');
    expect(detectSite('http://localhost:3000/queues')).toBe('rossum');
  });

  it('detects NetSuite app URLs', () => {
    expect(detectSite('https://1234.app.netsuite.com/app/center')).toBe('netsuite');
    expect(detectSite('https://1234.app.netsuite.com/login')).toBeNull(); // not /app
  });

  it('detects Coupa cloud and host URLs', () => {
    expect(detectSite('https://acme.coupacloud.com/orders')).toBe('coupa');
    expect(detectSite('https://acme.coupahost.com/invoices')).toBe('coupa');
  });

  it('returns null for unsupported, empty, or malformed input', () => {
    expect(detectSite('https://github.com/')).toBeNull();
    expect(detectSite('https://rossum.ai.evil.com/')).toBeNull();
    expect(detectSite('')).toBeNull();
    expect(detectSite(undefined)).toBeNull();
    expect(detectSite('chrome://newtab/')).toBeNull();
  });
});

describe('findRossumTabs', () => {
  it('returns Rossum tabs only, sorted by lastAccessed descending', async () => {
    tabsQueryMock.mockResolvedValue([
      { id: 1, url: 'https://github.com/', lastAccessed: 100 },
      { id: 2, url: 'https://elis.rossum.ai/queues', lastAccessed: 50 },
      { id: 3, url: 'https://test.rossum.app/x', lastAccessed: 200 },
      { id: 4, url: 'https://acme.coupacloud.com/x', lastAccessed: 999 },
      { id: 5, url: undefined, lastAccessed: 300 }, // redacted, no host perm
    ]);

    const out = await findRossumTabs();
    expect(out.map((t) => t.id)).toEqual([3, 2]);
    expect(tabsQueryMock).toHaveBeenCalledWith({});
  });

  it('returns [] when chrome.tabs.query rejects', async () => {
    tabsQueryMock.mockRejectedValue(new Error('boom'));
    expect(await findRossumTabs()).toEqual([]);
  });

  it('handles tabs without lastAccessed (treats as 0)', async () => {
    tabsQueryMock.mockResolvedValue([
      { id: 1, url: 'https://elis.rossum.ai/' },
      { id: 2, url: 'https://test.rossum.app/', lastAccessed: 5 },
    ]);
    const out = await findRossumTabs();
    expect(out.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe('activateTab', () => {
  it('activates the tab, focuses its window, and closes the popup', async () => {
    await activateTab({ id: 7, windowId: 3 });
    expect(tabsUpdateMock).toHaveBeenCalledWith(7, { active: true });
    expect(windowsUpdateMock).toHaveBeenCalledWith(3, { focused: true });
    expect(windowCloseSpy).toHaveBeenCalled();
  });

  it('skips windows.update when windowId is missing', async () => {
    await activateTab({ id: 9 });
    expect(tabsUpdateMock).toHaveBeenCalledWith(9, { active: true });
    expect(windowsUpdateMock).not.toHaveBeenCalled();
    expect(windowCloseSpy).toHaveBeenCalled();
  });

  it('still closes the popup if tabs.update throws', async () => {
    tabsUpdateMock.mockRejectedValueOnce(new Error('tab gone'));
    await activateTab({ id: 1, windowId: 1 });
    expect(windowCloseSpy).toHaveBeenCalled();
  });
});
