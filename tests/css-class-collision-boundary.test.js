import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

// CSS-module / hand-written-class collision boundary.
//
// esbuild's identifier minifier renames CSS Modules' local class names (e.g.
// Academy.module.css's `.heroBlobA`) down to short one/two-character globals
// emitted into dist/console/console.css. esbuild only guarantees those
// generated names are unique AMONG THEMSELVES — not against a bare,
// hand-written class literal in JSX markup (`<div class="k">`), which is
// styled instead via a descendant-scoped rule in the legacy
// dist/console/console.base.css (e.g. `.inspector-kv .k`). When a CSS-module
// local happened to also minify to "k", its unrelated top-level `.k{...}`
// rule leaked onto every "k"-classed element on the page (see the shipped
// bug this test guards against: an Inspector export-panel label cell
// rendering as a 320x320 decorative blob).
//
// build.js now keeps `minifyIdentifiers` OFF (only whitespace/syntax
// minification), so CSS-module locals keep their long, collision-proof
// names — but this test guards the invariant directly and independently of
// that build flag, so a future change that re-enables identifier
// minification (or ships some other CSS pipeline) is still caught here
// rather than only rediscovered by a screenshot.
//
// Scope is deliberately narrow to match the actual bug shape: only classes
// used BARE (the entire `class="…"` attribute is a single short token, no
// other classes, nothing dynamic) are checked, and only against selectors in
// dist/console/console.css that are themselves a bare TOP-LEVEL class
// selector (no descendant/compound context) — that is exactly the shape a
// leaked CSS-module global takes, and exactly what makes a short hand-written
// class dangerous to leave unprefixed. A legitimate hand-written rule like
// `.inspector-panel { … }` matching its own same-named class is not what
// this test is about — those live in console.base.css, a file this test
// never inspects.
const ROOT = process.cwd();

function walk(dir, filterExt) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filterExt));
    else if (filterExt.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

// Every BARE class="…" literal (single class, no whitespace) in src/**/*.jsx,
// short enough to plausibly collide with a generated CSS-module name.
function bareShortClasses() {
  const found = [];
  for (const file of walk(join(ROOT, 'src'), /\.(jsx|tsx)$/)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/class="([A-Za-z][A-Za-z0-9_-]{0,3})"/g)) {
        found.push({ name: m[1], file: rel(file), line: i + 1 });
      }
    });
  }
  return found;
}

// Bare top-level class selectors in the built CSS — `.foo{…}` or `.foo, .bar
// {…}` or `.foo:hover{…}`, but NOT `.foo .bar{…}` or `.foo.bar{…}`.
function topLevelSelectorClasses(css) {
  const names = new Set();
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const selectorList = m[1];
    for (const sel of selectorList.split(',')) {
      const s = sel.trim();
      const bare = s.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)(::?[A-Za-z-]+(\([^)]*\))?)?$/);
      if (bare) names.add(bare[1]);
    }
  }
  return names;
}

describe('CSS class collision boundary', () => {
  it('no class used bare in src/**/*.jsx also appears as a top-level selector in dist/console/console.css', () => {
    const cssPath = join(ROOT, 'dist', 'console', 'console.css');
    if (!existsSync(cssPath)) {
      throw new Error('run `npm run build` before this test — it inspects dist/');
    }
    const topLevel = topLevelSelectorClasses(readFileSync(cssPath, 'utf8'));
    const offenders = bareShortClasses()
      .filter((c) => topLevel.has(c.name))
      .map((c) => `${c.name} @ ${c.file}:${c.line}`);
    expect(offenders).toEqual([]);
  });
});
