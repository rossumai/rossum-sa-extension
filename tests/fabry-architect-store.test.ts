import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/fabry/architect/store.js';

beforeEach(() => {
  store.results.value = {};
  store.deliverables.value = [];
  store.activeId.value = null;
});

describe('architect store', () => {
  it('has sane defaults', () => {
    expect(store.deliverables.value).toEqual([]);
    expect(store.activeId.value).toBeNull();
    expect(store.loaded.value).toBe(false);
    expect(store.running.value).toBe(false);
    expect(store.results.value).toEqual({});
  });
  it('setResult merges immutably by id', () => {
    store.setResult('r1', { verdict: 'pass', evidence: 'a', chatId: 'c1', ranAt: 1, stale: false });
    const first = store.results.value;
    store.setResult('r2', { verdict: 'fail', evidence: 'b', chatId: 'c2', ranAt: 2, stale: true });
    expect(Object.keys(store.results.value).sort()).toEqual(['r1', 'r2']);
    expect(store.results.value).not.toBe(first);
  });
  it('clearResults empties; setActive sets the open id', () => {
    store.setResult('r1', { verdict: 'pass', evidence: '', chatId: 'c', ranAt: 1, stale: false });
    store.clearResults();
    expect(store.results.value).toEqual({});
    store.setActive('r9');
    expect(store.activeId.value).toBe('r9');
  });
});
