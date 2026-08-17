# Architect unified specification view — design

**Date:** 2026-08-19
**Status:** design approved in a browser mockup (three layouts proposed, B chosen and iterated twice);
awaiting spec review before any implementation.
**Owner decisions, verbatim where they settle something:**
- "I quite enjoyed (in localpages) when I could see the whole documentation in one page (and could
  use command+F, for example)… However, I'd like to still keep the deliverables testeable individually."
- "I wish to replace the editor/preview on the right with the one unified view. The navigation (list of
  deliverables) should then serve only as a navigation (basically a TOC). The checks should be per
  section. The refine and history needs to be rethink. Perhaps we shall abandon the bottom strip and
  make it part of the right content?"
- "B is the best" — the inspector-rail layout.
- "The editor should have switcher between edit and preview (let's remove the combined mode we have
  today). Both modes should have the same panels around (it just affects how the text is rendered).
  The rail (tool panel) should follow the scroll. Let's keep it per-deliverable for now."

## 1. What changes, in one paragraph

The Architect stops showing one deliverable at a time. The right side becomes a single continuous
document containing every deliverable in `order`, so a specification can be read top to bottom and
searched with Cmd+F. The deliverable list becomes navigation only. Per-deliverable machinery —
Check, Refine, History, state — moves out of the bottom console into a right-hand **inspector rail**
that follows the reader's scroll. The document's text renders either as Markdown source (**Edit**) or
as rendered Markdown (**Preview**); that switch changes nothing else on screen. The three-way
`Editor | Editor and Preview | Preview` switch and the bottom action console are removed.

## 2. Verified facts this design rests on

Measured during design, not assumed. Where something could not be verified, it says so.

| # | Fact | How |
|---|---|---|
| F1 | A whole-specification assembler already exists: `printDoc.js buildPrintDocument` concatenates every deliverable into one document (per-deliverable `<section>`, optional contents page, a title header only when the text does not already name itself) and never rewrites the text. | Read |
| F2 | **Heading ids collide across deliverables.** Two documents containing `## 2. Scope` both render `id="2-scope"`; markdown-it-anchor dedupes only within one render. In a 5-document page there were 5 duplicate ids and `querySelector` returned the first. | Rendered both docs; probed the concatenated DOM in Chrome |
| F3 | With all documents concatenated inside the pane's scroller (14,630px of range), the browser's text search **does** reach text in the last document and selects it. | `window.find` in Chrome, selection landed in section 5 of 5 |
| F4 | **Not verified:** whether Chrome's real find-in-page auto-scrolls the pane's *nested* scroller to a hit. `window.find` returned true but left `scrollTop` at 0 with the match at y≈15,174. `scrollIntoView` moves the container correctly, so the container is scrollable to it. Find-in-page is browser chrome and cannot be driven from the page. | Chrome probe; stated as a known unknown |
| F5 | **Cmd+F cannot work in Edit mode.** A real CodeMirror instance with a 600-line document renders **52** `.cm-line` elements; a marker near the end is absent from the DOM and browser find fails on it. | Bundled CodeMirror harness, probed in Chrome |
| F6 | Nothing in the Console intercepts Cmd+F — the only global keydown handlers act on Escape and Enter. | Grep of `src/console`, `src/fabry`, `src/docs` |
| F7 | The render cache is keyed `{id, text, dark, syncLines, withMermaid}` and `preload.js` already warms **every** deliverable with `syncLines: true`. Cached renders are copied out with `document.importNode`, so reuse cannot mutate the cache. | Read |
| F8 | `fabryArchDocView` is guarded by `DOC_VIEWS.includes(...)` on both read and write, so an unknown value is ignored rather than applied. | Read |
| F9 | Measured column widths in the mockup at a 1280px window: **664px** with both side columns open, **908px** with the list hidden, **1230px** with neither. | Mockup, browser-measured |
| F10 | The Console shell cannot scroll the window (`#app { overflow: hidden }`, fixed rail/sidebar/header), so an in-pane document is necessarily a nested scroller. | Read |

**The consequence of F5 + F3, stated plainly:** Cmd+F across the whole specification is a **Preview-mode
guarantee**. In Edit mode the focused editor captures Cmd+F and searches that deliverable's full text
only. Preview is therefore the default mode. The owner's two asks — one searchable page, and an Edit
mode that is a real mode — cannot both hold in the same mode; this is the honest split, not a defect.

