# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

Chrome extension (Manifest V3) enhancing the Rossum, NetSuite and Coupa UIs for solution
architects during onboarding. Published to the Chrome Web Store. Community-supported, not an
official Rossum product.

## Build System

esbuild bundles ES modules from `src/` into `dist/`. No transpilation, no other build tools.
`build.js` also copies static assets and injects the version (see Versioning). Config:
`format: 'iife'`, `minify: true`, `jsxFactory: 'h'`, `jsxFragment: 'Fragment'` (Preact JSX).

- `npm run build` — clean build into `dist/`
- `npm run dev` — watch mode (JS only; re-run the full build for CSS/HTML changes)
- `npm run typecheck` — `tsc --noEmit` for `src/`, then `-p tsconfig.tests.json` for `tests/`.
  Two programs, not one: see TypeScript below for why.
- `npm test` — Vitest. `tests/dead-code.test.ts` is a repo-hygiene guard, not a behaviour
  test: it derives the entry points from `build.js` and fails on an unreachable module, an
  export nothing imports, or an unused local/import. Its header lists what it deliberately
  cannot see — chiefly dead CSS, and code reachable only from a test.
- `dist/` is the loadable extension, and is gitignored. **Tests run `src/`, the browser runs
  `dist/` — rebuild before asking anyone to reload the extension.**

## TypeScript

**Every file in the repo is TypeScript: `src/` is 203 `.ts` + 159 `.tsx` + 1 `.d.ts`, and `tests/`
is 322 `.test.ts` plus `setup.ts` and `support/`. Zero `.js`/`.jsx` in either.**
Adopted for readability, not bug-finding — `tsc --checkJs` over the pre-migration repo found no
runtime defect. Why each decision was made, and the defects the work surfaced, is in the four
migration commit messages; this section is only the rules that still bind.

Rules, all in `tsconfig.json`:

- **`checkJs: false`** — was the migration ratchet; now vacuous, and guards only a future `.js`.
- **Two programs.** `tsconfig.json` covers `src/`; `tsconfig.tests.json` extends it for `tests/`
  and adds ONE thing — `@types/node`. That separation is the point: tests are the only code here
  that runs in Node (the meta-guards read `src/` off disk with `node:fs`), so `src/` stays
  node-free and a stray `process.env` in a browser bundle is still a type error. The tests program
  also has to name `src/types/**/*.d.ts` explicitly, since it reaches `src/` through imports rather
  than through `include`.
- **`setTimeout` returns a different type in each program**, so a stored handle is
  `ReturnType<typeof setTimeout>`, never `number`.
- **`strict: true`** — `noImplicitAny` is the point.
- **`erasableSyntaxOnly`** — no `enum`, `namespace` or parameter properties. A `.ts` file here is
  JavaScript plus annotations, nothing else. Still enforced on TypeScript 7.
- **`alwaysStrict: true`** — the ONE option here with a runtime effect, because esbuild reads this
  file: it emits the `"use strict"` prologue. Changing it is a behaviour change, not a type one.

Renaming and resolution:

- Renames need **no importer edits**: esbuild, vite and tsc resolve `./x.js` to `x.ts` and
  `./x.jsx` to `x.tsx`. Every component import still SPELLS `.jsx` (256 in `src`, 158 in tests) —
  deliberate, since bundling resolves them at build time and none reaches `dist/`. Do not
  mass-rewrite them.
- **Entry points are the exception**: `build.js` names all nine literally.

Conventions:

- **Type changes must be emit-neutral.** Verify by diffing UNMINIFIED bundles — minified
  byte-identity is too strict (identifier allocation shifts on rename) — and collapse whitespace
  first, because a wrapped signature is not emit. Prefer an erased cast to a runtime change:
  `x as string` over `String(x)`, `a!.b` over `a?.b`, `(window as any).f` over hoisting a `const`,
  and keep an `= {}` default rather than dropping it. Never add a guard, an operator or an
  argument to satisfy a type.
