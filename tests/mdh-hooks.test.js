// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import * as store from '../src/mdh/store.js';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';
import { useQuery } from '../src/mdh/hooks/useQuery.js';
import { usePagination } from '../src/mdh/hooks/usePagination.js';

function renderHook(hookFn) {
  let result;
  render(h(() => { result = hookFn(); return null; }, null), document.createElement('div'));
  return result;
}

beforeEach(() => {
  store.selectedCollection.value = null;
  store.skip.value = 0;
  store.limit.value = 50;
  store.records.value = [];
  store.loading.value = false;
  store.error.value = null;
  cache.invalidateAll();
  vi.clearAllMocks();
});

// ── Pipeline building ──────────────────────────────────────────────

describe('pipeline building (usePipeline)', () => {
  it('builds empty pipeline from fresh state', () => {
    const hook = renderHook(usePipeline);
    expect(hook.buildPipelineFromUI()).toEqual([
      { $match: {} },
      { $skip: 0 },
    ]);
  });

  it('sort toggles cycle: asc → desc → removed', () => {
    const hook = renderHook(usePipeline);

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe(' ↑');
    expect(hook.buildPipelineFromUI()).toEqual([
      { $match: {} },
      { $sort: { name: 1 } },
      { $skip: 0 },
    ]);

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe(' ↓');
    expect(hook.buildPipelineFromUI()[1]).toEqual({ $sort: { name: -1 } });

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe('');
    expect(hook.buildPipelineFromUI()).toEqual([
      { $match: {} },
      { $skip: 0 },
    ]);
  });

  it('filter toggle adds/removes $match conditions', () => {
    const hook = renderHook(usePipeline);

    hook.toggleFilter('status', 'active');
    expect(hook.isFiltered('status')).toBe(true);
    expect(hook.buildPipelineFromUI()[0].$match).toEqual({ status: 'active' });

    hook.toggleFilter('status', 'active');
    expect(hook.isFiltered('status')).toBe(false);
    expect(hook.buildPipelineFromUI()[0].$match).toEqual({});
  });

  it('sort and filter changes reset pagination to page 1', () => {
    const hook = renderHook(usePipeline);

    store.skip.value = 100;
    hook.toggleSort('name');
    expect(store.skip.value).toBe(0);

    store.skip.value = 100;
    hook.toggleFilter('status', 'active');
    expect(store.skip.value).toBe(0);
  });

  it('extracts and substitutes placeholders with type coercion', () => {
    const hook = renderHook(usePipeline);

    const names = hook.extractPlaceholders('{"status": "{status}", "count": {count}}');
    expect(names).toEqual(['status', 'count']);

    hook.setPlaceholder('status', 'active');
    hook.setPlaceholder('count', '42');
    const result = hook.substitutePlaceholders('{"status": "{status}", "count": {count}}');
    expect(result).toBe('{"status": "active", "count": 42}');
  });

  it('placeholder substitution handles booleans and null', () => {
    const hook = renderHook(usePipeline);
    hook.setPlaceholder('flag', 'true');
    hook.setPlaceholder('val', 'null');
    expect(hook.substitutePlaceholders('{flag}')).toBe('true');
    expect(hook.substitutePlaceholders('{val}')).toBe('null');
  });

  it('leaves unset placeholders as-is', () => {
    const hook = renderHook(usePipeline);
    expect(hook.substitutePlaceholders('{unknown}')).toBe('{unknown}');
  });

  it('reset clears sort, filter, placeholders, and skip', () => {
    const hook = renderHook(usePipeline);
    hook.toggleSort('name');
    hook.toggleFilter('status', 'active');
    hook.setPlaceholder('x', '1');
    store.skip.value = 50;

    hook.reset();

    expect(hook.sortIndicator('name')).toBe('');
    expect(hook.isFiltered('status')).toBe(false);
    expect(store.skip.value).toBe(0);
  });
});

// ── Query execution ────────────────────────────────────────────────

