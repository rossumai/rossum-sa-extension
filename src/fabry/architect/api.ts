// Data Storage wrapper for the Architect collection: deliverables, their persisted
// last-run results, and (2026-08-18) their version history as sibling `kind:'revision'`
// documents.
//
// The collection NAME is resolved at boot rather than hard-coded, because the rename to
// `_SA_EXTENSION__fabry_architect` cannot happen on every org at the same moment — see
// collectionPlan.js for the four states and why a failed rename must be a no-op rather
// than an error. Everything below writes through `colFor(id)`, never a literal.
import * as mdh from '../../mdh/api.js';
import { COLLECTION, LEGACY_COLLECTION } from './collectionNames.js';
import { planCollection, isRaceLostError, mergeDeliverables, legacyOnlyIds } from './collectionPlan.js';
import type { CollectionPlan, Deliverable } from './collectionPlan.js';
import { CAP as REVISION_CAP } from './revisionPolicy.js';

export { COLLECTION, LEGACY_COLLECTION };
export const JOURNAL_CAP = 10;

/** A persisted check verdict. `stale` is always true on load — see saveResult. */
export type CheckResult = {
  /** null while a check is in flight and no earlier verdict exists. */
  verdict: string | null;
  evidence: string;
  chatId: string | null;
  ranAt?: number | null;
  stale?: boolean;
  /** In-flight spinner; cleared by clearRunningFlags on teardown. */
  running?: boolean;
  /** The check itself failed to complete (transport), as opposed to returning a verdict. */
  error?: boolean;
};

/** Persisted implement-loop state for one deliverable. */
export type ImplementState = {
  status: string;
  attempt: number;
  writes: any[];
  summary: string;
  chatId: string | null;
  journal: any[];
  tasks: any[];
  ranAt: number | null;
  stale: boolean;
};

export type LoadedDeliverables = {
  deliverables: Deliverable[];
  results: Record<string, CheckResult>;
  implement: Record<string, ImplementState>;
  /** How many deliverables still live only in the legacy collection. */
  legacyCount: number;
};

/** What resolveCollection reports: the plan, plus what actually happened. */
export type CollectionResolution = Omit<CollectionPlan, 'fallback'> & {
  fallback?: string | null;
  migrated: boolean;
  /** Another tab renamed it first — which IS the merge state. */
  raceLost?: boolean;
  listError?: string;
  migrateError?: string;
};

/** What supersedes the stored text — see revisionPolicy.js. */
export type RevisionSource = 'edit' | 'refine' | 'restore';

// Resolved by resolveCollection(). `current` is where new documents go; `legacy` is set
// only in the merge state (both collections exist), where it is READ but never renamed
// or dropped.
let current = COLLECTION;
let legacy: string | null = null;
// id -> collection the document actually lives in. Writes follow the document instead of
// assuming `current`: in the merge state a legacy-resident deliverable updated against the
// new collection would match zero docs and the edit would be silently lost. An upsert is
// NOT the fix — it would create a doc without `kind:'requirement'`, which loadDeliverables
// filters on, so the deliverable would vanish from the list instead.
const origin = new Map<string, string>();

export function activeCollection() { return current; }
export function legacyCollection() { return legacy; }
export function collectionOf(id: string): string { return origin.get(id) || current; }
function colFor(id: string): string { return collectionOf(id); }

// Test seam + boot reset: forget any resolution from a previous org/tab.
export function resetCollection(next: string = COLLECTION, legacyName: string | null = null): void {
  current = next; legacy = legacyName; origin.clear();
}

export async function ensureCollection(): Promise<void> {
  try { await mdh.createCollection(current); }
  catch (err) { if ((err as mdh.ApiError)?.status === 401) throw err; }
}

