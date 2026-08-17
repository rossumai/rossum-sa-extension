# Architect Unified Specification View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Architect's one-deliverable-at-a-time pane with a single continuous specification document — navigable from the sidebar, inspected from a scroll-following right rail, and rendered either as Markdown source or as Markdown.

**Architecture:** One scroller holds every deliverable as a `<section data-deliverable>`. `DocView` is generalized from one document to N and initialises the document behaviours once for the page. Heading ids are namespaced per deliverable because they collide otherwise. A pure `specTarget` module decides which deliverable the rail is showing (scroll spy, held during a run, pinnable). The bottom action console disappears; its panels are reused inside the rail.

**Tech Stack:** Preact + `@preact/signals`, CodeMirror 6 (`@codemirror/lang-markdown`), markdown-it via `src/docs/render.js`, Vitest + jsdom, esbuild, `agent-browser` for headless layout verification.

**Spec:** `docs/superpowers/specs/2026-08-19-architect-unified-specification-view-design.md` — read it first; every task below argues from it and its fact table F1–F10.

## Global Constraints

- **Never commit.** Owner rule: work ends **staged** (`git add -A`), and the owner decides when to commit. Every task's final step is "Stage", not "Commit". Do not create branches or worktrees.
- **Tests are `.test.js` under `tests/`**, Vitest. JSX in tests is written `h(Component, props)` — raw JSX in a `.test.js` file fails to parse. Add `// @vitest-environment jsdom` at the top of any test that touches the DOM.
- **Never wait on a fixed timeout in a test.** Poll the condition (`await vi.waitFor(...)` or a `waitFor` helper). Fixed `setTimeout` flushes race Preact's after-paint effects under full-suite load.
- **jsdom has no layout.** Every height, width, scroll offset and "is it visible" claim must be measured in a browser harness (see the recipe in Task 11), never asserted in a unit test.
- **Unicode in JSX** must go through an expression: `{'✓'}`, never `✓` in raw JSX text or an attribute value.
- **Rebuild after UI changes:** `npm run build`, and tell the owner to reload the extension. Tests run `src/`; the loaded extension runs `dist/`.
- **Full suite must stay green:** `npm test` — currently **310 files / 3356 tests**. Never leave it red between tasks.
- **No new persisted content.** Deliverable text, results and version history keep their existing shapes (spec §7). The only storage changes are `fabryArchDocView`'s value set plus two new boolean prefs.
- **Owner-visible copy** says "deliverable", "specification", "Check", "Refine", "History" — match the existing vocabulary exactly.

## File Structure

**New — pure, no DOM:**
- `src/fabry/architect/specTarget.js` — which deliverable the rail shows; which heading is active.
- `src/docs/specDocument.js` — assembles per-deliverable section descriptors (shared with the print path).

**New — DOM-touching but dependency-light:**
- `src/docs/idNamespace.js` — per-deliverable id prefixing and in-page fragment resolution.

**New — components:**
- `src/fabry/architect/components/SpecView.jsx` — the document column: bar, sections, scroll spy, edit/preview bodies, document-width review host.
- `src/fabry/architect/components/InspectorRail.jsx` — the right rail: target header, pin, tabs hosting the existing panels.

**Modified:**
- `src/docs/components/DocView.jsx` — N sections; behaviours bound once to the root; namespacing on adopt.
- `src/docs/client/sectionPreview.js`, `src/docs/client/sourceViewer.js` — bind to the root instead of a single `.markdown-body` (one line each; `DocView` is their only caller since the ZIP export was removed).
- `src/docs/printDoc.js` — consumes `specDocument.js` instead of assembling inline.
- `src/fabry/architect/store.js` — `DOC_VIEWS` becomes `['edit','preview']` + `split`→`preview` migration; `tocOpen`/`railOpen` prefs; `pinnedTarget`, `spyTarget` signals.
- `src/fabry/architect/components/ArchitectSidebar.jsx` — navigation tree over all deliverables.
- `src/fabry/architect/components/ArchitectApp.jsx` — renders `SpecView` + `InspectorRail`.
- `src/console/console.css` — `.fabry-spec-*` rules.
- `CLAUDE.md`, the spec (revision note).

**Deleted:**
- `src/fabry/architect/components/DeliverableEditor.jsx` and its tests' expectations that assume a per-deliverable pane.

---

### Task 1: `specTarget.js` — which deliverable the rail is showing

**Files:**
- Create: `src/fabry/architect/specTarget.js`
- Test: `tests/fabry-architect-spec-target.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `currentSection(tops, scrollTop, offset?) -> id|null`, `railTarget({spy, pinned, running}) -> id|null`, `activeHeadingAt(headings, scrollTop, offset?) -> {docId, slug}|null`, `SPY_OFFSET = 64`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { currentSection, railTarget, activeHeadingAt, SPY_OFFSET } from '../src/fabry/architect/specTarget.js';

const TOPS = [{ id: 'a', top: 0 }, { id: 'b', top: 1200 }, { id: 'c', top: 2400 }];

describe('currentSection', () => {
  it('is the last section whose top has passed the threshold', () => {
    expect(currentSection(TOPS, 0)).toBe('a');
    expect(currentSection(TOPS, 1200 - SPY_OFFSET)).toBe('b');   // exactly at the threshold counts
    expect(currentSection(TOPS, 1500)).toBe('b');
    expect(currentSection(TOPS, 5000)).toBe('c');
  });

  it('holds the first section while scrolled above it, and tolerates junk', () => {
    expect(currentSection(TOPS, -300)).toBe('a');
    expect(currentSection([], 10)).toBe(null);
    expect(currentSection(null, 10)).toBe(null);
    expect(currentSection(TOPS, NaN)).toBe('a');
  });

  it('does not assume the input is sorted', () => {
    expect(currentSection([...TOPS].reverse(), 1500)).toBe('b');
  });
});

describe('railTarget', () => {
  it('prefers an explicit pin over the scroll', () => {
    expect(railTarget({ spy: 'c', pinned: 'a', running: null })).toBe('a');
  });

  it('HOLDS the shown deliverable while a check runs for it', () => {
    // A run started from the rail must not have its panel scrolled away.
    expect(railTarget({ spy: 'c', pinned: null, running: 'a', shown: 'a' })).toBe('a');
  });

  it('follows the scroll when nothing is pinned and the run is elsewhere', () => {
    expect(railTarget({ spy: 'c', pinned: null, running: 'b', shown: 'b' })).toBe('b');
    expect(railTarget({ spy: 'c', pinned: null, running: null, shown: 'a' })).toBe('c');
    expect(railTarget({ spy: null, pinned: null, running: null, shown: 'a' })).toBe('a');
    expect(railTarget({})).toBe(null);
  });
});

describe('activeHeadingAt', () => {
  const H = [
    { docId: 'a', slug: 'a--one', top: 40 },
    { docId: 'a', slug: 'a--two', top: 800 },
    { docId: 'b', slug: 'b--one', top: 1300 },
  ];
  it('reports the heading the reader is under, across deliverables', () => {
    expect(activeHeadingAt(H, 0)).toEqual({ docId: 'a', slug: 'a--one' });
    expect(activeHeadingAt(H, 900)).toEqual({ docId: 'a', slug: 'a--two' });
    expect(activeHeadingAt(H, 4000)).toEqual({ docId: 'b', slug: 'b--one' });
    expect(activeHeadingAt([], 10)).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/fabry-architect-spec-target.test.js`
