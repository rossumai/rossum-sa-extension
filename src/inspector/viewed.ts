// Shared contract for "annotations the user opened in the Rossum UI" — written
// by the Rossum content script (track-viewed feature), read by the
// Inspector landing. Pure and dependency-free on purpose: it is bundled into
// BOTH the content script and the Console without dragging signals along.

export const VIEWED_KEY = 'rossumViewedAnnotations';
export const MAX_VIEWED = 12; // stored cap (landing shows fewer, filtered per org)

// Newest-first, deduped by (origin, id), capped. Entry: { id, origin, at }.
/** One recently-viewed annotation, deduped by (origin, id). */
export type ViewedEntry = { id: string; origin: string; at: number };

/** What callers HAND to mergeViewed. A Rossum annotation id arrives as a number, and the
 *  `String(entry.id)` below is the normalisation that makes a stored entry's id a string. */
export type ViewedInput = Omit<ViewedEntry, 'id'> & { id: string | number };

export function mergeViewed(
  list: ViewedEntry[] | null | undefined,
  entry: ViewedInput | null,
  max = MAX_VIEWED,
): ViewedEntry[] {
  if (!entry || entry.id == null) return Array.isArray(list) ? list : [];
  const id = String(entry.id);
  const rest = (Array.isArray(list) ? list : []).filter(
    (e) => e && !(String(e.id) === id && e.origin === entry.origin),
  );
  return [{ ...entry, id }, ...rest].slice(0, max);
}
