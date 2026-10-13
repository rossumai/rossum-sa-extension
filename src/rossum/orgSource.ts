// Loads the organization for the org-name feature and the Console: the organization the
// session is in, then its group's deployment location. `show` gets the organization as
// soon as it is known — the name never waits for the group — and again with the location;
// returning `false` says the answer is no longer wanted (an organization switch), and
// stops the load. `get` is the caller's transport.
//
// With a session token, the result is cached in the tab's sessionStorage for a day
// (orgName.ts cachedOrg / orgCacheKey); the Console passes none and is not cached.
import {
  cachedOrg,
  currentOrg,
  deploymentLocation,
  orgCacheKey,
  ORG_CACHE_PREFIX,
  type Org,
} from './orgName.js';

type Get = (path: string) => Promise<unknown>;

// An entry is `{ at, org, located }`: `located` says the group was read, so a group with
// no deployment location is not asked again on every reload.
type Entry = { org: Org; at: number; located: boolean };

function readCache(key: string): Entry | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    const now = Date.now();
    const org = cachedOrg(raw, now);
    if (!org) return null;
    const { at, located } = JSON.parse(raw!);
    return { org, at, located: located === true };
  } catch {
    return null;
  }
}

// One entry per tab: the current session's. A token switch leaves the old one behind, and
// nothing else would ever remove it.
function writeCache(key: string, entry: Entry) {
  try {
    for (const old of Object.keys(window.sessionStorage)) {
      if (old.startsWith(ORG_CACHE_PREFIX) && old !== key) window.sessionStorage.removeItem(old);
    }
    window.sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* no cache, no harm */
  }
}

export async function loadOrg({
  get,
  cacheToken = null,
  withLocation,
  show,
}: {
  get: Get;
  cacheToken?: string | null;
  withLocation: boolean;
  show: (org: Org) => boolean | void;
}): Promise<void> {
  const key = cacheToken ? orgCacheKey(cacheToken) : null;
  const cached = key ? readCache(key) : null;
  let org = cached?.org ?? null;
  // The day is counted from the API's answer: rewriting an entry on every reload would
  // restart it, and a rename would never show in a tab reloaded daily. Adding the cell to
  // an entry keeps its original `at`.
  const at = cached?.at ?? Date.now();
  let located = cached?.located ?? false;
  let changed = !cached;
  if (!org) {
    try {
      org = currentOrg(await get('/api/v1/organizations'));
    } catch {
      /* no organization */
    }
  }
  if (!org || show(org) === false) return;
  if (withLocation && !located && org.groupPath) {
    try {
      const location = deploymentLocation(await get(org.groupPath));
      located = true;
      changed = true;
      if (location) {
        org = { ...org, location };
        if (show(org) === false) return;
      }
    } catch {
      /* named without the location; asked again next time */
    }
  }
  if (key && changed) writeCache(key, { org, at, located });
}
