// Deliverable title → the name a cross-document reference addresses it by (spec 2026-08-17, D7).
//
// localpages names each page after its .md file's basename, which is what its
// `[see](architecture.md)` reference resolves against. Deliverables have no filenames, so the
// slug of the title takes that role — in the hover preview, in link interception and in the
// printed contents page — and it
// is deliberately formed with the SAME transform markdown-it-anchor is given for
// heading ids in render.js, so a document slug and a heading slug are never formed by
// two different rules.

// `index` stays reserved even though the ZIP export that owned that filename is gone
// (2026-08-18): slugs address cross-document links in the live pane, so freeing the name
// would silently re-point any reference written against a deliverable called "Index".
export const RESERVED = new Set(['index']);

export function slugify(title: unknown): string {
  const base = String(title ?? '')
    .toLowerCase()
    // identical to render.js's anchor slugify
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    // filename hygiene beyond the anchor rule: collapse and trim dashes
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'untitled';
}

// Assigns a unique slug per deliverable, in the order given (which is `order`), so
// the mapping is stable for a stable list. Collisions take -2, -3, … like a
// filesystem would, and the FIRST occurrence keeps the bare slug.
export function assignSlugs(
  deliverables: { id: string; title?: string }[],
  displayTitle?: (d: { id: string; title?: string }) => string,
): Map<string, string> {
  const used = new Set(RESERVED);
  const out = new Map();
  for (const d of deliverables) {
    const base = slugify(displayTitle ? displayTitle(d) : d.title);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    out.set(d.id, slug);
  }
  return out;
}
