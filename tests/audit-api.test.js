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

describe('listAuditLogs', () => {
  it('builds the GET URL with page, page_size, object_type, and action params', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));

    await api.listAuditLogs({ page: 2, pageSize: 100, object_type: 'annotation', action: 'create' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/x\.rossum\.ai\/api\/v1\/audit_logs\/\?/);
    const qs = new URL(url).searchParams;
    expect(qs.get('page')).toBe('2');
    expect(qs.get('page_size')).toBe('100');
    expect(qs.get('object_type')).toBe('annotation');
    expect(qs.get('action')).toBe('create');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('omits empty/null params from the query string', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));
    await api.listAuditLogs({ object_type: 'annotation', action: '' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.has('action')).toBe(false);
  });

  it('returns parsed JSON on success', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [{ id: 1 }], pagination: { total: 5 } }));
    const data = await api.listAuditLogs({ object_type: 'annotation' });
    expect(data).toEqual({ results: [{ id: 1 }], pagination: { total: 5 } });
  });

  it('throws a session-expired error with status 401 on 401', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Auth' }, { ok: false, status: 401 }));
    const p = api.listAuditLogs({ object_type: 'annotation' });
    await expect(p).rejects.toThrow(/Session expired/);
    await p.catch((e) => expect(e.status).toBe(401));
  });

  it('marks 403 as featureUnavailable', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Forbidden' }, { ok: false, status: 403 }));

    let caught;
    try { await api.listAuditLogs({ object_type: 'annotation' }); }
    catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(403);
    expect(caught.featureUnavailable).toBe(true);
    expect(caught.message).toBe('Forbidden');
  });

  it('does NOT mark 404 as featureUnavailable (regression: bad query params used to be swallowed)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'Bad param' }, { ok: false, status: 404 }));

    let caught;
    try { await api.listAuditLogs({ object_type: 'annotation' }); }
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
    try { await api.listAuditLogs({ object_type: 'badtype' }); }
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
      api.listAuditLogs({ object_type: 'annotation', signal: ac.signal }),
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
