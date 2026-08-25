// @vitest-environment jsdom
// The allowlist sanitizer (spec 2026-08-17, D9).
//
// localpages renders `html: true` markdown straight into a page; deliverable text has
// four writers and the exported HTML carries no CSP, so the parsed tree is filtered
// before it is adopted. These tests pin both halves of the contract: everything a
// legitimate document contains survives untouched, and everything that could execute
// or exfiltrate does not.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { sanitizeHtml, sanitizeBody, markLinksForPane } from '../src/docs/sanitize.js';
import { createMarkdownRenderer, wrapStandaloneImages } from '../src/docs/render.js';

describe('what a document is allowed to contain', () => {
  it('keeps markdown-it output verbatim', () => {
    const html = '<h2 id="x" tabindex="-1">T</h2><p>a <em>b</em> <strong>c</strong> <code>d</code></p>'
      + '<ul><li>i</li></ul><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>'
      + '<blockquote>q</blockquote><hr><figure><img src="https://x.test/i.png" alt="a"><figcaption>a</figcaption></figure>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('keeps the four raw-HTML constructs localpages documents', () => {
    const html = '<details><summary>s</summary><p>body</p></details>'
      + '<mark>m</mark><div class="wide"><table><tr><td>t</td></tr></table></div>';
    const out = sanitizeHtml(html);
    expect(out).toMatch(/<details><summary>s<\/summary>/);
    expect(out).toMatch(/<mark>m<\/mark>/);
    expect(out).toMatch(/<div class="wide">/);
  });

  it('keeps data-* and aria-* — which is what carries state, sync and template keys', () => {
    const out = sanitizeHtml('<p data-src-line="4" aria-hidden="true" role="note">x</p>'
      + '<span class="state-label state-stale" data-state="stale">S</span>');
    expect(out).toMatch(/data-src-line="4"/);
    expect(out).toMatch(/aria-hidden="true"/);
    expect(out).toMatch(/role="note"/);
    expect(out).toMatch(/data-state="stale"/);
  });
});

describe('what is removed', () => {
  it('deletes elements whose children are not prose', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'link', 'meta', 'base']) {
      const out = sanitizeHtml(`<p>before</p><${tag}>payload</${tag}><p>after</p>`);
      expect(out, tag).not.toMatch(new RegExp('<' + tag));
      expect(out, tag).toMatch(/before/);
      expect(out, tag).toMatch(/after/);
    }
    expect(sanitizeHtml('<script>alert(1)</script>')).not.toMatch(/alert/);
  });

  it('strips every on* handler, and a top-level <style>', () => {
    expect(sanitizeHtml('<img src="x.png" onerror="alert(1)">')).not.toMatch(/onerror/);
    expect(sanitizeHtml('<p onclick="alert(1)">x</p>')).toBe('<p>x</p>');
    expect(sanitizeHtml('<style>body{display:none}</style><p>x</p>')).toBe('<p>x</p>');
  });

  it('rejects unsafe URLs but keeps the ones a document needs', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="#anchor">x</a>')).toMatch(/href="#anchor"/);
    expect(sanitizeHtml('<a href="other.html">x</a>')).toMatch(/href="other\.html"/);
    expect(sanitizeHtml('<a href="https://x.test/">x</a>')).toMatch(/href="https:\/\/x\.test\/"/);
    expect(sanitizeHtml('<a href="//evil.test/">x</a>')).toBe('<a>x</a>');
    // D8 inlines images as data: URIs, so those must pass — other data: must not.
    expect(sanitizeHtml('<img src="data:image/png;base64,AQID">')).toMatch(/data:image\/png/);
    expect(sanitizeHtml('<img src="data:text/html;base64,AQID">')).not.toMatch(/data:text/);
  });

  it('unwraps an unknown element instead of deleting its prose', () => {
    // The migration hazard this rule exists for: `<queue_id>` in a SOW would otherwise
    // take its content with it (an unknown element renders as nothing in a browser).
    expect(sanitizeHtml('<p>Set <queue_id>the queue</queue_id> first.</p>'))
      .toBe('<p>Set the queue first.</p>');
    expect(sanitizeHtml('<custom-thing><p>kept</p></custom-thing>')).toBe('<p>kept</p>');
  });
});

describe('the <svg> subtree rule', () => {
  it('keeps an SVG-internal <style> while a top-level one is deleted', () => {
    const out = sanitizeHtml('<svg><style>.a{fill:red}</style><path d="M0 0"/></svg><style>.b{}</style>');
    expect(out).toMatch(/<svg><style>\.a\{fill:red\}<\/style>/);
    expect(out).not.toMatch(/\.b\{\}/);
  });

  it('keeps SVG geometry attributes that no HTML allowlist would name', () => {
    const out = sanitizeHtml('<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" stroke-dasharray="2 2.4" paint-order="stroke fill"/></svg>');
    expect(out).toMatch(/viewBox="0 0 16 16"/);
    expect(out).toMatch(/stroke-dasharray="2 2\.4"/);
    expect(out).toMatch(/paint-order="stroke fill"/);
  });

  it('still refuses handlers and <script> inside an SVG', () => {
    const out = sanitizeHtml('<svg onload="alert(1)"><script>alert(2)</script><path onclick="alert(3)"/></svg>');
    expect(out).not.toMatch(/onload|onclick|alert/);
    expect(out).toMatch(/<svg><path/);
  });
});

