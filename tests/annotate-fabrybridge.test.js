import { describe, it, expect, vi } from 'vitest';
import { streamFabry } from '../src/rossum/annotate/fabryBridge.js';

function fakePort() {
  const p = { _msg: null, _disc: null, posted: [], onMessage: { addListener: (fn) => (p._msg = fn) },
    onDisconnect: { addListener: (fn) => (p._disc = fn) }, postMessage: (m) => p.posted.push(m), disconnect: vi.fn() };
  return p;
}

describe('streamFabry', () => {
  it('sends start and resolves with chatId after parsing events', async () => {
    const port = fakePort();
    const events = [];
    const promise = streamFabry({ token: 't', domain: 'd', content: 'hi', images: [], connect: () => port, onEvent: (e) => events.push(e) });
    expect(port.posted[0]).toEqual({ type: 'start', token: 't', domain: 'd', chatId: undefined, content: 'hi', images: [] });
    port._msg({ type: 'chunk', text: 'data: {"type":"text-delta","delta":"hi"}\n\n' });
    port._msg({ type: 'done', chatId: 'c1' });
    await expect(promise).resolves.toEqual({ chatId: 'c1' });
    expect(events).toContainEqual({ type: 'text-delta', delta: 'hi' });
  });
  it('rejects on error message', async () => {
    const port = fakePort();
    const promise = streamFabry({ token: 't', domain: 'd', content: 'x', connect: () => port, onEvent: () => {} });
    port._msg({ type: 'error', message: 'boom', status: 401 });
    await expect(promise).rejects.toThrow('boom');
  });
});
