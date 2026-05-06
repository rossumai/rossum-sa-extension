// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/audit/api.js');

import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';
import { fetchPage } from '../src/audit/query.js';

beforeEach(() => {
  store.results.value = [];
  store.total.value = null;
  store.page.value = 1;
  store.pageSize.value = 50;
  store.filters.value = { object_type: 'annotation', action: '' };
  store.loading.value = false;
  store.error.value = null;
  store.availability.value = 'unknown';
  store.availabilityMessage.value = null;
  store.availabilityStatus.value = null;
  store.expandedRow.value = 'leftover-key'; // verify it gets cleared
  store.constraints.value = { object_type: null, action: {} };
  vi.clearAllMocks();
});

describe('fetchPage — success', () => {
  it('populates results, tags positional _idx, sets total + availability', async () => {
    api.listAuditLogs.mockResolvedValue({
      results: [{ id: 'a' }, { id: 'b' }],
      pagination: { total: 273 },
    });

    await fetchPage();

    expect(store.results.value).toHaveLength(2);
    expect(store.results.value[0]).toMatchObject({ id: 'a', _idx: 0 });
    expect(store.results.value[1]).toMatchObject({ id: 'b', _idx: 1 });
    expect(store.total.value).toBe(273);
    expect(store.availability.value).toBe('available');
    expect(store.error.value).toBeNull();
    expect(store.loading.value).toBe(false);
  });

  it('falls back to res.count when pagination.total is missing', async () => {
    api.listAuditLogs.mockResolvedValue({ results: [], count: 9 });
    await fetchPage();
    expect(store.total.value).toBe(9);
  });

  it('sets total=null when neither pagination.total nor count is present', async () => {
    api.listAuditLogs.mockResolvedValue({ results: [] });
    await fetchPage();
    expect(store.total.value).toBeNull();
  });

  it('clears expandedRow at the start of every fetch', async () => {
    api.listAuditLogs.mockResolvedValue({ results: [] });
    expect(store.expandedRow.value).toBe('leftover-key');
    await fetchPage();
    expect(store.expandedRow.value).toBeNull();
  });

  it('passes filters and pagination to listAuditLogs', async () => {
    store.page.value = 3;
    store.pageSize.value = 100;
    store.filters.value = { object_type: 'document', action: 'update-status' };
    api.listAuditLogs.mockResolvedValue({ results: [] });

    await fetchPage();

    expect(api.listAuditLogs).toHaveBeenCalledWith(expect.objectContaining({
      page: 3,
      pageSize: 100,
      object_type: 'document',
      action: 'update-status',
    }));
  });
});

describe('fetchPage — errors', () => {
  it('non-403 errors set error.value and clear results', async () => {
    api.listAuditLogs.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await fetchPage();

    expect(store.error.value).toBe('boom');
    expect(store.results.value).toEqual([]);
    expect(store.availability.value).toBe('unknown');
  });

  it('403 maps to availability=unavailable, no error banner', async () => {
    const err = Object.assign(new Error('Forbidden'), {
      status: 403,
      featureUnavailable: true,
    });
    api.listAuditLogs.mockRejectedValue(err);

    await fetchPage();

    expect(store.availability.value).toBe('unavailable');
    expect(store.availabilityStatus.value).toBe(403);
    expect(store.error.value).toBeNull();
  });

  it('AbortError is silent — no state change beyond what was set at start', async () => {
    api.listAuditLogs.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await fetchPage();

    // expandedRow was cleared at the top, but error/availability stay where they were.
    expect(store.error.value).toBeNull();
    expect(store.availability.value).toBe('unknown');
  });

  it('records constraint hints from validation errors', async () => {
    const err = Object.assign(new Error('Invalid'), {
      status: 400,
      fieldErrors: {
        action: ['Available options: [\'update-status\', \'create\']'],
      },
    });
    api.listAuditLogs.mockRejectedValue(err);

    await fetchPage();

    expect(store.constraints.value.action.annotation).toEqual(['update-status', 'create']);
  });
});

describe('fetchPage — supersede', () => {
  it('a stale fetch does not overwrite a newer one', async () => {
    let resolveFirst;
    api.listAuditLogs
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ results: [{ id: 'newer' }], pagination: { total: 1 } });

    const stalePromise = fetchPage();
    // Second fetch starts before the first resolves — bumps the queryId.
    await fetchPage();
    expect(store.results.value).toHaveLength(1);
    expect(store.results.value[0].id).toBe('newer');

    // Now resolve the first (stale) call with different data — should be ignored.
    resolveFirst({ results: [{ id: 'stale' }], pagination: { total: 999 } });
    await stalePromise;

    expect(store.results.value[0].id).toBe('newer');
    expect(store.total.value).toBe(1);
  });
});
