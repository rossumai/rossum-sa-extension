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
export function declaresOwnHeading(text: string | null | undefined): boolean {
  const line = String(text || '').split('\n').find((l) => l.trim());
  return !!(line && LEADING_HEADING.test(line));
}

// The structural minimum a document needs. src/docs/ is the generic renderer, so it names its
// own shape rather than importing the Architect's Deliverable — which satisfies it.
export type SpecDoc = { id: string; text?: string; title?: string };
export type SpecResults = Record<string, { verdict?: string | null } | undefined>;

/** One deliverable's RAW MARKDOWN, as the on-screen view and the source column receive it.
 *  Distinct from SpecSection below, which is the RENDERED form — both were `any[]` before, so
 *  nothing said that DocView takes source and printDoc takes rendered HTML. */
export type SourceSection = { id: string; slug: string; text: string };

/** One rendered document in a specification — what buildSpecSections returns per deliverable
 *  and what the print page consumes. */
export type SpecSection = {
  id: string;
  slug: string;
  title: string;
  /** False when the document opens with its own Markdown heading. */
  showTitle: boolean;
  verdict: string | null;
  bodyHtml: string;
};

export function buildSpecSections({
  deliverables = [], displayTitle = (d: SpecDoc) => (d && d.title) || 'Untitled', results = {}, md,
}: {
  deliverables?: SpecDoc[];
  displayTitle?: (d: SpecDoc) => string;
  results?: SpecResults;
  md: { render: (text: string, env: any) => string };
}) {
  const warnings: string[] = [];
  const slugs = assignSlugs(deliverables, displayTitle);
  const sections: SpecSection[] = deliverables.map((d): SpecSection => {
    const title = displayTitle(d);
    const env: Record<string, unknown> = {};
    const bodyHtml = sanitizeHtml(wrapStandaloneImages(md.render(d.text || '', env)));
    reportDocWarnings(env, title, (m) => warnings.push(m));
    return {
      id: d.id,
      slug: slugs.get(d.id)!,
      title,
      showTitle: !declaresOwnHeading(d.text),
      verdict: (results[d.id] && results[d.id]!.verdict) || null,
      bodyHtml,
    };
  });
  return { sections, warnings };
}
