# Import Source Toggle (File / Clipboard) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`
**Builds on:** `docs/superpowers/specs/2026-06-30-unified-dataset-import-design.md` (the unified Import wizard)

## 1. Problem & goal

The unified Import wizard currently requires the **format to be chosen up front**
via a split-button menu (`Import ▾` → From JSON / CSV / Excel / XML / JSONL file,
plus a separate insert-only "Paste JSON…" path). This spreads "import" across a
split button + a second inline paste path.

**Goal:** collapse everything under **one plain `Import` button** that opens the
modal, where the user first picks a **source**:

- **From file** (default) — drop/choose **any supported file**; the format is
  **auto-detected** (JSON, JSONL, CSV, Excel, XML).
- **From clipboard** — paste or hand-type data in a JSON editor (JSON / JSONL).

Both sources then flow through the **same** Insert / Update / Replace pipeline
(match keys, live plan, block-if-non-unique, progress) that already exists.

### Non-goals
- No change to the mode/plan/execute pipeline (`importPlan.js`, `runImport.js`,
  `ImportConfirm.jsx`, `ImportStages.jsx`) — reused verbatim.
- No change to the per-format parsers or their ConfigureControls.
- Clipboard does **not** accept CSV/XML/Excel (Excel is binary; CSV/XML come via
  the File source). Clipboard is JSON/JSONL only.

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| Entry point | One plain **`Import`** button (no split/dropdown). |
| Source model | Two sources chosen inside the modal: **File (default)** and **Clipboard**, via a top **`File \| Clipboard` segmented toggle**. |
| File scope | **Any** supported file; format **auto-detected by extension**. |
| Clipboard scope | **JSON / JSONL** only, in the existing **rich `JsonEditor`** (with field autocomplete). Parsed from the editor's **raw text** so JSON *and* JSON-lines both work. |
| Clipboard capabilities | **Full unified pipeline** — pasted data gets the same Insert / Update / Replace + match-keys + plan + block-if-non-unique as file import. |
| Unknown file type | **Rejected** with a clear message (not content-sniffed). |
| Retire | `openDataOperations` + `InsertPanel` (inline paste, absorbed by Clipboard tab) and the now-unused generic `SplitButton`. |
| Commit policy | Write this spec; **do not git-commit** (standing user preference). |

## 3. Verified facts (grounding)

- Import is reached ONLY via `DataPanel.handleRefresh` → `openImport(format, onSuccess)` / `openDataOperations('insert', onSuccess, fieldsFn)`, triggered by the `RecordList` `SplitButton`. No other callers (grep-confirmed).
- `ImportWizard` currently takes a **preselected `format` prop**; PICK renders `FileDropArea accept={fmt.accept}` for that one format. No format-detection helper exists yet.
- `JsonEditor` (`components/JsonEditor.jsx`) exposes an imperative `editorRef` with `getValue()` (raw text via `state.doc.toString()`), `isValid()`, `getParsed()` (JSON5). Raw text access via `getValue()` is what enables JSONL parsing.
- `formats/json.js` `parse(text)` already does `JSON.parse` → NDJSON fallback (`parseNdjson`), returning `{docs, columns, warnings, error}` — so one call handles pasted JSON *and* JSON-lines.
- The generic `SplitButton` (defined in `RecordList.jsx`) is used ONLY by the Import button (grep-confirmed); `BulkSplitButton` and `DownloadSplitButton` are separate components.
- `ImportConfirm` renders `fileMeta?.name` optionally (a synthetic name for clipboard is fine).

## 4. UX

### Entry
Toolbar: a single `Import` button (`btn btn-sm btn-success`) → `onRefresh('import')`.

### Modal — PICK stage
```
Import
[ File | Clipboard ]           ← segmented (Segmented from ImportControls), default File

FILE:                          CLIPBOARD:
┌─────────────────────────┐    ┌─────────────────────────┐
│ Drop a file or click    │    │ [ JsonEditor ]          │
│ JSON · CSV · Excel · XML │    │  paste / type JSON      │
└─────────────────────────┘    └─────────────────────────┘
[Cancel]                       [Cancel]            [Next →]
```
- **File:** `FileDropArea accept={ALL_ACCEPT}`. On pick/drop → `detectFormat(name)`; `null` → error, stay. Else set format state → read (text/arrayBuffer per format) → CONFIGURE (csv/xlsx/xml) or CONFIRM (json/jsonl).
- **Clipboard:** `JsonEditor` (autocomplete via `fieldsFn`) + **Next**. On Next → `parse` the raw `getValue()` text via the json format → error/empty shows inline hint; else CONFIRM (fileMeta = `{ name: 'Pasted data' }`).

