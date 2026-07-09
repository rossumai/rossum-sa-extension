# Annotate-for-me v2: READ → LOCATE → RECONCILE — Design

Owner-approved 2026-07-08 ("go"), grounded in a live probe on the demo doc
(readprobe: 13/13 header quotes located, 29/30 line-item quotes located,
0 value disagreements beyond formatting, 103s full-reading turn; naive per-row
line matching 0/5 on near-identical rows → whole-table alignment required).

## Principle

Fabry is excellent at READING documents and mediocre at localization. So it
never does geometry: it reports **what is printed** (values + verbatim quotes);
the client deterministically finds each quote in its own OCR and draws every box.

## Phases

**READ (Fabry, ONE turn per run, pass 1 only).** Prompt = schema inventory
(header field ids + enum options, tables with columns sourced from the SCHEMA so
even fully-emptied tables keep their columns) + the JSON reading contract.
Output: `{headers:[{schema_id,value,printed,page}], tables:[{table,rows:[{cells:
[{schema_id,value,printed}]}]}]}` where `printed` is the value's exact page text
(null when inferred, e.g. language). The reading describes the PAGE, which never
changes mid-run → it is CACHED and re-reconciled on every later pass (added rows
get their boxes on pass 2 from cached quotes — no second AI turn).

**LOCATE (client, deterministic — `align.js`).**
- Headers: existing line-coherent claim-aware matcher (`matchValueWords`).
- Table cells: whole-table sequence alignment — cluster OCR words into lines,
  score each (row, line) pair by how many of the row's quoted cells match the
  line via consecutive-word-window quote matching, then assign rows→lines with
  an order-preserving injective max-total DP (ties prefer more assigned rows).
  Near-identical rows resolve via discriminator cells (#1…#5, distinct amounts);
  fully identical rows are interchangeable so in-order assignment is correct.
  Per-row minimum score: min(2, quoted cells).
- `box_pixels` is GONE from the AI contract. All boxes are quote-located word
  unions; `snapAndGuard`'s box-invariant validation + overlap ladder still apply.

**RECONCILE (client, pure — `reconcile.js`).** Reading vs current fields:
- empty field + read value → fill (+ located box when quoted).
- valued field, reading agrees (parse-aware compare) → keep; if boxless and
  quote located → box-only change.
- valued field, MATERIAL disagreement → correction (newly catches
  wrong-but-unflagged values the old scoped prompt never reviewed).
- read rows beyond the annotation's row count → `add_row` (values only; boxed
  next pass from the cached reading). Rows are paired IN ORDER (v1 limitation:
  an annotation missing its FIRST printed row would mispair — documented, rare).
- never delete rows; never touch fields the reading doesn't mention.

Parse-aware comparator (`sameValueLoose`): numbers via grouping/decimal-separator
heuristics (never digits-only compare — "1.5" vs "15" must differ); dates via
candidate sets (ISO, M/D/Y, D/M/Y, month-name) intersecting; enums are
conservative — fill/correct ONLY on exact option-value match, else leave alone
(probe: read "invoice" vs enum "tax_invoice" must not churn).

## Unchanged

Geometry-first pass, gridPass, snapAndGuard, validate → refine loop (fix turns
keep `buildFixPrompt` + datapoint_id-keyed parseProposal on the SAME chat),
quality score + plateau, undo/snapshot, panel, unboxed honesty.

## Pruned

`buildAnnotatePrompt`/`scopeFields`/field-list blocks, `parseAddRows`,
`proposeFromGathered`/`proposeCorrections` (replaced by `readDocument`),
`box_words`/`box_pixels` in the main contract.

## Files

- NEW `src/rossum/annotate/reading.js` — buildReadPrompt, parseReading
- NEW `src/rossum/annotate/align.js` — clusterLines, matchQuoteInLine,
  lineScore, orderPreservingAssignment, locateTable, locateQuote
- NEW `src/rossum/annotate/reconcile.js` — sameValueLoose, reconcileReading
- `gather.js` — flattenSchema carries enum `options`; new `collectSchemaTables`
  → `tableColumns` in the gathered bundle
- `propose.js` — readDocument (replaces proposeFromGathered/proposeCorrections)
- `loop.js` — pass-1 read + cached-reading reconcile each pass
- `prompt.js` — buildFixPrompt only
- `proposal.js` — parseAddRows removed
