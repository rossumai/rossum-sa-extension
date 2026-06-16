# Aggregate Pipeline Autocomplete — Context-Aware Completions

**Date:** 2026-06-16
**Status:** Approved (design) — ready for implementation plan
**Area:** MDH (`src/mdh/`), aggregate pipeline editor

---

## 1. Background & verified current state

The MDH "Aggregate Pipeline" editor is a CodeMirror instance (`JsonEditor`,
`mode="aggregate"`) that runs pipelines against **Rossum Data Storage**
(`POST /svc/data-storage/api/v1/data/aggregate`) — a MongoDB-compatible,
DocumentDB-backed service. This is a *different* engine from the Atlas-Search
MDH matching service.

Autocomplete today is `mongoCompletions()` in
`src/mdh/components/JsonEditor.jsx:161`. Verified facts:

- **Three trigger branches** (regex `matchBefore`):
  1. quoted `"$…` → operators (`JsonEditor.jsx:164`)
  2. unquoted `$…` → operators (`JsonEditor.jsx:169`)
  3. quoted `"word.path` (no `$`) → field names from the current page of records
     via `extractFieldNames(records.value)` (`JsonEditor.jsx:173`, `:188`)
- **Operator sets per mode** come from `getCompletionSets(mode)`
  (`JsonEditor.jsx:207`). For `aggregate` it returns the *union* of
  `AGGREGATION_STAGES` (16), `EXPRESSION_OPERATORS` (16), `QUERY_OPERATORS`
  (18) — ~50 operators, offered regardless of cursor position.

### Verified gaps

1. **Field refs in expressions never complete.** `"` + `$` always routes to the
   operator branch (`:164`), so `"$cust…` offers operators, never the
   `$customer_name` field. Pipelines reference fields as `"$field"` constantly.
2. **Pre-filtering blocks fuzzy matching.** Branches filter with
   `.startsWith(prefix)` (`:167`, `:171`, `:179`), defeating CodeMirror's
   built-in fuzzy/substring ranking. `$grp` won't surface `$group`.
3. **Operator coverage is a small subset** of standard MongoDB aggregation.
4. **No context-awareness** — stages are offered inside expressions, query
   operators inside `$group`, etc.
5. No system variables (`$$ROOT`, `$$NOW`), no `info` docs.

`JsonEditor`/`mongoCompletions` is **shared** by every editor in MDH (record
edit, bulk update, index/search-index panels) via the `mode` prop. The only
autocomplete test today is `tests/mdh-json-editor.test.js`, which covers
value-prop syncing, not completion behavior.

---

## 2. Goals & non-goals

**Goals** (all four, per product decision):

- **G1 — Field refs in expressions:** autocomplete dataset field names inside
  `"$…"` value references, plus system variables (`$$ROOT`, …).
- **G2 — Comprehensive operator list:** the full standard MongoDB aggregation
  vocabulary (stages, query, expression, accumulator), categorized.
- **G3 — Fuzzy matching:** drop `startsWith`; let CodeMirror's fuzzy matcher
  rank within the returned set.
- **G4 — Context-aware suggestions (strict):** offer *only* the operators valid
  at the cursor's position. **Backward compatibility for aggregate mode is
  explicitly waived** — strict lists are preferred over the old forgiving union,
  accepting that an unclassifiable cursor shows less.

**Non-goals:**

- No snippet/skeleton insertion (would change insertion behavior).
- No live probing of the backend for operator support — coverage is the standard
  MongoDB vocabulary; the user verifies execution by running the query.
- **Other editor modes** (`query`, `update`, `default`, `sort`) keep their
  current behavior. This work is scoped to `mode === 'aggregate'`.

---

## 3. Chosen approach

**Approach 2 — strict syntax-tree filtering.** Use CodeMirror's lezer syntax
tree (`syntaxTree`) to classify the cursor's position into exactly one context,
and return *only* that context's operator set. Token detection stays
regex-based (`matchBefore`) so incomplete input (`"$am`, `{ $ }`) still triggers;
the tree decides *which set*. On a genuinely unclassifiable cursor, fall back to
the full union (see §6) — a sensible default, not a back-compat guarantee.

