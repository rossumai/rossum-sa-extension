import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as agentApi from '../src/mdh/agent/agentApi.js';

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
