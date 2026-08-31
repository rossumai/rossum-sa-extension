// Pure helpers for the regular Indexes panel: copy-paste parity, diagnostics,
// and byte formatting. No dependencies — unit-tested in isolation.

// Fields from a listed MongoDB index that are NOT create options: `key`/`name`
// are passed separately (as keys/indexName), and `v`/`ns`/`*IndexVersion` are
// output-only/server-set and would be rejected or ignored on create.
const OUTPUT_ONLY = new Set(['key', 'name', 'v', 'ns', 'textIndexVersion', '2dsphereIndexVersion']);

// Convert a listed index (standard MongoDB `listIndexes` shape — `{ v, key,
// name, ...options }`) into the flat shape the Create Index modal parses and
// api.createIndex sends: `{ indexName, keys, options? }`. Option siblings are
// gathered under `options`; `options` is omitted when empty so a plain index
// copies clean. (Search indexes no longer need an equivalent: MDH V2 hands back a
// definition that is already valid input — see searchIndexDef.toSearchIndexDefinition.)
export function toCreateIndexDefinition(idx: any): Record<string, any> | null {
  if (!idx || typeof idx !== 'object') return idx;
  const options: Record<string, any> = {};
  for (const k of Object.keys(idx)) {
    if (!OUTPUT_ONLY.has(k)) options[k] = idx[k];
  }
  const out: Record<string, any> = { indexName: idx.name, keys: textCreateKeys(idx) ?? idx.key };
  if (Object.keys(options).length > 0) out.options = options;
  return out;
}

// A TEXT index's `key` is the internal `{ _fts: 'text', _ftsx: 1 }` — the real
// fields live in `weights`. Rebuild the create-spec key (`{ field: 'text' }`,
// preserving any non-text compound components and their order) so the copied
// definition actually recreates the index. Returns null for non-text indexes.
function textCreateKeys(idx: any): Record<string, any> | null {
  const key = idx.key;
  if (!key || typeof key !== 'object') return null;
  if (!('_fts' in key) && !('_ftsx' in key)) return null;
  if (!idx.weights || typeof idx.weights !== 'object') return null;
  const rebuilt: Record<string, any> = {};
  for (const [k, v] of Object.entries(key)) {
    if (k === '_ftsx') continue;
    if (k === '_fts') {
      for (const field of Object.keys(idx.weights)) rebuilt[field] = 'text';
    } else rebuilt[k] = v;
  }
  return rebuilt;
}

// Classify an index from its key spec. Returns one of
// single | compound | text | hashed | 2dsphere | 2d | wildcard, or null.
export function classifyIndexType(key: any): string | null {
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

// Option fields whose presence makes an index NOT safely redundant — dropping
// such an index could silently remove a constraint or change semantics.
const CONSTRAINTS = [
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
];

// Names of indexes that are conservatively redundant: a plain index (no
// constraint options, never `_id_`) whose key spec — field AND direction — is a
// strict prefix of another index's. A compound superset fully serves the prefix
// index's queries, so dropping the plain prefix loses nothing.
export function redundantIndexNames(indexes: any[]): Set<string> {
  const objs = (indexes || []).filter((i) => i && typeof i === 'object' && i.key);
  const sig = (i: any) => Object.entries(i.key).map(([k, v]) => `${k}:${v}`);
  const plain = (i: any) => CONSTRAINTS.every((c: string) => i[c] === undefined);
  // A superset only truly covers the prefix index's queries if it indexes the
  // same document set under the same collation and is visible to the planner.
  // partial/sparse index a strict subset of docs; collation restricts which
  // queries it serves; hidden indexes serve none. (A `unique` superset is fine
  // — uniqueness doesn't restrict read coverage.)
  const coversFully = (b: any) =>
    b.partialFilterExpression === undefined && !b.sparse && b.collation === undefined && !b.hidden;
  const out = new Set<string>();
  for (const a of objs) {
    if (a.name === '_id_' || !plain(a)) continue;
    const as = sig(a);
    const isPrefixOfCoveringSuperset = objs.some((b) => {
      if (b === a || !coversFully(b)) return false;
      const bs = sig(b);
      return bs.length > as.length && as.every((seg, i) => seg === bs[i]);
    });
    if (isPrefixOfCoveringSuperset) out.add(a.name);
  }
  return out;
}

// Human-readable byte size. '' for null/NaN/Infinity.
export function formatBytes(n?: number | null): string {
  if (n == null || !isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