## 3. Layout

```
┌ app rail ┬ deliverable list ─┬ document ─────────────┬ inspector ─┐
│          │ ▾ Specification   │ [✎ Edit|◑ Preview] ▷  │ Inspecting │
│          │   ● 1. Scope      │ ── section 1 header ── │ 2. Intake  │
│          │     1.1 In scope  │ (rendered or source)   │ ✗ Not met  │
│          │   ● 2. Intake     │ ── section 2 header ── │ [Check|…]  │
│          │   ● 3. Extraction │ …                      │ evidence   │
│          │ + Add   ▷ Run all │                        │ ✎ note     │
└──────────┴───────────────────┴────────────────────────┴────────────┘
```

Both side columns collapse from the document bar (F9 is the reason: 664 → 908 → 1230). Collapse state
is a global preference.

## 4. The unified document

### 4.1 One assembler, shared with print

Extract the per-deliverable assembly currently inside `buildPrintDocument` into a new pure module
`src/docs/specDocument.js`:

```js
buildSpecSections({ deliverables, displayTitle, results, md, options }) -> {
  sections: [{ id, slug, title, showTitle, meta, bodyHtml }], warnings
}
```

`printDoc.js` keeps its own wrapper (print classes, page breaks, contents page, link stripping) and
the unified view builds DOM sections with sticky headers. One concatenator, two presentations —
otherwise the printed specification and the on-screen one drift.

`showTitle` keeps F1's rule: a deliverable that opens with its own heading is not given a second one.

### 4.2 Heading ids are namespaced per deliverable

Because of F2, every id inside a section is prefixed with that deliverable's slug (`data-model--2-scope`).
New pure module `src/docs/idNamespace.js`:

- `namespaceSection(sectionEl, prefix)` — rewrites `[id]` only, and returns the original→prefixed map.
  **Authored hrefs are deliberately NOT rewritten** (corrected while locking interfaces, 2026-08-19):
  prefixing `#2.1` to `#data-model--2.1` would defeat the forgiving matching below, because the real id
  is `data-model--21-entities`. Ids move, hrefs stay as written — which also keeps the deliverable's
  text round-trippable — and `resolveInPage` reconciles the two.
- `resolveInPage(root, fragment, currentPrefix)` — resolution order: the current section first, then
  each section in document order, reusing `anchorResolve.js`'s forgiving matching (exact id →
  normalized → leading section number).

Applied to the **imported copy**, never to the cached render (F7), so `render.js` stays byte-faithful
to upstream and the cache stays shareable with the print path.

Two consequences worth having: a cross-deliverable link (`data-model.md#2.1`) becomes an **in-page
anchor jump** rather than a document switch, and the hover preview card keeps working unchanged
because it already resolves against a root it is given.

### 4.3 Text mode

`docView` becomes `'edit' | 'preview'`. It changes only how each section's body renders; the list, the
rail, the section headers and every action are identical in both (verified in the mockup: TOC entries,
rail tabs, section headers, pin and column width came out equal in both modes).

**Editor mounting.** In Edit mode a section renders its Markdown as a static source block, and becomes
a live CodeMirror **on focus** (click or keyboard). One live instance at a time; leaving flushes the
pending autosave exactly as `DeliverableEditor`'s unmount path does today. Rationale: N live editors
for N deliverables is unnecessary — an author edits one section at a time — and static source blocks
keep the rest of the specification in the DOM, so Edit mode degrades find gracefully instead of
hiding everything (F5 applies only to the focused editor). *This is a chosen default, not a
constraint: mounting every section live is a one-line change if the owner prefers it.*

### 4.4 The sticky section header

Identity and status only — the rail owns the actions, so the header carries the deliverable's title,
its state pill, its verdict pill and a stale marker, and nothing else. Clicking it targets that
deliverable explicitly (and moves the pin if one is set), which is also what a click in the navigation
list does. Keeping buttons out of it is what lets the document read as a document.

### 4.5 Which deliverable is "current"

Pure module `src/fabry/architect/specTarget.js`:

