import { resourceFromApiUrl } from './resourceFromApiUrl.js';
import * as cache from './resourceCache.js';
import { getJson as apiGetJson } from './api.js';

const DEFAULT_CAP = 6;

function nameable(url: string): string | null {
  const r = resourceFromApiUrl(url);
  return r && r.id && !r.readOnly ? r.apiPath : null;
}

// NOTE: `pending`/`queue`/`active` are per-resolver-instance while the cache is a
// shared singleton. Use ONE resolver instance per session (see the exported
// `resolver` below); two live instances could dedupe against each other's
// in-flight cache state and drop a subscriber. Production mounts one editor at a time.
export function makeNameResolver(getJson: (apiPath: string) => unknown, cap = DEFAULT_CAP) {
  const pending = new Map<string, Set<() => void>>(); // apiPath -> Set<cb>
  const queue: string[] = [];
  let active = 0;

  function notify(apiPath: string) {
    const set = pending.get(apiPath);
    pending.delete(apiPath);
    if (set) for (const cb of set) { try { cb(); } catch { /* ignore */ } }
  }
  function pump() {
    while (active < cap && queue.length) {
      const apiPath = queue.shift()!;
      active += 1;
      Promise.resolve(getJson(apiPath))
        .then((obj) => cache.put(apiPath, obj))
        .catch(() => cache.setStatus(apiPath, 'error'))
        .finally(() => { active -= 1; notify(apiPath); pump(); });
    }
  }

  return {
    nameFor(url: string) {
      const apiPath = nameable(url);
      if (!apiPath) return null;
      return cache.nameFor(apiPath) || { status: 'none', name: null };
    },
    ensure(url: string, onChange?: () => void) {
      const apiPath = nameable(url);
      if (!apiPath) return;
      const e = cache.nameFor(apiPath);
      if (e && (e.status === 'done' || e.status === 'error')) return; // settled
      if (onChange) { if (!pending.has(apiPath)) pending.set(apiPath, new Set()); pending.get(apiPath)!.add(onChange); }
      if (e && e.status === 'loading') return; // already in flight
      cache.setStatus(apiPath, 'loading');
      queue.push(apiPath);
      pump();
    },
  };
}

export const resolver = makeNameResolver(apiGetJson);
