# Modernize the CSV "Configure" stage (Dataset Management)

**Date:** 2026-06-08
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user (visual companion)

## 1. Goal

Modernize the visual design of the CSV import wizard's **Configure** stage — "Direction C: toolbar + hero preview" — chosen from three mocked layout directions. The current Configure UI works but looks plain (a two-column grid of label+control rows with stacked hint lines). This is a **presentation-only** redesign: no parsing or functional behavior changes.

## 2. Scope

**In scope:** `CsvStageConfigure`, `CsvOptions`, and the `CsvPreview` presentation in `src/mdh/components/CsvImportWizard.jsx`; a new meta bar; new/replaced `.csv-*` rules in `src/console/console.css`; the wizard's `tests/mdh-csv-wizard.test.js`.

**Explicitly untouched:**
- `src/mdh/csv.js` (the pure parser core) — no changes.
- `src/mdh/components/ImportStages.jsx` (shared `StageConfirm`/`StageImporting`/`StageDone`, also used by the JSON wizard) — no changes.
- `src/mdh/components/InsertFileWizard.jsx` (the JSON wizard) — no changes.
- The CONFIRM / IMPORTING / DONE flow and the PICK stage (`CsvStagePick`) — no changes.
- `parseCsv`, all option keys, `DEFAULT_OPTS`, the live-reparse `useMemo`, the Next-gating logic (`!parsed.error && docs.length > 0 && delimiter !== ''`), and `startImport` — all unchanged.
- The 1040px modal width (`.modal-card:has(.csv-import-wizard)`) — already shipped, kept.

## 3. Verified facts (grounding)