// Decide which collection this org uses, migrating it when that is possible. Returns the
// plan plus what actually happened, so the UI can report a migration or a legacy remainder.
//
// Existence comes from listCollections and nothing else: LIVE-VERIFIED that `find` on a
// missing collection returns 200 with an empty result, so it cannot answer this question.
export async function resolveCollection(): Promise<CollectionResolution> {
  let names: string[] = [];
  try {
    const res = await mdh.listCollections(null, true);
    names = (res && res.result) || [];
  } catch (err) {
    if ((err as mdh.ApiError)?.status === 401) throw err;
    // Cannot list (permissions, transient): assume the legacy name, which is what every
    // existing org has. Guessing the NEW name here would create a second empty collection.
    resetCollection(LEGACY_COLLECTION, null);
    return { use: LEGACY_COLLECTION, legacy: null, action: 'none', migrated: false, listError: (err as Error)?.message || 'could not list collections' };
  }
  const set = new Set(names);
  const plan = planCollection({ hasNew: set.has(COLLECTION), hasOld: set.has(LEGACY_COLLECTION) });

  if (plan.action === 'create') {
    resetCollection(COLLECTION, null);
    await ensureCollection();
    return { ...plan, migrated: false };
  }
  if (plan.action === 'rename') {
    try {
      await mdh.renameCollection(LEGACY_COLLECTION, COLLECTION, false);
      resetCollection(COLLECTION, null);
      return { ...plan, migrated: true };
    } catch (err) {
      if ((err as mdh.ApiError)?.status === 401) throw err;
      if (isRaceLostError(err)) {
        // Another tab renamed it first, so the new collection exists — but ours did not
        // move, so the legacy one still does too. That is precisely the merge state.
        resetCollection(COLLECTION, LEGACY_COLLECTION);
        return { ...plan, action: 'merge', use: COLLECTION, legacy: LEGACY_COLLECTION, migrated: false, raceLost: true };
      }
      // "Customers where we cannot rename it now": stay on the legacy collection, fully
      // functional, and try again on the next boot. Not surfaced as an error.
      resetCollection(plan.fallback || LEGACY_COLLECTION, null);
      return { ...plan, use: plan.fallback || LEGACY_COLLECTION, migrated: false, migrateError: (err as Error)?.message || 'rename failed' };
    }
  }
  resetCollection(COLLECTION, plan.legacy);
  return { ...plan, migrated: false };
}

function mapDocs(docs: mdh.DsDocument[]): Omit<LoadedDeliverables, 'legacyCount'> {
  const deliverables: Deliverable[] = docs.map((d) => ({
    id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0,
    title: typeof d.title === 'string' ? d.title : '',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : null,
    editedAt: typeof d.editedAt === 'number' ? d.editedAt : null,
    // Absent on every doc written before titleSource existed — '' there means
    // "unmarked", which displayTitle reads as AI-generated (see format.js).
    titleSource: typeof d.titleSource === 'string' ? d.titleSource : '',
  }));
  const results: Record<string, CheckResult> = {};
  const implement: Record<string, ImplementState> = {};
  for (const d of docs) {
    if (d.lastVerdict) {
      results[d._id] = { verdict: d.lastVerdict, evidence: d.lastEvidence || '', chatId: d.lastChatId || null, ranAt: d.ranAt || null, stale: true };
    }
    if (d.implementStatus) {
      implement[d._id] = {
        status: d.implementStatus, attempt: d.attempts || 0,
        writes: Array.isArray(d.lastImplementWrites) ? d.lastImplementWrites : [],
        summary: d.lastImplementSummary || '', chatId: d.lastImplementChatId || null,
        journal: Array.isArray(d.implementJournal) ? d.implementJournal : [],
        tasks: Array.isArray(d.implementTasks) ? d.implementTasks : [],
        ranAt: d.implementRanAt || null, stale: true,
      };
    }
  }
  return { deliverables, results, implement };
}

