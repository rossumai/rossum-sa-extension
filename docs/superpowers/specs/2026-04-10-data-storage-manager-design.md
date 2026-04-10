# Data Storage Manager — Design Spec

A full-page Chrome extension tab for browsing and managing Rossum Data Storage collections, records, indexes, and search indexes. Provides a complete CRUD interface with aggregation, bulk write, and index management.

## Context

The Rossum SA Extension is a Chrome extension (Manifest V3) that enhances Rossum, NetSuite, and Coupa UIs for solution architects. Currently it has a popup for toggling features and a button that links to Rossum's built-in MDH management page. This feature adds a dedicated Data Storage management page opened in a new browser tab.

## Decisions

- **Page type:** New Chrome extension tab page (`chrome-extension://<id>/mdh/mdh.html`), opened from a new button in the popup. The existing "Master Data Hub" button linking to `/svc/data-matching/web/management` is preserved as-is.
- **Data scope:** Rossum Data Storage API (`/svc/data-storage/api/v1/`) only. MDH datasets are out of scope.
- **Operations:** All 19 Data Storage API endpoints (including insert_many and update_many) — no omissions.
- **Layout:** Sidebar (collection list) + main panel with tabbed sub-views.
- **Code architecture:** Modular vanilla JS under `src/mdh/`, bundled by esbuild. No frameworks, no new dependencies.
- **Theming:** Light + dark via `prefers-color-scheme` media query with CSS custom properties.
- **JSON editing:** Raw JSON textarea with validation on submit.
- **Authentication:** Token + domain passed via `chrome.storage.local` from popup → extension page.

## Architecture

### File Structure

```
src/mdh/
├── mdh.html              # Extension page shell
├── mdh.css               # All styles (light + dark themes)
├── index.js              # Entry point: init auth, render app shell, wire routing
├── api.js                # Data Storage API client (all fetch calls)
├── state.js              # Central state + event emitter for UI updates
└── ui/
    ├── sidebar.js         # Collection list sidebar
    ├── records.js         # Record table: find, paginate, sort, view, delete
    ├── record-editor.js   # Modal: insert / update / replace a record
    ├── update-many.js     # Modal: update many with filter + update inputs
    ├── delete-many.js     # Modal: delete many with filter input
    ├── aggregate.js       # Aggregation pipeline editor + results
    ├── bulk-write.js      # Modal: bulk write operations editor
    ├── indexes.js         # Index management panel
    ├── search-indexes.js  # Search index management panel
    └── modal.js           # Shared modal infrastructure
```

### Build Changes

- New esbuild entry point: `'mdh/mdh': 'src/mdh/index.js'`
- Copy `src/mdh/mdh.html` and `src/mdh/mdh.css` to `dist/mdh/`

### Manifest Changes

- Add `host_permissions` for Rossum domains (required for cross-origin fetch from extension page):
  ```json
  "host_permissions": [
    "http://localhost:3000/*",
    "https://*.rossum.ai/*",
    "https://*.rossum.app/*",
    "https://*.r8.lol/*"
  ]
  ```
- No other manifest changes needed — the page is opened via `chrome.runtime.getURL()`, not registered as an options page or devtools panel.

### Popup Changes

- Keep existing "Master Data Hub" button (opens `/svc/data-matching/web/management`)
- Add new "Data Storage" button next to it
- New button: sends `get-auth-info` message to content script → saves `{ mdhToken, mdhDomain }` to `chrome.storage.local` → opens `chrome.runtime.getURL('mdh/mdh.html')`

### Content Script Changes

- Add message handler in `src/rossum/features/dev-flags.js` (or a new module) for `get-auth-info` message
- Returns `{ token: window.localStorage.getItem('secureToken'), domain: window.location.origin }`

## Authentication Flow

1. User is on a Rossum page, clicks "Data Storage" button in popup
2. Popup sends `chrome.tabs.sendMessage(tabId, 'get-auth-info')` to content script
3. Content script returns `{ token, domain }` from `window.localStorage`
4. Popup writes `chrome.storage.local.set({ mdhToken: token, mdhDomain: domain })`
5. Popup opens `chrome.runtime.getURL('mdh/mdh.html')` in a new tab
6. `index.js` reads `mdhToken` and `mdhDomain` from `chrome.storage.local`
7. Initializes `api.js` with base URL (`${domain}/svc/data-storage/api/v1`) and auth header (`Bearer ${token}`)
8. On 401 from any API call: show error "Session expired. Open a Rossum page and click Data Storage again to reconnect."

## State Management

Central `state.js` module with event emitter pattern.

### State Shape