Rejected: Approach 1 (boost full vocabulary — keeps everything reachable, but the
user wants precise lists); Approach 3 (regex/brace-depth — brittle on nesting,
comments, incomplete input).

---

## 4. Architecture

New pure, DOM-free module **`src/mdh/pipelineCompletions.js`** (unit-testable in
Node, mirroring `overviewCharts.js`). It owns:

- **Operator catalogs** — array of `{ label, detail, categories }`, where
  `categories ⊆ {STAGE, QUERY, EXPRESSION, ACCUMULATOR}`. (An operator may carry
  several — `$sum` is `[EXPRESSION, ACCUMULATOR]`.) Plus `SYSTEM_VARS`.
- **`classifyContext(state, pos)`** → one of `STAGE | QUERY | EXPRESSION |
  GROUP_VALUE | FIELD_REF | UNKNOWN` (pure given an `EditorState`; testable by
  constructing a state with the `javascript()` extension in Node).
- **`mongoCompletions(...)`** factory — the CodeMirror completion source,
  rewritten to consult `classifyContext` and emit the strict set.

The existing constants (`QUERY_OPERATORS`, `AGGREGATION_STAGES`,
`EXPRESSION_OPERATORS`, `UPDATE_OPERATORS`) and `extractFieldNames` move to / are
re-exported from this module. `JsonEditor.jsx` imports from it. Non-aggregate
modes call a thin path that reproduces today's union behavior from the same
catalogs (no behavior change).

---

## 5. Lezer tree facts (verified empirically, 2026-06-16)

Parsed with `@codemirror/lang-javascript`'s `javascriptLanguage.parser`
(JSON5/JS grammar, error-tolerant). `resolveInner(pos, -1)` at the cursor:

| Cursor situation | Node at cursor | Distinguishing rule |
|---|---|---|
| unquoted key being typed (`{ $ma`, `{ amo`) | `PropertyDefinition` | always a **key** |
| quoted key (`{ "$ma"`) | `String`, **is** `Property.firstChild` | **key** |
| string value (`y: "$fie"`) | `String`, **not** `Property.firstChild` | **value** |

- **Stage position:** the keyed `ObjectExpression`'s parent is `ArrayExpression`.
  Verified for the root pipeline **and** sub-pipelines (`$lookup.pipeline`,
  `$facet` branches) — array containment is the signal at any depth.
- **Nested context:** walk up `Property` ancestors; the **nearest** ancestor key
  starting with `$` determines context. Verified: in `$match:{ $expr:{ $g } }`
  the nearest `$`-key is `$expr` (→ EXPRESSION), correctly beating `$match`.
- Key/value test: cursor `String` is a key iff
  `prop.firstChild.from === node.from && prop.firstChild.to === node.to`.

---

## 6. Classifier rules → context → catalog

`classifyContext(state, pos)`:

1. Resolve `node = syntaxTree(state).resolveInner(pos, -1)`.
2. If `node` is a `String` **value** (not firstChild) whose text starts with `$`
   → **FIELD_REF**.
