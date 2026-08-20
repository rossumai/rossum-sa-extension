# Porting localpages into Fabry's Architect

Design, 2026-08-17. Upstream pin: **`localpages@4d43f26`** ("feat: section state labels",
clean tree, `git pull --ff-only` → already up to date).

## 1. What this is

[localpages](https://github.com/mrtnzlml/localpages) is a Node CLI that previews a directory of
Markdown files the way github.com renders them, and exports them as a self-contained HTML ZIP.
Its `src/` + `bin/` is 2,240 lines. This spec ports its **document rendering, reading and export**
into the Fabry Architect's deliverable pane, where a deliverable is one Markdown document.

The honest headline: **11 of localpages' 14 documented features port, 1 partially, 2 are dropped.**
Everything filesystem- or server-shaped (HTTP server, SSE live reload, `fs.watch`, git-rooted
source scoping, the CLI) has no destination. Section 7 is the exhaustive divergence ledger; it is
part of the deliverable, not an apology.

## 2. Decisions, and the fact behind each

Each of these was ruled by the owner after the stated measurement.

| # | Decision | Grounding |
|---|---|---|
| D1 | Reading surface lives **in the Architect's Preview pane**, not a dedicated viewer page | Owner's call. Costs: the four `client/*.js` behaviours must be re-rooted (CSP forbids inline scripts on extension pages — measured), and every viewport-based CSS rule must become container-based (§5) |
| D2 | **Deliverables only** — no local-folder mode | Owner's call. `showDirectoryPicker`/`FileSystemDirectoryHandle` were verified present in Chrome 150 but go unused; the source-file viewer, asset copying and `security.mjs` lose their subject |
| D3 | Document **follows the Console's light/dark theme** | `github-markdown.css` (auto) computes **identically** to the `github-markdown-light.css` upstream ships — verified across 19 elements × 14 properties under a light OS scheme. Its dark branch yields GitHub's real palette (`#f0f6fc` on `#0d1117`, `pre` `#151b23`) |
| D4 | **Curated highlight.js**: core + 11 grammars | 61,596 B measured, vs 1,080,512 B for the full set. `markdown` is mandatory: `state-labels.test.mjs:168` asserts a ```` ```markdown ```` fence produces nested spans |
| D5 | Source-file modal **re-aimed at Rossum API resources** | No filesystem (D2). Host permissions already cover every Rossum host; the modal markup, Copy/Esc/click-outside behaviour and the offline `<template>` mechanism all survive |
| D6 | Geometry via **container-query translation** | Verified in Chrome 150: `container-type: inline-size` + `100cqw` + `@container` all supported, the branch fires off the *pane* width, and inline-size containment does not break the pane's vertical scrolling (`scrollHeight` 1236 in a 300px pane) |
| D7 | Export filenames are the **slug of the deliverable title**; `[x](slug.md)` → `slug.html` | Keeps `render.mjs`'s `link_open` rewrite *and* its linkify `bogus http://foo.md` fixup verbatim, plus `buildDocsNav`'s active-tab logic |
| D8 | Images: **inline Rossum-hosted as `data:`, leave other hosts remote** | Cross-origin fetch beyond `host_permissions` is unavailable, and adding hosts would disable every existing install until each user re-approves |
| D9 | Raw HTML: **`html: true` + a DOMParser element/attribute allowlist** before adoption | Verified: `html:true` passes `<script>`, `<img onerror>`, `<iframe>`, `<form>` verbatim. Deliverable `text` has four writers — the SA, the *agent* (`RefineDock.jsx:72` `accept()` writes the refine proposal straight in), any org-token holder writing the Data Storage collection, and the extension's own MDH record editor (nothing filters `__`-prefixed collections). The exported HTML carries **no CSP at all** |
| D10 | `index.html` in the ZIP is a **generated contents page** | Deliverables have no authored landing document, and the README's "unzip and double-click `index.html`" promise must hold. Explicitly additive over upstream |
| D11 | Split view **scroll-syncs**, one-way editor → preview | Owner's call |

## 3. Upstream pin and file-by-file deltas

Ported code lives in `src/docs/` — its own npm dependencies and its own stylesheet make it a
subsystem rather than a `src/ui/` component, and keeping it in one directory keeps the diff
against upstream checkable.

The pin is per-file, so a later upstream change can be diffed rather than guessed at. Blob sha1s
at `4d43f26` (reproduce with `git hash-object <file>` in the localpages checkout):

```
render.mjs            489e201991ee9b446863d5ecf0fcbcdb3ebb1beb
state-labels.mjs      39a88847225d94c3dca11e994fddbd8c161885d4
page.mjs              625a998875e90b9786cb6ae6b8a458875502694b
export.mjs            cba2bd15dd4e96e2754d0cef5f3d2c13f825b1bd
theme.css             38155513d377a27f3f6d582cbc1c3a42b0843516
client/toc.js         3c97712d4ccfb8b137b901022d506a5932074734
client/code-copy.js   b27cfbac13a48d1c915a183a9a7f8acaa66ecb2c
client/section-preview.js  dc90a3fbf935ba487f4822d70660052c4d549dd0
client/source-viewer.js    485f1b4e72fd39a427858a113ed4299af98356cd
```

Not ported, recorded for completeness: `client/reload.js` `aa8e030`, `zip.mjs` `0eb3c4e`,
`security.mjs` `68559f6`, `constants.mjs` `ba47338`, `index.mjs` `e0703fe`, `server.mjs` `649953e`,
`bin/localpages.mjs` `f3c70aa`.

| Upstream (`4d43f26`) | LOC | Ported to | Delta |
|---|---|---|---|
| `src/state-labels.mjs` | 234 | `src/docs/stateLabels.js` | **Byte-identical** but the filename. Pure markdown-it plugin: no Node, no DOM |
| `src/render.mjs` | 124 | `src/docs/render.js` | `createMarkdownRenderer({ mermaid, hljs })` takes injected deps (upstream imports them); mermaid comes from the existing lazy loader; hljs is core+11; one new `env.syncLines` branch stamps `data-src-line` (live only, never on export). `highlight()`, `wrapStandaloneImages`, `highlightTodoInSvg`, `slugify`, the alerts→anchor→stateLabels order, `disable('replacements')` and the whole `link_open` rule: **verbatim** |
| `src/page.mjs` | 120 | `src/docs/page.js` | Export-only. `fs.readFileSync` of 3 CSS + 5 scripts → an injected `assets` param; the two live-only branches (`reloadScript`, `downloadLink`) removed — upstream's own export tests assert both absent, so export output is unchanged. `escHtml`, `buildDocsNav`, `sourceModalHtml`, the `<!doctype>` template: **verbatim** |
| `src/export.mjs` | 142 | `src/docs/docExport.js` | `listDocs` → deliverables by `order`, slugged; `collectFiles` **dropped**; `collectSourceRefs` re-aimed at Rossum API URLs; `highlightSourceFile` → resource JSON; `buildExportBundle` iterates deliverables and calls the new `makeZip`. `renderMarkdownForExport`'s shape kept |
| `src/theme.css` | 577 | `src/docs/theme.css` | Four mechanical deltas (§5) plus an added dark branch. Every value in the light branch **verbatim** |
| `src/client/toc.js` | 67 | `src/docs/client/toc.js` | Becomes `init(root, scroller)`: `document.`→`root.`, `window.scrollY`→`scroller.scrollTop`, `body.prepend(nav)`→`root.prepend(nav)`. Title-stripping, state-dot mirroring, active detection, the `beforeprint`/`afterprint` guard and `history.replaceState`: **verbatim** |
| `src/client/code-copy.js` | 51 | `src/docs/client/codeCopy.js` | Query root only |
| `src/client/section-preview.js` | 155 | `src/docs/client/sectionPreview.js` | Positioning moves from page coordinates to `position: fixed` viewport coordinates. `HOVER_DELAY_MS` 280, `HIDE_DELAY_MS` 160, `MAX_BLOCKS` 8, Escape, scroll-dismiss-unless-hovered, "Jump to section ↗": **verbatim** |
| `src/client/source-viewer.js` | 127 | `src/docs/client/sourceViewer.js` | Resolver only: `/__source?path=` → Rossum API fetch. The `<template data-source-path>` offline path, modal ids, Copy flash, `.source-link` marking: **verbatim** |
| `src/client/reload.js` | 25 | — | **Dropped**: no server to reconnect to; the preview re-renders per keystroke |
| `src/zip.mjs` | 103 | — | **Dropped**: `src/mdh/xlsxWrite.js` already exports `crc32`, `crc32Update`, `localHeader`, `dataDescriptor`, `centralHeader`, `eocd` (verified). A ~30-line generic `makeZip(entries)` composes them, keeping one CRC table in the bundle |
| `src/security.mjs` | 62 | — | **Dropped**: no filesystem. Replaced by an origin+path check for the resource modal |
| `src/constants.mjs` | 26 | partial | `SOURCE_EXTS`/`EXT_TO_LANG`/`MIME` served the source viewer and the static route |
| `src/index.mjs`, `src/server.mjs`, `bin/` | 427 | — | **Dropped**: CLI, HTTP, SSE, `fs.watch`, 404 page |

New, with no upstream counterpart:

| Module | ~LOC | Purpose |
|---|---|---|
| `src/docs/sanitize.js` | 90 | D9 allowlist over the parsed tree |
| `src/docs/slug.js` | 15 | Title → filename slug, collision-suffixed |
| `src/docs/resources.js` | 60 | Rossum API URL detection, org-origin scope check, resource fetch |
| `src/docs/syncScroll.js` | 60 | **Pure** line↔anchor mapping for D11 |
| `src/docs/components/DocView.jsx` | 80 | Renders, sanitizes, adopts, and runs the four behaviours |
| `src/docs/exportClient.js` | 20 | esbuild entry bundling the four behaviours for inlining into exported pages |
| `src/docs/contents.js` | 40 | The generated `index.html` contents page (D10) |

One extraction, not new code: `scrollerFor(view, container)` moves from `JsonEditor.jsx:71` (where
it is module-private) to `src/ui/scrollerFor.js`, imported by MDH and by scroll sync — see §5.

## 4. Render pipeline

```
text → md.render(text, env) → wrapStandaloneImages → sanitize → DOMParser → importNode → pane
                                                        ↓
                                              same string → export HTML
```

The **same sanitized output** feeds both the pane and the ZIP, so a mailed bundle can carry no
injected markup.

**Sanitizer (D9).** An **allowlist**, not a denylist — markdown-it's output plus the raw-HTML
constructs localpages documents (`<state-label>`, `<details>`/`<summary>`, `<mark>`,
`<div class="wide">`) is a finite, enumerable set, so there is no reason to accept the weaker
policy. Three rules, and each exists because of something the port actually renders:

1. **Allowed elements**: `p`, `h1`–`h6`, `a`, `em`, `strong`, `s`, `del`, `code`, `pre`,
   `blockquote`, `ul`, `ol`, `li`, `hr`, `br`, `img`, `table`, `thead`, `tbody`, `tr`, `th`, `td`,
   `figure`, `figcaption` (markdown-it's own output, `wrapStandaloneImages` included), plus
   `details`, `summary`, `mark`, `div`, `span`, `kbd`, `sup`, `sub`, `abbr`, `dl`, `dt`, `dd`.
   **Allowed attributes** are `class`, `id`, `href`, `src`,
   `alt`, `title`, `align`, `colspan`, `rowspan`, `open`, `start`, `type`, and any `data-*` or
   `aria-*` (which is what lets `data-state`, `data-src-line` and `data-source-path` through).
   Never `on*`, in any position.
2. **An element that is neither allowed nor dangerous is unwrapped, not deleted** — its children
   survive in place. Deleting subtrees would silently swallow prose, which is the failure mode this
   port can least afford; unwrapping degrades unexpected markup to its text content. The hard-delete
   set is only `script`, `iframe`, `object`, `embed`, `form`, `input`, `textarea`, `select`, `link`,
   `meta`, `base`, and a top-level `style` — elements whose *children* are not prose.
3. **Inside an `<svg>` subtree everything is allowed except `on*` attributes, `<script>` and
   `javascript:` URLs.** This is what keeps `render.mjs`'s fence override verbatim: mermaid emits an
   SVG containing its own `<style>`, into which `highlightTodoInSvg` injects the `.todo-hl` rule, and
   every state-label badge is an inline SVG icon with `stroke-dasharray`/`paint-order`/`tspan`
   geometry. Enumerating mermaid's SVG attribute surface would be a fragile allowlist over
   machine-generated markup; the subtree is safe by construction instead, since both producers are
   ours (and `beautiful-mermaid` escapes label text itself — probe-verified, per CLAUDE.md).

URL policy: `href` must be `http(s):`, a `#fragment`, or a relative `.html`; `src` must be
`http(s):` or `data:image/*` (D8 needs the latter).

**Mermaid.** When the document contains a mermaid fence, the render awaits `loadMermaidRenderer()`
before first paint, so the first frame already contains SVGs instead of flashing code fences; the
existing shimmer covers the wait. `beautiful-mermaid` is already a dependency at the **same
version in both repos (1.1.3)**, in its own 1.56MB lazy bundle, which this port does not enlarge.
Palette: upstream's exact hexes (`#ffffff`/`#1f2328`/`#0969da`/`#656d76`/`#f6f8fa`/`#d0d7de`) in
light, a new set in dark (D3).

**highlight.js (D4).** Core plus `python, json, javascript, bash, sql, xml, yaml, markdown, css,
ini, diff`. `highlight()`'s body is verbatim, so the only divergence is which grammars are
registered; `json5` still maps to `javascript` as upstream does.

**Diagnostics.** `reportStateLabelWarnings(env, file, emit)` is untouched; `emit` feeds a warnings
strip under the pane toolbar with the deliverable title as `file`, so
`Architecture:75 <state-label> has an unknown state "staale"` still reaches a human who has no
terminal. Mermaid render failures join the same strip; upstream's `console.error` stays.

## 5. The pane

**What the live pane renders, and what only the export renders.** Upstream's page has a sticky
`.docs-nav` listing every document, with a "Download ZIP" link at its right. In-pane that list
would duplicate the Fabry sidebar, which already *is* the deliverable list, and would spend
vertical space to do it — so **the live pane renders no `.docs-nav`**, and `Download ZIP` moves to
the pane toolbar beside the view switch. The **export still renders the nav verbatim**: a standalone
bundle has no sidebar, and two upstream assertions pin its markup. `scroll-padding-top: 52px`
therefore applies only in the export, where the sticky bar it compensates for exists.

`.markdown-body`'s own box is kept verbatim — `max-width: 980px; margin: 0 auto; padding: 45px` —
so a wide pane reproduces upstream's column exactly and a narrow one falls to `padding: 15px`
through the ported 767px branch (now container-based, §5 *Geometry*).

**Three-way view switch.** `.fabry-arch-viewtoggle` grows from two buttons to **Editor / Editor
and Preview / Preview**, keeping `aria-pressed` — it is already an N-button flex group, so this
needs **no new CSS**. Split mode makes `.fabry-arch-doc-body` a horizontal flex with both children
visible and a drag divider. `docView` and `splitRatio` join `architect/store.js` as
`fabryArchDocView` / `fabryArchSplitRatio`, following `consoleHeight` exactly: live signal during
the drag, one `chrome.storage.local` write on release, boot load in a `try/catch` so tests without
`chrome` are unaffected. `MarkdownEditor.refresh()` fires whenever the editor becomes visible or
the divider settles, because CodeMirror mis-measures when revealed from `display: none`.

One deliberate behaviour change: `view` currently resets to `'edit'` on every deliverable switch
(`DeliverableEditor.jsx:45`). A chosen mode should outlive a switch, so it persists instead.

**Scroll sync (D11), and the trap it walks into.** Measured in a real CodeMirror harness against
the shipping CSS: `.fabry-arch-source` owns a **14,002px** scroll range while `.fabry-arch-md`,
`.cm-editor` *and* `.cm-scroller` all have range **0** — `.cm-editor`'s computed height came out
`14402px`, so `height: 100%` (console.css:4715) never resolves against a host div with no height
and the editor is fully expanded inside the outer scroller. **Writing `view.scrollDOM.scrollTop`
does nothing**, the same failure CLAUDE.md records for the MDH editor. Sync therefore resolves the
scroller by largest scroll range — the heuristic `JsonEditor.jsx:71` already implements as
`scrollerFor(view, container)`, which is **module-private**, so it is lifted to
`src/ui/scrollerFor.js` and imported by both. A second hand-rolled copy of a subtle,
measurement-derived scroll-container heuristic is precisely the kind of duplicate that drifts; the
move is pure and pinned by MDH's existing tests.

Mechanism: `env.syncLines` stamps `data-src-line` on top-level blocks from markdown-it's token
`.map` (live render only — the export renders without it, so §8's golden-file equivalence stays
byte-exact). On editor scroll, the top visible source line maps to the last anchor at or before
it, interpolated toward the next, and `preview.scrollTop` is written **directly, untweened** —
it tracks a drag, so easing would lag. Active only in split mode. The math lives in the pure,
unit-tested `syncScroll.js`; the wiring is browser-verified, following the `stageLink.js` /
`smoothScroll.js` / `tether.js` precedent for geometry jsdom cannot see.

**Geometry translation (D6).** Four mechanical deltas in `theme.css`:

1. Globals scoped to `.docs-root`: `:root{color-scheme:light}`, `html{scroll-padding-top:52px}`,
   `html,body{overscroll-behavior-y:none;margin:0;background:#fff}` would otherwise repaint the
   whole Console.
2. `.toc` `position: fixed; left: 0` → absolute inside the pane. Upstream anchors the TOC to the
   window's left edge; in-pane that would overlay the app rail and the Fabry sidebar.
3. `100vw` → `100cqw` (the `.wide` breakout's `calc(100vw - 32px)` and `calc(100vw - 472px)`),
   and `.toc`'s `calc(100vh - 44px)` → `100%`.
4. `@media (max-width: 1280px|767px)` → `@container` at the same thresholds.

Split mode is what makes this earn its keep: at roughly 450px the ported `@container` branch hides
the TOC and the 767px branch drops padding to 15px — upstream's own narrow-screen behaviour, now
driven by the column instead of the window.

**Theme (D3).** Ship `github-markdown.css` (auto) plus a hand-written dark branch mirroring
`theme.css`'s ~50 light values; the light values stay verbatim, so light mode is identical to
upstream and dark is a pure addition.

**Print.** Upstream's entire `@media print` block ports verbatim. *Additions* neutralize the
Console shell — app rail, Fabry sidebar, `#app{height:100vh}`, ancestor `overflow:hidden`, the
deliverable header and the action console — and force the preview column visible even in Editor
mode, so `Cmd-P` prints the document in all three view modes. There is no `@media print` anywhere
in the extension today, so none of this can regress existing print behaviour.

## 6. Export

`<slug>.html` per deliverable from `displayTitle`, plus a generated `index.html` contents page
listing every deliverable with its state tally and last check verdict (D10). The nav lists all
deliverables; `[see](architecture.md)` resolves to `architecture.html` through the verbatim
rewrite rule (D7).

Referenced Rossum resources are fetched at export time and embedded as
`<template data-source-path="…">`, so the modal works from the ZIP with no token and no network —
a faithful port of upstream's offline mechanism, with `fs.readFileSync` swapped for an API read.
Rossum-hosted images become `data:` URIs; other hosts stay remote (D8).

ZIP framing reuses `xlsxWrite.js`'s primitives; download reuses `downloadCollection.js`'s
`showSaveFilePicker` path with its Blob-anchor fallback.

**Assets are injected, not fetched.** `build.js` reads the three stylesheets and the
`doc-export-client` bundle and emits them as a generated module. This is the one place where a
runtime mechanism could have been assumed and was not: `?raw` imports return an **empty string**
under vitest (its `css: false` default stubs CSS even with the suffix), and `esbuild.buildSync`
**rejects plugins**, so `build.js` moves to async `esbuild.build()`. The injection seam is also
what makes upstream's export assertions portable.

## 7. Divergence ledger — everything that is not 1:1

**Dropped features (2 of 14).**

- **Source-file viewer**, as a *filesystem* viewer: no `--source-root`, no git toplevel, no
  `credentials.*`/`.env*`/`*.pem`/`id_rsa*` blocklist, no `.git`/`node_modules` suppression, no
  `SOURCE_EXTS`. The modal, its markup, its offline `<template>` path and its Copy/Esc behaviour
  survive, re-aimed at Rossum API resources (D5).
- **Hot reload**: no SSE, no `SERVER_ID` restart detection, no `fs.watch`. The preview is live per
  keystroke instead. Upstream's print-deferral guard in `reload.js` becomes moot; the equivalent
  guard in `toc.js` is kept.

**Partial.**

- **Static export**: pages are 1:1, but there are no non-Markdown assets to copy verbatim
  (`collectFiles` has no subject) and a bundle referencing non-Rossum images is not fully offline.

**Changed.**

- Code highlighting: fences outside the 11 grammars render as escaped plain code (D4).
- Mermaid colours in dark mode, and `theme.css`'s dark branch, have no upstream counterpart (D3).
- Content column is the pane's width, not the window's, so line lengths differ from a 980px column
  unless the pane is wide (D1/D6).
- Injected `script`/`iframe`/`form`/`on*` markup is stripped where upstream would render it (D9).
- The live pane renders **no `.docs-nav`** — the Fabry sidebar is the document list, so upstream's
  sticky tab bar would duplicate it (§5). The export renders it verbatim, so the divergence exists
  only on screen.

**No destination.** CLI and all flags (`--port`, `--open`, `--no-watch`, `--export`,
`--source-root`, `--block`, `--version`, `--help`), the HTTP server and its routes, the 404 page
with its document list, terminal logging with timing and colour.

## 8. Verification

**Ported upstream assertions** (`node:test` → vitest, import paths swapped):

| Upstream file | Assertions | Fate |
|---|---|---|
| `state-labels.test.mjs` | 25 | **All port.** Includes the byte-identical-to-a-stock-renderer test, the fenced-example test, the summary ordering/tally tests and every diagnostic |
| `render.test.mjs` | 4 | Port; the live-chrome assertions (`EventSource`, `__export.zip`) become assertions that neither appears |
| `export.test.mjs` | 3 | Port, minus the asset-copying and `sample.py` template clauses; `--state-fg: #cf222e`-is-inlined and no-`<link>`-stylesheet are kept |
| `toc.test.mjs` | 4 | DOM-construction half becomes jsdom; scroll-spy geometry moves to an agent-browser harness outside `npm test` |
| `security.test.mjs` | 7 | **Not portable** (D2). Recorded with the reason |

**Golden-file equivalence — the mechanical 1:1 proof.** `examples/basic/*.md` and expected HTML
generated by upstream localpages itself are checked into `tests/fixtures/localpages/`; the ported
pipeline must reproduce that HTML, normalizing only the two documented deltas (mermaid palette,
hljs grammar set). Regenerating the fixtures against a newer upstream is how a future localpages
change gets migrated.

**New tests.** Sanitizer allowlist, its unwrap-not-delete rule, and the `<svg>`-subtree rule
(including an SVG-internal `<style>` surviving while a top-level one does not); slug generation and
collision suffixing; `.md`→`.html` rewriting including the linkify `bogus` case; ZIP validity
(`504b0304` magic plus a walkable central directory); image-inlining scope; the three-way view
switch and its persistence; `syncScroll.js`'s pure mapping.

## 9. Build, dependencies, bundle

New dependencies: `markdown-it`, `markdown-it-github-alerts`, `markdown-it-anchor`,
`highlight.js`, `github-markdown-css`. Measured with esbuild `--bundle --minify --format=iife`:
markdown-it + both plugins + core-and-11 hljs = **219,393 B**, against `console.js`'s current
**1,794,628 B** — **+12.2%**. Verified CSP-clean: zero `new Function`, zero `eval(`, zero residual
Node `require()` — the same bar that disqualified `3d-force-graph`. No manifest change, so no
install is disabled pending re-approval.

`build.js`: async `esbuild.build()`, one new entry (`console/doc-export-client`), three stylesheets
copied to `dist/console/`, and the generated asset module.

## 10. Backward compatibility

- **`FabryMarkdown` is not touched.** Chat, Academy, MDH's empty-stage explanation and the Check
  tab's evidence keep it, so its heading shift (`#`→`h3`) and https-only link policy are unchanged.
  The new renderer is used only by the Preview pane.
- **Existing deliverables render differently, by design.** Four cases are worth naming, all of them
  consequences of rendering real GFM where a deliberate subset used to run:
  - Prose containing angle brackets (`<queue_id>`) currently displays as literal text and becomes an
    unknown element — i.e. **invisible**. The sanitizer's unwrap rule (§4, rule 2) keeps the children
    but an empty unknown tag has none, so this is a genuine content hazard, not a styling change. It
    is the port's one migration note: a pass over existing deliverables for bare `<…>` placeholders.
  - `[x](#anchor)` links currently render as literal text (`markdown.js`'s `SAFE_HREF` is
    https-only) and start working.
  - `typographer: true` (upstream's setting, with `replacements` disabled) turns straight quotes into
    curly ones. Smart quotes only — `(c)`/`(tm)` stay literal, which is why upstream disables that
    rule and this port keeps the disable.
  - `linkify: true` turns bare URLs into anchors, which today's renderer leaves as text.
- **No new storage keys carry content**: `fabryArchDocView` and `fabryArchSplitRatio` are layout
  preferences, global like `fabryArchConsoleHeight`.
- **Deliverable documents gain no fields.** Slugs derive from `displayTitle` at export time.

## 11. Open items and live gates

1. **Renaming a deliverable breaks inbound slug links** (D7). Accepted; the export reports
   unresolved links in its summary rather than failing.
2. **`<template>` embedding of Rossum resources costs one API read per referenced resource** at
   export time. Bounded by a cap and reported; no live gate needed.
3. **The `__mrfabry_architect` collection remains readable and writable through MDH** — the reason
   D9 exists. Unchanged by this port, restated so it is not rediscovered.

## 12. Non-goals

Local-folder document sources (D2), a dedicated viewer page, bidirectional scroll sync (D11 is
editor→preview only), replacing `FabryMarkdown` elsewhere, and any change to the Architect's
check, refine or implement loops.

---

## Revision v2 — as implemented (2026-08-17)

The port shipped. Everything above stands except where noted here; this section is the
record of what implementation changed, and why. All numbers are measured.

### Deltas the design did not anticipate

1. **`wrapStandaloneImages` needed a fifth delta (render.js DELTA 4).** Upstream matches a
   bare `<p>`, which stops matching the moment DELTA 3 stamps `data-src-line` on the
   paragraph — so standalone images silently lost their `<figure>` **in the live pane
   only**. The paragraph's attributes now ride onto the `<figure>`, which keeps the block
   a scroll anchor and leaves attribute-free output character-for-character upstream's.
   Caught by the equivalence suite's own syncLines test.
2. **`tabindex` was missing from the attribute allowlist**, and markdown-it-anchor puts
   `tabindex="-1"` on *every* heading — so every heading in every document would have
   differed from upstream. Caught by a test the design did not call for: sanitizing
   upstream's own rendered HTML must be a no-op. That test is now the sanitizer's primary
   guard, because a hand-written sample can only pin attributes the author thought of.
3. **Sync anchors are top-level blocks only (`token.level === 0`).** Stamping every
   block-open produced 8 anchors for 5 blocks (a `<li>`, and the `<p>` inside it), and a
   nested element resolves `offsetTop` against a different offsetParent than its
   container — the extra anchors would have been measured in the wrong coordinate space.
4. **`CSS.escape` needed the repo's jsdom guard.** Upstream calls it bare; Chrome has it,
   jsdom does not. Same treatment as the training tether's `cssEscape`.
5. **`.fabry-arch-preview` stopped scrolling and padding** (console.css): the document
   brings its own scroller (`.docs-root`) and upstream's own 45px column padding. The
   now-dead `.fabry-arch-preview` halves of FabryMarkdown.module.css's context overrides
   were removed with it.

### Two design decisions reversed by measurement

- **`scrollerFor` was NOT extracted.** The design lifted it out of `JsonEditor.jsx` for the
  sync to share. It turned out to be unnecessary: sync only ever *writes* to the preview's
  scroller (which this code owns) and reads the editor's position from the wrapper's rect
  minus `view.documentTop`, which is correct whichever element scrolls. Rather than leave
  an unused extraction in a well-tested file, `JsonEditor.jsx` is byte-identical to its
  committed version and `src/ui/scrollerFor.js` does not exist. The measurement that
  motivated it still governs the implementation — `MarkdownEditor.lineAtTop()` documents
  it, and its scroll listener subscribes to **both** candidate elements, which is cheaper
  and safer than resolving one at mount when layout has not settled.
- **`build.js` stayed synchronous.** The design moved it to async `esbuild.build()` for a
  text-import plugin. Not needed: the export's assets are written by `build.js` itself into
  `dist/console/doc-assets.js`, a registrar script the Console loads on demand
  (`src/docs/assetsLoader.js`, the mermaid-bundle pattern). `buildSync` is untouched, no
  generated file lands in `src/`, and ~70KB of CSS/JS text stays out of `console.js`.

### One honest limit on "byte-identical"

The RENDERER is byte-identical to upstream — six fixture comparisons, live and export mode
(`tests/docs-render-equivalence.test.js`). The SANITIZER cannot be: passing HTML through a
DOMParser re-serializes it, so `&#x27;` returns as `'` and `<circle/>` as
`<circle></circle>`. Semantically and visually identical; not the same bytes. The suite
therefore asserts the sanitizer changes nothing **beyond a DOM round-trip**, which is the
precise claim and still catches real stripping (it is what caught `tabindex`).

### Verified in a browser (headless, real layout)

Exported bundle, generated from upstream's own `examples/basic` documents:
`externalRequests: 0` (the offline promise holds), content column exactly **980px**, 7 TOC
entries built, 2 copy buttons, 3 alerts, 1 `<figure>` with caption, 9 highlight spans, nav
with the correct active tab, scroll-spy moving the active entry and syncing `location.hash`,
mermaid SVG rendered with its own `<style>`, and the author's `<div class="wide">` breaking
out to 1115px past the 980 column.

In-pane, against the built stylesheet: `container-type: inline-size` active, `.docs-root`
owning the scroll range, `body` left transparent so the Console keeps its own background,
the TOC `position: absolute` at **paneLeft 344 == tocLeft 344** (upstream's `fixed; left: 0`
would have put it at 0, over the rail and sidebar) at upstream's 220px width and full pane
height, and — the delta that matters most — `.wide` sized to **904px = pane(936) − 32**
where upstream's `100vw` would have given 1248 and overflowed the pane.

### Two findings for the owner, deliberately not acted on

1. **The TOC is hidden at realistic pane widths.** Upstream hides it below 1280px, and that
   threshold is the same arithmetic in a container (980 column + 220 sidebar + margins) — so
   the translation is faithful. The consequence, measured: a 1280px window leaves the pane
   936px, so the TOC never appears; it needs a window of roughly 1620px+ (pane > 1280).
   Lowering the pane's threshold is a one-line change and a deliberate divergence, so it was
   left to the owner.
2. **`beautiful-mermaid` embeds `@import url('https://fonts.googleapis.com/…Inter…')` inside
   every diagram's `<style>`.** So a rendered diagram fetches a Google font — in the pane and
   in an exported bundle, which breaks the "no external requests on open" promise. This is
   upstream's behaviour too (same library, same version) **and it is pre-existing in this
   extension**: Fabry chat already renders mermaid the same way. Stripping the `@import` is
   two lines but changes diagram typography and alters shipped behaviour, so it was left
   alone and reported instead.

---

## Revision v3 — state labels move into the Architect (2026-08-18)

Two owner reports drove this: `<section-state>` "doesn't work now", and hook
implementations (`.py`/`.json`) could not be previewed. The first turned out to be a
missing diagnostic plus a design decision; the second was a real defect.

### What was actually wrong with `<section-state>`

Verified: **`<state-label>` worked correctly** in the live pane (badge rendered, no
warnings). `section-state` is not an element localpages has ever had — upstream is still at
`4d43f26` and the string appears nowhere in it. But the port gave **no feedback at all**:
markdown-it passes an unknown tag through, the sanitizer's unwrap rule removes it, and a
browser draws an unrecognised custom element as empty space. Upstream guards typos in a
label's *attributes* (unknown state, paired form, not-after-heading) and never in its *tag
name*, which is precisely the failure its own design rationale warns about — "a browser
renders an unrecognised custom element as nothing at all, so a typo would otherwise produce
a blank space and no clue."

### The design decision, and the fact behind it

**Owner: states belong to the Architect, not the markdown; per deliverable; shown in the
deliverable header; and the in-document element leaves the pipeline.**

The granularity was not a preference — it follows from identity. A deliverable has a stable
`_id`. A heading's only identity is a slug derived from its own text, so `"3. Architecture"`
→ `3-architecture` becomes `3-architecture-scope` the moment someone appends "& Scope"
(measured). Any state stored outside the document and keyed to a heading is therefore
orphaned by ordinary editing, and reordering sections misassigns it — the worst possible
failure for a feature whose entire job is telling a reader what to trust. Upstream avoids
this by keeping the label physically beside the heading; this port avoids it by keying to
the deliverable.

### What shipped

- **`src/fabry/architect/stateLabel.js`** (pure) — upstream's five states, its reading
  order, its shape-distinct icon geometry (Ready and Verified are both green; a ring and a
  check are what distinguish them) and a one-line meaning per state so the picker teaches
  the vocabulary. `deliverableState()` tolerates both an absent `state` (every pre-existing
  doc) and an unrecognised one (hand-edited through MDH) as "not assessed".
- **`state` + `stateDate` on the deliverable doc**, additive exactly like `titleSource`:
  absent on older docs, ignored by older builds, `null` clears. The date is **stamped, not
  typed** — upstream defines it as "the day the state last changed", which is something the
  Architect knows.
- **`StateControl.jsx`** in the pane header beside the title, next to the check pill. Two
  different axes on one row, deliberately: the pill is what Fabry **measured**, the state is
  what the author **asserts**. Its palette is restated in `console.css` rather than borrowed
  from `doc-theme.css`, so a future cleanup of that ported sheet cannot silently break it.
- **`src/docs/docWarnings.js`** replaces the plugin in the pipeline (DELTA 5) — a diagnostic
  for `<state-label>` and the near-misses someone reaching for it would type
  (`section-state`, `statelabel`, `StateLabel`, `sectionstatus`, bare `state`/`status`),
  rendering upstream's own dashed-red `.state-label.state-error` pill plus a
  `file:line` warning. Detection runs on the token stream, so a fenced ```markdown example
  of the syntax is still immune — upstream's insight, preserved.
- **Hook implementations preview as code.** Verified from the Rossum API tool contract (no
  org access): a function hook carries `config: { runtime: "python3.12", code: … }`, a
  webhook carries `config: { url }` and no code. So `formatResource` shows the code as
  **Python** (language read from `runtime`, not assumed) and everything else as pretty JSON,
  with a note saying which part of the resource is on screen. Previously the modal showed a
  three-line handler as one 130-character escaped line. `highlightCode` is shared by the
  live modal and the export's `<template>` embedding, so an offline bundle previews the same
  Python rather than reverting to JSON.

### What this cost, stated plainly

- **`src/docs/stateLabels.js` and its 25 verbatim upstream assertions are gone.** That was
  the port's strongest fidelity artifact (a byte-identical file guarded by upstream's own
  tests), and keeping an unused module plus tests for code nothing calls would have been
  worse. `states.md` is therefore **no longer byte-equivalent**, and the equivalence suite
  says so explicitly: `DOCS` covers `index` and `architecture`, and a dedicated block pins
  the divergence — no badge, no tally, a visible notice instead, and everything that is not
  a state label still matching upstream exactly.
- **The contents page lost its "Section states" column.** It counted in-document badges;
  with states scoped to the deliverable header there is nothing for it to count.
- The `.state-*` hues and the `toc-state-dot` mirroring inside the ported `theme.css` and
  `toc.js` are now **inert** for Architect documents. They are kept rather than stripped:
  they cost nothing at runtime, keep those files close to upstream, and are already there if
  states are ever surfaced in the document itself. The TOC-dot tests now feed them
  upstream-shaped markup and say so.

### One more fact worth keeping

An **underscored** name (`<state_label>`) needs no diagnostic and gets none: an underscore
is not legal in an HTML tag name, so markdown-it never treats it as HTML and it renders as
**visible literal text**. The notice exists only for the invisible case.

---

## Revision v4 — three owner reports (2026-08-18)

### 1. The state picker did not fit on screen — measured, then fixed

Cause, measured in a browser with the real stylesheet: the control sits at the right end of
the header row, and an absolutely positioned menu anchored to it put its right edge at
**1347px against a 1280px viewport**. Worse, `.fabry-arch-phead` sits inside
`.fabry-arch-editor { overflow: hidden }` (console.css:4444), so the overhanging part could
not even be scrolled to — it was clipped, exactly the hazard recorded for the MDH query
Library popup.

Fix: `position: fixed` plus **`src/fabry/architect/menuPlacement.js`** — pure, DOM-free,
tested — which clamps into the viewport and flips above only when below cannot show a usable
menu. Both clamp orders are load-bearing and both are asserted: right-then-left horizontally
(so a menu wider than the viewport shows its START), and bottom-then-top vertically. The
vertical one was a real bug the test caught: honouring `MIN_HEIGHT` on a viewport shorter
than the menu produced **top: -38px**, i.e. an unreachable first item. `maxHeight` is now
capped by the viewport and the menu scrolls internally.

Verified after the fix: menu at x=912 w=360 (right edge 1272 inside a 1280 viewport),
`fullyInsideViewport: true`, and hit-testable at **both** its top and bottom — the direct
test for "not clipped by an ancestor".

*(Note for a future reader: `src/mdh/libraryPlacement.js`, which CLAUDE.md cites for this
pattern, is NOT in the working tree — it survives only in a stash. Hence a local helper.)*

### 2. "PDF of the whole content" — and what Cmd-P actually does

**Cmd-P was not broken.** Measured with headless Chrome's own `--print-to-pdf`: a long
document prints to **3 pages** standalone and **3 pages** inside the Console shell, at
near-identical size (204,267 vs 204,208 bytes) — so the print stylesheet does unwind the
fixed-height layout. What Cmd-P cannot do is print more than the deliverable that is OPEN.
That is the gap.

**No Chrome API writes a .pdf here.** `chrome.printing` is ChromeOS-only, and
`chrome.debugger`'s `Page.printToPDF` needs a permission that would disable every existing
install until each user re-approved it. A JS PDF library means html2canvas rasterisation
(no selectable text, +300KB–1MB). So the owner-approved mechanism is a **print-ready page
plus the browser's print dialog**, where "Save as PDF" is the default destination — and the
dialog says so rather than implying a file appears.

- **`src/docs/printDoc.js`** builds ONE document from the chosen deliverables: optional
  contents page, a header per document carrying the state badge and/or check verdict, and
  `break-before: page` between documents. Each document is sanitized, so a printed page
  cannot carry injected markup.
- **`dist/console/print.html` + `src/docs/printEntry.js`** — a real extension page, not a
  blob: URL, because a blob **inherits the creator's CSP** (measured in v1) and could never
  run an inline script. It reads a single-use payload from `chrome.storage.session`
  (`docPrint_<uuid>`, removed on read — the `consoleAuth_` pattern), injects it, and opens
  the dialog. Session storage, so specification text never lands at rest on disk.
- Scope is **asked every time** (this deliverable / whole specification); the content options
  are **remembered** in `fabryArchPdfOptions` — the owner asked for them to be configurable.

Three defects showed up only in the real printed output, all now fixed and pinned:
`# Specification` (unwrapping every `<a>` left markdown-it-anchor's `#` as literal text — the
permalink must be *removed*, not unwrapped); the contents page telling a paper reader that
"styles and scripts are inlined" (that note describes the ZIP, so the print path passes
`note: null`); and a duplicated title ("Welcome" above the document's own "Welcome to
localpages") — a title is now injected **only** when the document does not already name
itself, and a self-naming document gets a meta-only header so the badge still has a home.
Measured result: 3 deliverables + contents → **7 pages**.

### 3. Cross-references — the same-document case works; the gap was cross-DELIVERABLE

Verified in a browser: hovering `[text](#heading-slug)` **does** open the card (created,
`position: fixed`, 820×257 at (452,185), fully in viewport, correct contents). My first probe
was wrong, not the code — it hovered the **TOC's** copy of the link, which `eligible()`
correctly refuses via `link.closest('.toc')`.

The real gap: a specification here is many deliverables, so "reference another section" means
another *document*, and upstream's card is same-page only (a localpages page is one file). So
`initSectionPreview` gained `resolveExternal(href)` / `onOpenExternal(href)`:

- A reference like `[queues](architecture.md#queues)` previews **that deliverable's** section;
  with no fragment it previews the document's opening rather than nothing.
- The card carries **provenance** (`.section-preview-from`) and its footer becomes
  "Open <Title> ↗", which opens that deliverable. A quotation from another document must not
  read as your own text.
- Rendered from the store — every deliverable's text is already in memory, so a hover costs
  no request — and cached by `slug + text`, so an edit invalidates only its own entry.

One related inconsistency fixed while verifying: **DocView did not intercept in-document `#`
clicks** (`DocView.jsx:134` returned early), so a prose cross-reference fell to the browser
and appended `#x` to the Console's own URL — the stray-fragment problem `toc.js` deliberately
avoids. It now scrolls the pane, like the TOC and the card footer already did.

---

## Revision v5 — the outline moves to the sidebar (2026-08-18)

Owner's choice (a): the document's headings nest **under the deliverable they belong to** in
the Architect sidebar, so the sidebar is one navigation tree rather than two panels competing
for the same vertical space. The in-pane TOC is gone.

This also closes the known limitation recorded in v2: upstream's in-page `.toc` needs a
1280px column, and the pane is ~936px at a 1280px window, so it was hidden in practice. The
sidebar always has room (200–420px, default 280) and the document gets its full column back.
`client/toc.js` is untouched and still serves the EXPORT, whose standalone pages have no
sidebar — the ported behaviour keeps its home.

- **`src/docs/outline.js`** (pure) reads the outline from the MARKDOWN, not the rendered DOM,
  so it works in Editor mode where nothing is rendered and needs no layout. The slug rule and
  the duplicate suffixes must match markdown-it-anchor exactly or a click scrolls to nothing,
  so they are asserted against the LIVE renderer: the second occurrence of a slug takes `-1`,
  the third `-2`, the counter spans every heading level even though only h2/h3 are listed, and
  `Ünïcode heading` really does become `ncode-heading` (upstream's slugify strips non-ASCII
  `\w`). Fenced blocks are skipped, both fence styles — upstream's own docs contain a
  ```` ```markdown ## heading ```` example.
- **Clicking navigates the surface the reader is on**: the EDITOR while editing (which drags
  the preview along in split view through the existing sync), the PREVIEW when that is all
  they can see. Scrolling a hidden element would look like a dead click.
- **The highlight follows whichever surface is scrolling** — `lineAtTop()` for the editor,
  the new `lineAtPreviewTop()` (the exact inverse of `previewScrollTop`, round-trip tested)
  for the preview — through `activeOutlineSlug`, which is pure.

### Two bugs found by verification, both real

1. **`h` as a loop variable shadowed Preact's `h` factory.** The JSX inside
   `entries.map((h) => …)` compiles to `h(...)` and called the heading object instead of the
   element factory. Caught immediately by the sidebar test (`TypeError: h is not a function`).
2. **`scrollToLine` wrote to an element that does not scroll.** It resolved the scroller as
   `host.parentElement`, which is true in the shipping markup and silently wrong anywhere
   else — and writing `scrollTop` to a non-scrolling div is *accepted and ignored*, so the jump
   did nothing and reported no error (measured: delta computed correctly at 1450px, `after: 0`,
   while a raw write to the real box accepted 700 in the same breath). It now walks to the
   nearest ancestor that genuinely has overflow AND range — the same lesson as the
   `.cm-scroller` trap, applied properly this time. `scrollToLine` also returns its own
   arithmetic so a silent no-op can never again look like a mystery.

Verified in a browser with real CodeMirror and the shipping CSS: jumping to a heading lands
its line at the top (`target 20 → lineAtTop 20`), the first heading lands at the padding
offset, and the last one clamps at max scroll (2480) as the browser should.

---

## Revision v6 — three reports that were real, and what my earlier verification missed (2026-08-18)

All three came back "still doesn't work" after v4/v5, which means the previous verification tested
MODULES in harnesses, not the app's wiring. Booting the real components together found the causes.

### The wiring bug behind two of the three reports

`resolveDoc` (and `onNavigate`, `onOutlineScroll`) are created fresh on every host render and one
of them sat in DocView's adopt-effect **dependency array**. So every host render — and
`setPreview` fires one on **every keystroke** — tore the document down and re-initialised every
behaviour. `initSourceViewer`'s teardown calls `closeModal()`, so **an open file/resource modal
closed itself**, and re-initialising **cancelled the 280ms hover timer mid-hover**. Both reports
("preview of the files doesn't work", "preview across deliverables doesn't work") follow from that
one line, and my harnesses never saw it because they never typed. The callbacks now live in refs
and the effect depends only on genuinely new DOM. Verified: open the modal, force a host render,
modal still open with its Python intact.

### The scroll bug behind the third — and a correction to v5

v5 claimed `scrollToLine` was fixed by walking to the nearest scrollable ancestor. That was
verified in a harness where the wrapper had no definite height — and **that is not the shipping
layout**. Measured in a faithful mount of the real components:

| layout | `.cm-editor` | `.cm-scroller` range | `.fabry-arch-source` range |
|---|---|---|---|
| harness, wrapper without a definite height | grows to content (14402px) | 0 | **14,002px** |
| SHIPPING layout, height chain resolves | bounded (211px) | **349px** | 0 |

So neither "the ancestor scrolls" nor "CodeMirror scrolls" is true on its own, and the ancestor-only
resolution wrote scrollTop to an element with no range — accepted and ignored, no error, jump does
nothing. `scrollTargetFor(view, host)` now compares **both** candidates and takes the larger range,
which is exactly the rule `JsonEditor.jsx` already used and which v2 recorded as unnecessary to
extract. It was necessary. Verified: an outline click moves `.cm-scroller` from 0 to 421.

### Two bugs found while verifying, neither reported

- **A switch painted the PREVIOUS deliverable's text for a frame.** `preview` was a bare string, so
  after the keyed remount DocView rendered the old text until a `[deliverable.id]` effect reset it,
  then swapped ~120ms later. It also meant the render cache was never hit, because the first render
  asked for a key nobody had warmed. `preview` is now tagged `{ id, text }` and `shownText` falls
  back to the new deliverable's text during the switching render. Measured frame sequence across a
  switch: `Deliverable 2` → (one empty frame, the remount) → `Deliverable 3`. No wrong-document frame.
- **`latest.current` is stale after a switch** (it only changes when the user types), and the outline
  jump read it for line numbers. It now reads `shownRef.current`, i.e. what is on screen.

### §2.1 — the form a human actually writes

The generated id for `### 2.1 Entities` is `21-entities`: markdown-it-anchor lowercases and strips
punctuation, so **the dot disappears**. A cross-reference written as `[§2.1](data-model.md#2.1)`
therefore matched nothing, while a hand-copied `#21-entities` worked — which is exactly the shape of
the report. `src/docs/anchorResolve.js` now resolves a fragment in order of how much it proves:
exact id → normalized equality (`#2-1-entities`, `#2.1 Entities`, percent-encoded) → leading
section number, and the prefix branch refuses to continue into a digit so **`#2.1` can never
resolve to "2.10 Appendix"**. Used by the hover card (both same- and cross-document), by fragment
clicks and by the sidebar outline. Verified in a browser: the human form and the slug form now open
the same card.

### Preloading (owner: "preload all deliverables so the page switching is instant")

Text was never the cost — every deliverable arrives in the single Data Storage `find` at boot. The
cost is rendering: markdown-it, the sanitizer, and for a document with a diagram a **second paint**
once the 1.5MB mermaid bundle lands.

- **`src/docs/renderCache.js`** — LRU (cap 24, recency-refreshed on hit) keyed by id + exact text +
  theme + sync-anchors + *whether a diagram renderer existed*. That last field matters: a document
  rendered before the bundle arrived has code fences where diagrams belong and must not be served
  afterwards. A render that throws is returned but never cached.
- **`src/fabry/architect/preload.js`** — one document per idle slice, the open one skipped (it
  renders itself), cancellable, capped at 40. **Two passes**: diagram-free documents warm
  immediately, and only the diagram ones wait for the bundle. The first version waited for the
  bundle before warming *anything*, which measured as nothing cached at all.
- Measured: a 14-section document renders in ~3ms cold and ~0ms warm; warm switches now show cache
  **hits** where before every switch was a miss. Switch latency is ~10ms either way at this document
  size — the win grows with document size and is largest for diagram-heavy documents, which no
  longer paint twice.

## Revision v7 (2026-08-18) — resource views: an extension is two files

**Report (owner):** "extensions/hooks have two files: JSON and PY (where JSON is the definition
of the whole hook). Currently, only the PY opens."

Correct, and it was the caveat this port shipped with: D5 re-aimed upstream's file viewer at API
resources, which collapsed two authored references (`<hook>.json`, `<hook>.py`) onto one key —
and `formatResource` prefers `config.code`, so the definition had no way to be shown.

**The view is part of the KEY** (`?view=code` / `?view=json`), for a reason worth recording: it is
the only place a marker survives both paths untouched. `apiPathFromHref` already preserves a query
string and strips a fragment, and the exported page's `keyFor` reduces an href to
`pathname + search` — so a query parameter keys a `<template>` offline exactly as it keys a live
fetch, while a fragment would be dropped by both. `splitResourceView` removes the marker before the
request (nothing unrecognised reaches the Rossum API) and claims it only for values we declare, so
a future real `view` parameter still passes through.

- `formatResource(raw, view)` — `view === null` is byte-identical to the previous behaviour, which
  is what keeps every already-written link and every already-exported bundle working. It now also
  returns `view` and `views`; `views.length > 1` is the only thing that makes a switcher appear, so
  queues, schemas and webhooks are untouched.
- `sourceViewer.js` gains its **second delta**: a `[Code | Definition]` switcher whose click is
  nothing more than this modal reopened on the sibling key. `theme.css` **DELTA G** styles it.
  Measured in a browser: info → switcher → Copy → Close, in order, inside the header.
- The **export embeds both views from one request** — `createResourceFetcher` attaches `.raw`, and
  each `<template>` carries `data-view` / `data-views` / `data-note`. Without that the switcher
  could offer what the bundle lacks, and a document linking only the implementation would leave the
  definition unreachable offline. Templates from an older build carry no attributes and get no
  switcher.
- **Authoring:** `?view=json` for the definition, `?view=code` (or a bare path) for the
  implementation.

+20 tests (311 files / 3384 total): view splitting and round-tripping, the unknown-value passthrough,
per-view formatting including the webhook-asked-for-code case, the fetcher never sending the marker,
both-views-from-one-request in the export, the plain-fetcher degradation, and the switcher live,
offline and on a legacy template.

## Revision v8 (2026-08-18) — the ZIP export is removed

**Owner:** "To simplify the overall functionality, let's remove the ability to download the ZIP
file (PDF should be enough or people can go directly to the Rossum org.)"

Accepted as stated. §7's ledger stands as the record of what the port *achieved*; what SHIPS now is
that list minus the static export, so **10 of upstream's 14 features** remain.

**Deleted:** `docExport.js`, `page.js`, `zip.js`, `exportClient.js`, `download.js`,
`assetsLoader.js`, `client/toc.js`, `tests/docs-export.test.js`, the two TOC blocks in
`tests/docs-client.test.js`, the `console/doc-export-client` esbuild entry, and `build.js`'s
`writeDocAssets()` (so `dist/console/doc-assets.js` and `doc-export-client.js` no longer exist).

**Why `client/toc.js` went with it, though the owner did not ask:** the in-pane TOC had already
moved to the Architect sidebar (v6), which left the exported pages — which have no sidebar — as its
only consumer. With the export gone it had none, so keeping it would have been dead code that reads
as a live feature. Its `.toc` CSS **stays** in `theme.css`: that file is a byte-faithful port whose
fidelity is asserted by `docs-render-equivalence`, and carving rules out of it would create a new
delta for no functional gain.

**Also removed as newly dead:** `createResourceFetcher`'s `.raw` attachment (it existed so one
request could serve both views of a hook while embedding templates) and `slug.js`'s
`mdHref`/`htmlHref` (the `.md`→`.html` filename pair).

**Deliberately kept, with the reason restated because it changed:**

- `slug.js` — slugs are how a cross-document reference is ADDRESSED (hover preview, link
  interception, printed contents), not merely how a file was named. `RESERVED = {'index'}` also
  stays: freeing the name would silently re-point any reference written against a deliverable
  called "Index".
- `contents.js` — `printDoc.js` generates the printed contents page from it. Its ZIP-flavoured
  default note is gone (print was already passing `note: null`), and its intro no longer says
  "bundle".
- `sanitize.js` — its strongest argument used to be that an exported page carries no CSP. That
  argument is gone, but the four writers of deliverable `text` are unchanged and the pane and the
  print page still adopt parsed HTML, so the allowlist still earns its place.
- `render.js`'s export mode and the `expected/*.export.html` fixtures — "export mode" is a renderer
  option, and the fixtures are what prove 1:1 fidelity with upstream. They stay because they prove
  the port, not because anything exports.
- `sourceViewer.js`'s `<template data-source-path>` branch — no producer remains in this repo, but
  it is three lines, it is what lets an ALREADY-EXPORTED bundle still open, and it is the seam any
  future offline mode would reuse.

**Genuinely lost:** offline `<template>` embedding of referenced API resources, the generated
`index.html` landing page, org-hosted images inlined as `data:` URIs, and the
unresolvable-cross-document-link report (`collectBrokenLinks`) — that last one was the only place a
dangling `other.md` reference was reported, so a rename that orphans a link is now silent again.

Suite after the removal: **310 files / 3356 tests**, from 311 / 3384 (−1 file, −28 tests: 20 export,
8 TOC), build clean, `dist/console/` down to eleven files.


## Revision v9 (2026-08-20) — dead rules pruned from `theme.css` (DELTA H)

A repo-wide dead-code sweep reached this sheet. 39 rules went; the sheet is 731 → 577 lines.
The owner's call was explicit: prune, and document the delta rather than leave the sheet a
superset of upstream.

**What went, and why each was unreachable.** Every deleted selector names at least one class
that appears in no source file *and* in no built JS bundle. That is the whole argument: a class
no code emits is on no element, so any selector requiring it never matches — which makes
`.live .dead` and `.live.dead` just as dead as `.dead`.

| Group | Classes | Why they cannot match |
|---|---|---|
| Section states | `.state-rough-draft` `.state-in-progress` `.state-ready` `.state-verified` `.state-stale` `.state-label-icon` `.state-label-date(::before)` `.state-summary-{title,item,count}` `.has-state-label` | Upstream's `state-labels.mjs` left the pipeline in Revision v3 (2026-08-18) and the Architect property that replaced it went on 2026-08-19. Nothing emits a state badge. |
| In-pane TOC | `.toc a.toc-h3` `.toc-state-dot` | The outline moved to the Architect sidebar (Revision v5) and `client/toc.js` was deleted with the export (Revision v8). |
| Static export | `.docs-nav` `.docs-nav-list` (+`a`, `:hover`, `.active`) `.export-link` | Removed in Revision v8. No nav bar and no export link are rendered anywhere. |

`.state-label` and `.state-error` **stay** — `docWarnings.js` still emits that pair for an
unsupported `<state-label>` tag, which is exactly the diagnostic Revision v3 introduced.

**Verification.** Both stylesheets were flattened to (at-rule context, single selector) →
declaration block before and after. Result: 204 → 165 rules, every dropped selector names a dead
class, **every surviving block byte-identical, nothing newly appeared**. Braces and comment
delimiters balance; no dangling selector fragment. Two pruning bugs were caught and fixed by
that check rather than shipped — a naive whole-rule delete detached the surviving selectors of a
grouped list from their block, and splitting a prelude on commas tore a comment in half.

**Cost, stated plainly.** This sheet is no longer a superset of upstream's, so a future re-port
against a newer localpages cannot be a straight copy of the changed hunks: these rules will come
back with it and have to be dropped again. That is the same bargain `states.md` already made —
its fixture stopped being byte-equivalent to upstream in Revision v3, and
`tests/docs-render-equivalence.test.js` says so in a dedicated block rather than quietly dropping
it. DELTA H is recorded in the sheet's own header for the same reason.

**Also in this sweep, in `src/docs/`:** `sanitize.js`'s `_internals` export (a test hook that
never acquired a test), `printDoc.js`'s `declaresOwnHeading` re-export (the test imports it from
`specDocument.js`), `outline.js`'s `activeOutlineSlug` and `resources.js`'s `resourceLabel` (both
production-dead), `DocView.jsx`'s `useDebounced` hook and its `resolveHeadingElement` import
(orphaned when Edit and Preview became separate mounts, so the preview no longer follows
keystrokes), and — reversing the decision quoted three paragraphs above — `sourceViewer.js`'s
`<template data-source-path>` branch. It was kept in v8 as "the seam any future offline mode
would reuse"; the owner chose deletion, and it becomes DELTA 3 of that file. Its `!resolve`
guard survives with honest wording, since `Not available offline.` no longer describes anything.
