# In-view "Stages" debugging (no modal) — design

**Date:** 2026-06-25
**Area:** MDH (Dataset Management) — pipeline debugging
**Status:** Approved (design); ready for implementation plan

## Goal

The debugging **modal** had two problems: the overlay **hides context** (it
covers the pipeline editor and the real results) and feels **disconnected from
the flow** (a separate popup you open/close). Move the per-stage debugging
experience **into the data view as a third results view mode**, so it renders
inline next to the always-visible editor — no overlay, no popup. The
all-stages-at-once richness is kept.

## Decisions (from brainstorming)

1. **Direction:** A **"Stages" view mode** in the right results pane, beside
   List / Table. Selecting it renders the stacked per-stage debug view inline in
   the pane; the editor and left panel stay visible.
2. **Left panel:** The inline *Aggregate Pipeline Debug* panel **stays** as the
   compact always-visible overview (per-stage counts/timing/toggles). **Clicking
   a stage row** switches the right pane to **Stages** and scrolls to + briefly
   highlights that stage (replacing the old modal-open).
3. **Per-stage editing:** **Deferred for v1.** The pipeline editor is now always
   visible on the left, so modifying a stage = edit it there; the Stages view
   reflects edits live. In-pane per-stage editing can be added later.
4. **Sample size:** hardcoded **10 docs per stage**, no selector.

## Current state (verified)

- `DataPanel` is two columns: **left** (`data-panel-left`, resizable via
  `mdhPipelineWidth`) = `PipelineEditor` → optional write banner →
  `PlaceholderInputs` → `PipelineDebug` panel; **right** (`data-panel-right`) =
  `RecordList` (final pipeline output: list/table views, pagination, click-to-
  sort/filter, download, bulk ops).
- `RecordList` owns its view mode: `const [view, setView] = useState('list')`,
  loads `mdhResultsView` on mount, persists via `changeView`. `ViewAsButton`
  offers List/Table. It renders `RecordTable` (table) or a list of `RecordCard`
  (list), plus a toolbar (Select, Expand All, View, Download, Bulk, Insert) and a
  pagination footer.
- `PipelineDebug` (left panel) row-click currently calls `openModal(...)` →
  `PipelineInspector`. It receives `entries` + `onToggleStage` from `DataPanel`.
- `PipelineInspector` (the modal body) already renders the stacked per-stage
  view: fixed-height sections, definition `<pre>`, side-by-side expanded
  read-only `RecordCard` previews, count delta/timing via `useStageCounts`, and
  per-stage enable/disable toggles. It currently holds a **local copy** of
  `entries` (needed only because the modal was opened from a closure snapshot).
- `DataPanel.handleToggleStage(entryIndex)` flips the stage's disabled marker in
  the editor text and re-runs the query; `entries` (derived from
  `editorState.text`) updates reactively — which is how the left panel already
  reflects toggles live.
- Shared: `useStageCounts(collection, activeStages)` (counts/timing),
  `RecordCard` `readOnly` mode, `stripWriteStages`.

## Architecture (no modal)

### Component: `StagesView.jsx` (rename of `PipelineInspector.jsx`)

The same stacked per-stage view, **de-modaled** and **simplified**:

- **Props:** `{ collection, entries, onToggleStage, inspectTarget }`.
  - `entries`: the **live** `{ disabled, stage }[]` from `DataPanel` (NO local
    copy — being inline, it re-renders when the editor changes, so the modal's
    snapshot/local-toggle complexity is removed). Toggling calls
    `onToggleStage(entryIndex)`; the editor update flows back through `entries`.
  - `inspectTarget`: `{ index }` (active-stage index, `-1` = input) | `null` —
    the stage to scroll to + highlight. A **new object per click** so re-clicking
    the same stage still re-fires the scroll/highlight effect.
