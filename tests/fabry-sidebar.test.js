// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  loadChats: vi.fn(), openChat: vi.fn(), startNewChat: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Sidebar from '../src/fabry/components/Sidebar.jsx';

const flush = () => new Promise((r) => setTimeout(r, 0));

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Sidebar, null), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.chats.value = [
    { chat_id: 'chat_1', timestamp: 1760000000, message_count: 4, first_message: 'find failed exports', summary: 'Failed exports triage' },
    { chat_id: 'chat_2', timestamp: 1760000000, message_count: 1, first_message: 'hello' },
  ];
  store.chatsTotal.value = 10;
  store.activeChatId.value = 'chat_2';
  store.chatsLoading.value = false;
  store.sidebarOpen.value = true;
});

describe('Sidebar', () => {
  it('renders rows with title fallback chain and marks the active one', () => {
    const root = mount();
    const rows = [...root.querySelectorAll('.fabry-chat-row')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Failed exports triage'); // summary wins
    expect(rows[1].textContent).toContain('hello'); // first_message fallback
    expect(rows[1].classList.contains('active')).toBe(true);
  });
  it('clicking a row opens it; New chat resets', () => {
    const root = mount();
    root.querySelectorAll('.fabry-chat-row')[0].click();
    expect(chat.openChat).toHaveBeenCalledWith('chat_1');
    root.querySelector('.fabry-newchat').click();
    expect(chat.startNewChat).toHaveBeenCalled();
  });
});

describe('Sidebar — collapse', () => {
  it('collapsed variant hides the list and expands on toggle', () => {
    store.sidebarOpen.value = false;
    const root = mount();
    const aside = root.querySelector('.fabry-sidebar');
    expect(aside.classList.contains('collapsed')).toBe(true);
    expect(root.querySelector('.fabry-chatlist')).toBeNull();
    root.querySelector('.fabry-sidebar-toggle').click();
    expect(store.sidebarOpen.value).toBe(true);
  });
  it('expanded variant shows a collapse toggle and an icon New chat when collapsed', () => {
    const root = mount();
    const toggle = root.querySelector('.fabry-sidebar-toggle');
    expect(toggle.getAttribute('title')).toBe('Collapse chat list');
    toggle.click();
    expect(store.sidebarOpen.value).toBe(false);
    const root2 = mount();
    const newBtn = root2.querySelector('.fabry-newchat.icon');
    expect(newBtn).toBeTruthy();
    newBtn.click();
    expect(chat.startNewChat).toHaveBeenCalled();
  });
});

describe('Sidebar — infinite scroll', () => {
  it('scrolling near the bottom loads older chats (no button)', () => {
    store.chatsTotal.value = 50; // more than loaded
    const root = mount();
    expect(root.querySelector('.fabry-loadmore')).toBeNull();
    root.querySelector('.fabry-chatlist').dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(chat.loadChats).toHaveBeenCalledWith({ more: true }); // jsdom zero-geometry = near-bottom
  });
  it('does not load while already loading or when everything is loaded', () => {
    store.chatsLoading.value = true;
    const root = mount();
    root.querySelector('.fabry-chatlist').dispatchEvent(new Event('scroll', { bubbles: true }));
    store.chatsLoading.value = false;
    store.chatsTotal.value = 2; // all loaded
    const root2 = mount();
    root2.querySelector('.fabry-chatlist').dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(chat.loadChats).not.toHaveBeenCalled();
  });
});

describe('Sidebar — search & resize', () => {
  it('filters loaded chats with highlighted matches and a status line', async () => {
    const root = mount();
    const input = root.querySelector('.fabry-search input');
    input.value = 'failed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    const rows = [...root.querySelectorAll('.fabry-chat-row')];
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('mark').textContent.toLowerCase()).toBe('failed');
    expect(root.querySelector('.fabry-search-status').textContent).toContain('1 of 2');
  });
  it('Escape clears the search', async () => {
    const root = mount();
    const input = root.querySelector('.fabry-search input');
    input.value = 'zzz-no-match';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.querySelectorAll('.fabry-chat-row').length).toBe(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(root.querySelectorAll('.fabry-chat-row').length).toBe(2);
  });
  it('dragging the edge resizes within clamps and persists on mouseup', () => {
    global.chrome = { storage: { local: { set: vi.fn(), get: vi.fn().mockResolvedValue({}) } } };
    store.sidebarWidth.value = 280;
    const root = mount();
    const handle = root.querySelector('.fabry-side-resizer');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 380, bubbles: true }));
    expect(store.sidebarWidth.value).toBe(360);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, bubbles: true }));
    expect(store.sidebarWidth.value).toBe(420); // clamped
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ fabrySidebarWidth: 420 });
  });
});
