// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

// The suite-wide rAF polyfill (tests/setup.js) is a deliberate no-op, which
// means Preact never flushes useEffect under jsdom. App's refresh-on-mount
// behavior LIVES in an effect, so this file needs a real (immediate) rAF —
// the ui-fabry-mermaid.test.js precedent.
globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(), sendMessage: vi.fn(),
  stopStreaming: vi.fn(), sendFeedback: vi.fn(), downloadFile: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import App from '../src/fabry/components/App.jsx';

function mount(props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(App, props), root);
  return root;
}

describe('Fabry App — chat-list refresh on activation', () => {
  it('remounting with the agent available refreshes the list; first boot (probe pending) does not', async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    store.agentAvailable.value = true;
    mount({ connected: true });
    await flush(); // preact flushes effects on a macrotask
    expect(chat.loadChats).toHaveBeenCalledTimes(1); // re-activation → refresh
    vi.clearAllMocks();
    store.agentAvailable.value = null; // first-ever mount, probe still running
    mount({ connected: true });
    await flush();
    expect(chat.loadChats).not.toHaveBeenCalled(); // initFabry owns the first load
  });
});

describe('Fabry App states', () => {
  beforeEach(() => { store.agentAvailable.value = true; store.error.value = null; });
  it('not connected message', () => {
    expect(mount({ connected: false }).textContent).toContain('Not connected');
  });
  it('agent offline state', () => {
    store.agentAvailable.value = false;
    expect(mount({ connected: true }).textContent).toContain('offline');
  });
  it('connected renders sidebar + main', () => {
    const root = mount({ connected: true });
    expect(root.querySelector('.fabry-sidebar')).toBeTruthy();
    expect(root.querySelector('.fabry-main')).toBeTruthy();
  });
  it('app-level error shows the banner', () => {
    store.error.value = 'Session expired. Reconnect.';
    expect(mount({ connected: true }).querySelector('.fabry-error').textContent).toContain('Session expired');
  });
});
