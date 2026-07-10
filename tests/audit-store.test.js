import { describe, it, expect } from 'vitest';
import * as store from '../src/audit/store.js';

describe('audit store — Fabry state', () => {
  it('defaults: aiAvailable false, fabry idle and empty', () => {
    store.resetFabry();
    expect(store.aiAvailable.value).toBe(false);
    expect(store.fabry.value).toEqual({ status: 'idle', chatId: null, turns: [], error: null, forView: null, refreshFailedFor: null });
  });
  it('resetFabry restores the idle default after mutation', () => {
    store.fabry.value = { status: 'done', chatId: 'c1', error: 'x', turns: [{ id: 1, question: null, text: 'hi', reasoning: '', tools: [], state: 'done' }] };
    store.resetFabry();
    expect(store.fabry.value.turns).toEqual([]);
    expect(store.fabry.value.status).toBe('idle');
    expect(store.fabry.value.chatId).toBe(null);
  });
});
