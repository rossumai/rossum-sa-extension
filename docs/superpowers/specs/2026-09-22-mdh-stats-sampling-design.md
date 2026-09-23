# MDH Collection Stats — sampling for extremely large collections

**Date:** 2026-09-22
**Status:** proposed.
**Supersedes for this area:** nothing. The Stats tab has no prior spec; the only written record of
its performance is the 2026-06-05 probe summarised in §2, whose three optimisation attempts were
all reverted before shipping. This design deliberately does not repeat any of them.
**Owner decisions taken during brainstorming (2026-09-22):**
- Sampling is **automatic above a threshold, plus an explicit control** — not always-on, not
  manual-only.
- Background prefetch **keeps running the stats suite for every selected collection**, sampled the
  same way the panel is, so the tab-bar health dot keeps working everywhere.
- Standing: preserve existing functionality; keep backward compatibility; never leak customer names
  or data; verify rather than assume.

**UI reviewed as rendered mockups on 2026-09-22** (nine variants across three decisions, rendered in
the built console stylesheet). Chosen: **A1** the control always in the toolbar, **B3** an info strip
replacing today's warning, **C2** the distinct count surfaced as a lower bound. §7 is what was
approved; the rejected variants and why are recorded there too, so they are not re-proposed.

## 1. What changes, in one paragraph

Today every Collection Stats run scans the whole collection eleven times. This design makes a large
collection's run **one sampled read**: a single `$sample` + `$project` query whose documents are
profiled in the browser, emitting the exact raw response shapes the ten document-reading server pipelines emit
today, so every transform, the health score, the tab-bar dot and their tests are untouched. Small
collections keep today's exact server pipelines, unchanged. A segmented control in the panel
toolbar chooses 1,000 / 5,000 / 25,000 / Exact, persisted as `mdhStatsSampleSize`. Document count
and storage figures stay exact on every path, because they come from `$collStats` metadata rather
than from a scan. No endpoint changes and no stored-data changes.

## 2. The facts this design rests on

### What the Stats tab does today

An uncached run issues **fourteen queries**: field discovery, the overview count, and the twelve
of `buildAllPipelines` (`src/mdh/statsPipelines.ts:325`). Of those:

- **three are free** — `storage`, the overview count and the 200-document discovery sample.
  The first two are `$collStats`, which reads collection metadata and never touches documents.
- **eleven scan the entire collection** — `coverage`, `empties`, `types`, `distribution`,
  `cardinality`, `strings`, `numeric`, `dates`, `sentinels`, `schema` and `docSize`.
- **seven of those eleven use `$facet` with one sub-pipeline per discovered field**, so with the
  `MAX_FIELDS = 50` cap the input stream is duplicated up to fifty times, seven times over.

There is **no `$sample` anywhere in the check pipelines**. `$sample` appears only in field
discovery (`FIELD_DISCOVERY_SIZE = 200`). The client request timeout is 30s
(`REQUEST_TIMEOUT`, `src/mdh/api.ts:50`).

`StatsPanel` fires all twelve through `Promise.allSettled` with no concurrency bound
(`src/mdh/components/StatsPanel.tsx:129`). `prefetchStats` fires the same twelve
(`src/mdh/prefetch.ts:98`), and `prefetchAll` runs it for **every collection selected in the
sidebar**, whatever panel is open (`src/mdh/index.tsx:282`).

### Measured cost (2026-06-05 probe, not re-measured for this spec)

Measured against a collection of **18.5M documents averaging ~17KB**, via timed aggregate calls.
The collection is described by shape only; it belonged to a customer organisation.

| Probe | Time |
|---|---|
| `$sample: { size: 25000 }` + count | ~1s |
| One 50-field `$facet` check over a 25,000-doc sample | ~7s |
| The same check over a **5,000**-doc sample | **also ~7s** |
| The same check over 5 fields / 15 fields | ~3s / ~7s |
| `$bsonSize` over full documents | ~3s |

The flat 5k↔25k result is the load-bearing measurement: **per-query cost on wide documents is a
fixed read floor of roughly 2s plus a shallow curve, not per-document work.** Shrinking a sample
therefore buys nothing, which is why the 2026-06 "halve the sample size" attempt failed. The floor
is paid **once per query**, so the way to spend less is to issue fewer queries, not smaller ones.

That is the whole argument for the design below: eleven reads become one.

### Measured while reviewing the mockups (2026-09-22)

`--text-secondary` on `--bg-card` gives **4.21:1** at 10–11px, under the 4.5:1 floor for small text.
That is the same ratio and the same cause as the `ModalFieldLabel` failure fixed in `a9ed60a`. It
already ships in `.stats-fields-note`, and `.stats-fcard-meta` — the dead style §7 revives — carries
it too. The info-token family used by the chosen B3 strip measures 7.5–7.7:1 in both themes.

