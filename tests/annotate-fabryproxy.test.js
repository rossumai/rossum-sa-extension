import { describe, it, expect, vi } from 'vitest';
import { runFabryTurn, AGENT_BASE } from '../src/background/fabryProxy.js';

function streamOf(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader: () => ({ read: () => i < chunks.length
    ? Promise.resolve({ value: enc.encode(chunks[i++]), done: false })
    : Promise.resolve({ value: undefined, done: true }) }) };
}

describe('runFabryTurn', () => {
  it('creates a chat, posts content+images, streams chunks', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.endsWith('/chats')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ chat_id: 'c1' }) });
      return Promise.resolve({ ok: true, body: streamOf(['data: {"type":"text-delta","delta":"hi"}\n\n', 'data: [DONE]\n\n']) });
    });
    const chunks = [];
    const out = await runFabryTurn({
      fetchImpl, base: AGENT_BASE, headers: { 'X-Rossum-Token': 't' },
      content: 'hello', images: [{ media_type: 'image/png', data: 'B64' }],
      onChunk: (t) => chunks.push(t),
    });
    expect(out.chatId).toBe('c1');
    expect(calls[0].url).toBe(`${AGENT_BASE}/chats`);
    expect(calls[1].url).toBe(`${AGENT_BASE}/chats/c1/messages`);
    expect(JSON.parse(calls[1].body)).toEqual({ content: 'hello', images: [{ media_type: 'image/png', data: 'B64' }] });
    expect(chunks.join('')).toContain('text-delta');
  });
  it('reuses an existing chatId and omits images when none', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, opts) => { calls.push({ url, body: opts.body }); return Promise.resolve({ ok: true, body: streamOf(['data: [DONE]\n\n']) }); });
    await runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c9', content: 'x', onChunk: () => {} });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({ content: 'x' });
  });
  it('throws on non-ok', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 401 }));
    await expect(runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c', content: 'x', onChunk: () => {} }))
      .rejects.toThrow(/401/);
  });
  it('aborts a stalled stream after the idle window', async () => {
    const neverEnding = { getReader: () => ({ read: () => new Promise(() => {}) }) }; // read never resolves
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body: neverEnding }));
    await expect(runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c', content: 'x', onChunk: () => {}, idleMs: 30 }))
      .rejects.toThrow(/timed out/i);
  }, 2000);
  it('does not time out while chunks keep arriving', async () => {
    // 3 chunks each arriving after ~15ms (< idleMs 40) then done → should complete, not time out.
    let i = 0; const parts = ['a', 'b', 'c'];
    const reader = { read: () => new Promise((res) => setTimeout(() => res(i < parts.length
      ? { value: new TextEncoder().encode(parts[i++]), done: false } : { done: true }), 15)) };
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body: { getReader: () => reader } }));
    const got = [];
    const out = await runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c', content: 'x', onChunk: (t) => got.push(t), idleMs: 40 });
    expect(out.chatId).toBe('c');
    expect(got.join('')).toBe('abc');
  }, 2000);
});
