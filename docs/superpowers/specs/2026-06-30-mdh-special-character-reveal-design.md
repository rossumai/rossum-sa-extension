# Reveal special / invisible characters in displayed record values (MDH)

**Date:** 2026-06-30
**Status:** Approved (design); pending spec review → implementation plan
**Area:** Console → Dataset Management (MDH) → record value display
(`JsonTree.jsx`, `RecordTable.jsx`, new `specialChars.js` + `SpecialText.jsx`)

## Problem

Record values in MDH render as raw text. When a stored string contains
invisible or non-standard characters that *look like* ordinary spaces — a
no-break space (`U+00A0`), a zero-width space (`U+200B`), a tab, a bidi mark — the
browser collapses or hides them, so the displayed value is indistinguishable
from clean data. A solution architect inspecting the data cannot see that, e.g.,
two values that look identical actually differ by a hidden character, or that a
"space-separated" field is really glued together by zero-width separators. This
silently breaks matching, joins, and exports.

A user-reported value illustrated the class of problem: it rendered as if "full
of spaces" but in fact carried special characters between the visible tokens.
(Note: the exact bytes of that pasted example did **not** survive transmission
into the design session — decoded, it contained only ordinary `U+0020` spaces —
so the character set below is defined explicitly from Unicode facts, not
reverse-engineered from the sample.)

We want to **reveal** these characters inline, in the surfaces where values are
inspected, **without** altering the underlying data, the copy/clipboard output,
exports, or the appearance of clean values.

There is an adjacent, separate feature: the Collection Stats panel already flags
*leading/trailing* whitespace per field at the aggregate level (`statsView.js`
`deriveIssues` → `kind: 'whitespace'`). This feature is complementary and
independent — it reveals the *actual* special characters inside an *individual*
displayed value. The Stats layer is **not** touched.

## Surfaces in scope (verified in code)

Record values reach the DOM through three paths:

1. **`JsonTree.jsx`** — expanded value view. String primitives render at
   `JsonTree.jsx:224` (`"${value}"`) into a JSX text child (`:232`/`:238`);
   primitive array items render via `JSON.stringify(item)` at `:204`. This
   component is consumed by `RecordCard.jsx` (expanded record cards, incl. the
   read-only Stages debug cards) and by `RecordTable.jsx:124` (nested expansion of
   complex cell values).
2. **`RecordTable.jsx`** — simple (non-complex, non-EJSON) cells call
   `displayValue(value)` at `:151` (truncates strings to 20 chars, wraps in
   quotes).
3. **`recordSummary.js`** — the collapsed one-line preview, a width-budgeted
   plain-**string** builder (`displayValue` based).

**In scope:** surfaces 1 and 2. **Out of scope:** surface 3 (collapsed preview)
— it emits a plain string with character-budget packing; rich markers there would
require reworking the builder and crowd the most space-constrained surface.

## Decisions (confirmed with the user)

1. **Character set:** reveal invisible characters, non-standard whitespace, and
   control characters — **excluding** the ordinary ASCII space `U+0020`. (So a
   value containing only normal spaces and letters is never marked.) Four
   categories — see *`specialChars.js`* below.
2. **Visual style:** each special character becomes **a short uppercase
   abbreviation label on a tinted background** (e.g. `NBSP`, `ZWSP`, `TAB`,
   `LRM`; characters with no curated abbreviation fall back to their `U+XXXX`
   codepoint), color-coded by category, with a native `title` tooltip giving the
   full `U+XXXX NAME`. Self-explanatory at a glance without hovering, while
   staying compact enough that a value hiding several characters stays readable.
   Chosen (after reviewing a rendered side-by-side proposal of three styles) over
   a compact single-glyph marker (too cryptic — needs a hover to decode) and over
   a label-plus-inline-codepoint chip (most explicit but widest).
3. **Surfaces:** expanded value view (`JsonTree`) + table cells (`RecordTable`).
   Collapsed one-line preview stays plain text.
4. **Scope of scan:** record **values only**. Field/key names are not scanned in
   v1.
5. **Always on, no toggle.** Because a marker appears *only* where a special
   character actually exists, a value with none renders byte-identical to today —
   so always-on is visually backward-compatible while always protecting the user.
   No new storage key, no popup/UI control.
6. **Implementation = Approach A:** a pure, DOM-free `specialChars.js` does all
   classification/tokenization; a thin `<SpecialText>` component renders tokens.
   `displayValue.js`'s string contract is **not** modified — new code is added and
   only the render sites are swapped.
7. **Copy stays raw.** The copy button continues to copy the original bytes via
   `copyTextFor`. Markers are display-only.

