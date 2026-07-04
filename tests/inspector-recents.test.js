// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { viewedRows, enrichRows, loadRecents, enrichRecents, clearRecents, relativeTime, MAX_RECENTS } from '../src/inspector/recents.js';
import { mergeViewed, VIEWED_KEY, MAX_VIEWED } from '../src/inspector/viewed.js';
import * as store from '../src/inspector/store.js';

beforeEach(() => { store.reset(); store.domain.value = 'https://org.example'; });
afterEach(() => { delete globalThis.chrome; });

describe('mergeViewed (pure)', () => {
  it('prepends, dedups by (origin, id), caps', () => {
    const a = { id: 1, origin: 'https://a', at: 1 };
    const out = mergeViewed([{ id: '1', origin: 'https://a', at: 0 }, { id: '1', origin: 'https://b', at: 0 }], a);
    expect(out).toHaveLength(2); // same id on another origin survives
    expect(out[0]).toEqual({ id: '1', origin: 'https://a', at: 1 });
    const many = Array.from({ length: MAX_VIEWED }, (_, i) => ({ id: String(i), origin: 'https://a', at: i }));
    expect(mergeViewed(many, { id: 'new', origin: 'https://a', at: 99 })).toHaveLength(MAX_VIEWED);
  });
  it('tolerates null list and nullish entry', () => {
    expect(mergeViewed(null, { id: 5, origin: 'x', at: 1 })).toHaveLength(1);
    expect(mergeViewed([{ id: '1', origin: 'x' }], null)).toHaveLength(1);
  });
});

describe('viewedRows (pure)', () => {
  const stored = [
    { id: 10, origin: 'https://org.example', at: 5 },
    { id: 11, origin: 'https://other.example', at: 4 },
    { id: 12, origin: 'https://org.example' },
  ];
  it('filters by origin, caps, and shapes id-only rows', () => {
    const rows = viewedRows(stored, 'https://org.example');
    expect(rows.map((r) => r.id)).toEqual(['10', '12']);
    expect(rows[0]).toEqual({ id: '10', fileName: null, queue: null, status: null, at: 5 });
    expect(rows[1].at).toBe(null); // missing timestamp stays honest
  });
  it('caps at MAX_RECENTS and tolerates garbage', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i, origin: 'https://org.example', at: i }));
    expect(viewedRows(many, 'https://org.example')).toHaveLength(MAX_RECENTS);
    expect(viewedRows(null, 'x')).toEqual([]);
    expect(viewedRows([null, { origin: 'x' }], 'x')).toEqual([]);
  });
});

describe('enrichRows (pure)', () => {
  it('joins sideloaded documents/queues by URL; unresolved rows stay id-only', () => {
    const rows = [
      { id: '10', fileName: null, queue: null, status: null, at: 1 },
      { id: '99', fileName: null, queue: null, status: null, at: 2 },
    ];
    const payload = {
      results: [{ id: 10, status: 'to_review', document: 'https://x/api/v1/documents/7', queue: 'https://x/api/v1/queues/3' }],
      documents: [{ url: 'https://x/api/v1/documents/7', original_file_name: 'invoice_10422.pdf' }],
      queues: [{ url: 'https://x/api/v1/queues/3', name: 'AP Invoices' }],
    };
    const out = enrichRows(rows, payload);
    expect(out[0]).toEqual({ id: '10', fileName: 'invoice_10422.pdf', queue: 'AP Invoices', status: 'to_review', at: 1 });
    expect(out[1]).toEqual(rows[1]); // deleted/inaccessible id keeps its honest shape
  });
});

describe('storage-backed flows', () => {
  function chromeMock(seed) {
    const state = { [VIEWED_KEY]: seed };
    globalThis.chrome = { storage: { local: {
      get: vi.fn(async () => ({ ...state })),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    } } };
    return state;
  }
  it('loadRecents reads + filters into the signal', async () => {
    chromeMock([{ id: 1, origin: 'https://org.example', at: 3 }, { id: 2, origin: 'https://elsewhere', at: 2 }]);
    await loadRecents();
    expect(store.recents.value.map((r) => r.id)).toEqual(['1']);
  });
  it('enrichRecents resolves names via the injected api', async () => {
    store.recents.value = [{ id: '1', fileName: null, queue: null, status: null, at: 3 }];
    const api = { listAnnotationsByIds: vi.fn(async () => ({
      results: [{ id: 1, status: 'exported', document: 'https://x/d/1', queue: 'https://x/q/1' }],
      documents: [{ url: 'https://x/d/1', original_file_name: 'a.pdf' }],
      queues: [{ url: 'https://x/q/1', name: 'Q' }],
    })) };
    await enrichRecents(api);
    expect(api.listAnnotationsByIds).toHaveBeenCalledWith(['1']);
    expect(store.recents.value[0].fileName).toBe('a.pdf');
    expect(store.recents.value[0].status).toBe('exported');
  });
  it('enrichRecents failure keeps id-only rows', async () => {
    store.recents.value = [{ id: '1', fileName: null, queue: null, status: null, at: 3 }];
    await enrichRecents({ listAnnotationsByIds: vi.fn(async () => { throw new Error('boom'); }) });
    expect(store.recents.value[0].fileName).toBe(null);
  });
  it('clearRecents clears the signal and only this origin from storage', async () => {
    const state = chromeMock([{ id: 1, origin: 'https://org.example', at: 3 }, { id: 2, origin: 'https://elsewhere', at: 2 }]);
    store.recents.value = [{ id: '1' }];
    clearRecents();
    expect(store.recents.value).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(state[VIEWED_KEY].map((e) => e.origin)).toEqual(['https://elsewhere']);
  });
  it('never throws without chrome', async () => {
    delete globalThis.chrome;
    await expect(loadRecents()).resolves.toBeUndefined();
    expect(() => clearRecents()).not.toThrow();
  });
});

describe('relativeTime', () => {
  const NOW = 1_000_000_000_000;
  it('formats the whole range', () => {
    expect(relativeTime(NOW - 5 * 1000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 12 * 60 * 1000, NOW)).toBe('12 min ago');
    expect(relativeTime(NOW - 2 * 3600 * 1000, NOW)).toBe('2 h ago');
    expect(relativeTime(NOW - 30 * 3600 * 1000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 5 * 24 * 3600 * 1000, NOW)).toBe('5 d ago');
  });
  it('missing/invalid timestamp -> null; future clock skew -> just now', () => {
    expect(relativeTime(undefined, NOW)).toBe(null);
    expect(relativeTime('nope', NOW)).toBe(null);
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });
});
