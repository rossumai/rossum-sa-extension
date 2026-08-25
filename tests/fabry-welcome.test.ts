// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({ sendMessage: vi.fn().mockResolvedValue(true), stopStreaming: vi.fn() }));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Welcome from '../src/fabry/components/Welcome.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Welcome, null), root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.streaming.value = false;
  store.activeChatId.value = null;
  store.commands.value = [];
  store.deepVerifyAllowed.value = true;
  store.sendError.value = null;
});

describe('Welcome (centered empty state)', () => {
  it('renders the greeting, the composer, and starter pills', () => {
    const root = mount();
    expect(root.querySelector('.fabry-welcome-title')!.textContent).toMatch(/explore/i);
    expect(root.querySelector('.fabry-composer-box textarea.fabry-input')).toBeTruthy(); // the composer is the hero
    const pills = [...root.querySelectorAll('.fabry-welcome-pill')];
    expect(pills.length).toBe(4);
    expect(pills[0].textContent).toContain('Map this organization');
  });
  it('clicking a starter pill sends its full prompt', () => {
    const root = mount();
    root.querySelector<HTMLElement>('.fabry-welcome-pill')!.click();
    expect(chat.sendMessage).toHaveBeenCalledWith(expect.stringMatching(/overview of this organization/));
  });
});
