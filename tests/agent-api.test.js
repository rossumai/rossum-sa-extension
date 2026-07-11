import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as agentApi from '../src/agent/agentApi.js';

function streamResponse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) },
  };
}

beforeEach(() => { agentApi.init('https://acme.rossum.app', 'tok123'); });
afterEach(() => { vi.restoreAllMocks(); });

describe('probeAgent', () => {
  it('true when healthy', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) });
    expect(await agentApi.probeAgent()).toBe(true);
  });
  it('false on error / throw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net'));
    expect(await agentApi.probeAgent()).toBe(false);
  });
});

describe('createChat', () => {
  it('returns chat_id and sends auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ chat_id: 'chat_1' }) });
    global.fetch = fetchMock;
    expect(await agentApi.createChat()).toBe('chat_1');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-Rossum-Token']).toBe('tok123');
    expect(opts.headers['X-Rossum-Api-Url']).toBe('https://acme.rossum.app/api/v1');
  });
  it('throws with status on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(agentApi.createChat()).rejects.toMatchObject({ status: 401 });
  });
});

describe('streamMessage', () => {
  it('emits parsed events and posts content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"start"}\n\n',
      'data: {"type":"text-delta","delta":"hi"}\n\n',
      'data: [DONE]\n\n',
    ]));
    global.fetch = fetchMock;
    const events = [];
    await agentApi.streamMessage('chat_1', 'hello', { onEvent: (e) => events.push(e.type) });
    expect(events).toEqual(['start', 'text-delta', '__done__']);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats/chat_1/messages');
    expect(JSON.parse(opts.body)).toEqual({ content: 'hello' });
  });
});

describe('streamMessage — error & abort exit paths', () => {
  it('rejects (and cleans up) when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(agentApi.streamMessage('c1', 'hi', { onEvent: () => {} })).rejects.toThrow('boom');
  });

  it('throws with .status on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(agentApi.streamMessage('c1', 'hi', { onEvent: () => {} })).rejects.toMatchObject({ status: 500 });
  });

  it('aborts before fetching when the signal is already aborted', async () => {
    global.fetch = vi.fn().mockImplementation((_u, opts) => {
      if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); }
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } });
    });
    const ac = new AbortController(); ac.abort();
    await expect(agentApi.streamMessage('c1', 'hi', { signal: ac.signal, onEvent: () => {} }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('listChats / getChat / submitFeedback / downloadChatFile', () => {
  it('listChats GETs with pagination and auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chats: [{ chat_id: 'chat_1' }], total: 1, limit: 50, offset: 0 }) });
    global.fetch = fetchMock;
    const out = await agentApi.listChats();
    expect(out.total).toBe(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats?limit=50&offset=0');
    expect(opts.headers['X-Rossum-Token']).toBe('tok123');
  });
  it('listChats throws with status on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(agentApi.listChats()).rejects.toMatchObject({ status: 401 });
  });
  it('getChat returns the detail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chat_id: 'chat_1', messages: [], created_at: 'x', files: [] }) });
    const out = await agentApi.getChat('chat_1');
    expect(out.chat_id).toBe('chat_1');
    expect(global.fetch.mock.calls[0][0]).toContain('/chats/chat_1');
  });
  it('submitFeedback PUTs snake_case body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ turn_index: 2, is_positive: true }) });
    global.fetch = fetchMock;
    await agentApi.submitFeedback('chat_1', 2, true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chats/chat_1/feedback');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ turn_index: 2, is_positive: true });
  });
  it('downloadChatFile returns a blob and URL-encodes the filename', async () => {
    const blob = new Blob(['x']);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    expect(await agentApi.downloadChatFile('chat_1', 'a b.csv')).toBe(blob);
    expect(global.fetch.mock.calls[0][0]).toContain('/chats/chat_1/files/a%20b.csv');
  });
});

describe('listCommands', () => {
  it('returns commands on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ commands: [{ name: '/persona', description: 'd' }] }) });
    expect((await agentApi.listCommands())[0].name).toBe('/persona');
  });
  it('returns [] on failure (degradation, never throws)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net'));
    expect(await agentApi.listCommands()).toEqual([]);
  });
});

describe('streamMessage images option', () => {
  it('adds top-level images only when non-empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(['data: [DONE]\n\n']));
    global.fetch = fetchMock;
    await agentApi.streamMessage('c1', 'look', { onEvent: () => {}, images: [{ media_type: 'image/png', data: 'AAA=' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ content: 'look', images: [{ media_type: 'image/png', data: 'AAA=' }] });
    await agentApi.streamMessage('c1', 'plain', { onEvent: () => {} });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ content: 'plain' });
  });
});
