// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/inspector/api.js';

function mockFetch(sequence) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  });
}

describe('inspector api', () => {
  beforeEach(() => { api.init('https://api.example.rossum.ai', 'TKN'); });

  it('buildQuery skips null/empty', () => {
    expect(api.buildQuery({ a: 1, b: null, c: '', d: 'x' })).toBe('a=1&d=x');
  });

  it('get attaches Bearer + maps 401 to Session expired', async () => {
    mockFetch([{ status: 401, body: {} }]);
    await expect(api.get('/api/v1/annotations/1')).rejects.toThrow(/Session expired/);
    const [, opts] = globalThis.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer TKN');
  });

  it('get flags 403 as featureUnavailable', async () => {
    mockFetch([{ status: 403, body: { detail: 'no' } }]);
    await expect(api.get('/x')).rejects.toMatchObject({ status: 403, featureUnavailable: true });
  });

  it('listAll follows pagination.next', async () => {
    mockFetch([
      { status: 200, body: { results: [1, 2], pagination: { next: 'https://api.example.rossum.ai/p2' } } },
      { status: 200, body: { results: [3], pagination: { next: null } } },
    ]);
    expect(await api.listAll('/api/v1/notes?annotation=9')).toEqual([1, 2, 3]);
  });

  it('safeListAll swallows 403 to []', async () => {
    mockFetch([{ status: 403, body: {} }]);
    expect(await api.safeListAll('/api/v1/audit_logs')).toEqual([]);
  });

  it('getAnnotation hits the annotation path', async () => {
    mockFetch([{ status: 200, body: { id: 5, status: 'to_review' } }]);
    const a = await api.getAnnotation(5);
    expect(a.id).toBe(5);
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.example.rossum.ai/api/v1/annotations/5');
  });
});
