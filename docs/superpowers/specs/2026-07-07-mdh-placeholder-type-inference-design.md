# MDH placeholder type inference — faithful types across Provenance and the pipeline editor

- **Date:** 2026-07-07
- **Status:** Approved design, pre-implementation
- **Surfaces:** MDH Provenance panel (`src/popup/`), Dataset Management pipeline editor (`src/mdh/`), Console boot (`src/console/`)

## Problem

An MDH matching query that compares a numeric-looking ID placeholder against a
dataset field returns zero rows in the extension's Dataset Management ("MDH")
app, even though the live MDH hook matches correctly.

Concrete pattern (values genericised — do not embed real customer data):

- A whole-quoted placeholder `"{cust}"` is compared inside a `$unionWith`
  sub-pipeline: `{"cust": "{cust}"}`.
- The source schema field feeding `{cust}` is `type: "enum"` with
  `enum_value_type: "string"`, so **real MDH injects a string**.
- The dataset stores `cust` as a **string** (e.g. `"21199417"`).
- Real MDH: string-vs-string → match. Extension: injects a **number** → zero
  rows (MongoDB equality is type-strict; the empty result is silent).

Verified against a Data Storage replica: `{"cust": <number>}` → 0 matches;
`{"cust": "<same digits>"}` → matches. The full reported pipeline returns 0 rows
with the number injection and the expected row with the string injection. The
`$unionWith` / `$lookup` / `$expr` / `$regexMatch` operators all execute cleanly
— the sole cause is the injected **type**.

## Root cause (verified in code)

The extension has no access to the queue schema, so it approximates MDH's
schema-driven typing. For a whole-quoted no-modifier placeholder the injected
JSON type is decided in `renderWholeToken` (`src/mdh/hooks/usePipeline.js:102`)
from a `resolvedType` produced by `deriveResolvedType`
(`src/mdh/fieldTypes.js:53`). Priority today:

1. **Manual override** (`placeholderTypes` signal, `usePipeline.js:226`).
2. **Field-type detection** — `mapPlaceholdersToFields`
   (`src/mdh/placeholderFields.js:80`) finds the field the placeholder is
   compared against, then `resolveFieldTypes` (`fieldTypes.js:75`) samples that
   field's stored BSON type and folds it to a primitive.
3. **Value-based fallback** (`usePipeline.js:109`): `isJson5NumberLiteral(val)`
   → emit a bare number, else a quoted string.

The bug is that step 2 fails here, so step 3 fires and turns `"21199417"` into a
number:

- `mapPlaceholdersToFields` only walks **top-level `$match` stages**
  (`placeholderFields.js:85-88`); it does **not** descend into `$unionWith` /
  `$lookup` sub-pipelines, where the real `{"cust": "{cust}"}` comparison lives.
- The only top-level use of `{cust}` is `{"$eq": ["{cust}", ""]}`, whose other
  operand is a literal `""`, so no field is recorded (`placeholderFields.js:37-38`).

With no field mapping, `deriveResolvedType` returns `{type: undefined}` and the
value-based fallback injects a number.

Separately, the Provenance panel models MDH's substitution correctly for this
case already: `flattenContent` (`src/popup/mdh-provenance.js:256`) marks a field
`number` only when the annotation's `normalized_value` is finite
(`isNumberContent`, `:246`); an enum's `normalized_value` is null → treated as a
string. Its latent gap is a **number-enum** (`enum_value_type: "number"`), which
the heuristic would mistype as string.

## Goal

Make the extension's placeholder **type** resolution faithful to real MDH so a
numeric-looking ID typed as a string is injected as a string. Fix the reported
bug on both the surface that has schema context (Provenance) and the surface
where the query is actually run (the editor), including the flow that carries a
query from Provenance into a new editor tab.

### Non-goals

- No change to real MDH, the matching hook, or any stored data (client-side type
  inference only).
- No change to the value-based fallback **default** (numeric-looking → number)
  for genuinely unresolvable placeholders — preserved for backward compatibility.
- No unification of the two substituters (editor works on editor text
  char-by-char to preserve CodeMirror formatting; Provenance works on a parsed
  node tree). They correctly share only `reEscape`.

## Design

Three components, each on the surface that has the right information, plus a
shared precedence in the editor:

```
Component 1 (schema):  Provenance panel  → read queue schema → authoritative types
Component 2 (bridge):  Provenance "Open in new tab" → propagate types to the editor
Component 3 (sample):  Editor standalone → sample field types across $unionWith/$lookup
Editor precedence:     override / propagated  >  field-sample  >  value-based (number, badged)
```

### Component 1 — Provenance authoritative types (`src/popup/mdh-provenance.js`)

- Add `fetchQueueSchema(domain, token, queueId)` and a pure
  `buildSchemaTypes(schema) → { schema_id: 'number' | 'string' }`, where a field
  is `'number'` iff `type === 'number'` **or**
  (`type === 'enum'` && `enum_value_type === 'number'`). MDH substitution only
  distinguishes number-vs-string (`mdh-provenance.js:213`), so no boolean/null.
- Merge **schema-first over the existing `normalized_value` heuristic**: the
  schema type wins; fall back per-field to the `flattenContent` heuristic when
  the schema fetch fails (403/offline) or the field is absent from the schema.
