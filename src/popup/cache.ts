// Session-storage caches for the MDH provenance panel.
// Each cache has a 5-minute TTL and is keyed by domain + scope.

const TTL_MS = 5 * 60 * 1000;

// chrome.storage.session is untyped at rest; each cache asserts its own entry shape
// at the read, which is also the only place the TTL field is named.
type Cached<T> = { fetchedAt?: number } & T;

// ── Hook entries (per queue) ──

// v3: cfg entries gained `actionCondition`, `actionConditionPlaceholders`,
// and `additionalMappings`. v2 entries lack these — treating them as null
// would mis-render hooks that actually have action_condition / extra mappings,
// so bump the prefix and let stale entries fall through to a refetch.
const HOOKS_PREFIX = 'mdhProv:hooks:v3:';

const hooksKey = (domain: string, queueId: string | number) =>
  `${HOOKS_PREFIX}${domain}#${queueId}`;

export async function getCachedHookEntries(
  domain: string,
  queueId: string | number,
): Promise<any[] | null> {
  const key = hooksKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as Cached<{ entries: any[] }> | undefined;
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.entries;
}

export async function setCachedHookEntries(
  domain: string,
  queueId: string | number,
  entries: any[],
): Promise<void> {
  // Persist only the fields the popup uses; avoid the full hook detail blob.
  const trimmed = entries.map(({ hook, cfgs }: { hook: any; cfgs: any }) => ({
    hook: { id: hook.id, name: hook.name },
    cfgs,
  }));
  await chrome.storage.session.set({
    [hooksKey(domain, queueId)]: { entries: trimmed, fetchedAt: Date.now() },
  });
}

// ── Schema types (per queue) ──
const SCHEMA_PREFIX = 'mdhProv:schemaTypes:v1:';
const schemaKey = (domain: string, queueId: string | number) =>
  `${SCHEMA_PREFIX}${domain}#${queueId}`;

export async function getCachedSchemaTypes(
  domain: string,
  queueId: string | number,
): Promise<any | null> {
  if (!queueId) return null;
  const key = schemaKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as Cached<{ types: any }> | undefined;
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.types;
}

export async function setCachedSchemaTypes(
  domain: string,
  queueId: string | number,
  types: any,
): Promise<void> {
  if (!queueId) return;
  await chrome.storage.session.set({
    [schemaKey(domain, queueId)]: { types, fetchedAt: Date.now() },
  });
}

// ── Annotation values (skips metadata + content fetches on warm reopen) ──

// v3: types are now derived from `content.normalized_value` (Rossum's
// content endpoint doesn't return a per-datapoint `type` field, so the
// v2 cache always stored an empty `types` map).
// v4: entries gained `tables` (per-table row counts + columns). A v3 entry has
// no `tables`, which would leave every row picker hidden until the 5-minute TTL
// expired — the row scope has no other source, so bump rather than tolerate it.
const ANN_PREFIX = 'mdhProv:ann:v4:';

const annKey = (domain: string, annotationId: string | number) =>
  `${ANN_PREFIX}${domain}#${annotationId}`;

export async function getCachedAnnotation(
  domain: string,
  annotationId: string | number,
): Promise<any | null> {
  if (!annotationId) return null;
  const key = annKey(domain, annotationId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as Cached<{ data?: any }> | undefined;
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry;
}

export async function setCachedAnnotation(
  domain: string,
  annotationId: string | number,
  data: any,
): Promise<void> {
  if (!annotationId) return;
  await chrome.storage.session.set({
    [annKey(domain, annotationId)]: { ...data, fetchedAt: Date.now() },
  });
}

export async function dropCachedAnnotation(
  domain: string,
  annotationId: string | number,
): Promise<void> {
  if (!annotationId) return;
  await chrome.storage.session.remove(annKey(domain, annotationId));
}

// ── Replay statuses (keyed by annotation modified_at) ──

const REPLAY_PREFIX = 'mdhProv:replay:';

const replayKey = (
  domain: string,
  annotationId: string | number,
  modifiedAt: string | number | null | undefined,
  rowIdx: number,
  cfgKey: string,
) => `${REPLAY_PREFIX}${domain}#${annotationId}#${modifiedAt}#${rowIdx}#${cfgKey}`;

export async function getCachedReplay(
  domain: string,
  annotationId: string | number,
  modifiedAt: string | number | null | undefined,
  rowIdx: number,
  cfgKey: string,
): Promise<any[] | null> {
  if (!annotationId || !modifiedAt) return null;
  const key = replayKey(domain, annotationId, modifiedAt, rowIdx, cfgKey);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as Cached<{ statuses: any[] }> | undefined;
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.statuses;
}

export async function setCachedReplay(
  domain: string,
  annotationId: string | number,
  modifiedAt: string | number | null | undefined,
  rowIdx: number,
  cfgKey: string,
  statuses: any[],
): Promise<void> {
  if (!annotationId || !modifiedAt || !statuses) return;
  if (!statuses.every((s: unknown) => s != null)) return;
  await chrome.storage.session.set({
    [replayKey(domain, annotationId, modifiedAt, rowIdx, cfgKey)]: {
      statuses,
      fetchedAt: Date.now(),
    },
  });
}
