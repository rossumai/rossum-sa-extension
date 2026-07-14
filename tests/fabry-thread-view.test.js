// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/fabry/chat.js', () => ({
  sendFeedback: vi.fn(), openChat: vi.fn(), sendMessage: vi.fn(), answerQuestions: vi.fn(),
}));

import * as chat from '../src/fabry/chat.js';
import * as store from '../src/fabry/store.js';
import Thread from '../src/fabry/components/Thread.jsx';
import noticeStyles from '../src/ui/fabry/FabryNotice.module.css';
import mdStyles from '../src/ui/fabry/FabryMarkdown.module.css';

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
    expect(root.querySelector('.fabry-turn-assistant .' + mdStyles.md + ' strong').textContent).toBe('answer');
    expect(root.querySelector('.fabry-tools').textContent).toContain('reading the queue');
    expect(root.querySelector('.fabry-thinking')).toBeTruthy();
  });
  it('does not render 👍/👎 feedback buttons (hidden pending backend feedback-id fix), keeps Copy', () => {
    const root = mount();
    const turns = root.querySelectorAll('.fabry-turn-assistant');
    expect(turns[1].querySelector('.fabry-fb-up')).toBeNull();
    expect(turns[1].querySelector('.fabry-fb-down')).toBeNull();
    expect(turns[1].querySelector('.fabry-copy')).toBeTruthy();
  });
  it('renders the streaming live turn with a caret and the interrupted refresh row', () => {
    store.streaming.value = true;
    store.liveTurn.value = { reasoning: 'r', text: 'partial', tools: [], status: 'thinking', done: false };
    const root = mount();
    expect(root.querySelector('.fabry-turn-live .' + mdStyles.caret)).toBeTruthy();
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
  it('renders a question form for a question turn and suppresses feedback', () => {
    store.thread.value = [
      { role: 'user', chip: false, command: false, text: 'draft', images: [], feedback: null, reasoning: '', tools: [], interrupted: false },
      { role: 'assistant', chip: false, command: false, text: '', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        questions: [{ question: 'Name?', options: [], multi_select: false }] },
    ];
    const root = mount();
    expect(root.querySelector('.fabry-q')).toBeTruthy();
    expect(root.querySelector('.fabry-turn-foot')).toBeNull(); // no feedback on a question turn
  });
  it('renders the unsupported-element notice for a text-less unknown turn', () => {
    store.thread.value = [
      { role: 'assistant', chip: false, command: false, text: '', images: [], feedback: null, reasoning: '', tools: [], interrupted: false,
        unhandled: [{ type: 'data-agent-confirmation', data: { prompt: 'ok?' } }] },
    ];
    const root = mount();
    expect(root.querySelector('.' + noticeStyles.warn).textContent).toContain('data-agent-confirmation');
    expect(root.querySelector('.fabry-turn-foot')).toBeNull();
  });
});
