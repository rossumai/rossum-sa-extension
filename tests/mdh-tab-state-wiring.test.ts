// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// initMdh has heavy side effects; mock the API clients so it doesn't hit the network.
vi.mock('../src/mdh/api.js', () => ({
  init: vi.fn(),
  getOrgId: vi.fn(() => Promise.resolve(1)),
  healthz: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn(() => Promise.resolve(false)),
}));

import { initMdh } from '../src/mdh/index.jsx';
import * as store from '../src/mdh/store.js';
import { activeApp } from '../src/console/store.js';

function stubStorage(seed = {}): any {
  const data = { ...seed };
  globalThis.chrome = ({
    storage: { local: {
      get: vi.fn((keys) => {
        if (typeof keys === 'string') return Promise.resolve(keys in data ? { [keys]: (data as any)[keys] } : {});
        const out = {};
        for (const k of keys) if (k in data) (out as any)[k] = (data as any)[k];
        return Promise.resolve(out);
      }),
      set: vi.fn((obj) => { Object.assign(data, obj); return Promise.resolve(); }),
      remove: vi.fn((k) => { [].concat(k).forEach((key) => delete data[key]); return Promise.resolve(); }),
    } } as any,
  } as any);
  return data;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sessionStorage.clear();
  store.selectedCollection.value = null;
  store.activeView.value = 'collection';
  store.activePanel.value = 'data';
  store.collections.value = [];
  store.connected.value = null;
  activeApp.value = 'mdh';
});

describe('initMdh per-tab navigation state', () => {
  it('prefers the sessionStorage collection over the chrome.storage.local seed', async () => {
    stubStorage({ mdhSelectedCollection: 'A' });
    sessionStorage.setItem('mdhSelectedCollection', JSON.stringify('B'));
    await initMdh();
    expect(store.selectedCollection.value).toBe('B');
  });

  it('falls back to the chrome.storage.local seed when this tab has no session value', async () => {
    stubStorage({ mdhSelectedCollection: 'A' });
    await initMdh();
    expect(store.selectedCollection.value).toBe('A');
  });

  it('writes a collection change to BOTH sessionStorage and chrome.storage.local', async () => {
    const data = stubStorage();
    await initMdh();
    store.selectedCollection.value = 'C';
    await flush();
    expect(JSON.parse(sessionStorage.getItem('mdhSelectedCollection')!)).toBe('C');
    expect(data.mdhSelectedCollection).toBe('C');
  });
});
