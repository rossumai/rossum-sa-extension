# MDH Preact Migration Design

Migrate the Dataset Manager (MDH) standalone page from imperative vanilla JS to Preact with signals. Full rewrite of `src/mdh/` UI code; no changes to content scripts, popup, or other extension areas.

## Decisions

- **Framework:** Preact (~3KB) with JSX
- **State management:** `@preact/signals` (~1KB) replacing custom event emitter
- **CodeMirror:** Wrapped as a Preact component (`<JsonEditor>`)
- **Migration strategy:** Full rewrite (MDH is isolated from rest of extension)
- **CSS approach:** Evolve existing styles — keep design system, remove dead selectors, let Preact's conditional rendering replace `.hidden` toggling

## Build & Dependencies

### New dependencies

- `preact`
- `@preact/signals`

### esbuild config changes

Add JSX pragma to `build.js`:

```js
const options = {
  // ...existing options...
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
};
```

Entry point changes from `'mdh/mdh': 'src/mdh/index.js'` to `'mdh/mdh': 'src/mdh/index.jsx'`.

Static asset copying (`mdh.html`, `mdh.css`) stays the same.

### mdh.html

Simplifies to a mount point. The static shell elements (sidebar, tabs, panels, error banner, loading overlay) move into Preact components:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Data Storage — Rossum SA</title>
  <link href="mdh.css" rel="stylesheet" />
</head>
<body>
  <div id="app"></div>
  <script src="mdh.js"></script>
</body>
</html>
```

## State Management

### Global store (`store.js`)

Each key from the current `state.js` becomes a signal:

```js
import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');
export const collections = signal([]);
export const selectedCollection = signal(null);
export const records = signal([]);
export const skip = signal(0);
export const limit = signal(50);
export const activePanel = signal('data');
export const loading = signal(false);
export const error = signal(null);
export const modalContent = signal(null);
```

Components that read a signal auto-re-render when it changes. No manual `on()`/`off()` subscriptions.

### What stays outside signals

- `api.js` — unchanged, pure async functions
- `cache.js` — unchanged, in-memory LRU
- Transient UI state (expanded records, sort/filter state, pipeline text, placeholder values) — local `signal()` or `useState` within owning components, not in global store

## File Structure

```
src/mdh/
├── index.jsx              # mount Preact app, boot logic (auth, api.init, prefetch)
├── store.js               # global signals
├── api.js                 # unchanged
├── cache.js               # unchanged
├── mdh.html               # simplified mount point
├── mdh.css                # evolved (dead selectors removed)
├── components/
│   ├── App.jsx            # layout shell: sidebar + resizer + main area
│   ├── Sidebar.jsx        # collection list, create/rename/drop
│   ├── SidebarResizer.jsx # drag-to-resize sidebar
│   ├── ConnectionBar.jsx  # connected/disconnected status
│   ├── ErrorBanner.jsx    # dismissable error display
│   ├── LoadingOverlay.jsx # spinner overlay
│   ├── TabBar.jsx         # Data / Indexes / Search Indexes tabs
│   ├── DataPanel.jsx      # pipeline + records split view, owns usePipeline/useQuery/usePagination
│   ├── PipelineEditor.jsx # left pane: JsonEditor + query action buttons + save/history/beautify
│   ├── PlaceholderInputs.jsx  # variable inputs extracted from pipeline text
│   ├── PipelineDebug.jsx  # aggregation stage-by-stage debug with counts
│   ├── RecordList.jsx     # record cards container
│   ├── RecordCard.jsx     # single expandable record with copy/edit/delete actions
│   ├── JsonTree.jsx       # interactive recursive key/value tree with sort/filter clicks
│   ├── IndexPanel.jsx     # indexes tab: list + create modal
│   ├── SearchIndexPanel.jsx   # search indexes tab: list + create modal
│   ├── IndexCard.jsx      # shared expandable card for index display
│   ├── JsonEditor.jsx     # Preact wrapper around CodeMirror 6
│   ├── Modal.jsx          # modal overlay driven by modalContent signal
│   ├── DeleteMany.jsx     # delete-many modal content
│   ├── RecordEditor.jsx   # edit/replace single record modal content
│   ├── DataOperations.jsx # insert/update/replace modals (manual + file upload)
│   └── QueryHistory.jsx   # history + saved query dropdown panels
└── hooks/
    ├── usePipeline.js     # pipeline text, sort/filter/placeholder state, buildPipelineFromUI, sync
    ├── useQuery.js        # query execution, caching, stale detection (queryId pattern)
    └── usePagination.js   # skip/limit/page navigation, total count fetching
