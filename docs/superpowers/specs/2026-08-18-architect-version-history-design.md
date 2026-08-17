# Architect version history + collection rename — design

**Date:** 2026-08-18
**Status:** implemented (uncommitted; owner approval pending for the commit)
**Owner decisions:** version granularity = per editing session; surface = 4th action-console tab;
collection renamed to `_SA_EXTENSION__fabry_architect`; `_SA_EXTENSION__*` kept out of Dataset
Management's list and shown in an expandable group beneath it; migration must tolerate orgs that
cannot be renamed now.

## 1. Why

A deliverable is a specification that people negotiate over. Until now the Architect kept exactly
one state of it — the current text — so an accepted Refine proposal, an implement-loop roll-up, or
an afternoon of edits erased whatever came before with no record. "What did this say last week, and
who changed it" had no answer.

Two things ride along, both owner-requested in the same breath: the collection gets a name that
marks it as this extension's, and Dataset Management stops showing our collections beside the
customer's datasets.

## 2. Live-verified facts

Probed against the internal org (organization 1) at `elis.rossum.ai/svc/data-storage/api/v1`,
with throwaway collections that were dropped afterwards. Nothing here was assumed.

| probe | result |
|---|---|
| `POST /collections/create` with a `_SA_EXTENSION__` name | **200 ok** — the prefix is accepted (this also closes the `__`-prefix gate open since the Architect shipped) |
| `insert_one` of a `kind:'revision'` doc, then `find {kind:'revision'}` | round-trips unchanged |
| `POST /collections/rename` | **200 ok**, and the documents are intact under the new name |
| create a collection that exists | **HTTP 400** `collection <name> already exists` |
| rename onto an existing target | **HTTP 400** `target namespace exists` |
| rename a missing source | **HTTP 400** `Source collection <ns>.<name> does not exist` |
| **`find` on a collection that does not exist** | **200 with `result: []`** |
| `POST /collections/drop` | 202 (async) |

Two of these are load-bearing:

- Every failure is an **HTTP 400**, and `src/mdh/api.js:55` throws on any non-OK status, so a failed
  migration surfaces as an exception. No response-body inspection is needed.
- `find` cannot answer "does this collection exist" — an absent collection and an empty one are
  byte-identical. **`listCollections` is therefore mandatory** for the resolution step, and the
  boot pays exactly one extra call for it.

## 3. What a version is

One document per version, in the same collection as its deliverable:

```js
{ _id: 'rev_<uuid>', kind: 'revision', deliverableId, text, at, source }
// source: 'edit' | 'refine' | 'restore'
```

`loadDeliverables` queries `{ kind: 'requirement' }`, so revision documents are invisible to this
build's normal load **and to every older build** — the additive-key precedent (`titleSource`,
`state`) applied to whole documents. Full text per version rather than a patch chain: restore is
then a plain write, and one bad entry cannot corrupt the middle of a history.

`source` records the change that **superseded** the stored text, so a row reads "at 11:07 a Refine
acceptance changed this; here is what it looked like before". That also answers "what did Fabry do
to my spec" without a separate provenance feature.

## 4. When a version is minted (`revisionPolicy.js`, pure)

The editor autosaves 600ms after typing stops (`DeliverableEditor.jsx:41,48`), so one version per
save would mint dozens per paragraph. Instead, one version per **editing session**: the first save
of a session stores the **pre-edit** text; later saves in that session write nothing.

A session ends when the author pauses longer than `IDLE_MS` (5 min), switches deliverable, or when
the `source` changes — a human edit following an accepted Refine is a different act and deserves
its own entry. `CAP` is 40 per deliverable, and pruning **always keeps the earliest** version: it is
the only copy of where the document started, and unlike every later version it cannot be
reconstructed from what survives (the same reasoning as `storage.js pruneOrgs` never evicting a
record that holds a receipt).

Two properties worth stating because they are easy to get wrong:

- The snapshot decision is made **before** the store is mutated, since the version stores the text
  as it *was*.
