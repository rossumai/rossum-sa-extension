// Shared contract for "annotations the user opened in the Rossum UI" — written
// by the Rossum content script (track-viewed feature), read by the
// Inspector landing. Pure and dependency-free on purpose: it is bundled into
// BOTH the content script and the Console without dragging signals along.

export const VIEWED_KEY = 'rossumViewedAnnotations';
export const MAX_VIEWED = 12; // stored cap (landing shows fewer, filtered per org)

// Newest-first, deduped by (origin, id), capped. Entry: { id, origin, at }.
export function mergeViewed(list, entry, max = MAX_VIEWED) {
  if (!entry || entry.id == null) return Array.isArray(list) ? list : [];
  const id = String(entry.id);
  const rest = (Array.isArray(list) ? list : []).filter((e) => e && !(String(e.id) === id && e.origin === entry.origin));
  return [{ ...entry, id }, ...rest].slice(0, max);
}
