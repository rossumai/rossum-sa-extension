# MDH Stages: a two-way stage link, and a source that isn't "stage 0"

**Status:** implemented
**Date:** 2026-08-12
**Origin:** three owner requests, in order —
1. *"I like the blue highlight of the aggregation pipeline stages. When showing the dashed
   line, we should also highlight the relevant stage with the blue background."*
2. *"Would it be possible to also show the blue background and the dashed line when clicking
   into the aggregation pipeline editor (vice versa)?"*
3. *"Improve the design of the '0' input phase to make it more understandable that it's
   actually nowhere in the aggregation pipeline."*
4. *"When hovering over the aggregation pipeline stages, I should also see the light blue
   background and the dashed lines."*
5. *"When the aggregation stage doesn't return any results, let's use Fabry to better explain
   why is it the case."*
6. *"Show a fast scroll animation instead of just jumping so users understand what's going on."*

## What this is

Hovering a section in the Stages view already draws a dashed SVG connector to that stage's
code in the pipeline editor (`StageLinkOverlay.jsx` + `stageLink.js`), and already turns the
hovered section's border accent (`.pipeline-inspect-section:hover`, `console.css`). Only the
editor end of that link was unmarked: the line simply ended on bare code.

This adds a tinted band behind the linked stage's lines, so both ends of the connector are
marked. Nothing else changes.

## Decisions (owner, 2026-08-12)

1. **The editor band only.** Not the records-pane section tint — the hovered section already
   gets an accent border at `console.css`'s `.pipeline-inspect-section:hover`, so a second
   marker there would be redundant.
2. **Not gated on the `Auto-scroll` option.** That checkbox governs scrolling, and the
   connector it accompanies has never been gated either. So with `Auto-scroll` off, hovering
   still tints the stage; the connector hides when the stage is off-screen
   (`stageScreenRect` returns null), but the band is waiting when the user scrolls to it.
3. **Hover-reveal is unchanged.** With `Auto-scroll` on, hovering still scrolls the editor to
   centre the stage, exactly as before. **SUPERSEDED 2026-08-14 — it now scrolls only when the
   stage is off screen, and to the top rather than the centre. See the revision note at the
   end.**

## How it works

- **`console.css`** — `.cm-linked-stage { background: var(--info-bg); }`, sitting with the
  other `.stage-link-*` rules. `--info-bg` is this stylesheet's accent-paired tint (there is
  no `--accent-bg`) and is defined in both the light `:root` block and the
  `prefers-color-scheme: dark` override, so the band follows the theme. A fill rather than a
  border, so it does not read as a second copy of the section's accent border.
- **`JsonEditor.jsx`** — a `StateField` holding the highlighted stage's **entry index**, with
  `Decoration.line` applied to that stage's lines, exposed as
  `editorRef.current.highlightStage(entryIndex | null)`. Registered only in the
  `mode === 'aggregate'` branch, so no other `JsonEditor` in the app is affected.
- **`StageLinkOverlay.jsx`** — sets the band alongside the existing `revealStage` call, and
  clears it in the effect's cleanup, which covers un-hover, hovering a different stage, and
  unmount.

**Why the field stores an index, not a text range.** The source of truth is which Stages-view
section the pointer is over, and that is an index — so re-deriving from the current document
keeps the band on the section being hovered rather than on the text that used to be there.
It also sidesteps a real trap: `LineDecoration` maps with `MapMode.TrackBefore`, so mapping
the decorations through a change **drops** the band outright when the line break in front of
it is deleted, and a mapped position is not necessarily at a line start. Both behaviours are
pinned by tests (`tests/mdh-stage-link-highlight.test.js`), each verified to fail against the
naive implementation.

Cost: one `stageLineRanges()` parse per edit, only while a stage is highlighted. The editor's
`updateListener` already runs `JSON5.parse` on every `docChanged`, so this is the same order
of work, not a new one.

## The link runs both ways (request 2)

The caret in the pipeline editor now drives the same connector and the same band, from the
other end. Owner decisions (2026-08-12):

1. **Any caret move into a different stage**, not clicks only — so it follows arrow keys and
   search jumps too, and reuses the existing `onCursorStage` plumbing rather than adding a
   click handler.