- The insert is **not awaited** by the save path. A user's text must never wait on its history, and
  a failed insert costs one missing entry instead of an unsaved edit (pinned by a test).

The first edit after this ships captures the pre-upgrade text, so no existing deliverable loses its
starting point retroactively.

## 5. Restore

Restoring is an ordinary edit whose `source` is `'restore'`. Because a source change always opens a
new session, the pre-restore text is snapshotted first — which is what makes restore undoable and
why it needs no confirmation dialog. The diff the reader just examined is on screen beside the
button.

## 6. Surface: the History tab

`[Check | Refine | Implement | ↺ History]`. Version list at left (relative time + kind of change,
newest first, with the live text pinned above as a landmark that is deliberately not selectable),
diff at right via the existing `src/ui/DiffView.jsx` — unmodified, and already unit-tested.

- The list query **projects `text` out**, so opening the tab is cheap on a long specification; each
  version's text is fetched only when it is actually looked at.
- Diff defaults to **selected → current** ("what changed since then") with a `vs next` mode that
  isolates the single change a version recorded. The neighbour's text is fetched by
  `ensureRevisionText`, which deliberately does **not** move the selection.
- The panel is keyed per deliverable, so a switch remounts it and drops a selection that would
  otherwise point at another document's version.

One incidental fix came with it: an **external** text change (a restore, or an accepted Refine)
now repaints the preview. `preview` only followed typing, so the pane kept showing superseded text
until the next keystroke — the editor itself was always fine, because `MarkdownEditor`'s value
effect dispatches the new document.

## 7. Collection rename and migration

`_SA_EXTENSION__fabry_architect` replaces `__mrfabry_architect`. Both names live in
`collectionNames.js`, a leaf module with no imports, so the Architect (which owns the documents) and
MDH's sidebar filter (which hides them) share one source of truth.

**The hazard, verified in code:** `loadArchitect` calls `ensureCollection`, which *creates* the
collection when absent (`api.js:9`). So an older build elsewhere — another machine, a profile that
has not auto-updated — recreates the legacy collection on its next boot and writes into it. A bare
rename is therefore not enough.

`planCollection({ hasNew, hasOld })` (pure, 4 states) drives one boot-time step:

| state | action |
|---|---|
| new only | use it |
| neither | create the new one |
| **legacy only** | try the rename. On success, use the new name. **On failure, keep using the legacy collection, unchanged, and try again next boot** — this is the "customers we cannot rename now" case, and it is *not* surfaced as an error |
| **both** | use the new one, **also read the legacy one**, union by `_id` with the newest edit winning, and say so in the UI |

A rename that fails with `target namespace exists` is not a failure: another tab won the race, so
the new collection exists — but ours did not move, so the legacy one still does too. That is
precisely the merge state, and it is treated as such rather than as an error.

Nothing is ever dropped or overwritten. **Writes follow the document**, not `current`: `colFor(id)`
routes an update to whichever collection the deliverable actually lives in.

> **A design correction made during implementation.** The approved design said the merge state would
> converge by *adopt-on-write* — editing a legacy-resident deliverable would move it to the new
> collection. That cannot be an upsert: `updateOne` with `upsert` creates a document without
> `kind:'requirement'`, which `loadDeliverables` filters on, so the deliverable would silently
> vanish from the list. A full-document copy while an older build may still be writing the legacy
> copy risks resurrecting stale text over newer. Write-where-it-lives is strictly safer and keeps
> both builds working, at the cost of leaving the two collections un-consolidated until the owner
> drops the legacy one. Consolidation is deliberately manual and not in this change.

## 8. Hiding our collections from Dataset Management

`isHiddenCollection` (prefix `_SA_EXTENSION__`, plus the legacy name explicitly, since it cannot be
renamed on every org) is applied at `Sidebar.jsx`'s single `listCollections` site through
`store.applyCollectionFilter()`. `rawCollections` keeps what the server returned; `collections` is
the filtered, sorted view every other consumer (Overview, prefetch, the empty state) already reads,
so they cannot disagree.

