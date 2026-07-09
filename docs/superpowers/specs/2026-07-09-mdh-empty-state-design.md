# Master Data Hub — state-aware empty state

**Date:** 2026-07-09
**Status:** Design approved, ready for implementation plan
**Area:** `src/mdh/` (Dataset Management console app)

## Problem

The Dataset Management main pane shows `Select a collection to get started`
(`src/mdh/components/App.jsx:47`) whenever no collection is selected. But
`loadCollections()` (`src/mdh/components/Sidebar.jsx:22`) **auto-selects the
first collection whenever any exist**. So the only time this panel is
*persistent* is when the organization has **zero collections** — where "select
a collection" is nonsensical: there is nothing to select.

The panel is also shown, unchanged, behind the "Not connected" connection bar
and behind the error banner, and it can flash for up to ~300ms during boot
before `loadCollections()` resolves.

## Verified facts (grounding)

1. **When the panel shows.** `App.jsx` renders the empty-state branch only when
   `activeView` is neither `operations` nor `overview` (i.e. the default
   `collection` view) **and** `selectedCollection` is null.
2. **Auto-select.** `Sidebar.jsx:22` selects `sorted[0]` when collections exist
   and none is selected. Therefore, with collections present, the empty branch
   is at most a sub-300ms boot transient (and usually not even that, because
   per-tab `mdhSelectedCollection` is restored first). **Persistent empty ⇔ zero
   collections.**
3. **Create path exists.** The sidebar `+` button calls `showCreateModal()`
   (module-local in `Sidebar.jsx`) → `api.createCollection()` →
   `POST /collections/create`. After success it reloads the list and selects the
   new collection, dropping the user into it.
4. **Import is per-collection, not global.** Import is launched from a
   collection's Data view (`RecordList` toolbar `Import` button, beside the "No
   records" state; `openImport` in `DataOperations.jsx`). The sidebar footer
   "Operation Logs" (`activeView === 'operations'`) is a **log viewer**, not an
   import launcher. You cannot import until a collection exists, so the correct
   first step from zero collections is simply to create one.
5. **Naming.** The codebase is inconsistent: the console rail says "Dataset
   Management", the popup launches it as "Master Data Hub", API error strings
   say "Data Storage". Per owner instruction, user-facing copy here uses
   **"Master Data Hub"**. The entity noun stays **"collection"** to match the
   rest of the app (sidebar title "Collections", "New Collection" modal,
   drop/rename) — switching to "dataset" would be inconsistent and out of scope.
6. **Available state.** The store exposes `collections`, `loading`, `error`,
   `selectedCollection`; `connected` is passed to `App` as a prop. That is
   enough to distinguish loading / disconnected / errored / genuinely-empty.
7. **No copy coupling.** No test asserts the string `Select a collection to get
   started` (only `App.jsx` and a stale plan doc reference it). No storage keys
   are involved. Backward compatibility is clean.

## Design

### New component: `src/mdh/components/CollectionEmptyState.jsx`

Replaces the inline `<div class="empty-state"><p>…</p></div>` in `App.jsx`.
Signature: `CollectionEmptyState({ connected })`. Reads the `collections`,
`loading`, and `error` signals directly. Renders exactly one of the following,
evaluated in this order:

| # | Condition | Renders |
|---|-----------|---------|
| 1 | `collections.length > 0` | `Select a collection to get started` (unchanged copy — now truthful; covers the transient boot window) |
| 2 | `loading` | nothing (`null`) — the existing `LoadingOverlay` spinner covers it; never assert "no collections" before the fetch resolves |
| 3 | `!connected` or `error` | nothing (`null`) — `ConnectionBar` / `ErrorBanner` already carry the real reason; do not contradict them |
| 4 | otherwise (loaded, connected, no error, empty) | the **No-collections block** |

`App.jsx` only mounts this component when `selectedCollection` is null and the
view is the default collection view, so no `selectedCollection` guard is needed
inside the component.

### No-collections block (copy)

```
No collections yet

Master Data Hub keeps your reference data in collections you can browse
and query. This organization doesn't have any yet.

[ Create collection ]
```

- Heading: **No collections yet**
- Body (one line): *Master Data Hub keeps your reference data in collections you
  can browse and query. This organization doesn't have any yet.*
- Primary button: **Create collection** — invokes the existing create flow.

No import hint (premature: import requires an existing collection; the
per-collection "No records" + `Import` state guides that step after creation).

### Reusing the create flow

Export `showCreateModal` from `Sidebar.jsx` (that file already owns collection
CRUD and already exports `loadCollections` / `performDrop`, so this matches the
existing pattern). `CollectionEmptyState` imports and calls it on button click.
No create logic is duplicated or moved. After creation the existing
`showCreateModal` path reloads the list and selects the new collection.

### CSS (`src/console/console.css`, additive)

Keep the centered `.empty-state` flex container. Add:

- `.empty-state-title` — heading (slightly larger than the 14px body, primary
  text color).
- `.empty-state-body` — the explanatory line (secondary text, constrained
  max-width, centered).

Stack title / body / button vertically and centered (small gap). The button
reuses existing `.btn` / `.btn-success`. No existing rule is modified, so
sibling users of `.empty-state` (Audit, Galaxy one-liners) are unaffected.

## Testing

New test file under `tests/` following the repo convention (`.test.js`,
`h(Component, null)`, `vi.mock` for `store` / `Sidebar`):

1. Loaded + connected + `collections = []` → renders "No collections yet" and a
   button.
2. `collections = ['a']` → renders "Select a collection to get started"; no
   button.
3. `loading = true` (empty, connected) → renders nothing.
4. `connected = false` (empty, not loading) → renders nothing.
5. `error` set (empty, connected, not loading) → renders nothing.
6. Clicking the button calls the (mocked) `showCreateModal`.

## Backward compatibility

- No new storage keys; no migration.
- Auto-select behavior in `Sidebar.loadCollections()` is untouched.
- `.empty-state` class and its existing consumers are untouched (CSS is purely
  additive).
- The "Select a collection to get started" string is preserved for the
  collections-present case.

## Out of scope

- Renaming the app or the "collection" entity noun app-wide.
- Any change to the import/export flows or the Operation Logs view.
- Reconciling the broader "Dataset Management" / "Master Data Hub" / "Data
  Storage" naming inconsistency beyond this one panel's copy.
