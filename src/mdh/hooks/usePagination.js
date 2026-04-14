import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { selectedCollection, skip, limit } from '../store.js';
import * as api from '../api.js';
import * as cache from '../cache.js';

export function usePagination() {
  const totalCount = useRef(signal(null)).current;

  async function fetchTotalCount(collection) {
    const cached = cache.get(collection, 'totalCount');
    if (cached !== null) {
      totalCount.value = cached;
      return cached;
    }
    try {
      const res = await api.aggregate(collection, [{ $count: 'total' }]);
      if (selectedCollection.value !== collection) return null;
      const count = res.result?.[0]?.total ?? 0;
      totalCount.value = count;
      cache.set(collection, 'totalCount', count);
      return count;
    } catch {
      return null;
    }
  }

  function page() {
    return Math.floor(skip.value / limit.value) + 1;
  }

  function hasPrev() {
    return skip.value > 0;
  }

  function hasNext(recordCount) {
    return recordCount >= limit.value;
  }

  function goNext() {
    skip.value = skip.value + limit.value;
  }

  function goPrev() {
    skip.value = Math.max(0, skip.value - limit.value);
  }

  function resetPage() {
    skip.value = 0;
    totalCount.value = null;
  }

  function invalidateTotalCount(collection) {
    cache.invalidate(collection, 'totalCount');
    totalCount.value = null;
  }

  return {
    totalCount,
    fetchTotalCount,
    page,
    hasPrev,
    hasNext,
    goNext,
    goPrev,
    resetPage,
    invalidateTotalCount,
  };
}
