// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn().mockResolvedValue(true),
  createChat: vi.fn().mockResolvedValue('chat_new'),
  listChats: vi.fn().mockResolvedValue({
    chats: [{ chat_id: 'chat_1', timestamp: 1, message_count: 2, first_message: 'hi' }],
    total: 1,
    limit: 50,
    offset: 0,
  }),
  getChat: vi.fn().mockResolvedValue({
    chat_id: 'chat_1',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    created_at: 'x',
    files: [{ filename: 'out.csv', size: 3, timestamp: 't' }],
  }),
  listCommands: vi.fn().mockResolvedValue([{ name: '/persona', description: 'd' }]),
  downloadChatFile: vi.fn().mockResolvedValue(new Blob(['x'])),
  streamMessage: vi.fn(),
}));

import * as agentApi from '../src/agent/agentApi.js';
import * as store from '../src/fabry/store.js';
import {
  loadChats,
  openChat,
  sendMessage,
  stopStreaming,
  formatAnswers,
  answerQuestions,
} from '../src/fabry/chat.js';

function streamOk(reply: any) {
  vi.mocked(agentApi.streamMessage).mockImplementation(async (id, content, { onEvent }: any) => {
    onEvent({ type: 'text-delta', delta: reply });
    onEvent({ type: 'finish' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.resetChatView();
  store.chats.value = [];
  store.chatsTotal.value = null;
  store.personaChoice.value = 'cautious';
  store.error.value = null;
  store.sendError.value = null;
  store.streaming.value = false;
  global.chrome = {
    storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } } as any,
  } as any;
});

describe('loadChats / openChat', () => {
  it('fills the sidebar and opens a chat with normalized turns + files', async () => {
    await loadChats();
    expect(store.chats.value.length).toBe(1);
    expect(store.chatsTotal.value).toBe(1);
    await openChat('chat_1');
    expect(store.activeChatId.value).toBe('chat_1');
    expect(store.thread.value.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(store.files.value[0].filename).toBe('out.csv');
  });
  it('404 on a restored chat falls back to the greeting silently', async () => {
    vi.mocked(agentApi.getChat).mockRejectedValueOnce(
      Object.assign(new Error('Agent error 404'), { status: 404 }),
    );
    store.sendError.value = null;
    await openChat('gone_chat', { restore: true });
    expect(store.activeChatId.value).toBeNull(); // greeting, not a dead chat
    expect(store.sendError.value).toBeNull(); // silent
  });
  it('404 on a user-opened chat resets to the greeting with a gentle note', async () => {
    vi.mocked(agentApi.getChat).mockRejectedValueOnce(
      Object.assign(new Error('Agent error 404'), { status: 404 }),
    );
    await openChat('gone_chat');
    expect(store.activeChatId.value).toBeNull();
    expect(store.sendError.value).toMatch(/no longer available/i);
  });
});

describe('sendMessage', () => {
  it('new chat: creates, primes cautious persona, streams, appends turns', async () => {
    streamOk('answer');
    const ok = await sendMessage('question', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).toHaveBeenCalled();
    expect(vi.mocked(agentApi.streamMessage).mock.calls[0][1]).toBe('/persona cautious');
    expect(vi.mocked(agentApi.streamMessage).mock.calls[1][1]).toBe('question');
    const roles = store.thread.value.map((t) => `${t.role}${t.chip ? ':chip' : ''}`);
    expect(roles).toEqual(['user:chip', 'assistant', 'user', 'assistant']);
    expect(store.thread.value.at(-1)!.text).toBe('answer');
    expect(store.streaming.value).toBe(false);
  });
  it('default persona sends no priming turn', async () => {
    store.personaChoice.value = 'default';
    streamOk('a');
    await sendMessage('q', []);
    expect(vi.mocked(agentApi.streamMessage).mock.calls[0][1]).toBe('q');
  });
  it('429 lands in sendError and returns false (draft preserved by composer)', async () => {
    store.personaChoice.value = 'default';
    vi.mocked(agentApi.streamMessage).mockRejectedValue(
      Object.assign(new Error('Agent error 429'), { status: 429 }),
    );
    const ok = await sendMessage('q', []);
    expect(ok).toBe(false);
    expect(store.sendError.value).toMatch(/rate/i);
  });
  it('passes images through', async () => {
    store.personaChoice.value = 'default';
    streamOk('a');
    await sendMessage('look', [{ media_type: 'image/png', data: 'AAA=' }]);
    expect(vi.mocked(agentApi.streamMessage).mock.calls[0][2]!.images).toEqual([
      { media_type: 'image/png', data: 'AAA=' },
    ]);
  });
});

describe('stopStreaming', () => {
  it('keeps the partial fold as an interrupted turn', async () => {
    store.personaChoice.value = 'default';
    vi.mocked(agentApi.streamMessage).mockImplementation(
      (id, content, { onEvent, signal }: any) =>
        new Promise((resolve, reject) => {
          onEvent({ type: 'text-delta', delta: 'par' });
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const p = sendMessage('q', []);
    await Promise.resolve();
    stopStreaming();
    await p;
    const last = store.thread.value.at(-1);
    expect(last).toMatchObject({ role: 'assistant', text: 'par', interrupted: true });
  });
});

describe('stale-guard', () => {
  it('a stale sendMessage never pollutes the thread after openChat switches chats mid-stream', async () => {
    store.personaChoice.value = 'default'; // skip priming, one less turn to reason about
    let resolveStream: any;
    let streamStarted: any;
    const streamGate = new Promise((resolve) => {
      streamStarted = resolve;
    });
    vi.mocked(agentApi.streamMessage).mockImplementation(
      (id, content, { onEvent }: any) =>
        new Promise((resolve) => {
          resolveStream = () => {
            onEvent({ type: 'text-delta', delta: 'stale answer' });
            onEvent({ type: 'finish' });
            resolve();
          };
          streamStarted(); // let the test know the stale call is now in flight, blocked on us
        }),
    );

    const sendPromise = sendMessage('stale question', []);
    await streamGate; // sendMessage is now suspended awaiting the (not-yet-resolved) stream

    // User navigates away mid-stream.
    await openChat('chat_1');
    expect(store.activeChatId.value).toBe('chat_1');
    expect(store.thread.value.map((t) => t.role)).toEqual(['user', 'assistant']);

    // Now let the stale stream finish; its turns must never land in the new chat.
    resolveStream();
    const ok = await sendPromise;

    expect(ok).toBe(false);
    expect(store.activeChatId.value).toBe('chat_1');
    expect(store.thread.value.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(
      store.thread.value.some((t) => t.text === 'stale question' || t.text === 'stale answer'),
    ).toBe(false);
    expect(store.streaming.value).toBe(false);
  });
});

describe('deep verify send path', () => {
  function queueStreams(replies: any) {
    // Each call to streamMessage consumes the next scripted reply text.
    let call = 0;
    vi.mocked(agentApi.streamMessage).mockImplementation(async (id, content, { onEvent }: any) => {
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      onEvent({ type: 'text-delta', delta: text });
      onEvent({ type: 'finish' });
    });
  }

  beforeEach(() => {
    store.personaChoice.value = 'default'; // skip main-chat priming for clarity
    store.deepVerifyAllowed.value = true;
    store.deepMode.value = true;
    store.activeChatId.value = 'chat_main';
  });

  it('fail → refine → pass: reviewer chip turn, verdict on the final answer', async () => {
    vi.mocked(agentApi.createChat).mockResolvedValue('chat_critic');
    queueStreams([
      'answer v1', // main
      'ok', // critic priming ack (/persona cautious)
      'VERDICT: FAIL\n- wrong count', // critic verdict 1
      'answer v2', // main refine
      'ok', // critic 2 priming ack
      'VERDICT: PASS', // critic verdict 2
    ]);
    const ok = await sendMessage('how many queues?', []);
    expect(ok).toBe(true);
    const turns = store.thread.value;
    const reviewer = turns.find((t) => t.text.startsWith('[deep-verify reviewer]'));
    expect(reviewer).toMatchObject({ role: 'user', chip: true, command: false });
    const final = turns[turns.length - 1];
    expect(final.role).toBe('assistant');
    expect(final.deep).toMatchObject({ verdict: 'pass' });
    expect(store.deepPhase.value).toBe(null);
    expect(store.streaming.value).toBe(false);
  });

  it('critic failure → answer kept, verdict inconclusive', async () => {
    vi.mocked(agentApi.createChat).mockRejectedValue(
      Object.assign(new Error('Agent error 429'), { status: 429 }),
    );
    queueStreams(['answer v1']);
    const ok = await sendMessage('q', []);
    expect(ok).toBe(true);
    const final = store.thread.value[store.thread.value.length - 1];
    expect(final.deep).toMatchObject({ verdict: 'inconclusive' });
  });

  it('kill switch off → plain single-turn path, no critic chat', async () => {
    store.deepVerifyAllowed.value = false;
    queueStreams(['plain answer']);
    const ok = await sendMessage('q', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).not.toHaveBeenCalled();
    expect(store.thread.value[store.thread.value.length - 1].deep).toBeUndefined();
  });

  it('liveTurn is cleared before the critic phase starts (no phantom duplicate answer)', async () => {
    vi.mocked(agentApi.createChat).mockResolvedValue('chat_critic');
    let capturedLiveTurn: any;
    let capturedStreaming: any;
    let call = 0;
    const replies = ['answer v1', 'ok', 'VERDICT: PASS'];
    vi.mocked(agentApi.streamMessage).mockImplementation(async (id, content, { onEvent }: any) => {
      if (id === 'chat_critic' && capturedLiveTurn === undefined) {
        capturedLiveTurn = store.liveTurn.value;
        capturedStreaming = store.streaming.value;
      }
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      onEvent({ type: 'text-delta', delta: text });
      onEvent({ type: 'finish' });
    });
    const ok = await sendMessage('q', []);
    expect(ok).toBe(true);
    expect(capturedLiveTurn).toBe(null);
    expect(capturedStreaming).toBe(true);
  });

  it('stop during the critic phase aborts cleanly with no duplicate turn', async () => {
    vi.mocked(agentApi.createChat).mockResolvedValue('chat_critic');
    let criticStarted: any;
    const criticGate = new Promise((resolve) => {
      criticStarted = resolve;
    });
    vi.mocked(agentApi.streamMessage).mockImplementation(
      (id, content, { onEvent, signal }: any) => {
        if (id === 'chat_main') {
          onEvent({ type: 'text-delta', delta: 'answer v1' });
          onEvent({ type: 'finish' });
          return Promise.resolve();
        }
        // critic phase (priming fold): hangs until the shared controller aborts.
        return new Promise((resolve, reject) => {
          criticStarted();
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    );
    const p = sendMessage('q', []);
    await criticGate; // the send is now suspended inside the critic's (hung) priming call
    stopStreaming();
    const ok = await p;
    expect(ok).toBe(false);
    expect(
      store.thread.value.filter((t) => t.role === 'assistant' && t.text === 'answer v1').length,
    ).toBe(1);
  });
});

describe('formatAnswers', () => {
  it('one question → bare answer', () => {
    expect(formatAnswers([{ question: 'Name?', answer: 'Acme' }])).toBe('Acme');
  });
  it('multiple → numbered question → answer', () => {
    expect(
      formatAnswers([
        { question: 'Name?', answer: 'Acme' },
        { question: 'Scope?', answer: 'All queues' },
      ]),
    ).toBe('1. Name?\n   → Acme\n2. Scope?\n   → All queues');
  });
});

describe('question turns', () => {
  function streamQuestion() {
    vi.mocked(agentApi.streamMessage).mockImplementation(async (id, content, { onEvent }: any) => {
      onEvent({
        type: 'data-agent-question',
        data: { questions: [{ question: 'Name?', options: [], multi_select: false }] },
      });
      onEvent({ type: 'finish' });
    });
  }
  beforeEach(() => {
    store.personaChoice.value = 'default';
    store.activeChatId.value = 'chat_main';
  });

  it('non-deep: pushes an assistant turn carrying questions, no text', async () => {
    store.deepMode.value = false;
    streamQuestion();
    const ok = await sendMessage('draft an email', []);
    expect(ok).toBe(true);
    const last = store.thread.value.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.questions).toEqual([{ question: 'Name?', options: [], multi_select: false }]);
    expect(last.text).toBe('');
  });

  it('deep mode: a question turn is NOT verified (no verdict, no critic chat)', async () => {
    store.deepMode.value = true;
    store.deepVerifyAllowed.value = true;
    streamQuestion();
    const ok = await sendMessage('draft an email', []);
    expect(ok).toBe(true);
    expect(agentApi.createChat).not.toHaveBeenCalled(); // no critic chat
    expect(store.thread.value.at(-1)!.deep).toBeUndefined();
  });

  it('answerQuestions sends the formatted answer as a normal message', async () => {
    store.deepMode.value = false;
    vi.mocked(agentApi.streamMessage).mockImplementation(async (id, content, { onEvent }: any) => {
      onEvent({ type: 'text-delta', delta: 'ok' });
      onEvent({ type: 'finish' });
    });
    await answerQuestions([{ question: 'Name?', answer: 'Acme' }]);
    expect(vi.mocked(agentApi.streamMessage).mock.calls.at(-1)![1]).toBe('Acme');
  });
});
