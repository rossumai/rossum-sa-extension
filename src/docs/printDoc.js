// The print-ready document behind "PDF" (owner, 2026-08-18).
//
// Why a generated page rather than printing the Console: an extension cannot write a .pdf
// under this manifest's permissions (chrome.printing is ChromeOS-only; chrome.debugger's
// Page.printToPDF would need a permission that disables every existing install until each
// user re-approves it), so the honest mechanism is a print-ready document plus the browser's
// own print dialog, where "Save as PDF" is the default destination.
//
// Printing the Console page DOES work — measured: a long document prints to the same 3 pages
// in-pane as it does standalone — but it can only ever print the deliverable that is OPEN.
// This builds the whole specification as one document, which is the gap.
//
// Pure apart from the injected renderer + sanitizer: takes deliverables, returns HTML.
import { sanitizeHtml } from './sanitize.js';
import { assignSlugs } from './slug.js';
import { buildContentsMarkdown } from './contents.js';
import { buildSpecSections } from './specDocument.js';

export const DEFAULT_OPTIONS = { contents: true, verdicts: false };

const VERDICT = { pass: '✓ Met', fail: '✗ Not met', uncertain: '? Uncertain' };


function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The printed status is the CHECK verdict alone (2026-08-19). The ported `.state-label` classes are
// now used only by docWarnings' diagnostic pill.

function verdictChip(result) {
  const v = result && result.verdict;
  if (!VERDICT[v]) return '';
  return `<span class="print-verdict verdict-${esc(v)}">${esc(VERDICT[v])}</span>`;
}

// deliverables: the ones to print, already in `order`.
// Returns { html, title, warnings }.
export function buildPrintDocument({
  deliverables = [],
  displayTitle = (d) => d.title || 'Untitled',
  results = {},
  md,
  options = {},
  heading = 'Specification',
}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings = [];
  const slugs = assignSlugs(deliverables, displayTitle);
  const sections = [];

  // A contents page only earns its place for more than one document.
  if (opts.contents && deliverables.length > 1) {
    const contentsMd = buildContentsMarkdown(
      deliverables.map((d) => ({
        title: displayTitle(d), slug: slugs.get(d.id),
        verdict: results[d.id] && results[d.id].verdict,
      })),
      {
        heading,
        columns: { verdict: !!opts.verdicts },
        intro: `${deliverables.length} documents.`,
        note: null,   // no standing note on paper; contents.js defaults to none since 2026-08-18
      },
    );
    // Links point at `slug.md`, which resolves to nothing on paper — strip them so the
    // contents reads as a list rather than as dead links.
    const env = {};
    // Drop the permalink anchors FIRST. Unwrapping every <a> would leave markdown-it-anchor's
    // `#` behind as literal text — in the document body it stays invisible via CSS, but here
    // it printed as "# Specification".
    const html = sanitizeHtml(md.render(contentsMd, env))
      .replace(/<a class="anchor"[^>]*>[\s\S]*?<\/a>/g, '')
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, '$1');
    sections.push(`<section class="print-doc print-contents">${html}</section>`);
  }

  // Rendering, sanitizing and warning collection are shared with the on-screen unified view
  // (specDocument.js); only the print presentation below belongs to this file.
  const { sections: built, warnings: buildWarnings } = buildSpecSections({ deliverables, displayTitle, results, md });
  warnings.push(...buildWarnings);
  for (const s of built) {
    const meta = opts.verdicts ? verdictChip(results[s.id]) : '';
    // The deliverable's own text is never rewritten — a title, when needed, is a header ABOVE
    // it. And it is only needed when the document does NOT already name itself: otherwise the
    // page opens with the same words twice ("Welcome" over "Welcome to localpages").
    const header = (s.showTitle || meta)
      ? `<header class="print-doc-head${s.showTitle ? '' : ' meta-only'}">`
        + (s.showTitle ? `<h1 class="print-doc-title">${esc(s.title)}</h1>` : '')
        + (meta ? `<div class="print-doc-meta">${meta}</div>` : '')
        + '</header>'
      : '';
    sections.push(`<section class="print-doc">${header}${s.bodyHtml}</section>`);
  }

  return { html: sections.join('\n'), title: heading, warnings };
}
