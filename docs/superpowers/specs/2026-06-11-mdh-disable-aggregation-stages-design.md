# Disable Individual Aggregation Stages in the MDH Pipeline Editor

**Date:** 2026-06-11
**Status:** Design — awaiting review
**Area:** Dataset Management app (`src/mdh/`) — Data panel pipeline editor

---

## 1. Problem

The Data panel runs MongoDB aggregation pipelines that the user edits as a single raw
JSON5 array in one CodeMirror editor (`PipelineEditor` → `JsonEditor`, `mode="aggregate"`).
Today the only way to take a stage out of the query is to delete it (and lose it) or
hand-comment it. We want a first-class way to **toggle individual stages on/off** — disable
a stage without losing it, then re-enable it — driven from the UI.

### What the user asked for

1. A way to disable individual stages in the aggregation query.
2. Every decision grounded in verified facts; no assumptions.
3. Backward compatibility preserved throughout.

### Decisions taken during brainstorming

All confirmed with the user:

- **Representation — JSON5 comments.** A disabled stage is commented out in the editor text.
  Chosen over a marker-key wrapper (`{"$disabled": …}`) or sidecar state.
- **Comment format — block comment with sentinel:**
  ```
  /* @disabled-stage
  {
    "$sort": { "amount": -1 }
  } */
  ```
  The `@disabled-stage` sentinel disambiguates a disabled stage from the user's own freehand
  comments and lets it be recognized after a reload.
- **Toggle UI — both surfaces:** a per-stage toggle in the Pipeline Debug stage list **and**
  a clickable gutter marker in the editor.
- **Persistence — everywhere:** disabled state survives reload, saved/recent queries, and
  collection switches. This is free because it lives in the editor text and all persistence
  stores raw text.
- **Comment-preservation scope — disabled stages only.** Through the rebuild actions
  (sort / filter / page / reset) only `@disabled-stage` blocks are preserved. Arbitrary
  freehand comments are still dropped by those actions — exactly as today, so no regression.
  General comment preservation was explicitly deferred (YAGNI).

---

## 2. Goals / Non-goals

**Goals**

- Toggle any top-level stage between enabled and disabled from the Debug list and the editor gutter.
- Disabled stages are excluded from the query, the per-stage Debug counts, and all downloads.
- Disabled stages persist verbatim across reload, save/load, and collection switches.
- Disabled stages survive sort / filter / pagination (the editor-rewrite actions).
- Zero behavior change for pipelines that have no disabled stages.

**Non-goals**

- Preserving arbitrary freehand comments through rebuild actions (deferred).
- Reordering, adding, or deleting stages from the new UI (out of scope — editor still owns that).
- A structured per-stage card editor (Compass-style). The single text editor remains the source of truth.
- Disabling sub-expressions within a stage. Only whole top-level stages toggle.

---

## 3. Verified ground truth

| Fact | Source |
|---|---|
| Pipeline is one raw JSON5 text buffer; editor uses the JS grammar so comments tokenize. | `JsonEditor.jsx:8-11`, `PipelineEditor.jsx` |
| `JSON5.parse` drops `/* @disabled-stage … */` blocks → `[{"$match":{}}]`. **Verified empirically.** | `node -e` with `json5` |
| The text is sent to the server in 3 families of call sites, all via `JSON5.parse` of the (substituted) text: the main query, the per-stage Debug counts, and the 4 download/export paths. | `useQuery.js:30,52`; `PipelineDebug.jsx:86,108,208`; `DataPanel.jsx` download* |
| Sort / filter / paginate rewrite the editor via `JSON5.parse → mutate → JSON.stringify(…, null, 2)` (`mutatePipelineText`) — this strips comments. | `DataPanel.jsx:79-93,370-389` |
| Reset / "View selected" / default collection-switch / Beautify also re-serialize via `JSON.stringify`. | `DataPanel.jsx:61-68,294-308,55-59`; `PipelineEditor.jsx:56-62` |
| Load / restore / external-prefill paths use `setValue(rawText)` verbatim → comments survive. | `DataPanel.jsx:127,142,158,365` |
| Persistence stores raw `getValue()` text. | `lastPipeline.js:12-22`; `pipelineState.js:11-14`; `QueryHistory.jsx:40-47` |
| `editorState.parsed` is consumed in exactly one place: `<PipelineDebug pipeline=… />`. | `DataPanel.jsx:876` (+ `:874` `!= null` check) |
| The UI mutators are pure and only touch `$sort` / `$match` / `$skip` / `$limit` stages. | `pipelineOps.js` |
| `extractUIStateFromPipeline` / `currentPipelineFilter` read `JSON5.parse` output → already exclude disabled stages. | `pipelineOps.js:80-103`; `DataPanel.jsx:206-219` |
| `api.aggregate` POSTs the pipeline verbatim — a bare `[]` would be sent as-is. | `api.js:189-191` |
| Saved-query dedup key is `collection + '::' + JSON.stringify(JSON5.parse(pipeline))` → comments dropped. | `QueryHistory.jsx:23-27` |

