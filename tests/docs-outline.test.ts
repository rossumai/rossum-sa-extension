// The sidebar outline. Its slugs must match markdown-it-anchor's exactly, or clicking an
// entry scrolls to nothing — so the first block checks them against the REAL renderer rather
// than against my expectations of it.
import { describe, it, expect } from 'vitest';
import { createMarkdownRenderer } from '../src/docs/render.js';
import { extractOutline, slugifyHeading, outlineWithoutTitle } from '../src/docs/outline.js';

const renderedIds = (text: any) => {
  const html = createMarkdownRenderer().render(text, {});
  return [...html.matchAll(/<h([1-6]) id="([^"]*)"/g)].map((m) => ({
    level: Number(m[1]),
    slug: m[2],
  }));
};

describe('slugs match the renderer', () => {
  const CASES = [
    '## Overview\n\na\n\n## Overview\n\nb\n\n## Overview\n\nc\n',
    '## 3. Architecture & Scope\n\nd\n\n### Nested\n\ne\n',
    '## Ünïcode heading\n\nf\n',
    '# Title\n\n## Title\n\nx\n',
    '## With `code` and **bold**\n\ny\n',
    '## Trailing spaces   \n\nz\n',
  ];
  for (const [i, text] of CASES.entries()) {
    it(`case ${i + 1}: every listed heading resolves to a real id`, () => {
      const ids = renderedIds(text);
      const outline = extractOutline(text);
      // Only h2/h3 are listed, and each one's slug must exist in the rendered document.
      expect(outline.map((h) => h.level).every((l) => l === 2 || l === 3)).toBe(true);
      for (const h of outline) {
        expect(
          ids.some((r) => r.slug === h.slug),
          `${h.text} -> ${h.slug}`,
        ).toBe(true);
      }
      // …and every rendered h2/h3 is listed, in order.
      expect(outline.map((h) => h.slug)).toEqual(
        ids.filter((r) => r.level === 2 || r.level === 3).map((r) => r.slug),
      );
    });
  }

  it('reproduces the duplicate suffixes and the ASCII-only slug rule', () => {
    expect(
      extractOutline('## Overview\n\n## Overview\n\n## Overview\n').map((h) => h.slug),
    ).toEqual(['overview', 'overview-1', 'overview-2']);
    // An h1 advances the counter even though it is not listed.
    expect(extractOutline('# Title\n\n## Title\n').map((h) => h.slug)).toEqual(['title-1']);
    expect(slugifyHeading('Ünïcode heading')).toBe('ncode-heading');
    expect(slugifyHeading('3. Architecture & Scope')).toBe('3-architecture-scope');
  });
});

describe('extractOutline', () => {
  it('ignores headings inside fenced blocks, both fence styles', () => {
    const text = [
      '## Real',
      '',
      '```markdown',
      '## Fake',
      '```',
      '',
      '~~~',
      '### Also fake',
      '~~~',
      '',
      '### Real two',
      '',
    ].join('\n');
    expect(extractOutline(text).map((h) => h.text)).toEqual(['Real', 'Real two']);
  });

  it('lists h2 and h3 only, and records the source line', () => {
    const text = ['# One', '', '## Two', '', 'body', '', '### Three', '', '#### Four', ''].join(
      '\n',
    );
    expect(extractOutline(text)).toEqual([
      { level: 2, text: 'Two', slug: 'two', line: 2 },
      { level: 3, text: 'Three', slug: 'three', line: 6 },
    ]);
  });

  it('strips inline markers from the label', () => {
    expect(extractOutline('## With `code` and **bold**\n')[0].text).toBe('With code and bold');
  });

  it('is empty for text with no headings, and tolerates junk', () => {
    expect(extractOutline('just prose\n')).toEqual([]);
    expect(extractOutline('')).toEqual([]);
    expect(extractOutline(null)).toEqual([]);
    expect(extractOutline('#no space\n')).toEqual([]);
  });
});

describe('outlineWithoutTitle — the sidebar row already names the document', () => {
  it('drops the opening heading when the document names itself with an h2', () => {
    // The row shows "1. Overview" (displayTitle prefers the document's own heading), so listing it
    // again one line below is the duplication the owner reported.
    const entries = outlineWithoutTitle('## 1. Overview\n\ntext\n\n## 1.1 Scope\n\nmore\n');
    expect(entries.map((e) => e.text)).toEqual(['1.1 Scope']);
  });

  it('keeps everything when the title is an h1, which the outline never listed anyway', () => {
    const entries = outlineWithoutTitle('# 1. Overview\n\n## 1.1 Scope\n\n### 1.1.1 Detail\n');
    expect(entries.map((e) => e.text)).toEqual(['1.1 Scope', '1.1.1 Detail']);
  });

  it('drops only the FIRST-LINE heading, not a later one that happens to share its text', () => {
    const entries = outlineWithoutTitle('## Scope\n\ntext\n\n## Scope\n\nagain\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe('scope-1'); // the renderer's duplicate suffix is preserved
  });

  it('tolerates leading blank lines, prose-first documents and junk', () => {
    expect(outlineWithoutTitle('\n\n## Real title\n\n## Second\n').map((e) => e.text)).toEqual([
      'Second',
    ]);
    expect(outlineWithoutTitle('Just prose.\n\n## Kept\n').map((e) => e.text)).toEqual(['Kept']);
    expect(outlineWithoutTitle('')).toEqual([]);
    expect(outlineWithoutTitle(null)).toEqual([]);
  });
});