### What is not verified, and must be before or during implementation

These are assumptions, labelled as such. Each has a probe in the implementation plan.

1. **`$sample`'s fast path on Data Storage.** MongoDB documents a pseudo-random cursor when
   `$sample` is the first stage, the collection holds at least 100 documents, and N is under 5% of
   them; otherwise it falls back to a collection scan plus a random sort. The 2026-06 probe is
   consistent with the fast path (25,000 of 18.5M is 0.13%, and took ~1s) but the rule itself was
   not tested at the boundary on Data Storage.
2. **Wire representation of BSON numeric subtypes.** Data Storage returns JSON. Whether a `long` or
   a `decimal` arrives as a bare JSON number or as `{"$numberLong": …}` decides how faithfully the
   client can report types. See §5, "Known divergences".
3. **Transfer cost of the sample.** 5,000 documents projected to 50 fields has not been measured on
   a wide collection. The control's largest setting (25,000) is the one at risk, not the default.
4. **End-to-end browser behaviour.** The 2026-06 attempt at client-side compute was reverted before
   it was ever run in a real browser. This one is not done until it has been.

## 3. When it samples, and why the threshold is not a magic number

Sampling only helps while `$sample` takes the random-cursor path. At or above 5% of the collection
MongoDB scans and sorts, which costs at least as much as the exact pipeline it would replace. So
the rule is derived from the sample size rather than chosen:

> **Sample when `totalDocuments > 20 × sampleSize`. Otherwise run the exact path.**

With the default sample size of 5,000 that puts the automatic threshold at **100,000 documents** —
which is, coincidentally, already the value of `LARGE_COLLECTION_WARN` in `StatsSummary.tsx:6` —
the constant behind today's "some checks may be slow or time out" banner. Both go: the banner is
replaced by the sampling note in §7, and the constant is **deleted rather than moved**, because the
threshold is no longer a fixed number. It is `20 × sampleSize`, so it moves with the control.

The exact document count needed to apply the rule is already fetched and cached before the checks
run (`totalCount`, from `$collStats`), so the decision costs nothing.

## 4. The sampled read

One query replaces eleven:

```js
[
  { $sample: { size: N } },
  {
    $project: {
      _id: 0,
      // the same ≤50 discovered field paths fieldsOnly() projects today
      '<field>': 1, …,
      // top-level key names, for the schema-shape check
      _topKeys: { $map: { input: { $objectToArray: '$$ROOT' }, as: 'k', in: '$$k.k' } },
    },
  },
]
```

`_topKeys` is what lets the schema-shape check survive the projection. Today `schema` is the one
check with no field projection at all — it reads whole documents to count top-level keys. Shipping
whole 17KB documents to the browser is exactly the cost this design exists to avoid, so the key
*names* are computed server-side and the values are left behind. `_topKeys` includes `_id`, matching
the current pipeline, which derives `fieldCount` as `$size(_keys) - 1` and filters `_id` out of
`sampleFields`.

Field discovery is unchanged: its own cached 200-document full-document `$sample`, because
discovery needs values it has not yet named.

So a sampled run issues **four queries** — discovery, `$collStats` ×2, and the analysis sample —
against today's fourteen, and exactly one of the four reads documents.

## 5. The compute engine

A new pure module `src/mdh/statsCompute.ts` — DOM-free, network-free, unit-tested directly, the same
shape as `statsView.ts` and the pure half of `statsSummary.ts`.

**Its contract is the raw response shape, not the view model.** For each of the ten
document-reading checks it emits precisely what `api.aggregate` returns for the corresponding
server pipeline — `{ result: [ … ] }`, same keys, same `encKey` encoding — and `StatsPanel` writes
those into the same `stats_<key>` cache entries. Consequences:

- `statsView.ts`, `statsSummary.ts`, `buildFieldProfiles`, `computeHealthScore`, the tab-bar dot
  and `updateStatsSummary` need **no changes at all** for sampling;
- `tests/mdh-stats-view.test.ts` and `tests/mdh-stats-summary.test.ts` keep guarding both engines;
- on any collection small enough to run both paths, the two must agree — which is the differential
  test in §9.

### Semantics `statsCompute.ts` must reproduce

Each row is a place where the obvious JavaScript is wrong. These are the implementation's real
work; the arithmetic is trivial by comparison.

