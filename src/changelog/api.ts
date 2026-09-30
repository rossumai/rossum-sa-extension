// Configuration changelog client for the DevTools panel's version history.
// Transport-free: the caller passes a GetJson bound to its own domain and token.
// Contract live-probed 2026-09-29; see
// docs/superpowers/specs/2026-09-29-config-changelog-in-context-design.md §2.

export type ObjectType =
  'hook' | 'schema' | 'queue' | 'rule' | 'email_template' | 'trigger' | 'workspace';

export type ChangelogEntry = {
  version_id: number;
  object_type: ObjectType;
  object_id: number;
  /** Absent for triggers, null on every delete (§2e, §2h). */
  name?: string | null;
  version_event: 'create' | 'update' | 'delete';
  /** Top-level keys only; empty for create and delete (§2f). */
  changed_fields: string[];
  version_created_at: string;
  /** null for system changes AND for every delete (§2h). */
  modifier_id: number | null;
  description?: string | null;
  /** The object at this version. Untyped wire object, and NOT the live GET shape (§2j). */
  snapshot?: any;
};

export type ChangelogFilters = {
  objectTypes?: ObjectType[];
  objectIds?: number[];
  versionIdMax?: number;
};

export type ChangelogPage = { entries: ChangelogEntry[]; total: number | null; hasMore: boolean };

/** GET an `/api/v1/…` path. Resolves parsed JSON; rejects with an Error carrying `status`. */
export type GetJson = (apiPath: string) => Promise<any>;

const PAGE_SIZE = 100;

const CHANGELOG = '/api/v1/configuration_changelog';

export function changelogPath(f: ChangelogFilters, page = 1, pageSize = PAGE_SIZE): string {
  const q = new URLSearchParams();
  if (f.objectTypes?.length) q.set('object_type', f.objectTypes.join(','));
  if (f.objectIds?.length) q.set('object_id', f.objectIds.join(','));
  if (f.versionIdMax != null) q.set('version_id_range_max', String(f.versionIdMax));
  q.set('page', String(page));
  q.set('page_size', String(pageSize));
  return `${CHANGELOG}?${q.toString()}`;
}

export async function listEntries(
  get: GetJson,
  f: ChangelogFilters,
  page = 1,
  pageSize = PAGE_SIZE,
): Promise<ChangelogPage> {
  const res = await get(changelogPath(f, page, pageSize));
  const entries: ChangelogEntry[] = Array.isArray(res?.results) ? res.results : [];
  const total = typeof res?.pagination?.total === 'number' ? res.pagination.total : null;
  return { entries, total, hasMore: !!res?.pagination?.next };
}

// Both snapshots in ONE request (§2l). A version the server leaves out is simply absent
// from the map; callers decide what a missing snapshot means.
export async function snapshotPair(get: GetJson, versionIds: number[]): Promise<Map<number, any>> {
  const q = new URLSearchParams({
    version_id: versionIds.join(','),
    include_snapshot: 'true',
    page_size: String(versionIds.length),
  });
  const res = await get(`${CHANGELOG}?${q.toString()}`);
  const out = new Map<number, any>();
  for (const e of res?.results || []) if (e && e.snapshot) out.set(e.version_id, e.snapshot);
  return out;
}

export async function previousVersion(
  get: GetJson,
  type: ObjectType,
  id: number,
  before: number,
): Promise<ChangelogEntry | null> {
  const page = await listEntries(
    get,
    { objectTypes: [type], objectIds: [id], versionIdMax: before - 1 },
    1,
    1,
  );
  return page.entries[0] || null;
}

// `/users` lists only members of the CURRENT org (§2p): an id from another org is simply
// not in the result, and the caller shows "User <id>".
export async function resolveUsers(get: GetJson, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += PAGE_SIZE) {
    const chunk = uniq.slice(i, i + PAGE_SIZE);
    const res = await get(`/api/v1/users?id=${chunk.join(',')}&page_size=${PAGE_SIZE}`);
    for (const u of res?.results || []) out.set(u.id, userLabel(u));
  }
  return out;
}

// A raw /users row (untyped wire object).
function userLabel(u: any): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  const base = full || u.email || `User ${u.id}`;
  return u.deleted ? `${base} (deleted)` : base;
}

export function isForbidden(e: unknown): boolean {
  return (e as any)?.status === 403;
}
