import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as cache from '../src/mdh/cache.js';

beforeEach(() => {
  cache.invalidateAll();
  vi.useRealTimers();
});

describe('MDH cache', () => {
  it('stores and retrieves values', () => {
    cache.set('col1', 'records', [{ id: 1 }]);
    expect(cache.get('col1', 'records')).toEqual([{ id: 1 }]);
  });

  it('returns null for missing entries', () => {
    expect(cache.get('nonexistent', 'field')).toBeNull();
    cache.set('col1', 'records', []);
    expect(cache.get('col1', 'missing')).toBeNull();
  });

  it('expires entries after TTL (60s)', () => {
    vi.useFakeTimers();
    cache.set('col1', 'records', 'data');

    vi.advanceTimersByTime(59_000);
    expect(cache.get('col1', 'records')).toBe('data');

    vi.advanceTimersByTime(2_000);
    expect(cache.get('col1', 'records')).toBeNull();
  });

  it('uses long TTL (600s) for stats keys, default TTL (60s) for others', () => {
    vi.useFakeTimers();
    cache.set('col1', 'statsFields', ['name']);
    cache.set('col1', 'stats_coverage', { result: [] });
    cache.set('col1', 'totalCount', 42);

    // After 70s: non-stats keys have expired, stats keys still cached.
    vi.advanceTimersByTime(70_000);
    expect(cache.get('col1', 'totalCount')).toBeNull();
    expect(cache.get('col1', 'statsFields')).toEqual(['name']);
    expect(cache.get('col1', 'stats_coverage')).toEqual({ result: [] });

    // Just past 600s: stats keys also expire.
    vi.advanceTimersByTime(531_000); // total 601s since set
    expect(cache.get('col1', 'statsFields')).toBeNull();
    expect(cache.get('col1', 'stats_coverage')).toBeNull();
  });

  it('cleans up expired entries on access', () => {
    vi.useFakeTimers();
    cache.set('col1', 'records', 'data');
    cache.set('col1', 'indexes', 'idx');

    vi.advanceTimersByTime(61_000);
    // Accessing expired field should remove it
    expect(cache.get('col1', 'records')).toBeNull();
    // Other field in same collection also expired
    expect(cache.get('col1', 'indexes')).toBeNull();
    // Collection entry should be fully cleaned up
    const s = cache.stats();
    expect(s.fieldCount).toBe(0);
  });

  it('evicts LRU entries beyond 200 collections', () => {
    for (let i = 0; i < 201; i++) {
      cache.set(`col_${i}`, 'data', i);
    }
    expect(cache.get('col_0', 'data')).toBeNull();
    expect(cache.get('col_200', 'data')).toBe(200);
  });

  it('invalidateData preserves index caches', () => {
    cache.set('col1', 'records', 'data');
    cache.set('col1', 'totalCount', 42);
    cache.set('col1', 'indexes', ['idx1']);
    cache.set('col1', 'searchIndexes', ['sidx1']);

    cache.invalidateData('col1');

    expect(cache.get('col1', 'records')).toBeNull();
    expect(cache.get('col1', 'totalCount')).toBeNull();
    expect(cache.get('col1', 'indexes')).toEqual(['idx1']);
    expect(cache.get('col1', 'searchIndexes')).toEqual(['sidx1']);
  });

  it('invalidate removes specific field or entire collection', () => {
    cache.set('col1', 'a', 1);
    cache.set('col1', 'b', 2);

    cache.invalidate('col1', 'a');
    expect(cache.get('col1', 'a')).toBeNull();
    expect(cache.get('col1', 'b')).toBe(2);

    cache.invalidate('col1');
    expect(cache.get('col1', 'b')).toBeNull();
  });

  it('reports stats', () => {
    cache.set('col1', 'a', 1);
    cache.set('col1', 'b', 2);
    cache.set('col2', 'c', 3);

    const s = cache.stats('col1');
    expect(s.fieldCount).toBe(3);
    expect(s.age).toBeTypeOf('number');
    expect(s.age).toBeLessThanOrEqual(100);
  });
});
