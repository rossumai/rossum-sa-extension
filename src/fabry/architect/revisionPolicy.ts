// When a deliverable edit becomes a version, and which versions age out (pure).
//
// The source editors autosave after 600ms of idle typing (`SourceColumn.onEdit` in
// components/SpecView.jsx), so
// "one version per save" would mint dozens per paragraph. A version is therefore minted
// per EDITING SESSION: on the first save of a session the PRE-EDIT text is stored, and
// every later save in that session writes nothing extra. History then reads as "what it
// looked like before each sitting", at a cost of one insert per sitting.
//
// A session ends when the author pauses longer than IDLE_MS, switches deliverable, or
// when the source changes — a human edit following an accepted Refine proposal is a
// different act and deserves its own entry.
export const IDLE_MS = 5 * 60 * 1000;

// Per deliverable. Chosen so a long working day cannot silently discard the state a
// specification started from — hence the earliest revision is never the one pruned.
export const CAP = 40;


// session: { deliverableId, source, lastAt } | null
/** One editing session. A version is stored per SESSION, not per save. */
export type EditSession = { deliverableId: string; source: string; lastAt: number };

export function shouldSnapshot(
  { session, deliverableId, source = 'edit', now = 0, idleMs = IDLE_MS }:
    { session?: EditSession | null; deliverableId?: string; source?: string; now?: number; idleMs?: number } = {},
): boolean {
  if (!session) return true;
  if (session.deliverableId !== deliverableId) return true;
  if (session.source !== source) return true;
  return now - (session.lastAt || 0) > idleMs;
}

export function openSession(
  { deliverableId, source = 'edit', now = 0 }: { deliverableId: string; source?: string; now?: number },
): EditSession {
  return { deliverableId, source, lastAt: now };
}

export function touchSession(session: EditSession, now: number): EditSession {
  return session ? { ...session, lastAt: now } : session;
}

// Ids to delete so at most `cap` revisions remain for one deliverable. The EARLIEST is
// always kept: it is the only copy of where the document started, and unlike every later
// revision it cannot be reconstructed from what survives. Same reasoning as
// storage.js pruneOrgs never evicting a record that holds a receipt.
export function prunePlan(revisions: any[], cap = CAP): string[] {
  const list = (revisions || [])
    .filter((r: any) => r && r.id != null)
    // newest first; id breaks ties so the plan is deterministic for equal timestamps
    .sort((a: any, b: any) => (b.at || 0) - (a.at || 0) || String(a.id).localeCompare(String(b.id)));
  if (list.length <= cap || cap < 1) return [];
  const keep = new Set([list[list.length - 1].id, ...list.slice(0, cap - 1).map((r: any) => r.id)]);
  return list.filter((r: any) => !keep.has(r.id)).map((r: any) => r.id);
}
