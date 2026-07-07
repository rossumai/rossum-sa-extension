# Stages view: show each stage's substituted definition

**Date:** 2026-07-07
**Status:** Design approved, ready for implementation plan
**Area:** MDH (Dataset Management) — Stages results-view mode (`src/mdh/components/StagesView.jsx`)

## Problem

The Stages view (the third results-view mode beside List/Table) shows, per active
stage, a header (number, stage key, doc count, timing) and a horizontal row of
sample-output `RecordCard`s. What it does **not** show is the stage *query itself* —
the actual aggregation stage object, with pipeline variables (`{name}`) substituted
to the concrete values that are sent to the Data Storage API.

Today the only place a user sees the stage body is the pipeline editor, where it
still contains the raw `{name}` placeholders. There is no view of the post-
substitution form, so a user debugging a stage cannot easily confirm *what value
actually got plugged in* (and how it was typed — number vs. string, `split` array,
`re`-escaped string, unfilled → `""`).

## Goal

In the Stages view, let the user see each active stage's **own definition object,
with variables already substituted** — the concrete stage as sent to the DS API —
without leaving the view or losing the sample output.

Scope decision (confirmed with owner): show **this stage's individual definition**
per section (not the cumulative prefix pipeline, not a single whole-pipeline block).

## Verified facts (grounded before design)

1. **The substituted stage object is already in hand.** `DataPanel.jsx:582` computes
   `debugEntries = parseEntries(pipeline.substituteWithTypes(editorState.text)).entries`.
   `substituteWithTypes` substitutes placeholders (type-aware: numbers, booleans,
   nulls, `split` arrays, `re`-escaped strings; unfilled → `""`) *before*
   `parseEntries`, so every `entry.stage` handed to `StagesView` is a plain JS object
   with variables already resolved. No new substitution work is needed.
2. **StagesView never renders the stage body.** `StageHeader` shows only num / key /
   count / timing; `StageOutput` shows sample docs. The stage object is unused for
   display.
3. **Precedent for a truncated substituted preview exists** in the sibling Aggregate
   Pipeline Debug panel (`PipelineDebug.jsx:69-70`): `JSON.stringify(stage)` truncated
   to 50 chars. This confirms `entry.stage` is the substituted object and is safe to
   `JSON.stringify`.
4. **The editor connector is unaffected by content below the header.**
   `stageLink.js:21` anchors the Stages-side endpoint at `sectionRect.top + 16` (the
   section header). Adding a block *below* the header does not move that anchor.
5. **Reusable styling/patterns:** `.inspector-code-block` (mono, `--bg-code` /
   `--text-code`, rounded, `max-height` + `overflow:auto`, `white-space:pre`) in
   `console.css:3613` is the right visual model for a read-only code block.
6. **Options-strip persistence pattern:** `stagesAutoscroll` / `stagesSampleSize`
   signals in `store.js`, seeded from `chrome.storage.local` in `index.jsx:148-153`
   and written back via `effect(...)` at `index.jsx:213-218`. A new toggle mirrors
   this exactly.

## Design

### 1. Per-section substituted-definition block

For each **active** stage section, when the "Definitions" option is on, render a
read-only code block between the header and the sample-output area:

```
┌─ 2  $match          10 → 4 docs   23ms ──────────────┐
│  ┌────────────────────────────────────────────────┐ │  ← NEW (opt-in)
│  │ {                                               │ │     substituted stage
│  │   "$match": { "code": "AB-12", "qty": 100 }     │ │     definition, mono,
│  │ }                                               │ │     capped height + scroll
│  └────────────────────────────────────────────────┘ │
│  ┌────────┐ ┌────────┐ ┌────────┐   (sample output)  │  ← existing output area,
│  └────────┘ └────────┘ └────────┘                     │     flexes into remainder
└───────────────────────────────────────────────────────┘
```

- **Content:** `JSON.stringify(entry.stage, null, 2)` — the exact substituted object,
  pretty-printed.
