// Golden-file regression guard on the document renderer.
//
// tests/fixtures/localpages/ holds what began as upstream's own examples/basic/*.md and the
// HTML upstream localpages@4d43f26 produced for them (expected/*.{live,export}.html, generated
// by running its src/render.mjs directly). Any drift in markdown-it, the plugins, the slugify,
// the alert markup, the figure wrapping or the .md→.html rewrite fails here.
//
// WHAT THIS NO LONGER CLAIMS. It was "the mechanical 1:1 proof for the localpages port" (spec
// 2026-08-17, §8) — evidence that the port matched upstream byte-for-byte. Fidelity to upstream
// is retired: on 2026-08-25 the owner ended it for the stylesheets, then confirmed it "applies to
// everything", this test included. So these fixtures are OURS now. They are still
// a real guard — nothing about the regression value depended on who authored them — but matching
// upstream is no longer the property being asserted, and a divergence is a decision to record,
// not a failure to fix.
//
// Regenerate them when rendering is changed ON PURPOSE, and say why in the commit. Do NOT
// re-derive them from a newer upstream: that would silently re-adopt upstream's choices as our
// expectations, which is the thing that stopped being a goal.
//
// The fixtures have a SECOND consumer that this decision does not touch:
// tests/docs-sanitize.test.ts uses expected/*.html as a realistic corpus for sanitizer
// idempotence — valuable whoever rendered it, and what caught tabindex="-1" going missing from
// every heading. Do not delete the fixtures as "upstream leftovers"; that guard goes with them.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { createMarkdownRenderer, wrapStandaloneImages, MERMAID_LIGHT } from '../src/docs/render.js';

const FIX = path.resolve(__dirname, 'fixtures/localpages');
// `states` is deliberately NOT here. Its whole subject is the `<state-label>` element, and
// that plugin left the pipeline when states became an Architect property rather than
// document markup (owner, 2026-08-18) — so byte-equivalence for that fixture is not a
// promise this port makes any more. The dedicated block at the bottom pins what it does
// instead, and the fixture stays checked in because the sanitizer suite still measures
// itself against upstream's rendering of it.
const DOCS = ['index', 'architecture'];

// Upstream imports beautiful-mermaid directly; this port injects it so the 1.5MB
// module stays in its own lazy bundle. Same package, same version (1.1.3), so the
// injected renderer and upstream's import are the same function.
function render(name: any, env: any) {
  const md = createMarkdownRenderer({ mermaid: renderMermaidSVG, mermaidTheme: MERMAID_LIGHT });
  const src = fs.readFileSync(path.join(FIX, name + '.md'), 'utf8');
  return wrapStandaloneImages(md.render(src, env));
}

const expected = (name: any, mode: any) =>
  fs.readFileSync(path.join(FIX, 'expected', `${name}.${mode}.html`), 'utf8');

describe('the renderer reproduces its golden fixtures byte-for-byte', () => {
  for (const name of DOCS) {
    test(`${name}.md — live mode`, () => {
      expect(render(name, {})).toBe(expected(name, 'live'));
    });
    test(`${name}.md — export mode (.md → .html rewriting)`, () => {
      expect(render(name, { forExport: true })).toBe(expected(name, 'export'));
    });
  }

  test('the fixtures actually exercise the features being pinned', () => {
    const live = expected('index', 'live');
    expect(live).toMatch(/markdown-alert-note/); // GitHub alerts
    expect(live).toMatch(/markdown-alert-warning/);
    expect(live).toMatch(/class="anchor"/); // heading permalinks
    expect(live).toMatch(/<figure>.*<figcaption>/s); // standalone-image figures
    expect(expected('architecture', 'live')).toMatch(/<div class="wide">.*<svg/s); // mermaid
    // Upstream's own rendering of states.md, kept as the reference for what the element
    // USED to produce here (see the deliberate-divergence block below).
    const states = expected('states', 'live');
    expect(states).toMatch(/<span class="state-label state-verified" data-state="verified">/);
    expect(states).toMatch(/<div class="state-summary"/);
    // The export-mode rewrite is what the second assertion per doc is protecting.
    expect(expected('index', 'export')).toMatch(/href="architecture\.html"/);
    expect(expected('index', 'live')).not.toMatch(/href="architecture\.html"/);
  });
});