Expected: FAIL — `Failed to resolve import ... specTarget.js`.

- [ ] **Step 3: Implement**

```js
// Which deliverable the inspector rail is showing, and which heading the reader is under.
//
// Pure on purpose: jsdom has no layout, so the DECISION is unit-tested here while the
// MEASUREMENT (offsetTop of each section) is browser-verified — the same split
// stageLink.js / smoothScroll.js / tether.js already use.

// How far below the scroller's top edge a section must reach before it counts as "current".
// Matches the sticky header's height, so the section you are reading is the one named.
export const SPY_OFFSET = 64;

export function currentSection(tops, scrollTop, offset = SPY_OFFSET) {
  const list = (Array.isArray(tops) ? tops : []).filter((t) => t && t.id != null)
    .slice().sort((a, b) => (a.top || 0) - (b.top || 0));
  if (!list.length) return null;
  const y = Number.isFinite(scrollTop) ? scrollTop : 0;
  let found = list[0].id;
  for (const t of list) if ((t.top || 0) - offset <= y) found = t.id;
  return found;
}

// `shown` is what the rail is displaying right now; `running` is the deliverable with a
// check in flight. A run started from the rail must not be scrolled away mid-flight, so a
// running+shown deliverable HOLDS the target until it finishes.
export function railTarget({ spy = null, pinned = null, running = null, shown = null } = {}) {
  if (pinned) return pinned;
  if (running && running === shown) return shown;
  return spy || shown || null;
}

export function activeHeadingAt(headings, scrollTop, offset = SPY_OFFSET) {
  const list = (Array.isArray(headings) ? headings : []).filter((h) => h && h.slug)
    .slice().sort((a, b) => (a.top || 0) - (b.top || 0));
  if (!list.length) return null;
  const y = Number.isFinite(scrollTop) ? scrollTop : 0;
  let found = list[0];
  for (const h of list) if ((h.top || 0) - offset <= y) found = h;
  return { docId: found.docId, slug: found.slug };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run tests/fabry-architect-spec-target.test.js`

- [ ] **Step 5: Stage**

```bash
git add src/fabry/architect/specTarget.js tests/fabry-architect-spec-target.test.js
```

---

### Task 2: `idNamespace.js` — stop heading ids colliding

**Files:**
- Create: `src/docs/idNamespace.js`
- Test: `tests/docs-id-namespace.test.js`

**Interfaces:**
- Consumes: `resolveHeadingId` from `src/docs/anchorResolve.js`.
- Produces: `prefixFor(slug) -> string`, `namespaceSection(sectionEl, prefix) -> Map<string,string>`, `resolveInPage(root, fragment, currentPrefix?) -> Element|null`.

**Why hrefs are NOT rewritten** (a correction to spec §4.2, carried here deliberately): prefixing an
authored `#2.1` to `#data-model--2.1` would defeat `anchorResolve`'s forgiving matching, because the
real id is `data-model--21-entities`. So only **element ids** are prefixed, authored hrefs are left
exactly as written, and all the cleverness lives in `resolveInPage`. That also keeps the deliverable's
text round-trippable.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { prefixFor, namespaceSection, resolveInPage } from '../src/docs/idNamespace.js';

function page() {
  const root = document.createElement('div');
  root.innerHTML = `
    <section data-deliverable="d1" data-slug="data-model">
      <h1 id="data-model">Data model</h1><h2 id="21-entities">2.1 Entities</h2>
      <p><a href="#21-entities">jump</a> <a href="#2.1">forgiving</a></p>
    </section>
    <section data-deliverable="d2" data-slug="intake">
      <h1 id="intake">Intake</h1><h2 id="21-entities">2.1 Entities</h2>
    </section>`;
  for (const s of root.querySelectorAll('section')) namespaceSection(s, prefixFor(s.dataset.slug));
  return root;
}

describe('namespaceSection', () => {
  it('prefixes ids so two deliverables can hold the same heading', () => {
    const root = page();
    expect([...root.querySelectorAll('[id]')].map((e) => e.id)).toEqual([
      'data-model--data-model', 'data-model--21-entities', 'intake--intake', 'intake--21-entities',
    ]);
  });

  it('leaves authored hrefs untouched, so the text stays round-trippable', () => {
    const root = page();
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#21-entities', '#2.1']);
  });

  it('reports the mapping it applied', () => {
    const s = document.createElement('section');
    s.innerHTML = '<h2 id="scope">Scope</h2>';
    expect(namespaceSection(s, 'x--').get('scope')).toBe('x--scope');
  });

  it('is idempotent — adopting twice must not double-prefix', () => {
    const s = document.createElement('section');
    s.innerHTML = '<h2 id="scope">Scope</h2>';
    namespaceSection(s, 'x--');
    namespaceSection(s, 'x--');
    expect(s.querySelector('[id]').id).toBe('x--scope');
  });
});

