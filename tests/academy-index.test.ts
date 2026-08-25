// tests/academy-index.test.js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initAcademy } from '../src/academy/index.jsx';
import * as store from '../src/academy/store.js';

beforeEach(() => {
  sessionStorage.clear();
  store.setOrigin('');
  store.connected.value = null;
  store.error.value = null;
  store.progress.value = null;
  store.activeMissionId.value = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn() },
    } as any,
  } as any;
});

describe('initAcademy', () => {
  it('fails closed when there is no console domain: connected=false, a clear error, and no storage read', async () => {
    await initAcademy();
    expect(store.connected.value).toBe(false);
    expect(store.error.value).toMatch(/Console/i);
    // refreshProgress() would call chrome.storage.local.get (via readProgress) —
    // proving it never ran, not just that the signals happen to look right.
    expect(globalThis.chrome.storage.local.get).not.toHaveBeenCalled();
    expect(store.progress.value).toBe(null);
    expect(store.getOrigin()).toBe('');
  });

  it('connects normally when a console domain is present', async () => {
    sessionStorage.setItem('consoleDomain', 'https://x.rossum.app');
    await initAcademy();
    expect(store.connected.value).toBe(true);
    expect(store.error.value).toBe(null);
    expect(store.getOrigin()).toBe('https://x.rossum.app');
    expect(globalThis.chrome.storage.local.get).toHaveBeenCalled();
  });
});
