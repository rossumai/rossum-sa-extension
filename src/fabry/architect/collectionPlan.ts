// Which collection does the Architect use, and what has to happen first (pure).
//
// The rename from LEGACY_COLLECTION to COLLECTION cannot be a one-shot migration, because
// of a verified hazard: loadArchitect calls ensureCollection, which CREATES the collection
// when absent (api.js:9). So an older build elsewhere — another machine, a profile that has
// not auto-updated yet — recreates the legacy collection on its next boot and writes into
// it. Both names then hold real deliverables. Nothing here ever drops or overwrites either
// one: both are READ and unioned (see mergeDeliverables), and each write follows the document
// it belongs to (`colFor` in api.js). The two collections are therefore never consolidated
// automatically — deliberately. Adopt-on-write was the approved design and was abandoned during
// implementation, because `updateOne` with `upsert` writes a document WITHOUT `kind:'requirement'`,
// which `loadDeliverables` filters on — so an adopted deliverable would vanish from the list — and
// copying wholesale while an older build may still be writing risks reviving stale text over newer.
//
// Existence must come from listCollections. LIVE-VERIFIED: `find` on a collection that does
// not exist returns HTTP 200 with `result: []`, indistinguishable from an empty collection,
// so a find can never answer "does this exist".
import { COLLECTION, LEGACY_COLLECTION } from './collectionNames.js';

/** A deliverable as the app holds it — `mapDocs` in api.ts turns `_id` into `id`. */
export type Deliverable = {
  id: string;
  text: string;
  order: number;
  title: string;
  titleSource: string;
  createdAt: number | null;
  editedAt: number | null;
};

export type CollectionAction = 'none' | 'create' | 'rename' | 'merge';

export type CollectionPlan = {
  use: string;
  legacy: string | null;
  action: CollectionAction;
  /** What to use if a 'rename' throws — the "cannot rename now" case. */
  fallback: string | null;
};

// { hasNew, hasOld } -> { use, legacy, action, fallback }
//
// `action` is what the caller must do BEFORE reading:
//   'none'   — nothing; the new collection is already canonical
//   'create' — fresh org: create the new collection
//   'rename' — legacy only: try to migrate. `fallback` is what to use if that throws,
//              which is the "customers where we cannot rename it now" case: they keep
//              working on the legacy name and the next boot tries again.
//   'merge'  — both exist: read both, prefer the new one per _id, and say so in the UI.
export function planCollection({
  hasNew,
  hasOld,
}: { hasNew?: boolean; hasOld?: boolean } = {}): CollectionPlan {
  if (hasNew && hasOld)
    return { use: COLLECTION, legacy: LEGACY_COLLECTION, action: 'merge', fallback: null };
  if (hasNew) return { use: COLLECTION, legacy: null, action: 'none', fallback: null };
  if (hasOld)
    return {
      use: COLLECTION,
      legacy: LEGACY_COLLECTION,
      action: 'rename',
      fallback: LEGACY_COLLECTION,
    };
  return { use: COLLECTION, legacy: null, action: 'create', fallback: null };
}

// A rename that fails because the target already exists is not a failure: another tab (or
// another window of the same build) won the race, and the collection we wanted now exists.
// The server says so with HTTP 400 and this message — LIVE-VERIFIED, both the status and
// the wording. Matched loosely (lowercased, substring) because the wording is the server's
// to change; the caller re-lists on true either way, so a missed match costs one fallback
// boot on the legacy name, never data.
export function isRaceLostError(err: unknown): boolean {
  // `err &&` already guards the access; a cast emits nothing, unlike `?.`.
  const msg = String((err && ((err as { message?: unknown }).message || err)) || '').toLowerCase();
  return msg.includes('target namespace exists') || msg.includes('already exists');
}

// Union two deliverable lists by id, newest edit winning, ordered like the app expects.
//
// Newest-wins is the only rule that cannot silently lose an edit: whichever build wrote
// last is the one the reader most likely means. `editedAt` is absent on a deliverable that
// has never been edited, so createdAt stands in, and a doc with neither loses to one that
// has either — but is still KEPT when its id is unique to the legacy side.
export function mergeDeliverables(
  primary: Deliverable[] | null | undefined,
  legacy: Deliverable[] | null | undefined,
): Deliverable[] {
  const stamp = (d: Deliverable) =>
    typeof d?.editedAt === 'number'
      ? d.editedAt
      : typeof d?.createdAt === 'number'
        ? d.createdAt
        : -1;
  const byId = new Map();
  for (const d of primary || []) if (d && d.id != null) byId.set(d.id, d);
  for (const d of legacy || []) {
    if (!d || d.id == null) continue;
    const have = byId.get(d.id);
    if (!have || stamp(d) > stamp(have)) byId.set(d.id, d);
  }
  return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Which ids came from the legacy collection only — the count the UI reports, and (through
// `colFor`) the set whose writes keep going to the legacy collection. They stay there until
// somebody consolidates by hand; nothing here moves them.
export function legacyOnlyIds(
  primary: Deliverable[] | null | undefined,
  legacy: Deliverable[] | null | undefined,
): string[] {
  const have = new Set((primary || []).map((d) => d && d.id));
  return (legacy || []).filter((d) => d && d.id != null && !have.has(d.id)).map((d) => d.id);
}
