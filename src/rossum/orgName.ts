// The organization as the org-name feature and the Console see it: which one the session
// is in, how it is labelled, whether the feature is on, and how it is cached. Pure — the
// feature (features/org-name.ts) and the loader (orgSource.ts) do the I/O.

// The organization the session is in, from `GET /organizations`. That list holds what
// the session's token can see — the one organization it is in — and it is what the
// Rossum UI reads too. `auth/user`'s `organization` is NOT a substitute: it names the
// user's HOME organization, and for a service or system user that is one the session
// cannot even read (404, measured on a dedicated cell 2026-09-23). More than one
// organization, or none, names nothing: which is current cannot be told, and a wrong
// name is worse than no name.
//
// `sandbox` is `organization.sandbox === true` and nothing else: the flag marks usage
// outside the fair-usage policy, so anything else, a missing flag included, is billed
// as production.
export type Org = {
  name: string;
  id: number | null;
  sandbox: boolean;
  /** Its organization group's API path on this origin, to read the deployment location. */
  groupPath: string | null;
  /** Where the group is deployed (`eu2`, from `prod-eu2`); null until read, or when it cannot be. */
  location: string | null;
};

export function currentOrg(list: unknown): Org | null {
  const results = (list as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== 1) return null;
  const { name, id, sandbox, organization_group: group } = results[0] ?? {};
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    name: name.trim(),
    id: typeof id === 'number' ? id : null,
    sandbox: sandbox === true,
    groupPath: groupPathOf(group),
    location: null,
  };
}

// Only the path is kept, and always requested on the page's own origin.
function groupPathOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const { pathname } = new URL(url);
    return /^\/api\/v1\/organization_groups\/\d+$/.test(pathname) ? pathname : null;
  } catch {
    return null;
  }
}

// A cached organization, as features/org-name.ts keeps it in the tab's sessionStorage:
// `{ at, org }`. The id never changes and the name and cell almost never do, so a page
// reload need not ask again; a day bounds how long a rename goes unseen. Anything else —
// expired, malformed, not ours — reads as no entry.
export const ORG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cachedOrg(raw: string | null, now: number): Org | null {
  if (!raw) return null;
  let entry: { at?: unknown; org?: Partial<Org> } | null;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  const org = entry?.org;
  if (typeof entry?.at !== 'number' || now - entry.at >= ORG_CACHE_TTL_MS) return null;
  if (!org || typeof org.name !== 'string' || !org.name) return null;
  if (typeof org.sandbox !== 'boolean' || !('id' in org) || !('location' in org)) return null;
  return {
    name: org.name,
    id: typeof org.id === 'number' ? org.id : null,
    sandbox: org.sandbox,
    // It decides where a token-bearing request goes, so it is checked like a fresh one.
    groupPath: groupPathOf(`https://x${org.groupPath ?? ''}`),
    location: typeof org.location === 'string' ? org.location : null,
  };
}

// Where cachedOrg's entry lives in the tab's sessionStorage: a hash of the session token,
// never the token itself — FNV-1a, enough to tell a tab's few tokens apart, synchronous.
export const ORG_CACHE_PREFIX = 'rossum-sa-extension-org:';

export function orgCacheKey(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 0x01000193);
  return `${ORG_CACHE_PREFIX}${(hash >>> 0).toString(16)}`;
}

// The cell the organization group is deployed in (`eu2` for `prod-eu2`), read off the
// group — every role tried (admin, manager, annotator) can read it.
export function deploymentLocation(group: unknown): string | null {
  const location = (group as { deployment_location?: unknown } | null)?.deployment_location;
  if (typeof location !== 'string' || !location) return null;
  // Every cell a client or SA ever sees is a production one, and "prod" beside a sandbox
  // chip reads as a contradiction; any other prefix stays, so a non-production one stands out.
  return location.replace(/^prod-/, '');
}

// How the organization is named on screen: its name, its id, then its deployment location
// when known — `Acme: 7 [eu2]` in the header, `Acme · org: 7 [eu2]` in the Console.
export const orgLabel = (org: Org, separator = ': '): string =>
  (org.id === null ? org.name : `${org.name}${separator}${org.id}`) +
  (org.location ? ` [${org.location}]` : '');

// The feature's switch, and the ONE place its default lives. It is the one toggle that
// defaults ON: an absent key means enabled and only an explicit `false` disables it.
// Every other toggle reads a missing key as off, so this must never be coerced —
// `!!undefined` hides the name from everyone who has never opened the popup, and shows
// the popup's switch off while the feature runs.
export const ORG_NAME_KEY = 'orgNameEnabled';
export const orgNameOn = (stored: unknown): boolean => stored !== false;
