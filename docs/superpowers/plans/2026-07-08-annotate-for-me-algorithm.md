# "Annotate for me" — Algorithm Improvement (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make Fabry's annotations actually good: stop the hang, produce **tight, non-overlapping** bounding boxes deterministically, **fill empty fields and add missing table rows**, and move the button to the bottom-right.

**Root causes (verified 2026-07-08 on live ann 138328520 — see `reference_annotate_algorithm_rootcauses` memory):**
1. Full correction turn >180s + **no worker/bridge timeout** → hangs on "thinking", nothing applies. (2/97 datapoints human-edited.)
2. **Overlapping boxes**: backend stamped all 5 `item_quantity` boxes identical; our box resolution is page-wide with **no overlap guard**; overlaps are NOT API-rejected → must enforce client-side.
3. **Loose boxes** (~1.9× the tight OCR union): no tightening pass.
4. **VAT/empty + missing rows**: prompt never asks to fill empty fields; no `add`-row support.

**Approach (owner-chosen):** deterministic geometry pass (always tighten to OCR + row-align line-item cells + hard overlap-block) with Fabry for **values**; full missing-data (fill empty cells + add rows); button → bottom-right.

**Architecture:** New pure `geometry.js` runs client-side after Fabry proposes. Fabry's job shrinks to values + which fields to fill + which rows to add (it needn't produce precise pixels). Box geometry is computed deterministically from OCR words + row structure, with a hard non-overlap invariant. A turn/idle timeout stops the hang. Add-rows use the content `add` op (new write type — verified live before building on it).

**Tech Stack:** esbuild, vanilla-DOM content scripts, vitest, no TypeScript.

