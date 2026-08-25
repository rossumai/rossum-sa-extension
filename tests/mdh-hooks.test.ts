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
import JSON5 from 'json5';

function renderHook(hookFn: any): any {
  let result: any;
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
  it('builds default pipeline with _id:-1 sort from fresh state', () => {
    const hook = renderHook(usePipeline);
    expect(hook.sortIndicator('_id')).toBe(' ↓'); // default indicator is visible
    expect(hook.buildPipelineFromUI()).toEqual([
      { $match: {} },
      { $sort: { _id: -1 } },
      { $skip: 0 },
    ]);
  });

  it('new sort key inserts at the front so it becomes the primary sort', () => {
    const hook = renderHook(usePipeline);

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe(' ↑');
    expect(hook.sortIndicator('_id')).toBe(' ↓'); // _id stays as tiebreaker
    // Object key order matters for MongoDB $sort — name must come first.
    expect(Object.keys(hook.buildPipelineFromUI()[1].$sort)).toEqual(['name', '_id']);
    expect(hook.buildPipelineFromUI()[1]).toEqual({ $sort: { name: 1, _id: -1 } });

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe(' ↓');
    expect(hook.buildPipelineFromUI()[1]).toEqual({ $sort: { name: -1, _id: -1 } });

    hook.toggleSort('name');
    expect(hook.sortIndicator('name')).toBe('');
    expect(hook.buildPipelineFromUI()[1]).toEqual({ $sort: { _id: -1 } });
  });

  it('cycles _id from default: -1 → off → +1 → -1', () => {
    const hook = renderHook(usePipeline);
    expect(hook.sortIndicator('_id')).toBe(' ↓'); // default
    hook.toggleSort('_id');
    expect(hook.sortIndicator('_id')).toBe(''); // cleared
    hook.toggleSort('_id');
    expect(hook.sortIndicator('_id')).toBe(' ↑'); // asc
    hook.toggleSort('_id');
    expect(hook.sortIndicator('_id')).toBe(' ↓'); // desc
  });

  it('clearing all sort keys omits the $sort stage entirely', () => {
    const hook = renderHook(usePipeline);
    hook.toggleSort('_id'); // removes _id from the default sortState
    expect(hook.buildPipelineFromUI()).toEqual([
      { $match: {} },
      { $skip: 0 },
    ]);
  });

  it('reset restores the default _id:-1 sort', () => {
    const hook = renderHook(usePipeline);
    hook.toggleSort('price');
    hook.toggleSort('_id'); // clears _id from the default; sortState = { price: 1 }
    hook.reset();
    expect(hook.sortIndicator('_id')).toBe(' ↓');
    expect(hook.sortIndicator('price')).toBe('');
    expect(hook.buildPipelineFromUI()[1]).toEqual({ $sort: { _id: -1 } });
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

  it('extracts and substitutes "{name}" placeholders with type coercion', () => {
    const hook = renderHook(usePipeline);

    // Variables are whole quoted values; type-aware substitution still turns a
    // numeric value into a JSON number (dropping the quotes).
    const names = hook.extractPlaceholders('{"status": "{status}", "count": "{count}"}');
    expect(names).toEqual(['status', 'count']);

    hook.setPlaceholder('status', 'active');
    hook.setPlaceholder('count', '42');
    const result = hook.substitutePlaceholders('{"status": "{status}", "count": "{count}"}');
    expect(result).toBe('{"status": "active", "count": 42}');
  });

  it('placeholder substitution handles booleans and null', () => {
    const hook = renderHook(usePipeline);
    hook.setPlaceholder('flag', 'true');
    hook.setPlaceholder('val', 'null');
    expect(hook.substitutePlaceholders('"{flag}"')).toBe('true');
    expect(hook.substitutePlaceholders('"{val}"')).toBe('null');
  });

  it('substitutes an unfilled "{name}" as an empty string', () => {
    const hook = renderHook(usePipeline);
    expect(hook.substitutePlaceholders('"{unknown}"')).toBe('""');
  });

  it('quotes leading-zero numeric strings instead of emitting invalid JSON5', () => {
    // Regression for the "Fill from Annotation" bug: annotation fields commonly
    // carry zero-padded IDs (vendor numbers, document numbers, zip codes). The
    // old `!isNaN(Number(val))` check accepted "007" as a literal — but JSON5
    // rejects `007` as a number, so the substituted pipeline failed to parse
    // and the entire PipelineDebug panel disappeared.
    const hook = renderHook(usePipeline);
    hook.setPlaceholder('vendor_id', '007');
    const result = hook.substitutePlaceholders('[{"$match": {"vendor_id": "{vendor_id}"}}]');
    expect(result).toBe('[{"$match": {"vendor_id": "007"}}]');
    expect(() => JSON5.parse(result)).not.toThrow();
  });

  it('quotes other malformed-as-JSON5 numeric shapes (commas, spaces, repeated dots)', () => {
    const hook = renderHook(usePipeline);
    hook.setPlaceholder('a', '5,552.14'); // locale-formatted number from a Rossum field
    hook.setPlaceholder('b', ' 42 ');     // padded
    const r = hook.substitutePlaceholders('["{a}", "{b}"]');
    // Both must end up as strings (not bare literals) for the result to parse.
    expect(() => JSON5.parse(r)).not.toThrow();
    const parsed = JSON5.parse(r);
    expect(parsed[0]).toBe('5,552.14');
    expect(parsed[1]).toBe(' 42 ');
  });

  it('still inlines plain numeric values as JSON5 literals', () => {
    const hook = renderHook(usePipeline);
    hook.setPlaceholder('a', '42');
    hook.setPlaceholder('b', '3.14');
    hook.setPlaceholder('c', '-5');
    hook.setPlaceholder('d', '0');
    const r = hook.substitutePlaceholders('["{a}", "{b}", "{c}", "{d}"]');
    expect(r).toBe('[42, 3.14, -5, 0]');
    expect(JSON5.parse(r)).toEqual([42, 3.14, -5, 0]);
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
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ _id: '1', name: 'Alice' }] });
    const hook = renderHook(useQuery);

    const res = await hook.runQuery('test_col', '[{"$match": {}}]');

    expect(api.aggregate).toHaveBeenCalledWith('test_col', [{ $match: {} }], { signal: expect.any(AbortSignal) });
    expect(store.records.value).toEqual([{ _id: '1', name: 'Alice' }]);
    expect(res.elapsed).toBeTypeOf('number');
    expect(store.loading.value).toBe(false);
  });

  it('sets error signal on API failure', async () => {
    vi.mocked(api.aggregate).mockRejectedValue(new Error('Connection refused'));
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{"$match": {}}]');

    expect(store.error.value).toEqual({ message: 'Connection refused' });
    expect(store.loading.value).toBe(false);
  });

  it('ignores stale query results when a newer query completes first', async () => {
    let resolveFirst: any;
    vi.mocked(api.aggregate)
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
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ cached: true }] });
    const hook = renderHook(useQuery);

    hook.setCacheNextQuery(true);
    await hook.runQuery('col', '[{"$match": {}}]');

    expect(cache.get('col', 'records')).toEqual([{ cached: true }]);
  });

  it('does not cache by default', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ data: 1 }] });
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{"$match": {}}]');

    expect(cache.get('col', 'records')).toBeNull();
  });

  it('skips execution for invalid pipeline text', async () => {
    const hook = renderHook(useQuery);
    await hook.runQuery('col', 'not valid json');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('runs the pipeline as-is with no substitution fn (a "{name}" is just a literal string)', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const hook = renderHook(useQuery);
    await hook.runQuery('col', '[{"$match": {"status": "{status}"}}]');
    expect(api.aggregate).toHaveBeenCalledWith(
      'col',
      [{ $match: { status: '{status}' } }],
      { signal: expect.any(AbortSignal) },
    );
  });

  it('skips execution when collection is empty', async () => {
    const hook = renderHook(useQuery);
    await hook.runQuery('', '[{"$match": {}}]');
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('accepts JSON5 syntax (trailing commas, unquoted keys)', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
    const hook = renderHook(useQuery);

    await hook.runQuery('col', '[{$match: {},}]');

    expect(api.aggregate).toHaveBeenCalledWith('col', [{ $match: {} }], { signal: expect.any(AbortSignal) });
  });

  it('aborts the prior in-flight aggregate when superseded by a new runQuery', async () => {
    const signals: any = [];
    vi.mocked(api.aggregate).mockImplementation((_col, _pipeline, { signal }: any) => {
      signals.push(signal);
      return new Promise(() => {}); // never resolves
    });
    const hook = renderHook(useQuery);

    hook.runQuery('col', '[{"$match": {}}]');
    hook.runQuery('col', '[{"$match": {"x": 1}}]');

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('clears cacheNextQuery flag when superseded so it cannot bleed into the next query', async () => {
    let resolveFirst: any;
    let aggregateCallIndex = 0;
    vi.mocked(api.aggregate).mockImplementation((col) => {
      const idx = aggregateCallIndex++;
      if (idx === 0) {
        return new Promise((_, reject) => {
          resolveFirst = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }
      return Promise.resolve({ result: [{ _id: 'second', col }] });
    });
    const hook = renderHook(useQuery);

    hook.setCacheNextQuery(true);
    const firstPromise = hook.runQuery('collection_a', '[{"$match": {}}]');

    // Supersede with a second query against a *different* collection without
    // re-asserting the cache flag.
    const secondPromise = hook.runQuery('collection_b', '[{"$match": {}}]');

    resolveFirst();
    await Promise.all([firstPromise, secondPromise]);

    // collection_b should NOT have inherited collection_a's cacheNextQuery flag.
    expect(cache.get('collection_b', 'records')).toBeNull();
  });
});

// ── Pagination ─────────────────────────────────────────────────────

describe('pagination (usePagination)', () => {
  it('fetches and caches total count via aggregation', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ count: 150 }] });
    store.selectedCollection.value = 'col';
    const hook = renderHook(usePagination);

    const count = await hook.fetchTotalCount('col');

    expect(count).toBe(150);
    expect(hook.totalCount.value).toBe(150);
    expect(api.aggregate).toHaveBeenCalledWith('col', [{ $collStats: { count: {} } }, { $limit: 1 }]);
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

  it('does not over-page into empty pages when the query is filtered', () => {
    const hook = renderHook(usePagination);
    hook.totalCount.value = 10000;      // unfiltered collection size
    store.skip.value = 0;
    store.limit.value = 50;
    // Unfiltered: trust the total → there is a next page.
    expect(hook.hasNext(50, false)).toBe(true);
    // Filtered with fewer than a full page of results → no next page.
    expect(hook.hasNext(30, true)).toBe(false);
    // Filtered with a full page → heuristic allows a next page.
    expect(hook.hasNext(50, true)).toBe(true);
  });

  it('discards stale total count when collection changes during fetch', async () => {
    let resolveCount: any;
    vi.mocked(api.aggregate).mockImplementation(() => new Promise((r) => { resolveCount = r; }));
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