| Server behaviour | Correct client equivalent |
|---|---|
| `$type` of an absent path is `'missing'`, distinct from `null` | resolve paths with an explicit found/not-found result at every level, never `?? null` |
| `$a.b` where `a` is an **array of documents** yields an array of the `b` values, **omitting elements that lack `b`** | reproduce implicit array traversal; do not treat it as undefined |
| EJSON wrappers are BSON scalars server-side — `$type` never says `'object'` for them | `{$oid:…}` → `'objectId'`, `{$date:…}` → `'date'` |
| `$strLenCP` counts **code points** | `[...str].length`, never `str.length` |
| `$ltrim`/`$rtrim` trim MongoDB's DOCUMENTED default set: 20 code points — NUL, tab, LF, VT, FF, CR, space, NBSP, U+1680, and U+2000 to U+200A. It includes NUL and excludes the BOM; it also EXCLUDES U+2028, U+2029, U+202F, U+205F and U+3000 | one shared character class matching that table exactly. `String.prototype.trim()` is wrong on NUL and the BOM, and general "Unicode whitespace" is wrong the other way: U+3000, the CJK full-width space, is trimmed by JS and NOT by `$trim` |
| `$group: { _id: '$f' }` is distinct by BSON value **and** type, and groups an array field as a whole array | canonical key = type tag + `JSON.stringify` with **insertion order preserved** (do not sort keys — BSON document equality is order-sensitive) |
| `$sort: { count: -1 }` then `$limit` | same order and limit, so `TOP_VALUES` slices identically |

### Known divergences, accepted

**BSON numeric subtypes.** The client cannot tell `int` from `double` in a JSON number, so
`statsCompute` emits the type `'number'` where the server emits `'int'`/`'long'`/`'double'`/
`'decimal'`. Every downstream consumer already collapses these — `friendlyType` maps all four to
`'number'`, and both `transformTypes` and `fieldTypeSummary` count distinct *logical* types
specifically so that a field holding `1` and `0.5` is not reported as a type mix. `friendlyType('number')`
returns `'number'` unchanged, so the collapse is a no-op. The divergence is therefore visible in the
raw shape and invisible in every rendered number. Assumption 2 in §2 must confirm that longs and
decimals do not arrive pre-wrapped; if they do, they are mapped to `'number'` too.

**Arrays of numbers and dates.** The server's `numeric` and `dates` checks filter with
`$match: { f: { $type: 'number' } }`, a query-level `$type` that matches when ANY element of an
array field is a number. The client requires the value itself to be a number. A discovered leaf
path is a scalar in the documents it was discovered from — `allDiscoveredFields` treats an array as
a leaf and never descends — so this differs only for a field that is a scalar in some documents and
an array of numbers in others. Asserted by `computeNumeric`'s test rather than left implicit.

**Null versus missing in the `empties` check — RESOLVED IN CODE, on the server side.**
The server's `null_<k>` counter used to be a bare `{$eq: ['$f', null]}`. In MongoDB aggregation a
missing field path is widely held to compare EQUAL to `null` under `$eq`, which would mean that
counter silently included every document where the field is absent — so a field missing from 412
documents and null in none would render as "412 null · 412 missing", while `computeEmpties`, which
treats the three counters as mutually exclusive, read "0 null · 412 missing" from the same data.
A user can see both numbers, because toggling **Exact** re-runs the server pipelines.

It was parked behind a live probe because it could not be settled from here. It did not need
settling. `buildEmptyValuesPipeline` now excludes `'missing'` explicitly:

```js
{ $and: [{ $ne: [{ $type: '$f' }, 'missing'] }, { $eq: ['$f', null] }] }
```

That is correct under BOTH hypotheses — a no-op if `$eq` already excludes missing, a fix if it does
not — so the two paths agree by construction and the probe is unnecessary. Blast radius is confined:
`transformEmpties` flags a field on the SUM of the three counters, so the health score and the
tab-bar dot are unaffected; only the displayed null figure changes, in the correcting direction.
See §11 for the one respect in which an exact run is therefore no longer byte-identical to HEAD.

**Document size.** `$bsonSize` has no client equivalent, and JSON byte length is not BSON byte
length. On a sampled run the `docSize` check is **not** computed from the sample at all — it is
derived from `$collStats.storageStats`, which is exact and already fetched: `avg` from
`avgObjSize`, `total` from `size`, `count` from `count`. `min` and `max` are emitted as `null`,
since storage stats do not carry them and a sampled min/max would be a narrower range presented as
the true one. `StatsSummary` currently puts them in the card's `title` unconditionally
(`StatsSummary.tsx:141`) and gains a guard: the min/max tooltip appears only when both are present.

## 6. Ratios must divide by what was analysed