describe('resolveInPage', () => {
  it('resolves within the reader current section FIRST when ids collide', () => {
    const root = page();
    const hit = resolveInPage(root, '21-entities', 'intake--');
    expect(hit.closest('section').dataset.deliverable).toBe('d2');
  });

  it('falls back to document order when the current section has no such heading', () => {
    const root = page();
    expect(resolveInPage(root, 'data-model', 'intake--').id).toBe('data-model--data-model');
  });

  it('stays forgiving about the form the author wrote', () => {
    const root = page();
    expect(resolveInPage(root, '2.1', 'data-model--').id).toBe('data-model--21-entities');
    expect(resolveInPage(root, '2.1 Entities', 'data-model--').id).toBe('data-model--21-entities');
  });

  it('returns null rather than guessing', () => {
    expect(resolveInPage(page(), 'nothing-like-this', 'data-model--')).toBe(null);
    expect(resolveInPage(null, 'x')).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/docs-id-namespace.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// Per-deliverable id namespacing for the unified specification view.
//
// MEASURED (spec F2): two deliverables containing `## 2. Scope` both render `id="2-scope"`,
// because markdown-it-anchor dedupes within one render only. Concatenated, `querySelector`
// returns the first, so every fragment link and outline jump would land in the wrong
// document. Prefixing ids per deliverable is what makes one page addressable.
//
// Applied to the ADOPTED COPY, never to the cached render (spec F7), so `render.js` stays
// byte-faithful to upstream localpages and the cache stays shareable with the print path.
import { resolveHeadingId } from './anchorResolve.js';

export const prefixFor = (slug) => `${String(slug || '')}--`;

// Only ids move. Authored hrefs are left exactly as written: rewriting `#2.1` to
// `#slug--2.1` would defeat the forgiving matching below (the real id is `slug--21-entities`),
// and an untouched href keeps the deliverable's text round-trippable.
export function namespaceSection(sectionEl, prefix) {
  const map = new Map();
  if (!sectionEl || !prefix) return map;
  for (const el of sectionEl.querySelectorAll('[id]')) {
    const id = el.getAttribute('id');
    if (!id || id.startsWith(prefix)) continue;   // idempotent: adopting twice must not double up
    map.set(id, prefix + id);
    el.setAttribute('id', prefix + id);
  }
  return map;
}

function headingsIn(scope, prefix) {
  return [...scope.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')].map((el) => ({
    el,
    // resolveHeadingId matches on the id AS AUTHORED, so hand it the un-prefixed form.
    id: prefix && el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id,
    text: el.textContent || '',
  }));
}

// The reader's own section wins first: with a colliding id, "the one I am looking at" is
// what a fragment in that document means.
export function resolveInPage(root, fragment, currentPrefix = '') {
  if (!root || !fragment) return null;
  const scopes = [];
  if (currentPrefix) {
    const own = [...root.querySelectorAll('[data-slug]')].find((s) => prefixFor(s.dataset.slug) === currentPrefix);
    if (own) scopes.push([own, currentPrefix]);
  }
  for (const s of root.querySelectorAll('[data-slug]')) {
    const p = prefixFor(s.dataset.slug);
    if (p !== currentPrefix) scopes.push([s, p]);
  }
  if (!scopes.length) scopes.push([root, '']);
  for (const [scope, prefix] of scopes) {
    const heads = headingsIn(scope, prefix);
    const hit = resolveHeadingId(heads, fragment);
    if (hit) {
      const found = heads.find((h) => h.id === hit);
      if (found) return found.el;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test — expect PASS.** If `resolveHeadingId` returns an id rather than the entry, the `heads.find` above is what maps it back; do not change `anchorResolve.js`.

- [ ] **Step 5: Stage**

```bash
git add src/docs/idNamespace.js tests/docs-id-namespace.test.js
```

---

### Task 3: `specDocument.js` — one assembler for screen and paper

**Files:**
- Create: `src/docs/specDocument.js`
- Modify: `src/docs/printDoc.js` (use it)
- Test: `tests/docs-spec-document.test.js`; `tests/docs-print.test.js` must stay green untouched.

**Interfaces:**
- Consumes: `wrapStandaloneImages` (`render.js`), `sanitizeHtml` (`sanitize.js`), `reportDocWarnings` (`docWarnings.js`), `assignSlugs` (`slug.js`).
- Produces: `buildSpecSections({ deliverables, displayTitle, md }) -> { sections, warnings }` where a section is `{ id, slug, title, showTitle, state, stateDate, verdict, bodyHtml }`; and `declaresOwnHeading(text)` re-exported from here for both callers.

The shared module returns **data, not chrome**: print draws SVG state badges, the screen draws
`console.css` pills. Only the assembly is shared, so the printed specification and the on-screen one
cannot drift.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { buildSpecSections } from '../src/docs/specDocument.js';
import { createMarkdownRenderer } from '../src/docs/render.js';

const md = createMarkdownRenderer();
const displayTitle = (d) => d.title || 'Untitled';
const build = (deliverables, results = {}) => buildSpecSections({ deliverables, displayTitle, results, md });

describe('buildSpecSections', () => {
  it('returns one section per deliverable, in the order given, with slugs assigned', () => {
    const { sections } = build([
      { id: 'a', title: 'Data model', text: '## Entities\n', order: 1 },
      { id: 'b', title: 'Data model', text: 'text\n', order: 2 },
    ]);
    expect(sections.map((s) => [s.id, s.slug])).toEqual([['a', 'data-model'], ['b', 'data-model-2']]);
  });

  it('renders and sanitizes the body', () => {
    const { sections } = build([{ id: 'a', title: 'T', text: '## Scope\n\n<script>x()</script>\n' }]);
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
  });

  it('carries state and verdict as DATA, not markup', () => {
    const { sections } = build(
      [{ id: 'a', title: 'T', text: 'x', state: 'verified', stateDate: '2026-08-12' }],
      { a: { verdict: 'pass' } },
    );
    expect(sections[0]).toMatchObject({ state: 'verified', stateDate: '2026-08-12', verdict: 'pass' });
    expect(JSON.stringify(sections[0])).not.toMatch(/<svg|<span/);
  });

  it('collects document warnings per deliverable, naming the document', () => {
    const { warnings } = build([{ id: 'a', title: 'Intake', text: '<state-label>ready</state-label>\n' }]);
    expect(warnings.join(' ')).toMatch(/Intake/);
  });

  it('tolerates an empty list', () => {
    expect(build([])).toEqual({ sections: [], warnings: [] });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found).**

- [ ] **Step 3: Implement `specDocument.js`**

```js
// Assembles a specification: one section descriptor per deliverable, rendered and sanitized.
//
// Extracted from printDoc.js (2026-08-19) so the printed specification and the on-screen
// unified view share ONE concatenator. It deliberately returns DATA rather than chrome —
// print draws SVG state badges, the screen draws console.css pills — so only the assembly is
// shared and the two presentations cannot drift.
import { wrapStandaloneImages } from './render.js';
import { sanitizeHtml } from './sanitize.js';
import { reportDocWarnings } from './docWarnings.js';
import { assignSlugs } from './slug.js';

// A deliverable that opens with its own Markdown heading must not be given a second title.
// Same rule the sidebar uses to let a deliverable name itself.
const LEADING_HEADING = /^(#{1,4})\s+(.*)$/;
export function declaresOwnHeading(text) {
  const line = String(text || '').split('\n').find((l) => l.trim());
  return !!(line && LEADING_HEADING.test(line));
}

export function buildSpecSections({ deliverables = [], displayTitle, results = {}, md }) {
  const warnings = [];
  const slugs = assignSlugs(deliverables, displayTitle);
  const sections = deliverables.map((d) => {
    const title = displayTitle(d);
    const env = {};
    const bodyHtml = sanitizeHtml(wrapStandaloneImages(md.render(d.text || '', env)));
    reportDocWarnings(env, title, (m) => warnings.push(m));
    return {
      id: d.id,
      slug: slugs.get(d.id),
      title,
      showTitle: !declaresOwnHeading(d.text),
      state: d.state || null,
      stateDate: d.stateDate || '',
      verdict: (results[d.id] && results[d.id].verdict) || null,
      bodyHtml,
    };
  });
  return { sections, warnings };
}
```

- [ ] **Step 4: Run the new test — expect PASS.**

- [ ] **Step 5: Rewrite `printDoc.js`'s per-deliverable loop to consume it**

Replace the `for (const d of deliverables)` block (which renders, sanitizes and reports warnings
inline) with a call to `buildSpecSections`, keeping print's own `stateBadge`/`verdictChip`/`<section
class="print-doc">` wrapper and its `declaresOwnHeading` import now coming from `specDocument.js`:

```js
import { buildSpecSections } from './specDocument.js';
export { declaresOwnHeading } from './specDocument.js';   // printDoc's existing export, unchanged for callers
// ...
const { sections: built, warnings: buildWarnings } = buildSpecSections({ deliverables, displayTitle, results, md });
warnings.push(...buildWarnings);
for (const s of built) {
  const meta = [opts.states ? stateBadge({ state: s.state, stateDate: s.stateDate }) : '',
                opts.verdicts ? verdictChip(results[s.id]) : ''].filter(Boolean).join('');
  const header = (s.showTitle || meta)
    ? `<header class="print-doc-head${s.showTitle ? '' : ' meta-only'}">`
      + (s.showTitle ? `<h1 class="print-doc-title">${esc(s.title)}</h1>` : '')
      + (meta ? `<div class="print-doc-meta">${meta}</div>` : '')
      + '</header>'
    : '';
  sections.push(`<section class="print-doc">${header}${s.bodyHtml}</section>`);
}
```

- [ ] **Step 6: Run the print tests — they are the safety net for this refactor**

Run: `npx vitest run tests/docs-print.test.js tests/docs-spec-document.test.js`
Expected: PASS, unchanged. If a print assertion moves, the extraction changed behaviour — fix the
extraction, not the test.

- [ ] **Step 7: Stage**

```bash
git add src/docs/specDocument.js src/docs/printDoc.js tests/docs-spec-document.test.js
```

---

### Task 4: store — two modes, two collapse prefs, target signals

**Files:**
- Modify: `src/fabry/architect/store.js`
- Test: `tests/fabry-architect-store-view.test.js`

**Interfaces:**
- Produces: `DOC_VIEWS = ['edit','preview']`, `docView`, `setDocView`, `migrateDocView(stored) -> 'edit'|'preview'`, `tocOpen`, `setTocOpen`, `railOpen`, `setRailOpen`, `pinnedTarget`, `setPinnedTarget`, `spyTarget`, `setSpyTarget`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { DOC_VIEWS, migrateDocView } from '../src/fabry/architect/store.js';

describe('document view modes', () => {
  it('offers exactly edit and preview — the combined mode is gone', () => {
    expect(DOC_VIEWS).toEqual(['edit', 'preview']);
  });

  it('migrates a stored split to preview, and keeps a known value', () => {
    expect(migrateDocView('split')).toBe('preview');      // the mode no longer exists
    expect(migrateDocView('edit')).toBe('edit');
    expect(migrateDocView('preview')).toBe('preview');
  });

  it('defaults anything unrecognised to preview — the reading mode', () => {
    expect(migrateDocView(undefined)).toBe('preview');
    expect(migrateDocView('nonsense')).toBe('preview');
    expect(migrateDocView(42)).toBe('preview');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`DOC_VIEWS` still has three entries).

- [ ] **Step 3: Implement in `store.js`**

Replace the `DOC_VIEWS`/`docView`/`setDocView` block and the `fabryArchSplitRatio` boot read:

```js
// Edit | Preview. The combined ("Editor and Preview") mode was removed 2026-08-19 with the
// per-deliverable pane: the unified view renders every deliverable at once, and the switch
// changes only HOW the text renders, not what surrounds it.
export const DOC_VIEWS = ['edit', 'preview'];
export const docView = signal('preview');   // reading is the default: Cmd+F only works here (spec F5)

// A profile written by an older build can hold 'split'. It maps to 'preview' rather than being
// ignored, so the reader lands in the mode that still exists. An older build reading 'edit' or
// 'preview' still understands both, so the pref degrades in BOTH directions.
export function migrateDocView(stored) {
  if (stored === 'edit' || stored === 'preview') return stored;
  return 'preview';
}
export function setDocView(mode) {
  if (!DOC_VIEWS.includes(mode)) return;
  docView.value = mode;
  try { chrome.storage?.local?.set({ fabryArchDocView: mode }); } catch { /* no storage (tests) */ }
}

// Both side columns collapse; measured widths at a 1280px window are 664 / 908 / 1230 (spec F9).
export const tocOpen = signal(true);
export const railOpen = signal(true);
function persistBool(key, sig) {
  return (v) => { sig.value = !!v; try { chrome.storage?.local?.set({ [key]: !!v }); } catch { /* tests */ } };
}
export const setTocOpen = persistBool('fabryArchTocOpen', tocOpen);
export const setRailOpen = persistBool('fabryArchRailOpen', railOpen);

// Rail targeting. `spyTarget` is what the scroll says; `pinnedTarget` is an explicit lock.
// Neither is persisted: which paragraph you are reading is not worth carrying between sessions.
export const spyTarget = signal(null);
export const pinnedTarget = signal(null);
export function setSpyTarget(id) { if (spyTarget.value !== id) spyTarget.value = id; }
export function setPinnedTarget(id) { pinnedTarget.value = id || null; }
```

And in the boot `chrome.storage.local.get([...])` block, read the new keys and migrate the mode:

```js
chrome.storage?.local?.get(['fabryArchDocView', 'fabryArchTocOpen', 'fabryArchRailOpen', 'fabryArchPdfOptions']).then((v) => {
  docView.value = migrateDocView(v && v.fabryArchDocView);
  if (v && typeof v.fabryArchTocOpen === 'boolean') tocOpen.value = v.fabryArchTocOpen;
  if (v && typeof v.fabryArchRailOpen === 'boolean') railOpen.value = v.fabryArchRailOpen;
  // ...existing pdfOptions handling unchanged...
}).catch(() => {});
```

Leave `splitRatio`/`SPLIT_MIN`/`SPLIT_MAX` exports in place for one release: nothing reads them after
Task 8, and deleting them is a separate, trivial cleanup.

- [ ] **Step 4: Run the test — expect PASS. Then run the whole architect group; `fabry-architect-app.test.js` will fail because it sets `docView.value = 'edit'` and asserts a three-way switch — that is Task 8's job. Note the failures and move on only if they are exclusively in files Task 8 rewrites.**

Run: `npx vitest run tests/fabry-architect-store-view.test.js`

- [ ] **Step 5: Stage**

```bash
git add src/fabry/architect/store.js tests/fabry-architect-store-view.test.js
```

---

### Task 5: `DocView` renders N sections, binds behaviours once

**Files:**
- Modify: `src/docs/components/DocView.jsx`, `src/docs/client/sectionPreview.js`, `src/docs/client/sourceViewer.js`
- Test: `tests/docs-docview-sections.test.js`

**Interfaces:**
- Consumes: `renderDocument` (`renderCache.js`), `namespaceSection`/`prefixFor`/`resolveInPage` (Task 2).
- Produces: `<DocView sections={[{ id, slug, text }]} … />` rendering `.docs-pane > .docs-root > section[data-deliverable][data-slug] > .markdown-body`, one behaviour set per page, ids namespaced.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import DocView from '../src/docs/components/DocView.jsx';

const SECTIONS = [
  { id: 'd1', slug: 'data-model', text: '# Data model\n\n## 2. Scope\n\nalpha\n' },
  { id: 'd2', slug: 'intake', text: '# Intake\n\n## 2. Scope\n\nbeta\n' },
];
function mount(props = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => { render(h(DocView, { sections: SECTIONS, ...props }), root); });
  return root;
}
beforeEach(() => { document.body.innerHTML = ''; });

describe('DocView with many sections', () => {
  it('renders one section per deliverable, tagged with id and slug', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('section[data-deliverable]').length).toBe(2));
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.slug)).toEqual(['data-model', 'intake']);
  });

  it('puts EVERY deliverable text in the DOM — this is what makes Cmd+F work (spec F3)', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.textContent).toMatch(/alpha/));
    expect(root.textContent).toMatch(/beta/);
  });

  it('namespaces colliding heading ids so a fragment can address one deliverable', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('h2[id]').length).toBe(2));
    expect([...root.querySelectorAll('h2[id]')].map((e) => e.id)).toEqual(['data-model--2-scope', 'intake--2-scope']);
  });

  it('keeps one scroller and one behaviour set for the whole page', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.docs-root').length).toBe(1));
    // copy buttons come from initCodeCopy; one init must cover every section
    expect(root.querySelectorAll('.markdown-body').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (DocView still takes `text` and renders one body).

- [ ] **Step 3: Change the two client behaviours to bind at the root**

`sectionPreview.js:205` and `sourceViewer.js:161` both do `var body = root.querySelector('.markdown-body');`.
With N bodies that binds the first one only. `DocView` is their sole caller since the ZIP export was
removed, so scope them to the root:

```js
  // The unified view has one .markdown-body PER DELIVERABLE (2026-08-19), so listeners bind at
  // the root and events bubble up from whichever section they happened in. With a single body
  // this is identical to what it replaced.
  var body = root;
```

- [ ] **Step 4: Change `DocView` to take `sections`**

- Render `sections.map((s) => <section data-deliverable={s.id} data-slug={s.slug}><div class="markdown-body" /></section>)` inside `.docs-root`.
- In the adopt effect, loop the sections: render each `text` through `renderDocument`, `replaceChildren()` its own body, `importNode` the children in, then `namespaceSection(sectionEl, prefixFor(s.slug))`.
- Init `initCodeCopy` / `initSectionPreview` / `initSourceViewer` **once** against `.docs-root` exactly as now.
- Fragment clicks and the hover card's same-page lookups go through `resolveInPage(root, frag, prefixFor(currentSlugOfClickedSection))`.
- Keep the refs-not-deps discipline: `resolveDoc`, `onNavigate`, `onOutlineScroll` stay in refs. Adding a
  fresh function to this effect's deps tears the document down on every keystroke — that bug closed an
  open resource modal and cancelled the hover timer, and it must not come back.

- [ ] **Step 5: Run the new test plus the docs suite**

Run: `npx vitest run tests/docs-docview-sections.test.js tests/docs-client.test.js tests/docs-render-cache.test.js`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git add src/docs/components/DocView.jsx src/docs/client/sectionPreview.js src/docs/client/sourceViewer.js tests/docs-docview-sections.test.js
```

---

### Task 6: `SpecView` — the document column in Preview mode

**Files:**
- Create: `src/fabry/architect/components/SpecView.jsx`
- Modify: `src/console/console.css` (`.fabry-spec-*`)
- Test: `tests/fabry-architect-spec-view.test.js`

**Interfaces:**
- Consumes: `buildSpecSections` is NOT used here (DocView renders from `text`); uses `DocView` (Task 5), `specTarget` (Task 1), store signals (Task 4), `displayTitle` (`format.js`).
- Produces: `<SpecView />` reading `store.deliverables`; renders `.fabry-spec` = bar + `DocView`; writes `store.spyTarget` on scroll; exposes nothing else.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import * as store from '../src/fabry/architect/store.js';
import SpecView from '../src/fabry/architect/components/SpecView.jsx';

const D = [
  { id: 'd1', text: '# One\n\nalpha\n', order: 1, title: '', titleSource: '' },
  { id: 'd2', text: '# Two\n\nbeta\n', order: 2, title: '', titleSource: '' },
];
function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => { render(h(SpecView, null), root); });
  return root;
}
beforeEach(() => {
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.docView.value = 'preview';
  store.tocOpen.value = true; store.railOpen.value = true;
  store.pinnedTarget.value = null; store.spyTarget.value = null;
});

describe('SpecView', () => {
  it('offers a two-way mode switch and no combined mode', () => {
    const labels = [...mount().querySelectorAll('.fabry-spec-modes button')].map((b) => b.textContent);
    expect(labels.length).toBe(2);
    expect(labels.join(' ')).toMatch(/Edit/);
    expect(labels.join(' ')).toMatch(/Preview/);
    expect(labels.join(' ')).not.toMatch(/Editor and Preview/);
  });

  it('switching mode changes the mode signal, nothing else', () => {
    const root = mount();
    const before = root.querySelectorAll('.fabry-spec-sec-hd').length;
    act(() => { [...root.querySelectorAll('.fabry-spec-modes button')].find((b) => /Edit/.test(b.textContent)).click(); });
    expect(store.docView.value).toBe('edit');
    expect(root.querySelectorAll('.fabry-spec-sec-hd').length).toBe(before);
  });

  it('renders a sticky header per deliverable carrying identity and status only — no action buttons', async () => {
    const root = mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.fabry-spec-sec-hd').length).toBe(2));
    expect(root.querySelector('.fabry-spec-sec-hd').querySelectorAll('button').length).toBe(0);
  });

  it('collapse toggles drive the persisted prefs', () => {
    const root = mount();
    act(() => { root.querySelector('[data-act="toggle-toc"]').click(); });
    expect(store.tocOpen.value).toBe(false);
    act(() => { root.querySelector('[data-act="toggle-rail"]').click(); });
    expect(store.railOpen.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found).**

- [ ] **Step 3: Implement `SpecView.jsx`**

Structure (fill in with the store/format imports the other architect components already use):

```jsx
export default function SpecView() {
  const ds = store.deliverables.value;
  const mode = store.docView.value;
  const sections = ds.map((d) => ({ id: d.id, slug: slugFor(d), text: d.text || '' }));
  return (
    <div class="fabry-spec">
      <div class="fabry-spec-bar">
        <span class="fabry-spec-lbl">Specification</span>
        <div class="fabry-spec-modes" role="group" aria-label="Text mode">
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => store.setDocView('edit')}>{'✎ Edit'}</button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => store.setDocView('preview')}>{'◑ Preview'}</button>
        </div>
        <span class="fabry-spec-sp" />
        <button type="button" data-act="toggle-toc" onClick={() => store.setTocOpen(!store.tocOpen.value)}>…</button>
        <button type="button" data-act="toggle-rail" onClick={() => store.setRailOpen(!store.railOpen.value)}>…</button>
      </div>
      {mode === 'preview'
        ? <DocView sections={sections} headerFor={(s) => <SectionHeader deliverable={byId(ds, s.id)} />} onScroll={onScroll} />
        : <SourceColumn deliverables={ds} headerFor={…} onScroll={onScroll} />}
    </div>
  );
}
```

- `slugFor` uses `assignSlugs(ds, displayTitle)` once per render, memoized on the id+title list.
- `SectionHeader` renders title, state pill, verdict pill, stale marker — **no buttons** (spec §4.4);
  clicking the header calls `store.setSpyTarget(id)` and, if a pin is set, moves it.
- `onScroll` reads each section's `offsetTop`, hands them to `currentSection`, and writes
  `store.setSpyTarget(...)`; it also computes `activeHeadingAt` and calls `store.setActiveHeading`.
  Throttle with `requestAnimationFrame`, passive listener.

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Add the CSS** — `.fabry-spec`, `.fabry-spec-bar`, `.fabry-spec-modes` (reuse
  `.fabry-arch-viewtoggle`'s look), `.fabry-spec-sec-hd` (`position: sticky; top: 0`), pills reusing
  the existing `--success-bg`/`--warning-bg`/`--danger-bg` sets. Copy the class structure from the
  approved mockup, which was measured in a browser.

- [ ] **Step 6: Stage**

```bash
git add src/fabry/architect/components/SpecView.jsx src/console/console.css tests/fabry-architect-spec-view.test.js
```

---

### Task 7: Edit mode — source per section, one live editor at a time

**Files:**
- Modify: `src/fabry/architect/components/SpecView.jsx` (add `SourceColumn`)
- Test: `tests/fabry-architect-spec-edit.test.js`

**Interfaces:**
- Consumes: `MarkdownEditor` (`components/MarkdownEditor.jsx`), `updateDeliverable` (`actions.js`).
- Produces: `SourceColumn` rendering `section[data-deliverable] > (header + .fabry-spec-src)`, where the focused section hosts `MarkdownEditor` and the rest are static `<pre>`.

**Why one live editor:** measured (spec F5) — CodeMirror renders 52 of 600 lines, so a live editor
hides its text from the browser's find. Static `<pre>` keeps the rest of the specification in the DOM,
and an author edits one section at a time anyway.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('../src/fabry/architect/components/MarkdownEditor.jsx', () => ({
  default: ({ value, onChange }) => h('textarea', { class: 'md-mock', value, onInput: (e) => onChange && onChange(e.currentTarget.value) }),
}));
vi.mock('../src/fabry/architect/actions.js', () => ({ updateDeliverable: vi.fn(), loadRevisions: vi.fn(), openRevision: vi.fn(), ensureRevisionText: vi.fn(), restoreRevision: vi.fn(), reRun: vi.fn(), stopRun: vi.fn(), refineTurn: vi.fn(), answerRefine: vi.fn(), renameDeliverable: vi.fn(), reImplement: vi.fn(), stopImplement: vi.fn(), deleteDeliverable: vi.fn(), addDeliverable: vi.fn(), moveDeliverable: vi.fn(), openDeliverable: vi.fn() }));
import * as store from '../src/fabry/architect/store.js';
import * as actions from '../src/fabry/architect/actions.js';
import SpecView from '../src/fabry/architect/components/SpecView.jsx';

const D = [{ id: 'd1', text: '# One\n\nalpha\n', order: 1 }, { id: 'd2', text: '# Two\n\nbeta\n', order: 2 }];
function mount() { const r = document.createElement('div'); document.body.appendChild(r); act(() => { render(h(SpecView, null), r); }); return r; }
beforeEach(() => { document.body.innerHTML = ''; store.deliverables.value = D; store.docView.value = 'edit'; vi.clearAllMocks(); });

describe('edit mode', () => {
  it('shows every deliverable source at once, as text', () => {
    const root = mount();
    expect(root.querySelectorAll('.fabry-spec-src').length).toBe(2);
    expect(root.textContent).toMatch(/alpha/);
    expect(root.textContent).toMatch(/beta/);          // the other sections stay findable
    expect(root.querySelectorAll('.md-mock').length).toBe(0);
  });

  it('mounts a live editor only in the section you focus', () => {
    const root = mount();
    act(() => { root.querySelectorAll('.fabry-spec-src')[1].click(); });
    expect(root.querySelectorAll('.md-mock').length).toBe(1);
    expect(root.querySelectorAll('section')[1].querySelector('.md-mock')).toBeTruthy();
  });

  it('saves through the same action the pane used, so version capture is unchanged', () => {
    const root = mount();
    act(() => { root.querySelectorAll('.fabry-spec-src')[0].click(); });
    const ta = root.querySelector('.md-mock');
    act(() => { ta.value = '# One\n\nedited\n'; ta.dispatchEvent(new window.Event('input', { bubbles: true })); });
    act(() => { root.querySelectorAll('.fabry-spec-src, .md-mock')[0].blur(); });
    return vi.waitFor(() => expect(actions.updateDeliverable).toHaveBeenCalledWith('d1', '# One\n\nedited\n'));
  });

  it('keeps the same chrome as preview mode', () => {
    const edit = mount().querySelectorAll('.fabry-spec-sec-hd').length;
    store.docView.value = 'preview';
    document.body.innerHTML = '';
    expect(mount().querySelectorAll('.fabry-spec-sec-hd').length).toBe(edit);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `SourceColumn`**

- Each section: the same `SectionHeader`, then either `<pre class="fabry-spec-src">{text}</pre>` or,
  when `focused === d.id`, `<MarkdownEditor value={d.text} onChange={…} />`.
- `onChange` debounces 600ms into `updateDeliverable(id, text)` — the same action, so per-session
  version capture and the stale-result marking keep working with no changes.
- Leaving a section (focus moves, or another section is clicked) **flushes** the pending timer
  immediately, exactly as `DeliverableEditor`'s unmount path did. Losing an edit here would be the
  worst possible regression.
- `<pre>` gets `tabindex="0"` so a keyboard user can focus a section to edit it.

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Stage**

```bash
git add src/fabry/architect/components/SpecView.jsx tests/fabry-architect-spec-edit.test.js
```

---

### Task 8: `InspectorRail` + sidebar as navigation + wire it all up, delete the pane

**Files:**
- Create: `src/fabry/architect/components/InspectorRail.jsx`
- Modify: `src/fabry/architect/components/ArchitectSidebar.jsx`, `components/ArchitectApp.jsx`, `src/console/console.css`
- Delete: `src/fabry/architect/components/DeliverableEditor.jsx`
- Test: `tests/fabry-architect-rail.test.js`; update `tests/fabry-architect-app.test.js`, `tests/fabry-architect-implement-panel.test.js`, `tests/fabry-architect-sidebar.test.js`

**Interfaces:**
- Consumes: `railTarget` (Task 1), store signals (Task 4), `HistoryPanel`, `RefineDock`, `StateControl`, `ImplementPanel` markup from the deleted pane.
- Produces: `<InspectorRail />` with `.fabry-rail`, tabs `[check|refine|implement|history]`, header showing the target and a pin button.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('../src/fabry/architect/actions.js', () => ({ reRun: vi.fn(), stopRun: vi.fn(), loadRevisions: vi.fn(), openRevision: vi.fn(), ensureRevisionText: vi.fn(), restoreRevision: vi.fn(), refineTurn: vi.fn(), answerRefine: vi.fn(), updateDeliverable: vi.fn(), setDeliverableState: vi.fn(), reImplement: vi.fn(), stopImplement: vi.fn(), renameDeliverable: vi.fn() }));
import * as store from '../src/fabry/architect/store.js';
import InspectorRail from '../src/fabry/architect/components/InspectorRail.jsx';

const D = [{ id: 'd1', text: '# One', order: 1 }, { id: 'd2', text: '# Two', order: 2 }];
function mount() { const r = document.createElement('div'); document.body.appendChild(r); act(() => { render(h(InspectorRail, null), r); }); return r; }
beforeEach(() => {
  document.body.innerHTML = '';
  store.deliverables.value = D;
  store.results.value = { d1: { verdict: 'pass', evidence: 'ok', stale: false }, d2: { verdict: 'fail', evidence: 'no rule', stale: false } };
  store.spyTarget.value = 'd1'; store.pinnedTarget.value = null; store.railOpen.value = true;
});

describe('InspectorRail', () => {
  it('names the deliverable it is inspecting and follows the scroll', () => {
    const root = mount();
    expect(root.querySelector('.fabry-rail-name').textContent).toMatch(/One/);
    act(() => { store.spyTarget.value = 'd2'; });
    expect(root.querySelector('.fabry-rail-name').textContent).toMatch(/Two/);
  });

  it('pinning stops it following, and says so', () => {
    const root = mount();
    act(() => { root.querySelector('.fabry-rail-pin').click(); });
    expect(store.pinnedTarget.value).toBe('d1');
    act(() => { store.spyTarget.value = 'd2'; });
    expect(root.querySelector('.fabry-rail-name').textContent).toMatch(/One/);
    expect(root.querySelector('.fabry-rail-for').textContent).toMatch(/Pinned/i);
  });

  it('HOLDS the target while a check runs for the shown deliverable', () => {
    const root = mount();
    act(() => { store.setResult('d1', { verdict: null, running: true }); });
    act(() => { store.spyTarget.value = 'd2'; });
    expect(root.querySelector('.fabry-rail-name').textContent).toMatch(/One/);
    expect(root.querySelector('.fabry-rail-held')).toBeTruthy();
  });

  it('shows the verdict for the target, and offers the four tabs', () => {
    const root = mount();
    expect(root.textContent).toMatch(/Met/);
    expect(root.querySelectorAll('.fabry-rail-tab').length).toBe(4);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `InspectorRail`**

- `const target = railTarget({ spy: store.spyTarget.value, pinned: store.pinnedTarget.value, running: runningId(), shown: lastShown })` where `runningId()` is the id whose `store.results[id].running` or implement status is active; keep `lastShown` in a ref so `shown` is meaningful.
- Header: `.fabry-rail-for` ("Inspecting" / "Pinned to"), `.fabry-rail-name`, `StateControl`, verdict pill, `.fabry-rail-held` badge when held, `.fabry-rail-pin` button.
- Tabs render the panels lifted verbatim from the deleted pane: the Check body (verdict + evidence +
  Re-run + View investigation), `RefineDock`, the Implement panel, `HistoryPanel` — all keyed by the
  target id so switching target remounts them.
- Refine and History each get `⤢ Open at document width`, which sets a new signal
  `store.reviewTarget = { id, kind }`; `SpecView` renders that diff above the section and clears it on
  Escape or Close.

- [ ] **Step 4: Rewrite `ArchitectSidebar` as the navigation tree**

Every deliverable in `order`, verdict dot, headings nested via `extractOutline`, active entry from
`store.activeHeading`. Clicking scrolls (`store.navigateOutline`). Keep the row kebab (rename /
delete), the drag handle (reorder), and the footer's `+ Add` / `▷ Run all` / PDF — they have no other
home.

- [ ] **Step 5: Rewire `ArchitectApp`, delete the pane**

```jsx
<div class="fabry-arch">
  {legacy ? <LegacyNotice … /> : null}
  {ds.length ? <SpecView /> : <Placeholder … />}
  {store.railOpen.value && ds.length ? <InspectorRail /> : null}
</div>
```

Then `rm src/fabry/architect/components/DeliverableEditor.jsx`, and update the three existing test
files that mount it: `fabry-architect-app.test.js` (drop the three-way-switch and split-ratio cases,
keep the legacy-notice cases), `fabry-architect-implement-panel.test.js` (mount `InspectorRail`
instead of the pane; the console-height/drag cases go — there is no console), and
`fabry-architect-sidebar.test.js` (navigation assertions).

- [ ] **Step 6: Run the full suite — it must be green**

Run: `npm test`
Expected: 0 failures. Any test asserting a bottom console or a three-way switch is asserting a
removed feature; delete that case rather than keeping the feature alive.

- [ ] **Step 7: Stage**

```bash
git add -A
```

---

### Task 9: Rebuild and verify the real thing in the headless browser

**Files:** none changed unless a defect is found (then fix and re-verify).

**Interfaces:** none.

**This task is required, not optional** (owner: "keep reviewing it in the HEADLESS agent browser").
jsdom cannot see any of it.

- [ ] **Step 1: Build**

Run: `npm run build` — expect a clean build.

- [ ] **Step 2: Bundle a harness that mounts the REAL components**

The recipe, proven in this repo: write the harness into the scratchpad, symlink the repo's
`node_modules` beside it so bare imports resolve, bundle IIFE (a `file://` page cannot load ES
modules), and link the built stylesheets by absolute path.

```bash
SP=<scratchpad>; ln -sfn "$PWD/node_modules" "$SP/node_modules"
cat > "$SP/spec-entry.jsx" <<'EOF'
import { h, render } from 'preact';
import * as store from '/ABS/PATH/src/fabry/architect/store.js';
import SpecView from '/ABS/PATH/src/fabry/architect/components/SpecView.jsx';
import InspectorRail from '/ABS/PATH/src/fabry/architect/components/InspectorRail.jsx';
store.deliverables.value = [/* four fake deliverables, ~40 lines each, NO customer content */];
store.results.value = { /* one pass, one fail, one uncertain, one absent */ };
render(h('div', { class: 'fabry-arch' }, h(SpecView, null), h(InspectorRail, null)), document.getElementById('app'));
window.__ready = true;
EOF
npx esbuild "$SP/spec-entry.jsx" --bundle --format=iife --jsx-factory=h --jsx-fragment=Fragment --outfile="$SP/spec.js"
```

The harness HTML links `dist/console/console.base.css`, `console.css`, `github-markdown.css`,
`hljs-github.css`, `doc-theme.css` — **base first**, exactly as `console.html` does. Linking only
`console.css` (the CSS-Modules bundle) yields a void measurement.

- [ ] **Step 3: Measure it against the approved mockup**

Run `agent-browser open "file://$SP/spec.html"` then one `eval` returning JSON for:

| Claim | Expected |
|---|---|
| sections rendered | 4, in `order` |
| every deliverable's text present in the DOM | true (this is spec F3 — Cmd+F depends on it) |
| namespaced ids | no duplicate `id` anywhere on the page |
| column width, both columns open / list hidden / neither | ~664 / ~908 / ~1230 at a 1280px window (spec F9) |
| chrome equality between modes | section-header count, rail tab count and column width identical in `edit` and `preview` |
| scroll spy | scrolling to the last section moves `.fabry-rail-name` to that deliverable |
| held during a run | with `results[shown].running = true`, scrolling leaves the name unchanged and `.fabry-rail-held` present |
| nothing overflows | `document.documentElement.scrollWidth <= innerWidth + 1` |

Use **fresh identifiers in every `eval`** — the eval scope persists across calls in one session and a
re-`const` throws.

- [ ] **Step 4: Check both themes**

`agent-browser set media dark` + `reload`, then assert `matchMedia('(prefers-color-scheme: dark)').matches`
is true before trusting anything, and that the document's background and text luminance differ by > 90.

- [ ] **Step 5: Fix whatever the measurements contradict, re-measure, then stage**

```bash
rm -f "$SP/node_modules"; git add -A
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-08-19-architect-unified-specification-view-design.md`

- [ ] **Step 1: Update CLAUDE.md**

In the Fabry Architect section: the unified view replaces the per-deliverable pane; the sidebar is
navigation; the rail is the per-deliverable inspector (following scroll, held during a run, pinnable);
`docView` is two-way with the `split`→`preview` migration; **Cmd+F is a Preview-mode guarantee** with
the measured 600→52 line fact; ids are namespaced per deliverable with the measured collision as the
reason; `specDocument.js` is shared with the print path. Storage keys: add `fabryArchTocOpen` /
`fabryArchRailOpen`, mark `fabryArchSplitRatio` and `fabryArchConsoleHeight` orphaned.

- [ ] **Step 2: Add a revision note to the spec**

Record the one design correction made during implementation: authored hrefs are **not** rewritten
(§4.2 said they were), because prefixing `#2.1` would defeat the forgiving fragment matching — ids
move, hrefs stay, and `resolveInPage` reconciles them.

- [ ] **Step 3: Full suite + build, then stage**

```bash
npm test && npm run build && git add -A
```

- [ ] **Step 4: Tell the owner** the work is staged and uncommitted, that `dist/` was rebuilt so the
extension needs a reload, and that F4 (whether find-in-page scrolls the nested scroller) is settled by
one Cmd+F in the real build.

---

## Self-review

**Spec coverage:** §3 layout → Tasks 6, 8. §4.1 assembler → Task 3. §4.2 namespacing → Tasks 2, 5.
§4.3 text mode → Tasks 4, 6, 7. §4.4 header → Task 6. §4.5 targeting → Tasks 1, 8. §5 sidebar →
Task 8. §6 rail → Task 8. §7 storage → Task 4. §8 modules → Tasks 3–8. §9 performance → Task 5
(cache reuse) + Task 9 (measured). §10 testing → every task, plus Task 9 for what jsdom cannot see.
§11 limits → Task 10 documents them.

**Type consistency:** `sections: [{id, slug, text}]` is what Task 5's `DocView` takes and what Task 6
passes. `buildSpecSections` returns `{id, slug, title, showTitle, state, stateDate, verdict, bodyHtml}`
— consumed only by `printDoc` (Task 3); `SpecView` deliberately renders from `text` through the render
cache instead, which is why it does not call the assembler. `railTarget({spy, pinned, running, shown})`
is used with exactly those four keys in Task 8. `prefixFor(slug)` produces the `slug--` form asserted
in Tasks 2 and 5 and measured in Task 9.

**Placeholders:** none — every code step carries real code, and the two component tasks name the exact
classes their tests query.
