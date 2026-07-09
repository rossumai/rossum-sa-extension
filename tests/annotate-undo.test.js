import { snapKey, saveSnapshot, loadSnapshot, clearSnapshot, runUndo } from '../src/rossum/annotate/undo.js';
import { describe, it, expect, vi } from 'vitest';

function memStore() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }

describe('undo persistence', () => {
  it('save/load/clear round-trips', () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'x', position: null, page: 1 } }, s);
    expect(loadSnapshot(5, s)).toEqual({ 1: { value: 'x', position: null, page: 1 } });
    clearSnapshot(5, s);
    expect(loadSnapshot(5, s)).toBeNull();
  });
  it('saveSnapshot/loadSnapshot/clearSnapshot do not throw when store throws', () => {
    const throwingStore = {
      getItem: () => { throw new Error('store error'); },
      setItem: () => { throw new Error('store error'); },
      removeItem: () => { throw new Error('store error'); },
    };
    expect(() => saveSnapshot(5, { 1: { value: 'x' } }, throwingStore)).not.toThrow();
    expect(loadSnapshot(5, throwingStore)).toBeNull();
    expect(() => clearSnapshot(5, throwingStore)).not.toThrow();
  });
});
describe('runUndo', () => {
  it('restores from snapshot via start→ops→cancel and clears it', async () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'x', position: [0,0,1,1], page: 1 } }, s);
    const post = vi.fn(() => Promise.resolve({ content: [] }));
    const out = await runUndo({ annotationId: 5, deps: { post, store: s }, onProgress: () => {} });
    expect(out.restored).toBe(1);
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/annotations/5/start', '/api/v1/annotations/5/content/operations', '/api/v1/annotations/5/cancel',
    ]);
    expect(loadSnapshot(5, s)).toBeNull();
  });
  it('no-ops when there is no snapshot', async () => {
    const post = vi.fn();
    expect(await runUndo({ annotationId: 9, deps: { post, store: memStore() }, onProgress: () => {} })).toEqual({ restored: 0 });
    expect(post).not.toHaveBeenCalled();
  });
  it('cancel runs in finally block even when ops fails', async () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'x', position: [0,0,1,1], page: 1 } }, s);
    const post = vi.fn(async (path) => {
      if (path.includes('/start')) return { content: [] };
      if (path.includes('/operations')) throw new Error('ops failed');
      if (path.includes('/cancel')) return { content: [] };
    });
    let didReject = false;
    try {
      await runUndo({ annotationId: 5, deps: { post, store: s }, onProgress: () => {} });
    } catch (e) {
      didReject = true;
    }
    expect(didReject).toBe(true);
    const calls = post.mock.calls.map((c) => c[0]);
    expect(calls).toContain('/api/v1/annotations/5/cancel');
    expect(calls.indexOf('/api/v1/annotations/5/start')).toBeLessThan(calls.indexOf('/api/v1/annotations/5/cancel'));
  });
  it('empty snapshot returns {restored:0} and makes no post calls', async () => {
    const s = memStore();
    saveSnapshot(5, {}, s);
    const post = vi.fn();
    const out = await runUndo({ annotationId: 5, deps: { post, store: s }, onProgress: () => {} });
    expect(out).toEqual({ restored: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('runUndo with added rows', () => {
  it('removes added rows and restores field values (remove ops first)', async () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'orig', position: null, page: 1 }, __addedRows: [5001] }, s);
    const calls = [];
    const post = vi.fn((p, body) => { calls.push({ p, body }); return Promise.resolve({ content: [] }); });
    const out = await runUndo({ annotationId: 5, deps: { post, store: s }, onProgress: () => {} });
    expect(out.restored).toBe(2); // 1 remove + 1 restore
    const opsCall = calls.find((c) => c.p.endsWith('/content/operations'));
    expect(opsCall.body.operations).toEqual([
      { op: 'remove', id: 5001 },
      { op: 'replace', id: 1, value: { content: { value: 'orig' } } },
    ]);
    expect(loadSnapshot(5, s)).toBeNull();
  });
});