- `currentSection(tops, scrollTop, offset)` — the last section whose top is at or above the threshold.
- `railTarget({ spy, pinned, running })` — `pinned` wins; otherwise, while a run is in flight for the
  shown deliverable the target is **held**; otherwise the spy's answer.
- `activeHeading(headings, scrollTop, offset)` — same rule across all sections' headings, for the
  navigation highlight.

Held-during-run is not a nicety: a run started from the rail must not have its panel pulled away by a
scroll. Verified in the mockup — with a check running, scrolling to the end of the document left the
rail on the same deliverable and showed a "held while this check runs" badge.

## 5. The deliverable list (navigation)

Deliverables in `order`, each with a verdict dot, and their headings nested beneath. The entry for the
section being read is highlighted, driven by `activeHeading`. Clicking scrolls the one document.

It keeps the operations nothing else can own: **add**, **reorder** (drag), **rename**, **delete**, plus
**Run all** and **PDF** in its header/footer. "Navigation only" describes what it is *for*, not a
removal of these.

## 6. The inspector rail

Per-deliverable, following the scroll (owner). Header names the target and says whether it is
following or pinned; then tabs:

- **Check** — verdict, evidence, `Re-run`, `View investigation`; unchanged semantics, new home.
- **Refine** — the existing `RefineDock` flow, per-deliverable (owner: "keep it per-deliverable for now").
- **History** — the version list and diff from the work landed on 2026-08-18.
- **State** — the existing `StateControl`, in the rail header rather than a pane header.

**Diffs open at document width on request.** A word-diff in a 322px rail is unreadable, so Refine and
History carry "⤢ Open at document width", which renders the diff in the document column above that
section until dismissed. This replaces the width the bottom console used to provide.

## 7. Storage and backward compatibility

| Key | Change |
|---|---|
| `fabryArchDocView` | values become `edit` \| `preview`. A stored `split` maps to `preview` on read. An older build still understands both remaining values (F8), so the pref degrades in both directions. |
| `fabryArchTocOpen`, `fabryArchRailOpen` | **new**, global booleans, defaults true. |
| `fabryArchSplitRatio`, `fabryArchConsoleHeight` | orphaned. Left in place, read by nothing, migrated by nothing. |
| `fabryArchitectActive` | unchanged (per-tab id); now means "scroll to this section on open" instead of "open this pane". |

**No deliverable data changes at all.** Documents, `state`, `titleSource`, check results, implement
state and `kind:'revision'` history keep their existing shapes, so an older build opening the same org
still works and the version history written yesterday stays valid.

## 8. Modules

**New:** `src/docs/specDocument.js` (assembler, pure), `src/docs/idNamespace.js` (pure),
`src/fabry/architect/specTarget.js` (pure), `components/SpecView.jsx`, `components/InspectorRail.jsx`.

**Changed:** `DocView.jsx` generalized to adopt **N sections** and initialise the document behaviours
(copy buttons, hover previews, resource modal) **once for the whole page** rather than per document —
it already owns that wiring plus the hard-won "callbacks must never reach the adopt effect's deps"
lesson, so this is reuse, not a rewrite. `ArchitectSidebar.jsx` becomes the navigation tree.
`architect/store.js` (mode values, collapse prefs, target signals). `printDoc.js` (uses the shared
assembler). `PdfDialog` scope "this deliverable" now means the current rail target.

**Removed:** `DeliverableEditor.jsx` is **deleted**. It is the per-deliverable pane, and there is no
longer one: its document bar moves into `SpecView`, its PDF action and warnings strip move to that bar,
its outline wiring is replaced by §4.5, and its console tabs move into the rail. `HistoryPanel` and
`RefineDock` are **kept and reused** inside the rail; only their host disappears. The three-way switch
goes with it.

Store signals: `activeHeading` / `setActiveHeading` and `navigateOutline` / `setOutlineNavigator` are
reused as-is — the navigator now scrolls the one document instead of a single-deliverable pane, which
is a change of implementation behind the same seam.

## 9. Performance

The switch cost is rendering, and it is already paid: `preload.js` warms every deliverable with the
exact cache key this view needs (F7), so assembling the page is DOM assembly from cached renders, not
rendering. Mermaid stays lazy. Sections are all in the DOM by design — that is what makes F3 true —
so there is no virtualisation to add; if a specification ever grows large enough to hurt, the honest
fix is to say so rather than to virtualise and silently break Cmd+F.