- Fetch once per queue and cache (reuse the panel's existing caching approach).

**Backward compatibility:** purely additive. If the schema is unavailable the
merged map equals today's heuristic map, so behavior is byte-identical. Also
fixes the latent number-enum mistype in Provenance's own replay.

### Component 2 — Propagate types into the editor tab (`src/popup/` → `src/console/` → `src/mdh/`)

The consumer side already applies propagated types; only the producer and boot
wiring are missing.

1. `ConfigBlock.openQuery` (`src/popup/components/ConfigBlock.jsx:133`): build
   `variableTypes = { name: types[name] === 'number' ? 'number' : 'string' }` for
   each placeholder (explicit per name, from Component 1's merged map), and pass
   it as a 4th argument to `onOpenInDm`.
2. `MdhProvenancePanel` `onOpenInDm` (`src/popup/components/MdhProvenancePanel.jsx:315`):
   stage `pendingVariableTypes: variableTypes` alongside `pendingVariables`.
3. `src/console/boot.js:28`: read `entry.pendingVariableTypes` and pass it to
   `initMdh`.
4. `src/mdh/index.jsx:159`: add `placeholderTypes: pendingVariableTypes` to the
   `pendingPipelineLoad` object; update the shape comment in
   `src/mdh/store.js:40` to `{ collection, pipelineText, variables?, placeholderTypes? }`.
5. `src/mdh/components/DataPanel.jsx:158`: already does
   `pipeline.placeholderTypes.value = { ...external.placeholderTypes }` —
   **no change**.

**Result:** opening a query from Provenance seeds the editor's `placeholderTypes`
overrides, so the tab reproduces the Provenance replay exactly (types, not just
values, propagate). The user can switch any variable back to Auto. The
`openCollectionTab.js` / `lastPipeline.js` round-trip already preserves
`placeholderTypes` (`src/mdh/lastPipeline.js:19,37`) and is untouched.

**Note on explicit `'string'`:** propagating an explicit `'string'` (not just
omitting non-number entries) makes the type an authoritative override, so the
editor tab matches the Provenance panel even when field-sampling would guess
differently. This is intentional: the tab should reproduce what Provenance
showed.

### Component 3 — Editor collection-aware sampling (`src/mdh/`)

For the standalone case (query pasted directly, no Provenance context).

- `src/mdh/placeholderFields.js` — `mapPlaceholdersToFields` descends into
  `$unionWith` and `$lookup` sub-pipelines, tracking a collection context per
  level, and returns `{ name: { field, collection, op, ambiguous? } }`. It stays
  **pure and text-only**: `collection` is `null` for top-level (meaning "the
  active collection") or the **raw** `$unionWith.coll` / `$lookup.from` string
  (which may contain `{vars}`). For `$lookup`, placeholders inside the join
  `pipeline` map to the `from` collection.
- `src/mdh/hooks/usePipeline.js` — resolves that collection string against
  `placeholderValues` using the existing embedded substitution
  (`_{prefix}_material_match` → `_PROD_material_match`); an unfilled/missing
  collection variable yields no collection → value-based fallback. Re-keys the
  `fieldTypes` signal from `{ field → info }` to `{ collection → { field → info } }`
  so same-named fields across collections do not collide. `ensureFieldTypes`
  fetches per target collection (the `cache.js` layer is already
  collection-keyed).
- `src/mdh/fieldTypes.js` — `deriveResolvedType` keeps the same precedence; the
  field-type lookup uses the mapped collection. The value-based fallback is
  unchanged but tagged `source: 'value-guess'` so the Variables badge reads
  "guessed from value" and invites an override.
- Audit and update every consumer of the `fieldTypes` signal shape
  (`resolvedTypeForName`, `src/mdh/components/PlaceholderInputs.jsx`, and any
  debug view) for the new per-collection keying.

**Backward compatibility:** top-level `$match` resolution is unchanged; this only
**adds** resolution for previously-unresolved sub-pipeline fields. The only
intended behavior change is the fix (a numeric-string placeholder compared
against a string field in a `$unionWith` / `$lookup` target now injects a string
instead of a number).

## Editor type-resolution precedence (final)

1. `placeholderTypes` override — manual selection **or** types propagated from
   Provenance (Component 2). Wins.
2. Field-sampled type — collection-aware across the active collection,
   `$unionWith.coll`, and `$lookup.from` (Component 3), via the `$type` facet.
3. Value-based fallback — numeric-looking → bare number, with a visible
   "guessed from value" badge.

## Risks

- **Re-keying `fieldTypes` by collection** is the riskiest mechanical change;
  mitigated by auditing every consumer of the signal shape and by tests.
- A query relying (incorrectly) on the old number injection could change result;
  such queries were already returning wrong/empty results, so this is the fix,
  not a regression.

## Testing

TDD: write failing tests first; keep the current 1785 tests green. Tests are
`.test.js` rendering via `h(Component, null)` per repo convention.

- `placeholderFields.test.js`: `$unionWith` / `$lookup` descent; collection
  tracking; raw variable collection names; cross-collection ambiguity; nested
  `$unionWith`; top-level `$match` unchanged; the `$expr`-vs-literal case.
- `fieldTypes.test.js`: per-collection keying; `deriveResolvedType` with a mapped
  collection; override precedence; `value-guess` source; `buildSchemaTypes`
  (number / enum-number / enum-string / string / date).
- `usePipeline.test.js`: the reported query pattern → the ID placeholder resolves
  to `string` → string injection → non-empty; a genuine number field still →
  number; collection-variable resolution for the `$unionWith` target; value-based
  fallback + badge source.
- `mdh-provenance.test.js`: schema-first precedence; heuristic fallback on
  schema-fetch failure; `buildSchemaTypes` mapping.
- Propagation: producer builds `variableTypes`; boot → `initMdh` →
  `pendingPipelineLoad.placeholderTypes`; a test asserting `external.placeholderTypes`
  seeds the `placeholderTypes` signal in `DataPanel`.
- Regression + dogfood: full `npm test`, then `npm run build` and reload the
  extension to verify live: (a) the reported query returns the row in the editor;
  (b) Provenance → new tab carries types (numeric-string enum stays string);
  (c) a genuine number field still injects a number; (d) Provenance replay is
  unaffected when the schema request 403s.
