// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(true), stopStreaming: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Composer from '../src/fabry/components/Composer.jsx';
import CommandMenu from '../src/fabry/components/CommandMenu.jsx';

function mount(Comp, props) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Comp, props), root);
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  store.streaming.value = false;
  store.sendError.value = null;
  store.activeChatId.value = null;
  store.personaChoice.value = 'cautious';
  store.deepVerifyAllowed.value = true;
  store.deepMode.value = false;
  store.commands.value = [
    { name: '/persona', description: 'switch persona', argument_suggestions: [{ value: 'cautious', description: 'safe' }] },
    { name: '/list-skills', description: 'skills', argument_suggestions: [] },
  ];
});

describe('Composer', () => {
  it('Enter sends and clears; Shift+Enter does not send', async () => {
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = 'hello'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(chat.sendMessage).toHaveBeenCalledWith('hello', []);
    expect(root.querySelector('textarea').value).toBe('');
  });
  it('Stop does not clobber a newer draft typed while streaming', async () => {
    let resolveSend;
    chat.sendMessage.mockImplementation(() => new Promise((r) => { resolveSend = r; }));
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = 'first question'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    ta.value = 'my NEXT question'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    resolveSend(false); // the user hit Stop → send resolves false
    await flush();
    expect(root.querySelector('textarea').value).toBe('my NEXT question');
  });
  it('keeps the draft when sendMessage fails', async () => {
    chat.sendMessage.mockResolvedValue(false);
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = 'draft'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(root.querySelector('textarea').value).toBe('draft');
  });
  it('shows Stop while streaming and calls stopStreaming', () => {
    store.streaming.value = true;
    const root = mount(Composer, {});
    const stop = root.querySelector('.fabry-stop');
    expect(stop).toBeTruthy();
    stop.click();
    expect(chat.stopStreaming).toHaveBeenCalled();
  });
  it('while streaming: draft stays editable, verbs show above the input, Enter does not send', async () => {
    store.streaming.value = true;
    const root = mount(Composer, {});
    // Verbs share ONE line with the deep toggle (same .fabry-persona row).
    const row = root.querySelector('.fabry-persona');
    expect(row.querySelector('.fabry-working .nl-search-loading')).toBeTruthy();
    expect(row.querySelector('.fabry-deep-toggle')).toBeTruthy();
    expect(row.querySelector('.fabry-persona-seg')).toBeNull(); // picker yields to the verbs while streaming
    const ta = root.querySelector('textarea');
    expect(ta.disabled).toBe(false);
    expect(ta.getAttribute('placeholder')).toMatch(/next message/i);
    ta.value = 'my next question';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(root.querySelector('textarea').value).toBe('my next question');
  });
  it('persona buttons carry descriptive labels', () => {
    const root = mount(Composer, {});
    const seg = [...root.querySelectorAll('.fabry-persona-seg button')];
    expect(seg.map((b) => b.textContent)).toEqual(['Cautious', 'Autonomous']);
    expect(root.querySelector('.fabry-persona-hint').textContent).toMatch(/asks before every write/i);
  });
  it('persona picker renders only for a new chat and flips the signal', () => {
    const root = mount(Composer, {});
    const seg = root.querySelectorAll('.fabry-persona-seg button');
    expect(seg.length).toBe(2);
    seg[1].click();
    expect(store.personaChoice.value).toBe('default');
    store.activeChatId.value = 'chat_1';
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-persona-seg')).toBeNull();
    expect(root2.querySelector('.fabry-persona-hint')).toBeNull();
  });
  it('typing / opens the command menu; inline send error renders', async () => {
    const root = mount(Composer, {});
    const ta = root.querySelector('textarea');
    ta.value = '/li'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.querySelector('.fabry-cmdmenu').textContent).toContain('/list-skills');
    store.sendError.value = 'Rate-limited by the agent — try again shortly.';
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-senderr').textContent).toMatch(/Rate-limited/);
  });
  it('always shows the standing capability notice', () => {
    expect(mount(Composer, {}).querySelector('.fabry-notice').textContent).toMatch(/can .*modif/i);
  });
});

describe('deep verify toggle', () => {
  it('renders when allowed, flips deepMode, hidden when killed', async () => {
    store.deepVerifyAllowed.value = true;
    store.deepMode.value = false;
    const root = mount(Composer, {});
    const btn = root.querySelector('.fabry-deep-toggle');
    expect(btn).toBeTruthy();
    btn.click();
    expect(store.deepMode.value).toBe(true);
    store.deepVerifyAllowed.value = false;
    const root2 = mount(Composer, {});
    expect(root2.querySelector('.fabry-deep-toggle')).toBeNull();
  });
});

describe('CommandMenu', () => {
  it('filters by prefix and picks with arguments', () => {
    const onPick = vi.fn();
    const root = mount(CommandMenu, { query: '/pe', commands: store.commands.value, onPick });
    const rows = [...root.querySelectorAll('.fabry-cmd-row')];
    expect(rows.length).toBe(1);
    rows[0].click();
    expect(onPick).toHaveBeenCalledWith('/persona ');
    const sug = root.querySelector('.fabry-cmd-arg');
    sug.click();
    expect(onPick).toHaveBeenCalledWith('/persona cautious');
  });
});
