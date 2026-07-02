# Import Summary Wording + Dropdown Overflow — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`
**Builds on:** the import wizard work, most recently `2026-07-01-import-ui-refinements` (the one-line summary + the focus-combobox match-key picker).

## 1. Problem & goal

Two follow-up refinements:

1. **The one-line summary is now too terse.** The user reversed the earlier
   "keep it tight" decision: they want the counts kept but the wording
   **expanded to explain how the selected mode works and what will happen**, so
   users are confident before running.
2. **The match-key dropdown is clipped by the modal.** It's an absolutely-
   positioned overlay inside the modal's scroll container, so when it extends
   past the modal it's cut off and the user must scroll the modal to see the
   suggestions.

Goal: expand the summary into a short explanatory block (mechanic + this-run
counts); make the dropdown a `position: fixed` popup that escapes the modal clip.

### Non-goals
- No change to match/plan/execute logic or to which counts are shown.
- No portal/`createPortal` (not needed — see §3).

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| Summary | Expand `.import-summary` to a mechanic sentence + a "This run:" counts clause, per mode, flipping with the upsert toggle. Copy in §4. Keeps `data-testid="import-plan"`. |
| Dropdown | `.match-key-suggest` becomes `position: fixed`, anchored to the input's `getBoundingClientRect()`; width = input width; flip-up when room below is short; `max-height` capped to available viewport space; reposition on scroll/resize while open; `z-index` above the modal. |
| Commit policy | Write this spec; **do not git-commit** (standing user preference). |

## 3. Verified facts (grounding)

- `console.css`: `.modal-card { max-height: 85vh; overflow: hidden; }`, `.modal-body { overflow-y: auto; }`. The confirm-stage content (incl. `MatchKeyPicker`) lives in `.modal-body`.
- **No modal ancestor** (`.modal-overlay`, `.modal-card`, `.modal-body`, `.match-key-picker`) sets `transform`/`filter`/`will-change`/`perspective`/`contain` (grep-confirmed) → a `position: fixed` descendant is positioned relative to the viewport and is NOT clipped by those ancestors' `overflow`. So fixed positioning fixes the clip without a portal.
- `MatchKeyPicker.jsx` (current): controlled `useState` combobox; `open = focused && suggestions.length > 0`; dropdown is `.match-key-suggest` rendered `{open && …}` with CSS `position: absolute; top: 100%; left: 0; right: 0; z-index: 20`.
- `.modal-overlay { z-index: 200; }` — the fixed dropdown needs a higher z-index to sit above modal content.
- `ImportConfirm.jsx`: the `.import-summary` line (`data-testid="import-plan"`) currently has four mutually-exclusive branches (insert / no-keys / analyzing / update-replace-with-counts). `verb = 'Insert'|'Update'|'Replace'`; counts from `plan.counts.{willApply,willInsert,willSkip}`; insert uses `insertCount`/`insertStats.inFileDupeCount`.

## 4. Piece 1 — expanded summary (`ImportConfirm.jsx`)

Replace the terse sentences in the `.import-summary` line with explanatory ones. Keep the four mutually-exclusive branches, the `data-testid="import-plan"`, bold numbers (`<strong>`), and match keys as `<code>`. `KEYS` = `keys.join(', ')`.

- **Insert:**
  > Adds every row as a new document. If a row's `_id` already exists the insert is rejected and reported afterward — nothing already in the collection is changed. **This file adds `<insertCount>` new document(s).**
  (+ when `insertStats.inFileDupeCount > 0`: append " `<n>` in-file duplicate `_id`(s) are collapsed first.")

- **Update:**
  > Matches each row to an existing record by `<KEYS>`, then overwrites that record's fields with the row's values (fields not in the file stay as they are). Rows that match nothing are **{skipped | added as new documents}**. **This run: `<willApply>` updated, `<willInsert|willSkip>` {inserted|skipped}.**

- **Replace:**
  > Matches each row to an existing record by `<KEYS>`, then replaces the whole document with the row (anything not in the row is removed; `_id` is kept). Rows that match nothing are **{skipped | added as new documents}**. **This run: `<willApply>` replaced, `<willInsert|willSkip>` {inserted|skipped}.**

- **No keys (update/replace):** "Choose one or more fields to match existing records by."
- **Analyzing (update/replace, `planLoading || !plan`, keys chosen):** "Analyzing…"

