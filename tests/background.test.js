import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module registers a chrome.runtime.onMessage listener at import time, so
// stub chrome before importing.
globalThis.chrome = {
  runtime: { onMessage: { addListener: vi.fn() }, id: 'self', getURL: (p) => `chrome-extension://self/${p}` },
  storage: { local: { set: vi.fn() } },
  tabs: { create: vi.fn() },
};

import { openDatasetManagement, handleFabryPort } from '../src/background/index.js';

describe('openDatasetManagement', () => {
  let deps;
  beforeEach(() => {
    deps = {
      storageSet: vi.fn((obj, cb) => cb && cb()),
      tabsCreate: vi.fn(),
      getURL: (p) => `chrome-extension://self/${p}`,
      uuid: () => 'UUID',
      now: () => 1234,
    };
  });

  it('stages a single-use consoleAuth entry with the token + domain + app', () => {
    openDatasetManagement({ token: 'tok', domain: 'https://x.rossum.app' }, deps);
    expect(deps.storageSet).toHaveBeenCalledWith(
      { consoleAuth_UUID: { token: 'tok', domain: 'https://x.rossum.app', app: 'mdh', createdAt: 1234 } },
      expect.any(Function),
    );
  });

  it('opens console.html right next to the requesting tab (after the stage completes)', () => {
    openDatasetManagement(
      { token: 'tok', domain: 'https://x.rossum.app', openerTab: { index: 3, windowId: 7 } },
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

describe('handleFabryPort', () => {
  it('runs a turn and relays chunk+done', async () => {
    const posted = [];
    const port = {
      name: 'annotate-fabry',
      sender: { id: 'self' },
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => (port._msg = fn) },
      onDisconnect: { addListener: () => {} },
    };
    const runFabryTurn = vi.fn(async ({ onChunk }) => { onChunk('data: x\n\n'); return { chatId: 'c1' }; });
    handleFabryPort(port, { extensionId: 'self', runFabryTurn });
    await port._msg({ type: 'start', token: 't', domain: 'https://x.rossum.app', content: 'hi', images: [] });
    expect(posted).toContainEqual({ type: 'chunk', text: 'data: x\n\n' });
    expect(posted).toContainEqual({ type: 'done', chatId: 'c1' });
    const [, args] = runFabryTurn.mock.calls[0];
    expect(runFabryTurn.mock.calls[0][0].headers['X-Rossum-Api-Url']).toBe('https://x.rossum.app/api/v1');
  });
  it('ignores ports from other extensions', () => {
    const port = { name: 'annotate-fabry', sender: { id: 'evil' }, postMessage: () => {}, onMessage: { addListener: () => { throw new Error('should not attach'); } }, onDisconnect: { addListener: () => {} } };
    expect(() => handleFabryPort(port, { extensionId: 'self', runFabryTurn: vi.fn() })).not.toThrow();
  });

  it('rejects a port with a missing sender (fails closed, does not attach a listener)', () => {
    const posted = [];
    const port = {
      name: 'annotate-fabry',
      sender: undefined,
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: () => {} },
    };
    const runFabryTurn = vi.fn();
    handleFabryPort(port, { extensionId: 'self', runFabryTurn });
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
    expect(runFabryTurn).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('relays an error (with status) from a failing runFabryTurn', async () => {
    const posted = [];
    const port = {
      name: 'annotate-fabry',
      sender: { id: 'self' },
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => (port._msg = fn) },
      onDisconnect: { addListener: () => {} },
    };
    const err = new Error('boom');
    err.status = 429;
    const runFabryTurn = vi.fn(async () => { throw err; });
    handleFabryPort(port, { extensionId: 'self', runFabryTurn });
    await port._msg({ type: 'start', token: 't', domain: 'https://x.rossum.app', content: 'hi', images: [] });
    expect(posted).toContainEqual({ type: 'error', message: 'boom', status: 429 });
  });

  it('aborts the signal passed into runFabryTurn when the port disconnects', () => {
    const port = {
      name: 'annotate-fabry',
      sender: { id: 'self' },
      postMessage: () => {},
      onMessage: { addListener: (fn) => (port._msg = fn) },
      onDisconnect: { addListener: (fn) => (port._disconnect = fn) },
    };
    let capturedSignal;
    const runFabryTurn = vi.fn(async ({ signal }) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves
    });
    handleFabryPort(port, { extensionId: 'self', runFabryTurn });
    port._msg({ type: 'start', token: 't', domain: 'https://x.rossum.app', content: 'hi', images: [] });
    expect(capturedSignal.aborted).toBe(false);
    port._disconnect();
    expect(capturedSignal.aborted).toBe(true);
  });
});
