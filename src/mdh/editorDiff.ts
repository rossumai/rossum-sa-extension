// Smallest CodeMirror change ({ from, to, insert }) that turns `a` into `b`, by
// keeping the shared leading prefix and trailing suffix and rewriting only the
// differing middle. Returns null when the texts are identical.
//
// Why this exists: replacing the whole document (`{ from: 0, to: doc.length }`)
// collapses CodeMirror's scroll anchor to offset 0 — every in-viewport position
// falls inside the deleted range — so the editor jumps to the top on each write.
// A minimal change leaves the unchanged region anchored, so localized edits
// (toggling / sorting / filtering a single pipeline stage) keep the viewport and
// cursor put. A genuinely different document still yields a change spanning most
// of the text, so CodeMirror still scrolls toward the top there — unchanged
// behaviour for "load a new pipeline".
//
// Boundaries are nudged off UTF-16 surrogate pairs so a change never starts or
// ends in the middle of an astral character (the resulting document is exact
// either way, but this avoids handing CodeMirror a split-pair offset).
/** The smallest CodeMirror change that turns `a` into `b`, or null if they are equal. */
export function computeMinimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const aLen = a.length;
  const bLen = b.length;
  const max = Math.min(aLen, bLen);

  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  // If the prefix boundary sits just after a high surrogate, back off one so the
  // pair stays whole on the kept (prefix) side.
  if (p > 0 && (a.charCodeAt(p - 1) & 0xfc00) === 0xd800) p--;

  let s = 0;
  while (s < max - p && a.charCodeAt(aLen - 1 - s) === b.charCodeAt(bLen - 1 - s)) s++;
  // If the suffix boundary sits just before a low surrogate, drop one so the pair
  // stays whole on the kept (suffix) side.
  if (s > 0 && (a.charCodeAt(aLen - s) & 0xfc00) === 0xdc00) s--;

  return { from: p, to: aLen - s, insert: b.slice(p, bLen - s) };
}
