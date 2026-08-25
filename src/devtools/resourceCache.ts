// PURE name picker + an in-memory, session-scoped resource cache (never persisted).
import { resourceFromApiUrl } from './resourceFromApiUrl.js';

const CAP = 200;
const store = new Map(); // apiPath -> { name, obj, at, status }

export function pickName(type: string, obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (type === 'user') {
    const full = `${obj.first_name ?? ''} ${obj.last_name ?? ''}`.trim();
    if (obj.username) return full ? `${obj.username} (${full})` : obj.username;
    return obj.email || null;
  }
  if (type === 'documents' || type === 'document')
    return obj.original_file_name || obj.name || null;
  return obj.name || null;
}

function evictIfNeeded() {
  if (store.size <= CAP) return;
  let oldestKey = null,
    oldestAt = Infinity;
  for (const [k, v] of store)
    if (v.at < oldestAt) {
      oldestAt = v.at;
      oldestKey = k;
    }
  if (oldestKey != null) store.delete(oldestKey);
}

export function put(apiPath: string, obj: any): string | null {
  const type = (resourceFromApiUrl(apiPath) || ({} as any)).type;
  const name = pickName(type, obj);
  store.set(apiPath, { name, obj, at: Date.now(), status: 'done' });
  evictIfNeeded();
  return name;
}

export function setStatus(apiPath: string, status: number | string): void {
  const prev = store.get(apiPath) || { name: null, obj: null, at: Date.now() };
  store.set(apiPath, { ...prev, status });
}

/** What the inline hint needs: the resolution state, and the display name once known. */
export type NameInfo = { status: string; name: string | null };

export function nameFor(apiPath: string): NameInfo | null {
  const e = store.get(apiPath);
  return e ? { status: e.status, name: e.name } : null;
}

export function getFresh(apiPath: string, maxAgeMs = 60000): any {
  const e = store.get(apiPath);
  if (!e || e.status !== 'done' || !e.obj) return null;
  return Date.now() - e.at < maxAgeMs ? e.obj : null;
}

export function clear() {
  store.clear();
}