3. Determine the keyed `ObjectExpression` (the object whose key we're in).
   - If its parent is `ArrayExpression` → **STAGE**.
4. Else walk up `Property` ancestors, take the **nearest** key starting with `$`
   (call it the *governing key*):
   - governing key is `$match` → **QUERY**. (A `$`-operator key typed directly
     under `$match` — `$and`/`$or`/`$nor`/`$expr` — is a query operator; `$expr`
     re-contexts deeper, see below.)
   - governing key is `$group` / `$bucket` / `$bucketAuto`, **and** the
     intervening field key (the `Property` directly under that object) is **not**
     `_id`; or the governing key is `$setWindowFields` and we're under its
     `output` field → **GROUP_VALUE**.
   - governing key is an **expression-opening stage** (`$project`, `$addFields`,
     `$set`, `$replaceRoot`, `$replaceWith`) or an **expression operator**
     (`$expr`, `$cond`, `$switch`, arithmetic/string/array/date/…), or it is
     `$group._id` → **EXPRESSION**.
5. Anything unresolved (parse error region, top-level non-array, ambiguous) →
   **UNKNOWN**.

Context → returned options:

| Context | Options returned |
|---|---|
| STAGE | catalog where `categories` includes `STAGE` |
| QUERY | `QUERY` operators |
| EXPRESSION | `EXPRESSION` operators |
| GROUP_VALUE | `ACCUMULATOR` ∪ `EXPRESSION` (accumulator args are expressions) |
| FIELD_REF | `$`-prefixed field names (from `extractFieldNames`) ∪ `SYSTEM_VARS` |
| UNKNOWN | full union of all operator categories (fallback) |

Plain **field-name key** positions (`$sort` keys, `$group._id` written as a key,
`$project` include/exclude keys) — i.e. a quoted/unquoted **key** that does *not*
start with `$` — return unprefixed field names, preserving today's branch-3
behavior.

---

## 7. Completion source behavior

`mongoCompletions(mode, fieldsFn)` returns a source `(context) => result`:

- **Token detection** via `matchBefore` (keeps working on incomplete tokens):
  - `/"?\${0,2}[\w]*/`-style matches to capture `$op`, `"$op`, `"$field`,
    `"$$VAR`, and bare field-key prefixes. Exact regexes finalized in
    implementation; the captured `from` is the token start (after the opening
    quote for quoted tokens).
- For `mode === 'aggregate'`: call `classifyContext(context.state, context.pos)`,
  pick the option set per §6, and return `{ from, options, validFor }`.
  - **No `startsWith` pre-filter** — return the whole context set; CodeMirror's
    fuzzy matcher (config `filter: true`, default) ranks against `from..pos`.
  - **`validFor`** a token regex so CM re-filters across keystrokes without
    re-invoking the source.
- For other modes: reproduce today's union behavior from the shared catalogs
  (operators + branch-3 field names). No classifier, no behavior change.
- Field refs: `FIELD_REF` options are `extractFieldNames(...)` mapped to
  `{ label: '$' + name, type: 'property', detail: 'field' }` plus `SYSTEM_VARS`.
  Returns `null` (not an empty menu) when there are no fields/records.

---

## 8. Operator catalog (comprehensive standard MongoDB)

Categorized; each entry `{ label, detail, categories }`. Representative coverage
(final list compiled from `mongodb-reference` + `data-storage-reference` +
standard MongoDB; window-only accumulators included under ACCUMULATOR):

- **STAGE:** `$match $project $addFields $set $unset $group $sort $limit $skip
  $count $unwind $replaceRoot $replaceWith $lookup $unionWith $graphLookup
  $facet $bucket $bucketAuto $sortByCount $sample $setWindowFields $densify
  $fill $documents $merge $out $redact $geoNear $collStats $indexStats $search
  $searchMeta`
- **QUERY:** comparison `$eq $ne $gt $gte $lt $lte $in $nin`; logical
  `$and $or $not $nor`; element `$exists $type`; evaluation
  `$regex $options $expr $mod $text $where $jsonSchema`; array
  `$all $elemMatch $size`.
- **EXPRESSION:** arithmetic `$add $subtract $multiply $divide $mod $abs $ceil
  $floor $round $trunc $sqrt $pow $exp $ln $log $log10`; string `$concat $substr
  $substrBytes $substrCP $toLower $toUpper $trim $ltrim $rtrim $split
  $strLenBytes $strLenCP $indexOfBytes $indexOfCP $regexFind $regexFindAll
  $regexMatch $replaceOne $replaceAll`; array `$arrayElemAt $arrayToObject
  $concatArrays $filter $first $last $firstN $lastN $in $indexOfArray $isArray
  $map $objectToArray $range $reduce $reverseArray $size $slice $zip $sortArray
  $maxN $minN`; date `$dateFromString $dateToString $dateFromParts $dateToParts
  $year $month $dayOfMonth $hour $minute $second $millisecond $dayOfWeek
  $dayOfYear $week $isoWeek $isoWeekYear $isoDayOfWeek $dateAdd $dateSubtract
  $dateDiff $dateTrunc $toDate`; comparison `$cmp` (+ `$eq…$lte`); conditional
  `$cond $ifNull $switch`; boolean `$and $or $not`; type `$type $convert $toBool
  $toInt $toLong $toDouble $toDecimal $toString $toObjectId $isNumber`; set
  `$setEquals $setIntersection $setUnion $setDifference $setIsSubset
  $anyElementTrue $allElementsTrue`; object `$mergeObjects $getField $setField`;
  variable `$let`; special `$literal $rand $function $meta`.
- **ACCUMULATOR:** `$sum $avg $min $max $first $last $push $addToSet $count
  $stdDevPop $stdDevSamp $mergeObjects $accumulator $top $topN $bottom $bottomN
  $firstN $lastN $maxN $minN $median $percentile`; window-only `$rank $denseRank
  $documentNumber $shift $derivative $integral $expMovingAvg $covariancePop
  $covarianceSamp $linearFill $locf`.
- **SYSTEM_VARS** (value position): `$$ROOT $$CURRENT $$REMOVE $$NOW
  $$CLUSTER_TIME $$DESCEND $$PRUNE $$KEEP $$SEARCH_META`.

Operators appearing in multiple roles (e.g. `$sum`, `$min`, `$max`, `$first`,
`$last`, `$mergeObjects`, `$eq…$lte`, `$mod`, `$type`) carry multiple categories.

---

## 9. Backward compatibility & scoping

- New strict context system applies **only** to `mode === 'aggregate'`.
- `query` / `update` / `default` / `sort` modes are unchanged — same operators,
  same trigger branches, same (non-strict) behavior. Verified by leaving their
  code path equivalent and keeping `tests/mdh-json-editor.test.js` green.
- For aggregate mode, the old forgiving union is intentionally replaced by strict
  context sets (back-compat waived for this case). UNKNOWN still yields the full
  union as a safety net.

---

## 10. Testing strategy

1. **Confirm lezer node names** — already verified (§5); a small assertion test
   pins `PropertyDefinition` / `String` / `ObjectExpression` / `ArrayExpression`
   and the firstChild key/value rule so a CodeMirror upgrade that renames nodes
   fails loudly.
2. **`classifyContext` unit tests** (Node, real `EditorState` with
   `javascript()`): STAGE (root + `$lookup.pipeline` + `$facet` branch), QUERY
   (`$match` field op), EXPRESSION (`$project`, `$expr`-inside-`$match`,
   `$group._id`), GROUP_VALUE (`$group` non-`_id` accumulator), FIELD_REF
   (`"$fie"` value, `"$$RO"` system var), UNKNOWN (parse error / empty).
3. **Source factory tests:** aggregate mode returns the right strict set per
   context; no `startsWith` pruning (e.g. `$grp` keeps `$group` after fuzzy);
   field refs map to `$`-prefixed labels; `null` when no records; non-aggregate
   modes reproduce the prior union.
4. `npm test` + `npm run build` green.

---

## 11. Files touched

- **New:** `src/mdh/pipelineCompletions.js` (catalogs, `classifyContext`,
  `mongoCompletions` factory).
- **New:** `tests/mdh-pipeline-completions.test.js`.
- **Edit:** `src/mdh/components/JsonEditor.jsx` — import catalogs + factory from
  the new module; remove inline constants/`mongoCompletions`; wire
  `context.state`/`pos` through (CodeMirror already passes `context`). Keep
  `extractFieldNames` export (re-export from the new module if convenient for
  `PipelineEditor.jsx`'s import).
- **Possibly edit:** `src/mdh/components/PipelineEditor.jsx` import path for
  `extractFieldNames` (only if the export moves).

---

## 12. Risks

- **Classifier blind spots** under strict filtering surface as "fewer/no
  suggestions" rather than wrong runs. Mitigated by the UNKNOWN→union fallback
  and broad test coverage. Accepted per product decision.
- **Catalog drift / unsupported operators:** the comprehensive set may include
  operators the DocumentDB backend rejects at run time. Accepted — autocomplete
  is a typing aid; the user verifies by running. Not surfaced in the UI.
- **lezer node renames** on a CodeMirror upgrade — caught by the pinning test (§10.1).
