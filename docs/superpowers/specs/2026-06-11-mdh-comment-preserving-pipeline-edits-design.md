# Comment-Preserving Pipeline Edits (+ re-enable-invalid, hide line numbers)

**Date:** 2026-06-11
**Status:** Design — awaiting review
**Area:** Dataset Management app (`src/mdh/`) — Data panel pipeline editor

> Follow-up to `2026-06-11-mdh-disable-aggregation-stages-design.md` (the disable-stages feature).
> This refines three behaviors of that feature's text-handling core.

---

## 1. Problem

The Data panel edits an aggregation pipeline as raw JSON5 text. Three issues:

1. **Freehand comments are thrown away.** Any sort / filter / paginate (and Beautify) re-serializes
   the whole pipeline from parsed objects (`JSON.stringify`), so every `//` and `/* */` comment the
   user wrote is silently lost — and the whole pipeline is reflowed to canonical 2-space.
2. **An invalid disabled stage can't be re-enabled.** `setStageDisabled` refuses to enable a
   `/* @disabled-stage … */` block whose inner JSON is invalid (a no-op with no feedback). The user
   would rather make the mistake visible and fixable than be silently blocked.
3. **The line-number gutter wastes horizontal space** in the aggregate editor.

### Decisions taken during brainstorming (all confirmed)

- **Comment preservation — preserve everything.** Move every text rewrite to a **minimal edit** that
  touches only the bytes that actually change. Untouched stages keep their exact formatting and inner
  comments; comments between/around unchanged stages survive. Accepted consequence: sort/filter/
  paginate **stop reflowing the whole pipeline** to canonical formatting.
- **Beautify keeps comments.** Beautify reformats each stage to canonical 2-space but preserves
  standalone / leading / trailing comments (a comment *inside* a stage is reflowed away with it).
- **Re-enable invalid → show the error.** Re-enabling a disabled block uncomments it verbatim even if
  the inner JSON is invalid; the editor's existing linter then surfaces the parse error.
- **Hide line numbers only.** Remove the line-number gutter in the aggregate editor; keep the fold
  gutter and the stage-toggle gutter.
- **Remove-comment rule (Limit B, confirm in review):** when a stage is *removed*, its attached
  leading comment is **dropped with the stage** (rather than left dangling and misattached).

---

## 2. Goals / Non-goals

**Goals**
- Sort / filter / paginate / toggle / re-enable preserve all comments and the formatting of every
  stage they don't change.
- Re-enabling an invalid disabled block puts the (invalid) text back and shows the parse error.
- Beautify reformats stage bodies while keeping standalone/leading/trailing comments.
- The aggregate editor shows no line-number gutter.
- The `pipelineOps.js` mutators and all `parseEntries` consumers (PipelineDebug, gutter, dedup) keep working unchanged.

