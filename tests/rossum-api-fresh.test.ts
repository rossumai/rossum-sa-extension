// tests/rossum-api-fresh.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRossumApiFresh } from '../src/rossum/api.js';

beforeEach(() => {
  window.localStorage.setItem('secureToken', 'tok');
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ n: 1 }) })) as any;
});

describe('fetchRossumApiFresh', () => {
  it('sends the page token to a same-origin api path', async () => {
    await fetchRossumApiFresh('/api/v1/queues?page_size=100', { ttlMs: 0 });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${window.location.origin}/api/v1/queues?page_size=100`);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Token tok');
  });

  it('allows the one Data Storage prefix and sends it as a Bearer POST', async () => {
    await fetchRossumApiFresh('/svc/data-storage/api/v1/collections/list', {
      ttlMs: 0,
      method: 'POST',
      body: { nameOnly: true },
      auth: 'bearer',
    });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${window.location.origin}/svc/data-storage/api/v1/collections/list`);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok'); // NOT `Token`
    expect(JSON.parse(init!.body as string)).toEqual({ nameOnly: true });
  });

  it('rejects percent-encoded traversal that would resolve outside the allowlist', async () => {
    // `new URL` decodes %2e%2e into real `..` and normalises it away, so a
    // literal `..` check alone lets this through: it resolves to /admin.
    await expect(fetchRossumApiFresh('/api/v1/%2e%2e/%2e%2e/admin', { ttlMs: 0 })).rejects.toThrow(
      /Invalid API path/,
    );
    await expect(
      fetchRossumApiFresh('/svc/data-storage/api/v1/%2e%2e/other', { ttlMs: 0 }),
    ).rejects.toThrow(/Invalid API path/);
  });

  it('rejects any other service prefix', async () => {
    await expect(fetchRossumApiFresh('/svc/other/thing', { ttlMs: 0 })).rejects.toThrow(
      /Invalid API path/,
    );
    await expect(
      fetchRossumApiFresh('https://evil.example/api/v1/x', { ttlMs: 0 }),
    ).rejects.toThrow();
    await expect(fetchRossumApiFresh('/api/v1/../../x', { ttlMs: 0 })).rejects.toThrow();
  });

  it('serves from cache inside the ttl and re-fetches after it', async () => {
    let now = 1000;
    const clock = () => now;
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    now = 1200;
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not share a cache entry between a GET and a POST on the same path', async () => {
    // Without method/body in the key this collides and the POST is served the
    // GET's response. This path is unique to this test (not reused elsewhere
    // in this file) because the module-level cache is never reset between
    // tests — reusing a path+method+body pair already exercised above (e.g.
    // the Bearer-POST case) would let that earlier entry serve this test's
    // second call within its 10s ttl, masking a real regression.
    const p = '/api/v1/documents';
    await fetchRossumApiFresh(p, { ttlMs: 10_000 });
    await fetchRossumApiFresh(p, {
      ttlMs: 10_000,
      method: 'POST',
      body: { nameOnly: true },
      auth: 'bearer',
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const methods = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => init!.method || 'GET');
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('dedupes concurrent calls for the same path', async () => {
    await Promise.all([
      fetchRossumApiFresh('/api/v1/hooks', { ttlMs: 1000 }),
      fetchRossumApiFresh('/api/v1/hooks', { ttlMs: 1000 }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any;
    await expect(fetchRossumApiFresh('/api/v1/rules', { ttlMs: 1000 })).rejects.toThrow(/API 500/);
    await expect(fetchRossumApiFresh('/api/v1/rules', { ttlMs: 1000 })).rejects.toThrow(/API 500/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
