// Which deliverable the inspector rail is showing, and which heading the reader is under.
//
// Pure on purpose: jsdom has no layout, so the DECISION is unit-tested here while the
// MEASUREMENT (each section's offsetTop) is browser-verified — the same split
// stageLink.js / smoothScroll.js / tether.js already use.

// How far below the scroller's top edge a section must reach before it counts as "current".
// Matches the sticky header's height, so the section being read is the one the rail names.
export const SPY_OFFSET = 64;

// Array.isArray IS the guard, so the parameter admits what it guards against.
function ordered(list: any[] | null | undefined, key: string) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && t[key] != null)
    .slice()
    .sort((a, b) => (a.top || 0) - (b.top || 0));
}

// The guard below is the contract — an absent list scopes to nothing.
export function currentSection(
  tops: any[] | null | undefined,
  scrollTop: number,
  offset = SPY_OFFSET,
) {
  const list = ordered(tops, 'id');
  if (!list.length) return null;
  const y = Number.isFinite(scrollTop) ? scrollTop : 0;
  let found = list[0].id;
  for (const t of list) if ((t.top || 0) - offset <= y) found = t.id;
  return found;
}

// `shown` is what the rail is displaying right now; `running` is the deliverable with a check in
// flight. A run started from the rail must not be scrolled away mid-flight, so a running AND shown
// deliverable HOLDS the target until it finishes.
export function railTarget({
  spy = null,
  pinned = null,
  running = null,
  shown = null,
}: {
  spy?: string | null;
  pinned?: string | null;
  running?: string | null;
  shown?: string | null;
} = {}) {
  if (pinned) return pinned;
  if (running && running === shown) return shown;
  return spy || shown || null;
}

export function activeHeadingAt(headings: any[], scrollTop: number, offset = SPY_OFFSET) {
  const list = ordered(headings, 'slug');
  if (!list.length) return null;
  const y = Number.isFinite(scrollTop) ? scrollTop : 0;
  let found = list[0];
  for (const h of list) if ((h.top || 0) - offset <= y) found = h;
  return { docId: found.docId, slug: found.slug };
}
