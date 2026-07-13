// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
globalThis.cancelAnimationFrame = () => {};

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(), sendMessage: vi.fn(),
  stopStreaming: vi.fn(), sendFeedback: vi.fn(), downloadFile: vi.fn(),
}));
// ArchitectApp pulls actions on mount — stub it to a marker so the wiring test
// stays about the swap, not Architect internals.
vi.mock('../src/fabry/architect/components/ArchitectApp.jsx', () => ({
  default: () => h('div', { class: 'arch-marker' }, 'ARCH'),
}));
vi.mock('../src/fabry/architect/components/ArchitectSidebar.jsx', () => ({
  default: () => h('div', { class: 'arch-side-marker' }, 'SIDE'),
}));

import * as store from '../src/fabry/store.js';
import App from '../src/fabry/components/App.jsx';
import Sidebar from '../src/fabry/components/Sidebar.jsx';

function mount(Comp, props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, props || null), root);
  return root;
}

beforeEach(() => {
  store.agentAvailable.value = true;
  store.error.value = null;
  store.fabryMode.value = 'chat';
  store.chats.value = []; store.chatsTotal.value = null; store.chatsLoading.value = false;
});

describe('App pane swap', () => {
  it('chat mode renders the composer, not the architect pane', () => {
    const root = mount(App, { connected: true });
    expect(root.querySelector('.arch-marker')).toBeNull();
    expect(root.querySelector('.fabry-main')).toBeTruthy();
  });
  it('architect mode renders the architect pane', () => {
    store.fabryMode.value = 'architect';
    const root = mount(App, { connected: true });
    expect(root.querySelector('.arch-marker')).toBeTruthy();
  });
});

describe('Sidebar mode toggle', () => {
  it('renders a Chat/Architect segmented control and switches mode', () => {
    const root = mount(Sidebar);
    const opts = root.querySelectorAll('.fabry-mode-opt');
    expect(opts.length).toBe(2);
    const arch = [...opts].find((o) => /architect/i.test(o.textContent));
    arch.click();
    expect(store.fabryMode.value).toBe('architect');
  });
  it('renders the deliverable sidebar (not the chat list) in architect mode', () => {
    store.fabryMode.value = 'architect';
    const root = mount(Sidebar);
    expect(root.querySelector('.fabry-chatlist')).toBeNull();
    expect(root.querySelector('.arch-side-marker')).toBeTruthy();
    expect(root.querySelector('.fabry-mode')).toBeTruthy();
  });
  it('shows the chat list and New chat in chat mode', () => {
    const root = mount(Sidebar);
    expect(root.querySelector('.fabry-chatlist')).toBeTruthy();
    expect(root.querySelector('.fabry-newchat')).toBeTruthy();
  });
});
