// Session-storage caches for the MDH provenance panel.
// Each cache has a 5-minute TTL and is keyed by domain + scope.

const TTL_MS = 5 * 60 * 1000;

// ── Hook entries (per queue) ──

// v2: cfg.queries entries gained a precomputed `placeholders` array.
const HOOKS_PREFIX = 'mdhProv:hooks:v2:';

const hooksKey = (domain, queueId) => `${HOOKS_PREFIX}${domain}#${queueId}`;

export async function getCachedHookEntries(domain, queueId) {
  const key = hooksKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.entries;
}

export async function setCachedHookEntries(domain, queueId, entries) {
  // Persist only the fields the popup uses; avoid the full hook detail blob.
  const trimmed = entries.map(({ hook, cfgs }) => ({
    hook: { id: hook.id, name: hook.name },
    cfgs,
  }));
  await chrome.storage.session.set({
    [hooksKey(domain, queueId)]: { entries: trimmed, fetchedAt: Date.now() },
  });
}

// ── Annotation values (skips metadata + content fetches on warm reopen) ──

const ANN_PREFIX = 'mdhProv:ann:';

const annKey = (domain, annotationId) => `${ANN_PREFIX}${domain}#${annotationId}`;

export async function getCachedAnnotation(domain, annotationId) {
  if (!annotationId) return null;
  const key = annKey(domain, annotationId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry;
}

export async function setCachedAnnotation(domain, annotationId, data) {
  if (!annotationId) return;
  await chrome.storage.session.set({
    [annKey(domain, annotationId)]: { ...data, fetchedAt: Date.now() },
  });
}

export async function dropCachedAnnotation(domain, annotationId) {
  if (!annotationId) return;
  await chrome.storage.session.remove(annKey(domain, annotationId));
}

// ── Replay statuses (keyed by annotation modified_at) ──

const REPLAY_PREFIX = 'mdhProv:replay:';

const replayKey = (domain, annotationId, modifiedAt, rowIdx, cfgKey) =>
  `${REPLAY_PREFIX}${domain}#${annotationId}#${modifiedAt}#${rowIdx}#${cfgKey}`;

export async function getCachedReplay(domain, annotationId, modifiedAt, rowIdx, cfgKey) {
  if (!annotationId || !modifiedAt) return null;
  const key = replayKey(domain, annotationId, modifiedAt, rowIdx, cfgKey);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.statuses;
}

export async function setCachedReplay(domain, annotationId, modifiedAt, rowIdx, cfgKey, statuses) {
  if (!annotationId || !modifiedAt || !statuses) return;
  if (!statuses.every((s) => s != null)) return;
  await chrome.storage.session.set({
    [replayKey(domain, annotationId, modifiedAt, rowIdx, cfgKey)]: {
      statuses,
      fetchedAt: Date.now(),
    },
  });
}
