# MDH — Make search index definitions copy-pasteable

**Date:** 2026-06-10
**Status:** Approved (design), pending implementation
**Area:** Dataset Management (MDH) → Search Indexes (Atlas Search) panel

## Problem

Solution architects routinely create a new Atlas Search index by copying an
existing index's definition and pasting it into the **Create Search Index**
modal, then tweaking it. Today that round-trip is broken: the JSON the **Copy**
button produces cannot be pasted into the Create modal without manual surgery.

### Verified facts (grounded, not assumed)

The shape the list endpoint returns per index (real sample, copied from the
live panel — `POST /search_indexes/list`, `nameOnly=false`):

```jsonc
{
  "name": "default",            // top-level
  "type": "search",             // runtime
  "status": "READY",            // runtime
  "queryable": true,            // runtime
  "latest_definition": {        // snake_case wrapper
    "mappings": { "dynamic": false, "fields": { "NAME": { "type": "string" } } },
    "analyzer": null,
    "analyzers": null,
    "search_analyzer": null,    // snake_case
    "synonyms": null
  }
}
```

The Create modal (`SearchIndexPanel.jsx` `openCreateModal` → `handleCreate`)
parses **flat, camelCase** keys and hard-requires two of them:

| Create field    | Required | Source in list object        |
|-----------------|----------|------------------------------|
| `indexName`     | yes      | `name`                       |
| `mappings`      | yes      | `latest_definition.mappings` |
| `analyzer`      | no       | `latest_definition.analyzer` |
| `analyzers`     | no       | `latest_definition.analyzers`|
| `searchAnalyzer`| no       | `latest_definition.search_analyzer` |
| `synonyms`      | no       | `latest_definition.synonyms` |

`createSearchIndex` (`api.js`) sends exactly `{ collectionName, indexName,
mappings, analyzer?, analyzers?, searchAnalyzer?, synonyms? }`. The endpoint
contract is this fixed set — verified against `data-storage-reference`.

The **Copy** button (`IndexCard.jsx:12`) copies the raw list object verbatim,
and the card body shows that same raw object. So pasting the copied JSON yields
`indexName = undefined` and `mappings = undefined` → the modal blocks with
**"indexName and mappings are required."** The user must manually rename
`name`→`indexName`, lift `latest_definition.mappings` to the top level, rename
`search_analyzer`→`searchAnalyzer`, and delete the wrapper + runtime fields.

## Decision

**Approach B (clean copy), scope = B only.** Runtime fields belong in the UI
(badges), never in the copied/displayed JSON. The principle:

> For a search index, **what the card shows = what Copy puts on the clipboard =
> what the Create modal's parser expects.**

Name-collision handling: **leave as-is.** Cloning/pasting keeps the original
name; if it collides (index names are unique per collection), the async create
fails server-side and surfaces the operation error — same as today. No rename
suggestion, no client-side collision warning.

(Approaches A "tolerant paste" and C "one-click Clone" were considered and
declined for this scope.)

## Design

### 1. New pure module: `src/mdh/searchIndexDef.js`

```js
// Transform a listed Atlas Search index (snake_case, nested under
// latest_definition, plus runtime fields) into the flat, camelCase shape the
// Create Search Index modal parses and api.createSearchIndex sends. Runtime
// fields (type/status/queryable) and the latest_definition wrapper are dropped;
// null/absent optionals are omitted so the copied JSON stays clean.
export function toCreateSearchIndexDefinition(idx) {
  if (!idx || typeof idx !== 'object') return idx;
  const def = idx.latest_definition || {};
  const out = { indexName: idx.name };
  if (def.mappings != null) out.mappings = def.mappings;
  if (def.analyzer != null) out.analyzer = def.analyzer;
  if (def.analyzers != null) out.analyzers = def.analyzers;
  if (def.search_analyzer != null) out.searchAnalyzer = def.search_analyzer;
  if (def.synonyms != null) out.synonyms = def.synonyms;
  return out;
}
```

- Maps **only** the six documented create fields; unknown keys are intentionally
  dropped (they are not part of the create contract).
- snake→camel only where the contract differs (`search_analyzer` →
  `searchAnalyzer`). `mappings`/`analyzer`/`analyzers`/`synonyms` are identical
  words in both shapes.
- Verified sample → clean output:
  `{ "indexName": "default", "mappings": { "dynamic": false, "fields": { "NAME": { "type": "string" } } } }`

### 2. `SearchIndexPanel.jsx`

- Import `toCreateSearchIndexDefinition`.
- In the index `.map`, compute badges from the **raw** `idx` (unchanged), then
  pass `definition={isObj ? toCreateSearchIndexDefinition(idx) : null}` to
  `IndexCard`. This single change makes both the card-body JSON view and the
  Copy button emit the clean, create-ready shape.
- **Surface `queryable` in the UI** (runtime field removed from JSON): add a
  badge **only when `queryable === false`** — a warning-style "not queryable"
  indicator. When `true`, the existing `READY` status badge already conveys it,
  so no always-on badge (avoids noise). Existing `status` and `type` badges are
  unchanged.

### 3. `IndexCard.jsx` — unchanged

It already renders + copies whatever `definition` prop it receives. Handing it
the clean shape is sufficient. (It is shared with the regular `IndexPanel`,
which keeps passing raw regular-index definitions — unaffected.)

### 4. Create modal — unchanged

It already parses exactly the shape `toCreateSearchIndexDefinition` emits, so
**copy → open Create → paste → Create** works verbatim.

## Result / acceptance

- Copy on a search index → clipboard holds clean `{ indexName, mappings, … }`.
- Paste into the Create modal → no manual editing required; Create succeeds
  (modulo the name, which the user changes if they don't want a collision).
- Card body displays the same clean definition; runtime state lives in badges
  (`status`, `type`, and `queryable` when false).

## Out of scope / known limitation

`type: "vectorSearch"` indexes use a different definition shape (vector `fields`
specs, no `mappings`) that the Create modal's body does not support. The
transform degrades gracefully (emits `indexName` plus any of the six known
fields that exist) but no vector-specific logic is built on the unverified
vector list shape. Treated as a known limitation, consistent with the project's
"correctness over guessing" rule.

## Testing

- **`tests/mdh-search-index-def.test.js`** (new, pure unit tests, no rendering —
  matches the `bulkOps.js` testing pattern):
  - verified real sample → `{ indexName, mappings }`, no `latest_definition`,
    no `type`/`status`/`queryable`, no null optionals.
  - all optionals present (non-null `analyzer`/`analyzers`/`search_analyzer`/
    `synonyms`) → all lifted, `search_analyzer` renamed to `searchAnalyzer`.
  - `null` optionals omitted entirely.
  - missing `latest_definition` → `{ indexName }` only (no crash).
  - round-trip property: output keys ⊆ the six create fields the modal parses.
- Full suite (`npm test`) green; `npm run build` clean.