- **Do not annotate a CONTEXTUALLY typed parameter.** A callback handed straight to `map`,
  `filter`, `vi.fn` or a typed prop already has a type; writing `: any` on it is the only thing
  that takes it away. ~260 such annotations were removed on 2026-08-25 by stripping every
  contextual `: any` and putting back only the positions `tsc` then reported as implicit — the
  same two-pass check is how to keep it honest next time. Two places the annotation is still
  right, both measured: an event handler that reads `e.target` (see the `e.target` rule below —
  the alternative, `e.currentTarget`, is a different runtime object), and a mock destructuring an
  options bag the real signature marks OPTIONAL, since a required parameter is not assignable
  where the target's is optional.
- **`any` is fine where the wire genuinely is untyped** — a parsed JSON body, a raw Rossum API
  object, a Data Storage record, a markdown-it token. Say why at a **module boundary**; a callback
  over such an array (`records.map((r: any) => …)`) needs no comment. Most of the ~1,560 `any`
  annotations are that shape.
- **Reach for an existing named type before writing `any`** — the repo exports ~100, and `grep
  "^export type"` is faster than inventing a shape. Doing this after the migration surfaced four
  real defects.
- **Name an imperative handle passed by ref** (`JsonEditorHandle`), and name a prop group more
  than one component takes (`SortFilterControls`). An `any` ref hides an entire API.
- **`signal`/`useRef`/`useState` initialised to `null` need a type parameter** — untyped, they
  infer `Signal<null>`/`Ref<null>` and reject every later assignment. Do NOT change the
  initialiser instead: `useRef(undefined)` emits `void 0` where the source said `null`.
- **Class fields must be `declare`d.** `useDefineForClassFields` is on under `target: ES2022`, so
  a bare `x: T` emits a define and changes the constructor.
- `export type` is ignored by the dead-code guard, so a boundary type may be exported unused.

Components (`.tsx`):

- **Children before parents.** TS infers every default-less destructured prop as REQUIRED, so
  typing a parent whose children are untyped invents "missing required prop" errors — but check
  before dismissing one, since the fix usually belongs in the child's prop type.
- **A prop's optionality is evidence, not taste.** A wrong `?` moves the error into the body as
  "possibly undefined"; a wrong required moves it to the call site. Read both and let them
  triangulate.
- **A ref is typed from the tag it is attached to** — Preact's `ref` on a `<div>` wants
  `Ref<HTMLDivElement>` and rejects the wider `HTMLElement`.
- **`e.target.value` needs the handler parameter annotated**, not each access guarded.
- **CSS Modules** have no types; `src/types/vendor.d.ts` declares `*.module.css` as
  `Record<string, string>`. Exact key sets would need a build step ahead of tsc, and
  `tests/css-class-collision-boundary.test.ts` already checks the BUILT stylesheet.

Tests (`tests/**/*.test.ts`):

- **`h()`, not JSX.** Vitest transforms `.ts` as TypeScript, not TSX, so components are mounted
  with `h(Component, props)`. That is why the suite is `.test.ts` and not `.test.tsx`; moving a
  file to `.tsx` to write JSX is a deliberate choice, not a tidy-up.
- **`vi.mocked(x)` around a module mock.** `vi.mock('./api.js')` leaves the import typed as the
  REAL function, so `api.foo.mockResolvedValue(…)` does not type-check. `vi.mocked` is identity
  at runtime and the only thing that makes the mock surface visible.
- **A mock needs the parameters it is asserted on.** `vi.fn(async () => {})` gives
  `mock.calls[0]` an empty tuple, so `calls[0][0]` is a type error — declare `(_opts: any)`.
- **Assert null-ness ONCE, where the value is produced.** `const btn = root.querySelector('.x')!;`
  then plain `btn.click()` — not `btn!` at every use. 736 of the suite's 1,666 assertions were
  redundant on that measure (2026-08-25) and were removed by stripping every `!` and restoring
  only the positions `tsc` still objected to; run that same two-pass check rather than eyeballing
  it. Watch the binding when hoisting: `await f()!` asserts the PROMISE, so it has to be
  `(await f())!`. In `src/` the same sweep removed nothing — all 149 there are load-bearing.
- **Shared fixtures live in `tests/support/`.** A repo type with required fields gets a factory
  there (`deliverable()`, `track()`, `rect()`) rather than a partial literal per test, so a
  fixture cannot drift from the type the real loader produces.
