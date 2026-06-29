// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildOpenTabRequest, openCollectionTab } from '../src/mdh/openCollectionTab.js';
import * as store from '../src/mdh/store.js';

beforeEach(() => {
  store.token.value = 'tok';
  store.domain.value = 'https://x.rossum.app';
});

describe('buildOpenTabRequest', () => {
  it('builds the consoleAuth staging key, entry, and console URL', () => {
    const req = buildOpenTabRequest({
      token: 'tok', domain: 'https://x.rossum.app', collection: 'vendors', uuid: 'u1', now: 123,
    });
    expect(req).toEqual({
      authKey: 'consoleAuth_u1',
      authEntry: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', pendingCollection: 'vendors', createdAt: 123 },
      url: 'console/console.html?authId=u1',
    });
  });
});

function stubDeps(overrides = {}) {
  return {
    uuid: () => 'u1',
    now: () => 123,
    getURL: (p) => 'chrome-extension://abc/' + p,
    storageSet: vi.fn(() => Promise.resolve()),
    getCurrentTab: () => Promise.resolve({ index: 3, windowId: 7 }),
    tabsCreate: vi.fn(),
    ...overrides,
  };
}

describe('openCollectionTab', () => {
  it('stages the entry and opens a tab next to the current one', async () => {
    const deps = stubDeps();
    await openCollectionTab('vendors', deps);
    expect(deps.storageSet).toHaveBeenCalledWith({
      consoleAuth_u1: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', pendingCollection: 'vendors', createdAt: 123 },
    });
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/console/console.html?authId=u1', index: 4, windowId: 7,
    });
  });

  it('no-ops when not connected (no token/domain)', async () => {
    store.token.value = '';
    const deps = stubDeps();
    await openCollectionTab('vendors', deps);
    expect(deps.storageSet).not.toHaveBeenCalled();
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });

  it('no-ops when collection is falsy', async () => {
    const deps = stubDeps();
    await openCollectionTab('', deps);
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });

  it('still opens the tab (without positioning) when getCurrentTab rejects', async () => {
    const deps = stubDeps({ getCurrentTab: () => Promise.reject(new Error('no tab')) });
    await openCollectionTab('vendors', deps);
    expect(deps.tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://abc/console/console.html?authId=u1' });
  });
});