They are not merged back in on reveal. `applyCollectionFilter` splits the sorted list into
`collections` (the customer's) and `hiddenCollections` (ours), and the sidebar renders the latter in
an **expandable group pinned below** the main list (owner, 2026-08-18) — a disclosure row
`▸ Extension collections (n)` whose expanded state is the global `mdhShowHiddenCollections`. Rows
come from the same `collectionRow(name)` renderer as the main list, so a hidden collection selects,
middle-clicks, right-clicks and kebab-menus exactly like any other; it merely starts out of sight.
The group is absent entirely on an org that has none of ours.

Two consequences worth stating. A selection is cleared only when the collection no longer
**exists** — visibility is not the test, or selecting one from the group would immediately deselect
it. And a restored per-tab selection that happens to be one of ours **auto-expands** the group
(without persisting, so it cannot overwrite the preference), because a highlight hidden under a
collapsed header reads as no selection at all.

Reachability is required, not a nicety: the MDH record editor is currently the only way to
hand-edit a deliverable or read a stored version. Hiding is decluttering and must not read as a
security boundary — the collection is plainly visible to anything else holding the org token.

## 9. Backward compatibility

- Revision documents are invisible to older builds (`kind` filter).
- `state`/`titleSource`/`createdAt`/`editedAt` handling is unchanged; `createdAt`/`editedAt` are now
  carried into the store because the merge needs them.
- A deliverable with no history shows an honest empty state, not an error.
- An org whose rename cannot happen keeps working exactly as before, on the old collection.
- No new browser storage for content: versions live in Data Storage with their deliverables. The
  only new persisted value anywhere is the `mdhShowHiddenCollections` UI preference.

## 10. Tests

6 new files, +73 tests (310 files / 3358 tests, all passing):

- `fabry-architect-collection-plan.test.js` — the 4 states, the race-lost matcher, merge
  newest-wins (including a *newer legacy* edit winning), ordering, junk tolerance.
- `fabry-architect-collection-resolve.test.js` — resolution against a mocked client: create,
  rename, rename-failure fallback, lost race → merge, 401 rethrow, list failure → legacy,
  merge-state dual read, **write routing to the collection a document lives in**, revision CRUD
  shapes.
- `fabry-architect-revision-policy.test.js` — session boundaries (the autosave case, the idle
  edge, deliverable and source changes), prune keeping the earliest, determinism on tied
  timestamps.
- `fabry-architect-history.test.js` — one version per session across three saves, source change
  opening a new one, no-op saves writing nothing, **text still saved when the history write
  fails**, pruning past the cap, restore snapshotting first, a missing version reported instead of
  writing an empty document.
- `fabry-architect-history-panel.test.js` — list rendering, loading/empty/error states, auto-select
  of the newest, selection, diff rendering, `vs next` fetching without moving the selection,
  restore gating.
- `mdh-hidden-collections.test.js` — the prefix rule (including near-misses that must **not**
  match), an assertion that the Architect's own name is caught by the prefix and not merely by
  name, the filter's ordering/copy semantics, and selection clearing.

jsdom has no layout, so the History pane's two-column flex sizing is not unit-tested; it follows the
`min-height: 0` rule the MDH Stages pane needed, and `height: 100%` degrades to content height if
the console ever loses its definite height, so neither case collapses.

## 11. Not done

- **Consolidating the merge state** — deliberately manual (see §7).
- **Attribution to a person.** A version records what kind of change was made, not who made it. The
  org token identifies a user, but reading it costs a call and the single-SA case gains nothing;
  worth revisiting if a shared org asks for it.
- **The reference rewrite** in the other org's deliverables is still pending that org's access —
  the elis token reaches organization 1, whose collection holds a single 374-character deliverable.
  The inventory tool (`refs.mjs`, scratchpad) classifies every link against the shipping modules
  and is ready to run.
