# MDH pagination owns the trailing `$skip`/`$limit` run — design

**Date:** 2026-09-23
**Status:** shipped (uncommitted)
**Scope:** `src/mdh/pipelineOps.ts`, `src/mdh/pipelineComments.ts`,
`src/mdh/hooks/usePagination.ts`, `src/mdh/components/DataPanel.tsx`,
`src/mdh/components/RecordList.tsx`.

## 1. Why

The question that opened this: does `{$skip: 0}` behave correctly for a non-default
query when the user pages? For the pipeline the UI builds itself, yes. For anything the
user typed, it was wrong in four ways — none of them visible as an error, all of them
silently wrong results or a dead control.

**a. Paging overwrote a load-bearing `$skip`.** `applySkipToPipeline` targeted the
*first* top-level `$skip`. In

```
[{$match: {ok: true}}, {$sort: {n: -1}}, {$skip: 3}, {$group: …}, {$limit: 50}]
```

Next rewrote the user's `$skip: 3` to `$skip: 50`. That is not pagination, it is a
different query — returning rows the user never asked for, with no indication anything
changed. `stripPaginationStages` in the same module already said, in a comment, that a
mid-pipeline `$skip` may be query semantics; `applySkipToPipeline` contradicted its
neighbour.

**b. The page size was a constant.** `store.limit` is `signal(50)` and nothing in `src/`
ever assigns it. `goNext` stepped by 50 whatever the pipeline's own `$limit` said. With
`$limit: 10` over 1000 documents, `$skip` went 0 → 50 and rows 11–50 were unreachable.
With `$limit: 200` the step of 50 re-showed 150 rows already on screen.

**c. A custom `$limit` under 50 disabled Next outright.** `hasNext` returned
`recordCount >= limit.value` — `10 >= 50` is false, so a reducing pipeline with
`$limit: 10` had no page 2 at all.

**d. A hand-typed `$skip` never reached the UI.** `extractUIStateFromPipeline` returns
`sorts` and `filters` only. Type `$skip: 120` and the footer still read "Showing 1–50",
Prev stayed disabled, and Next set `skip.value` to 50 — paging *backwards*, from record
121 to 51.

Not affected, and verified so: a `$skip` nested inside `$lookup` or `$facet` (the scan is
top-level only), and a `$skip` the user disabled from the debug panel.

(a) and (d) pull in opposite directions — one wants the UI to stop touching a `$skip` it
did not write, the other wants it to adopt one — for as long as the target is "the first
top-level `$skip`".

## 2. The rule

**The pagination window is the contiguous trailing run of `$skip` / `$limit` stages.
Everything before it is the user's query.**

That is the same trailing-run rule `stripPaginationStages` already applies, for the same
reason, so the two now agree. Under it (a) and (d) stop conflicting: a mid-pipeline
`$skip` is never the window, a trailing one always is.

`findPaginationWindow(stages)` returns `{skipIndex, limitIndex, skip, limit}`, or null
when the run is not one the UI can drive:

- **no `$limit` in it** — with no page size there is no next page;
- more than one `$skip` or `$limit`, or one stage carrying both;
- **the `$skip` sits after the `$limit`** — paging forward there could only ever return an
  empty page, which is how that pipeline failed before;
- either bound is not a usable count (a placeholder that resolved to a string, a
  negative offset, `$limit: 0`).

Null is not an error state. Prev and Next disable and carry a `title` saying the pipeline
has no trailing `$skip`/`$limit` to page through. The alternative — appending a pagination
pair on the first click — was declined: a click meant as navigation should not edit the
pipeline.

Everything else follows from the window:

| | before | after |
|---|---|---|
| Write target | first top-level `$skip`, else insert before first `$limit`, else append | the window's `$skip`, else insert before the window's `$limit`; no window → no write |
| Page size | `store.limit`, fixed at 50 | the window's `$limit` |
| Offset | `skip.value`, UI-owned | the window's `$skip`, adopted on every valid edit |

`usePagination`'s `page`, `hasNext`, `goNext` and `goPrev` take the page size as a
trailing parameter defaulting to `limit.value`, so the existing callers and the pipelines
the UI builds itself are unchanged.

## 3. The disabled-stage trap

`applyMutationToText` hands the mutator an inert stand-in for each disabled stage, holding
its slot so active-stage indices stay aligned. A trailing-run scan reads that stand-in as
a non-pagination stage and stops there — so with a disabled stage sitting after the pair,
the mutator would find no window while the controls, computed from the active stages
alone, still showed as enabled. Clicking Next would then move the footer and change
nothing else.

The stand-in is now an object with **no own keys**, and the scan steps over any such
entry. That is the whole contract, and it is why `pipelineComments` no longer uses a named
sentinel key. Covered by "pages a pipeline whose LAST stage is disabled".

## 4. What is not fixed

`store.limit` stays a constant 50: it is now only the page size of a pipeline the UI
builds, which is what it always meant. There is still no control for it, and a user who
wants a different page size edits the `$limit` — which now works.

## 5. Tests

`tests/mdh-pipeline-ops.test.ts` covers `findPaginationWindow` (twelve cases, including
every null branch) and the four `applySkipToPipeline` outcomes.
`tests/mdh-pipeline-comments.test.ts` covers the disabled-stage step-over.
`tests/mdh-hooks.test.tsx` covers the page-size parameter.
`tests/mdh-record-list-footer.test.tsx` covers the disabled controls and their reason.
`tests/mdh-datapanel-pagination-window.test.tsx` is the end-to-end proof: type a pipeline
carrying both a load-bearing `$skip: 3` and a trailing `$skip: 120` / `$limit: 10`, click
Next, and assert the offset stepped to 130 while the `$skip: 3` stayed put.

Each of those was mutation-tested — reverting the write target, the page size, the offset
adoption, or the disabled-control gate fails the test that claims to guard it.
