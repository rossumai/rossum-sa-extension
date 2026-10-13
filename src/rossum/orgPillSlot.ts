// Where the org pill fits in the Rossum header (features/org-name.ts measures, this
// decides). Pure geometry over the header's boxes, so it is unit-tested without layout.

export type Box = { left: number; top: number; right: number; bottom: number };

const GAP = 12;
const MIN_WIDTH = 60;
// Between the environment chip and the name inside the pill.
export const CHIP_GAP = 8;

// The narrowest the pill can be and still be read: a readable name, plus the chip beside
// it (the chip never truncates). Never more than the whole pill, which may be shorter;
// `whole` is 0 when nothing could be measured.
export function pillMinWidth({
  nameShown,
  chipWidth,
  whole,
}: {
  nameShown: boolean;
  chipWidth: number;
  whole: number;
}): number {
  const name = nameShown ? MIN_WIDTH + (chipWidth ? CHIP_GAP : 0) : 0;
  const least = name + chipWidth || MIN_WIDTH;
  return whole > 0 ? Math.min(whole, least) : least;
}

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
  minWidth = MIN_WIDTH,
}: {
  header: Box;
  clusterLeft: number;
  obstacles: Box[];
  /** The pill's natural width, the whole name shown; 0 when it could not be measured. */
  nameWidth?: number;
  /** The narrowest the pill can be (pillMinWidth); 60px of readable name by default. */
  minWidth?: number;
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
    .filter((slot) => slot.maxWidth >= minWidth)
    .reverse(); // rightmost first
  return slots.find((slot) => slot.maxWidth >= nameWidth) ?? slots[0] ?? null;
}
