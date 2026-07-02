# Import UI Refinements — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`
**Builds on:** the unified Import wizard + source toggle + match-key/robustness work
(specs `2026-06-30-unified-dataset-import`, `2026-07-01-import-source-toggle`,
`2026-07-01-import-robustness-and-match-keys`).

## 1. Problem & goal

Five focused UI/UX refinements to the import flow:

1. **CSV delimiter is always defaulted to comma.** A semicolon/tab CSV forces the
   user to notice and switch the pill. Autodetect and preselect it.
2. **The "what will happen" summary reads messy** — a verbose explanation
   paragraph *plus* a separate bold counts line, in a heavy callout box.
3. **A redundant "Mode" label** sits above the Insert/Update/Replace tabs.
4. **The match-key picker only shows suggestions after the user types** — no
   discoverable default list.
5. **The suggestion dropdown is in-flow**, so it grows/reflows the modal and
   shifts the confirm button; there's no keyboard navigation.

Goal: preselect the CSV delimiter; replace the summary with one tight sentence;
drop the "Mode" label; make the match-key picker a focus-combobox with an overlay
dropdown and keyboard navigation.

### Non-goals
- No change to parse correctness, the mode/plan/execute pipeline, or match
  semantics. (Delimiter detection only sets an initial UI value; the user can
  override, and the actual parse still uses the chosen `opts`.)
- No change to Update's `$set` behavior (that decision was already settled).

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| CSV delimiter | Pure `detectDelimiter(text)` + a per-format `detectOpts(input)` hook the wizard calls once on file load to seed initial `opts` (delimiter preselected; user-overridable). |
| Summary | One tight `.import-summary` sentence (numbers emphasized), replacing `ModeHelp` + the bordered `.import-summary-callout`. Exact copy in §5. |
| "Mode" label | Removed. |
| Default options | Suggestions show **on focus** (empty query → available fields, capped 50). |
| Dropdown | Absolutely-positioned overlay (no modal reflow) + keyboard nav (Arrow/Enter/Esc; Backspace-empty still removes last chip). |
| Commit policy | Write this spec; **do not git-commit** (standing user preference). |

## 3. Verified facts (grounding)

- `formats/csv.jsx`: `DEFAULT_OPTS.delimiter = ','`; `parse(buffer, opts)` wraps `parseCsv`; `ConfigureControls({opts,setOpt})` binds a `Segmented` (comma/semicolon/tab, `DELIM_SEG`) to `opts.delimiter`. Format has no `detectOpts` today.
- `ImportWizard.handleFile(fileObj)`: sets `format`, `setOpts(f.defaultOpts)`, reads via `f.read` (`arrayBuffer` for CSV) in a `.then`, then for `ConfigureControls` formats goes to CONFIGURE (a race-guarded effect re-parses on `opts` change). Opts are currently seeded to `defaultOpts` synchronously *before* the read resolves.
- `ImportConfirm.jsx`: renders `<div class="modal-field-label">Mode</div>` + mode tabs; a `ModeHelp` component (explanation paragraph); and a `.import-summary-callout` box wrapping `ModeHelp` + `.import-summary-plan` (bold counts). Plan counts: `plan.counts.{willApply,willInsert,willSkip}`. Insert uses `analyzeDocs(docs)` → `insertCount = uniqueIdCount + withoutId`, `inFileDupeCount`.
- `MatchKeyPicker.jsx`: controlled (`paths`,`keys`,`setKeys`); `useState('')` query; suggestions = available (minus selected) filtered by query, `.slice(0,50)`; rendered only when `q` is truthy (`{q && suggestions.length>0 && …}`) as an **in-flow** `.match-key-suggest` div; Enter adds `suggestions[0]`, Backspace-empty removes last chip.
- `console.css`: `.match-key-suggest { margin-top:4px; max-height:180px; overflow:auto; border…; }` (in-flow); `.match-key-picker`, `.match-key-chips`, `.import-summary-callout`, `.import-summary-plan`, `.import-mode-help` exist.