```js
{
  domain: "",
  token: "",
  collections: [],
  selectedCollection: null,
  records: [],
  filter: "{}",
  sort: "{}",
  projection: "",
  skip: 0,
  limit: 30,
  activePanel: "records",   // "records" | "aggregate" | "indexes" | "search-indexes" | "bulk-write"
  loading: false,
  error: null,
}
```

### Events

| Event | Triggers |
|---|---|
| `collectionsChanged` | Sidebar re-renders collection list |
| `selectedCollectionChanged` | Main panel reloads data for new collection |
| `recordsChanged` | Records table re-renders |
| `activePanelChanged` | Switches visible panel in main area |
| `loadingChanged` | Shows/hides loading spinner |
| `errorChanged` | Shows/hides error banner |

### Data Flow

1. User action triggers a UI handler
2. Handler sets `loading: true` via state
3. Handler calls `api.js` method
4. On success: handler updates state with results, sets `loading: false`
5. On error: handler sets `error`, sets `loading: false`
6. Subscribed UI modules re-render from new state

## API Client

`api.js` wraps all 17 Data Storage endpoints. Initialized once with domain and token.

### Endpoints

| Method | API Path | Returns |
|---|---|---|
| `listCollections(filter, nameOnly)` | `POST /collections/list` | `string[]` or `object[]` |
| `createCollection(name, options)` | `POST /collections/create` | `SuccessResponse` |
| `renameCollection(name, target, dropTarget)` | `POST /collections/rename` | `SuccessResponse` |
| `dropCollection(name)` | `POST /collections/drop` | `AcceptResponse` (202) |
| `find(collection, { query, projection, skip, limit, sort })` | `POST /data/find` | `document[]` |
| `insertOne(collection, document)` | `POST /data/insert_one` | `InsertOneResponse` |
| `insertMany(collection, documents, ordered)` | `POST /data/insert_many` | `InsertManyResponse` |
| `updateOne(collection, filter, update)` | `POST /data/update_one` | `UpdateResponse` |
| `updateMany(collection, filter, update)` | `POST /data/update_many` | `UpdateResponse` |
| `deleteOne(collection, filter)` | `POST /data/delete_one` | `DeleteResponse` |
| `deleteMany(collection, filter)` | `POST /data/delete_many` | `DeleteResponse` |
| `replaceOne(collection, filter, replacement)` | `POST /data/replace_one` | `UpdateResponse` |
| `aggregate(collection, pipeline)` | `POST /data/aggregate` | `document[]` |
| `bulkWrite(collection, operations)` | `POST /data/bulk_write` | `AcceptResponse` (202) |
| `listIndexes(collection, nameOnly)` | `POST /indexes/list` | `string[]` or `object[]` |
| `createIndex(collection, indexName, keys)` | `POST /indexes/create` | `AcceptResponse` (202) |
| `dropIndex(collection, indexName)` | `POST /indexes/drop` | `AcceptResponse` (202) |
| `listSearchIndexes(collection, nameOnly)` | `POST /search_indexes/list` | `string[]` or `object[]` |
| `createSearchIndex(collection, { indexName, mappings, ... })` | `POST /search_indexes/create` | `AcceptResponse` (202) |
| `dropSearchIndex(collection, indexName)` | `POST /search_indexes/drop` | `AcceptResponse` (202) |
| `checkOperationStatus(operationId)` | `GET /operation_status/{id}` | `OperationStatusResponse` |
| `healthz()` | `GET /healthz` | `HealthzResponse` |

### Error Handling

- All methods throw on non-OK responses with the error message from the API
- 401 responses trigger a session-expired message
- Callers catch errors and set `state.error`

### Async Operations

Operations returning 202 (`dropCollection`, `bulkWrite`, `createIndex`, `dropIndex`, `createSearchIndex`, `dropSearchIndex`) extract the `operation_id` from the response message. The UI shows an "Operation pending" banner with a "Check Status" button that calls `checkOperationStatus()`.

## UI Panels

### Sidebar (`sidebar.js`)

- Lists all collections from `state.collections`
- "Create" input + button at top
- Click collection to select (updates `state.selectedCollection`)
- Right-click opens a custom context menu (positioned at cursor, not the browser default) with "Rename" and "Drop" options
- Rename shows inline edit input
- Drop shows confirmation dialog
- Refreshes collection list after create/rename/drop

### Records Panel (`records.js`)

Default panel when a collection is selected.

- **Toolbar row 1:** Filter JSON input + "Find" button + "+ Insert" button + "Update Many" button + "Delete Many" button
- **Toolbar row 2:** Sort JSON input + Projection JSON input
- **Record rows:** `_id` + truncated JSON preview + action buttons (Expand, Edit, Replace, Del)
- **Expand:** Inline pretty-printed JSON below the row
- **Pagination:** Skip-based with Prev/Next buttons, page indicator, configurable limit (30 default)
- "Find" validates JSON before submitting, resets skip to 0