- **Rendering:** a styled `<pre class="pipeline-inspect-def">` mirroring
  `.inspector-code-block` (mono, `--bg-code`/`--text-code`, rounded, `max-height`
  ~160px, `overflow:auto`, `white-space:pre`, `overscroll-behavior:none` to match
  the view's existing rubber-band suppression). No syntax highlighting in v1 — the
  plain block reads as "the request body," in deliberate contrast to the highlighted
  editor above.
- **Layout:** the block sits above `.pipeline-inspect-output`; the output area keeps
  `flex` so it fills the remaining section height. The definition block is capped and
  scrolls internally so a large stage (e.g. a big `$group`) never pushes the output
  out of the fixed-height section.
- **No copy button** (confirmed): text is selectable; nothing else added to the block.

### 2. "Definitions" toggle in the options strip (default OFF)

Add a checkbox to `.pipeline-inspect-opts`, beside "Auto-scroll":

- Label: **Definitions**
- `title`: "Show each stage's query with variables substituted (as sent to the Data
  Storage API)"
- Backed by a new global signal `stagesShowDef` (`store.js`), **default `false`**.
- Persisted as `chrome.storage.local` key **`mdhStagesShowDef`**, wired exactly like
  `mdhStagesAutoscroll`: seeded on boot (`if (typeof stored.mdhStagesShowDef ===
  'boolean') store.stagesShowDef.value = stored.mdhStagesShowDef;`) and written via an
  `effect`. Absent key → `false` (default OFF).

Rationale for opt-in default: the Stages sections are fixed-height; a definition
block consumes vertical space that would otherwise show sample output. Making it opt-in
keeps the default layout unchanged and lets a user reveal definitions only while
debugging a stage's substitution.

### Edge cases

- **Input (stage 0):** no stage definition (it is the raw collection). No block is
  rendered for the input section regardless of the toggle; its existing explanatory
  hint is unchanged.
- **Disabled stages:** not executed → not sent to the API. No definition block (showing
  one would falsely imply the stage is part of the request). The existing "disabled —
  not executed" badge is unchanged.
- **Unfilled variables:** substitute to `""` (the existing `substituteWithTypes`
  behavior). Displayed honestly — this is informative (reveals a forgotten value), not
  an error state.
- **Type-aware substitution is visible as-is:** a numeric variable shows as a JSON
  number, `split` as an array, `re` as an escaped string. This is precisely the value
  of the feature (the substitution/typing behavior is otherwise invisible).

### Backward compatibility

Purely additive:
- One new render block + one new options-strip checkbox in `StagesView.jsx`.
- One new CSS class `.pipeline-inspect-def` in `console.css`.
- One new signal `stagesShowDef` + one new persisted key `mdhStagesShowDef`
  (defaulted, boolean-guarded on read).

No changes to the API, the pipeline/data flow, `entry.stage` shape, the editor
connector, auto-scroll, sample-size, count, or any existing storage key. With the key
absent (existing users) the feature is off and the view is byte-identical to today.

### Privacy

The block renders the user's own substituted stage values in their own session
(same data already visible in the sample output). No values are persisted, logged, or
sent anywhere new. Spec examples use neutral placeholder values only.

## Testing

Extend `tests/mdh-stages-view.test.js`:
- With the toggle ON, each active stage section renders a `.pipeline-inspect-def`
  containing `JSON.stringify(entry.stage, null, 2)` (assert a substituted value, e.g. a
  variable resolved to a concrete number/string).
- With the toggle OFF (default), no `.pipeline-inspect-def` is rendered.
- Input section (stage 0) renders no definition block in either state.
- Disabled stages render no definition block in either state.
- Toggling the "Definitions" checkbox flips `store.stagesShowDef` (and the block's
  presence).

## Out of scope

- Cumulative-prefix or whole-pipeline views of what's sent (owner chose per-stage
  definition).
- Copy button (owner declined).
- Syntax highlighting of the definition block (plain styled `<pre>` in v1).
- Showing the debug instrumentation actually appended to requests (`$limit` sample cap,
  `$count`, `stripWriteStages`) — the block shows the *stage definition*, not the
  instrumented request body.
