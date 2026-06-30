# Drag-and-drop file support for the import/file-pick modals

**Date:** 2026-06-30
**Status:** Approved (design); pending spec review → implementation plan
**Area:** Console → Dataset Management (MDH) → "Insert from XYZ file" wizards + Update/Replace-from-file panels

## Problem

The MDH file-import modals let the user pick a file **only by clicking** a dashed
box that opens the OS file dialog. The box (`.file-input-area`, `console.css:1313`)
*already* renders a `2px dashed` border — so it visually reads as a drop target —
but nothing handles a dropped file. Users who drag a file onto it get no result,
and a file dropped just outside the box makes the browser navigate away and open
the file, destroying the Console session.

We want to add **drag-and-drop** as a second way to choose a file, across every
file-pick surface, without changing the existing click behavior and without any
API, storage, or dependency changes.

## Surfaces in scope (verified in code)

**Five picker components**, surfaced through seven menu entries (the
`InsertFileWizard` serves both JSON and JSONL; the `FileInput` serves both Update
and Replace). All launched from `DataOperations.jsx` (`openDataOperations`) via
`openModal`:

| Surface | Component | Picker sub-component | input `data-testid` | `accept` |
|---|---|---|---|---|
| Insert from JSON | `InsertFileWizard.jsx` (`format="json"`) | `StagePick` | *(none)* | `.json,application/json` |
| Insert from JSONL | `InsertFileWizard.jsx` (`format="jsonl"`) | `StagePick` | *(none)* | `.jsonl,.ndjson,application/x-ndjson` |
| Insert from CSV | `CsvImportWizard.jsx` | `CsvStagePick` | `csv-file-input` | `.csv,text/csv` |
| Insert from XML | `XmlImportWizard.jsx` | `XmlStagePick` | `xml-file-input` | `.xml,text/xml,application/xml` |
| Insert from Excel | `XlsxImportWizard.jsx` | `XlsxStagePick` | `xlsx-file-input` | `.xlsx` |
| Update from file | `DataOperations.jsx` → `UpdatePanel` | `FileInput` | *(none)* | `.json` |
| Replace from file | `DataOperations.jsx` → `ReplacePanel` | `FileInput` | *(none)* | `.json` |

Two structural shapes exist today:

- **Wizard `*StagePick`** (4 near-identical copies): hidden
  `<input type="file" style="display:none" onChange={pick}>` + a
  `.file-input-area` div with `onClick={() => inputRef.current?.click()}` +
  a `.file-input-label` and `.file-input-info`. Parsing happens in the wizard's
  `handleFile(file)`.
- **`FileInput`** (used by `UpdatePanel` + `ReplacePanel`): the click target is
  the **label**, parsing happens **inside** `FileInput`, and the **filename + doc
  count render inline** after selection. Calls `onParsed(parsedDocs)`.

There is **no existing file drag-and-drop anywhere** in the codebase
(`mdh-sidebar-drop.test.js` is about *deleting* a collection, unrelated). Existing
tests simulate file selection by dispatching a `change` event on the hidden input
after defining its read-only `files` list via `Object.defineProperty`.

## Decisions (confirmed with the user)

1. **Scope = all five file-pick surfaces** (4 Insert wizards + Update/Replace
   `FileInput`), so every picker behaves consistently.
2. **Structure = a shared `FileDropArea` component** (Approach A). The 4 wizard
   `*StagePick`s collapse to thin wrappers; `FileInput` wraps it too. This removes
   the existing 4× duplication rather than adding abstraction for its own sake.
3. **Wrong-type drop → reject with a friendly, extension-based message.** MIME
   types are unreliable, so validation is by file extension.
4. **Mis-drop guard on the modal overlay.** Dropping a file anywhere on the
   full-screen `.modal-overlay` (outside an actual drop zone) is swallowed so the
   browser never navigates to the file.
5. **Backward-compat split: extension validation runs on the DROP path only.**
   The click path is left exactly as today (the OS dialog already filters by
   `accept`; a force-picked odd extension still flows to the parser unchanged).
   Trade-off accepted: a correctly-formatted file with a non-standard extension is
   rejected *on drop* but still works *via click*.
6. **No new storage keys, API calls, or dependencies.**

## Component contract: `FileDropArea.jsx`

New file `src/mdh/components/FileDropArea.jsx`.

```
FileDropArea({ accept, onFile, onReject, inputTestid, children })
```

- **Renders:** the hidden `<input type="file" accept={accept}>`, the
  `.file-input-area` div, and `{children}` (each host passes its own label/info or
  inline filename + doc count).
- **Click path (unchanged):** clicking the area opens the input; the input's
  `change` event → `onFile(file)`. Same input element, same `accept`, same
  `data-testid` (forwarded via `inputTestid`). No extension validation on this
  path — preserves today's behavior and keeps every existing test green.
- **Drop path:** on `drop`, take `dataTransfer.files[0]`, run the extension check:
  valid → `onFile(file)`; invalid → `onReject(message)`. Calls `preventDefault()`
  and `stopPropagation()` so the event is handled exactly once and never reaches
  the overlay guard.