`buildFieldProfiles` takes `total` and uses it for both display and `diversityPct`
(`distinct / total`). On a sampled run those are two different numbers: 5,000 documents were
analysed, millions exist. Dividing a sample's distinct count by the collection's size reports every
field as 0% diverse.

Today `diversityPct` is only a **sort key** (`StatsFieldGrid.tsx:24`), so getting it wrong scrambles
card order rather than printing a wrong number. Under §7's C2 the underlying `distinct` becomes
visible, which raises the stakes on the same arithmetic.

So `buildFieldProfiles` gains an `analyzed` input used for every ratio, with `total` kept for
display. On an exact run the caller passes the same value for both, so behaviour is identical.
`StatsPanel` is its only caller; `tests/mdh-stats-view.test.ts` covers it and gains cases for the
two-value case.

`transformCoverage`'s own `pct` needs nothing: it already divides by the `_total` carried inside the
same result, which on a sampled run is the sample size — self-consistent either way.

## 7. The approved interface

Three decisions, each reviewed as a rendered mockup against the built stylesheet.

### The sample-size control lives in the toolbar, always (A1)

A segmented control in the Stats toolbar, reusing the `view-seg` / `view-seg-opt` / `aria-pressed`
idiom `StagesView` already uses for "Records per stage" (`StagesView.tsx:257`) rather than a new
component — per the standing preference for the existing design-system idiom.

- Options: **1k · 5k · 25k · Exact**. Default 5,000.
- Persisted as `mdhStatsSampleSize` in `chrome.storage.local`, wired exactly like
  `mdhStagesSampleSize`, with a `coerceStatsSampleSize` guard mirroring `coerceStageSampleSize` so a
  hand-edited or stale value cannot produce a nonsense pipeline.
- Changing it invalidates the collection's `stats_*` cache entries and re-runs, the same path the
  existing ↻ button takes. The cache keys themselves are unchanged, but the entries carry a
  `statsRunSize` marker recording the size that produced them — `0` for an exact run, so the value
  is never `null` and a stored marker cannot be mistaken for a cache miss. Both callers write it
  after their `stats_*` writes and both re-check it before reading, invalidating the collection's
  entries when it does not match. The marker is needed because invalidation on a control change is
  per collection while the entries live for ten minutes each: a run can find entries ANOTHER
  collection's run left at a different size, and reusing them would divide a 5,000-document
  payload's distinct counts by 25,000 and label the strip with a size the payload never had.
  `ttlFor` gives any field starting with `stats` the long TTL, so the marker expires with the
  entries it describes.
- Background prefetch reads the same preference, so the dot and the panel never disagree about how
  much was sampled.
- **Exact** is offered at every size and is honest about itself: on a very large collection it will
  reach the 30s timeout, and the resulting per-check error already renders. It is the user's call,
  and on a 200,000-document collection it may well finish.

**Why it is not hidden on small collections**, which was the rejected variant: the threshold is
`20 × sampleSize`, so whether sampling applies depends on the control's own value. A
50,000-document collection is exact at 25,000 and sampled at 1,000. A control that hides itself
below a threshold cannot express a threshold that moves with it.

### An info strip replaces the warning (B3)

`StatsSummary.tsx:178` currently renders a yellow `stats-warn` banner above 100,000 documents
saying checks "may be slow or time out". After this change that sentence is false, so the banner has
to change regardless. It becomes a neutral info strip in the same position, carrying the same
weight, built from the existing `--info-bg` / `--info-fg` / `--info-border` tokens that
`.stats-tchip` already uses:

> Estimated from a random sample of **5,000** of 4,210,663 documents. Document count and storage are exact.

It is the only one of the three reviewed options with room for the second sentence, and at 7.5–7.7:1
it is the only one that clears the contrast floor without a fix. Exact runs render nothing, as today.
The rejected alternatives were a muted note under the summary (quiet, and at 4.21:1) and an
"estimated" chip on every band label (travels with the content, but repeats down the page).

### The distinct count is surfaced as a lower bound (C2)

**Correcting §6 of the first draft:** `distinct` is computed for every field and **rendered
nowhere**. `buildFieldProfiles` produces it, and its only consumer is `diversityPct`, the secondary
sort key in `StatsFieldGrid.tsx:24`. So there was no displayed number to caveat — labelling it was
not a detail but a decision about whether to build it at all.

It gets built. The field card gains a meta row under its header:

> `≥ **4,812** distinct` … `in 5,000 sampled`

with `≥` present only on sampled runs; an exact run reads `4,812 distinct`. This answers the one
question the top-values list cannot — whether a field is an identifier or a category — and it is the
number sampling most affects, so leaving it invisible would have been the least honest option
rather than the safest.

