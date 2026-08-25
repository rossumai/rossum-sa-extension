// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { parseInline, parseMarkdown } from '../src/ui/fabry/markdown.js';
import { renderMermaidSVG } from 'beautiful-mermaid';
import FabryMarkdown from '../src/ui/fabry/FabryMarkdown.jsx';
import styles from '../src/ui/fabry/FabryMarkdown.module.css';

// MermaidBlock resolves its renderer from this global (lazy bundle in prod).
window.__fabryMermaidSvg = renderMermaidSVG;

function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<FabryMarkdown {...props} />, root);
  return root;
}

describe('parseInline', () => {
  it('splits code, strong, em, links', () => {
    expect(parseInline('a `x` **b** *c* [d](https://r8.example)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'em', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'd', href: 'https://r8.example' },
    ]);
  });
  it('non-http(s) link schemes render as literal text', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });
  it('unterminated markers stay literal (streaming tolerance)', () => {
    expect(parseInline('**bold-not-closed')).toEqual([{ type: 'text', text: '**bold-not-closed' }]);
  });
  it('trailing prose paren after a link is preserved, not swallowed into the href', () => {
    expect(parseInline('(see [d](https://r8.example)).')).toEqual([
      { type: 'text', text: '(see ' },
      { type: 'link', text: 'd', href: 'https://r8.example' },
      { type: 'text', text: ').' },
    ]);
  });
  it('parens inside the URL itself are kept (Wikipedia-style links)', () => {
    expect(parseInline('[w](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { type: 'link', text: 'w', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('headings, paragraphs, lists', () => {
    const b = parseMarkdown('## Title\n\npara one\nsame para\n\n- one\n- two\n\n1. a\n2. b');
    expect(b.map((x) => x.type)).toEqual(['heading', 'para', 'ul', 'ol']);
    expect(b[0].level).toBe(2);
    expect(b[1].spans[0].text).toBe('para one same para');
    expect(b[2].items.length).toBe(2);
  });
  it('fenced code keeps language and never parses inline', () => {
    const b = parseMarkdown('```json\n{"a": "**x**"}\n```');
    expect(b).toEqual([{ type: 'code', lang: 'json', text: '{"a": "**x**"}' }]);
  });
  it('unterminated fence consumes the rest (streaming)', () => {
    const b = parseMarkdown('```\npartial');
    expect(b).toEqual([{ type: 'code', lang: '', text: 'partial' }]);
  });
  it('blockquote and table', () => {
    const b = parseMarkdown('> quoted\n\n| h1 | h2 |\n| --- | --- |\n| a | b |');
    expect(b[0].type).toBe('blockquote');
    expect(b[1].type).toBe('table');
    expect(b[1].rows[0][1][0].text).toBe('b');
  });
});

describe('FabryMarkdown', () => {
  it('renders vnodes — HTML-shaped input stays inert text', () => {
    const root = mount({ text: 'hi <img src=x onerror=alert(1)> there' });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('renders code blocks and a streaming caret', () => {
    const root = mount({ text: '```\ncode\n```', streaming: true });
    expect(root.querySelector('pre code')!.textContent).toBe('code');
    expect(root.querySelector('.' + styles.caret)).toBeTruthy();
  });
  it('code fences show a language tag and highlighted tokens', () => {
    const root = mount({ text: '```json\n{"a": true}\n```' });
    expect(root.querySelector('.' + styles.lang)!.textContent).toBe('json');
    expect(root.querySelector('.' + styles.code + ' .' + styles['hl-key'])!.textContent).toBe(
      '"a"',
    );
    expect(root.querySelector('.' + styles.code + ' .' + styles['hl-lit'])!.textContent).toBe(
      'true',
    );
  });
  it('mermaid fences render a diagram block when done, a code fence while streaming', () => {
    const rootDone = mount({ text: '```mermaid\ngraph TD\nA-->B\n```', streaming: false });
    expect(rootDone.querySelector('.' + styles.mermaid)).toBeTruthy();
    const rootLive = mount({ text: '```mermaid\ngraph TD\nA-->B\n```', streaming: true });
    expect(rootLive.querySelector('.' + styles.mermaid)).toBeNull();
    expect(rootLive.querySelector('.' + styles.codewrap + ' .' + styles.lang)!.textContent).toBe(
      'mermaid',
    );
  });
  it('links open in a new tab with rel protection', () => {
    const root = mount({ text: '[d](https://r8.example)' });
    const a = root.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
