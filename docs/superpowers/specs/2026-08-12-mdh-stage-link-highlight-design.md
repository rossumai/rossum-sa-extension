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
   centre the stage, exactly as before.

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
  be taken somewhere.
- **The connector no longer draws toward an off-screen target.** `computeStageLink` never
  checked visibility; hovering a *section* could not expose that (you can only hover what you
  can see), but the caret and editor-hover links can, and the line would run off over the
  toolbar. `sectionInPane()` now suppresses the line when the target is scrolled out of the
  pane, leaving the band to carry the link. This was a defect introduced with the caret link
  in the same day's work.

`.pipeline-inspect-section[data-linked]` marks the section end when the pointer is in the
editor, since its own `:hover` cannot fire in that direction — the same accent border, reached
from the other end. An attribute, not a class, for the usual reason: Preact rewrites
`className` wholesale when `sectionCls()` changes for the `inspectTarget` flash.

The `mousemove` handler would otherwise run a whole-document `JSON5.parse` per pointer move, so
`stageLineRanges` is now memoized on the CodeMirror `Text` object's identity (immutable, so
identity implies identical content and the key cannot go stale). The caret path shares the memo.

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