2. **Persists while the caret is in that stage**, clearing when it leaves every stage or the
   editor loses focus.
3. **Hover wins while hovering**, falling back to the caret when the pointer leaves. Exactly
   one connector is ever drawn.

Not gated on `Auto-scroll` (matching the hover band), and it never calls `revealStage` — the
caret is on screen by definition, so scrolling to it would yank the view out from under the
user's own cursor.

**Two index spaces, and why both are needed.** `activeStageIndexAtOffset` returns the ACTIVE
index (skipping disabled stages) — that is what the existing scroll jump needs, because it
addresses a stage's *output*, and a disabled stage produced none. The link needs the ENTRY
index, because the Stages view renders a section per entry, disabled ones included. So
`entryIndexAtOffset` was added beside it rather than folding a flag into the existing
function, and `onCursorStage` now reports `{ entryIndex, activeIndex } | null`. The dedup
sentinel starts at `undefined`, distinct from `null` — without that, the first "left all
stages" would be swallowed and the link would never clear.

> **Superseded 2026-08-14.** With the scroll jump gone there is only one index space left:
> `activeStageIndexAtOffset` was deleted and `onCursorStage` reports a bare entry index. The
> dedup-sentinel point below still holds. See the revision note at the end.

The caret carries no DOM node, so `StageLinkOverlay` resolves the section itself from
`[data-entry]` (now stamped on active *and* disabled sections) on every recompute. That also
means it draws nothing when the Stages view is closed — correct, since there is no section to
link to.

## Hovering the editor lights the same link (request 4)

A third source, alongside the section hover and the caret: `editorHoverStage`, fed by a
CodeMirror `mousemove`/`mouseleave` handler that maps pointer position to an entry index via
`posAtCoords` + `entryIndexAtOffset`. Precedence is **hoveredStage > editorHoverStage >
caretStage** — either pointer source beats a resting caret, and the two hovers are mutually
exclusive in practice since there is one pointer.

Two things fell out of it, both owner decisions (2026-08-12):

- **The reveal is now symmetric.** Hovering a section already scrolled the editor to that
  stage; hovering a stage in the editor now scrolls the pane to its section (`block: 'nearest'`,
  same `Auto-scroll` gate). The caret still scrolls nothing — a caret is not a gesture asking to
  be taken somewhere. **REVERSED 2026-08-14 — see the revision note at the end.**
- **The connector no longer draws toward an off-screen target.** `computeStageLink` never
  checked visibility; hovering a *section* could not expose that (you can only hover what you
  can see), but the caret and editor-hover links can, and the line would run off over the
  toolbar. `sectionInPane()` now suppresses the line when the target is scrolled out of the
  pane, leaving the band to carry the link. This was a defect introduced with the caret link
  in the same day's work. **The diagnosis stands; the remedy changed 2026-08-14 — the line is
  clamped to the pane's edge instead of suppressed. See the revision note at the end.**

`.pipeline-inspect-section[data-linked]` marks the section end when the pointer is in the
editor, since its own `:hover` cannot fire in that direction — the same accent border, reached
from the other end. An attribute, not a class, for the usual reason: Preact rewrites
`className` wholesale when `sectionCls()` changes for the `inspectTarget` flash.

The `mousemove` handler would otherwise run a whole-document `JSON5.parse` per pointer move, so
`stageLineRanges` is now memoized on the CodeMirror `Text` object's identity (immutable, so
identity implies identical content and the key cannot go stale). The caret path shares the memo.

## Mr. Fabry explains an empty stage (request 5)

When a stage returns nothing, "No documents at this stage" still shows — and below it a Fabry
panel in the shared Inspector Diagnosis identity (`--diag-*` purple, `FabryMark`, two
`inspector-esec-skel` shimmer bars and a cycling activity line while it works, then the
streaming narrative via `FabryNarrative`, credited and hedged in the footer).

Owner decisions:

- **Automatic**, not on demand. (I recommended on-demand — an agent call per intermediate empty
  state while typing — and was overruled; noted here so the cost is a known choice rather than
  an oversight. It is bounded by `explainSignature`: the same empty pipeline is explained
  exactly once, and a pipeline that moves on aborts the stream in flight.)
