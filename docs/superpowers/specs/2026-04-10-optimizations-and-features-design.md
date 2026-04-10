# Optimizations & New Features Design

Date: 2026-04-10

## Scope

Two workstreams in a single spec:

1. **Targeted optimizations** — fix memory leaks, improve performance, reduce code duplication
2. **Three new MDH features** — query history, collection stats, bulk operations

---

## 1. Optimizations

### 1a. Modal escape listener stacking (`modal.js`)

`openModal()` adds a `keydown` listener every call. `closeModal()` removes it, but rapid open/open without close stacks handlers.

**Fix:** Call `document.removeEventListener('keydown', handleEscape)` before `addEventListener` in `openModal`.

### 1b. Split-button click listener leak (`records.js`)

Each split-button adds a document-level `click` listener to close menus. These are never removed.

**Fix:** Use a single document-level event delegation listener registered once at module init. It closes any open `.split-menu` when clicking outside.

### 1c. Scroll-lock RAF loop (`scroll-lock.js:100-108`)

`requestAnimationFrame(monitorElementConnection)` runs every frame (~60/s) just to check `element.isConnected`.

**Fix:** Replace with `setInterval` at 2000ms. Clear interval when element disconnects.

### 1d. AbortController for main queries (`records.js`)

Background prefetch uses AbortController, but the primary `runQuery()` does not. Rapid collection switching can cause stale results overwriting newer data.

**Fix:** Track an `activeQueryController` at module scope. Abort it at the start of each `runQuery()`.

### 1e. LRU eviction in cache (`cache.js`)

`evict()` deletes the oldest-inserted entry (FIFO). The `lastAccess` timestamp is tracked but unused for eviction.

**Fix:** Sort by `lastAccess` and delete the entry with the smallest value.

### 1f. Extract shared panel builder (`record-editor.js`)

`buildInsertPanel`, `buildUpdatePanel`, `buildReplacePanel` share ~120 lines of identical boilerplate (hint, actions, cancel/submit buttons).

**Fix:** Extract a `buildPanelShell({ submitLabel, submitClass, onSubmit })` helper that returns `{ panel, hint, submitBtn }`.

### 1g. Promise-chained modal close (`record-editor.js`)

Six places use `setTimeout(() => { closeModal(); onSuccess?.(); }, 1000)` — fixed 1s delay regardless of actual operation time.

**Fix:** Show success message, then close after a short delay (500ms) chained to the resolved promise. Use a helper: `showSuccessAndClose(hint, message, onSuccess)`.

### 1h. Download size warning (`records.js`)

Download fetches entire collection in 1000-doc batches with no limit.

**Fix:** Before starting download, fetch `totalCount`. If >10,000 documents, show a confirm modal warning about size. Proceed on confirm.

### 1i. `replaceChildren()` adoption (multiple files)

Several files use `element.innerHTML = ''` followed by `appendChild()`.

**Fix:** Replace with `element.replaceChildren()` or `element.replaceChildren(newChild)` where applicable.

### 1j. NetSuite double-regex (`netsuite/index.js`)

Two sequential regex matches: `onClick.match(/"..."/g) || onClick.match(/'...'/g)`.

**Fix:** Single pattern: `/"([^"]*)"|'([^']*)'/g`.

---

## 2. Query History & Saved Queries

### Storage

Uses `chrome.storage.sync` for cross-browser persistence.

Two keys:
- `queryHistory` — `Array<{ collection: string, query: string, pipeline: string, ts: number }>` — auto-pruned to 30 entries (FIFO by ts)
- `savedQueries` — `Array<{ collection: string, query: string, pipeline: string, name: string, ts: number }>` — user-managed, no auto-prune

### Sync storage budget