The decisive property: because `JSON5.parse` drops the comment, a disabled stage is excluded
from **every** server-bound path with **no change** to those paths. The only real work is the
inverse — keeping the comment alive through the `JSON.stringify` rebuilds.

---

## 4. Architecture

### 4.1 New pure module: `src/mdh/pipelineComments.js`

The one new primitive. Pure, no Preact/DOM — unit-testable like `pipelineOps.js`.

**Data model — an ordered entry list:**
```
Entry = {
  disabled: boolean,   // true → was a /* @disabled-stage … */ block
  stage: object,       // the parsed stage object (e.g. { $sort: { amount: -1 } })
  lineStart: number,   // 1-based first line of this entry's span in the text
  lineEnd: number,     // 1-based last line (inclusive)
}
```

**API:**

- `parseEntries(text) → { entries: Entry[], ok: boolean }`
  Strategy (delegates the hard parsing to JSON5):
  1. String-literal-aware scan for top-level `/* @disabled-stage … */` blocks. Reuse the
     string-state scanning idiom already in `usePipeline.scanPlaceholders` so a sentinel that
     appears inside a JSON string is not matched. Block comments don't nest and a stage's JSON
     never contains `*/`, so the closing scan is safe.
  2. Replace each matched block with a unique placeholder element `{"__disabledSlot": k}`,
     remembering the captured inner text for slot `k`.
  3. `JSON5.parse` the resulting (comment-free) array. On parse failure → `{ entries: [], ok: false }`.
  4. Walk the parsed array: a `__disabledSlot` element → re-parse its captured inner text into
     the disabled `stage` (set `disabled: true`); anything else → an active entry.
  5. Compute `lineStart` / `lineEnd` for each entry from the original text (for the gutter).