describe('query execution (useQuery)', () => {
  it('runs pipeline and populates store.records', async () => {
    api.aggregate.mockResolvedValue({ result: [{ _id: '1', name: 'Alice' }] });
    const hook = renderHook(useQuery);

    const res = await hook.runQuery('test_col', '[{"$match": {}}]');

    expect(api.aggregate).toHaveBeenCalledWith('test_col', [{ $match: {} }]);
    expect(store.records.value).toEqual([{ _id: '1', name: 'Alice' }]);
    expect(res.elapsed).toBeTypeOf('number');
    expect(store.loading.value).toBe(false);
  });

  it('sets error signal on API failure', async () => {
    api.aggregate.mockRejectedValue(new Error('Connection refused'));
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{"$match": {}}]');

    expect(store.error.value).toEqual({ message: 'Connection refused' });
    expect(store.loading.value).toBe(false);
  });

  it('ignores stale query results when a newer query completes first', async () => {
    let resolveFirst;
    api.aggregate
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ result: [{ name: 'second' }] });

    const hook = renderHook(useQuery);

    const firstPromise = hook.runQuery('col', '[{"$match": {"v": 1}}]');
    await hook.runQuery('col', '[{"$match": {"v": 2}}]');
    expect(store.records.value).toEqual([{ name: 'second' }]);

    // Resolve the stale first query — store must not be overwritten
    resolveFirst({ result: [{ name: 'first' }] });
    await firstPromise;
    expect(store.records.value).toEqual([{ name: 'second' }]);
  });

  it('caches result when setCacheNextQuery is enabled', async () => {
    api.aggregate.mockResolvedValue({ result: [{ cached: true }] });
    const hook = renderHook(useQuery);

    hook.setCacheNextQuery(true);
    await hook.runQuery('col', '[{"$match": {}}]');

    expect(cache.get('col', 'records')).toEqual([{ cached: true }]);
  });

  it('does not cache by default', async () => {
    api.aggregate.mockResolvedValue({ result: [{ data: 1 }] });
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{"$match": {}}]');

    expect(cache.get('col', 'records')).toBeNull();
  });

  it('skips execution for invalid pipeline text', async () => {
    const hook = renderHook(useQuery);
    await hook.runQuery('col', 'not valid json');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('skips execution when unresolved placeholders remain', async () => {
    const hook = renderHook(useQuery);
    await hook.runQuery('col', '[{"$match": {"status": "{status}"}}]');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('skips execution when collection is empty', async () => {
    const hook = renderHook(useQuery);
    await hook.runQuery('', '[{"$match": {}}]');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('accepts JSON5 syntax (trailing commas, unquoted keys)', async () => {
    api.aggregate.mockResolvedValue({ result: [] });
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{$match: {},}]');

    expect(api.aggregate).toHaveBeenCalledWith('col', [{ $match: {} }]);
  });
});

// ── Pagination ─────────────────────────────────────────────────────

describe('pagination (usePagination)', () => {
  it('fetches and caches total count via aggregation', async () => {
    api.aggregate.mockResolvedValue({ result: [{ total: 150 }] });
    store.selectedCollection.value = 'col';
    const hook = renderHook(usePagination);

    const count = await hook.fetchTotalCount('col');

    expect(count).toBe(150);
    expect(hook.totalCount.value).toBe(150);
    expect(api.aggregate).toHaveBeenCalledWith('col', [{ $count: 'total' }]);
    expect(cache.get('col', 'totalCount')).toBe(150);
  });

  it('returns cached total count without API call', async () => {
    cache.set('col', 'totalCount', 200);
    const hook = renderHook(usePagination);

    const count = await hook.fetchTotalCount('col');

    expect(count).toBe(200);
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('page navigation: next, prev, boundaries', () => {
    const hook = renderHook(usePagination);

    expect(hook.page()).toBe(1);
    expect(hook.hasPrev()).toBe(false);
    expect(hook.hasNext(50)).toBe(true);
    expect(hook.hasNext(30)).toBe(false);

    hook.goNext();
    expect(store.skip.value).toBe(50);
    expect(hook.page()).toBe(2);
    expect(hook.hasPrev()).toBe(true);

    hook.goPrev();
    expect(store.skip.value).toBe(0);
    expect(hook.page()).toBe(1);
  });

  it('goPrev does not go below zero', () => {
    const hook = renderHook(usePagination);
    hook.goPrev();
    expect(store.skip.value).toBe(0);
  });

  it('resetPage clears skip and total count', () => {
    const hook = renderHook(usePagination);
    store.skip.value = 200;
    hook.totalCount.value = 500;

    hook.resetPage();

    expect(store.skip.value).toBe(0);
    expect(hook.totalCount.value).toBeNull();
  });

  it('invalidateTotalCount clears cache and signal', () => {
    cache.set('col', 'totalCount', 100);
    const hook = renderHook(usePagination);
    hook.totalCount.value = 100;

    hook.invalidateTotalCount('col');

    expect(cache.get('col', 'totalCount')).toBeNull();
    expect(hook.totalCount.value).toBeNull();
  });

  it('discards stale total count when collection changes during fetch', async () => {
    let resolveCount;
    api.aggregate.mockImplementation(() => new Promise((r) => { resolveCount = r; }));
    const hook = renderHook(usePagination);

    // Start fetching total count for 'old_col'
    store.selectedCollection.value = 'old_col';
    const promise = hook.fetchTotalCount('old_col');

    // User switches collection before API responds
    store.selectedCollection.value = 'new_col';

    // Resolve with old collection's count
    resolveCount({ result: [{ total: 999 }] });
    const result = await promise;

    // Stale result should be discarded
    expect(result).toBeNull();
    expect(hook.totalCount.value).toBeNull();
    expect(cache.get('old_col', 'totalCount')).toBeNull();
  });
});
