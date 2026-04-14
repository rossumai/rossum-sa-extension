import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import * as store from '../src/mdh/store.js';
import { prefetchForPanel, prefetchAll } from '../src/mdh/prefetch.js';

beforeEach(() => {
  cache.invalidateAll();
  store.limit.value = 50;
  vi.clearAllMocks();
});

describe('prefetch system', () => {
  it('prefetchForPanel("data") loads records and total count into cache', async () => {
    api.aggregate
      .mockResolvedValueOnce({ result: [{ _id: '1', name: 'rec1' }] })
      .mockResolvedValueOnce({ result: [{ total: 42 }] });

    await prefetchForPanel('test_col', 'data');

    expect(cache.get('test_col', 'records')).toEqual([{ _id: '1', name: 'rec1' }]);
    expect(cache.get('test_col', 'totalCount')).toBe(42);
  });

  it('prefetchForPanel("indexes") loads index list into cache', async () => {
    api.listIndexes.mockResolvedValue({ result: [{ name: '_id_', key: { _id: 1 } }] });

    await prefetchForPanel('test_col', 'indexes');

    expect(cache.get('test_col', 'indexes')).toEqual([{ name: '_id_', key: { _id: 1 } }]);
    expect(api.listIndexes).toHaveBeenCalledWith('test_col', false);
  });

  it('prefetchForPanel("search-indexes") loads search index list', async () => {
    api.listSearchIndexes.mockResolvedValue({ result: [{ name: 'search1' }] });

    await prefetchForPanel('test_col', 'search-indexes');

    expect(cache.get('test_col', 'searchIndexes')).toEqual([{ name: 'search1' }]);
  });

  it('prefetchForPanel("stats") discovers fields and runs stat pipelines', async () => {
    // Sample query returns docs for field discovery
    api.aggregate.mockImplementation((_col, pipeline) => {
      if (pipeline[0]?.$sample) {
        return Promise.resolve({
          result: [
            { name: 'Alice', age: 30 },
            { name: 'Bob', age: 25 },
          ],
        });
      }
      // All stat pipelines return empty results
      return Promise.resolve({ result: [] });
    });

    await prefetchForPanel('test_col', 'stats');

    expect(cache.get('test_col', 'statsFields')).toEqual(['age', 'name']);
    // 1 sample query + 9 stat pipelines = 10 aggregate calls
    expect(api.aggregate).toHaveBeenCalledTimes(10);
    // Stat results should be cached
    expect(cache.get('test_col', 'stats_coverage')).toEqual({ result: [] });
    expect(cache.get('test_col', 'stats_types')).toEqual({ result: [] });
  });

  it('skips prefetch when cache is already populated', async () => {
    cache.set('test_col', 'records', [{ cached: true }]);
    cache.set('test_col', 'totalCount', 10);

    await prefetchForPanel('test_col', 'data');

    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('prefetchAll loads data for all panels', async () => {
    api.aggregate.mockImplementation((_col, pipeline) => {
      if (pipeline[0]?.$sample) {
        return Promise.resolve({ result: [{ name: 'test' }] });
      }
      if (pipeline[0]?.$count) {
        return Promise.resolve({ result: [{ total: 5 }] });
      }
      return Promise.resolve({ result: [] });
    });
    api.listIndexes.mockResolvedValue({ result: [] });
    api.listSearchIndexes.mockResolvedValue({ result: [] });

    await prefetchAll('test_col');

    expect(cache.get('test_col', 'records')).not.toBeNull();
    expect(cache.get('test_col', 'totalCount')).toBe(5);
    expect(cache.get('test_col', 'indexes')).toEqual([]);
    expect(cache.get('test_col', 'searchIndexes')).toEqual([]);
    expect(cache.get('test_col', 'statsFields')).toEqual(['name']);
  });

  it('prefetch silently handles API errors', async () => {
    api.aggregate.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await prefetchForPanel('test_col', 'data');

    expect(cache.get('test_col', 'records')).toBeNull();
    expect(cache.get('test_col', 'totalCount')).toBeNull();
  });
});