- `serializeEntries(entries) → string`
  Emit a JSON array. Active entries are pretty-printed with `JSON.stringify(stage, null, 2)`
  (matching today's formatting). Disabled entries are emitted as:
  ```
  /* @disabled-stage
  <JSON.stringify(stage, null, 2)>
  */
  ```
  at their position in the array, with correct comma placement (a disabled block followed by
  more entries still needs the array to remain valid JSON5 once parsed — the comment carries no
  comma; commas live on the active elements).

- `setStageDisabled(text, entryIndex, disabled) → string`
  `parseEntries` → flip `entries[entryIndex].disabled` → `serializeEntries`. The index is into
  the **full** entry list (active + disabled interleaved), which is exactly what both UIs render.
  No-op (returns `text` unchanged) when `!ok` or index out of range.

- `hasDisabledStages(text) → boolean`
  Fast check (does the text contain a top-level `@disabled-stage` block?) used to pick the fast
  path in `mutatePipelineText`.

- `weaveDisabledBack(entries, activeStages) → Entry[]` — re-interleaves mutated active stages with
  disabled entries by anchoring (§4.2).
- `effectivePipeline(parsedArray) → array` — normalizes an empty active pipeline to
  `[{ $match: {} }]` (§4.3); identity otherwise.

### 4.2 Comment-preserving rebuild (DataPanel `mutatePipelineText`)

```
function mutatePipelineText(mutator) {
  if (!editorRef.current) return;
  const text = editorRef.current.getValue();

  if (!hasDisabledStages(text)) {
    // EXISTING fast path — byte-identical to today. Zero change when nothing disabled.
    let parsed; try { parsed = JSON5.parse(text); if (!Array.isArray(parsed)) return; } catch { return; }
    const next = parsed.map(shallowCopyObj);
    mutator(next);
    writeBack(JSON.stringify(next, null, 2));
    return;
  }

  // Disabled stages present → preserve them.
  const { entries, ok } = parseEntries(text);
  if (!ok) return;                                  // invalid WIP — leave untouched
  const active = entries.filter(e => !e.disabled).map(e => shallowCopyObj(e.stage));
  mutator(active);                                  // reuse pipelineOps unchanged
  const rebuilt = weaveDisabledBack(entries, active);
  writeBack(serializeEntries(rebuilt));
}
```

`weaveDisabledBack(entries, active)` re-interleaves the (possibly added/removed/reordered)
active stages with the disabled entries using **anchoring**:

- Each disabled entry is anchored to the active stage that **immediately preceded it** in the
  original `entries` order (or "head" if it was first).
- On rebuild, emit disabled entries right after their anchor's new position. If the anchor was
  removed by the mutator, fall back to the nearest surviving predecessor; if none, head.
- Anchor identity is resolved by reference to the original active-stage objects (we pass the
  same object instances into `mutator`, and `pipelineOps` mutators preserve untouched stage
  objects by reference — only the touched `$sort`/`$skip`/`$match` stage is replaced).

`pipelineOps.js` is **not modified** — it operates on the active-only array exactly as before.

> **Defaulted decision (flag for review):** the anchoring rule. Alternative would be index-based
> repositioning, but reference-anchoring is the most intuitive ("the disabled stage stays after
> the stage it was after") and degrades gracefully. Documented for the spec-review gate.

### 4.3 "All stages disabled" edge case

If the effective (active) pipeline parses to `[]`, the query/count/download paths would send a
bare `[]` to `api.aggregate`. To avoid relying on undefined server behavior, the effective
pipeline is normalized to `[{ $match: {} }]` (all records — consistent with `downloadAll`)
whenever it is empty. This normalization lives at the point of execution, not in the editor text
(the editor still shows all stages disabled).

> **Defaulted decision (flag for review):** empty → `[{ $match: {} }]`. Alternative: skip the
> query and show "all stages disabled — nothing to run." Chosen the run-all default as least
> surprising and matching the existing download-all convention.

### 4.4 Pipeline Debug stage list (`PipelineDebug.jsx`)

- DataPanel passes the **entries** (`parseEntries(editorState.text)`) instead of `editorState.parsed`,
  so disabled stages render too.
- Disabled rows render greyed, with a "disabled" affordance, **no count**, and are **skipped** in
  the prefix-count fan-out. Counts for active stages are computed over the active prefix (the
  JSON5-parsed pipeline, which already excludes disabled stages — so the existing prefix logic is
  correct once disabled rows are filtered out of the count loop).
- Each row gets a toggle control (enabled → disable, disabled → enable) → calls back to DataPanel
  → `setStageDisabled(getValue(), entryIndex, …)` → `setValue(newText)` under `suppressSync` →
  re-run query.
- The "input (stage 0)" row is unchanged.

### 4.5 Editor gutter toggle (`JsonEditor.jsx`)

- A custom CodeMirror gutter, gated to `mode === 'aggregate'`, that places a clickable marker on
  each stage's first line: `◉` enabled, `⊘` disabled. Plus a line decoration greying the lines of
  disabled stages.
- Stage→line spans come from `parseEntries` run on the current doc. On a doc change the gutter
  recomputes; on parse failure it shows no markers (no crash, no stale markers).
- Clicking a marker toggles that stage via the same `setStageDisabled` path (dispatched as a
  single editor change so undo treats it atomically).
- `@codemirror/view` (already a dependency — `keymap` is imported from it) provides `gutter`,
  `GutterMarker`, `Decoration`, `ViewPlugin`.

### 4.6 Persistence & dedup

- Persistence is **free**: `lastPipeline`, `pipelineState`, and saved/recent queries all store raw
  `getValue()` text, so `@disabled-stage` blocks round-trip verbatim.
- `dedupKey` (`QueryHistory.jsx`) currently normalizes via `JSON5.parse`, which drops comments —
  so two saves differing only by which stages are disabled collide. Make `dedupKey` sentinel-aware
  (include each entry's `disabled` flag + position in the normalized key) so distinct disable
  configurations are distinct saved queries.

> **Defaulted decision (flag for review):** making dedup disable-aware. Alternative is to keep
> today's behavior (disable state ignored for dedup); chosen disable-aware so a user can save both
> "full pipeline" and "pipeline with stage 3 off" without one clobbering the other.

---

## 5. Backward compatibility

- **Existing pipelines** (no sentinel) → `hasDisabledStages` is false → the original fast path runs,
  byte-identical. Nothing changes.
- **Old saved/recent queries & `lastPipeline`** have no sentinel → all stages active on load. No migration.
- **Server-bound paths** unchanged — they still `JSON5.parse` the text; disabled stages were never
  valid stages and are simply absent from the parsed pipeline.
- **`extractUIStateFromPipeline` / `currentPipelineFilter`** already read parsed output → a disabled
  `$match`/`$sort` correctly does not produce a filter chip / sort arrow / bulk-op seed filter.
- **No new Chrome storage keys.** No manifest or schema changes.

---

## 6. Edge cases

| Case | Behavior |
|---|---|
| All stages disabled | Effective pipeline normalized to `[{ $match: {} }]` (§4.3). |
| Invalid JSON5 in editor | Toggles no-op; gutter hides markers; Debug renders only on valid parse (existing). |
| Disabled stage hand-edited to invalid JSON inside the comment | Enabling surfaces a gentle error and leaves it disabled; no crash. Precise handling (forgiving vs strict) is Open Question #4. |
| Sentinel string inside a JSON string literal | Not matched (string-aware scan). |
| Disable, then sort/filter/page | Disabled block preserved and re-anchored (§4.2). |
| Disable, then Reset / "View selected" | Discarded (these are deliberate full rebuilds to a fresh pipeline). |
| Beautify with a disabled stage | Beautify runs `JSON5.parse → JSON.stringify` → would drop the comment. Make Beautify entries-aware (parseEntries → serializeEntries) so it preserves disabled blocks too. |

---

## 7. File-by-file changes

- **`src/mdh/pipelineComments.js`** *(new)* — `parseEntries`, `serializeEntries`, `setStageDisabled`,
  `hasDisabledStages`, `weaveDisabledBack`, `effectivePipeline` (empty → `[{$match:{}}]`).
- **`src/mdh/components/DataPanel.jsx`** — `mutatePipelineText` dual path (§4.2); pass entries to
  `PipelineDebug`; wire the disable/enable callback; normalize empty effective pipeline in `runQuery`
  and the download paths (via `effectivePipeline`).
- **`src/mdh/components/PipelineDebug.jsx`** — consume entries; render disabled rows greyed; skip
  disabled in counts; per-row toggle.
- **`src/mdh/components/JsonEditor.jsx`** — aggregate-mode gutter + disabled-line decoration + click
  toggle (§4.5).
- **`src/mdh/components/QueryHistory.jsx`** — sentinel-aware `dedupKey` (§4.6).
- **`src/mdh/components/PipelineEditor.jsx`** — `beautify` becomes entries-aware (§6).
- **`console.css`** — styles for disabled Debug rows, the gutter markers, and greyed lines.

No changes to: `useQuery.js`, `pipelineOps.js`, `api.js`, `lastPipeline.js`, `pipelineState.js`,
`store.js`, the download serializers.

---

## 8. Testing

Vitest, `*.test.js` rendering via `h()` (per `reference_vitest_test_jsx_convention`).

- **`pipelineComments.test.js`** (pure, the core): round-trip `parseEntries`↔`serializeEntries`
  identity; `setStageDisabled` enable/disable; `hasDisabledStages`; string-literal-safe sentinel
  scan; multi-line + nested-object stages; invalid-JSON `ok:false`; `weaveDisabledBack` anchoring
  through sort (insert/replace/remove `$sort`), filter delta, and pagination; empty → `[{$match:{}}]`;
  the **nothing-disabled fast path produces byte-identical output to today**.
- **DataPanel integration**: sort/filter/page preserve a disabled stage; disabling all runs
  `[{$match:{}}]`; toggling from the Debug list re-runs the query.
- **PipelineDebug**: disabled rows render greyed and are excluded from the count fan-out; active
  counts unaffected.
- **Gutter**: test the pure span-computation + the toggle command separately from the live view
  where jsdom limits CodeMirror (per the WebGL/limited-jsdom testing pattern); a thin view-level
  smoke test if feasible.
- Guard against the flaky fixed-timeout pattern (`reference_vitest_flaky_fixed_timeouts`): use
  condition-based `waitFor`, not fixed sleeps; loop the suite to check for races.

---

## 9. Open questions (for the review gate)

1. **Anchoring rule** (§4.2) — confirm reference-anchoring vs index-based.
2. **Empty effective pipeline** (§4.3) — confirm `[{ $match: {} }]` vs "nothing to run".
3. **Dedup disable-awareness** (§4.6) — confirm distinct-saves vs ignore-disable.
4. **Hand-edited invalid disabled block** (§6) — exact handling: keep the whole pipeline `ok` and
   leave that one slot disabled-and-unparseable (rendered as raw text in the Debug list), or treat
   the text as `!ok` until fixed? Leaning toward the former (more forgiving).