```

### File mapping from current code

| Current file | New location |
|---|---|
| `index.js` | `index.jsx` + `App.jsx` |
| `state.js` | `store.js` |
| `api.js` | `api.js` (unchanged) |
| `cache.js` | `cache.js` (unchanged) |
| `ui/sidebar.js` | `Sidebar.jsx` |
| `ui/records.js` (1,422 lines) | `DataPanel.jsx`, `PipelineEditor.jsx`, `PlaceholderInputs.jsx`, `PipelineDebug.jsx`, `RecordList.jsx`, `RecordCard.jsx`, `JsonTree.jsx`, + `usePipeline.js`, `useQuery.js`, `usePagination.js` |
| `ui/record-editor.js` | `RecordEditor.jsx` + `DataOperations.jsx` |
| `ui/modal.js` | `Modal.jsx` |
| `ui/indexes.js` | `IndexPanel.jsx` |
| `ui/search-indexes.js` | `SearchIndexPanel.jsx` |
| `ui/index-card.js` | `IndexCard.jsx` |
| `ui/json-editor.js` | `JsonEditor.jsx` |
| `ui/delete-many.js` | `DeleteMany.jsx` |
| `ui/query-history.js` | `QueryHistory.jsx` |
| `ui/utils.js` | Inlined — `escapeHtml` not needed (Preact auto-escapes), `showAsyncStatus` moves into panel components |

## Component Details

### `index.jsx` — Boot

Reads `chrome.storage.local` for `mdhToken`/`mdhDomain`, calls `api.init()`, sets global signals, renders `<App />` into `#app`. Background prefetch logic (batch-loading other collections) runs as an `effect()` triggered by `selectedCollection` changing.

### `App.jsx` — Layout

```jsx
function App() {
  return (
    <div id="app">
      <Sidebar />
      <SidebarResizer />
      <main class="main">
        <ConnectionBar />
        <ErrorBanner />
        <LoadingOverlay />
        <Modal />
        {selectedCollection.value ? (
          <div class="main-content">
            <TabBar />
            {activePanel.value === 'data' && <DataPanel />}
            {activePanel.value === 'indexes' && <IndexPanel />}
            {activePanel.value === 'search-indexes' && <SearchIndexPanel />}
          </div>
        ) : (
          <div class="empty-state"><p>Select a collection to get started</p></div>
        )}
      </main>
    </div>
  );
}
```

Conditional rendering replaces `.hidden` class toggling.

### `DataPanel.jsx` — Split pane orchestrator

Owns three custom hooks:

- **`usePipeline()`** — manages pipeline text signal, `sortState`, `filterState`, `placeholderValues` as local signals. Provides `buildPipelineFromUI()`, `syncPipeline()`, `toggleSort(field)`, `toggleFilter(field, value)`. Replaces the 12 module-level `let` variables in current `records.js`.
- **`useQuery(collection, pipelineText)`** — executes aggregation via `api.aggregate()`, manages `queryId` for stale detection, integrates with cache. Returns `{ records, lastQueryMs, runQuery, isRunning }`.
- **`usePagination(totalCount)`** — manages skip/limit, provides `page`, `hasPrev`, `hasNext`, `goNext()`, `goPrev()`, `reset()`.

Also owns the horizontal resizer between pipeline editor and records pane (persists width to `chrome.storage.local`).

### `JsonEditor.jsx` — CodeMirror wrapper