## 4. Piece 1 — CSV delimiter autodetect

### `csv.js` (pure)
`detectDelimiter(text) -> ',' | ';' | '\t'`:
- Take the first up-to-5 **non-empty** lines. For each candidate (`,`, `;`, `\t`), sum raw occurrences across those lines. Pick the candidate with the highest total that is > 0; ties or all-zero → `','`. (Raw count is enough for preselection — a quoted-delimiter edge case just means the user overrides.)

### `formats/csv.jsx`
Add `detectOpts(arrayBuffer) -> { delimiter }`:
- Decode a sample (first ~64 KB) of the ArrayBuffer as UTF-8 (`new TextDecoder('utf-8').decode(new Uint8Array(buf).subarray(0, 65536))`), call `detectDelimiter`, return `{ delimiter }`. Wrap in try/catch → `{}` on failure.
- Export it on the format object: `{ …, detectOpts }`.

### `ImportWizard.handleFile`
In the `.then((input) => …)` (where `input` is the read result), seed initial opts with detection:
```js
const initialOpts = f.detectOpts ? { ...f.defaultOpts, ...f.detectOpts(input) } : f.defaultOpts;
setOpts(initialOpts);
```
Do this **before** `setStage(CONFIGURE)` so the first parse + the Delimiter pill use the detected value. (Move the current pre-read `setOpts(f.defaultOpts)` into the `.then`, or leave it and override in the `.then` — either is fine as long as the detected value wins by the time CONFIGURE renders.) Only CSV provides `detectOpts`; other formats are unaffected.

## 5. Piece 2 — tight summary sentence (`ImportConfirm.jsx`)

Remove the `ModeHelp` component and the `.import-summary-callout` box. Render a single `.import-summary` line just above the actions (same position — after the warnings region), with emphasized numbers and match keys as `<code>`:

- **Insert:** `Will insert <b>{insertCount}</b> new document(s).` + when `insertStats.inFileDupeCount > 0`: ` · <b>{n}</b> in-file duplicate _id(s) collapsed`.
- **Update/Replace, keys chosen, plan ready:** `Will <b>{update|replace}</b> <b>{willApply}</b> record(s) matched by <code>{keys joined ", "}</code>, insert <b>{willInsert}</b> new, skip <b>{willSkip}</b>.`
- **Update/Replace, no keys:** `Select a match field to preview what will happen.`
- **Update/Replace, analyzing (planLoading or plan null with keys):** `Analyzing…`

Keep `data-testid="import-plan"` on this line (tests + downstream reference it). Pluralize with the existing `pluralDocs`/inline `n===1` style. The `.import-summary` style is a plain line (no border/background) with emphasized `<strong>`/`<code>` — lighter than the old callout.

## 6. Piece 3 — remove "Mode" label

Delete the `<div class="modal-field-label">Mode</div>` line above the mode `Segmented` in `ImportConfirm.jsx`. The tabs remain.

## 7. Pieces 4 + 5 — match-key combobox (`MatchKeyPicker.jsx` + CSS)

Turn the picker into a focus-combobox with an overlay dropdown and keyboard nav.

- **State:** add `focused` (boolean) and `activeIndex` (number). Keep `query`.
- **Show suggestions when `focused`** (regardless of `query`): `open = focused && suggestions.length > 0`. Empty query → suggestions = all available (minus selected), `.slice(0,50)`.
- **Overlay:** the suggestion list is rendered inside the picker with `position:absolute`; the picker root is `position:relative`. It floats over following content (never reflows the modal). Add a subtle shadow + `z-index`.
- **Focus/blur:** input `onFocus` → `focused=true`, reset `activeIndex=0`; `onBlur` → `focused=false` (so the dropdown closes when focus leaves). Suggestion buttons use `onMouseDown={(e)=>e.preventDefault()}` so clicking one adds it without first blurring the input.
- **Keyboard (`onKeyDown`):**
  - `ArrowDown`/`ArrowUp` → move `activeIndex` within `[0, suggestions.length-1]` (clamp), `preventDefault`.
  - `Enter` → if open, `add(suggestions[activeIndex])`, `preventDefault`.
  - `Escape` → `focused=false` (close), `preventDefault`.
  - `Backspace` with empty `query` and `keys.length>0` → remove last chip (unchanged).