### Record Editor Modal (`record-editor.js`)

Shared modal for three operations:

- **Insert one:** Empty JSON textarea, submits via `api.insertOne()`
- **Insert many:** JSON textarea expecting an array of documents, submits via `api.insertMany()`. Toggle between "Insert One" / "Insert Many" mode at top of modal.
- **Edit (Update):** Pre-filled with `{ "$set": { ...currentFields } }`, submits via `api.updateOne()`. Filter is `{ "_id": record._id }`.
- **Replace:** Pre-filled with current full document (minus `_id`), submits via `api.replaceOne()`. Filter is `{ "_id": record._id }`.

All validate JSON before submit. On success, close modal and refresh records.

### Update Many Modal (`update-many.js`)

- JSON textarea for the filter (which documents to update)
- JSON textarea for the update expression (e.g., `{ "$set": { "status": "active" } }`)
- "Preview" button runs `api.find()` with limit 5 to show what will be updated
- Confirmation required to execute
- On success, show matched/modified counts and refresh records

### Delete Many Modal (`delete-many.js`)

- JSON textarea for the filter
- Shows warning: "This will delete ALL documents matching the filter"
- "Preview" button runs `api.find()` with limit 5 to show what will be deleted
- Confirmation required to execute
- On success, refresh records

### Aggregate Panel (`aggregate.js`)

- Split view: pipeline editor (left) + results (right)
- Pipeline textarea pre-filled with `[]`
- "Run Pipeline" button validates JSON array and calls `api.aggregate()`
- Results displayed as pretty-printed JSON
- Shows result count

### Bulk Write Panel (`bulk-write.js`)

- JSON textarea for the operations array
- Pre-filled with example template:
  ```json
  [
    {"insertOne": {"document": {}}},
    {"updateOne": {"filter": {}, "update": {"$set": {}}}},
    {"deleteOne": {"filter": {}}}
  ]
  ```
- "Run" button validates JSON and calls `api.bulkWrite()`
- Shows async operation status with "Check Status" button

### Indexes Panel (`indexes.js`)

- Lists indexes with name + keys display
- Default `_id_` index shown but without Drop button
- "Drop" button on other indexes with confirmation
- "Create Index" form: name input + keys JSON input + Create button
- Async operations show status with "Check Status" button

### Search Indexes Panel (`search-indexes.js`)

- Same list pattern as regular indexes
- "Create Search Index" form: name input + mappings JSON textarea + optional analyzer/searchAnalyzer inputs
- Drop with confirmation
- Async operation status

### Modal Infrastructure (`modal.js`)

- Generic modal: overlay + centered card + close button
- `openModal(title, contentElement, onClose)` / `closeModal()`
- Confirmation variant: `confirmModal(title, message, onConfirm)` with Cancel + Confirm buttons
- Escape key and overlay click close the modal

## Theming

CSS custom properties with `prefers-color-scheme` media query.

### Light Theme (default)

```
--bg-base: #f1f1f5       --text-primary: #1a1a24
--bg-card: #ffffff        --text-secondary: #7a7a8c
--bg-input: #ffffff       --text-code: #333
--bg-hover: #e8e8ee       --border: #ddd
--bg-sidebar: #f8f8fb     --accent: #4270db
--bg-code: #f5f5f8        --accent-hover: #3560c5
                          --danger: #cc3333
                          --success: #22883e
```

### Dark Theme

```
--bg-base: #12121e        --text-primary: #ccccdd
--bg-card: #1a1a2e        --text-secondary: #666680
--bg-input: #0d0d18       --text-code: #aaaabb
--bg-hover: #2a2a3e       --border: #333
--bg-sidebar: #1a1a2e     --accent: #4270db
--bg-code: #0d0d18        --accent-hover: #5580ee
                          --danger: #cc3333
                          --success: #22883e
```

Typography: system fonts for UI, monospace for JSON/code/IDs. Consistent with existing popup.

## Confirmation Dialogs

Required before these destructive operations:

- Delete one record
- Delete many records
- Drop collection
- Drop index
- Drop search index

Pattern: `confirmModal("Drop collection?", "This will permanently delete 'vendors' and all its data.", onConfirm)`

## Error Handling

- JSON validation before every API call that takes JSON input — show inline error below the textarea
- API errors displayed in a dismissible banner at the top of the main panel
- 401 errors show session-expired message with instructions to reconnect
- Network errors (fetch failure) show "Connection failed" message
