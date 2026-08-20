// Per-deliverable id namespacing for the unified specification view.
//
// MEASURED (spec 2026-08-19, F2): two deliverables containing `## 2. Scope` both render
// `id="2-scope"`, because markdown-it-anchor dedupes within ONE render only. Concatenated,
// `querySelector` returns the first, so every fragment link and outline jump would land in the
// wrong document. Prefixing ids per deliverable is what makes one page addressable.
//
// Applied to the ADOPTED COPY, never to the cached render (F7), so `render.js` stays byte-faithful
// to upstream localpages and the cache stays shareable with the print path.
import { resolveHeadingId } from './anchorResolve.js';

export const prefixFor = (slug: unknown) => `${String(slug || '')}--`;

// Only ids move. Authored hrefs are left exactly as written: prefixing `#2.1` to `#slug--2.1` would
// defeat the forgiving matching below (the real id is `slug--21-entities`), and an untouched href
// keeps the deliverable's text round-trippable.
export function namespaceSection(sectionEl: Element, prefix: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!sectionEl || !prefix) return map;
  for (const el of sectionEl.querySelectorAll('[id]')) {
    const id = el.getAttribute('id');
    if (!id || id.startsWith(prefix)) continue;   // idempotent: adopting twice must not double up
    map.set(id, prefix + id);
    el.setAttribute('id', prefix + id);
  }
  return map;
}

function headingsIn(scope: ParentNode, prefix: string) {
  return [...scope.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')].map((el) => ({
    el,
    // resolveHeadingId matches on the id AS AUTHORED, so hand it the un-prefixed form.
    id: prefix && el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id,
    text: el.textContent || '',
  }));
}

// The reader's own section wins first: with a colliding id, "the one I am looking at" is what a
// fragment written in that document means.
export function resolveInPage(root: ParentNode, fragment: string, currentPrefix = ''): Element | null {
  if (!root || !fragment) return null;
  const sections = [...root.querySelectorAll('[data-slug]')] as HTMLElement[];
  const scopes: [ParentNode, string][] = [];
  if (currentPrefix) {
    const own = sections.find((s) => prefixFor(s.dataset.slug) === currentPrefix);
    if (own) scopes.push([own, currentPrefix]);
  }
  for (const s of sections) {
    const p = prefixFor(s.dataset.slug);
    if (p !== currentPrefix) scopes.push([s, p]);
  }
  if (!scopes.length) scopes.push([root, '']);
  for (const [scope, prefix] of scopes) {
    const heads = headingsIn(scope, prefix);
    const hit = resolveHeadingId(heads, fragment);
    if (hit) {
      const found = heads.find((h) => h.id === hit);
      if (found) return found.el;
    }
  }
  return null;
}