Switching the toggle preserves nothing between sources (each source owns its own input); the mode/keys/upsert selection lives on the later CONFIRM stage and is not shown until a source produces parsed docs.

### Downstream (unchanged)
CONFIGURE (file csv/xlsx/xml only) → CONFIRM (mode + match keys + upsert + live plan + block-if-non-unique) → IMPORTING → DONE. Identical for both sources.

## 5. Architecture / modules

- **`formats/index.js`** — add pure `detectFormat(filename) -> id | null` (case-insensitive extension map from the registry) and `ALL_ACCEPT` (union of every format's `accept`). Unit-tested.
- **`components/ImportWizard.jsx`** — `format` becomes **state** (default null), not a prop. Add `source` state ('file' | 'clipboard', default 'file'). PICK renders the toggle + the active source's input. File path detects the format then behaves as today; Clipboard path parses editor text via the json format. Everything from CONFIGURE onward is unchanged. Props become `{ onSuccess, fieldsFn }` (drop `format`/`mode`; mode defaults to 'insert' internally, chosen on CONFIRM).
- **`components/DataOperations.jsx`** — replace `openImport(format, onSuccess)` with `openImport(onSuccess, fieldsFn)` that opens `<ImportWizard onSuccess fieldsFn />` titled "Import". Remove `IMPORT_TITLES`, `openDataOperations`, and `InsertPanel`.
- **`components/DataPanel.jsx`** — `handleRefresh`: replace the six `import-*` + `insert` branches with one `import` branch → `openImport(invalidateAndRun, currentFields)`. Update the import statement (`openImport` only).
- **`components/RecordList.jsx`** — replace the Import `SplitButton` with a plain button (`onRefresh('import')`); delete the now-unused `SplitButton` component.

## 6. Backward compatibility
- Every capability remains reachable: all 5 file formats (via detection) + JSON/JSONL paste (via Clipboard) + Insert/Update/Replace/upsert (via CONFIRM, now available to clipboard too). Only the *route* changes.
- No storage-key changes.
- `openImport`'s signature changes (drops `format`, adds `fieldsFn`); the only caller (`DataPanel`) is updated in the same change. `openDataOperations`/`InsertPanel`/`SplitButton` are removed with their only callers updated — no dangling references.

## 7. Testing strategy
- **`formats/index.js`** (`mdh-formats.test.js`): `detectFormat` for each extension + case-insensitivity + unknown→null; `ALL_ACCEPT` contains each format's tokens.
- **`ImportWizard`** (`mdh-import-wizard.test.js`): rewrite for the new shape — mounts with `{ onSuccess }` (no `format`); default File source; dropping a `.csv` detects csv and reaches CONFIGURE (`csv-options`); dropping a `.json` reaches CONFIRM; switching to Clipboard shows the JSON editor; pasting a JSON array + Next reaches CONFIRM; an unknown type shows the unsupported-file error.
- **Routing** (`mdh-csv-routing.test.js`): rewrite — `openImport()` opens a modal titled "Import" that renders the wizard; `openDataOperations` no longer exists.
- **`mdh-file-drop.test.js`**: the "Import wizards accept dropped files" cases mount `ImportWizard` with no `format`; `.csv` drop → detect → `csv-options`; `.png` drop → unsupported-file message.
- Pure/executor/confirm modules (`importPlan`, `runImport`, `ImportConfirm`, `ImportStages`) are untouched — their tests stay green.
- Follow the repo's vitest conventions (`h()` + `vi.mock`, condition-based `waitFor`, not fixed sleeps). Run `npm run build` + `npm test`.

## 8. Risks
- **Detection vs. content:** extension-based detection can mislabel a mis-named file (e.g. a JSON file named `.csv`). Accepted: the CONFIGURE preview / CONFIRM plan surfaces a bad parse before any write, and unknown extensions are rejected outright.
- **jsdom clipboard:** the Clipboard source is a manual editor (no `navigator.clipboard.readText`), so tests need no clipboard API. (An optional "Paste from clipboard" button is explicitly out of scope for v1.)
- **Test churn:** three wizard/routing/drop test files are rewritten; the pure-logic and downstream-stage tests are unaffected.