- **Renders:** the input section + one section per entry, exactly as today —
  fixed-height sections scrolling within the pane, definition `<pre>`,
  side-by-side **expanded** read-only `RecordCard` previews (**10 docs**, via its
  own `[...stripWriteStages(prefix), { $limit: 10 }]` fetch), count delta/timing
  (`useStageCounts`), and the enable/disable toggle on each header. Disabled
  stages render greyed with their toggle; per-stage preview errors render in that
  section.
- **Drops:** the modal toolbar + `5/10/25` docs-per-stage selector (and its
  `chrome.storage` persistence), the local `entries` state + `toggleEntry`
  local-flip.
- **Highlight (reliable, state-driven):** an effect keyed on `inspectTarget`
  sets an internal `highlightIdx`, scrolls that section into view
  (`scrollIntoView({ block: 'start' })`), and clears `highlightIdx` after
  ~1.5s. Sections render the `pipeline-inspect-highlight` class from
  `highlightIdx` (JSX, not imperative `classList`) so a mid-flash re-render
  cannot wipe it.
- **Invariants preserved:** `$search` first in every prefix; `stripWriteStages`
  on every preview; counts via the shared hook.

### `RecordList.jsx`

- `view` becomes a **controlled prop** (`'list' | 'table' | 'stages'`) with
  `onChangeView`; the local view state + load/persist move to `DataPanel`.
- New props: `entries`, `onToggleStage`, `inspectTarget` (forwarded to
  `StagesView`).
- When `view === 'stages'`: render `<StagesView collection={selectedCollection.value}
  entries={entries} onToggleStage={onToggleStage} inspectTarget={inspectTarget} />`
  inside `.record-list` instead of the table/list; the toolbar renders **only**
  the `ViewAsButton` (Select/Expand-All/Download/Bulk/Insert hidden — they don't
  apply); the **pagination footer is hidden**.
- `ViewAsButton` gains a **Stages** option; label is `Stages` when active.

### `PipelineDebug.jsx`

- Drop `openModal` + `PipelineInspector` import. Row-click calls a new prop
  `onInspectStage(activeIndex)` (input row → `-1`). Everything else (counts via
  `useStageCounts`, timing, toggles, error blocks, tooltips) unchanged.

### `DataPanel.jsx`

- Own `resultsView` state (`'list' | 'table' | 'stages'`), loaded from
  `mdhResultsView` (legacy `json` → `list`) and persisted on change; pass
  `view={resultsView}` + `onChangeView` to `RecordList`.
- Own `inspectTarget` state (`{ index } | null`). `handleInspectStage(index)` =
  `setResultsView('stages')` + `setInspectTarget({ index })`; pass
  `onInspectStage={handleInspectStage}` to `PipelineDebug` and
  `inspectTarget={inspectTarget}` to `RecordList`. `onChangeView(v)` (the View
  dropdown) sets `resultsView = v` **and clears `inspectTarget` to `null`** — so
  switching to Stages via the dropdown shows it from the top, while only a
  left-panel row-click scrolls/highlights a specific stage.
- Pass `entries` (the already-computed `parseEntries(...).entries`) and
  `onToggleStage={handleToggleStage}` to `RecordList` (same values already passed
  to `PipelineDebug`).

## Data flow

- Switch to Stages via the View dropdown **or** by clicking a left-panel stage
  row (which also sets `inspectTarget` → scroll/highlight). `StagesView` derives
  `activeStages` from the live `entries`, fetches 10-doc previews per active
  stage + the `$collStats` input count + per-stage `$count` (shared hook), and
  recomputes whenever `entries` change (toggle or editor edit).
- Toggling a stage in either the left panel or the Stages view calls
  `onToggleStage` → `handleToggleStage` (editor splice + re-run) → `entries`
  update → both reflect it.

## Backward compatibility

- The `Modal` system is **retained** (used by confirm/prompt and other features);
  only this feature's `openModal(PipelineInspector)` usage is removed.