```jsx
function JsonEditor({ value, onChange, onValidChange, mode, fields, compact, readOnly, onSubmit, editorRef }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);

  useEffect(() => {
    const view = new EditorView({
      state: createEditorState(value, { mode, fields, compact, readOnly, onSubmit, onChange, onValidChange }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []);

  // Expose imperative API for cases that need getValue/setValue/isValid/getParsed
  useEffect(() => {
    if (editorRef) {
      editorRef.current = {
        getValue: () => viewRef.current.state.doc.toString(),
        setValue: (v) => viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: v } }),
        isValid: () => { try { JSON5.parse(viewRef.current.state.doc.toString()); return true; } catch { return false; } },
        getParsed: () => JSON5.parse(viewRef.current.state.doc.toString()),
        refresh: () => viewRef.current.requestMeasure(),
      };
    }
  }, []);

  return <div class={compact ? 'json-editor json-editor-compact' : 'json-editor'} ref={containerRef} />;
}
```

MongoDB autocompletion sets, JSON5 validation, dark mode detection all carry over.

### `Modal.jsx` — Signal-driven modals

```jsx
function Modal() {
  const modal = modalContent.value;

  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  if (!modal) return null;

  return (
    <div class="modal-overlay visible" onClick={e => e.target === e.currentTarget && closeModal()}>
      <div class="modal-card">
        <div class="modal-header">
          <span class="modal-title">{modal.title}</span>
          <button class="modal-close" onClick={closeModal}>&times;</button>
        </div>
        {modal.render()}
      </div>
    </div>
  );
}

export function closeModal() { modalContent.value = null; }

export function confirmModal(title, message, onConfirm) {
  modalContent.value = { title, render: () => <ConfirmBody message={message} onConfirm={onConfirm} /> };
}

export function promptModal(title, options, onSubmit) {
  modalContent.value = { title, render: () => <PromptBody options={options} onSubmit={onSubmit} /> };
}
```

### `JsonTree.jsx` — Recursive interactive display

The current `renderInteractiveJson()` function (135 lines) becomes a recursive component. Props: `data`, `prefix`, `sortState`, `filterState`, `onSort`, `onFilter`. Handles objects, arrays, EJSON types, and primitive values. Sort/filter clicks bubble up to `DataPanel` via callbacks.

### Async operation status

The current `showAsyncStatus()` utility renders inline HTML for operation polling. In Preact, `IndexPanel` and `SearchIndexPanel` each maintain a local `operationStatus` signal. When a create/drop operation returns an operation ID, the signal updates and the component renders a status badge with a "Check Status" button — no innerHTML needed.

## CSS Changes

- Remove `.hidden` utility class usages — Preact conditionally renders instead
- Remove selectors that targeted dynamically created elements only reachable via `createElement` chains — components render their own class names directly
- Keep all CSS variable definitions, color scheme, dark mode media query
- Keep all visual styles (cards, buttons, badges, layout, typography)
- `escapeHtml()` calls in `innerHTML` strings become unnecessary — Preact JSX auto-escapes

## Migration Boundaries

### Untouched (outside `src/mdh/`)

- `src/rossum/` — content script, MutationObserver pattern
- `src/netsuite/` — content script
- `src/coupa/` — content script
- `src/popup/` — popup UI, communicates via `chrome.storage.local` only
- `manifest.json` — no changes needed

### Untouched (within `src/mdh/`)

- `api.js` — pure fetch wrapper, no DOM or state coupling
- `cache.js` — in-memory LRU, no DOM or state coupling

### Chrome APIs (same usage, different call sites)

- `chrome.storage.local` — auth tokens (`mdhToken`, `mdhDomain`), sidebar width, pipeline pane width
- `chrome.storage.sync` — query history, saved queries
- Calls move into owning components/hooks but the API surface is identical

### External behavior preserved

- Popup "Data Storage" button flow unchanged
- MDH page URL (`chrome-extension://…/mdh/mdh.html`) unchanged
- All Data Storage API interactions unchanged
- Dark mode via `prefers-color-scheme` unchanged