- **When a test proves a function tolerates junk, widen the FUNCTION — but only if the body
  actually guards.** Half of what this migration turned up was a parameter typed `T` whose body
  opens with `if (!x)` or `Array.isArray(x)`; those signatures were simply narrower than their
  contracts. Verify by widening and re-running `tsc`: if a body does not really guard, it says so
  immediately. Where the input is deliberately malformed (`'not a pipeline'`, a doc with no id),
  cast at the CALL with a comment saying that is the point of the assertion.

## Architecture

Nine entry points, plus two bundles nothing imports that are script-injected on demand:
`console/mermaid` (`src/fabry/mermaidEntry.ts`, the ~1.5MB diagram renderer) and
`console/doc-print` (`src/docs/printEntry.ts`).

| Entry | Surface |
|---|---|
| `src/rossum/index.ts` · `src/netsuite/index.ts` · `src/coupa/index.ts` | content scripts |
| `src/popup/popup.tsx` | extension popup (Preact) |
| `src/console/index.tsx` | Console page — an app rail over six apps |
| `src/background/index.ts` | MV3 service worker |
| `src/devtools/devtools.ts` · `src/devtools/panel.tsx` | DevTools "Rossum" panel |
| `src/sidepanel/index.tsx` | Chrome side panel |

### Content scripts

**Rossum** reads toggles from `chrome.storage.local`, builds a handler array from the enabled
features, and runs ONE MutationObserver over added subtrees. Each module in
`src/rossum/features/` exports an optional `init()` (inject CSS, add listeners; called once) and
`handleNode(node)` (called for every added element; must be fast, and a no-op when irrelevant).
To add a feature: create the module, add its key to `SETTINGS_KEYS` in `index.ts`, wire
`init()`/`handleNode()`, add a popup checkbox. Disabled features add zero overhead.

**NetSuite** and **Coupa** are self-contained single files with no observer. Coupa uses two
strategies: JSON from `#initial_full_react_data` (React pages), and DOM attributes with
`IGNORE_S_CLASSES` filtering (Rails pages).

Reloading the extension does NOT re-inject content scripts into open tabs — reload the tab.

### Console apps (`src/console/`)

An app-switcher rail over six apps. Adding one touches three hardcoded switch points
(`Rail.tsx` APPS, `Console.tsx` render switch, `boot.ts` `isValidApp`) plus `console/index.tsx`.

- **Dataset Management** (`src/mdh/`) — Preact SPA over Rossum Data Storage: collections,
  records, a CodeMirror+JSON5 aggregation-pipeline editor, indexes, one import and one export
  wizard, and a Stages view that debugs a pipeline stage by stage. Signals in `store.ts`, REST in
  `api.ts`, plus an LRU cache, background prefetch and streamed export.
- **Audit Log Viewer** (`src/audit/`) — one generic shell driven by per-source descriptors in
  `sources/`. Only `audit_logs` is registered; the descriptor shape exists to host more.
- **Galaxy** (`src/galaxy/`) — the live org as a 3D force graph on raw three.js + d3-force-3d.
  `3d-force-graph` is deliberately avoided: its ngraph engine uses `new Function`, which the
  Console page's MV3 CSP forbids.
- **Inspector** (`src/inspector/`) — read-only "what happened to this annotation, and why" as one
  progressively-filling Diagnosis Report: a deterministic evidence model and verdict
  (`evidence.ts`), then a Fabry narrative with `[e:<id>]` citations (`synthesize.ts`).
- **Fabry Chat** (`src/fabry/`) — chat over the Rossum Agent API. There is **no 👍/👎
  feedback**: `PUT /feedback`'s `turn_index` addresses the raw stored history while
  `GET /chats` drops text-less tool-only steps, so a thread index mis-targets feedback on any
  tool-using turn (live-confirmed 2026-07-13). The plumbing was kept dormant for a year and
  deleted on 2026-08-20 — restoring it means restoring `chat.sendFeedback`,
  `agentApi.submitFeedback` and `thread.serverMessageIndex` from git, and it should wait for a
  stable per-message feedback id regardless. Plus **Architect**: per-org
  Markdown deliverables kept in a Data Storage collection, rendered as ONE scrolling
  specification (`components/SpecView.tsx`) and checked against live org state.
- **Academy** (`src/academy/`) — the onboarding training track; the only app behind
  `experimentalUnlocked`.

