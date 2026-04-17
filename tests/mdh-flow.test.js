// @vitest-environment jsdom
//
// High-level E2E: simulates a full user session through the MDH app.
// Combines usePipeline + useQuery + usePagination with a mocked API
// and the real cache, exercising the same code paths as a real user.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import * as store from '../src/mdh/store.js';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';
import { useQuery } from '../src/mdh/hooks/useQuery.js';
import { usePagination } from '../src/mdh/hooks/usePagination.js';

function renderAllHooks() {
  let result;
  render(
    h(() => {
      result = {
        pipeline: usePipeline(),
        query: useQuery(),
        pagination: usePagination(),
      };
      return null;
    }, null),
    document.createElement('div'),
  );
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

describe('full data exploration flow', () => {
  const page1 = [
    { _id: '1', name: 'Alpha', category: 'A', price: 10 },
    { _id: '2', name: 'Beta', category: 'B', price: 20 },
  ];
  const page1Sorted = [
    { _id: '2', name: 'Beta', category: 'B', price: 20 },
    { _id: '1', name: 'Alpha', category: 'A', price: 10 },
  ];
  const page1Filtered = [
    { _id: '1', name: 'Alpha', category: 'A', price: 10 },
  ];
  const page2 = [
    { _id: '3', name: 'Gamma', category: 'A', price: 30 },
  ];

  it('query → sort → filter → paginate → reset', async () => {
    const hooks = renderAllHooks();

    // ── Step 1: initial query ──
    api.aggregate.mockResolvedValueOnce({ result: page1 });
    await hooks.query.runQuery('products', '[{"$match": {}}]');

    expect(store.records.value).toEqual(page1);
    expect(api.aggregate).toHaveBeenCalledWith('products', [{ $match: {} }]);

    // ── Step 2: sort by price descending (two toggles: asc → desc) ──
    hooks.pipeline.toggleSort('price');
    hooks.pipeline.toggleSort('price');
    expect(hooks.pipeline.sortIndicator('price')).toBe(' ↓');
    expect(store.skip.value).toBe(0); // sort resets pagination

    const sortedPipeline = hooks.pipeline.buildPipelineFromUI();
    expect(sortedPipeline).toEqual([
      { $match: {} },
      { $sort: { price: -1, _id: -1 } }, // price primary, _id:-1 default acts as tiebreaker
      { $skip: 0 },
    ]);

    api.aggregate.mockResolvedValueOnce({ result: page1Sorted });
    await hooks.query.runQuery('products', JSON.stringify(sortedPipeline));
    expect(store.records.value).toEqual(page1Sorted);

    // ── Step 3: filter by category ──
    hooks.pipeline.toggleFilter('category', 'A');
    expect(store.skip.value).toBe(0); // filter resets pagination

    const filteredPipeline = hooks.pipeline.buildPipelineFromUI();
    expect(filteredPipeline[0].$match).toEqual({ category: 'A' });
    expect(filteredPipeline[1]).toEqual({ $sort: { price: -1, _id: -1 } }); // user sort + default _id tiebreaker

    api.aggregate.mockResolvedValueOnce({ result: page1Filtered });
    await hooks.query.runQuery('products', JSON.stringify(filteredPipeline));
    expect(store.records.value).toEqual(page1Filtered);

    // ── Step 4: go to page 2 ──
    hooks.pagination.goNext();
    expect(store.skip.value).toBe(50);
    expect(hooks.pagination.page()).toBe(2);
    expect(hooks.pagination.hasPrev()).toBe(true);

    api.aggregate.mockResolvedValueOnce({ result: page2 });
    const page2Pipeline = hooks.pipeline.buildPipelineFromUI();
    expect(page2Pipeline[page2Pipeline.length - 1]).toEqual({ $skip: 50 });
    await hooks.query.runQuery('products', JSON.stringify(page2Pipeline));
    expect(store.records.value).toEqual(page2);

    // ── Step 5: reset all state ──
    hooks.pipeline.reset();
    hooks.pagination.resetPage();
    expect(store.skip.value).toBe(0);
    expect(hooks.pipeline.isFiltered('category')).toBe(false);
    expect(hooks.pipeline.sortIndicator('price')).toBe('');
    expect(hooks.pagination.totalCount.value).toBeNull();
  });

  it('query with placeholders → substitute → execute', async () => {
    const hooks = renderAllHooks();

    const template = '[{"$match": {"status": "{status}", "minPrice": {minPrice}}}]';
    const names = hooks.pipeline.extractPlaceholders(template);
    expect(names).toEqual(['status', 'minPrice']);

    // Query skipped while placeholders unresolved
    await hooks.query.runQuery('products', template);
    expect(api.aggregate).not.toHaveBeenCalled();

    // Set placeholders and substitute
    hooks.pipeline.setPlaceholder('status', 'active');
    hooks.pipeline.setPlaceholder('minPrice', '100');
    const resolved = hooks.pipeline.substitutePlaceholders(template);
    expect(resolved).toBe('[{"$match": {"status": "active", "minPrice": 100}}]');

    // Now the query runs
    api.aggregate.mockResolvedValueOnce({ result: [{ name: 'result' }] });
    await hooks.query.runQuery('products', resolved);
    expect(store.records.value).toEqual([{ name: 'result' }]);
  });

  it('pagination uses cached total count on second fetch', async () => {
    store.selectedCollection.value = 'products';
    const hooks = renderAllHooks();

    // First fetch — hits the API
    api.aggregate.mockResolvedValueOnce({ result: [{ count: 250 }] });
    await hooks.pagination.fetchTotalCount('products');
    expect(hooks.pagination.totalCount.value).toBe(250);
    expect(api.aggregate).toHaveBeenCalledTimes(1);

    // Second fetch — served from cache
    await hooks.pagination.fetchTotalCount('products');
    expect(api.aggregate).toHaveBeenCalledTimes(1); // no new call

    // After mutation, invalidate and re-fetch
    hooks.pagination.invalidateTotalCount('products');
    expect(hooks.pagination.totalCount.value).toBeNull();

    api.aggregate.mockResolvedValueOnce({ result: [{ count: 251 }] });
    await hooks.pagination.fetchTotalCount('products');
    expect(hooks.pagination.totalCount.value).toBe(251);
    expect(api.aggregate).toHaveBeenCalledTimes(2);
  });

  it('rapid queries — only the last result is kept', async () => {
    const hooks = renderAllHooks();

    let resolvers = [];
    api.aggregate.mockImplementation(
      () => new Promise((r) => resolvers.push(r)),
    );

    // Fire 3 rapid queries
    const p1 = hooks.query.runQuery('col', '[{"$match": {"v": 1}}]');
    const p2 = hooks.query.runQuery('col', '[{"$match": {"v": 2}}]');
    const p3 = hooks.query.runQuery('col', '[{"$match": {"v": 3}}]');

    // Resolve out of order: 3rd first, then 1st, then 2nd
    resolvers[2]({ result: [{ v: 3 }] });
    await p3;
    expect(store.records.value).toEqual([{ v: 3 }]);

    resolvers[0]({ result: [{ v: 1 }] });
    await p1;
    expect(store.records.value).toEqual([{ v: 3 }]); // stale, ignored

    resolvers[1]({ result: [{ v: 2 }] });
    await p2;
    expect(store.records.value).toEqual([{ v: 3 }]); // stale, ignored
  });
});