- **The first empty stage only.** Once a stage emits nothing every later one almost always does
  too, so the useful question is which stage emptied the result. ($unionWith and $documents can
  produce rows from an empty input; rare enough that one explanation is the right trade.)
- **Pipeline + counts + schema hints** — the same `getSchemaHints()` the AI query box already
  sends for this collection. Hints are derived in the browser; whole documents never reach the
  agent. It is usually a distinct value that explains a `$match` matching nothing.

Gated on `aiAvailable` (the `/health` probe), like the AI query box — not on
`experimentalUnlocked`. `firstEmptyStage` deliberately returns -1 while any earlier stage is
still loading or has errored: guessing mid-load would explain a stage that a moment later is
not the culprit, and an errored stage already shows its own message.

**Layout.** The empty-stage body override is written as the COMPOUND selector
`.pipeline-inspect-body.pipeline-inspect-body-empty`. The single-class version silently did
nothing: `.pipeline-inspect-body` sets the fixed height ~65 lines further down the file and at
equal specificity the later rule wins, so the 324px band survived and the message still sat on
a wall of whitespace. jsdom has no layout engine, so the test asserting the class was applied
passed while the height never collapsed — the selector carrying its own weight is the guard.

The panel is a child of the `<section>`, placed after `.pipeline-inspect-body` —
NOT inside `.pipeline-inspect-output`, which is a horizontal flex row of record cards, so a
panel there becomes a card-sized sibling beside the message rather than a full-width block
under it. An empty stage also drops the fixed 324px records band
(`.pipeline-inspect-body-empty { height: auto }`): that band exists to keep RECORDS uniform,
and an empty stage has none, so it was 324px of nothing pushing the answer down. The panel is
capped at 260px with its own scroll so one verbose answer cannot dwarf the pane.

**The empty message is a warning band.** Muted grey italic was easy to scroll past once the
records band stopped reserving 324px for an empty stage, so it is now
`--warning-bg`/`--warning-fg`/`--warning-border` with a ⚠ icon, spanning the stage (`flex: 1`,
since its parent is a horizontal flex row of record cards). Warning rather than danger on
purpose: `--danger` is this pane's colour for a request that FAILED
(`.pipeline-inspect-error`), whereas an empty result means the query ran fine and matched
nothing — keeping the two apart is what lets a genuine error still stand out. The header's zero
count remains `--danger` (`.pipeline-inspect-zero`); that is pre-existing and was left alone.

**Rendering + prose.** The answer renders as Markdown (`FabryMarkdown`), so field names and
values come through as inline code, and it is shown in full — no inner scroll. A nested
scroller inside an already-scrolling pane hides that there is more and makes the wheel fight
over which region moves; the answer is short by construction and the section is content-sized.

**The agent was refusing outright, and the prompt was the cause.** Unframed, it answered:
*"This question is about debugging a MongoDB aggregation pipeline, which isn't related to the
Rossum document processing platform. I'm a Rossum platform specialist…"* — a scope refusal, not
mere padding. The prompt now opens by establishing what this actually is: Master Data Hub
stores a customer's master data as collections in **Rossum's Data Storage**, and Rossum MDH
matching hooks query them with aggregation pipelines while a document is extracted. It then
states plainly that this IS a Rossum question and forbids scope commentary, preambles,
restatements and apologies. Pinned by tests — prompt wording regresses silently.

**The agent can now see the pipeline as WRITTEN, not just as run.** `debugEntries` is the
*substituted* form, so the agent saw rendered literals and could not distinguish a hard-coded
value from an unfilled variable. Verified at `usePipeline.js:237`: an unset variable substitutes
as an **empty string**, so `{"country": "{country}"}` runs as `{"country": ""}` and the agent
would advise loosening a filter when the real fix is to fill the variable in. The prompt now
carries both forms plus a variable table marking each one set or NOT SET, and states the two
substitution rules that change what a stage means (empty-string-for-unset, and type-aware
substitution turning `"{qty}"` into `5`). `DataPanel` derives the raw form with the same
`parseEntries` on the unsubstituted text, and passes null when it does not parse or when the
two forms disagree about stage count — misaligned forms would be worse than none. The written
form is part of the cache signature too: swapping a literal for a variable of the same value
leaves the run form byte-identical while changing what the correct advice is.

