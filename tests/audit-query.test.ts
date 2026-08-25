// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/audit/api.js');
import * as api from '../src/audit/api.js';
import * as store from '../src/audit/store.js';
import { fetchActive } from '../src/audit/query.js';

// real normalizePage/extractParam via the actual module would be mocked away by
// vi.mock; provide passthrough implementations the query code relies on.
(api as any).normalizePage = (await vi.importActual('../src/audit/api.js')).normalizePage;
(api as any).extractParam = (await vi.importActual('../src/audit/api.js')).extractParam;
(api as any).buildQuery = (await vi.importActual('../src/audit/api.js')).buildQuery;

beforeEach(() => {
  vi.clearAllMocks();
  store.activeSource.value = 'audit';
  store.rows.value = [];
  store.error.value = null;
  store.availability.value = 'unknown';
  store.filtersBySource.value = {
    ...store.filtersBySource.value,
    audit: {
      object_type: 'user',
      action: '',
      object_id: '',
      username: '',
      timestamp_after: '',
      timestamp_before: '',
      page: 1,
      cursor: null,
      pageSize: 50,
      search: '',
    },
  };
});

describe('fetchActive', () => {
  it('cursor source: requests include_total + cursor, tags rows with _idx, sets pageInfo', async () => {
    vi.mocked(api.get).mockResolvedValue({
      results: [{ a: 1 }, { a: 2 }],
      pagination: { total: 238, total_pages: 80, next: 'https://x?cursor=N', previous: null },
    });
    store.patchFilters('audit', { cursor: 'C1' });
    await fetchActive();
    const url = vi.mocked(api.get).mock.calls[0][0];
    expect(url).toContain('/api/v1/audit_logs/?');
    expect(url).toContain('object_type=user');
    expect(url).toContain('include_total=true');
    expect(url).toContain('cursor=C1');
    expect(store.rows.value).toEqual([
      { a: 1, _idx: 0 },
      { a: 2, _idx: 1 },
    ]);
    expect(store.pageInfo.value).toMatchObject({ total: 238, nextCursor: 'N', hasNext: true });
    expect(store.availability.value).toBe('available');
  });

  it('resets a stale unavailable availability when the new response succeeds', async () => {
    store.availability.value = 'unavailable';
    vi.mocked(api.get).mockResolvedValue({
      results: [{ a: 1 }],
      pagination: { total: 1, total_pages: 1, next: null, previous: null },
    });
    await fetchActive();
    expect(store.availability.value).toBe('available');
  });

  it('maps a 403 to per-source unavailable, not an error banner', async () => {
    const err = Object.assign(new Error('forbidden'), { status: 403, featureUnavailable: true });
    vi.mocked(api.get).mockRejectedValue(err);
    await fetchActive();
    expect(store.availability.value).toBe('unavailable');
    expect(store.availabilityStatus.value).toBe(403);
    expect(store.error.value).toBeNull();
    expect(store.rows.value).toEqual([]);
  });
});
