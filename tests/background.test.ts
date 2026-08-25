import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module registers a chrome.runtime.onMessage listener at import time, so
// stub chrome before importing.
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: vi.fn() },
    id: 'self',
    getURL: (p: any) => `chrome-extension://self/${p}`,
  } as any,
  storage: { local: { set: vi.fn() } } as any,
  tabs: { create: vi.fn() },
} as any;

import { openDatasetManagement } from '../src/background/index.js';

describe('openDatasetManagement', () => {
  let deps: any;
  beforeEach(() => {
    deps = {
      storageSet: vi.fn((obj, cb) => cb && cb()),
      tabsCreate: vi.fn(),
      getURL: (p: any) => `chrome-extension://self/${p}`,
      uuid: () => 'UUID',
      now: () => 1234,
    };
  });

  it('stages a single-use consoleAuth entry with the token + domain + app', () => {
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.storageSet).toHaveBeenCalledWith(
      {
        consoleAuth_UUID: {
          token: 'tok',
          domain: 'https://x.rossum.app',
          app: 'mdh',
          createdAt: 1234,
        },
      },
      expect.any(Function),
    );
  });

  it('opens console.html right next to the requesting tab (after the stage completes)', () => {
    openDatasetManagement(
      { token: 'tok', domain: 'https://x.rossum.app', openerTab: { index: 3, windowId: 7 } } as any,
      deps,
    );
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://self/console/console.html?authId=UUID',
      index: 4,
      windowId: 7,
    });
  });

  it('opens without a position when there is no opener tab', () => {
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.tabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://self/console/console.html?authId=UUID',
    });
  });

  it('does not open the tab until the auth entry is persisted', () => {
    // storageSet that never invokes its callback → tab must not be created yet.
    deps.storageSet = vi.fn();
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });
});
