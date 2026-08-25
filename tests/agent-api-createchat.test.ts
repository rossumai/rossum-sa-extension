import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as agentApi from '../src/agent/agentApi.js';

beforeEach(() => { agentApi.init('https://x.rossum.app', 'tok'); });

describe('createChat write opt-in', () => {
  it('sends an empty body by default (read-only, unchanged)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ chat_id: 'c1' }) });
    global.fetch = fetchMock;
    await agentApi.createChat();
    expect(fetchMock.mock.calls[0][1].body).toBe('{}');
  });
  it('streamMessage puts mcp_mode in the message body when mcpMode is set', async () => {
    let body: any;
    global.fetch = vi.fn().mockImplementation((url, init) => { body = init.body; return Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) } }); });
    await agentApi.streamMessage('c1', 'hello', { mcpMode: 'read-write' });
    expect(JSON.parse(body)).toEqual({ content: 'hello', mcp_mode: 'read-write' });
  });
  it('streamMessage omits mcp_mode by default (read-only)', async () => {
    let body: any;
    global.fetch = vi.fn().mockImplementation((url, init) => { body = init.body; return Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) } }); });
    await agentApi.streamMessage('c1', 'hi');
    expect(JSON.parse(body)).toEqual({ content: 'hi' });
  });
});
