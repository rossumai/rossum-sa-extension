// Assembles a specification: one section descriptor per deliverable, rendered and sanitized.
//
// Extracted from printDoc.js (2026-08-19) so the printed specification and the on-screen unified
// view share ONE concatenator. It deliberately returns DATA rather than chrome — print draws SVG
// state badges, the screen draws console.css pills — so only the assembly is shared and the two
// presentations cannot drift.
import { wrapStandaloneImages } from './render.js';
import { sanitizeHtml } from './sanitize.js';
import { reportDocWarnings } from './docWarnings.js';
import { assignSlugs } from './slug.js';

// A deliverable that opens with its own Markdown heading must not be given a second title. Same rule
// the sidebar uses to let a deliverable name itself (src/ui/fabry/markdown.js:76 — `#`–`####`, a
// space, column 0, untrimmed).
const LEADING_HEADING = /^(#{1,4})\s+(.*)$/;
export function declaresOwnHeading(text) {
  const line = String(text || '').split('\n').find((l) => l.trim());
  return !!(line && LEADING_HEADING.test(line));
}

export function buildSpecSections({ deliverables = [], displayTitle = (d) => (d && d.title) || 'Untitled', results = {}, md }) {
  const warnings = [];
  const slugs = assignSlugs(deliverables, displayTitle);
  const sections = deliverables.map((d) => {
    const title = displayTitle(d);
    const env = {};
    const bodyHtml = sanitizeHtml(wrapStandaloneImages(md.render(d.text || '', env)));
    reportDocWarnings(env, title, (m) => warnings.push(m));
    return {
      id: d.id,
      slug: slugs.get(d.id),
      title,
      showTitle: !declaresOwnHeading(d.text),
      verdict: (results[d.id] && results[d.id].verdict) || null,
      bodyHtml,
    };
  });
  return { sections, warnings };
}