Auth: the popup (or the worker) runs `readAuthInfo` in the Rossum tab via
`chrome.scripting.executeScript`, stages a single-use `consoleAuth_<uuid>` in
`chrome.storage.local`, and opens `console/console.html?authId=…`. The Console reads and
immediately removes it, then keeps credentials in `sessionStorage`, so the token is never left at
rest. A 24h TTL sweep purges entries that were never consumed.

### Other surfaces

- **Service worker** — three jobs: stage auth and open the Console for the legacy MDH web app (a
  content script cannot `chrome.tabs.create` an extension page); be the ONLY sender of usage
  events; scope the side panel per tab.
- **Popup** — detects the site and dims irrelevant sections. All tab IO goes through
  `chrome.scripting.executeScript`, never `tabs.sendMessage`, so popup actions survive
  content-script orphaning across upgrades. On Rossum tabs it widens to show the MDH provenance
  card, and warns when the open annotation is held in `reviewing` by another user — one-click
  Unlock is `PATCH status:'to_review'`, the only non-holder-capable release.
- **Side panel** — hosts the *same* `MdhProvenancePanel` component as the popup; it exists
  because a Chrome popup closes on blur. Scoped to Rossum tabs by the worker.
- **DevTools panel** — shows and PATCHes the API resource behind the current Rossum page. Auth
  via `inspectedWindow.eval`; in-panel tabs, a GET-only request bar, Copy as curl, inline
  resource-name hints, diff→confirm→PATCH save. Read-only resources hide Save. Nothing leaves
  the browser.

## Safety invariants

Enforced by tests, not by convention. Do not weaken them.

- **Write boundary** — Fabry Chat is strictly read-only. ONLY `src/fabry/architect/**` (the
  implement loop) may send `mcp_mode: 'read-write'`, and only the transport
  `src/agent/agentApi.ts` may name it. There is **no server-side write-lock** — the backend
  honours whatever the client sends, so the boundary is entirely client-side. Guarded by
  `tests/fabry-write-boundary.test.ts` plus a `dist/` grep.
- **Training never mutates** — no request the onboarding track makes can change the org. That is
  not the same as "only GETs": mission 5 POSTs to `/svc/data-storage/api/v1/collections/list`
  because that service takes queries as JSON bodies. It is a list query. Do not "fix" it into a
  GET — it would 404. Audit by looking for mutating endpoints, not for non-GET verbs.
- **Usage data** — the worker is the only sender, gated on `usageConsent === true`. Events are
  name-only by construction (no caller can supply a field), so the leak guard is structural.
  Adding an event means adding it to `EVENT_NAMES` **and** to `PRIVACY.md` in backticks; a test
  enforces the pairing. Only `src/usage/ga4Config.ts` may name `google-analytics.com`.
- A **read-only agent framing** (cautious persona, standing notices) is defense-in-depth, never a
  guarantee.
- **Retiring a feature must never delete customer data** — stop reading a field, do not drop it.
- **No bare single-letter class names in JSX.** `minify: true` shortens CSS Modules' local class
  names to one or two characters in the emitted `console.css`, and esbuild guarantees those are
  unique only among THEMSELVES — not against hand-written classes. A generated `.k` once painted
  a 320px blurred hero blob across the Inspector's `class="k"` cells. What keeps it safe is that
  no bare short class names remain, asserted against the BUILT stylesheet by
  `tests/css-class-collision-boundary.test.ts`.

## Conventions & traps

- **Pure core, impure glue.** Geometry, prompts, parsers, state machines and decisions live in
  DOM-free unit-tested modules; DOM and network wiring is a thin layer over them.
- **One home per grammar.** Annotation-URL parsing lives only in `src/rossum/annotationUrl.ts`,
  MDH placeholder syntax only in `src/mdh/placeholderSyntax.ts`. `src/popup/tab-readers.ts` keeps
  a deliberate copy, because its functions are serialized into the page by `executeScript` and
  cannot close over an import — both carry a comment saying so.
- **Additive keys and sibling documents** keep older builds working; that is the migration
  convention for the Architect's Data Storage collection.
- **jsdom has no layout.** CSS geometry, scroll and overflow bugs pass every test. Measure in a
  real browser, or with a scratchpad harness that links the live stylesheet.
- **Writing `scrollTop` to a non-scrolling element is accepted and silently ignored** — no error,
  no movement. Which element owns the scroll range depends on the layout, so measure both
  candidates; `view.scrollDOM.scrollTop` on CodeMirror does nothing in several layouts here.