`.stats-fcard-meta` already exists in `console.css` with exactly this layout and is **dead CSS**,
emitted by no component since the card was rebuilt; reviving it is why this costs no new style. It
must, however, move from `--text-secondary` to `--text-primary`: measured at 4.21:1, the same fix
`a9ed60a` made to `ModalFieldLabel` for the same reason. Its `b` element is already
`--text-primary`, so only the surrounding words change.

Because `$sample` is random, two runs give different numbers. The 10-minute stats cache (`TTL_LONG`)
already prevents that by itself; only ↻ or a control change re-draws.

## 8. Prefetch, and the double-run defect

`prefetchStats` keeps running for every selected collection, using the same rule and the same
sampled read — so the tab-bar health dot keeps appearing everywhere, now for one query instead of
twelve.

One defect is fixed in passing, because it is the cause the 2026-06 probe identified for the
original timeouts. `prefetchStats` and `StatsPanel` both check the cache, both miss, and both fire
the full suite, so the work is done twice concurrently. A **single in-flight promise per
`(collection, sampleSize)`**, held next to the cache, makes the second caller await the first
instead of duplicating it. With one query per run this matters less than it did, and it is still
wrong to issue it twice.

## 9. Testing

Success is defined before implementation, per the repo's standing rule.

1. **The transforms read the emitted shape (the primary criterion).** No recorded server responses
   exist, and capturing a set would need a live organisation, so the check is not a diff against
   the server. Instead, for a set of fixture documents, `statsCompute`'s output for each of the ten
   checks is fed to the transform that consumes the server's response for the same check —
   `transformStatsResults`, `transformCardinality`, `transformDistribution`, `transformNumeric`,
   `transformDates` — and the **transformed** result is asserted against a hand-derived expectation.
   Transformed rather than raw, because of the numeric-subtype divergence in §5, which is exactly
   the difference that must not reach the UI. This proves the emitted shape is one the existing
   transforms read correctly; it does not prove the server emits the same shape, which is what §9.7's
   live run is for. New file `tests/mdh-stats-compute.test.ts`.
2. **Semantics cases**, one per row of the §5 table, each failing before the correct implementation:
   missing-vs-null, array traversal with a gap, EJSON `$oid`/`$date`, an astral-plane string for
   `$strLenCP`, a `\0`-padded string for trim, `{a:1,b:2}` vs `{b:2,a:1}` as distinct group keys.
3. **The budget rule** (§13.1, which retired the `20 × sampleSize` threshold this item used to
   name). Monotonicity in collection size over a grid of totals, document sizes and field counts;
   both invariants — `rows × avgObjSize ≤ SAMPLE_BYTE_BUDGET` and `rows × fields ≤
   SAMPLE_MAX_CELLS`; the row clamp when neither budget binds; the exact path when `avgObjSize` is
   unknown; and `Exact` forcing the exact path at any size.
4. **`buildFieldProfiles` with `analyzed ≠ total`** — diversity divides by `analyzed`, display uses
   `total`, and the equal case is byte-identical to today.
5. **Null versus missing — no probe.** This was a live aggregate that would have decided whether
   the server's `null_` counter includes absent documents. It was dropped: the server pipeline now
   excludes `'missing'` explicitly, which is correct whichever way `$eq` behaves, so the question
   no longer has to be answered to know the two paths agree. The pipeline's shape is asserted in
   `tests/mdh-pipelines.test.ts` instead.
6. **Existing suites unchanged.** `tests/mdh-stats-view.test.ts` and `tests/mdh-stats-summary.test.ts`
   must pass without edits other than the new `analyzed` cases; any other edit to them means the raw
   contract in §5 was broken.
7. **A live run in a real browser**, on an internal organisation only, against a collection large
   enough to sample. jsdom cannot tell us whether this is fast. Per §2 assumption 4, the work is not
   done until this has happened, and the transfer size of the 25,000 setting is measured while it is.

## 10. Out of scope

- **Raising `MAX_FIELDS` above 50.** Client-side compute removes the server-side reason for the cap
  — there is no `$facet` fan-out any more — but transfer size stays linear in field count, so the
  cap becomes a transfer budget rather than a server limit. Leaving it at 50 keeps this change to
  one variable.
- **Progressive refinement** (paint at 1,000, refine to 25,000 in the background). Appealing, and
  not needed to make the tab usable.
- **Making the exact path faster.** Below the threshold it already is.
- **Any other use of the revived `.stats-fcard-meta` row.** It carries the distinct count and
  nothing else.
- **Any change to what the health score means.** Same inputs, same weights, now estimated.

## 11. Compatibility

