// Pure half of the org name (features/org-name.ts is the DOM half): which organization
// the session is in, whether the feature is on, and where in the header the name fits.
// No DOM, no network — the feature measures and fetches, this decides.

// The organization the session is in, from `GET /organizations`. That list holds what
// the session's token can see — the one organization it is in — and it is what the
// Rossum UI reads too. `auth/user`'s `organization` is NOT a substitute: it names the
// user's HOME organization, and for a service or system user that is one the session
// cannot even read (404, measured on a dedicated cell 2026-09-23). More than one
// organization, or none, names nothing: which is current cannot be told, and a wrong
// name is worse than no name.
export function currentOrgName(list: unknown): string | null {
  const results = (list as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== 1) return null;
  const name = results[0]?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

// The feature's switch, and the ONE place its default lives. It is the one toggle that
// defaults ON: an absent key means enabled and only an explicit `false` disables it.
// Every other toggle reads a missing key as off, so this must never be coerced —
// `!!undefined` hides the name from everyone who has never opened the popup, and shows
// the popup's switch off while the feature runs.
export const ORG_NAME_KEY = 'orgNameEnabled';
export const orgNameOn = (stored: unknown): boolean => stored !== false;

export type Box = { left: number; top: number; right: number; bottom: number };

const GAP = 12;
const MIN_WIDTH = 60;

// The pill sits in a free gap of the header, right-aligned against whatever closes that
// gap on the right: the header's right-hand buttons on a plain header (the gap after the
// last nav tab, or after the paging controls on the review screen), or branding such as
// "Powered by Rossum" when a white-labelled header puts it right beside the buttons.
// `obstacles` are the header's visible controls and text; one that reaches into or past
// the buttons is a wrapper or a button itself, not a neighbour, and is ignored.
//
// Which gap: the rightmost one that holds the WHOLE name (`nameWidth`, the pill's
// natural width), searching leftwards from the buttons — a name is better moved than
// cut. Only when no gap holds it all is it truncated, in the rightmost gap still wide
// enough to read a name in. The search never picks a gap that lies in the left half of
// the header, though a long name in a gap that ends right of the middle may reach
// across it. Returns the CSS `right` offset from the header's right edge and the width
// available, or null when no gap is wide enough.
export function pillSlot({
  header,
  clusterLeft,
  obstacles,
  nameWidth = 0,
}: {
  header: Box;
  clusterLeft: number;
  obstacles: Box[];
  /** The pill's natural width, the whole name shown; 0 when it could not be measured. */
  nameWidth?: number;
}): { right: number; maxWidth: number } | null {
  const blocks = obstacles
    .filter((o) => o.right > o.left && o.bottom > o.top && o.right <= clusterLeft)
    .sort((a, b) => a.left - b.left);
  // Walk the blocks left to right, merging overlaps, and collect the gaps between them.
  const gaps: [start: number, end: number][] = [];
  let cursor = header.left;
  for (const block of blocks) {
    if (block.left > cursor) gaps.push([cursor, block.left]);
    cursor = Math.max(cursor, block.right);
  }
  if (clusterLeft > cursor) gaps.push([cursor, clusterLeft]);
  // Never a gap in the left half: that is the logo, the chips and the tabs, and a
  // name found there reads as part of the navigation rather than as "you are here".
  const middle = (header.left + header.right) / 2;
  const slots = gaps
    .filter(([, end]) => end > middle)
    .map(([start, end]) => ({
      right: header.right - end + GAP,
      maxWidth: end - GAP - (start + GAP),
    }))
    .filter((slot) => slot.maxWidth >= MIN_WIDTH)
    .reverse(); // rightmost first
  return slots.find((slot) => slot.maxWidth >= nameWidth) ?? slots[0] ?? null;
}
