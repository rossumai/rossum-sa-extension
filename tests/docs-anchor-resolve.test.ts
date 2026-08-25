// @vitest-environment jsdom
// Forgiving fragment → heading resolution.
//
// The reported case: "§2.1 link from deliverable no. 4" previewed nothing. The generated id for
// "### 2.1 Entities" is `21-entities` (markdown-it-anchor strips the dot), so the fragment a
// human writes — `#2.1` — matched no element at all.
import { describe, it, expect } from 'vitest';
import {
  resolveHeadingId,
  resolveHeadingElement,
  normalizeAnchor,
} from '../src/docs/anchorResolve.js';
import { createMarkdownRenderer } from '../src/docs/render.js';

const HEADINGS = [
  { id: 'data-model', text: 'Data model' },
  { id: '2-model', text: '2. Model' },
  { id: '21-entities', text: '2.1 Entities' },
  { id: '22-fields', text: '2.2 Fields' },
  { id: '210-appendix', text: '2.10 Appendix' },
];

describe('resolveHeadingId', () => {
  it('takes an exact id first', () => {
    expect(resolveHeadingId(HEADINGS, '21-entities')).toBe('21-entities');
    expect(resolveHeadingId(HEADINGS, '#21-entities')).toBe('21-entities');
  });

  it('resolves the section number a human actually writes', () => {
    expect(resolveHeadingId(HEADINGS, '2.1')).toBe('21-entities');
    expect(resolveHeadingId(HEADINGS, '§2.1'.slice(1))).toBe('21-entities');
    expect(resolveHeadingId(HEADINGS, '2.2')).toBe('22-fields');
  });

  it('never lets 2.1 capture 2.10', () => {
    // Prefix matching stops at a digit, so the shorter number cannot swallow the longer one.
    expect(resolveHeadingId(HEADINGS, '2.10')).toBe('210-appendix');
    expect(resolveHeadingId(HEADINGS, '2.1')).not.toBe('210-appendix');
  });

  it('accepts punctuation and case variations of the heading text', () => {
    expect(resolveHeadingId(HEADINGS, '2.1 Entities')).toBe('21-entities');
    expect(resolveHeadingId(HEADINGS, '2-1-entities')).toBe('21-entities');
    expect(resolveHeadingId(HEADINGS, 'DATA MODEL')).toBe('data-model');
    expect(resolveHeadingId(HEADINGS, 'data%20model')).toBe('data-model'); // percent-encoded
  });

  it('returns null rather than guessing', () => {
    expect(resolveHeadingId(HEADINGS, 'nope')).toBeNull();
    expect(resolveHeadingId(HEADINGS, '')).toBeNull();
    expect(resolveHeadingId(HEADINGS, '#')).toBeNull();
    expect(resolveHeadingId([], '2.1')).toBeNull();
    expect(resolveHeadingId(null, '2.1')).toBeNull();
  });

  it('normalizeAnchor strips everything that ids drop', () => {
    expect(normalizeAnchor('2.1 Entities!')).toBe('21entities');
    expect(normalizeAnchor('§4 — Retries')).toBe('4retries');
  });
});

describe('against a really rendered document', () => {
  const render = (text: any) => {
    const root = document.createElement('div');
    root.innerHTML = createMarkdownRenderer().render(text, {});
    return root;
  };

  it('finds the heading for every form of the same reference', () => {
    const root = render(
      '# Data model\n\n## 2. Model\n\n### 2.1 Entities\n\nBody.\n\n### 2.2 Fields\n\nMore.\n',
    );
    // What the renderer actually produced, so the test cannot drift from it.
    expect([...root.querySelectorAll('h3')].map((h) => h.id)).toEqual(['21-entities', '22-fields']);
    for (const frag of ['21-entities', '2.1', '2.1 Entities', '2-1-entities']) {
      const el = resolveHeadingElement(root, frag);
      expect(el && el.id, frag).toBe('21-entities');
    }
    expect(resolveHeadingElement(root, 'not-there')).toBeNull();
  });

  it('ignores ids outside the document root', () => {
    const outside = document.createElement('div');
    outside.id = '21-entities';
    document.body.appendChild(outside);
    const root = render('## 2.1 Entities\n\nBody.\n');
    expect(resolveHeadingElement(root, '2.1')!.tagName).toBe('H2');
    outside.remove();
  });
});
