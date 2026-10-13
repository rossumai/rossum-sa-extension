import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedHookEntries,
  getCachedSchema,
  setCachedHookEntries,
  setCachedSchema,
} from '../src/popup/cache.js';

// ── src/popup/cache.js — schema-types cache (Task 5) ──────────────────
// This is the popup provenance panel's 5-minute chrome.storage.session
// cache. It needs its own chrome.storage.session mock since tests/setup.js
// does not provide one.

function stubSessionStorage() {
  const data: Record<string, any> = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: (key: any) => Promise.resolve(key in data ? { [key]: (data as any)[key] } : {}),
        set: (obj: any) => {
          Object.assign(data, obj);
          return Promise.resolve();
        },
      },
    } as any,
  } as any;
  return data;
}

describe('popup cache — schema types', () => {
  beforeEach(() => {
    stubSessionStorage();
  });

  it('round-trips schema types per (domain, queue) within TTL', async () => {
    await setCachedSchema('https://d', '7', {
      types: { cust: 'string' },
      lookups: [],
      order: { cust: 0 },
    });
    expect(await getCachedSchema('https://d', '7')).toEqual({
      types: { cust: 'string' },
      lookups: [],
      order: { cust: 0 },
      stale: false,
    });
    expect(await getCachedSchema('https://d', '8')).toBeNull();
  });
});

describe('popup cache — schema v2 key', () => {
  it('ignores a v1 types-only entry, which would hide every lookup field', async () => {
    const data: any = stubSessionStorage();
    data['mdhProv:schemaTypes:v1:https://d#7'] = { types: { a: 'string' }, fetchedAt: Date.now() };
    expect(await getCachedSchema('https://d', '7')).toBeNull();
  });
});

// ── Spec 2026-10-13-api-call-reduction-design.md §4.4 ──
const SIX_MINUTES = 6 * 60 * 1000;

describe('popup cache — hook entries that can be confirmed', () => {
  let data: Record<string, any>;
  beforeEach(() => {
    data = stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a queue with no MDH hook is returned stale, with its hook ids, inside the window', async () => {
    await setCachedHookEntries('https://d', '42', [], { hadHooks: false, hookIds: ['60'] });
    expect(await getCachedHookEntries('https://d', '42')).toEqual({
      entries: [],
      hadHooks: false,
      hookIds: ['60'],
      stale: true,
    });
  });

  it('a queue with no MDH hook expires after 5 minutes too', async () => {
    await setCachedHookEntries('https://d', '42', [], { hadHooks: false, hookIds: ['60'] });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toBeNull();
  });

  it('hooks that exist but do not apply keep the 5-minute window', async () => {
    await setCachedHookEntries('https://d', '42', [], { hadHooks: true, hookIds: ['50'] });
    expect(await getCachedHookEntries('https://d', '42')).toMatchObject({
      hadHooks: true,
      stale: false,
    });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toBeNull();
  });

  it('an entry from before this change is served inside the window and expires after', async () => {
    data['mdhProv:hooks:v3:https://d#42'] = {
      entries: [{ hook: { id: 1, name: 'H' }, cfgs: [] }],
      fetchedAt: Date.now(),
    };
    expect(await getCachedHookEntries('https://d', '42')).toEqual({
      entries: [{ hook: { id: 1, name: 'H' }, cfgs: [] }],
      hadHooks: true,
      hookIds: null,
      stale: false,
    });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toBeNull();
  });
});

describe('popup cache — schema signature', () => {
  beforeEach(() => {
    stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SCHEMA = { types: {}, lookups: [], order: {} };

  it('past the window, an entry with a signature is returned stale', async () => {
    await setCachedSchema('https://d', '42', { ...SCHEMA, sig: '9:s1' });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedSchema('https://d', '42')).toEqual({
      ...SCHEMA,
      sig: '9:s1',
      stale: true,
    });
  });

  it('past the window, an entry without a signature expires as before', async () => {
    await setCachedSchema('https://d', '42', SCHEMA);
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedSchema('https://d', '42')).toBeNull();
  });
});
