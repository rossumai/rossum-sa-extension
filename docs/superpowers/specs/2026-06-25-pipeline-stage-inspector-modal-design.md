# Full-pipeline stage inspector modal — design

**Date:** 2026-06-25
**Area:** MDH (Dataset Management) — Aggregate Pipeline Debug
**Status:** Approved (design); ready for implementation plan

## Goal

Replace the small, one-stage-at-a-time preview modal opened from the *Aggregate
Pipeline Debug* panel with a **near-fullscreen modal that shows every stage's
sample output at once**, in pipeline order — similar to the cloud.mongodb.com
(Atlas) aggregation builder. The user goal is **more visibility, quickly, into
what each stage does**.

## Current behavior (verified)

- `src/mdh/components/PipelineDebug.jsx` is an **inline panel** (not a modal),
  titled *"Aggregate Pipeline Debug"*, mounted in `DataPanel.jsx`'s left column,
  capped at `max-height: 220px`. Each row shows a stage's number, `$key`,
  truncated JSON, cumulative doc count, and end-to-end timing. Row 0 is the raw
  collection input via `$collStats`.
- **Clicking a stage row** calls `openModal('Stage N: $key', …)` → mounts the
  local `StageInspector`, which fetches `[...stripWriteStages(prefix), { $limit: 5 }]`
  and shows the **first 5 docs after that one stage** as a horizontal carousel of
  `.sample-card`s. **This is the modal being replaced.**
- Modal shell (`src/mdh/components/Modal.jsx`) is a single-slot signal
  (`modalContent`). `openModal(title, renderFn)` renders only the body; the
  header (title + ✕) is fixed. `.modal-card` is capped at
  `max-width: 800px; width: 90vw; max-height: 85vh`.
- Established **backward-compatible widening pattern**:
  `.modal-card:has(.csv-import-wizard), .modal-card:has(.xlsx-import-wizard) { max-width: 1040px; }`
  — a child class widens just that modal.
- `api.aggregate(collection, pipeline, { signal })` → `{ result: [...] }`, 30s
  timeout via AbortController.
- Safety helper `stripWriteStages` (`src/mdh/pipelineOps.js`) removes
  `$out`/`$merge` so debug never writes.

### Verified reuse / cleanup facts

- The **data view list** renders each document with `RecordCard`
  (`src/mdh/components/RecordCard.jsx`), which wraps `JsonTree` for the body and
  adds a one-line summary + Copy/Edit/Del actions. (Table mode uses
  `RecordTable`; list is the default.)
- The data view **already** runs the same aggregation pipeline and renders
  arbitrary aggregation output (post-`$group`/`$project`) through `RecordCard`.
  Reuse is therefore already proven safe for any stage shape.
- `JsonTree` calls `onSort`/`onFilter` and indexes `sortState`/`filterState`
  **unconditionally** (it will throw if they are undefined). A read-only reuse
  must pass `sortState={}`, `filterState={}`, and no-op `onSort`/`onFilter`.
- `readOnly` is an existing prop convention in the codebase (`JsonEditor`,
  consumed by `IndexCard`).
- `.pipeline-inspect-info` CSS and `StageInspector` are consumed **only** by the
  current click-to-inspect flow → safe to retire.
- `.sample-card(s)` CSS is **also** consumed by `BulkDelete`/`BulkUpdate`
  (and `tests/mdh-bulk-update.test.js`) → keep the CSS; the new modal will not
  use it.

## Resolved decisions

1. **Entry point:** Clicking **any** row — including the input row — opens the
   single new modal, scrolled to (and briefly highlighting) that stage. The
   per-stage `StageInspector` is removed (subsumed by the new modal).
2. **Stage definition rendering:** Plain `<pre>` code block (pretty-printed
   JSON), not a CodeMirror read-only editor — lighter across N stages and
   sufficient for small stage objects.
3. **Layout:** Vertical stage list (stacked, pipeline order).
4. **Sample size:** Default 10 docs/stage, with a `5 / 10 / 25` selector in the
   modal; persisted as `mdhInspectSampleSize` (matches the app's storage-key
   convention).
5. **Document rendering:** Reuse the data-view `RecordCard` in a new read-only
   mode.

## Components

- **New `src/mdh/components/PipelineInspector.jsx`** — the modal body. Props:
  `{ collection, entries, counts, inputInfo, clickedIndex }`.
  - `entries`: the same `{ disabled, stage }[]` the panel renders.
  - `counts` / `inputInfo`: the per-stage count+timing and input count+timing the
    panel has **already computed**, passed in so they display instantly (the
    preview docs load asynchronously on top).
  - `clickedIndex`: which stage section to scroll to / highlight (`-1` = input).
- **`PipelineDebug.jsx`** — `inspectStage`/`inspectInput` change to
  `openModal('Inspect pipeline', () => <PipelineInspector …/>)`, passing
  `collection`, `entries`, the local `stageCounts`/`inputInfo`, and the clicked
  index. `StageInspector` and `DEBUG_PREVIEW_LIMIT` are removed. Everything else
  in the panel (per-stage `$count` requests, `$collStats` input row, timing,
  slow-flagging, toggles, error blocks, `StageTooltip`, `stripWriteStages`,
  `$search`-first) is **unchanged**.
