# Overview reuses the shared empty-state component

**Date:** 2026-07-09
**Status:** Design approved, ready for implementation plan
**Area:** `src/mdh/`

## Problem

The Dataset Management **Overview** panel shows a bare
`<div class="stats-empty">No collections</div>` (`OverviewPanel.jsx:309`) when
the org has no collections. The collection view already got a richer, actionable
empty state (`CollectionEmptyState`, shipped in commit `ae66019`): a "No
collections yet" card with a **Create collection** button. The Overview should
reuse it for consistency instead of the plain text.

## Verified facts (grounding)

1. **Trigger is identical to the empty-org case.** In `OverviewPanel.jsx`,
   `totalCount = cols.length` and `cols = collections.value` (lines 48, 271), so
   the `totalCount === 0` branch (line 308-309) fires exactly when
   `collections.value.length === 0` — the same condition `CollectionEmptyState`
   treats as "no collections".
2. **`CollectionEmptyState` is safe to reuse here.** Its first branch,
   `collections.value.length > 0 → "Select a collection to get started"`, is
   unreachable in the Overview because the Overview only mounts it when
   `totalCount === 0`. It then gates on `loading || !connected || error` →
   `null`, else renders the "No collections yet" block.
3. **Layout fits.** `.stats-scroll` is `display:flex; flex-direction:column;
   flex:1; min-height:0` (`console.css:2293-2296`). `CollectionEmptyState`
   renders `.empty-state` (`flex:1; display:flex; align-items:center;
   justify-content:center` — `console.css:330-333`), which grows to fill the
   scroll area and centers the card. When empty, the empty-state is the only
   child of `.stats-scroll` (the charts/progress track above are gated on
   `totalCount > 0`).
4. **An empty Overview is fully inert (verified).** The initial-load effect
   (`OverviewPanel.jsx:158`) calls `streamStats([], …)`, whose
   `runWithConcurrency([], …)` spawns zero workers → no API calls. The live-poll
   effect early-returns at line 176 (`if (cols.length === 0) return`) → no
   `setTimeout`, no `visibilitychange` listener. `OverviewPanel` uses no
   `chrome.*` at all. So a test rendering it with empty `cols` needs no timers,
   no network, and no `chrome` stub for the panel itself.
5. **`connected` is a store signal** (`store.js`), not currently imported by
   `OverviewPanel`. `CollectionEmptyState` takes `connected` as a prop and
   tolerates `null`/`false` (renders `null`).
6. **No import cycle.** `OverviewPanel → CollectionEmptyState → Sidebar.jsx →
   (store, api, cache, …)`; `Sidebar` does not import `OverviewPanel`. Both are
   imported by `App.jsx`. No cycle.

## Design

In `src/mdh/components/OverviewPanel.jsx`:

- Add `connected` to the store import: `import { collections, selectedCollection,
  activeView, connected } from '../store.js';`
- Add `import CollectionEmptyState from './CollectionEmptyState.jsx';`
- Replace the empty branch:

```jsx
{totalCount === 0 ? (
  <CollectionEmptyState connected={connected.value} />
) : (
  <table class="stats-table stats-overview-table">
  ...
```

No other change. The `.stats-empty` CSS rule stays — it is still used by
`StatsPanel.jsx:180-181` ("Discovering fields…" / "No fields found"), so it is
not dead after this change.

### Behavior delta

- Empty + connected → "No collections yet" card + Create button (was: "No
  collections" text).
- Empty + disconnected/errored → blank (was: "No collections"); the connection/
  error bars carry the reason — consistent with the collection view.

## Testing

New `tests/mdh-overview-empty.test.js` (jsdom, render via `h(OverviewPanel,
null)`):

- With `collections.value = []`, `connected.value = true`: renders "No
  collections yet" and a `button.btn-success` ("Create collection"); does NOT
  render the bare "No collections" text and renders no stats `<table>`.
- Mock `../src/mdh/api.js` defensively (no real network) and mock
  `../src/mdh/components/Sidebar.jsx` `showCreateModal` (imported transitively by
  `CollectionEmptyState`), following the pattern in
  `tests/mdh-empty-state.test.js`. No `chrome` stub or fake timers are needed
  (fact 4: the empty Overview spawns no workers, timers, or listeners).

## Backward compatibility

- No new storage keys; no migration.
- Only the `totalCount === 0` render path in the Overview changes; the populated
  Overview (table, charts, sorting, totals) is untouched.
- `CollectionEmptyState` itself is unchanged (reused as-is).
- `.stats-empty` CSS rule left in place.

## Out of scope

- Any change to `CollectionEmptyState`.
- `.stats-empty` CSS (still used by `StatsPanel`; untouched).
- Charts / populated-Overview behavior.
