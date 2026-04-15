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

function ttlFor(field) {
  return field.startsWith('stats') ? TTL_LONG : TTL_DEFAULT;
}

export function get(collection, field) {
  const entry = entries.get(collection);
  if (!entry) { misses++; return null; }
  const f = entry.fields[field];
  if (!f) { misses++; return null; }
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

export function stats(collection) {
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
        if (f.ts > newest) newest = f.ts;
      }
      if (newest > 0) age = Date.now() - newest;
    }
  }

  return { fieldCount, age };
}

export function set(collection, field, value) {
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

export function invalidate(collection, field) {
  if (!field) {
    entries.delete(collection);
    return;
  }
  const entry = entries.get(collection);
  if (entry) delete entry.fields[field];
}

export function invalidateData(collection) {
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
  while (entries.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of entries) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
    else break;
  }
}
