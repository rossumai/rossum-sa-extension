// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  sendFeedback: vi.fn(), openChat: vi.fn(), sendMessage: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Thread from '../src/fabry/components/Thread.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(Thread, null), root);
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  store.activeChatId.value = 'chat_1';
  store.threadLoading.value = false;
  store.streaming.value = false;
  store.liveTurn.value = null;
  store.deepPhase.value = null;
  store.thread.value = [
    { role: 'user', chip: true, text: '/persona cautious', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'assistant', chip: false, text: 'Persona set.', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'user', chip: false, text: '**q**', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
    { role: 'assistant', chip: false, text: 'the **answer**', images: [], feedback: true, reasoning: 'thought hard', tools: ['rossum_get_queue'], interrupted: false },
  ];
});

describe('Thread', () => {
  it('renders chips, user turns, assistant markdown, reasoning and tool chips', () => {
    const root = mount();
    expect(root.querySelector('.fabry-turn-chip').textContent).toContain('/persona cautious');
    expect(root.querySelectorAll('.fabry-turn-user').length).toBe(1); // chip is not a user bubble
    expect(root.querySelector('.fabry-turn-assistant .fabry-md strong').textContent).toBe('answer');
    expect(root.querySelector('.fabry-tools').textContent).toContain('reading the queue');
    expect(root.querySelector('.fabry-thinking')).toBeTruthy();
  });
  it('feedback buttons call sendFeedback with the thread index', () => {
    const root = mount();
    const turns = root.querySelectorAll('.fabry-turn-assistant');
    turns[1].querySelector('.fabry-fb-up').click();
    expect(chat.sendFeedback).toHaveBeenCalledWith(3, true);
  });
  it('renders the streaming live turn with a caret and the interrupted refresh row', () => {
    store.streaming.value = true;
    store.liveTurn.value = { reasoning: 'r', text: 'partial', tools: [], status: 'thinking', done: false };
    const root = mount();
    expect(root.querySelector('.fabry-turn-live .fabry-caret')).toBeTruthy();
    store.streaming.value = false;
    store.liveTurn.value = null;
    store.thread.value = [...store.thread.value, { role: 'assistant', chip: false, text: 'par', images: [], feedback: null, reasoning: '', tools: [], interrupted: true }];
    const root2 = mount();
    root2.querySelector('.fabry-refresh').click();
    expect(chat.openChat).toHaveBeenCalledWith('chat_1');
  });
  it('empty new chat shows the greeting with Rossum starter prompts; clicking one sends it', () => {
    store.activeChatId.value = null;
    store.thread.value = [];
    const root = mount();
    expect(root.querySelector('.fabry-greeting')).toBeTruthy();
    const starters = [...root.querySelectorAll('.fabry-starter')];
    expect(starters.length).toBe(4);
    expect(starters[0].textContent).toContain('Map this organization');
    starters[0].click();
    expect(chat.sendMessage).toHaveBeenCalledWith(expect.stringMatching(/overview of this organization/));
  });
  it('shows the deep phase chip while verifying', () => {
    store.streaming.value = true;
    store.liveTurn.value = { reasoning: '', text: 'x', tools: [] };
    store.deepPhase.value = { phase: 'verify', round: 0 };
    const root = mount();
    expect(root.querySelector('.fabry-deep-phase').textContent).toContain('Verifying in a fresh chat');
    store.deepPhase.value = { phase: 'refine', round: 2 };
    const root2 = mount();
    expect(root2.querySelector('.fabry-deep-phase').textContent).toContain('Refining 2/2');
  });
  it('verdict chip renders per state and expands the critic strip', async () => {
    store.thread.value = [
      { role: 'user', chip: false, command: false, text: 'q', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
      { role: 'assistant', chip: false, command: false, text: 'a', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        deep: { verdict: 'fail', issues: ['wrong count'], criticText: 'VERDICT: FAIL\n- wrong count' } },
    ];
    const root = mount();
    const chipEl = root.querySelector('.fabry-deep-chip.fail');
    expect(chipEl.textContent).toContain('1 unresolved issue');
    chipEl.click();
    await flush();
    expect(root.querySelector('.fabry-deep-strip').textContent).toContain('wrong count');
  });
});