- **No stored data changes.** The only new storage key is the preference `mdhStatsMode` (§13.2
  renamed it from `mdhStatsSampleSize`, which stored a size); an absent value reads as `'sample'`,
  so existing profiles behave as if they had chosen it.
- **No API changes.** Every pipeline stage used here is one the panel already issues.
- **Exact runs are byte-identical to today, with ONE deliberate exception.**
  `buildEmptyValuesPipeline`'s `null_<k>` counter now excludes a missing field explicitly (§5), so
  on a server where `$eq` treats an absent path as null, an exact run reports a smaller null figure
  than HEAD did — the correcting direction, and the change that makes the exact and sampled paths
  agree. Every other pipeline is untouched, and the exact path remains the one every collection
  inside the budget takes.
- **Callers.** `buildFieldProfiles` gains one input and has one caller. `buildAllPipelines` keeps
  its signature; the sampled read is a new builder beside it, not a change to it.

## 12. Verified after implementation (2026-09-22)

**Verified headlessly, against the built stylesheet, with no organisation and no customer data.**
A scratchpad harness rendered the three changed surfaces — the toolbar control, the info strip and
the field card's distinct row — against `dist/console/console.base.css` at this change's HEAD, in
both themes, and was measured in Chrome:

| Check | Result |
|---|---|
| `.stats-note` contrast | **7.68:1** light, **7.51:1** dark — clears the 4.5:1 floor |
| `.stats-fcard-meta` contrast | **17.25:1** light, **12.66:1** dark — was 4.21:1 before the `--text-primary` fix |
| Hierarchy preserved without colour | the count renders at `font-weight: 600` |
| `.stats-warn` removed | absent from Chrome's own CSSOM; `.stats-note` present |
| `≥` renders as the character | confirmed in the rendered text, not as an escape |
| Horizontal overflow | none |

The CSSOM check is the method CLAUDE.md prescribes for a CSS deletion, because a hand-rolled parser
is what the three silent traps defeat.

**The §13.4 schema layout has had the same headless check** — the shape columns, the elision button
and the "Show these records" button rendered against `dist/console/console.base.css` in both themes —
but not the live check below: nobody has clicked "Show these records" against a real collection and
watched the Data tab come back with the matching rows.

**Still open, and they need a live organisation.** These are the items §2 listed as assumptions and
§9 as probes, plus the §13.4 records jump, and none of them can be answered from this machine — no
Rossum token is configured here, and the dogfooding recipe requires a visible browser window against a
real organisation:

1. **Wall-clock time and transfer size** of the sampled read on a collection above the budget, at
   both ends of the row range the budget produces — a wide-document collection (few rows) and a
   narrow-document one (rows capped by `SAMPLE_MAX_CELLS` or `SAMPLE_MAX_ROWS`). What is being
   measured is whether `SAMPLE_BYTE_BUDGET` (64MB) and `SAMPLE_MAX_CELLS` (400,000) are set right;
   the latter is derived from one set of V8 timings and is the likelier of the two to be wrong.
2. **Main-thread block time** of `assembleSampledStats` at the cell ceiling, in the Console rather
   than in a microbenchmark. The ceiling claims roughly 1.5s of profiling; that is the number to
   confirm.
3. **`$sample` above 5% of the collection** on Data Storage. The byte budget is what makes that
   zone safe (§13.1), and the sort-buffer reasoning has not been checked against a live server.
4. **The wire representation of BSON numeric subtypes** (§2, assumption 2). `bsonType` and
   `numericValue` handle both forms, so this confirms which is real rather than changing the code.
5. **That exactly one analysis read is issued** when the panel and the prefetch race in a real
   browser — the unit test simulates that race; it has not been observed live.
6. **The §13.4 "Show these records" jump.** `buildShapeFilterPipeline`'s `$setEquals` match is
   unit-tested against fixture documents, but nobody has clicked the button on a live collection and
   confirmed the Data tab comes back with the matching rows.

## 13. Revision, 2026-09-22 — budgeted sample, and an always-visible schema

Two owner decisions taken after the first implementation landed. Both supersede earlier sections
where they conflict; §3 and §7's four-option control are **retired**, not amended.

### 13.1 The sample is a byte budget, not a fraction of the collection

**What was wrong.** §3 derived the sample from the collection: sample when `total > 20 × sampleSize`.
The owner rejected it on a case the rule makes indefensible — a 90,000-document collection analyses
all 90,000, while a 110,000-document one analyses ~5,000. The step is 20× wide and lands wherever the
threshold is put, so moving it only moves the absurdity.

**Why the step was forced.** `$sample` keeps MongoDB's cheap random cursor only while it draws under
5% of the collection. Deriving the sample as a fraction therefore means that the moment you stop
reading everything you may read at most a twentieth of it. The cliff was a consequence of measuring
the sample against the collection.