- **`RecordCard.jsx`** — add an optional **`readOnly` prop (default `false`)**:
  when true, suppress Edit/Del and the selection checkbox (ignore the global
  `selectionMode`), keep Copy + chevron expand/collapse + `JsonTree`. Existing
  call sites are unaffected.

## Layout

Modal sized near-fullscreen via the existing widening pattern:
`.modal-card:has(.pipeline-inspect) { width: 96vw; max-width: none; height: 92vh; max-height: 92vh; }`.

Modal body (`.pipeline-inspect`):

- A small top toolbar: a `docs/stage` segmented control (`5 / 10 / 25`).
- A vertical scroll column of **stage sections**, top→bottom in pipeline order,
  starting with the input section (row 0):
  - **Header strip:** `[num] · $key` … count (delta form, e.g. `1,240 → 420 docs`,
    using the passed-in numbers) … timing (ms; reuse the panel's slow-flag
    threshold/style).
  - **Two-column content** (CSS grid; stacks on narrow widths):
    - **Left:** stage definition as a read-only `<pre>` code block. Input row:
      "all records (pipeline input)".
    - **Right:** the stage's output as a vertical, internally-scrollable list of
      **read-only `RecordCard`s** (capped height, own scrollbar so one large
      stage doesn't dominate). Each card defaults collapsed (summary line),
      expandable.
  - **Disabled** stages: greyed section with a "disabled — not executed" note and
    no preview (consistent with the panel).
  - **Error:** if a stage's preview aggregation errors, show the verbatim message
    + status in that section's output column (reuse the panel's error styling).
- Opening from a row scrolls that section into view and briefly highlights it.

The **last** active stage's output is the final query result (with `$limit N`),
so the modal gives end-to-end visibility.

## Data flow

- On open, the modal receives `collection`, `entries`, the panel's
  `counts`/`inputInfo`, and `clickedIndex`.
- For the **previews**, the modal fans out one aggregation per active stage *i*:
  `api.aggregate(collection, [...stripWriteStages(prefix_i), { $limit: N }], { signal })`,
  plus the input row: `api.aggregate(collection, [{ $limit: N }], { signal })`.
  All fire in parallel under a single `AbortController`. Each section renders its
  docs independently as they arrive (independent loading state per section), so
  the modal is responsive.
- Changing the `docs/stage` selector updates `N`, persists `mdhInspectSampleSize`,
  aborts in-flight requests, and re-fires all previews.
- **Invariants preserved:** `$search` remains the first stage of every prefix
  request (prefixes are built from `activeStages.slice(0, i+1)` exactly as the
  panel does); `stripWriteStages` keeps `$out`/`$merge` out of every request.

## Backward compatibility

- The inline **panel behavior is unchanged** — only what a click *opens* changes.
  All existing `mdh-pipeline-debug.test.js` panel assertions stay valid.
- Retire `StageInspector` + `.pipeline-inspect-info` CSS (sole consumer). **Keep**
  `.sample-card(s)` CSS (BulkDelete/BulkUpdate).
- `RecordCard` `readOnly` defaults off → no impact on the data view,
  BulkDelete/BulkUpdate, or selection mode.
- The modal system (single-slot `modalContent`) is reused as-is; no API change.

## Testing

- **Update** the two `StageInspector`-specific assertions in
  `tests/mdh-pipeline-debug.test.js` (the "clicking the 0th row previews…" test
  and any modal-text assertions) to target the new modal — still asserting the
  `$limit` preview request, `stripWriteStages` (no `$out`/`$merge`), and
  `$search`-first. Keep all panel-level assertions unchanged.
- **New `tests/mdh-pipeline-inspector.test.js`** (jsdom; `.test.js` + `h()`
  convention; `waitFor`-polling, no fixed sleeps):
  - renders one section per active stage (+ input section);
  - fires one `[...prefix, { $limit: N }]` preview request per active stage and
    `[{ $limit: N }]` for input;
  - the `docs/stage` selector re-fires previews with the new `N`;
  - read-only `RecordCard` shows no Edit/Del and no selection checkbox;
  - a failing stage surfaces its verbatim error in that section, independently;
  - disabled stages render greyed with no preview request;
  - `$search`-first and `stripWriteStages` invariants hold for every request.

## New / changed files

- New: `src/mdh/components/PipelineInspector.jsx`
- New: `tests/mdh-pipeline-inspector.test.js`
- Changed: `src/mdh/components/PipelineDebug.jsx` (open new modal; remove
  `StageInspector` + `DEBUG_PREVIEW_LIMIT`)
- Changed: `src/mdh/components/RecordCard.jsx` (add `readOnly` prop)
- Changed: `src/console/console.css` (add `.modal-card:has(.pipeline-inspect)` +
  `.pipeline-inspect-*` rules; remove `.pipeline-inspect-info`)
- Changed: `tests/mdh-pipeline-debug.test.js` (retarget the two StageInspector
  assertions)
- Doc: `CLAUDE.md` storage-key list + component count touch-up (`mdhInspectSampleSize`).

## Out of scope (YAGNI)

- Per-document diffing between stages (highlighting changed fields). The count
  delta + sample docs already convey the stage effect; reliable diffing across
  reshaping stages is a separate, larger feature.
- Editing documents from the inspector (it is read-only).
