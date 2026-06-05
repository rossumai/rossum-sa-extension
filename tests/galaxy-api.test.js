// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/galaxy/api.js';

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api.init('https://x.rossum.ai', 'tok-123');
});
function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe('get headers + 401/403', () => {
  it('sends the Bearer token and Accept header', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));
    await api.get('/api/v1/queues/?page_size=100');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.rossum.ai/api/v1/queues/?page_size=100');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers.Accept).toBe('application/json');
  });
  it('throws a 401 session-expired error', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'x' }, { ok: false, status: 401 }));
    await expect(api.get('/api/v1/queues/')).rejects.toMatchObject({ status: 401 });
  });
  it('marks 403 as featureUnavailable', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'no' }, { ok: false, status: 403 }));
    await expect(api.get('/api/v1/queues/')).rejects.toMatchObject({ status: 403, featureUnavailable: true });
  });
});

describe('listAll', () => {
  it('concatenates results across pagination.next pages', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 1 }, { id: 2 }], pagination: { next: 'https://x.rossum.ai/api/v1/queues/?page=2' } }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 3 }], pagination: { next: null } }));
    const all = await api.listAll('/api/v1/queues/?page_size=2');
    expect(all.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[1][0]).toBe('https://x.rossum.ai/api/v1/queues/?page=2');
  });
  it('returns [] for an empty collection', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [], pagination: { next: null } }));
    expect(await api.listAll('/api/v1/connectors/')).toEqual([]);
  });
  it('calls onPage once per page with that page\'s result count', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 1 }, { id: 2 }], pagination: { next: 'https://x.rossum.ai/api/v1/queues/?page=2' } }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 3 }], pagination: { next: null } }));
    const pageCounts = [];
    await api.listAll('/api/v1/queues/?page_size=2', { onPage: (n) => pageCounts.push(n) });
    expect(pageCounts).toEqual([2, 1]);
  });
});

describe('fetchOrgResources', () => {
  it('assembles the raw bundle including engines and tolerates a 403 on one collection', async () => {
    fetchMock.mockImplementation((url) => {
      if (url.includes('/organizations/')) return Promise.resolve(jsonRes({ results: [{ id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme' }], pagination: { next: null } }));
      if (url.includes('/workspaces/')) return Promise.resolve(jsonRes({ results: [{ id: 10 }], pagination: { next: null } }));
      if (url.includes('/queues/')) return Promise.resolve(jsonRes({ results: [{ id: 100 }], pagination: { next: null } }));
      if (url.includes('/hooks/')) return Promise.resolve(jsonRes({ detail: 'forbidden' }, { ok: false, status: 403 }));
      if (url.includes('/engines/')) return Promise.resolve(jsonRes({ results: [{ id: 7, name: 'My Engine', type: 'extractor' }], pagination: { next: null } }));
      return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
    });
    const raw = await api.fetchOrgResources({});
    expect(raw.organization).toMatchObject({ id: 1, name: 'Acme' });
    expect(raw.workspaces).toEqual([{ id: 10 }]);
    expect(raw.queues).toEqual([{ id: 100 }]);
    expect(raw.hooks).toEqual([]);
    expect(raw.engines).toEqual([{ id: 7, name: 'My Engine', type: 'extractor' }]);
  });
  it('rethrows a 401 (session expired) instead of swallowing it', async () => {
    fetchMock.mockResolvedValue(jsonRes({ detail: 'x' }, { ok: false, status: 401 }));
    await expect(api.fetchOrgResources({})).rejects.toMatchObject({ status: 401 });
  });
  it('reports cumulative progress via onProgress as pages arrive (engines count too)', async () => {
    // organizations: 1, workspaces: 2, queues: 3, hooks: 0 (403 → []), engines: 1
    fetchMock.mockImplementation((url) => {
      if (url.includes('/organizations/')) return Promise.resolve(jsonRes({ results: [{ id: 1 }], pagination: { next: null } }));
      if (url.includes('/workspaces/')) return Promise.resolve(jsonRes({ results: [{ id: 10 }, { id: 11 }], pagination: { next: null } }));
      if (url.includes('/queues/')) return Promise.resolve(jsonRes({ results: [{ id: 100 }, { id: 101 }, { id: 102 }], pagination: { next: null } }));
      if (url.includes('/hooks/')) return Promise.resolve(jsonRes({ detail: 'forbidden' }, { ok: false, status: 403 }));
      if (url.includes('/engines/')) return Promise.resolve(jsonRes({ results: [{ id: 7 }], pagination: { next: null } }));
      return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
    });
    const progressValues = [];
    await api.fetchOrgResources({ onProgress: (n) => progressValues.push(n) });
    // onProgress must have been called at least once
    expect(progressValues.length).toBeGreaterThan(0);
    // the final reported value equals total fetched records (1 + 2 + 3 + 1 = 7; hooks 403 → 0)
    expect(progressValues[progressValues.length - 1]).toBe(7);
    // values must be non-decreasing (monotonic)
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });
  it('tolerates a 403 on engines (degrades to empty engines array)', async () => {
    fetchMock.mockImplementation((url) => {
      if (url.includes('/organizations/')) return Promise.resolve(jsonRes({ results: [{ id: 1 }], pagination: { next: null } }));
      if (url.includes('/workspaces/')) return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
      if (url.includes('/queues/')) return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
      if (url.includes('/hooks/')) return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
      if (url.includes('/engines/')) return Promise.resolve(jsonRes({ detail: 'forbidden' }, { ok: false, status: 403 }));
      return Promise.resolve(jsonRes({ results: [], pagination: { next: null } }));
    });
    const raw = await api.fetchOrgResources({});
    expect(raw.engines).toEqual([]);
  });
});
