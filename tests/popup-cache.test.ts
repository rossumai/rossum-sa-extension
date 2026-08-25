import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedSchemaTypes, setCachedSchemaTypes } from '../src/popup/cache.js';

// ── src/popup/cache.js — schema-types cache (Task 5) ──────────────────
// This is the popup provenance panel's 5-minute chrome.storage.session
// cache. It needs its own chrome.storage.session mock since tests/setup.js
// does not provide one.

function stubSessionStorage() {
  const data = {};
  globalThis.chrome = ({
    storage: {
      session: {
        get: (key: any) => Promise.resolve(key in data ? { [key]: (data as any)[key] } : {}),
        set: (obj: any) => { Object.assign(data, obj); return Promise.resolve(); },
      },
    } as any,
  } as any);
  return data;
}

describe('popup cache — schema types', () => {
  beforeEach(() => {
    stubSessionStorage();
  });

  it('round-trips schema types per (domain, queue) within TTL', async () => {
    await setCachedSchemaTypes('https://d', '7', { cust: 'string' });
    expect(await getCachedSchemaTypes('https://d', '7')).toEqual({ cust: 'string' });
    expect(await getCachedSchemaTypes('https://d', '8')).toBeNull();
  });
});
