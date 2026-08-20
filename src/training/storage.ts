// Thin chrome.storage.local layer. Progress is keyed by org ORIGIN (the
// rossumViewedAnnotations pattern) and capped, so a laptop that has visited
// many orgs does not accumulate state forever.
import { migrate } from './progress.js';
import type { Progress } from './progress.js';
import type { Track } from './track.js';

export type { Progress, Track };

/** One org's record. `startedAt` is a creation stamp, not recency — see pruneOrgs. */
export type ProgressByOrigin = Record<string, Progress>;

// The gate is the extension's single hidden-features key. It was
// `trainingUnlocked` until 2026-08-11; any value left under that name in an
// installed profile is orphaned and read by nothing. No migration is needed —
// the only build that ever wrote `trainingUnlocked` wrote `experimentalUnlocked`
// in the same call, so no profile can hold one without the other.
export const UNLOCK_KEY = 'experimentalUnlocked';
export const PROGRESS_KEY = 'trainingProgress';
export const MAX_ORGS = 3;

// `max` bounds the EVICTABLE records; the active origin and any record holding
// an issued receipt are exempt, so the cap is deliberately soft.
//
// Why receipts are exempt: the record is the only copy of a receipt unless the
// trainee already pasted it somewhere, and nothing here can know whether they
// did — so eviction is an unrecoverable loss, while keeping a few hundred extra
// bytes is not a cost worth a data-loss risk. Ranking by a "touched at" stamp
// instead was the alternative; it would need a new field written on every save
// and would STILL evict the receipt of an org the trainee has stopped visiting
// — which is exactly the case where it is most likely to be the only copy.
//
// (`startedAt` is set once at track start and never updated, so it is a
// creation stamp, not a recency stamp. That is fine as a tie-break for
// receiptless records — the worst case there is redoing a track — and is
// precisely why it must NOT be the thing standing between a receipt and
// deletion.)
//
// Precondition unchanged: `keepOrigin` must already be a key of `all` — if it
// is not, it is NOT added, so the "always included" guarantee silently does not
// hold (pinned by tests; unreachable via writeProgress, which merges first).
export function pruneOrgs(
  all: ProgressByOrigin | null | undefined,
  keepOrigin: string,
  max: number = MAX_ORGS,
): ProgressByOrigin {
  const src = all || {};
  const entries = Object.entries(src);
  if (entries.length <= max) return src;
  const kept = new Set(entries.filter(([, v]) => v?.receipt).map(([k]) => k));
  kept.add(keepOrigin);
  const reserved = kept.size;
  const ranked = entries
    .filter(([k]) => !kept.has(k))
    .sort((a, b) => (b[1]?.startedAt || 0) - (a[1]?.startedAt || 0));
  for (const [k] of ranked.slice(0, Math.max(0, max - reserved))) kept.add(k);
  const out: ProgressByOrigin = {};
  for (const [k, v] of entries) if (kept.has(k)) out[k] = v;
  return out;
}

async function readAll(): Promise<ProgressByOrigin> {
  const got = await chrome.storage.local.get([PROGRESS_KEY]);
  // chrome.storage is untyped at rest; assert the shape once, here at the boundary.
  return (got?.[PROGRESS_KEY] as ProgressByOrigin | undefined) || {};
}

export async function readProgress(origin: string, track: Track): Promise<Progress | null> {
  const stored = (await readAll())[origin];
  if (!stored) return null;
  // `stored` is non-null here, so migrate cannot return undefined; a cast keeps the
  // emitted call unchanged where `?? null` would not.
  return migrate(track, stored) as Progress | null;
}

export async function writeProgress(origin: string, next: Progress): Promise<void> {
  const all = await readAll();
  const merged = pruneOrgs({ ...all, [origin]: next }, origin);
  await chrome.storage.local.set({ [PROGRESS_KEY]: merged });
}

export async function clearProgress(origin: string): Promise<void> {
  const all = await readAll();
  delete all[origin];
  await chrome.storage.local.set({ [PROGRESS_KEY]: all });
}
