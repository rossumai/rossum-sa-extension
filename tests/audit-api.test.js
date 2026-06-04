// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/audit/api.js';

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api.init('https://x.rossum.ai', 'tok-123');
});

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('get + buildQuery', () => {
  it('builds a GET request with Authorization and Accept headers', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));
    const qs = api.buildQuery({ page: 2, page_size: 100, object_type: 'annotation', action: 'create' });
    await api.get(`/api/v1/audit_logs/?${qs}`);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/x\.rossum\.ai\/api\/v1\/audit_logs\/\?/);
    const params = new URL(url).searchParams;
    expect(params.get('page')).toBe('2');
    expect(params.get('page_size')).toBe('100');
    expect(params.get('object_type')).toBe('annotation');
    expect(params.get('action')).toBe('create');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('buildQuery omits empty/null params from the query string', () => {
    const qs = api.buildQuery({ object_type: 'annotation', action: '' });
    expect(new URLSearchParams(qs).has('action')).toBe(false);
  });

  it('returns parsed JSON on success', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [{ id: 1 }], pagination: { total: 5 } }));
    const data = await api.get('/api/v1/audit_logs/?object_type=annotation');
    expect(data).toEqual({ results: [{ id: 1 }], pagination: { total: 5 } });
  });

  it('throws a session-expired error with status 401 on 401', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Auth' }, { ok: false, status: 401 }));
    const p = api.get('/api/v1/audit_logs/?object_type=annotation');
    await expect(p).rejects.toThrow(/Session expired/);
    await p.catch((e) => expect(e.status).toBe(401));
  });

  it('marks 403 as featureUnavailable', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Forbidden' }, { ok: false, status: 403 }));
    let caught;
    try { await api.get('/api/v1/audit_logs/?object_type=annotation'); }
    catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(403);
    expect(caught.featureUnavailable).toBe(true);
    expect(caught.message).toBe('Forbidden');
  });

  it('does NOT mark 404 as featureUnavailable', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Bad param' }, { ok: false, status: 404 }));
    let caught;
    try { await api.get('/api/v1/audit_logs/?object_type=badtype'); }
    catch (e) { caught = e; }
    expect(caught.status).toBe(404);
    expect(caught.featureUnavailable).toBeUndefined();
  });

  it('extracts DRF field-error arrays into err.fieldErrors', async () => {
    fetchMock.mockResolvedValue(jsonRes(
      { object_type: ['Available options: [\'annotation\', \'document\']'] },
      { ok: false, status: 400 },
    ));
    let caught;
    try { await api.get('/api/v1/audit_logs/?object_type=badtype'); }
    catch (e) { caught = e; }
    expect(caught.fieldErrors).toEqual({
      object_type: ['Available options: [\'annotation\', \'document\']'],
    });
  });

  it('propagates external AbortError untouched', async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    ac.abort();
    await expect(
      api.get('/api/v1/audit_logs/?object_type=annotation', { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('whoami', () => {
  it('hits /api/v1/auth/user/ with the Bearer token', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 1, username: 'sa' }));
    const out = await api.whoami();
    expect(out).toEqual({ id: 1, username: 'sa' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.rossum.ai/api/v1/auth/user/');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
  });
});

import { extractParam, normalizePage } from '../src/audit/api.js';

describe('extractParam', () => {
  it('reads a query param from an absolute URL', () => {
    expect(extractParam('https://x/api/v1/audit_logs?cursor=abc123&page_size=3', 'cursor')).toBe('abc123');
  });
  it('returns null for missing param or bad url', () => {
    expect(extractParam('https://x/api/v1/audit_logs?page_size=3', 'cursor')).toBeNull();
    expect(extractParam(null, 'cursor')).toBeNull();
    expect(extractParam('not a url', 'cursor')).toBeNull();
  });
});

describe('normalizePage', () => {
  it('offset: derives hasPrev from current page, hasNext from next link', () => {
    const p = normalizePage({ total: 43, total_pages: 15, next: 'https://x?page=2', previous: null }, 'offset', 1);
    expect(p).toMatchObject({ total: 43, totalPages: 15, hasNext: true, hasPrev: false, nextCursor: null, prevCursor: null });
    expect(normalizePage({ total: 43, total_pages: 15, next: null, previous: 'https://x?page=1' }, 'offset', 2).hasPrev).toBe(true);
  });
  it('cursor: extracts next/prev cursors and total', () => {
    const p = normalizePage({ total: 238, total_pages: 80, next: 'https://x?cursor=NEXT&include_total=true', previous: null }, 'cursor', 1);
    expect(p).toMatchObject({ total: 238, totalPages: 80, hasNext: true, hasPrev: false, nextCursor: 'NEXT', prevCursor: null });
    const p2 = normalizePage({ next: null, previous: 'https://x?cursor=PREV' }, 'cursor', 1);
    expect(p2).toMatchObject({ hasNext: false, hasPrev: true, nextCursor: null, prevCursor: 'PREV' });
  });
  it('handles a null pagination object', () => {
    expect(normalizePage(null, 'offset', 1)).toMatchObject({ total: null, hasNext: false, hasPrev: false });
  });
});