- Current `CsvStageConfigure` renders: a `.modal-count-info` with the filename only, then `<CsvOptions>` (a two-column `.csv-config` flex grid of `.csv-opt` rows with `.csv-opt-hint` lines), then `<CsvPreview>`, then the actions row.
- `console.css` `:root` design tokens (light + dark): `--bg-card #fff / #1a1a2e`, `--bg-base`, `--bg-hover`, `--bg-code`, `--text-primary`, `--text-secondary`, `--border`, `--accent #4270db` (+`--accent-hover`), semantic `--success/--warning/--danger` (+ `-bg/-fg`), `--radius 6px`, `--shadow`, `--glass-*`, `--font-mono`. Dark mode overrides `:root` under `@media (prefers-color-scheme: dark)`. The codebase already uses `:has()` (e.g. `.match-field-option:has(input:checked)`).
- File size is available as `fileMeta.size` (today shown only in CONFIRM's `FileSummary`, not in Configure). `parsed.docs.length` = row count; `parsed.columns.length` = column count.
- The Infer-types interaction test in `tests/mdh-csv-wizard.test.js` toggles `[data-testid="csv-infer"]` and asserts the preview re-parses (a quoted string `"30"` becomes a `.csv-cell-number`).

## 4. Decisions

| Decision | Choice |
|---|---|
| Layout | Direction C — meta bar + slim toolbar + inline Advanced + hero preview |
| Meta bar | `filename · N rows · KB · C columns` |
| Toolbar (always visible) | Delimiter (segmented + Custom), Header-row toggle, Infer-types toggle, right-aligned **Advanced ▾** |
| Advanced reveal | **Inline expand, collapsed by default** (pushes preview down) |
| Advanced contents | Quote char, Escape char, Double-quote, Encoding, Empty-cell, Skip-empty-lines, Trim |
| Control vocabulary | Segmented pill groups (delimiter, empty-cell, encoding); toggle switches (header, infer, double-quote, skip-empty, trim); mono char chips/inputs (quote, escape) |
| Explanations | Toolbar controls → `title=` tooltips (labels are self-explanatory); Advanced controls → concise visible hint text (that's where the options needing explanation live: escape, double-quote, encoding, empty-cell) |

## 5. Layout (top → bottom)

1. **Meta bar** (`.csv-meta`): filename (mono, emphasized) then `· N rows · KB · C columns` (muted, with the numbers emphasized). `KB` formatted by `formatBytes`, which currently lives as a private helper in `ImportStages.jsx`: **export it from `ImportStages.jsx`** and import it into `CsvImportWizard.jsx` (DRY — no duplicate copy). Rows = `parsed.docs.length`, columns = `parsed.columns.length`. When `parsed` is null/empty, show what's available (filename + size).
2. **Toolbar** (`.csv-toolbar`, always visible): 
   - Delimiter — `Segmented` pills: `,` `;` `Tab` `|` `Custom`. Selecting Custom reveals a 1-char input (same `delimiter` state; the existing `delimiterIsCustom` logic).
   - Header-row — `Toggle`.
   - Infer-types — `Toggle` (keeps `data-testid="csv-infer"`).
   - **Advanced ▾ / ▴** disclosure button (right-aligned via `margin-left:auto`), toggles `advancedOpen`.
3. **Advanced panel** (`.csv-advanced`, rendered only when `advancedOpen`): Quote (char chip/input), Escape (char chip/input, placeholder "none"), Double-quote (`Toggle`), Encoding (`Segmented`: UTF-8 / Windows-1252 / ISO-8859-1 / UTF-16LE), Empty-cell (`Segmented`: `""` / `null` / omit), Skip-empty-lines (`Toggle`), Trim (`Toggle`). Each Advanced control has a concise visible `.csv-opt-hint`.
4. **Preview (hero)** (`<CsvPreview>`): caption `Preview · first {min(limit,docs.length)} of {docs.length} rows · {columns.length} columns` + a small **type legend** (`123 number` · `null` · `"text"`) on the right; sticky-header scrollable table with the existing typed-cell styling (`.csv-cell-string/number/bool/null/missing`) — unchanged; warnings (`.csv-warning`) below; blocking parse-error banner (`.csv-error`) replaces the table when `parsed.error`.
5. **Actions**: Cancel / Next → (unchanged; Next stays gated as today).

## 6. Components / helpers (in `CsvImportWizard.jsx`)

- `Segmented({ value, options, onChange })` — pill group. `options`: `[{ value, label, title? }]`. Renders buttons; the one matching `value` gets `.on`. Accessible: `<button type="button">` per pill (so keyboard/Enter works), the group wrapped in a `role="group"`. Used for delimiter (with Custom handling at the call site), encoding, empty-cell.
- `Toggle({ checked, onChange, label, title, testid })` — a switch implemented as `<button type="button" role="switch" aria-checked={checked} title={title} data-testid={testid}>` wrapping a styled track + knob (`.csv-switch`/`.csv-switch-knob`, `.on` when checked). `onClick` calls `onChange(!checked)`. Keyboard-operable for free (button). Forwards `testid` to the button (the infer toggle needs `data-testid="csv-infer"`). Used for header, infer, double-quote, skip-empty, trim.
- `CsvStageConfigure` gains `const [advancedOpen, setAdvancedOpen] = useState(false)` and renders meta bar → toolbar → (advancedOpen && advanced panel) → `<CsvPreview>` → actions. The current `CsvOptions` component is replaced by the toolbar + advanced markup (either inline or as `ToolbarControls` + `AdvancedPanel` sub-components).
- `CsvPreview` gains the type-legend element in its caption row; everything else unchanged.

All option state and the `parseCsv` `useMemo` stay in the `CsvImportWizard` container exactly as today; the new controls call the same `setOpt`.

## 7. CSS (`console.css`)

**New rules** (use the existing tokens so dark mode adapts for free):
- `.csv-meta` (flex row; mono filename; muted metrics with emphasized numbers)
- `.csv-toolbar` (flex row, `gap`, `flex-wrap`, `--bg-base`/`--bg-code` surface, border, radius)
- `.csv-tb-item` (label + control cluster)
- `.csv-seg` / `.csv-seg-opt` / `.csv-seg-opt.on` (segmented pills; `.on` uses `--accent`)
- `.csv-switch` / `.csv-switch.on` / `.csv-switch-knob` (toggle track + knob; `.on` uses `--accent`)
- `.csv-chip` (mono char input/chip)
- `.csv-advanced` (the inline panel; dashed or subtle border, `gap`, `flex-wrap`)
- `.csv-adv-toggle` (the Advanced disclosure button; `--accent` text)
- `.csv-preview-legend` (small muted legend in the caption row)

**Replaced/removed:** `.csv-config`, `.csv-opt`, `.csv-opt-group`, `.csv-opt-group-title`, `.csv-opt-check`, `.csv-opt-label`, `.csv-opt-char` (superseded by the toolbar/segmented/switch rules). **Keep** `.csv-opt-hint` (reused for Advanced hints) and all `.csv-preview*` / `.csv-cell-*` rules. **Keep** `.modal-card:has(.csv-import-wizard) { max-width: 1040px; }`.

## 8. Accessibility

Toggles and segmented controls must be real interactive elements (`<button>` / `<input type=checkbox>`), keyboard-operable, with visible focus. Tooltips via `title=`. The Infer-types control must keep `data-testid="csv-infer"` on its clickable element so the existing reparse test still drives it.

## 9. Testing (`tests/mdh-csv-wizard.test.js`)

- Keep the async configure interaction test green: clicking `[data-testid="csv-infer"]` flips `inferTypes` and the preview re-parses (`30` → `.csv-cell-number`).
- Add: **Advanced is collapsed by default** — the advanced controls (e.g. `[data-testid="csv-empty"]` / a double-quote control) are absent until the Advanced button (`[data-testid="csv-advanced-toggle"]`) is clicked, then present.
- Add: **meta bar** shows the row count and a formatted size (mount with a `File`; after the async read, assert the meta text contains the row count and a `KB`/`B` token).
- Add: **delimiter segmented** — clicking the `;` pill (`[data-testid="csv-delimiter-;"]` or similar) changes the parse (preview column count changes for a `;`-delimited sample); choosing **Custom** reveals the char input.
- `CsvPreview` render tests stay valid; optionally assert the legend renders.
- Use the existing condition-based `waitFor` (throws on timeout) for any async step.

## 10. Non-goals

- No parsing/semantics changes; no new options; no new dependencies.
- No changes to the shared stages, the JSON wizard, or the PICK/CONFIRM/IMPORTING/DONE flow.
- Not changing the modal width (already done) or modernizing other modals.