describe('source-line anchors are live-only', () => {
  test('env.syncLines stamps data-src-line on block openings', () => {
    const md = createMarkdownRenderer();
    const html = md.render('# Title\n\nBody paragraph.\n\n## Section\n\nMore.\n', {
      syncLines: true,
    });
    expect(html).toMatch(/<h1 [^>]*data-src-line="0"/);
    expect(html).toMatch(/<p data-src-line="2">/);
    expect(html).toMatch(/<h2 [^>]*data-src-line="4"/);
  });

  test('without the flag the output is untouched — which is why export stays byte-identical', () => {
    const md = createMarkdownRenderer();
    const src = '# Title\n\nBody paragraph.\n';
    expect(md.render(src, {})).not.toMatch(/data-src-line/);
    expect(md.render(src, {})).toBe(md.render(src, { forExport: true }));
  });

  test('every fixture renders identically with and without syncLines once anchors are stripped', () => {
    for (const name of DOCS) {
      const withAnchors = render(name, { syncLines: true }).replace(/ data-src-line="\d+"/g, '');
      expect(withAnchors).toBe(expected(name, 'live'));
    }
  });
});

describe('mermaid is injected, not imported', () => {
  test('a mermaid fence falls back to a code block when no renderer is available', () => {
    const md = createMarkdownRenderer(); // no mermaid injected (bundle not loaded yet)
    const html = md.render('```mermaid\ngraph TD\n  A --> B\n```\n');
    expect(html).not.toMatch(/<svg/);
    expect(html).toMatch(/<pre><code/);
  });

  test('TODO/TBD inside a diagram gets the yellow stroke, as upstream', () => {
    const md = createMarkdownRenderer({ mermaid: renderMermaidSVG });
    const html = md.render('```mermaid\ngraph TD\n  A[Do TODO thing] --> B[Done]\n```\n');
    expect(html).toMatch(/<tspan class="todo-hl">TODO<\/tspan>/);
    expect(html).toMatch(/\.todo-hl \{ stroke: #ffdd33/);
  });
});

describe('the one deliberate divergence: <state-label> is no longer document markup', () => {
  // Owner, 2026-08-18: "add the support for state-label, but let's make it part of the
  // Fabry's Architect (not inside the markdown)". So the element must NOT render a badge —
  // and, critically, must not vanish in silence either, which is what it did before this
  // diagnostic existed and is exactly what the convention was designed to prevent.
  test('it produces a visible notice and a warning instead of a badge', () => {
    const md = createMarkdownRenderer();
    const env = {} as any;
    const html = md.render(
      '## 3. Architecture\n\n<state-label state="ready" date="2026-08-17" />\n',
      env,
    );
    expect(html).not.toMatch(/class="state-label state-ready"/); // no badge
    expect(html).not.toMatch(/state-summary/); // no tally
    expect(html).toMatch(/class="state-label state-error"/); // a visible notice
    expect(html).toMatch(/renders as nothing/);
    expect(env.stateLabelWarnings).toHaveLength(1);
    expect(env.stateLabelWarnings[0].message).toMatch(/not supported here/);
  });

  test("upstream's states.md now differs from upstream only in that respect", () => {
    // Everything that is not a state label still matches: same headings, same slugs, same
    // prose, same fenced example. Only the badges and the tally are gone.
    const ours = render('states', {});
    const theirs = expected('states', 'live');
    const strip = (h: any) =>
      h
        .replace(/<span class="state-label[\s\S]*?<\/span><\/span>/g, '')
        .replace(/<div class="state-summary[\s\S]*?<\/div>\n?/, '')
        .replace(/ class="has-state-label"/g, '')
        .replace(/<span class="state-label state-error">[\s\S]*?<\/span><\/span>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(strip(ours)).toBe(strip(theirs));
  });
});
