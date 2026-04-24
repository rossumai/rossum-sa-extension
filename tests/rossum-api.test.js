// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('fetchRossumApi', () => {
  let fetchRossumApi;

  beforeEach(async () => {
    vi.resetModules();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    // Fresh import so the per-module apiCache is empty.
    const mod = await import('../src/rossum/api.js');
    fetchRossumApi = mod.fetchRossumApi;
  });

  it('sends the secureToken as an Authorization header', async () => {
    window.localStorage.setItem('secureToken', 'secret-abc');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ id: 1 }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const data = await fetchRossumApi('/api/v1/workspaces');

    expect(data).toEqual({ results: [{ id: 1 }] });
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/workspaces', {
      headers: { Authorization: 'Token secret-abc' },
    });
  });

  it('omits the Authorization header when no token is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRossumApi('/api/v1/queues');

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/queues', { headers: {} });
  });

  it('caches responses per path — second call does not hit the network', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRossumApi('/api/v1/labels');
    await fetchRossumApi('/api/v1/labels');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent in-flight requests to the same path', async () => {
    let resolveFetch;
    const fetchSpy = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = () => resolve({
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        });
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const p1 = fetchRossumApi('/api/v1/hooks');
    const p2 = fetchRossumApi('/api/v1/hooks');
    resolveFetch();
    await Promise.all([p1, p2]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on non-OK responses and evicts the failed entry from cache', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: ['ok'] }) });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchRossumApi('/api/v1/users')).rejects.toThrow('API 500');
    // Second call retries (cache was cleared) and now succeeds.
    const data = await fetchRossumApi('/api/v1/users');
    expect(data).toEqual({ results: ['ok'] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts the cache entry when fetch itself rejects', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchRossumApi('/api/v1/organization')).rejects.toThrow('network down');
    await fetchRossumApi('/api/v1/organization');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