- `mdhResultsView` gains `'stages'`; existing `list`/`table` (and legacy `json`)
  values are unaffected. A persisted `'stages'` reopens in Stages mode
  (consistent with List/Table persistence).
- `useStageCounts` and `RecordCard` `readOnly` are reused unchanged. The
  `mdhInspectSampleSize` storage key is no longer written (dead key, harmless).
- CSS: keep the `.pipeline-inspect-*` class names (styling `StagesView` —
  documented; renaming all rules is pure churn). **Remove** the modal-only rules:
  `.modal-card:has(.pipeline-inspect)` sizing, `.pipeline-inspect-toolbar*`,
  `.pipeline-inspect-seg*`. The `.pipeline-inspect`/`-scroll` container styles are
  reused to fill the pane; add `overscroll-behavior: contain` on the scroll
  regions (`.pipeline-inspect-scroll`, `.pipeline-inspect-output`,
  `.pipeline-inspect-output > .record-card`) — the overscroll bounce fix.

## Testing

- **Rename** `tests/mdh-pipeline-inspector.test.js` → `tests/mdh-stages-view.test.js`;
  import `StagesView`; mount directly with props (no modal, no `chrome` selector
  setup needed beyond what `useStageCounts` requires). Keep: one section per
  active stage + input; 10-doc preview per active stage + `$collStats` input +
  per-stage `$count`; read-only `RecordCard`s; per-stage error; disabled greyed +
  no preview for it; toggle checkbox calls `onToggleStage(entryIndex)`; `$search`
  first + `stripWriteStages`. Replace the modal/selector/persistence/local-toggle
  cases with: live-`entries` re-render on prop change; `inspectTarget` →
  highlight + `scrollIntoView`.
- **`tests/mdh-pipeline-debug.test.js`:** the row-click test asserts
  `onInspectStage` is called with the active index (not that a modal opens);
  drop the `Modal`/`.pipeline-inspect` assertions.
- **`RecordList`:** add tests for the `view === 'stages'` branch — renders
  `StagesView` (stubbed) instead of records, toolbar shows only the View switch,
  pagination footer hidden; `ViewAsButton` offers Stages and `onChangeView`
  fires.
- **`DataPanel`:** `onInspectStage` sets the view to `stages` + target; `entries`
  / `onToggleStage` reach `RecordList`. (Extend existing `mdh-datapanel-*` tests
  or add a focused one.)
- Follow repo conventions: `.test.js` + `h()`, `waitFor`-polling, `afterEach`
  unmount to prevent deferred-effect bleed.

## New / changed files

- Rename: `src/mdh/components/PipelineInspector.jsx` → `StagesView.jsx`
  (de-modal: live props, no selector, no local entries; state-driven highlight).
- Rename: `tests/mdh-pipeline-inspector.test.js` → `tests/mdh-stages-view.test.js`.
- Modify: `src/mdh/components/RecordList.jsx` (controlled `view` incl. `stages`,
  `StagesView` branch, toolbar trim, pagination hide, `ViewAsButton` Stages).
- Modify: `src/mdh/components/PipelineDebug.jsx` (drop modal; `onInspectStage`).
- Modify: `src/mdh/components/DataPanel.jsx` (lift `resultsView` + persist;
  `inspectTarget`; wire `onInspectStage`; pass `entries`/`onToggleStage`/`view`/
  `onChangeView`/`inspectTarget` to `RecordList`).
- Modify: `src/console/console.css` (remove modal-only rules; reuse container
  styles in-pane; add `overscroll-behavior: contain`).
- Modify: `CLAUDE.md` (Stages view mode; `mdhResultsView` adds `stages`; drop the
  `mdhInspectSampleSize` mention; note the modal removal).

## Out of scope (YAGNI for v1)

- Per-stage inline editing in the Stages view (the left editor handles edits).
- Per-document diffing between stages.
- Changing the left panel's compact layout (it stays as-is, plus `onInspectStage`).
