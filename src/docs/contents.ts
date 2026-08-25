// The generated contents page for a printed specification (spec 2026-08-17, D10; the ZIP
// export it was first written for was removed 2026-08-18, leaving printDoc.js as the only
// caller).
//
// localpages exports whatever `index.md` you wrote. Deliverables have no authored landing
// document, so one is generated — the single place this port ADDS a page rather than
// porting one.
//
// It is emitted as MARKDOWN and rendered through the same pipeline as every other
// document, so it inherits the GitHub styling, the anchors, the table chrome and the
// state-label vocabulary for free, and there is no second HTML template to keep in step.
// Links are still written `slug.md` — printDoc strips them, since a link resolves to
// nothing on paper.

const VERDICT = { pass: '✓ Met', fail: '✗ Not met', uncertain: '? Uncertain' };

// There is deliberately NO state column. Upstream counted `<state-label>` badges in the rendered
// HTML; this port made states an Architect property instead (2026-08-17) and then dropped the manual
// state entirely (2026-08-19) in favour of the check verdict alone — so there is no source for one.

// A pipe inside a cell would break the row; escape it the way GFM expects.
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|');

// entries: [{ title, slug, verdict, state, stateDate }]
/** One row of the printed contents page. */
export type ContentsEntry = { title?: string; slug: string; verdict?: string | null };

export function buildContentsMarkdown(
  entries: ContentsEntry[],
  {
    heading = 'Deliverables',
    columns = {},
    intro = null,
    note = null,
  }: {
    heading?: string;
    columns?: { verdict?: boolean };
    intro?: string | null;
    note?: string | null;
  } = {},
): string {
  const cols = { verdict: true, ...columns };
  const head = ['Document'];
  if (cols.verdict) head.push('Check');
  const rows = entries.map((e) => {
    const cells = [`[${cell(e.title)}](${e.slug}.md)`];
    if (cols.verdict) cells.push(VERDICT[e.verdict as keyof typeof VERDICT] || '—');
    return `| ${cells.join(' | ')} |`;
  });
  const count = entries.length;
  return [
    `# ${heading}`,
    '',
    intro || `${count} document${count === 1 ? '' : 's'}.`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows,
    '',
    // No note unless the caller wants one. It used to default to a paragraph about the ZIP
    // bundle being self-contained, which was nonsense on paper — and paper is all there is now.
    ...(note ? note : []),
    '',
  ].join('\n');
}
