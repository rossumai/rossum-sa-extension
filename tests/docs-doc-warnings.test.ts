// The document diagnostic that replaced upstream's <state-label> plugin.
//
// Section states became an Architect property (owner, 2026-08-18) and were dropped entirely on
// 2026-08-19, so the element no
// longer renders a badge. Without this plugin it would render NOTHING and say nothing —
// markdown-it passes the unknown tag through, the sanitizer unwraps it, and a browser
// draws an unrecognised custom element as empty space. That silent failure is what the
// whole convention was designed to prevent, and it is what actually happened when
// `<section-state>` was tried.
import { describe, it, expect } from 'vitest';
import { createMarkdownRenderer } from '../src/docs/render.js';
import { reportDocWarnings, isStateLabelish, leadingTagName } from '../src/docs/docWarnings.js';

function render(src: any) {
  const md = createMarkdownRenderer();
  const env = {};
  const html = md.render(src, env);
  const lines: any = [];
  const count = reportDocWarnings(env, 'solution', (m) => lines.push(m));
  return { html, lines, count };
}

describe('near-miss detection', () => {
  it('flags the element that used to work, and the names someone reaching for it types', () => {
    // Only names that markdown-it actually treats as HTML need a notice — see the next test.
    for (const tag of ['state-label', 'section-state', 'statelabel', 'StateLabel', 'section-status']) {
      const { html, count } = render(`## S\n\n<${tag} state="ready" date="2026-08-17" />\n`);
      expect(count, tag).toBe(1);
      expect(html, tag).toMatch(/class="state-label state-error"/);
      expect(html, tag).toMatch(new RegExp(`&lt;${tag}&gt; renders as nothing`));
    }
  });

  it('names the file and line, like upstream did', () => {
    const { lines } = render('## S\n\n<section-state state="ready" />\n');
    expect(lines[0]).toMatch(/^solution:3 /);
    expect(lines[0]).toMatch(/not supported here/);
  });

  it('needs no notice for an underscored name, which is already visible', () => {
    // An underscore is not legal in an HTML tag name, so markdown-it never makes this an
    // html_block at all: it renders as literal text the author can SEE. The notice exists
    // only for the invisible case, so this correctly stays silent.
    const { html, count } = render('## S\n\n<state_label state="ready" />\n');
    expect(count).toBe(0);
    // Quotes come back curly (typographer is on, per upstream's config), so match the
    // tag itself rather than the attribute text.
    expect(html).toMatch(/&lt;state_label/);
    expect(html).toMatch(/<p>&lt;state_label/);
  });

  it('leaves ordinary unknown elements alone — a SOW placeholder is not a state label', () => {
    const { html, count } = render('Set <queue_id> before <invoice_number>.\n');
    expect(count).toBe(0);
    expect(html).not.toMatch(/state-error/);
  });

  it('never fires inside a fenced code block', () => {
    // Detection runs on the token stream, where a fence is a `fence` token and never an
    // html_block — upstream's insight, and the reason a doc can document the syntax.
    const src = ['# Docs', '', '```markdown', '## 1. Overview', '', '<state-label state="verified" />', '```', ''].join('\n');
    const { html, count } = render(src);
    expect(count).toBe(0);
    expect(html).not.toMatch(/state-error/);
    expect(html).toMatch(/<pre><code/);
  });

  it('handles the inline form, and drops a closing partner without a second notice', () => {
    const { html, count } = render('Use <state-label state="stale"> here</state-label>.\n');
    expect(count).toBe(1);
    expect(html).toMatch(/Use /);
    expect(html).toMatch(/ here\./);
    expect(html).toMatch(/class="state-label state-error"/);
    expect((html.match(/state-error/g) || []).length).toBe(1);
  });

  it('escapes the tag name it echoes back', () => {
    const { html } = render('## S\n\n<state-label state="&quot;><script>alert(1)</script>" />\n');
    expect(html).not.toMatch(/<script>alert/);
  });
});

describe('helpers', () => {
  it('leadingTagName reads the tag out of a fragment', () => {
    expect(leadingTagName('<state-label state="x" />')).toBe('state-label');
    expect(leadingTagName('</state-label>')).toBe('state-label');
    expect(leadingTagName('  <Section-State/>')).toBe('Section-State');
    expect(leadingTagName('not html')).toBe('');
  });

  it('isStateLabelish normalizes separators and case', () => {
    for (const t of ['state-label', 'STATE_LABEL', 'sectionstate', 'section-state', 'status']) {
      expect(isStateLabelish(t), t).toBe(true);
    }
    for (const t of ['queue_id', 'details', 'mark', 'invoice-number']) {
      expect(isStateLabelish(t), t).toBe(false);
    }
  });

  it('reportDocWarnings is silent when the document is clean', () => {
    const out: any = [];
    expect(reportDocWarnings({}, 'solution', (m) => out.push(m))).toBe(0);
    expect(out).toEqual([]);
  });
});