## 10. Testing

Pure and unit-testable: the assembler's section descriptors (including F1's own-heading rule), id
namespacing and in-page resolution (F2's collision as a fixture), `currentSection` / `railTarget` /
`activeHeading` (including held-during-run and pinned), and the `split`→`preview` migration.

Component tests: mode switch changes only the body, navigation click scrolls, rail retargets on scroll,
rail holds during a run, diff opens at document width, list operations still reachable.

Not unit-testable (jsdom has no layout): column widths, scroll-spy geometry, Cmd+F. These get the
repo's usual browser harness treatment — the mockup already measured F9 and the mode-equality claim.

## 11. Honest limits

- **Cmd+F is Preview-only** (F5). Edit mode gives the focused editor's own search over one deliverable.
- **F4 is still open**: whether find-in-page scrolls the nested scroller to a hit. One keystroke in the
  real build settles it. If it does not, the fallback is a standalone reading page (window-scrolled,
  the mechanism the print page already uses) — not built here.
- Refine stays per-deliverable; a whole-specification Refine is explicitly deferred.
- The rail occupies width even while only reading; collapsing is the answer, and F9 quantifies it.
- This is the largest change to the Architect since it shipped. It should land as its own commit on
  top of the currently staged work, not mixed into it.

## Revision v2 (2026-08-19) — what implementation changed

Three corrections, all found while building, two of them by measuring in a browser:

1. **Authored hrefs are not rewritten** (§4.2, already corrected in place). Prefixing `#2.1` to
   `#data-model--2.1` would defeat the forgiving fragment matching, since the real id is
   `data-model--21-entities`. Ids move, hrefs stay, `resolveInPage` reconciles.
2. **A scroll listener belongs to the effect that owns the element.** §4.5 assumed the parent could
   attach the spy. It cannot: a mode switch remounts `DocView` and builds a new `.docs-root`, and the
   parent's effect deps (`[sections]`) do not change across a switch — so the listener kept listening
   to the destroyed node and the spy died permanently after one switch, with every unit test green.
   `DocView` and `SourceColumn` now own their listeners and pass their live API into the callback.
3. **Collapsing the list is a grid-column change in the Fabry shell**, not something the Architect can
   do alone (`src/fabry/components/App.jsx` sizes the sidebar column). The spec did not say where that
   wiring lives; it does now.

**Measured against the approved mockup** (real components, headless Chrome, 1280px viewport): reading
column **646 / 906 / 1228px** for both-open / list-hidden / neither, against the mockup's 664/908/1230
— the 18px is a 260px harness list versus the mockup's 244. Chrome is identical between Edit and
Preview (4 section headers, 4 rail tabs, 4 list rows, 4 outlines, same width); focusing a section in
Edit mode mounts exactly **one** live editor and leaves the other three as findable text; the spy
retargets at 3000/3900/1200px and keeps working after a mode switch; a run holds the target and
releases it; the pin holds through scrolling; **zero duplicate ids** on a page whose deliverables share
heading text; no sideways overflow; dark mode legible (document 16/245, rail 28/222).

Suite: **318 files / 3395 tests**, all passing, from 310/3356 before this change.

## Revision v3 (2026-08-19) — owner feedback after first use

Six changes, each measured in a browser against the built code:

1. **The list no longer repeats a deliverable's title.** A document starting `## 1. Overview` put the
   same words on the row and one line below it, since the row uses `displayTitle` (which prefers the
   document's own heading) and `extractOutline` lists h2/h3. `outlineWithoutTitle` drops the entry on
   the document's first non-empty line — by LINE, because two headings may legitimately share a title.
   Verified: an h2-titled deliverable now lists only its sub-heading.
2. **Edit matches Preview's column exactly.** Both elements now CARRY `.markdown-body` for its box
   instead of restating it. The restatement was wrong in a way worth remembering: the ported sheet has
   an `@container (max-width: 767px)` branch dropping the padding to 15px, and a 646px reading column
   is inside it — so a copied `45px` made Edit narrower. Measured after: `left 312 / right 958 /
   content 616 / padding 15px` in both modes.
3. **The deliverable list is not collapsible.** The toggle, the `tocOpen` signal and the
   `fabryArchTocOpen` key are gone, and the Fabry shell's grid wiring is back to always rendering the
   sidebar — no orphan pref left behind.
4. **The inspector is drag-resizable** from its left edge: `railWidth` (clamp 260–620, persisted as
   `fabryArchRailWidth`), live during the drag and persisted on release. Measured: 322 → 442px, the
   document column reflowing to 526px.
5. **Navigation is ~7× faster.** `scrollIntoView({ behavior: 'smooth' })` took **≥1481ms** for a
   ~13,000px jump (sampling stopped at 1500ms); `animateScrollTop` — the tween this repo already
   hand-rolled for exactly this reason — takes **198ms**. Chrome's smooth duration scales with
   distance, which is why it only felt sluggish once the whole specification became one page.
6. **The inspector follows a settled target** (`RAIL_SETTLE_MS` 120ms) and the spy geometry is cached.
   Over a 60-frame scroll: **44 rail mutations → 0**; the geometry read **0.136ms → 0.001ms** per frame
   (136×). Explicit clicks bypass the delay entirely; the list highlight stays live, because it is
   cheap and it is what gives immediate feedback while scrolling.

Two measurement traps worth recording, both of which produced false "it doesn't work" readings during
this pass: **reading the DOM synchronously after a click or a signal write** shows pre-flush state
(Preact batches into a microtask — measure across an IPC round-trip), and **a harness whose shell is a
flex item without `flex: 1`** does not stretch, which made the document column measure 193px.

Suite: **318 files / 3405 tests**.

## Revision v4 (2026-08-19) — second round of owner feedback

Two of the four items were regressions I introduced, and both are worth remembering:

1. **"Download PDF" was gone.** It lived in the deliverable pane and was deleted with it; nothing called
   `openPdfDialog`, `printAction.js` and `PdfDialog.jsx` were orphaned, and §5/§8 of this spec claimed
   the sidebar had kept it. The flow is now `architect/pdfAction.js openPdfFlow`, the document bar owns
   the button, and the bar carries its outcome note and document warnings the way the pane did. Lesson:
   when a host is deleted, enumerate the ACTIONS it owned, not just the components it rendered.
2. **The inspector width was saved but never restored.** `chrome.storage.local.get([keys])` returns only
   the requested keys, and the boot read list had never been updated — so the read was `undefined`
   for ever. One `PREF_KEYS` list now feeds the read, and a test scans the module's writes and asserts
   the list covers them.

The other two were design corrections:

3. **Edit mode is fields, not prose that becomes an editor.** Every deliverable renders in an auto-sized
   `<textarea>` immediately; the click-to-activate CodeMirror is gone, and `MarkdownEditor.jsx` was
   deleted with it (so `@codemirror/lang-markdown` is now unused). Honest cost: no syntax highlighting
   while editing. Fields are uncontrolled with a seed-and-sync effect, and pending edits are per
   deliverable now that all of them are editable at once.
4. **Navigation and switching behave the same in both modes.** Heading offsets in source are measured
   with a metrics-matched mirror (`sourceGeometry.js`), because `line * lineHeight` drifts by hundreds
   of pixels once paragraphs wrap; and a mode switch restores the deliverable being read instantly
   (6507 → 6157 → 6507px across Preview → Edit → Preview).

Also removed as dead: the bottom console's `fabryArchConsoleHeight` machinery.

**Measurement notes from this pass** (all three cost me a wrong conclusion first): scrolling a harness
by assigning `scrollTop` does NOT notify the spy — dispatch the event, or the restore correctly restores
the stale target; a test file without `vi.clearAllMocks()` hands you the PREVIOUS test's callbacks, which
belong to an unmounted component; and this machine's `grep` is ugrep, whose pattern handling silently
matched nothing twice, which is why two edits appeared to apply and had not.

Suite: **317 files / 3404 tests**.

## Revision v5 (2026-08-19) — Markdown highlighting comes back

The owner wants highlighting while editing, which reverses v4's textarea decision. What made it
affordable is a measurement: CodeMirror at CONTENT HEIGHT inside the page's scroller mounts five
700-line editors in **70ms**, has an inner scroll range of **0** (so the specification stays one
document), and still renders only the visible lines (**79 of 3500**) — so an editor per deliverable is
cheap, and fast scrolling stays cheap.

`components/SourceEditor.jsx` replaces the textareas; `architect/sourceGeometry.js` (the mirror written
for them) is deleted. Cmd+F remains a Preview-mode guarantee, unchanged and for the same reason.

**The navigation lesson, in the order it was learned** — worth keeping, because three plausible
approaches failed before the right one:

1. `line * lineHeight` — wrong as soon as anything wraps.
2. A metrics-matched mirror element — correct for textareas, and gone with them.
3. `lineBlockAt(pos).top` arithmetic — **CodeMirror estimates unrendered line heights and the estimate
   assumes one visual line**, so a click on a heading 500 lines down landed at the section start.
4. A bounded re-measure-and-correct loop — still drifted two or three headings, because each landing
   changes the estimates it was correcting from.
5. **What works:** CodeMirror's own `EditorView.scrollIntoView`, which re-measures as it goes and —
   verified — scrolls the ANCESTOR scroller when the editor has no scroll range, plus one exact
   correction from `coordsAtPos` once the target line is rendered. All five probe entries land on the
   clicked heading.

The scroll spy keeps using estimated tops deliberately: they are accurate near the viewport, which is
the only region the highlight reports on.

Suite: **317 files / 3404 tests**.


---

## Revision v6 (2026-08-19) — one badge: the manual state is dropped

Owner, after asking what "Verified" was for when "Met" already exists: *"OK, let's drop the manual
labels. Let's rely only on the LLM (programatic) labels."*

**What was there.** Three badges could sit on one deliverable at once:

| Badge | Set by | Answers |
|---|---|---|
| `Verified` / `Ready` / `In progress` / … | the author, by hand | "how finished do I say this is" |
| `✓ Met` / `✗ Not met` / `? Uncertain` | Fabry's read-only check | "does the org actually satisfy it" |
| `stale` | derived from `editedAt` vs `ranAt` | "when was that measured" |

The first two answered the **same** question in two voices, which is the whole defect: a reader facing
`Verified` beside `✗ Not met` has to decide which to believe, and the design offered no way to. The
one nobody can assert into existence is the measured one — Fabry re-derives it from live org state on
every run — so it is the one that stays.

`stale` was never a third status. It qualifies a verdict, so it becomes a **suffix on the same pill**
(`? Uncertain · stale`) with the **fill removed** and the verdict's hue kept in text and border:
measured 2026-08-19 in headless Chrome — a fresh pass is `bg rgb(209,250,229)`, a stale uncertain is
`bg rgba(0,0,0,0)` with `fg rgb(146,64,14)` — the same claim, visibly not fresh. Both themes checked
(dark ground `rgb(13,17,23)`, stale `fg rgb(245,158,11)`, transparent fill).

**What was removed.** `architect/stateLabel.js`, `components/StateControl.jsx`,
`tests/fabry-architect-state.test.js`, `api.saveState`, `actions.setDeliverableState`, the
`state`/`stateDate` read in `mapDocs`, the state column in `docs/contents.js`, `stateBadge`/
`STATE_LABEL` in `docs/printDoc.js`, the PdfDialog "State badge" option (`PDF_KEYS` is now
`['contents','verdicts']`), and 62 lines of state CSS. `CheckBadge` is exported from `SpecView.jsx`
and used by both the section header and the inspector rail, so the two can never disagree.

**Backward compatibility.** Existing documents KEEP their `state`/`stateDate` fields — `mapDocs`
stops reading them and nothing writes them, but nothing deletes them either: retiring a feature must
not delete customer data, and a document written by yesterday's build stays readable by both. A
`state` value arriving from an older build (or hand-edited through MDH) now renders nothing at all,
which is the correct outcome and is pinned by a test that feeds `state: 'verified'` through
`loadDeliverables` and asserts the field never reaches a deliverable.

**The old markup still warns.** `docWarnings.js` is unchanged in mechanism and reworded in message:
`<state-label>` and its near-misses render upstream's dashed-red error pill plus a `file:line`
warning saying the element is not supported here and that a deliverable's status comes from its check
verdict. Without it they render as literally nothing — markdown-it passes the unknown tag through,
the sanitizer unwraps it, and a browser draws an unrecognised custom element as empty space. That
silence is what the owner hit with `<section-state>` in the first place, so the bridge earns its keep
even now that neither the element nor its replacement exists.

**Honest cost, recorded rather than hidden:** `tests/docs-render-equivalence.test.js` still says in a
dedicated block that `states.md` is no longer byte-equivalent to upstream localpages' own output. That
was already true when states became an Architect property (Revision v2 of the port spec); dropping
them does not make it less true, and quietly deleting the fixture would.

Suite: **316 files / 3391 tests**, green.

---

## Revision v7 (2026-08-19) — what a pre-commit code review found

Five defects, all in code this spec describes, all confirmed by measurement rather than reasoning.

**1. `SpecView.jsx` was staged as a BINARY file.** Its slug memo key was written with literal
`\x00`/`\x01` bytes instead of the two-character escapes. Two silent consequences: `git diff
--numstat` reported `-  -`, meaning a 345-line component would have been committed as an opaque
blob with no line diff, no blame and no textual merge; and ugrep's `-I` (skip binary) excluded the
file from every search, so repeated `grep` sweeps over `src/` came back clean while the largest new
component was never actually read. Defect 2 is what that hid.

**2. `ReviewHost` was referenced and never defined.** `headerFor` renders it for a
`reviewTarget`, and nothing declared or imported it — `RefineDock` and `HistoryPanel` sat imported
and unused beside it, and its CSS (`.fabry-spec-review*`) was already in `console.css`. Browser-
confirmed: setting a review target throws `ReferenceError: ReviewHost is not defined` as an
unhandled rejection inside Preact's async render, which takes the whole Architect view down and
does not recover (a following mode switch then rendered zero editors). No test reached it, because
mounting `SpecView` is not enough — the target has to be set. Written, plus three tests.

**3. Edit mode ignored WHICH deliverable's heading was clicked.** `scrollToSlug` took only the
slug and scanned in document order, so with `## 2. Scope` in two deliverables — both slugging to
`2-scope`, the very collision §F2 exists to handle — asking for the second landed at scrollTop 49,
inside the first. The deliverable id now travels in the shared options argument and its own section
is searched first; measured 49 → d1 and 2196 → d2.

**4. Section jumps in Edit mode landed short.** CodeMirror estimates unrendered line heights as one
visual line, so an arithmetic target moves as the trip renders the region: computed 4725, section
settled at 5153, **428px short** — and the mode-switch restore had been landing short in the same
way while measuring as "each mode's own layout". The jump now tweens and then corrects from the
element's live rect (≤3 passes, 2px tolerance, a monotonic `seq` so a newer jump wins). All three
targets land at offBy 0, and the restore holds a section at 0 across Preview → Edit → Preview.
Section geometry also moved from `offsetTop` to rects: they agree today (4393 == 4393) only because
`.docs-pane` shares the scroller's top edge.

**5. Dead code the deletions left behind.** `DocView`'s `onOutlineScroll` hook had no producer, so
`src/docs/syncScroll.js` and `api.anchors` were reachable only from a passing test;
`architect/menuPlacement.js` was imported by nothing but its own test (the state picker it placed is
gone); `splitRatio` still WROTE `fabryArchSplitRatio` while nothing read it, justified by a comment
whose logic ran backwards; and 23 `fabry-*` CSS classes (~7.4KB) belonged to the deleted pane, split
columns and bottom console. All removed; an audit now reports zero dead `fabry-*` classes.

**A real regression came out of that last sweep.** The `@media print` block still tore down the OLD
shell — including `.fabry-side`, which never matched anything (the element is `.fabry-sidebar`), so
the Fabry sidebar had been printing all along. It now hides the app rail, the Fabry sidebar, the
specification bar, the review host and the inspector rail, unwinds `.fabry-spec` instead of the
deleted pane classes, and un-sticks the section headers. Verified with headless Chrome
`--print-to-pdf`: 19 flowing pages, page 1 rasterized and read — document only, no chrome. `Cmd-P`
in Edit mode prints the Markdown source, which is what is on screen; the ⤓ PDF button remains the
path that always prints the rendered document.

Suite: **314 files / 3371 tests**, green.
