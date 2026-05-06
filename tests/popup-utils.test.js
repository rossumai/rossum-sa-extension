// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInTab, openMdhTab, openAuditTab } from '../src/popup/utils.js';

let executeScriptMock;
let storageSetMock;
let tabsCreateMock;

beforeEach(() => {
  executeScriptMock = vi.fn();
  storageSetMock = vi.fn((_obj, cb) => { cb && cb(); });
  tabsCreateMock = vi.fn();
  globalThis.chrome = {
    scripting: { executeScript: executeScriptMock },
    storage: { local: { set: storageSetMock } },
    tabs: { create: tabsCreateMock },
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

describe('openMdhTab', () => {
  it('stages auth under a uuid key, opens mdh tab next to source tab', () => {
    const tab = { id: 99, index: 4 };
    const auth = { token: 'tok', domain: 'https://x.rossum.ai' };

    openMdhTab(tab, auth);

    // Storage write happens first; the storage callback fires chrome.tabs.create.
    expect(storageSetMock).toHaveBeenCalledTimes(1);
    const [storageObj] = storageSetMock.mock.calls[0];
    expect(Object.keys(storageObj)).toEqual(['mdhAuth_uuid-1']);
    const entry = storageObj['mdhAuth_uuid-1'];
    expect(entry.token).toBe('tok');
    expect(entry.domain).toBe('https://x.rossum.ai');
    expect(typeof entry.createdAt).toBe('number');

    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/mdh/mdh.html?authId=uuid-1',
      index: 5,
    });
  });

  it('passes through pendingCollection / pendingPipeline metadata', () => {
    openMdhTab(
      { id: 1, index: 0 },
      { token: 't', domain: 'd', pendingCollection: 'invoices', pendingPipeline: '[]' },
    );
    const entry = storageSetMock.mock.calls[0][0]['mdhAuth_uuid-1'];
    expect(entry.pendingCollection).toBe('invoices');
    expect(entry.pendingPipeline).toBe('[]');
  });
});

describe('openAuditTab', () => {
  it('stages auth under auditAuth_<uuid> and opens audit tab', () => {
    openAuditTab({ id: 7, index: 2 }, { token: 'a', domain: 'https://x.rossum.app' });

    const [storageObj] = storageSetMock.mock.calls[0];
    expect(Object.keys(storageObj)).toEqual(['auditAuth_uuid-1']);
    const entry = storageObj['auditAuth_uuid-1'];
    expect(entry.token).toBe('a');
    expect(entry.domain).toBe('https://x.rossum.app');

    expect(tabsCreateMock).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/audit/audit.html?authId=uuid-1',
      index: 3,
    });
  });
});
