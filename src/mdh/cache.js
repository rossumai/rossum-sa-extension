const TTL = 60_000;
const MAX_ENTRIES = 200;

// Map preserves insertion order — last entry is most recently used
const entries = new Map();
let hits = 0;
let misses = 0;

export function get(collection, field) {
  const entry = entries.get(collection);
  if (!entry) { misses++; return null; }
  const f = entry.fields[field];
  if (!f) { misses++; return null; }
  if (Date.now() - f.ts > TTL) {
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
