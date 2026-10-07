// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import App from '../src/popup/components/App.jsx';

async function waitFor(cond: any, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let state: any;
beforeEach(() => {
  state = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...state })),
        set: vi.fn(async (obj) => Object.assign(state, obj)),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    } as any,
    tabs: { query: vi.fn(async () => []), reload: vi.fn() },
    runtime: {
      getManifest: () => ({ version: '1.0', version_name: 'test' }),
      getURL: (p: any) => `chrome-extension://test-id/${p}`,
      sendMessage: vi.fn(),
    },
    // Token-less Rossum tab: every in-page reader resolves here with no network.
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            token: null,
            domain: 'https://org.rossum.app',
            annotationId: null,
            queueId: null,
          },
        },
      ]),
    },
  } as any;
  document.body.innerHTML = '';
});

afterEach(() => {
  render(null, document.body);
});

const ROSSUM_TAB = { id: 2, url: 'https://org.rossum.app/documents' };

async function mountApp(seed: any) {
  // usageAsked: keep the unrelated consent overlay from writing to storage.
  Object.assign(state, { usageAsked: true }, seed);
  render(<App tab={ROSSUM_TAB} />, document.body);
  await waitFor(() => document.body.querySelector('#orgNameEnabled'));
}

describe('org name toggle', () => {
  it('is on when it has never been set — the org name defaults on', async () => {
    await mountApp({});
    const box = document.body.querySelector<HTMLInputElement>('#orgNameEnabled')!;
    expect(box.checked).toBe(true);
  });

  it('still shows on when the storage read fails', async () => {
    // The content script reads a missing key as on, so the switch must too.
    (chrome.storage.local.get as any).mockImplementation(async (keys: unknown) => {
      if (Array.isArray(keys) && keys.includes('orgNameEnabled')) throw new Error('storage');
      return { ...state };
    });
    await mountApp({});
    const box = document.body.querySelector<HTMLInputElement>('#orgNameEnabled')!;
    expect(box.checked).toBe(true);
  });

  it('reads an explicit off', async () => {
    // chrome.storage.local.get([keys]) returns only the keys asked for: a toggle
    // missing from the popup's read list would render on for ever.
    await mountApp({ orgNameEnabled: false });
    const box = document.body.querySelector<HTMLInputElement>('#orgNameEnabled')!;
    await waitFor(() => !box.checked);
    expect(box.checked).toBe(false);
  });

  it('stores false and reloads the tab so the content script picks it up', async () => {
    await mountApp({});
    const box = document.body.querySelector<HTMLInputElement>('#orgNameEnabled')!;
    box.click();
    await waitFor(() => (chrome.tabs.reload as any).mock.calls.length > 0);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ orgNameEnabled: false });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(2);
  });
});
