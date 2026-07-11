// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({ downloadFile: vi.fn() }));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import ChatHeader from '../src/fabry/components/ChatHeader.jsx';
import FilesStrip from '../src/fabry/components/FilesStrip.jsx';

function mount(Comp) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, null), root);
  return root;
}

beforeEach(() => {
  store.activeChatId.value = 'chat_1';
  store.chats.value = [{ chat_id: 'chat_1', timestamp: 1, message_count: 2, first_message: 'hi', summary: 'Failed exports triage', total_input_tokens: 1200, total_output_tokens: 800 }];
  store.thread.value = [
    { role: 'user', chip: true, text: '/persona cautious', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
  ];
  store.files.value = [{ filename: 'out.csv', size: 2048, timestamp: 't' }];
});

describe('ChatHeader', () => {
  it('shows the band mark, title, persona pill and token stat', () => {
    const root = mount(ChatHeader);
    expect(root.querySelector('.fabry-hd-mark').textContent).toBe('\u2726');
    expect(root.textContent).toContain('Failed exports triage');
    expect(root.querySelector('.fabry-hd-persona').textContent).toBe('Cautious');
    expect(root.querySelector('.fabry-hd-tokens').textContent).toContain('2.0k');
  });
  it('renders nothing without an active chat', () => {
    store.activeChatId.value = null;
    expect(mount(ChatHeader).querySelector('.fabry-hd')).toBeNull();
  });
});

describe('FilesStrip', () => {
  it('lists files and downloads on click', () => {
    const root = mount(FilesStrip);
    expect(root.textContent).toContain('out.csv');
    expect(root.textContent).toContain('2.0 KB');
    root.querySelector('.fabry-file-dl').click();
    expect(chat.downloadFile).toHaveBeenCalledWith('out.csv');
  });
  it('renders nothing when no files', () => {
    store.files.value = [];
    expect(mount(FilesStrip).querySelector('.fabry-files')).toBeNull();
  });
});
