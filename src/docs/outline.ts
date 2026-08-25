// A deliverable's outline: its h2/h3 headings, for the sidebar navigation tree.
//
// Read from the MARKDOWN, not from the rendered DOM, for three reasons: it works in Editor
// mode where nothing is rendered, it needs no layout, and it is pure so the slug rule can be
// tested against the real renderer's output.
//
// The slug rule and the duplicate suffixes must match markdown-it-anchor EXACTLY or a click
// scrolls to nothing. Both are verified against the live renderer in
// tests/docs-outline.test.js:
//   • slugify is render.js's own transform — lowercase, strip [^\w\s-], trim, spaces→dashes.
//     `\w` is ASCII here (no unicode flag), so "Ünïcode heading" really does become
//     "ncode-heading", exactly as upstream renders it.
//   • the SECOND occurrence of a slug gets `-1`, the third `-2`, and the counter spans EVERY
//     heading level even though only h2/h3 are listed.

// Identical to the slugify passed to markdown-it-anchor in render.js.
export function slugifyHeading(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;

// Strip the inline markers a heading's TEXT may carry, so the sidebar shows words rather than
// syntax. Mirrors format.js's headingTitle, which does the same for a deliverable's name.
function headingText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

// text -> [{ level, text, slug, line }] for h2/h3, in document order.
// `line` is 0-based, matching render.js's data-src-line stamps.
/** One outline row. `line` is 0-based, matching render.js's data-src-line stamps. */
export type OutlineEntry = { level: number; text: string; slug: string; line: number };

export function extractOutline(text: unknown): OutlineEntry[] {
  const lines = String(text ?? '').split('\n');
  const seen = new Map();
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A fenced block can contain anything, including a `## heading` example — upstream's own
    // documentation does exactly that, and the renderer does not treat it as a heading.
    const f = line.match(FENCE);
    if (fence) {
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }

    const m = line.match(HEADING);
    if (!m) continue;
    const level = m[1].length;
    const base = slugifyHeading(headingText(m[2]));
    // Every level advances the counter, because the renderer slugs every heading.
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    if (level === 2 || level === 3) out.push({ level, text: headingText(m[2]), slug, line: i });
  }
  return out;
}

// The outline as the SIDEBAR wants it: without the heading the deliverable is already named by.
//
// The row shows `displayTitle`, which prefers the document's own opening heading — so when that
// heading is an h2 or h3 (a specification that starts `## 1. Overview` rather than `# 1. Overview`)
// `extractOutline` lists it too and the sidebar says the same words twice, one line apart (owner
// report, 2026-08-19). Matched by LINE, not by text: two headings can legitimately share a title, and
// the one being dropped is specifically the one on the document's first non-empty line.
export function outlineWithoutTitle(text: unknown): OutlineEntry[] {
  const lines = String(text ?? '').split('\n');
  let titleLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim()) {
      titleLine = i;
      break;
    }
  }
  return extractOutline(text).filter((e) => e.line !== titleLine);
}
