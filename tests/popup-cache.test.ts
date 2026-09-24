import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedSchema, setCachedSchema } from '../src/popup/cache.js';

// ── src/popup/cache.js — schema-types cache (Task 5) ──────────────────
// This is the popup provenance panel's 5-minute chrome.storage.session
// cache. It needs its own chrome.storage.session mock since tests/setup.js
// does not provide one.

function stubSessionStorage() {
  const data = {};
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