The upsert toggle flips the middle clause ("added as new documents" vs "skipped") and the trailing count ("`<willInsert>` inserted" vs "`<willSkip>` skipped"). Implement as a small `SummaryText`/inline helper; numbers via `<strong>`, keys via `<code>`. Style stays `.import-summary` (secondary text, emphasized numbers) — line-height already handles multi-line prose.

## 5. Piece 2 — fixed-position dropdown (`MatchKeyPicker.jsx` + CSS)

Anchor the dropdown to the input's viewport rect so it escapes the modal clip.

- Add `inputRef` (ref on the `<input>`) and `box` state (`{ left, width, maxHeight, top? , bottom? }` | null).
- A `useLayoutEffect` keyed on `open`: when `open`, `measure()` reads `inputRef.current.getBoundingClientRect()` and computes:
  - `left = rect.left`, `width = rect.width`.
  - `below = innerHeight - rect.bottom - PAD`, `above = rect.top - PAD` (PAD ≈ 8).
  - `flip = below < MIN_DROP (≈180) && above > below`.
  - `maxHeight = min(MAX_DROP (≈260), (flip ? above : below) - GAP)` (GAP ≈ 4).
  - placement: `flip ? { bottom: innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }`.
  - set `box`. When not open, `setBox(null)`.
  - While open, add `scroll` (capture: true, to catch modal-body scroll) + `resize` listeners calling `measure`; remove them on cleanup.
- Render the dropdown `{open && box && (…)}` with an inline `style` applying `position` coords (`left`/`width`/`max-height` + `top` or `bottom`). Everything else (items, `.active`, mousedown-preventDefault, click/keyboard) is unchanged.
- CSS `.match-key-suggest`: change to `position: fixed; z-index: 250;` and DROP `top: 100%; left: 0; right: 0; margin-top: 4px` (now inline). Keep `overflow: auto`, border, background, `box-shadow`. `.match-key-picker` keeps `position: relative` (harmless; the dropdown no longer depends on it).

Because no ancestor traps fixed, the dropdown renders over the modal and beyond its edges — fully visible, no modal scroll. In jsdom `getBoundingClientRect()` returns zeros and `innerHeight` is finite, so `box` is set (non-flip, `maxHeight ≈ 260`) and the dropdown + items render — existing behavior tests pass; the positioning itself is visual (not unit-tested).

## 6. Architecture / files
- `src/mdh/components/ImportConfirm.jsx` — expanded summary copy (four branches).
- `src/mdh/components/MatchKeyPicker.jsx` — `inputRef`, `box` state, `useLayoutEffect` measure/reposition, inline-styled fixed dropdown.
- `src/console/console.css` — `.match-key-suggest` → fixed + z-index 250 (drop the absolute offsets).

## 7. Backward compatibility
- `ImportConfirm`/`MatchKeyPicker` props and all `data-testid`s unchanged. Existing summary tests use substring matches (`/update/i`, `/insert/i`, `/12/`, `/3/`, `/sku/`, `/new document/i`) that the expanded copy still satisfies. Existing picker tests (focus-open, keyboard nav, click, escape, backspace) rely only on the item list + `.active` + testids, all preserved. No storage-key changes.

## 8. Testing
- **`mdh-import-confirm`**: the summary explains the mechanic — assert the update copy contains e.g. `/matched?/i` + `/overwrite/i` + the counts + `sku`; the replace copy contains `/replace/i` + counts; insert contains `/new document/i`. Keep the existing branch tests.
- **`mdh-match-key-picker`**: assert the open dropdown carries `position: fixed` (e.g. the element's inline `style` includes `position: fixed` or `getComputedStyle`… in jsdom prefer asserting the inline style string contains `fixed`). All existing behavior tests (focus-open, ArrowDown/Enter active, Escape, filter+click, Backspace) remain green.
- Run `npm run build` + `npm test`.

## 9. Risks
- **Repositioning cost / staleness** while the modal scrolls with the dropdown open — mitigated by the capture-phase `scroll` listener re-measuring; low frequency (dropdown is transient).
- **Flip thresholds** are heuristic; capped `max-height` guarantees the list always fits and scrolls internally.
- **jsdom zero-rect** — positioning untested but the render path is; acceptable (visual concern), consistent with other visual bits in this codebase.
