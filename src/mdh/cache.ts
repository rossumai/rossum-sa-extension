const TTL_DEFAULT = 60_000;
// Stats checks (statsFields + stats_*) run 9 facet aggregations per collection
// and can be slow on large datasets. Cache them for 10 minutes so users who
// switch between Data and Stats during a session don't pay the cost twice.
// Manual re-run via the Stats panel's refresh button still invalidates them.
const TTL_LONG = 600_000;
const MAX_ENTRIES = 200;

// Map preserves insertion order — last entry is most recently used
const entries = new Map();
let hits = 0;
let misses = 0;

function ttlFor(field: string) {
  return field.startsWith('stats') ? TTL_LONG : TTL_DEFAULT;
}

export function get(collection: string, field: string): any {
  const entry = entries.get(collection);
  if (!entry) {
    misses++;
    return null;
  }
  const f = entry.fields[field];
  if (!f) {
    misses++;
    return null;
  }
  if (Date.now() - f.ts > ttlFor(field)) {
    delete entry.fields[field];
    if (Object.keys(entry.fields).length === 0) entries.delete(collection);
    misses++;
    return null;
  }
  hits++;
  // Promote to most-recently-used
  entries.delete(collection);
  entry.lastAccess = Date.now();
  entries.set(collection, entry);
  return f.value;
}

export function stats(collection?: string | null) {
  // Total cached fields across all collections
  let fieldCount = 0;
  for (const entry of entries.values()) {
    fieldCount += Object.keys(entry.fields).length;
  }

  // Age info for a specific collection
  let age = null;
  if (collection) {
    const entry = entries.get(collection);
    if (entry) {
      let newest = 0;
      for (const f of Object.values(entry.fields)) {
        if ((f as any).ts > newest) newest = (f as any).ts;
      }
      if (newest > 0) age = Date.now() - newest;
    }
  }

  return { fieldCount, age };
}

export function set(collection: string, field: string, value: any): void {
  let entry = entries.get(collection);
  if (entry) {
    entries.delete(collection);
  } else {
    entry = { fields: {} };
  }
  entry.fields[field] = { value, ts: Date.now() };
  entry.lastAccess = Date.now();
  entries.set(collection, entry);
  evict();
}

export function invalidate(collection?: string | null, field?: string | null): void {
  if (!field) {
    entries.delete(collection);
    return;
  }
  const entry = entries.get(collection);
  if (entry) delete entry.fields[field];
}

export function invalidateData(collection?: string | null): void {
  const entry = entries.get(collection);
  if (!entry) return;
  const keysToRemove = Object.keys(entry.fields).filter(
    (k) => k !== 'indexes' && k !== 'searchIndexes',
  );
  for (const k of keysToRemove) delete entry.fields[k];
}

export function invalidateAll() {
  entries.clear();
}

function evict() {
  // Map preserves insertion order, and both `set()` and `get()` re-insert the
  // entry at the end — so the first key is always least-recently-used.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}
