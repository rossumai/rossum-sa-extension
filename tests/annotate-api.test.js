import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getJson, getBase64, postRossumApi } from '../src/rossum/api.js';

beforeEach(() => {
  global.window = { location: { origin: 'https://x.rossum.app' }, localStorage: { getItem: () => 'TKN' } };
});

describe('getJson', () => {
  it('GETs a same-origin api path with the token and returns json', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ a: 1 }) });
    const out = await getJson('/api/v1/annotations/5/content');
    expect(out).toEqual({ a: 1 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.rossum.app/api/v1/annotations/5/content');
    expect(opts.headers.Authorization).toBe('Token TKN');
  });
  it('rejects a non-/api/v1 path', async () => {
    await expect(getJson('/evil')).rejects.toThrow(/Invalid API path/);
  });
  it('throws on non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(getJson('/api/v1/x/1')).rejects.toThrow(/API 403/);
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const e = await getJson('/api/v1/x/1').catch((err) => err);
    expect(e.status).toBe(403);
  });
  it('rejects with .status === 401 on an expired-token response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const e = await getJson('/api/v1/x/1').catch((err) => err);
    expect(e.status).toBe(401);
  });
});

describe('getBase64', () => {
  it('fetches a blob and returns base64 without the data prefix', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    const b64 = await getBase64('/api/v1/pages/9/preview');
    expect(b64).toBe(btoa(String.fromCharCode(1, 2, 3)));
  });
});

describe('postRossumApi', () => {
  it('POSTs json to a same-origin path with the token', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
    const out = await postRossumApi('/api/v1/annotations/5/content/operations', { operations: [] });
    expect(out).toEqual({ ok: 1 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.rossum.app/api/v1/annotations/5/content/operations');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Token TKN');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ operations: [] });
  });
  it('returns {} for a 204 (no body)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) });
    expect(await postRossumApi('/api/v1/annotations/5/cancel', {})).toEqual({});
  });
  it('throws apiError with .status on non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    const e = await postRossumApi('/api/v1/annotations/5/start', {}).catch((x) => x);
    expect(e.status).toBe(409);
  });
  it('rejects a non-/api/v1 path', async () => {
    await expect(postRossumApi('/evil', {})).rejects.toThrow(/Invalid API path/);
  });
});
