# MDH — Regular Indexes panel improvements

**Date:** 2026-06-10
**Status:** Approved (design), pending implementation
**Area:** Dataset Management (MDH) → Indexes panel (`IndexPanel.jsx`)

## Problem / goal

Three improvements to the regular Indexes view, all grounded in facts verified
live on a customer dev org (2026-06-10):

1. **Copy-paste parity** with the search-index fix: Copy must emit a clean,
   create-ready definition that pastes straight into the Create Index modal.
2. **Diagnostics badges**: index type + a conservative "redundant?" hint.
3. **Size display**: per-index on-disk size + collection totals.

### Verified facts

Regular index list (`/indexes/list` nameOnly=false) — standard MongoDB shape:
```json
{ "v": 2, "key": { "ALT1": 1 }, "name": "products_alt1_idx" }
```
Options (`unique`, `sparse`, `expireAfterSeconds`, `partialFilterExpression`,
`collation`, …) appear as flat siblings. The Create Index modal
(`IndexPanel.jsx` `handleCreate`) parses `{ indexName, keys, options }` and
requires `indexName` + `keys`; `createIndex(collection, indexName, keys, opts)`
sends them. So the listed object breaks paste: `name` (≠ `indexName`), `key`
singular (≠ `keys`), options not nested under `options`, internal `v`.

`$collStats: { storageStats: {} }` **works** and returns `count`, `size`,
`storageSize`, `totalIndexSize`, and `indexSizes` (per-regular-index bytes map).
`$indexStats` is **403/400 not-authorized** — so index usage / unused-index
detection is impossible and is out of scope. (See memory
`reference_datastorage_collstats_indexstats_perms`.)

## Design

### New pure module `src/mdh/indexDef.js` (unit-tested, no deps)

```js
const OUTPUT_ONLY = new Set(['key', 'name', 'v', 'ns', 'textIndexVersion', '2dsphereIndexVersion']);

export function toCreateIndexDefinition(idx) {
  if (!idx || typeof idx !== 'object') return idx;
  const options = {};
  for (const k of Object.keys(idx)) if (!OUTPUT_ONLY.has(k)) options[k] = idx[k];
  // TEXT indexes: listIndexes returns the internal key { _fts:'text', _ftsx:1 }
  // with real fields in `weights`. Rebuild keys as { field:'text' } (preserving
  // non-text compound components + order) so the copy actually recreates. Other
  // index types' listed `key` already equals the create spec.
  const out = { indexName: idx.name, keys: textCreateKeys(idx) ?? idx.key };
  if (Object.keys(options).length > 0) out.options = options;
  return out;
}

export function classifyIndexType(key) {
  if (!key || typeof key !== 'object') return null;
  const names = Object.keys(key);
  if (names.some((n) => n.includes('$**'))) return 'wildcard';
  const vals = names.map((n) => key[n]);
  if (vals.includes('text')) return 'text';
  if (vals.includes('2dsphere')) return '2dsphere';
  if (vals.includes('2d')) return '2d';
  if (vals.includes('hashed')) return 'hashed';
  return names.length > 1 ? 'compound' : 'single';
}

// Conservative: flag index A (not _id_, carrying NO constraint options) whose
// key spec (field AND direction) is a strict prefix of a FULL-COVERAGE superset.
// A is never flagged if it bears a constraint (unique/sparse/partial/TTL/
// collation). The superset must also fully cover A: NOT partial/sparse/hidden
// and NO collation (those index a subset of docs or serve a restricted query
// set). A `unique` superset is fine — uniqueness doesn't restrict read coverage.
const CONSTRAINTS = ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation'];
export function redundantIndexNames(indexes) {
  const objs = (indexes || []).filter((i) => i && typeof i === 'object' && i.key);
  const sig = (i) => Object.entries(i.key).map(([k, v]) => `${k}:${v}`);
  const plain = (i) => CONSTRAINTS.every((c) => i[c] === undefined);
  const coversFully = (b) => b.partialFilterExpression === undefined && !b.sparse
    && b.collation === undefined && !b.hidden;
  const out = new Set();
  for (const a of objs) {
    if (a.name === '_id_' || !plain(a)) continue;
    const as = sig(a);
    if (objs.some((b) => b !== a && coversFully(b) && sig(b).length > as.length && as.every((s, i) => s === sig(b)[i]))) {
      out.add(a.name);
    }
  }
  return out;
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

### `src/mdh/api.js` — new method

```js
export function collectionStats(collectionName, { signal } = {}) {
  return aggregate(collectionName, [
    { $collStats: { storageStats: {} } },
    { $project: { count: '$storageStats.count', size: '$storageStats.size',
      storageSize: '$storageStats.storageSize', totalIndexSize: '$storageStats.totalIndexSize',
      indexSizes: '$storageStats.indexSizes' } },
  ], { signal });
}
```

### `src/mdh/components/IndexPanel.jsx`

- **① parity:** `definition={isObj ? toCreateIndexDefinition(idx) : null}` → IndexCard
  (drives Copy + body). Existing default/unique/sparse/TTL badges unchanged.
- **③ type badge:** `const t = classifyIndexType(idx.key); if (t && t !== 'single') badges.push({ text: t })`.
  "single" omitted to keep cards lean.
- **③ redundant badge:** compute `redundantIndexNames(indexes)` once per render;
  if the set contains `name`, push `{ text: 'redundant?', cls: 'index-badge-warning' }`.
- **④ size:** load `api.collectionStats(collection)` best-effort (cached under
  field `collStats`, silent on failure). Per-card meta = `formatBytes(stats.indexSizes[name])`.
  Toolbar shows `${count.toLocaleString()} docs · ${formatBytes(totalIndexSize)}`
  when stats present.

### `src/mdh/components/IndexCard.jsx`

Add one optional `meta` prop — muted text rendered in the header between the
summary and the actions. Search panel omits it (unaffected).

### `src/console/console.css`

Add `.index-card-meta` (small, muted, nowrap). Reuse existing badge styles:
type badge = default `.index-badge`; redundant = `.index-badge-warning`.

## Out of scope

- Index usage / unused-index detection (`$indexStats` not authorized — verified).
- At-a-glance key summary (declined), partial/collation/hidden flag badges (declined).
- Search-index sizes (`$collStats.indexSizes` covers regular indexes only).

## Testing

- `tests/mdh-index-def.test.js` (pure): `toCreateIndexDefinition` (verified
  sample → `{indexName, keys}`; unique → `options:{unique:true}`; drops
  v/ns/version fields; **text index → keys rebuilt from weights as
  `{field:'text'}`, incl. compound**; non-object passthrough), `classifyIndexType`
  (single/compound/text/hashed/2dsphere/wildcard), `redundantIndexNames` (plain
  prefix flagged; `_id_` never; constraint-bearing prefix NOT flagged; direction
  mismatch not a prefix; **superset that is partial/sparse/collation/hidden does
  NOT flag the prefix; unique superset still does**), `formatBytes`.
- `tests/mdh-index-panel.test.js` (render): Copy emits `{indexName, keys, options}`;
  compound index shows a type badge, single does not; a redundant index shows
  the badge; per-index size meta appears from a mocked `collectionStats`; stats
  failure degrades silently (no error, no size).
- Full suite + `npm run build` green.