**The rule now.** Precision on every proportion this panel reports depends on how many documents were
read, not on what share of the collection they were — 25,000 documents give the same ±0.6 points at
500,000 as at 18 million. So the sample is a budget:

> **`analysed = min(total, affordableRows(avgObjSize, fieldCount))`**, where `affordableRows` takes
> `min(SAMPLE_BYTE_BUDGET / avgObjSize, SAMPLE_MAX_CELLS / fieldCount, SAMPLE_MAX_ROWS)` and rounds
> it DOWN to the nearest 1,000 — below 1,000 rows, the exact count survives unrounded.

`affordable` does not depend on `total`, so **the number of documents analysed is monotonically
non-decreasing in collection size.** It rises with the collection until it meets the budget, then
stays flat. There is no size at which growing the collection analyses fewer documents. A property
test asserts exactly that, over a grid of totals and document sizes, and it is the guard that keeps
this honest.

**Why the budget is in bytes.** Above 5% of the collection `$sample` scans and holds the drawn
documents in a sort buffer capped at 100MB without `allowDiskUse`, which this API cannot pass.
Budgeting in bytes makes that buffer equal the budget by construction, so the zone where the sample
is more than 5% of the collection but less than all of it becomes **safe to use** rather than
forbidden — and that zone is precisely the 90k-to-110k range the old rule handled so badly. The byte
budget also tracks the real cost: a wide document costs more to move than a narrow one, and the row
count should fall accordingly.

**There is no row FLOOR, deliberately.** A floor would be the one clamp that can push the sample
PAST a budget, and both invariants depend on no term doing that: `rows × avgObjSize ≤ BUDGET` is what
makes the >5% zone safe, and a floor on a very wide document breaks it. A floor also has to be
compared against something, and the only thing available is the collection — which reintroduces the
dependence on `total` that monotonicity forbids. Every term in `affordable` is therefore independent
of collection size, and the property test in §9.3 is what keeps it that way. If a future reader is
tempted to add a floor because 200 rows is a thin sample, the answer is that a thin sample is
honest and a broken invariant is not.

**A second ceiling, in cells, because the byte budget protects the wrong half.** `rows =
SAMPLE_BYTE_BUDGET / avgObjSize` bounds transfer and the sort buffer, but the client-side profiling
is O(rows × fields) across nine passes — and rows is INVERSELY proportional to document size, so the
byte budget's protection runs backwards there: the smaller the documents, the more rows fit and the
longer the main thread is blocked. Measured on V8, 3,855 rows × 50 fields took 532ms, 65,536 × 50
took 12.3s and 100,000 × 50 took 17.2s, with the Console frozen throughout — and a five-million-
document collection of ~1KB, 50-field documents is an ordinary MDH shape. `SAMPLE_MAX_CELLS =
400_000` bounds the product instead, at roughly 1.5s of profiling. It does not depend on `total`
either, so monotonicity survives it. The field count comes from field discovery, which already runs
before the path decision.

**The result is rounded DOWN to a readable multiple of 1,000.** The byte invariant depends on the
direction: the returned count is what keeps `rows × avgObjSize` inside `SAMPLE_BYTE_BUDGET`, and so
inside MongoDB's 100MB `$sample` sort cap, and only a floor preserves that — rounding 1,001 up to
2,000 would nearly double the budget. Below 1,000 rows the exact count is returned unrounded,
because rounding a few hundred rows to the nearest thousand would floor them to zero.

**When `avgObjSize` is unknown, read exactly.** Without a document size neither the transfer nor the
sort buffer can be bounded, so the byte invariant would not hold by construction — and a fixed row
fallback would leave `rows × avgObjSize` unbounded precisely when the documents might be huge. We
cannot bound a read we cannot size, so `analysisPlan` does not sample it.

`avgObjSize` comes from `$collStats.storageStats`, is exact, and costs nothing — but it must now be
fetched **before** the path decision rather than alongside the sampled read, which is a change to the
panel's phase ordering. It is fetched **independently of the document count**, not under a shared
`Promise.all`: a failed storage probe must cost the sampled path and nothing else, or a count already
in hand is discarded with it and the panel falls back to eleven full-collection scans with
`total = 0`.

### 13.2 The control is Sample / Exact

Two options, not four. The size is derived from the budget and the collection, so there is nothing
left for the user to choose but the intent. **Exact** remains as an explicit override that runs the
unchanged server pipelines. Nothing of the first implementation shipped, so the preference is renamed
from `mdhStatsSampleSize` (which stored a size) to `mdhStatsMode`, storing `'sample'` or `'exact'`.

