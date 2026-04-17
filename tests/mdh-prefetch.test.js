import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import * as store from '../src/mdh/store.js';
import { prefetchForPanel, prefetchAll } from '../src/mdh/prefetch.js';
import { encKey } from '../src/mdh/statsPipelines.js';

beforeEach(() => {
  cache.invalidateAll();
  store.limit.value = 50;
  store.statsSummary.value = null;
  vi.clearAllMocks();
});

describe('prefetch system', () => {
  it('prefetchForPanel("data") loads records and total count into cache', async () => {
    api.aggregate.mockImplementation((_col, pipeline) => {
      if (pipeline[0]?.$collStats) return Promise.resolve({ result: [{ count: 42 }] });
      return Promise.resolve({ result: [{ _id: '1', name: 'rec1' }] });
    });

    await prefetchForPanel('test_col', 'data');

    expect(cache.get('test_col', 'records')).toEqual([{ _id: '1', name: 'rec1' }]);
    expect(cache.get('test_col', 'totalCount')).toBe(42);
  });

  it('prefetchForPanel("indexes") loads index list into cache', async () => {
    api.listIndexes.mockResolvedValue({ result: [{ name: '_id_', key: { _id: 1 } }] });

    await prefetchForPanel('test_col', 'indexes');

    expect(cache.get('test_col', 'indexes')).toEqual([{ name: '_id_', key: { _id: 1 } }]);
    expect(api.listIndexes).toHaveBeenCalledWith('test_col', false, expect.anything());
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
    // 1 sample query + 11 stat pipelines = 12 aggregate calls
    expect(api.aggregate).toHaveBeenCalledTimes(12);
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
      if (pipeline[0]?.$collStats) {
        return Promise.resolve({ result: [{ count: 5 }] });
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

  it('prefetchForPanel("stats") publishes the statsSummary signal after completion', async () => {
    api.aggregate.mockImplementation((_col, pipeline) => {
      if (pipeline[0]?.$sample) {
        return Promise.resolve({ result: [{ name: 'Alice', age: 30 }] });
      }
      // Coverage pipeline shape: [$project, $group { _total, f_<field>, ... }].
      // If buildFieldCoveragePipeline ever changes shape, this branch silently
      // falls through and the test would still pass with a degraded score —
      // update both this matcher and the asserted health score below in lockstep.
      const stage = pipeline[1];
      if (stage?.$group?._total) {
        return Promise.resolve({
          result: [{ _total: 10, [`f_${encKey('name')}`]: 10, [`f_${encKey('age')}`]: 10 }],
        });
      }
      return Promise.resolve({ result: [{}] });
    });

    await prefetchForPanel('test_col', 'stats');

    // With both fields at 100% coverage and no other issues surfaced
    // (empties/types/strings/schema all empty), score should be Excellent (>=90).
    expect(store.statsSummary.value).not.toBeNull();
    expect(store.statsSummary.value.collection).toBe('test_col');
    expect(store.statsSummary.value.health).toBeGreaterThanOrEqual(90);
    expect(store.statsSummary.value.label).toBe('Excellent');
  });

  it('prefetchForPanel("stats") leaves statsSummary null when a stats check fails', async () => {
    // Field discovery succeeds; one of the 9 stat checks rejects.
    // updateStatsSummary should bail to null because a required input is missing.
    api.aggregate.mockImplementation((_col, pipeline) => {
      if (pipeline[0]?.$sample) {
        return Promise.resolve({ result: [{ name: 'Alice', age: 30 }] });
      }
      // The coverage pipeline rejects; all other stat pipelines return [{}].
      const stage = pipeline[1];
      if (stage?.$group?._total) {
        return Promise.reject(new Error('Aggregation failed'));
      }
      return Promise.resolve({ result: [{}] });
    });

    await prefetchForPanel('test_col', 'stats');

    expect(store.statsSummary.value).toBeNull();
  });
});
