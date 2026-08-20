// Repo-hygiene guard: the three dead-code checks a repo with no linter cannot otherwise
// make. It reads `src/` as text — no bundler, no extra dependency — and derives the entry
// points from build.js itself, so adding or renaming an entry point cannot silently take
// a whole subtree out of scope.
//
// WHAT IT CANNOT SEE, stated so nobody trusts it further than it goes:
//   • An export used ONLY by a test but by no production code. That is real dead weight,
//     but it is indistinguishable here from a legitimate pure-module test seam (a cache
//     reset like `undo.js _reset`, an inspection hook like `renderCache.js cacheStats`),
//     so automating it would be a false-positive machine. Audit it by hand.
//   • Dead CSS. Class names are built dynamically (`inspector-sb-${kind}`) and emitted by
//     libraries (`cm-selectionBackground`, `markdown-alert-note`), so the allowlist would
//     be larger than the signal. Audit it by hand, and verify in a real browser — jsdom
//     has no layout, so no test in this suite can see a stylesheet regression.
//   • Anything reached through a string: `window.__fabryMermaidSvg`, a `chrome.storage`
//     key, a `data-*` attribute contract.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Exports deliberately kept without a consumer. Each needs a reason, and the reason is
// the point: an entry here is a decision, not a snooze button.
const UNCONSUMED_EXPORTS_ALLOWLIST = {
  // The list of per-tab navigation keys. Production cannot consult it — every call site
  // passes only the keys it needs, and `writeTabState` must not reject an unknown key
  // (a silent storage failure is worse than a drifted comment). It stays as the single
  // written-down answer to "which keys are per-tab", pinned by console-tab-state.test.js.
  'src/console/tabState.js': ['TAB_SCOPED_KEYS'],
};

// `h` and `Fragment` are the JSX pragma pair: the compiler emits calls to them, so they
// are used by every JSX file that imports them without ever appearing by name.
const JSX_PRAGMA = new Set(['h', 'Fragment']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(ROOT, p));
  }
  return out;
}

const ALL_SRC = walk(path.join(ROOT, 'src')).map((p) => p.split(path.sep).join('/'));
const CODE = ALL_SRC.filter((f) => /\.(js|jsx)$/.test(f));
const TESTS = walk(path.join(ROOT, 'tests'))
  .map((p) => p.split(path.sep).join('/'))
  .filter((f) => /\.(js|jsx|mjs)$/.test(f));

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Entry points, read out of build.js so this can never disagree with what ships.
function entryPoints() {
  const build = read('build.js');
  const block = build.slice(build.indexOf('entryPoints:'), build.indexOf('bundle: true'));
  return [...block.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]);
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;                     // npm package
  // join+normalize, never resolve: `resolve` would anchor to process.cwd() and hand back
  // an absolute path that never matches a repo-relative entry in ALL_SRC.
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const cands = [base, `${base}.js`, `${base}.jsx`, `${base}.css`,
    path.posix.join(base, 'index.js'), path.posix.join(base, 'index.jsx')];
  return cands.find((c) => ALL_SRC.includes(c)) || null;
}

function specifiers(text) {
  const out = [];
  for (const re of [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,   // import/export … from
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,                          // side-effect import
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                         // dynamic import
  ]) { let m; while ((m = re.exec(text))) out.push(m[1]); }
  return out;
}

// name -> importing files, per target module. Namespace and dynamic imports register '*',
// which counts as a use of every export (we cannot see which member is read).
function importGraph(files) {
  const uses = new Map();
  const add = (target, name) => {
    if (!uses.has(target)) uses.set(target, new Set());
    uses.get(target).add(name);
  };
  for (const f of files) {
    const text = read(f);
    let m;
    const re = /\bimport\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
    while ((m = re.exec(text))) {
      const target = resolveSpec(f, m[2]);
      if (!target) continue;
      const clause = m[1].trim();
      const braced = clause.match(/\{([^}]*)\}/);
      const bare = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
      if (bare.startsWith('*')) add(target, '*');
      else if (bare) add(target, 'default');
      if (braced) for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (t) add(target, t.split(/\s+as\s+/)[0].trim());
      }
    }
    const reExport = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reExport.exec(text))) {
      const target = resolveSpec(f, m[2]);
      if (!target) continue;
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (t) add(target, t.split(/\s+as\s+/)[0].trim());
      }
    }
    const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(text))) {
      const target = resolveSpec(f, m[1]);
      if (target) add(target, '*');
    }
  }
  return uses;
}