## Global Constraints
- No TypeScript; vanilla DOM (no Preact, no `innerHTML`) in content scripts; pure modules have no DOM/network/imports beyond other pure modules.
- Tests `.test.js`; DOM tests use `// @vitest-environment jsdom` docblock (never global config). Condition-based waits.
- **NO commits** (owner rule); stay on master; per-task working-tree diffs scoped to task files.
- **Write-safety:** only `replace` (existing datapoint ids) and `add` (multivalue content-node ids) ops; never confirm/export/delete. Lock released in `finally`. **NEVER write a box that overlaps another field's final box** (hard invariant, enforced in geometry). Snapshot before writes; undo restores (for adds, undo removes the added rows).
- **Grounded facts:** overlaps are a client-side constraint (API doesn't reject them); box tightening = snap to union of OCR words whose center is inside the box; row y-band comes from a line-item row's other boxed cells; `tax_details`/`line_items` are unbounded `tuple` multivalues; `add` op shape `{op:'add', id:<mvContentId>, value:[{schema_id, content:{value}}]}` (VERIFY LIVE — Task 0).
- Fabry facts: vision via `images`; small image turn ~44s, full-doc turn >180s → **slim the prompt** (rely on the image; cap OCR text) and **add an idle timeout**.
- Rebuild `dist/` for dogfood.

## Shared shapes (extends Plan 2)
```
field   += { mvSchemaId:string|null, mvId:number|null }   // owning multivalue's schema id + content-node id (null for header)
ocrWord  = { text:string, position:[n,n,n,n] }
proposal += { action:'correct'|'fill'|'add_row', cells?:[{schemaId,newValue,boxWords?}], mvSchemaId?:string }  // add_row carries the target table + its cells
change   += { boxSource:'ocr'|'pixels'|'tighten'|'row-align'|'none', op:'replace'|'add', mvId?:number, cells?:[...] }
```

## File Structure
- Create `src/rossum/annotate/geometry.js` — pure: `tightenBox`, `rowBandOf`, `boxesOverlap`, `alignAndDeoverlap`, `applyGeometry`.
- Modify `src/rossum/annotate/gather.js` — `flattenFields` also emits `mvSchemaId` + `mvId`; expose page OCR words + multivalue map already in `gathered`.
- Modify `src/rossum/annotate/prompt.js` — slim OCR (cap/omit; rely on image), instruct **fill empty** + **add rows**; output contract gains `action` + `cells`.
- Modify `src/rossum/annotate/proposal.js` — parse `action`/`fill`/`add_row` proposals; keep `correct` behavior.
- Modify `src/rossum/annotate/apply.js` — `buildAddOperations(addChanges)`; snapshot/undo for adds (record added-row ids → remove on undo).
- Modify `src/rossum/annotate/fabryProxy.js` + `fabryBridge.js` — idle/turn timeout (abort after `IDLE_MS` with no chunk) → clean error.
- Modify `src/rossum/annotate/loop.js` — integrate geometry pass (tighten all + row-align + overlap-block) before apply; handle `add` ops; keep validate/refine/undo.
- Modify `src/rossum/features/annotate-for-me.js` — button **bottom-right**; live-refresh attempt (see Task 11).
- Tests per module.

**Milestone A (Tasks 1–7): the hang + geometry + fill + button** — the core that fixes issues 1–3 for existing fields, using only the verified `replace` op. **Milestone B (Tasks 8–10): add-rows** (new `add` op; gated on Task 0 live verification).

---

### Task 0 (verification, authorized live write): confirm the `add` row op
**Not a code task.** Before building add-rows, verify the content `add` op live (needs owner write-authorization, like the earlier box-write test). Reversible test on ann 138328520: snapshot row count of `tax_details` → `POST content/operations {op:'add', id:<tax_details mvContentId>, value:[{schema_id:'tax_detail_rate', content:{value:'TEST'}}]}` (start→op→read-back new row→**remove** the added row via `{op:'remove', id:<newRowId>}`→cancel). Confirm: add returns the new row with a server id; remove deletes it; the shape is as documented. Record the exact accepted shape. **If unauthorized/unavailable, Tasks 8–10 are BLOCKED** and Milestone A still ships.

---

### Task 1: worker/bridge idle timeout (stop the hang)
**Files:** Modify `src/rossum/annotate/fabryProxy.js`; Modify `src/rossum/annotate/fabryBridge.js` (or the worker port handler in `src/background/index.js` — whichever owns the stream); Test `tests/annotate-fabryproxy.test.js` (extend).

**Interfaces:** `runFabryTurn` gains an idle-timeout: if no chunk arrives for `IDLE_MS = 75000`, abort the fetch and throw `Error('Agent timed out')` (`.status` unset). Plumb an `AbortController`/timer; reset on each chunk. The content side surfaces it as a clean panel error, not a hang.

- [ ] **Step 1: failing test** — with a `fetchImpl` whose stream never yields and never closes, `runFabryTurn` rejects with a timeout error within a short (injected) idle window (make `IDLE_MS` injectable/overridable for the test, default 75000).
```js
it('aborts a stalled stream after the idle window', async () => {
  const neverEnding = { getReader: () => ({ read: () => new Promise(() => {}) }) }; // never resolves
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body: neverEnding }));
  await expect(runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c', content: 'x', onChunk: () => {}, idleMs: 30 }))
    .rejects.toThrow(/timed out/i);
});
```
- [ ] **Step 2: run → FAIL** (no timeout yet, test hangs to vitest's own timeout — set the test's timeout to 2000ms so failure is fast).
- [ ] **Step 3: implement** — in `runFabryTurn`, accept `idleMs = 75000`; create an `AbortController`, pass `signal` to `fetchImpl`; a timer `setTimeout(() => ctrl.abort(new Error('Agent timed out')), idleMs)` reset after each `onChunk`; on abort, clear timer and throw `Error('Agent timed out')`. Keep the existing behavior otherwise.
- [ ] **Step 4: run → PASS.** - [ ] **Step 5:** `npm test` green.

---

### Task 2: `flattenFields` carries owning multivalue (mvSchemaId + mvId)
**Files:** Modify `src/rossum/annotate/gather.js`; Test `tests/annotate-gather.test.js` (extend + update exact-match expectations).

**Interfaces:** each `field` also has `mvSchemaId` (owning multivalue's `schema_id`, null for header) and `mvId` (the multivalue **content-node id**, null for header). `flattenFields` threads these through the multivalue branch (`mvSchemaId = n.schema_id`, `mvId = n.id`).

- [ ] **Step 1: failing test** — a line-item datapoint reports `mvSchemaId:'line_items'` and the multivalue's content id; header reports `null`/`null`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** — in the `multivalue` branch of `flattenFields`, pass `{inLineItem:true, rowIndex:i+1, mvSchemaId:n.schema_id, mvId:n.id}`; header ctx gets `mvSchemaId:null, mvId:null`; push these onto each datapoint. Update the existing exact-`toEqual` tests to include the two new keys (header → nulls).
- [ ] **Step 4: PASS** (all gather tests). - [ ] **Step 5:** `npm test` green.

---

### Task 3: `geometry.js` — tighten + overlap detection (pure)
**Files:** Create `src/rossum/annotate/geometry.js`; Test `tests/annotate-geometry.test.js`.

**Interfaces (pure):**
- `boxArea(b)`, `intersectionArea(a,b)`, `boxesOverlap(a,b)` (strict: intersection area > 0.5px²; shared edges don't count).
- `tightenBox(box, ocrWords, pad=1)` → the padded union of OCR words whose CENTER lies in `box`; returns `box` unchanged if none inside.
- `wordsInBand(ocrWords, band)` where band = `[x1,y1,x2,y2]`.

- [ ] **Step 1: failing test** — `tightenBox` shrinks a loose box to its 2 contained words' union (+pad); `boxesOverlap` true for intersecting, false for edge-touching/disjoint.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** the pure helpers (union = min/min/max/max; center-in test; pad expands then clamp ≥0 handled by caller/loop).
- [ ] **Step 4: PASS.** - [ ] **Step 5:** `npm test` green.

---

### Task 4: `geometry.js` — row-align + de-overlap pass
**Files:** Modify `src/rossum/annotate/geometry.js`; Test `tests/annotate-geometry.test.js` (extend).

**Interfaces:** `rowBandOf(fields, mvSchemaId, rowIndex)` → the y-band `[minY,maxY]` from the other boxed cells of that (table,row); null if none. `applyGeometry({fields, ocrPages}) → { tightened: change[], skippedOverlaps: [...] }`:
- For every field with a box: compute a **tightened** box (`tightenBox`). For a **line-item** field whose current box's y-center is outside its `rowBandOf`, first **relocate**: restrict OCR-word search to `rowBandOf ∩ (field's column x-range from same-schema cells in other rows)`, tighten within that region.
- After computing all target boxes, run a **de-overlap** check across the whole page: if a target box overlaps another field's target box, DROP that box change (keep the field's value; leave its box unchanged) and record it in `skippedOverlaps`. Never emit a box that overlaps another.
- Emit box-only `change`s (`boxChanged:true, valueChanged:false, boxSource:'tighten'|'row-align'`) only where the tightened/relocated box materially differs from current (slack or center move beyond a threshold).

- [ ] **Step 1: failing test** — a fixture with 5 identical `item_quantity` boxes stacked on row 1 + per-row sibling cells: `applyGeometry` relocates each quantity to its own row band (distinct, non-overlapping) OR drops the ones it can't place without overlap; asserts the emitted boxes are pairwise non-overlapping; a loose header box is tightened.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** `rowBandOf` + `applyGeometry` per the interface. Threshold: emit a box change if slack (curArea/tightArea) > 1.15 OR center moves > 3px. De-overlap is the last, authoritative step.
- [ ] **Step 4: PASS.** - [ ] **Step 5:** `npm test` green.

---

### Task 5: prompt — slim OCR, instruct fill-empty (+ add-row placeholder), values-first
**Files:** Modify `src/rossum/annotate/prompt.js`; Test `tests/annotate-prompt.test.js` (extend).

**Interfaces:** `buildAnnotatePrompt` — (a) cap the OCR block hard (e.g. ≤ 120 words or omit entirely, relying on the image) to shrink the prompt; (b) OUTPUT_CONTRACT: instruct Fabry to focus on **values** — correct wrong values, **fill empty fields it can read on the page**, and (Milestone B) list **missing table rows to add** — and note that **bounding boxes are computed by the tool** (Fabry may give `box_words` hints but need not be pixel-precise). Keep field list (dp#/row). Add `action` (`correct`/`fill`/`add_row`) + `cells` to the contract text.

- [ ] **Step 1: failing test** — prompt contains fill-empty guidance, mentions boxes are tool-computed, and the OCR block is capped (length bound with a large OCR fixture).
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement.** - [ ] **Step 4: PASS** (existing budget/head tests stay green). - [ ] **Step 5:** `npm test` green.

---

### Task 6: loop — integrate geometry pass + timeout error (replace-only path)
**Files:** Modify `src/rossum/annotate/loop.js`; Test `tests/annotate-loop.test.js` (extend).

**Interfaces:** `runAnnotate` — after `proposeCorrections` + `resolveBoxes`/`diffProposals` (value changes), run `applyGeometry({fields: gathered.fields, ocrPages})` and MERGE its box-only changes with Fabry's value changes (dedupe by datapointId; a field may get both a value change and a geometry box). Before building ops, run a FINAL overlap check across all target boxes (Fabry + geometry) and drop any box that overlaps another (hard invariant). Timeout errors from `streamFabry` propagate cleanly (caught by the feature). Keep snapshot/apply/validate/refine/undo. `onProgress('geometry','Tightening boxes…')` tick.

- [ ] **Step 1: failing test** — with a fabry stub returning one value change and a fixture with a loose box + stacked quantities, `runAnnotate` applies value + geometry box changes, and NO two written boxes overlap (assert against the ops). A stalled/timeout stream surfaces as a thrown error with the lock released.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement** the geometry merge + final overlap guard. - [ ] **Step 4: PASS.** - [ ] **Step 5:** `npm test` green.

---

### Task 7: feature — button bottom-right (+ live-refresh investigation stub)
**Files:** Modify `src/rossum/features/annotate-for-me.js`; Test `tests/annotate-feature.test.js` (extend).

**Interfaces:** change the injected button CSS from `top:16px` to `bottom:16px` (keep `right:16px`). Add a `statusFor('geometry')` mapping. Keep everything else.

- [ ] **Step 1: failing test** — a test asserting the injected button style contains `bottom:16px` (and not `top:16px`).
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement.** - [ ] **Step 4: PASS.** - [ ] **Step 5:** `npm test` green + `npm run build` clean.

**MILESTONE A COMPLETE** — hang fixed, boxes tight + non-overlapping, empty fields filled, button bottom-right. Dogfood-ready for issues 1–3 (existing fields).

---

### Task 8: proposal — parse `add_row` proposals (gated on Task 0)
**Files:** Modify `src/rossum/annotate/proposal.js`; Test `tests/annotate-proposal.test.js` (extend).
**Interfaces:** `parseProposal` also accepts elements with `action:'add_row'`, `mvSchemaId` (or table name), and `cells:[{schema_id,new_value,box_words?}]`; returns them as `{action:'add_row', mvSchemaId, cells}`. `correct`/`fill` (no action or action:'correct'/'fill') map to the existing field-proposal shape. Existing tests stay green.
- [ ] TDD steps: test add_row parse + existing behavior; implement; green.

### Task 9: apply — `buildAddOperations` + add-aware snapshot/undo (gated on Task 0)
**Files:** Modify `src/rossum/annotate/apply.js`; Test `tests/annotate-apply.test.js` (extend).
**Interfaces:** `buildAddOperations(addChanges) → [{op:'add', id:mvId, value:[{schema_id, content:{value}}]}]` (cells with box computed by geometry post-add, or value-only). Undo of adds: after apply, diff content to find added row ids → `runUndo` removes them via `{op:'remove', id:<rowId>}` (extend the snapshot model to record `addedRowIds`).
- [ ] TDD: buildAddOperations shape; undo removes added rows; green.

### Task 10: loop — integrate add-rows + geometry for new cells (gated on Task 0)
**Files:** Modify `src/rossum/annotate/loop.js`; Test `tests/annotate-loop.test.js` (extend).
**Interfaces:** `runAnnotate` applies `add` ops for `add_row` proposals; after add, re-flatten, run geometry on the new cells' boxes (tighten + overlap guard); record added row ids for undo. Cap number of added rows sensibly; skip adds that would overlap.
- [ ] TDD: an add_row proposal adds a row, geometry boxes it, undo removes it; green.

**MILESTONE B COMPLETE** — missing rows added.

---

### Task 11: live-update-without-reload (investigation + best-effort)
**Files:** Modify `src/rossum/features/annotate-for-me.js` (+ report).
Investigate whether the Rossum SPA can be made to repaint applied changes without a full reload. Options to probe (verify, don't assume): (a) does Rossum re-fetch content on window focus / visibility change we can trigger?; (b) a lighter `location.reload()` vs. an in-place refresh. If no clean hook exists, KEEP the "Reload to view" button and document the finding (don't hack the SPA's internals). Deliverable: either a working live-refresh or a documented "not cleanly possible; reload retained".

---

### Task 12: build + manual dogfood (owner)
- [ ] `npm test` green + `npm run build` clean; reload extension + Rossum tab; click **✨ Annotate for me** (now bottom-right); confirm: no hang (timeout if slow); boxes tight + non-overlapping (esp. quantities); empty VAT cells filled; (Milestone B) missing rows added; Undo reverts (incl. added rows). Record outcome in memory.

## Self-Review (against decisions)
- Deterministic geometry (tighten + row-align + hard overlap-block) ✅ Tasks 3/4/6. Fabry for values + fill + add-rows ✅ Tasks 5/8. Timeout/hang ✅ Task 1. Fill empty ✅ Task 5/6. Add rows ✅ Tasks 8–10 (gated on Task 0). Button bottom-right ✅ Task 7. Live-update ✅ Task 11 (best-effort). Overlap enforced client-side (API won't) ✅ Task 4/6.
- Write-safety: replace + add only; overlap invariant; lock in finally; snapshot/undo incl. added rows.
- Backward-compat: off-by-default toggle unchanged; Plan-2 replace/validate/loop/undo preserved; additive.

## Known risks
- Add-rows write NEW data → Task 0 authorized live verification is a prerequisite; undo-of-add relies on identifying added row ids (diff content pre/post).
- Deterministic row-align can't always disambiguate columns the backend already merged (e.g. quantity vs code sharing x-range) → when ambiguous, prefer DROPPING the box change (leave value) over risking an overlap; Fabry's `box_words` hint can assist.
- Slimming the prompt trades some Fabry spatial context for speed; acceptable since geometry is now deterministic.