Each query entry is ~200-500 bytes. 30 history entries + ~20 saved queries = ~10-25KB total. Well within the 100KB total / 8KB per-item limits (we'll split into chunks if an individual key exceeds 8KB, but unlikely at these sizes).

### UI

New file: `src/mdh/ui/query-history.js`

**Trigger:** A clock-icon button next to the pipeline/query editor toolbar in `records.js`.

**Panel:** A dropdown panel (positioned below the button) with two sections:

1. **History** — most recent first, shows truncated query text + timestamp. Click to load into editor. Auto-populated on every query execution.
2. **Saved** — alphabetical by name. Shows name + collection. Click to load. Small X button to delete. 

**Save action:** A "Save" button (star/bookmark icon) next to the history button. Clicking it opens a small inline input for naming the query, then stores it.

**Filtering:** Shows queries for the current collection by default. A "Show all collections" toggle at the bottom of the panel shows everything, with collection name as a badge on each entry.

### Integration points

- `records.js` calls `addToHistory(collection, query, pipeline)` after successful query execution
- `records.js` renders the history button and wires up `loadQuery(entry)` to populate editors
- All reads/writes go through `query-history.js` which owns the `chrome.storage.sync` interaction

---

## 3. Collection Stats Dashboard

### Data sources

All data already available:
- **Document count** — `totalCount` from state (already fetched on collection select)
- **Index count** — from `api.listIndexes()` (already fetched for Indexes tab)
- **Search index count** — from `api.listSearchIndexes()` (already fetched for Search Indexes tab)

### UI — Sidebar badges

Each collection item in the sidebar gets a small count badge showing document count. Populated from cache or fetched alongside collection data. Uses the eager-loading cache when available.

### UI — Summary bar

A horizontal stats bar at the top of the main content area (above the tab bar), visible when a collection is selected. Shows three stat chips:

```
[123 documents]  [3 indexes]  [1 search index]
```

Each chip is a clickable shortcut that switches to the corresponding tab.

### State integration

Stats are derived from existing state fields. A new `renderStats()` function in a new `src/mdh/ui/stats.js` module listens to state changes and updates the bar. No new API calls needed.

---

## 4. Bulk Collection Operations

### UI — Selection mode

A checkbox icon/toggle button at the top of the sidebar collection list header. When active:
- Each collection item shows a checkbox on the left
- A floating toolbar appears at the bottom of the sidebar when 2+ items are checked
- Clicking a collection name still selects it for viewing (checkbox is a separate click target)

### Toolbar actions

- **Drop selected** — opens a confirmation modal listing all selected collection names. On confirm, drops them sequentially via `api.dropCollection()`. Refreshes sidebar on completion.
- **Export selected** — downloads each selected collection as a separate `.json` file. Uses the existing download logic from records.js, extracted into a shared helper.

### State

Selection state is local to the sidebar module — a `Set<string>` of selected collection names. Cleared when selection mode is toggled off. No persistence needed.

### New file

`src/mdh/ui/bulk-operations.js` — owns the toolbar rendering and operation execution. Called by `sidebar.js` when selection state changes.

---

## Files to create

| File | Purpose |
|------|---------|
| `src/mdh/ui/query-history.js` | Query history & saved queries storage + UI |
| `src/mdh/ui/stats.js` | Collection stats summary bar |
| `src/mdh/ui/bulk-operations.js` | Bulk selection toolbar + operations |

## Files to modify

| File | Changes |
|------|---------|
| `src/mdh/ui/modal.js` | Fix escape listener stacking |
| `src/mdh/ui/records.js` | Event delegation, AbortController, download warning, history integration, replaceChildren |
| `src/mdh/ui/record-editor.js` | Extract panel builder, promise-chained close |
| `src/mdh/ui/sidebar.js` | Bulk selection checkboxes, stats badges, replaceChildren |
| `src/mdh/ui/indexes.js` | Stats count integration |
| `src/mdh/ui/search-indexes.js` | Stats count integration |
| `src/mdh/cache.js` | LRU eviction fix |
| `src/mdh/index.js` | Mount stats bar, wire up new modules |
| `src/mdh/mdh.html` | Container elements for stats bar |
| `src/mdh/mdh.css` | Styles for stats bar, query history panel, bulk toolbar, badges |
| `src/rossum/features/scroll-lock.js` | Replace RAF with setInterval |
| `src/netsuite/index.js` | Consolidate regex |