## Module: `src/mdh/specialChars.js` (pure, no Preact/DOM)

Sibling to `displayValue.js`; unit-tested directly like it.

### Categories and curated codepoints

Classification is by codepoint (using ranges + an explicit set, not a full
UnicodeData table). The four categories and their CSS color intent:

- **`space`** (amber / `--warning`) — Unicode space separators **except**
  `U+0020`:
  `U+00A0` NO-BREAK SPACE, `U+1680` OGHAM SPACE MARK,
  `U+2000`–`U+200A` (EN QUAD, EM QUAD, EN SPACE, EM SPACE, THREE-PER-EM SPACE,
  FOUR-PER-EM SPACE, SIX-PER-EM SPACE, FIGURE SPACE, PUNCTUATION SPACE, THIN
  SPACE, HAIR SPACE), `U+202F` NARROW NO-BREAK SPACE,
  `U+205F` MEDIUM MATHEMATICAL SPACE, `U+3000` IDEOGRAPHIC SPACE.
- **`zero-width`** (red / `--danger`) — invisible format characters:
  `U+200B` ZERO WIDTH SPACE, `U+200C` ZERO WIDTH NON-JOINER,
  `U+200D` ZERO WIDTH JOINER, `U+2060` WORD JOINER,
  `U+FEFF` ZERO WIDTH NO-BREAK SPACE (BOM), `U+00AD` SOFT HYPHEN,
  `U+180E` MONGOLIAN VOWEL SEPARATOR.
- **`control`** (blue / `--accent`) — `U+0000`–`U+001F` (incl. `U+0009` TAB,
  `U+000A` LINE FEED, `U+000D` CARRIAGE RETURN), `U+007F` DELETE,
  `U+0080`–`U+009F` (C1 controls, incl. `U+0085` NEL),
  `U+2028` LINE SEPARATOR, `U+2029` PARAGRAPH SEPARATOR.
- **`bidi`** (purple) — `U+200E` LRM, `U+200F` RLM, `U+202A`–`U+202E`
  (embeddings/overrides), `U+2066`–`U+2069` (isolates).

`U+0020` is explicitly **not** classified. (`U+FFFD` REPLACEMENT CHARACTER is
intentionally excluded from v1 — it is already visible and is not whitespace-like;
listed under *Out of scope*.)

### API

```
classifySpecial(codePoint) -> null | { category, name, abbr }
```
Returns `null` for normal characters. `category` is one of
`space | zero-width | control | bidi`. `name` is a friendly Unicode name for the
curated set (`NO-BREAK SPACE`, `TAB`, `ZERO WIDTH SPACE`, …) with a generic
fallback for un-named C0/C1 controls (e.g. `CONTROL U+0007`). `abbr` is the
short uppercase label shown in the UI, from a curated map keyed by codepoint
(`U+00A0` → `NBSP`, `U+200B` → `ZWSP`, `U+0009` → `TAB`, `U+200E` → `LRM`,
`U+202F` → `NNBSP`, …); a character with no curated abbreviation falls back to
its `cpLabel` (`U+XXXX`).

```
hasSpecial(str) -> boolean
```
Fast scan; `false` means "no special characters" → callers take the plain
(unchanged) render path. Non-strings return `false`.

```
tokenizeSpecial(str, { limit } = {}) -> { tokens, truncated }
```
Returns `tokens`: an ordered array of either `{ type: 'text', value }` (a
coalesced run of normal characters) or
`{ type: 'special', cp, category, name, abbr, char }`. Consecutive normal
characters are merged into one `text` run so clean substrings stay plain.
`limit` (optional) caps the result at `limit` **source characters** (a special
char counts as 1); when the source is longer, `truncated` is `true` and the
caller appends an ellipsis. Iteration is by Unicode code point (`for…of`) so
astral characters are handled correctly and never mis-split.

## Component: `src/mdh/components/SpecialText.jsx`

```
<SpecialText value={string} quote={bool=false} limit={number?} />
```

- Renders only for a **string** `value`. (Callers gate non-strings out; the
  component also guards by returning `value` unchanged if it is not a string.)
- If `hasSpecial(value)` is `false`: returns the plain string — optionally
  wrapped in quote glyphs and/or truncated with `…` — producing DOM
  **byte-identical** to today for clean values.