function exportedNames(text) {
  const names = new Set();
  let m;
  const decl = /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(text))) names.add(m[1]);
  for (const re of [/\bexport\s*\{([^}]*)\}\s*from/g, /\bexport\s*\{([^}]*)\}(?!\s*from)/g]) {
    while ((m = re.exec(text))) for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      const name = (as[1] || as[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// Occurrences of a bare identifier, ignoring import/export statement lines (a declaration
// is not a use) and property access (`obj.name`). `...` is stripped first, because
// `...defaultDeps` IS a use and would otherwise read as property access.
function bodyUses(text, name) {
  const body = text.split('\n')
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s*\{/.test(l))
    .join('\n')
    .replace(/\.\.\./g, ' ');
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  return (body.match(re) || []).length;
}

describe('every file under src/ is reachable from a build entry point', () => {
  it('has no orphaned module', () => {
    const entries = entryPoints();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(ALL_SRC, `build.js entry ${e} does not exist`).toContain(e);

    const graph = new Map(CODE.map((f) => [
      f, specifiers(read(f)).map((s) => resolveSpec(f, s)).filter(Boolean),
    ]));
    const seen = new Set();
    const stack = [...entries];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const d of graph.get(f) || []) if (!seen.has(d)) stack.push(d);
    }
    // Stylesheets and HTML pages are copied by build.js and linked by the pages, so they
    // are never imported. Everything else must be reachable.
    const orphans = ALL_SRC.filter((f) => !seen.has(f) && !/\.(css|html)$/.test(f));
    expect(orphans).toEqual([]);
  });
});

describe('every export has a consumer', () => {
  it('has no export that nothing imports', () => {
    const uses = importGraph([...CODE, ...TESTS]);
    const dead = [];
    for (const f of CODE) {
      const text = read(f);
      const consumed = uses.get(f) || new Set();
      if (consumed.has('*')) continue;
      const allowed = UNCONSUMED_EXPORTS_ALLOWLIST[f] || [];
      for (const name of exportedNames(text)) {
        if (consumed.has(name) || allowed.includes(name)) continue;
        // An export used inside its own module is only a superfluous `export` keyword,
        // not dead code — the value still ships and still runs.
        if (bodyUses(text, name) > 1) continue;
        dead.push(`${f} :: ${name}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe('no unused local declaration or import', () => {
  it('has no dead identifier inside a module', () => {
    const dead = [];
    for (const f of CODE) {
      const text = read(f);
      const exported = exportedNames(text);
      let m;

      const decl = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
      while ((m = decl.exec(text))) {
        const name = m[1];
        if (exported.has(name)) continue;                     // covered by the check above
        if (bodyUses(text, name) <= 1) dead.push(`${f} :: local ${name}`);
      }

      const imp = /\bimport\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
      while ((m = imp.exec(text))) {
        const clause = m[1].trim();
        const braced = clause.match(/\{([^}]*)\}/);
        const bare = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
        const bound = [];
        if (bare && !bare.startsWith('*')) bound.push(bare);
        if (bare.startsWith('*')) bound.push(bare.replace(/\*\s*as\s*/, '').trim());
        if (braced) for (const part of braced[1].split(',')) {
          const t = part.trim();
          if (t) bound.push((t.split(/\s+as\s+/)[1] || t).trim());
        }
        for (const name of bound) {
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
          if (JSX_PRAGMA.has(name) && f.endsWith('.jsx')) continue;
          if (exported.has(name)) continue;                    // imported purely to re-export
          if (bodyUses(text, name) === 0) dead.push(`${f} :: import ${name} <- ${m[2]}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });
});
