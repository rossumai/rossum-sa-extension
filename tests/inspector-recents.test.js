import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mergeRecent, recordRecent, loadRecents, clearRecents, MAX_RECENTS } from '../src/inspector/recents.js';
import * as store from '../src/inspector/store.js';

describe('mergeRecent (pure)', () => {
  it('puts a new entry first and coerces id to a string', () => {
    expect(mergeRecent([], { id: 5, fileName: 'a.pdf' })).toEqual([{ id: '5', fileName: 'a.pdf' }]);
  });
  it('dedups by id — a re-inspected annotation moves to the front with fresh metadata', () => {
    const out = mergeRecent([{ id: '1', status: 'x' }, { id: '2', status: 'old' }], { id: '2', status: 'exported' });
    expect(out.map((r) => r.id)).toEqual(['2', '1']);
    expect(out[0].status).toBe('exported');
  });
  it('treats a numeric id and its string form as the same identity', () => {
    expect(mergeRecent([{ id: '7' }], { id: 7 })).toHaveLength(1);
  });
  it('caps at MAX_RECENTS, dropping the oldest', () => {
    const list = Array.from({ length: MAX_RECENTS }, (_, i) => ({ id: String(i) }));
    const out = mergeRecent(list, { id: 'new' });
    expect(out).toHaveLength(MAX_RECENTS);
    expect(out[0].id).toBe('new');
    expect(out.some((r) => r.id === String(MAX_RECENTS - 1))).toBe(false); // oldest fell off
  });
  it('tolerates a null list', () => {
    expect(mergeRecent(null, { id: '1' })).toEqual([{ id: '1' }]);
  });
});

describe('recents persistence (mocked chrome.storage)', () => {
  let setSpy;
  let getSpy;
  let removeSpy;
  beforeEach(() => {
    store.recents.value = [];
    setSpy = vi.fn(() => Promise.resolve());
    getSpy = vi.fn(() => Promise.resolve({ inspectorRecents: [{ id: '9', fileName: 'z.pdf' }] }));
    removeSpy = vi.fn(() => Promise.resolve());
    globalThis.chrome = { storage: { local: { get: getSpy, set: setSpy, remove: removeSpy } } };
  });
  afterEach(() => { delete globalThis.chrome; });

  it('recordRecent updates the signal and persists the merged list', () => {
    recordRecent({ id: 3, fileName: 'a.pdf', at: 1 });
    expect(store.recents.value[0].id).toBe('3');
    expect(setSpy).toHaveBeenCalledWith({ inspectorRecents: store.recents.value });
  });
  it('recordRecent ignores a nullish entry or a missing id', () => {
    recordRecent(null);
    recordRecent({ fileName: 'x' });
    expect(store.recents.value).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });
  it('loadRecents reads the persisted list into the signal', async () => {
    await loadRecents();
    expect(getSpy).toHaveBeenCalledWith('inspectorRecents');
    expect(store.recents.value).toEqual([{ id: '9', fileName: 'z.pdf' }]);
  });
  it('clearRecents empties the signal and removes the key', () => {
    store.recents.value = [{ id: '1' }];
    clearRecents();
    expect(store.recents.value).toEqual([]);
    expect(removeSpy).toHaveBeenCalledWith('inspectorRecents');
  });
});

describe('recents outside an extension context', () => {
  it('recordRecent still updates the signal and never throws without chrome', () => {
    const saved = globalThis.chrome;
    delete globalThis.chrome;
    store.recents.value = [];
    expect(() => recordRecent({ id: '1' })).not.toThrow();
    expect(store.recents.value[0].id).toBe('1');
    if (saved) globalThis.chrome = saved;
  });
});