- **Drag highlight:** `dragenter`/`dragover`/`dragleave` toggle internal
  `dragging` state → `.drag-over` class on the area. A nested enter/leave **counter**
  (increment on enter, decrement on leave, `dragging = counter > 0`) prevents the
  highlight flickering when the cursor moves over the inner label/info children.
  `dragover` sets `dataTransfer.dropEffect = 'copy'`.
- **Files-only gate:** every drag handler is a no-op unless
  `dataTransfer.types.includes('Files')`. This stops the zone lighting up when the
  user drags non-file content (e.g. a draggable sidebar collection) across it.
- **Multiple files:** uses `files[0]` only, matching today's single-file
  `files?.[0]` semantics. (No multi-file import flow exists.)

### Extension validation

Derive the allowed-extension list once from `accept`: split on commas, keep the
`.`-prefixed tokens, lowercase them. A dropped file passes if
`file.name.toLowerCase()` ends with any allowed extension. If `accept` yields no
dotted token (not the case for any current surface), validation is skipped
(accept anything). Reject message format: `Expected a <ext> file` (joined to the
real list when more than one, e.g. `Expected a .jsonl or .ndjson file`).

## Overlay mis-drop guard: `Modal.jsx`

Add `onDragOver` and `onDrop` handlers to the existing `.modal-overlay` element
(the full-screen `position:fixed; inset:0` backdrop, `console.css:1250`) that call
`preventDefault()`. This swallows any drop that lands on the overlay or modal card
outside a real `FileDropArea`, so the browser never opens the file / navigates
away. Applied **unconditionally** to every modal (harmless — no modal wants a
dropped file to open). Because `FileDropArea` calls `stopPropagation()` on real
drops, valid drops are not double-handled.

## Wiring the surfaces

- **`InsertFileWizard` `StagePick`** (JSON + JSONL) → renders `FileDropArea` with
  `onFile={onFile}` (existing `handleFile`), `onReject={setErrorMsg}`, no
  `inputTestid`. Existing label/info text passed as children.
- **`CsvImportWizard` `CsvStagePick`** → same, `inputTestid="csv-file-input"`.
- **`XmlImportWizard` `XmlStagePick`** → same, `inputTestid="xml-file-input"`.
- **`XlsxImportWizard` `XlsxStagePick`** → same, `inputTestid="xlsx-file-input"`.
- **`DataOperations` `FileInput`** (Update + Replace) → keeps its own `fileName` /
  `docCount` state and renders them as children; its read+parse logic moves into
  an `onFile(file)` handler that still calls `onParsed(parsedDocs)`. Gains a small
  inline error display fed by `onReject` (today it shows read errors by setting
  `fileName` to `Error: …`; reject messages route the same way).

## CSS

One rule added to `console.css`:

```css
.file-input-area.drag-over {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-bg);
}
```

Reuses existing semantic variables; introduces no new tokens. The resting dashed
border stays as-is.

## Error handling & edge cases

- Wrong extension on drop → friendly message in the host's existing error slot
  (`errorMsg` line for wizards; the new inline error for `FileInput`). `onFile`
  not called; stage does not advance.
- Empty drop / no files in `dataTransfer` → no-op.
- Drag carrying non-file data → ignored (files-only gate); no highlight.
- Read failure after a valid drop → unchanged existing `Couldn't read file …`
  path inside each host's `onFile`.
- Drop outside any zone but on the modal → swallowed by the overlay guard.

## Testing

New `tests/mdh-file-drop.test.js` (jsdom), reusing the existing
`Object.defineProperty` pattern to attach a synthetic `dataTransfer`
(`{ files: [file], types: ['Files'] }`) to dispatched `dragover`/`drop` events:

1. Valid file drop → `onFile` called with the file; wizard advances past the pick
   stage.
2. Wrong-extension drop → `onReject`/error shown; `onFile` not called.
3. `dragover` with files → `.drag-over` class present; `dragleave` (counter to 0)
   → class removed.
4. Drag without `'Files'` in `types` → no highlight, no `onFile`.
5. Drop on `.modal-overlay` → `event.defaultPrevented === true`.

Regression guard: the **entire existing suite must stay green** — `data-testid`s,
`accept` values, and the `change`-event click path are all preserved unchanged.

## Backward compatibility

- Click-to-select path is byte-for-byte unchanged (same input, testids, `accept`,
  `change` handler → `onFile`).
- Extension validation is **drop-only**, so no click-path behavior changes.
- `.file-input-area` markup and classes are preserved (label/info become
  children).
- Overlay guard is additive and inert for existing/non-file modals.
- No storage keys, API surface, or dependency changes.

## Out of scope (YAGNI)

- Multi-file import.
- Keyboard accessibility of the dashed box (a pre-existing gap — the box is a
  clickable `div`, not a button; not regressed, not fixed here).
- Drag-and-drop anywhere outside the MDH file-pick modals.