**A simplification this opens, deliberately NOT taken here.** When `analysed == total` the one-read
path reads every document, so its numbers are identical to the exact path's by definition rather than
by approximation — which makes the eleven server aggregations redundant at every size. Collapsing to
a single path would be faster everywhere and would delete a whole branch, but it is a larger deletion
than was asked for. Recorded so the option is not lost.

### 13.3 A shape is a field set, not a field count

`buildSchemaConsistencyPipeline` grouped on the NUMBER of top-level keys and took `sampleFields` from
`$first` — the first document in each group. So two genuinely different 20-field documents counted as
one shape, and the names displayed were whichever document happened to arrive first. The side-by-side
diff could therefore be fiction, which was tolerable while the view was collapsed behind a toggle and
is not now that it is always visible.

Shapes are now grouped by the actual key set. `$sortArray` would be the direct way to normalise key
order, but it needs MongoDB 5.2+ and Data Storage's version is unverified here, so instead the server
groups on the raw key array, takes the top 50, and `transformSchema` merges equal key sets before
taking the top 20 — version-independent, and key-order variants merge correctly. The raw `_id` becomes
the field list itself, which removes the `$first` fiction entirely; `fieldCount` derives from its
length.

**This moves the health score, on purpose.** Real shapes usually outnumber field-count shapes, and the
score subtracts 20 per extra shape, so messy collections will score lower than they did. That is the
score becoming truthful, not a regression, and it is recorded here so nobody later reads it as one.

### 13.4 The schema is always visible

Today a single-shape collection shows no field list at all, and a multi-shape one hides behind a
toggle above a 20-field union — because the structure renders one field per row, so 21 fields across
3 shapes is 63 rows.

**Rejected design, for the record.** The first pass folded the union into two groups: fields that
differ between shapes, kept as the side-by-side columns, and fields present in every shape, pulled out
of the list into one compact wrapped line naming them ("14 in every shape: …"), collapsing only as a
safety valve if the varying set alone exceeded ~25 fields. The owner rejected it verbatim — *"I don't
like the '14 in every shape'. Let's keep the fields in the list but let's collapse them a bit (keep
only the beginning and end and allow users to expand the schema on click)."* A second round rendered
three ways to do that collapse and drew a related objection: *"why are there more than one? Shouldn't
the common fields be on top of the list with the common middle collapsed?"* — i.e. one collapse point,
not several. Neither the wrapped-line grouping nor a multi-point collapse shipped; do not reintroduce
either.

**What shipped instead.** `buildRowPlan` in `src/mdh/components/StatsSchema.tsx` orders the field
union by category rather than pulling any of it out of the list: fields present in every shape first
(alphabetical), then fields that differ between shapes (alphabetical) — so the common run sits
together at the top of the list instead of being scattered by name among the differing fields. Only
that common block's middle is elided, keeping `HEAD_ROWS` (6) and `TAIL_ROWS` (3) always visible, and
collapse triggers only once the common block exceeds `HEAD_ROWS + TAIL_ROWS + 1` (10) fields; every
differing field renders unconditionally, whatever its alphabetical position would otherwise have been
among the common ones. That yields exactly one elision per column — the previous alphabetical-only
ordering produced one per gap, since each differing field split the common run and could open its own
collapsible stretch on either side of it.

The elision is a button (`ElisionRow`, `.stats-schema-more`), not the plain wrapped text of the
rejected design. Collapsing it again reuses the identical control, relabelled "Show fewer", at the
foot of the expanded list — the return trip is exactly as visible as the outward one. (The previous
build's plain-text control already amounted to a collapse; the owner's request went unnoticed because
nothing marked it as clickable.) Every column (`ShapeColumns`) renders from the same `rows` array,
elision included, so the row sequence — and the vertical alignment across columns — is identical; a
single-shape collection (`SingleShapeList`) gets the same head/tail collapse over its one field list,
where today it shows nothing.

**The records jump.** Each shape header carries a "Show these records" button
(`.stats-shape-records`); a single-shape collection gets the same button below its list. Both call
`buildShapeFilterPipeline` in `src/mdh/statsView.ts`, which stages a pipeline through
`pendingPipelineLoad` and switches to the Data tab — the same mechanism `StatsFieldCard.tsx` already
uses for a top value's "click to see those records" jump via `buildValueFilterPipeline`. The match is
one `$expr: { $setEquals: [...] }` over the document's own key list (`$objectToArray('$$ROOT')` mapped
to keys), not a series of `$exists` checks: a shape now means an exact key set (§13.3), so a document
carrying one extra field is a different shape, and an `$exists`-only match would wrongly count it as
this one.
