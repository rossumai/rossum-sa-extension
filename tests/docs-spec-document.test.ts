// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildSpecSections, declaresOwnHeading } from '../src/docs/specDocument.js';
import { createMarkdownRenderer } from '../src/docs/render.js';

const md = createMarkdownRenderer();
const displayTitle = (d: any) => d.title || 'Untitled';
const build = (deliverables: any, results = {}) =>
  buildSpecSections({ deliverables, displayTitle, results, md });

describe('buildSpecSections', () => {
  it('returns one section per deliverable, in the order given, with slugs assigned', () => {
    const { sections } = build([
      { id: 'a', title: 'Data model', text: '## Entities\n', order: 1 },
      { id: 'b', title: 'Data model', text: 'text\n', order: 2 },
    ]);
    expect(sections.map((s) => [s.id, s.slug])).toEqual([
      ['a', 'data-model'],
      ['b', 'data-model-2'],
    ]);
  });

  it('renders and sanitizes the body', () => {
    const { sections } = build([
      { id: 'a', title: 'T', text: '## Scope\n\n<script>x()</script>\n' },
    ]);
    expect(sections[0].bodyHtml).toMatch(/<h2 id="scope"/);
    expect(sections[0].bodyHtml).not.toMatch(/<script/);
  });

  it('says whether the document already names itself, so no title is shown twice', () => {
    const { sections } = build([
      { id: 'a', title: 'Scope', text: '# Scope\n\nbody\n' },
      { id: 'b', title: 'Scope', text: 'body with no heading\n' },
    ]);
    expect(sections[0].showTitle).toBe(false);
    expect(sections[1].showTitle).toBe(true);
    expect(declaresOwnHeading('##### too deep')).toBe(false); // matches what the Preview renders
  });

  it('carries the verdict as DATA, not markup — and no manual state, which was dropped', () => {
    const { sections } = build(
      [{ id: 'a', title: 'T', text: 'x', state: 'verified', stateDate: '2026-08-12' }],
      { a: { verdict: 'pass' } },
    );
    expect(sections[0]).toMatchObject({ verdict: 'pass' });
    // A document may still CARRY the old fields; the assembler must not pass them on (2026-08-19).
    // Retired fields: still on stored documents, deliberately absent from the type.
    expect((sections[0] as any).state).toBeUndefined();
    expect((sections[0] as any).stateDate).toBeUndefined();
    expect(JSON.stringify(sections[0])).not.toMatch(/<svg|state-label|print-verdict/);
  });

  it('collects document warnings per deliverable, naming the document', () => {
    const { warnings } = build([
      { id: 'a', title: 'Intake', text: '<state-label>ready</state-label>\n' },
    ]);
    expect(warnings.join(' ')).toMatch(/Intake/);
  });

  it('tolerates an empty list', () => {
    expect(build([])).toEqual({ sections: [], warnings: [] });
  });
});