describe('against real rendered documents', () => {
  const render = (src: any, opts?: any) => {
    const md = createMarkdownRenderer(opts);
    return wrapStandaloneImages(md.render(src, {}));
  };

  it('the <state-label> notice survives sanitization, so the diagnostic is never swallowed', () => {
    // There is no manual state any more (2026-08-19), so the element renders a NOTICE rather than a
    // badge (owner, 2026-08-18) — and that notice has to survive the sanitizer, or the
    // author is back to a silently blank line. Badge markup itself is covered by the
    // idempotence block below, which measures against upstream's rendering of states.md.
    const out = sanitizeHtml(render('## S\n\n<state-label state="verified" date="2026-08-17" />\n'));
    expect(out).toMatch(/<span class="state-label state-error" data-state="error">/);
    expect(out).toMatch(/renders as nothing/);
    expect(out).toMatch(/not supported here/);
    expect(out).not.toMatch(/state-label state-verified/);
  });

  it('a mermaid diagram survives with its own <style> and the TODO stroke', () => {
    const html = render('```mermaid\ngraph TD\n  A[Do TODO thing] --> B[Done]\n```\n', { mermaid: renderMermaidSVG });
    const out = sanitizeHtml(html);
    expect(out).toMatch(/<div class="wide">/);
    expect(out).toMatch(/<svg/);
    expect(out).toMatch(/\.todo-hl \{ stroke: #ffdd33/);      // injected into the SVG's <style>
    expect(out).toMatch(/<tspan class="todo-hl">TODO<\/tspan>/);
  });

  it('an alert callout survives with its icon', () => {
    const out = sanitizeHtml(render('> [!WARNING]\n> Careful.\n'));
    expect(out).toMatch(/markdown-alert markdown-alert-warning/);
    expect(out).toMatch(/markdown-alert-title/);
    expect(out).toMatch(/<svg/);
  });
});

describe('idempotence on upstream localpages output', () => {
  // The strongest guarantee available: whatever localpages itself produced for its own
  // examples must come out of the sanitizer unchanged. A hand-written sample can only
  // pin the attributes I thought of — this pins the ones markdown-it and the plugins
  // actually emit, and is what caught `tabindex="-1"` going missing from every heading.
  const FIX = path.resolve(__dirname, 'fixtures/localpages/expected');

  // Parse + re-serialize WITHOUT filtering. Any DOMParser-based sanitizer inherits the
  // DOM's own normalizations — `&#x27;` becomes `'`, `<circle/>` becomes
  // `<circle></circle>` — which are semantically identical and render identically, but
  // are not byte-identical to what markdown-it emitted. Measuring against this baseline
  // instead of against the raw file asks the precise question: does the sanitizer change
  // anything BEYOND a round-trip? Nothing legitimate may.
  const roundTrip = (html: any) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML;

  for (const name of ['index', 'architecture', 'states']) {
    it(`${name}.md — the sanitizer changes nothing a DOM round-trip does not`, () => {
      const upstream = fs.readFileSync(path.join(FIX, `${name}.live.html`), 'utf8');
      expect(sanitizeHtml(upstream)).toBe(roundTrip(upstream));
    });
  }

  it('and the round-trip itself loses no element, attribute or diagram', () => {
    // Belt and braces: prove the baseline is not hiding losses of its own.
    const upstream = fs.readFileSync(path.join(FIX, 'architecture.live.html'), 'utf8');
    const out = sanitizeHtml(upstream);
    const count = (s: any, re: any) => (s.match(re) || []).length;
    for (const re of [/<h2 /g, /<h3 /g, /<p>/g, /<pre>/g, /<code/g, /<table>/g, /<svg/g, /class="anchor"/g, /tabindex="-1"/g]) {
      expect(count(out, re), String(re)).toBe(count(upstream, re));
    }
    expect(out).toMatch(/<div class="wide">/);
    expect(out).toMatch(/\.todo-hl \{ stroke: #ffdd33/);
  });
});

describe('markLinksForPane', () => {
  it('opens external links in a new tab and leaves relative ones for the host', () => {
    const body = sanitizeBody('<a href="https://x.test/">e</a><a href="other.md">r</a><a href="#f">f</a>');
    markLinksForPane(body);
    const [external, relative, fragment] = body.querySelectorAll('a');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    // A relative link must NOT navigate: DocView intercepts it and opens the sibling
    // deliverable, because navigating would replace the whole Console.
    expect(relative.getAttribute('target')).toBeNull();
    expect(fragment.getAttribute('target')).toBeNull();
  });
});