- **A raw control byte makes a source file binary to git AND invisible to grep** — `git diff
  --numstat` reports `- -` and ugrep skips it, so a whole component can go unreviewed. Write
  escapes, not literal bytes; `file <path>` must not say `data`.
- **`chrome.storage.local.get([keys])` returns only the keys you ask for** — a preference written
  but missing from the boot read list reads back `undefined` for ever.
- **A listener must be owned by the effect that owns the element**, or a remount leaves it bound
  to a destroyed node — silent, and invisible to unit tests.
- **Deleting dead CSS has three traps, all silent, none visible to jsdom.** (a) A rule whose
  selector *list* is grouped must lose only the dead selectors — deleting the whole rule
  detaches the survivors from their block, and braces still balance afterwards. (b) A selector
  is dead when it names *any* class no code emits, not only when every class is dead:
  `.live .dead` matches nothing either. (c) Splicing a note into an existing CSS comment closes
  it early, and the orphaned prose then swallows the next rule. Verify by comparing Chrome's own
  CSSOM (`sheet.cssRules`) before and after, plus computed styles over real markup — a
  hand-rolled CSS parser is what these traps defeat.
- **`CSSStyleRule` has a `cssRules` property** (empty, there for CSS nesting), so `if
  (r.cssRules) recurse()` descends into every ordinary rule and records none. Test
  `selectorText` first when walking a stylesheet.
- **esbuild READS `tsconfig.json`**, so a compiler option can change what ships (see
  `alwaysStrict` under TypeScript). Verify a "types only" change by diffing built output.
- **A test that names or walks a source file by extension goes blind when that file is renamed**
  — and blind looks exactly like passing. `tests/fabry-write-boundary.test.ts` once passed while
  ignoring four `read-write` mentions in the transport it exists to guard. Three shapes do it: an
  extension filter, an allowlist literal, and a direct `readFileSync`. Mutation-test a guard
  after touching what it scans.
- Guard Chrome-only APIs for jsdom (`CSS.escape`, `scrollIntoView`), and use the repo's own tween
  (`src/mdh/smoothScroll.ts`) for navigation jumps rather than `behavior: 'smooth'`, whose
  duration scales with distance (measured ≥1481ms vs 198ms).

## Chrome Storage Keys

- **Feature toggles** — `schemaAnnotationsEnabled`, `expandFormulasEnabled`,
  `expandReasoningFieldsEnabled`, `scrollLockEnabled`, `resourceIdsEnabled`,
  `netsuiteFieldNamesEnabled`, `coupaFieldNamesEnabled`. `closable-tooltips`,
  `dataset-mgmt-suggest` and `track-viewed` are always on, with no toggle and no key.
- **The one gate** — `experimentalUnlocked`: 5 quick clicks on the popup's version hash, hiding
  only the Academy, mirrored live via `chrome.storage.onChanged`.
- **Auth staging** — `consoleAuth_<uuid>`: single-use, 24h TTL, removed on read.
- **Global prefs** — `mdhPipelineWidth`, `mdhSidebarWidth`, `mdhUploadsColumnWidths`,
  `mdhOverviewChartsScale`, `mdhResultsView`, `mdhStages*`, `mdhShowHiddenCollections`,
  `mdhProvenanceFilter`, `fabrySidebarWidth`, `fabryArchDocView`, `fabryArchRailOpen`,
  `fabryArchRailWidth`, `fabryArchPdfOptions`.
- **Per-tab navigation**, read session-first from `sessionStorage` with a `chrome.storage.local`
  seed (`src/console/tabState.ts`), all content-free — `consoleActiveApp`, `mdhActiveView`,
  `mdhSelectedCollection`, `mdhActivePanel`, `mdhOpsSearch`, `fabryActiveChat`, `fabryMode`,
  `fabryArchitectActive`.
- **Other** — `mdhLastPipeline::<scope>::<collection>` (per org and per collection),
  `auditActiveSource`, `auditFiltersBySource`, `rossumViewedAnnotations` (cap 12),
  `trainingProgress` (per org origin, cap 3).
