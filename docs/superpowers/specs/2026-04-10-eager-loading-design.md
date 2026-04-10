# Dataset Manager Eager Loading

## Problem

Indexes and search indexes load lazily on tab click, causing visible loading delays. Switching collections also requires fresh fetches for all data. This makes the UI feel sluggish.

## Solution

LRU cache with 30s TTL sitting between the UI and API. All data (records, indexes, search indexes) fetches in parallel on collection select. Background pre-fetches all other collections in staggered batches.

## Cache Module (`src/mdh/cache.js`)

LRU cache keyed by collection name. Each entry stores per-field data with individual timestamps.

**Config:** TTL = 30s, max entries = 50.

**Entry structure:**

```
{
  collection: {
    records: { value, timestamp },
    totalCount: { value, timestamp },
    indexes: { value, timestamp },
    searchIndexes: { value, timestamp },
    _lastAccess: timestamp
  }
}
```

**API:**

- `get(collection, field)` — returns value if fresh (< 30s), else `null`
- `set(collection, field, value)` — stores with timestamp, promotes LRU, evicts if over 50
- `invalidate(collection, field?)` — clears one field or entire entry
- `invalidateAll()` — clears everything

**LRU mechanics:** `_lastAccess` updated on every `get` or `set`. When at capacity, the entry with the oldest `_lastAccess` is evicted.

## Integration

### On collection select (parallel fetch)

When `selectedCollectionChanged` fires, all three panels check cache and fetch in parallel:

- `records.js` — check cache for records + totalCount, fetch on miss
- `indexes.js` — check cache for indexes, fetch on miss (no longer lazy)
- `search-indexes.js` — check cache for searchIndexes, fetch on miss (no longer lazy)

### Tab switching

Reads from cache. If fresh, renders immediately with no API call. If expired, fetches normally.

### Background pre-fetch (`index.js`)

After the selected collection finishes loading, pre-fetch all other collections:

- Batch size: 5 collections
- Delay between batches: 200ms
- Each collection fetches: records (first page), totalCount, indexes, searchIndexes
- Pre-fetch only populates cache, does not update UI state
- Abort pending pre-fetch if collection selection changes

### Mutation invalidation

| Operation | Invalidation |
|-----------|-------------|
| Record insert/update/delete/bulkWrite | `invalidate(collection, 'records')` + `invalidate(collection, 'totalCount')` |
| Index create/drop | `invalidate(collection, 'indexes')` |
| Search index create/drop | `invalidate(collection, 'searchIndexes')` |
| Collection rename/drop | `invalidateAll()` |
| Collection create | `invalidateAll()` |

## Files Changed

- **New: `src/mdh/cache.js`** — cache module
- **`src/mdh/ui/records.js`** — cache reads/writes for records + totalCount, invalidation on mutations
- **`src/mdh/ui/indexes.js`** — eager fetch on collection select, cache reads/writes, invalidation
- **`src/mdh/ui/search-indexes.js`** — same as indexes
- **`src/mdh/ui/sidebar.js`** — invalidateAll on collection create/rename/drop
- **`src/mdh/index.js`** — orchestrate staggered background pre-fetch, abort on collection change