async function readCollection(name: string): Promise<Omit<LoadedDeliverables, 'legacyCount'>> {
  const res = await mdh.find(name, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  return mapDocs((res && res.result) || []);
}

export async function loadDeliverables(): Promise<LoadedDeliverables> {
  const primary = await readCollection(current);
  origin.clear();
  for (const d of primary.deliverables) origin.set(d.id, current);
  if (!legacy) return { ...primary, legacyCount: 0 };

  // Merge state. A legacy read that fails must not take the primary list down with it —
  // the new collection is the canonical one and is already in hand.
  let old: Omit<LoadedDeliverables, 'legacyCount'> = { deliverables: [], results: {}, implement: {} };
  try { old = await readCollection(legacy); } catch { /* legacy unreadable: primary stands */ }
  const deliverables = mergeDeliverables(primary.deliverables, old.deliverables);
  const legacyOnly = new Set(legacyOnlyIds(primary.deliverables, old.deliverables));
  for (const id of legacyOnly) origin.set(id, legacy);
  return {
    deliverables,
    // Primary-preferred: a result is cosmetic next to the text, and every loaded result is
    // already marked stale, so the worst case is one extra re-run.
    results: { ...old.results, ...primary.results },
    implement: { ...old.implement, ...primary.implement },
    legacyCount: legacyOnly.size,
  };
}

export function addDeliverable(
  { id, text, order, createdAt }: { id: string; text: string; order: number; createdAt: number },
): Promise<any> {
  origin.set(id, current);
  return mdh.insertOne(current, { _id: id, kind: 'requirement', text, order, createdAt });
}
export function updateDeliverable(id: string, text: string, editedAt: number): Promise<any> {
  return mdh.updateOne(colFor(id), { _id: id }, { $set: { text, editedAt } });
}
export function deleteDeliverable(id: string): Promise<any> {
  return mdh.deleteOne(colFor(id), { _id: id });
}
export function saveResult(
  id: string,
  { verdict, evidence, chatId, ranAt }: Omit<CheckResult, 'stale'>,
): Promise<any> {
  return mdh.updateOne(colFor(id), { _id: id }, { $set: { lastVerdict: verdict, lastEvidence: evidence, lastChatId: chatId, ranAt } });
}
export function setOrder(id: string, order: number): Promise<any> {
  return mdh.updateOne(colFor(id), { _id: id }, { $set: { order } });
}
// `titleSource` is 'manual' (a rename) or 'ai' (generated). An older build
// ignores the extra key and still reads `title`, so this stays readable both ways.
export function saveTitle(id: string, title: string, titleSource: 'manual' | 'ai'): Promise<any> {
  return mdh.updateOne(colFor(id), { _id: id }, { $set: { title, titleSource } });
}
// The manual state was DROPPED on 2026-08-19 (owner: "let's drop the manual labels, rely only on the
// LLM labels"), so nothing writes `state`/`stateDate` any more. Existing documents keep those fields —
// they are simply no longer read, and an older build still shows what it wrote. Nothing deletes
// customer data to retire a feature.

export type ImplementResultInput = {
  status: string;
  attempts: number;
  writes?: any[];
  summary?: string;
  chatId?: string | null;
  ranAt: number | null;
  journal?: any[];
  tasks?: any[];
};

export function saveImplementResult(id: string, {
  status, attempts, writes, summary, chatId, ranAt, journal, tasks,
}: ImplementResultInput): Promise<any> {
  return mdh.updateOne(colFor(id), { _id: id }, { $set: {
    implementStatus: status, attempts, lastImplementWrites: writes || [], lastImplementSummary: summary || '',
    lastImplementChatId: chatId || null, implementRanAt: ranAt, implementJournal: (journal || []).slice(-JOURNAL_CAP),
    implementTasks: Array.isArray(tasks) ? tasks : [],
  } });
}


// ── Version history (2026-08-18) ───────────────────────────────────────────────
// One document per version, `kind:'revision'`, beside the deliverable it belongs to.
// loadDeliverables queries `kind:'requirement'`, so these are invisible to this build's
// normal load AND to every older build — the additive-key precedent (titleSource, state)
// applied to whole documents. Full text per revision rather than a patch chain: restore is
// then a plain write and no single bad entry can corrupt the middle of a history.
export function listRevisions(deliverableId: string, limit: number = REVISION_CAP + 1): Promise<any> {
  // `text` is projected out: a specification is long and the list only shows when/who.
  return mdh.find(colFor(deliverableId), {
    query: { kind: 'revision', deliverableId },
    projection: { text: 0 }, sort: { at: -1 }, limit,
  });
}

export function getRevision(deliverableId: string, revisionId: string): Promise<any> {
  return mdh.find(colFor(deliverableId), { query: { kind: 'revision', _id: revisionId }, limit: 1 });
}

export function addRevision(
  { id, deliverableId, text, at, source }:
    { id: string; deliverableId: string; text: string; at: number; source: RevisionSource },
): Promise<any> {
  return mdh.insertOne(colFor(deliverableId), {
    _id: id, kind: 'revision', deliverableId, text, at, source,
  });
}

export function deleteRevisions(deliverableId: string, ids: string[] | null | undefined): Promise<any> {
  if (!ids || !ids.length) return Promise.resolve(null);
  return mdh.deleteMany(colFor(deliverableId), { kind: 'revision', _id: { $in: ids } });
}

// A deleted deliverable takes its history with it — otherwise the collection accretes
// orphans no UI can ever reach.
export function deleteRevisionsFor(deliverableId: string): Promise<any> {
  return mdh.deleteMany(colFor(deliverableId), { kind: 'revision', deliverableId });
}