**Non-goals**
- Preserving the inner comments/formatting of the *one stage a mutation changes* (it is reserialized).
- Preserving a comment bound to a stage that is *inserted or removed* (it can't follow a stage that no longer exists).
- Reflowing/normalizing gap whitespace in Beautify (only stage bodies are canonicalized).
- Any change to non-aggregate `JsonEditor` modes, downloads, or the server-bound paths.

---

## 3. Verified ground truth

| Fact | Source |
|---|---|
| Comments are dropped wherever the pipeline is re-serialized from parsed objects: `applyMutationToText` (fast path `JSON5.parse→JSON.stringify`; slow path `serializeEntries`) and `beautifyText` (`serializeEntries`). | `src/mdh/pipelineComments.js:109,150,183` |
| Load/restore paths (`setValue(rawText)`) and persistence (`getValue()`) preserve comments verbatim — only the rebuild paths destroy them. | `DataPanel.jsx` setValue paths; `lastPipeline.js`/`pipelineState.js` |
| `scanLayout(text)` already yields exact source spans (`start`/`end`) for every top-level item (active object-stage or `@disabled-stage` block), string/comment/depth-aware. | `pipelineComments.js:22-65` |
| `pipelineOps` mutators replace a changed stage with a NEW object and `splice` for insert/remove; they never mutate a stage object in place and never reorder untouched stages. | `pipelineOps.js` |
| `setStageDisabled` no-ops when enabling a block whose `stage == null` (invalid inner JSON). | `pipelineComments.js:139` |
| `setStageDisabled`/`applyMutationToText` currently re-serialize via `serializeEntries` (canonical), discarding the toggled/other stages' original formatting. | `pipelineComments.js:135-170` |
| CodeMirror `basicSetup` bundles BOTH `lineNumbers()` and `foldGutter()`. The aggregate editor also adds the custom `stageToggleGutter`. | `node_modules/codemirror/dist/index.js:50,54`; `JsonEditor.jsx:208,214` |
| `JsonEditor` builds its extensions once in a mount effect; the aggregate gutter is added behind `mode === 'aggregate'`. | `JsonEditor.jsx:207-216` |

---

## 4. Architecture

### 4.1 Lossless document model (`pipelineComments.js`)

Introduce `parsePipelineDoc(text) → { ok, segments }`:
- `segments`: ordered array, one per top-level item, each `{ kind: 'active'|'disabled', start, end, stage, raw }`.
  - `start`/`end` are the exact char span (from `scanLayout`).
  - `active`: `stage` = `JSON5.parse(text.slice(start,end))`.
  - `disabled`: `raw` = inner text; `stage` = parsed inner or `null` (forgiving).
- **Gaps** (commas, whitespace, comments between items; the leading text after `[`; the trailing text before `]`) are not stored — they are recovered verbatim from the original `text` via the spans. The original text string is the source of truth; segments are an index into it.

`parseEntries(text)` becomes a thin derivation of `parsePipelineDoc` (maps segments → `{ disabled, stage, raw }` and applies the existing `activeCount === JSON5.parse(text).length` cross-check). Its output shape is unchanged, so `PipelineDebug`, `stageLineRanges`, and `QueryHistory.dedupKey` are untouched.

### 4.2 Minimal-edit rewrites — the core (`applyMutationToText`)

`pipelineOps.js` is **not modified**. `applyMutationToText(text, mutator)` changes its write-back:

1. `parsePipelineDoc(text)` → `{ ok, segments }`. If `!ok` return `null` (preserves today's no-op-on-invalid).
2. Build `work`: for each segment push the active `stage` **by reference**, or an inert placeholder object (carrying a link back to its disabled segment). (Mutators ignore non-`$`-keyed placeholders, as today; by-reference — not shallow-copied — so untouched stages keep identity.)
3. Run `mutator(work)`.
4. **Reference diff** (`work` vs the pre-mutation work array). Because mutators never reorder, a two-pointer walk yields per-position ops; a remove immediately followed by an insert at the same anchor is collapsed to a **replace**:
   - **replace(segment → newStage):** splice `[segment.start, segment.end)` → `reindent(JSON.stringify(newStage, null, 2))`. Both surrounding gaps (commas + comments) are untouched.
   - **insert(newStage) at a boundary:** splice in `reindent(JSON.stringify(newStage)) + separator` (comma + newline), anchored so the *next* kept stage's leading comment stays attached to it.
   - **remove(segment):** splice out the segment span, its separating comma, **and its leading-gap comment** (Limit B → "drop with the stage").
5. Apply splices right-to-left (so earlier offsets stay valid) and return the new text.

`reindent(s)` = `JSON.stringify`'s output with lines 2..n prefixed by 2 spaces (line 1 sits at the column the gap already provides), matching the canonical 2-space array-element shape.

The disabled placeholders are never replaced/removed (mutators only touch `$sort`/`$match`/`$skip`), so disabled stages ride along untouched — same guarantee as today, now also keeping their exact original bytes.

### 4.3 Toggle = wrap/unwrap splice (`setStageDisabled`) — and re-enable-invalid

- **disable** segment `i`: splice `[start,end)` → `/* @disabled-stage\n` + escapeStarSlash(verbatim span) + ` */`. The stage's *own* formatting and inner comments are preserved inside the comment (better than today's canonicalization). `escapeStarSlash` replaces `*/` → `*\/` (as in the current serializer).
- **enable** segment `i`: splice `[start,end)` → `unescape(raw)` (verbatim inner text). **The `stage == null` guard is removed** — enabling an invalid block restores the invalid text as an active element, the editor lints it, and the user sees/fixes the error. (Decision #2 / #3.)

Everything outside the toggled segment stays byte-for-byte.

### 4.4 Beautify — reformat stages, keep comments (`beautifyText`)

`parsePipelineDoc` → for every **active** segment, splice its span with `reindent(JSON.stringify(stage, null, 2))`; for every **disabled** segment, splice with a freshly canonicalized `/* @disabled-stage … */` (canonical inner). **All gaps (commas, whitespace, standalone/leading/trailing comments) are left untouched.** Net effect: stage bodies are tidied; comments between/around stages survive; a comment *inside* a stage is reflowed away with that stage. Returns `null` on invalid text (unchanged contract).

### 4.5 Hide line numbers (`JsonEditor.jsx`)

Add an instance-scoped theme to the extensions, only for aggregate mode:
```js
const noLineNumbersTheme = EditorView.theme({ '.cm-lineNumbers': { display: 'none' } });
// …in the extensions array:
...(mode === 'aggregate' ? [noLineNumbersTheme] : []),
```
`EditorView.theme` scopes rules to that editor instance, so other `JsonEditor` modes are unaffected. The fold gutter and stage-toggle gutter remain; the line-number gutter's width is reclaimed (`display:none` removes its layout box).

### 4.6 `serializeEntries`

After 4.2–4.4, the splice-based writers replace `serializeEntries` on every real path. It is retired (and its direct round-trip tests migrate to the new writers), unless a consumer remains — to be confirmed during implementation; no behavior depends on keeping it.

---

## 5. Guarantees and documented limits

**Preserved (verbatim):**
- Any stage you don't change — exact bytes (formatting + inner comments).
- Comments between two unchanged stages; leading/trailing comments.
- A comment on its own line **above/below a stage that is replaced in place** (re-sort, filter toggle, paginate) — the common case.
- A disabled stage's own formatting/inner comments (now wrapped verbatim).

**Limit A — the changed stage is reserialized:** a comment *inside* the one stage a mutation changes is lost, and that stage is reflowed to canonical 2-space.
```js
// before: re-sorting this stage…
{ "$sort": {
    "created": -1  // primary; tie-break later
} }
// after: the inner comment is gone, body canonicalized
{
  "$sort": { "created": 1 }
}
```

**Limit B — a comment bound to an inserted/removed stage can't follow it.** On **remove** (e.g. clearing a sort), the stage's leading comment is **dropped with the stage** (chosen rule). On **insert** (first sort), a comment sitting exactly on the insertion boundary may land on the far side of the new stage.
```js
// before
// newest first
{ "$sort": { "created": -1 } },
{ "$skip": 0 }
// after clearing the sort: the $sort is gone and so is its "// newest first" line
{ "$skip": 0 }
```

**Mental model:** *don't touch a stage → its bytes and comments are exact; change a stage → that one stage is regenerated (its inner comments go); insert/remove a stage → a comment whose meaning was bound to it can't be kept.*

---

## 6. Backward compatibility

- **No-disabled pipelines no longer reflow on sort/filter.** The old fast path was byte-identical to `JSON.stringify(…, null, 2)`; it is replaced by the minimal-edit path. This is the intended behavior change (comments + formatting now survive). Tests asserting the old canonical reflow are updated.
- **Old saved/recent queries & `lastPipeline`** still load verbatim via `setValue` — unaffected.
- **Server-bound paths, downloads, bulk-ops, dedup** are untouched (they consume `JSON5.parse` output, which still drops comments).
- **Disabled-stage round-trip** is now *more* faithful (verbatim wrap/unwrap), a superset of prior behavior. Existing disable tests that assert `JSON5.parse(text)` equality and `/* @disabled-stage` presence still hold; the few that asserted *canonical* re-serialization of untoggled stages are updated.
- **No new Chrome storage keys, manifest, or schema changes.**

---

## 7. File-by-file changes

- **`src/mdh/pipelineComments.js`** — add `parsePipelineDoc`; rewrite `applyMutationToText` (reference-diff → splices), `setStageDisabled` (wrap/unwrap splice, drop the enable-invalid guard), `beautifyText` (per-stage span replace, gaps verbatim); add shared splice helpers (`applyEdits`, `reindent`); retire/repurpose `serializeEntries`; `parseEntries` re-expressed over `parsePipelineDoc`.
- **`src/mdh/components/JsonEditor.jsx`** — add `noLineNumbersTheme`, included only for `mode === 'aggregate'`.
- **Tests** — see §8.

No changes to: `pipelineOps.js`, `useQuery.js`, `api.js`, `lastPipeline.js`, `pipelineState.js`, `store.js`, `PipelineDebug.jsx`, `PipelineEditor.jsx`, `QueryHistory.jsx`, `DataPanel.jsx`, `pipelineGutter.js`, downloads/serializers.

---

## 8. Testing

Vitest, `*.test.js` (+ `h()` where rendering).

**`tests/mdh-pipeline-comments.test.js`** (the bulk — pure, exhaustive):
- **replace preserves surroundings:** a pipeline with `// comment above` a `$sort`; mutate the `$sort`; assert the comment, all other stages' bytes, and trailing stages are unchanged, and only the `$sort` body changed.
- **paginate preserves all comments:** leading + between-stage + trailing comments survive an `applySkip` replace.
- **insert/remove rules:** first `$sort` insert keeps the next stage's leading comment; clearing a `$sort` drops its leading comment (Limit B), array stays valid JSON5.
- **multi-change mutator (handleSort = applySort + applySkip):** untouched stages *between* the two changed stages keep exact bytes.
- **toggle round-trip is verbatim:** disabling a stage with custom formatting + inner comment preserves them inside the block; enabling restores them exactly; a `*/`-containing value still round-trips.
- **re-enable invalid:** enabling a disabled block with invalid inner JSON yields text containing that raw inner as an active element (no `null`, no no-op); `parseEntries` of the result is `ok:false`.
- **Beautify:** stage bodies canonicalized; standalone/leading/trailing comments preserved; inside-stage comment reflowed away; disabled blocks kept.
- **Limit A & B asserted explicitly** so the losses are intentional and pinned.
- **Replace the old "fast path byte-identical to JSON.stringify" test** with the new minimal-edit expectation.

**`tests/mdh-datapanel-disable.test.js`, `mdh-datapanel-variables.test.js`, `mdh-flow.test.js`, `mdh-pipeline-editor.test.js`** — run to confirm no regression; update any assertion that depended on canonical reflow after a mutation. Add a DataPanel-level case: a freehand comment survives a sort.

**`#5` line numbers** — verified by `npm run build` + manual smoke (jsdom computed-style for injected CSS is unreliable; do not force a brittle assertion).

Guard against flaky fixed-timeout waits (use condition-based `waitFor`).

---

## 9. Open questions (for the review gate)

1. **Remove-comment rule (Limit B):** confirm "drop the removed stage's leading comment" vs "leave it dangling." Spec assumes **drop**.
2. **`serializeEntries` retirement** (§4.6): confirm removal if no consumer remains, vs keep as a tested canonical builder.
3. **Insert anchoring:** a comment exactly on an insertion boundary attaches to the *following* stage. Confirm that bias (vs attaching to the preceding stage).