- Otherwise: maps `tokenizeSpecial(value, { limit })` to children — `text` runs
  as plain string children; each `special` token as
  `<span class={"mdh-special mdh-special-" + category} title={tooltip}>{abbr}</span>`,
  where `tooltip` is `` `${cpLabel} ${name}` `` and `cpLabel` is `U+` followed by
  the codepoint in **uppercase hex, zero-padded to at least 4 digits** (e.g.
  `U+00A0`, `U+0009`). When `quote`, wraps the whole sequence in literal `"` text
  (not inside the markers). When truncated, appends `...` (literal three dots, to
  match `displayValue`'s existing table truncation) after the last rendered token.
- The component is intentionally tiny and presentational; all logic lives in
  `specialChars.js`.

## Wiring the surfaces

Three edit sites; no behavioral change for non-string or clean values.

1. **`JsonTree.jsx` expanded primitive** (`:224`–`:239`): for the `readOnly` and
   interactive string cases, render the value via `<SpecialText value={value}
   quote />` instead of the bare `"${value}"` text. Numbers/booleans/`null` keep
   `String(value)`/`'null'` exactly as today. The clickable-button wrapper, sort/
   filter handlers, `title`, and copy button are unchanged — only the visible
   child changes.
2. **`JsonTree.jsx` array primitive items** (`:204`): for **string** items render
   `<SpecialText value={item} quote />`; non-strings keep `JSON.stringify(item)`.
3. **`RecordTable.jsx` simple cell** (`:146`–`:155`): when `value` is a string,
   render `<SpecialText value={value} quote limit={20} />`; otherwise keep
   `displayValue(value)`. (EJSON and complex values already take earlier branches
   — `:131`/`:111` — and are untouched.)

These three sites transitively cover RecordCard expanded cards, the read-only
Stages debug cards, and nested complex-value JsonTrees inside table cells.

## CSS (`src/console/console.css`)

Add a base `.mdh-special` rule (inline-block, monospace, small bold slightly
tracked label `~0.72em`, tiny horizontal padding, subtle rounded tinted
background, `cursor: help`) plus four category modifiers driving
background/foreground from existing semantic custom properties so both light and
dark themes work:

- `.mdh-special-space` → `--warning` family (amber)
- `.mdh-special-zero-width` → `--danger` family (red)
- `.mdh-special-control` → `--accent` family (blue)
- `.mdh-special-bidi` → a purple (new local variable if no semantic var fits)

Tooltip is the native `title` attribute — no JS, no portal.

## Backward compatibility

- **Clean values are byte-identical** to today (the `hasSpecial` fast path returns
  the original string). No layout or color change for data without special
  characters.
- **`displayValue.js` is unchanged** — its string contract (used by
  `recordSummary`, downloads, width math, copy) is preserved.
- **`recordSummary.js` is unchanged** — the collapsed preview is untouched.
- **Copy is unchanged** — `copyTextFor` still returns raw original bytes; the
  copy button copies raw.
- **Downloads / export / record editing** are unaffected (they never used these
  render paths).
- **Known minor limitation (documented):** drag-selecting *across* a marker and
  copying via the OS copies the abbreviation label (e.g. `NBSP`), not the
  original hidden character. The copy button is the canonical raw-copy path.
  Acceptable for v1.

## Testing

- **`tests/mdh-special-chars.test.js`** (pure, like `mdh-display-value.test.js`):
  - `classifySpecial` returns the right category/name for a representative
    member of each category (`U+00A0`, `U+200B`, `U+0009`, `U+200E`).
  - `U+0020` (space), ordinary letters/digits, and a representative astral
    emoji are **not** classified.
  - `hasSpecial`: true/false cases incl. empty string and non-string input.
  - `tokenizeSpecial`: coalesces normal runs; emits a `special` token with
    correct fields; handles a value that is *all* special chars; `limit`
    truncates by source-character count and sets `truncated` (matching
    `displayValue`'s "> 20 chars" boundary); astral characters are not split.
- **`tests/mdh-special-text.test.js`** (`h()`-based, per the project's Vitest JSX
  convention — no raw JSX in `.test.js`):
  - clean string → a single plain text node (no `.mdh-special` spans), and with
    `quote` the surrounding quotes are present.
  - mixed string → expected number of `.mdh-special-*` spans with the correct
    category class and a `title` of the form `U+00A0 NO-BREAK SPACE`.
  - `limit` truncation appends `...` (literal three dots).
- Existing `tests/mdh-display-value.test.js` and the RecordTable/JsonTree-adjacent
  tests must remain green (no contract change).

## Out of scope (YAGNI)

- Field/key-name scanning (decided: values only in v1).
- Markers in the collapsed one-line preview (`recordSummary`).
- A toggle / storage key / popup control (decided: always on).
- "Copy as escaped" (e.g. `North America`) affordance.
- Flagging `U+FFFD` REPLACEMENT CHARACTER (already visible; not whitespace-like).
- The pipeline/query editor (`JsonEditor`) and the record editor.
- Any change to the Stats data/scoring layer.