- **Active highlight:** the suggestion at `activeIndex` gets an `.active` class (`aria-selected`). Reset/clamp `activeIndex` to 0 whenever `query` changes or it would exceed the list.
- `add`/`remove` unchanged (call `setKeys`). Keep all existing `data-testid`s (`match-keys`, `match-key-input`, `match-key-suggest`, `.match-key-suggest-item`, `.match-key-chip*`).

### CSS
`.match-key-picker { position: relative; }`; `.match-key-suggest { position: absolute; top: 100%; left: 0; right: 0; z-index: 20; margin-top: 4px; max-height: 220px; overflow: auto; box-shadow: 0 6px 20px rgba(0,0,0,0.18); … (keep border/bg) }`; `.match-key-suggest-item.active { background: var(--bg-hover); }`. Add `.import-summary { font-size: 13px; line-height: 1.5; color: var(--text-secondary); margin-top: 12px; } .import-summary strong { color: var(--text-primary); } .import-summary code { … mono chip … }`. Remove the now-unused `.import-summary-callout` / `.import-summary-plan` / `.import-mode-help` rules (or leave them harmlessly — prefer removing since nothing references them).

## 8. Architecture / files
- `csv.js` — `detectDelimiter` (pure, exported).
- `formats/csv.jsx` — `detectOpts` (exported on the format object).
- `components/ImportWizard.jsx` — seed initial opts via `detectOpts` in `handleFile`.
- `components/ImportConfirm.jsx` — remove `Mode` label + `ModeHelp`; render the tight `.import-summary` sentence.
- `components/MatchKeyPicker.jsx` — focus-combobox + keyboard nav.
- `console.css` — `.import-summary`, overlay `.match-key-suggest`, `.active`; remove dead summary/mode-help rules.

## 9. Backward compatibility
- `detectOpts` is optional per format — non-CSV formats unchanged. Delimiter detection only changes the *initial* pill; parse still honors the current `opts`.
- `ImportConfirm` keeps `data-testid="import-plan"` and all other testids; the `plan.counts` contract is unchanged.
- `MatchKeyPicker` stays controlled with the same props + testids; add/remove semantics unchanged.
- No storage-key changes.

## 10. Testing
- **`mdh-csv`** (+`detectDelimiter`): comma / semicolon / tab detection from sample text; header-line detection; ties/empty → comma.
- **`mdh-formats`** (+`detectOpts`): `getFormat('csv').detectOpts(arrayBufferOf("a;b\n1;2"))` → `{ delimiter: ';' }`; non-CSV formats have no `detectOpts`.
- **`mdh-match-key-picker`**: on focus (empty query) the suggestion list appears; ArrowDown moves the `.active` highlight; Enter adds the active suggestion (not always the first); Escape closes; overlay list is present; Backspace-empty removes last chip; clicking a suggestion (mousedown) adds it.
- **`mdh-import-confirm`**: no `Mode` label; no `mode-help`; summary sentence per mode/upsert (insert / update-upsert / update-skip); `import-plan` testid present with the right counts; large-import caution + block behavior still hold.
- Run `npm run build` + `npm test`.

## 11. Risks
- **Delimiter mis-detection** on unusual CSVs — bounded: it only preselects; the live preview + the user override make it self-correcting.
- **Combobox blur vs click** — handled by mousedown-preventDefault on suggestions; unit-tested.
- **Test churn** limited to the four test files above; parser/executor/plan tests unaffected.
