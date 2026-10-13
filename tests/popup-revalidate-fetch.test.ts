// tests/popup-revalidate-fetch.test.ts
// Spec 2026-10-13-api-call-reduction-design.md §4.4: the popup's cheap checks.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchQueueHookIds,
  fetchSchemaSig,
  loadMdhHooksForQueue,
  loadSchemaForQueue,
  sameIds,
} from '../src/popup/mdh-provenance.js';

const D = 'https://x.rossum.app';
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const throttled = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchQueueHookIds', () => {
  it("reads the queue's attached hooks as ids from ?fields=hooks", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ hooks: [`${D}/api/v1/hooks/12`, `${D}/api/v1/hooks/7/`] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchQueueHookIds(D, 't', 42)).toEqual(['12', '7']);
    expect(fetchMock.mock.calls[0]).toEqual([
      `${D}/api/v1/queues/42?fields=hooks`,
      expect.anything(),
    ]);
  });

  it('returns [] for a queue with no hooks field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({})),
    );
    expect(await fetchQueueHookIds(D, 't', 42)).toEqual([]);
  });
});

describe('fetchSchemaSig', () => {
  it('reads id:modified_at from the schemas list filtered by queue', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ results: [{ id: 9, modified_at: '2026-07-28T21:16:47Z' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSchemaSig(D, 't', 42)).toBe('9:2026-07-28T21:16:47Z');
    expect(fetchMock.mock.calls[0]).toEqual([`${D}/api/v1/schemas?queue=42`, expect.anything()]);
  });

  it('returns null when the queue lists no schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ results: [] })),
    );
    expect(await fetchSchemaSig(D, 't', 42)).toBeNull();
  });
});

describe('loadSchemaForQueue signature and 429', () => {
  it('asks the schema for id and modified_at and returns them as sig', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/queues/')) return ok({ schema: `${D}/api/v1/schemas/9` });
        return ok({ id: 9, modified_at: 's1', content: [] });
      }),
    );
    const info = await loadSchemaForQueue(D, 't', 42);
    expect(info.sig).toBe('9:s1');
    expect(urls[1]).toBe(`${D}/api/v1/schemas/9?fields=content,id,modified_at`);
  });

  it('rethrows a 429 instead of returning an empty schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => throttled),
    );
    await expect(loadSchemaForQueue(D, 't', 42)).rejects.toMatchObject({ status: 429 });
  });

  it('still returns the empty schema on a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    expect(await loadSchemaForQueue(D, 't', 42)).toEqual({ types: {}, lookups: [], order: {} });
  });
});

describe('loadMdhHooksForQueue onAttached', () => {
  it('reports every attached hook id, MDH or not, active or not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          results: [
            { id: 1, type: 'function', active: true },
            { id: 2, type: 'webhook', active: false },
          ],
        }),
      ),
    );
    let ids: string[] = [];
    const mdh = await loadMdhHooksForQueue(D, 't', 42, (hookIds) => {
      ids = hookIds;
    });
    expect(mdh).toEqual([]);
    expect(ids).toEqual(['1', '2']);
  });
});

describe('sameIds', () => {
  it('ignores order and compares content', () => {
    expect(sameIds(['1', '2'], ['2', '1'])).toBe(true);
    expect(sameIds(['1'], ['1', '2'])).toBe(false);
    expect(sameIds(['1', '3'], ['1', '2'])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});