- **Usage** — `usageConsent` (`true`/`false`/**absent**, where absent means never answered),
  `usageClientId` (minted lazily by the worker on the first event, deleted on revoke),
  `usageAsked`; plus `usageSessionId` in `chrome.storage.session`.
- Galaxy persists nothing. Chat content, and Architect deliverable text, versions and
  transcripts, never touch storage — they live in the org's own Data Storage collection.
- **Orphaned** keys, read and written by nothing, deliberately left in existing profiles:
  `trainingUnlocked`, `fabryArchSplitRatio`, `fabryArchConsoleHeight`, `fabrySidebarOpen`,
  `usageSnapshotDay`, `inspectAnnotationEnabled`, `rawObjectEditorEnabled`,
  `fabryDeepVerifyEnabled`, `fabryArchitectImplementEnabled`, `annotateForMeEnabled`,
  `inspectorRecents`, `consoleInspectorAnn`.

## CSS Architecture

The Console ships **two** stylesheets, linked in that order by `console.html`:

- `src/console/console.css` → **`dist/console/console.base.css`** — the legacy hand-written
  monolith, holding the shared tokens (every colour, surface and type variable, plus semantic
  `--accent`/`--success`/`--warning`/`--danger` with `-hover`/`-bg`/`-fg`/`-border`). Dark mode
  overrides `:root` under `@media (prefers-color-scheme: dark)`. It shrinks as components move
  their rules into CSS Modules, and is eventually retired.
- **`dist/console/console.css`** — emitted by esbuild from imported `*.module.css` CSS Modules
  (self-contained component styles; the design-system direction). Do not confuse the names: in
  `dist/`, `console.css` is the *generated* sheet, not the monolith.

Also linked, all build artifacts rather than source: `github-markdown.css` (copied from the
`github-markdown-css` package), `hljs-github.css` (light + dark concatenated by `build.js`) and
`doc-theme.css` (copied from `src/docs/theme.css`, the ported localpages sheet — no longer a
superset of upstream's since **DELTA H**, 2026-08-20, pruned 38 rules whose features this port
dropped; its header says which, and a re-port must drop them again). These are scoped
in practice to `.markdown-body`/`.docs-*`/`.source-*` — before adding a bare class to either
side, check it cannot leak. The print page has its own `src/docs/print.css`.

`popup.css` has its own variable system, also dark-mode aware; the side panel links it FIRST and
`sidepanel.css` overrides only the shell, so the shared MDH card has one source of truth. Content
scripts inject their styles from `init()`, so styles are in the DOM only while the feature is on,
and all their classes are prefixed `rossum-sa-extension-*`.

## Dependencies

- **preact** + **@preact/signals** — all UI and reactive state
- **codemirror** + **@codemirror/lang-json** + **@codemirror/lang-markdown** — the pipeline
  editor, and the Architect's per-deliverable Markdown source editors
- **markdown-it** + **markdown-it-github-alerts** + **markdown-it-anchor** + **highlight.js** +
  **github-markdown-css** — the document renderer. **Pinned to EXACT versions, no carets**: a
  golden-file test compares byte-for-byte against upstream localpages' own output, so a minor
  bump could change rendering with no code change. That guard is NARROW — two fixtures, ~124
  lines — so it is necessary, not sufficient: markdown-it 14 -> 15 passed it while still changing
  linkify behaviour it cannot see. When one of these moves, probe the specific behaviour the code
  compensates for, not just the fixtures.
- The CodeMirror family is **carets, never exact pins** — the opposite of the render family
  above, for the opposite reason. An exact pin on `@codemirror/state` installs a SECOND copy
  beside the one `codemirror` resolves (measured: three copies, all bundled), and CodeMirror
  breaks `instanceof` across every editor. `tsc` catches it; the tests do not. All 8 sub-packages
  `src/` imports are declared, so they no longer depend on transitive hoisting.
- **json5** — lenient parsing for the pipeline editor (trailing commas, unquoted keys)
- **beautiful-mermaid** — diagrams; one flat ~1.5MB module, so it ships as its own lazy entry
- **three** + **d3-force-3d** — Galaxy (~360KB)
- **@types/node** (dev) — for the tests program only; see Two programs under TypeScript. Pin it
  to the major of the Node in use, or it types APIs the runtime does not have.
- **typescript** (dev) — type-checking only; esbuild does the building. After a major bump,
  confirm your tsconfig options are still ENFORCED (plant an `enum`); zero errors is equally
  consistent with an option having been dropped.
- **esbuild** (dev)

All are CSP-clean (no `eval`, no `new Function`) — check the BUILT bundles, and note that
`\beval\(` also matches `chrome.devtools.inspectedWindow.eval(`, a DevTools API method. The
Console runs under the default MV3 CSP — keep it that way.

## JSX escape sequences

`\uXXXX` DOES NOT work in JSX raw text children or attribute values — it renders as the six
literal characters, because JSX text is parsed as HTML-like content, not as a JS string literal.
What works: wrap it in an expression (`{'–'}`), paste the literal character (`–`), or use an HTML
entity in a text child (`&ndash;` — text only, not attributes). `\uXXXX` is fine inside template
literals and ordinary strings, and inside an attribute whose whole value is an expression. Common
offenders: en/em dash, ellipsis, arrows, chevrons, checkmarks. When mixing with expressions,
write `{a}{'–'}{b}`.

## Versioning

Fully automated in `build.js` — never edit the version in the source `manifest.json`, which holds
a `0.0` placeholder. At build time `git rev-parse --short HEAD` becomes `version_name` and
`git rev-list --count HEAD` becomes the Chrome-compatible `version`. The popup displays the hash
via `chrome.runtime.getManifest().version_name`.

## Release Process

The **Release** GitHub Actions workflow (`.github/workflows/release.yml`), triggered manually:
Actions → **Release** → **Run workflow** (on `master`). The `test` job runs
`npm ci → npm run build → npm test`, and publishes nothing if it fails; the `release` job then
rebuilds, zips `dist/`, and uploads and publishes to the Chrome Web Store. Chrome review still
applies, usually days.

Because the version comes from the commit count, every new commit is a valid higher version, and
re-running from the same commit fails the upload as a duplicate — advance a commit to re-release.
One-time credential setup is in
[`docs/chrome-web-store-release.md`](docs/chrome-web-store-release.md). Manual ZIP upload via the
Developer Dashboard remains the fallback.

## Browser Automation

Use `agent-browser` (`agent-browser --help` for all commands): `open <url>`, then `snapshot -i`
for interactive elements with refs (`@e1`, `@e2`), then `click @e1` / `fill @e2 "text"`.
Re-snapshot after the page changes.

## Where the design detail lives

`docs/superpowers/specs/` holds a dated design record per change, and `docs/superpowers/plans/`
the plan that executed it. **They are dated records, not current documentation** — a later spec
may have replaced an earlier one's design, so read the newest spec for an area first and treat
older ones as history. Currently authoritative per area:

- **Architect** — `2026-08-19-architect-unified-specification-view-design.md` (the view),
  `2026-08-18-architect-version-history-design.md`,
  `2026-07-14-architect-implement-loop-design.md`, plus
  `2026-07-13-fabry-architect-design.md` for the data model and check loop (its UI is superseded)
- **Document rendering, print, PDF** — `2026-08-17-localpages-port-architect-design.md`
- **Usage data** — `2026-08-19-usage-tracking-simplification-design.md`, a delta on
  `2026-08-03-feature-usage-measurement-design.md` (kept as the base record)
- **Fabry Chat** — `2026-07-10-fabry-chat-console-design.md`,
  `2026-07-11-fabry-deep-verify-design.md`, `2026-07-13-fabry-agent-questions-design.md`,
  `2026-08-11-fabry-public-single-gate-design.md`
- **Onboarding training** — `2026-08-07-partner-onboarding-training-design.md` + `-verification.md`
- **Inspector** — `2026-07-03-inspector-overhaul-design.md`
- **MDH** — `2026-08-12-mdh-stage-link-highlight-design.md`,
  `2026-08-07-mdh-provenance-side-panel-design.md`,
  `2026-06-30-unified-dataset-import-design.md`, `2026-07-04-export-unify-design.md`
- **DevTools panel** — `2026-07-10-devtools-rossum-panel-design.md`,
  `2026-07-17-devtools-request-bar-curl-design.md`
- **Popup** — `2026-07-16-popup-unlock-reviewing-annotation-design.md`
- **Galaxy** — `2026-06-04-galaxy-3d-org-birdview-design.md`
- **Release automation** — `2026-06-12-chrome-web-store-auto-release-design.md`