**Nothing is re-investigated for an unchanged pipeline.** Two separate causes were fixed:

- Toggling the source card used to clear every stage preview and refetch all of them, because
  `sourceOpen` had been added to the stage-preview effect's deps. That briefly unmounted the
  panel and restarted the investigation on every expand or collapse. The source sample now has
  its own effect, so a toggle costs exactly one request and touches nothing else.
- A module-level cache in `explainEmpty.js`, keyed by the same signature, lets any other
  remount (List/Table and back) reuse the answer instantly. Successful answers only — caching a
  failure would turn one transient blip into a permanently stuck error with no way to retry.
  Capped at 20 with recency eviction; in memory, never persisted.

`EmptyStageExplain` owns its request and its streaming text rather than lifting them into
`StagesView`, which renders every `RecordCard` in every stage — holding the text up there would
re-render the whole pane on each token.

**A bug this shipped with, and how it was found.** The panel never appeared: every affected
stage sat on "Loading…" forever. Root cause was a render-time `TypeError` —
`useStageCounts` returns `counts` as an **object keyed by active index**, not an array
(`useStageCounts.js:12`), and the new prop mapped it with `.map()`. Every other use in
`StagesView` is index access, which reads identically on an object and an array, so the shape
was assumed rather than checked. The throw aborted the render, which is why the symptom was a
stuck "Loading…" (`StageOutput`'s state for an unresolved preview) rather than a missing panel
or a visible error. Reproduced with a mounted `StagesView` before fixing; the suite had no test
that mounted the component at all, which is exactly why a green run hid it. Pinned now by four
tests that mount it with a mocked agent.

## Reveals animate (request 6)

Both hover reveals now tween over ~180ms with an ease-out instead of teleporting
(`src/mdh/smoothScroll.js`: pure `easeOutCubic`/`tweenAt`/`nearestScrollTop` plus a thin
`animateScrollTop`). Hand-rolled rather than `behavior: 'smooth'` for two reasons: the
browser's smooth duration is not controllable and runs ~300-500ms in Chrome, which is too slow
for something that fires on hover; and **CodeMirror's `EditorView.scrollIntoView` effect has no
behaviour option at all** — it is always instant, so the editor side had to compute its own
target regardless. `prefers-reduced-motion` falls back to an instant jump, a sub-2px move is
never animated (it would read as a nudge), and one in-flight tween per element is cancelled on
retarget so rapid hovers do not fight.

Animating the editor forced a fact back into the code that the reverted scroll-sync work had
established: **`.cm-scroller` is not the editor's scroller here.** `console.css:408` makes the
outer `.json-editor` the scroller, and the generic `.json-editor .cm-editor { flex: 1 }` has no
`min-height: 0`, so `.cm-scroller`'s `height: 100%` never resolves. Writing
`view.scrollDOM.scrollTop` would silently do nothing — `revealStage` only worked before because
CodeMirror's own effect walks up to the real scrollable ancestor. `scrollerFor()` picks
whichever candidate has the LARGER range rather than a bare `>` test, because the measured
layout sits exactly on that threshold and these properties are integer-rounded while wrapped
line heights are not.

The caret jump and the debug-panel jump are unchanged (still instant): they fire on discrete
intent, and the caret one fires on every caret move into a new stage.

## The source, not "stage 0" (request 3)

A MongoDB pipeline has no stage zero. The input was rendering with the same number badge, the
same solid card and the same rhythm as stages 1…N, so it read as one of them. Five treatments
were mocked up for review; the owner chose a combination of three:

- **Quiet card** — dashed and unfilled rather than solid: a different *class* of object,
  legible before any word is read. Deliberately not dimmed with `opacity` the way
  `.pipeline-inspect-disabled` is — that means "did not run", which is the wrong idea.
- **Unnumbered** — no badge; labelled `source` with the collection's own name, so the numbered
  list visibly starts at 1.
- **Collapsed by default, expandable** — a `.pipeline-inspect-start` divider ("pipeline starts
  here · N stages") sits beneath it, stating the boundary rather than leaving it to be inferred.

Collapsing also **saves one aggregate per Stages open**: the sample is fetched only while the
card is expanded. The document count still shows either way, because that comes from the
`$collStats` probe in `useStageCounts`, not from the sample. The divider's count says
"2 of 3 stages run" when any stage is disabled, so it can never disagree with the numbered
sections directly below it, and is omitted entirely for an empty pipeline.

The toggle is a real `<button>` with `aria-expanded`, so it is keyboard-operable and reports
its state. State persists as `mdhStagesSourceOpen` (default `false`), following the existing
`mdhStagesShowDef` pattern exactly.

## Backward compatibility

No usage events added or changed. `mdhStagesAutoscroll` keeps its name, type, default and
meaning — it still gates the hover reveal and the caret's scroll jump, and gates neither band.
The `editorRef` API grows by one method (`highlightStage`); `revealStage` and
`stageScreenRect` are untouched. `.cm-linked-stage`, `.pipeline-inspect-source*` and
`.pipeline-inspect-start` are new classes with no other references.

Two additions, both purely additive:

- **`caretStage`** — a new store signal, in-memory only, never persisted.
- **`mdhStagesSourceOpen`** — one new `chrome.storage.local` key, boolean, default `false`,
  read with a `typeof === 'boolean'` guard so an absent or junk value falls back to the
  default. An install that has never seen it simply gets a collapsed source card.

`onCursorStage`'s payload changed from a bare active index to `{ entryIndex, activeIndex } |
null`. It has exactly one consumer (`DataPanel.handleCursorStage`) and no test pinned the old
signature. One behavioural nuance worth recording: moving the caret from a stage into a
disabled stage and back out again now re-fires the scroll jump, where before it did not,
because the dedup key is the entry index rather than the active index. That is arguably more
correct and is harmless.

## What was reverted, and one fact worth keeping

This band is the only surviving piece of a continuous scroll-sync feature (spec and plan
dated 2026-08-11, both deleted with the code) in which the two panes scrolled each other,
interpolated per stage. The owner rejected it. Do not rebuild it without a fresh decision.

One durable, non-obvious fact was established while verifying it, and is easy to trip over
again: **the pipeline editor's scroller is NOT `view.scrollDOM`.** `.cm-scroller` has
`scrollHeight === clientHeight` and `maxScrollTop === 0` here, because
`console.css`'s `.data-panel-left .json-editor { overflow: auto }` makes the outer
`.json-editor` the real scroller while the generic `.json-editor .cm-editor { flex: 1 }` omits
`min-height: 0`, so the flexbox `min-height:auto` trap stops `.cm-scroller`'s `height: 100%`
resolving. Anything that reads or writes `view.scrollDOM.scrollTop` in this editor silently
does nothing. No unit test can catch that — it is a pure layout fact and jsdom has no layout
engine. Nothing in the current code depends on it; it is recorded here so the next attempt
does not lose a day to it.

## Revision, 2026-08-14 — the editor no longer scrolls the Stages pane

Owner decision, reversing the "symmetric reveal" above: **the pipeline text editor must not
move the right pane.** Pointing at a stage in the editor still MARKS its section — band,
connector, `[data-linked]` — but nothing scrolls. Two paths were removed:

- the editor-hover pane scroll in `StageLinkOverlay` (`animateScrollTop` + `nearestScrollTop`
  on `.pipeline-inspect-scroll`);
- the caret's `inspectTarget` jump in `DataPanel.handleCursorStage`, which also took the
  section's flash highlight with it — flashing something the user cannot see is not worth a
  second signal, and `[data-linked]` already marks it.

The reason is the one the symmetry argument missed: hovering a SECTION is a gesture aimed at
the pane, so answering it in the editor is a reply; but reading or typing in the editor is not
a request about the pane, and the movement in the corner of the eye reads as the UI twitching
on its own. Symmetry of the LINK was always the good idea; symmetry of the SCROLLING was not.

Consequences:

- `Auto-scroll` now gates exactly one thing — hovering a section scrolls the editor. Its
  tooltip says so; the persisted key (`mdhStagesAutoscroll`) and its default are unchanged, so
  an existing profile keeps working with no migration.
- The explicit debug-panel row click (`handleInspectStage`) is untouched and still jumps,
  ungated: it is a deliberate "show me this stage", not incidental pointer movement.
- The editor now reports a **bare entry index** from `onCursorStage`, matching `onHoverStage`.
  The second index space (`activeStageIndexAtOffset`, the ACTIVE-stage index) existed only to
  name the stage OUTPUT to scroll to, so it and `smoothScroll.nearestScrollTop` were deleted
  with their tests — both had exactly one caller, and it was the removed scroll.
- Pinned by `tests/mdh-stages-editor-no-follow.test.js`, which spies on the scroll tween
  (jsdom has no layout, so asserting on `scrollTop` would pass either way) and asserts
  `inspectTarget` stays null when the caret moves. The opposite direction keeps its existing
  tests in `tests/mdh-stage-link-highlight.test.js`.

### Follow-on the same day: the tether survives an off-screen section

Removing the pane-follow exposed the other half of the 2026-08-12 decision above —
`sectionInPane()` suppressing the connector whenever the target section was scrolled out of
the Stages pane. That was written when the pane still scrolled the section into view, making
the suppression a flicker; with the editor no longer scrolling anything the section can stay
out of view indefinitely, so the tether was simply missing. Owner: *"Can we keep the tether
even if the stage on the right is off screen?"*

`computeStageLink` now takes the pane rect (optional — omit it and nothing clamps) and pins
the far endpoint into `[paneTop + 8, paneBottom - 8]`, reporting `edge: 'up' | 'down' | null`.
The overlay draws `edgeArrowPath()` — a small accent triangle pointing the way the section
lies — INSTEAD of the round dot at that end, because a dot there would claim the stage is at
the boundary, which is the one thing it isn't. `sectionInPane` stays exported as the honest
visibility predicate (`src/training/tether.js` cites it) but no longer gates drawing.

**The last leg follows the arrow's axis** (owner: *"the tether leaving the arrow is too abrupt
and immediately going to the left"*). `connectorPath` ends in a short HORIZONTAL stub, which
is right for a dot on a section's left edge — the line enters the section the way a reader's
eye does — and wrong for a vertical arrowhead, where a sideways arrival reads as a corner
rather than as one arrow. For a clamped endpoint the path now ends in a ~14px VERTICAL shaft
into the head (`shaftPath`), rounded into the diagonal like every other bend here.

The shaft is **unconditional**. It was first written to shorten (and vanish) whenever the line
approached from the side its head points at, on the theory that a shaft starting past its own
head would descend and climb back — a fishhook. That guard was wrong twice over, and the owner
caught it the same day: *"we should just show a bit more of the tether when both arrows are
pointing up, for example (currently, the right side goes immediately to the left instead of
continuing a bit vertically)."*

It fired in the ORDINARY case of both ends clamped the same way. The Stages pane's band starts
below the editor's — its options strip pushes it down — so a line between two up-arrows always
"arrives from above", and the guard zeroed the far shaft and left the diagonal to turn sideways
at the head: precisely the defect the shaft exists to prevent. And what it was avoiding is 14px
of dip against a horizontal span of several hundred (the two panes are far apart), which reads
as a shallow cable passing under a marker, not as a hook. Overshoot is now bounded by `SHAFT` by
construction, and a test pins that bound instead of the old monotonic-y assertion.

Clamping also fixes a case the suppression never caught: a section overlapping the pane
passes `sectionInPane`, yet its header anchor (`top + 16`) can still sit above the pane top —
drawing the line over the options toolbar. Both are pinned in `tests/mdh-stage-link.test.js`,
with the component-level "line still drawn, ending in an arrow" case in
`tests/mdh-stage-link-highlight.test.js`; each was verified to fail against the old code.
Geometry was checked visually in Chrome against the real stylesheet (both themes) — the
arrow lands inside the scroller, clear of the toolbar, at both edges.

### And the same clamp on the editor end

Owner, same day: *"when the editor is scrolled slightly off screen the tether on the stage
starts outside of the textarea and overlaps the UI."* The near end had the far end's bug, and
a wrong assumption recorded earlier in this session hid it — that `stageScreenRect` returns
null for a scrolled-out stage. **MEASURED, and it does not:** with the editor box at viewport
y 10..330, scrolling it 40px puts stage 0's `{` at y −7, and 320px puts it at −287.
CodeMirror's `coordsAtPos` reports coordinates for any line it has rendered, and a normal
pipeline is well inside its render window, so the line started outside the editor and ran up
over `.pipeline-header`'s Run/Save buttons.

So `computeStageLink` takes a `clipRect` too and treats both ends through one `clampToBox`,
reporting `startEdge` beside `edge`. The editor's clipping box comes from a new
`editorRef.current.clipRect()` — the INTERSECTION of `.json-editor` and CodeMirror's
`scrollDOM`, because which one clips depends on the layout: in the data panel the outer
`.json-editor` is the scroller (`console.css:408`) and `.cm-scroller`'s rect is the full
content height, so the container wins; were a layout to make `.cm-scroller` the scroller, its
rect would be the tighter one and would win instead. Verified against a real editor: at
`scrollTop` 0 the intersection is `{11, 330}`, at 120 it is `{10, 330}` while `.cm-scroller`
reports `{-109, 537}`.

`connectorPath` is now one emitter over four points — A, elbow, elbow, D — where each end's LEG
is either the horizontal (dot) or the vertical shaft (arrow), so the four combinations are just
different legs rather than four code paths. With two horizontal legs it produces the radii the
single-radius version did (both legs are ≥ 6 by construction), leaving the unclamped connector
unchanged. Both ends place their elbow one `SHAFT` along the head's axis on the VISIBLE side of
it — below an up-arrow, above a down-arrow — which is one rule, not two: the start's line leaves
its head that way and the end's arrives that way, the same segment described from either end.
With both ends clamped the same direction the result is a shallow cable, dipping out of one head
and rising into the other.

### And the editor stays put for a stage already on screen

Owner, same day: *"when the stage in the aggregation pipeline is already on screen (visible in
the textarea), do not try to scroll it to the middle of the screen when hovering on the stage on
the right."* Decision 3 above — hover-reveal centres the stage, "exactly as before" — was the
defect. `revealStage` ran no visibility test at all: every hover animated the scroller to
`block.top + c - (clientHeight - block.height) / 2`, and `animateScrollTop` only declines a move
under 2px, so a stage the user could already read travelled on every hover.

Two changes, both confined to the section-hover path (the caret and editor-hover paths never
scrolled the editor, and the debug-panel row click moves the right pane only):

- **Nothing moves while the stage's opening line is on screen.** Owner's choice of predicate,
  over "the whole stage fits": the editor then stays put in every case where you can see where
  the stage begins, which is the case being complained about, and a stage whose body runs below
  the fold is not a reason to move the text you are reading.
- **When it does move, that line goes to the TOP of the box, not the centre.** Also the owner's
  call. Centring wastes half the box above a stage and was never a decision — it arrived with
  the original link commit (`0464939`) and this spec merely recorded it.

The decision is pure (`smoothScroll.revealScrollTop(line, view) → scrollTop | null`, `null`
meaning "leave it alone"); only the measuring stays in `JsonEditor`. A line touching either edge
counts as visible, which makes a reveal **idempotent** — re-hovering the stage it just revealed
asks for nothing.

`REVEAL_TOP_INSET = 6` is load-bearing, by 0.3px. The connector's editor endpoint is the line's
vertical CENTRE, clamped `EDGE_INSET` (8px) inside the clip box, so a line placed flush at the
top would put that anchor 8.4/2 = **7.7px** below the edge — inside the clamp — and the
connector would draw its "it is off screen" arrow at the clip edge for a stage in plain view.
MEASURED in a browser on the real component and stylesheet (a 20-stage pipeline in a 198px-tall
`.json-editor`, line height 16.8px): with the inset the revealed line's top sits at 6.7px and
its anchor at **13.7px**, clear of the clamp, so the endpoint keeps its dot.

Measured in the same harness, before/after: a stage whose `{` sat at y 123.6 in a 198px box
scrolled the editor 0 → 32 under the old code and **0 → 0** now; a stage far below the fold
lands with its `{` line 6.7px from the top instead of centred at ~99px; and hovering it again
moves nothing. jsdom has no layout — every rect there is 0 — so the geometry cannot be pinned by
the unit tests, which cover `revealScrollTop` itself (visible, flush at either edge, above,
below, partly cut, idempotence, and that the inset keeps the anchor clear of the 8px clamp).
