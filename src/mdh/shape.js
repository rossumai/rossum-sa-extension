// Pure shape derivation + validation for the import wizard's shape guard.
// "Shape" = the set of deep (dotted) field paths in the existing records, plus
// the type(s) seen at each path. Arrays are a single leaf type ('array'); plain
// nested objects are walked; the EJSON wrappers {$oid}/{$date} are their own
// types. Validation is an EXACT field-set match per document (no missing, no
// extra), with types required to agree — except `null`, which is compatible in
// both directions (a field may legitimately be null on either side).

export function typeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$oid') return 'objectId';
    if (keys.length === 1 && keys[0] === '$date') return 'date';
    return 'object';
  }
  return 'string';
}

// Collect { path -> type } for one document. Walks plain objects into dotted
// paths; arrays and EJSON wrappers are leaves. `_id` and MDH's `__digest_md5`
// are ignored (server-owned, not part of the user's data shape).
const IGNORED = new Set(['_id', '__digest_md5']);

function collectPaths(obj, prefix, out) {
  for (const key of Object.keys(obj)) {
    if (!prefix && IGNORED.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const t = typeOf(obj[key]);
    if (t === 'object') collectPaths(obj[key], path, out);
    else out.set(path, t);
  }
  return out;
}

export function deriveShape(docs) {
  const paths = new Map();           // path -> Set<type>
  const presence = new Map();        // path -> count of docs containing it
  const list = Array.isArray(docs) ? docs : [];
  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue;
    const dp = collectPaths(doc, '', new Map());
    for (const [path, t] of dp) {
      if (!paths.has(path)) paths.set(path, new Set());
      paths.get(path).add(t);
      presence.set(path, (presence.get(path) || 0) + 1);
    }
  }
  const total = list.length;
  const optionalPaths = [...presence.entries()].filter(([, c]) => c < total).map(([p]) => p);
  // A field that is sometimes null (a nullable column) is still "uniform" for
  // warning purposes: null is type-compatible in both directions, so it never
  // causes over-rejection. Only a real clash of >1 NON-null type, or a field
  // missing from some docs (optional), makes the collection non-uniform.
  const uniform = optionalPaths.length === 0
    && [...paths.values()].every((s) => [...s].filter((t) => t !== 'null').length <= 1);
  return { paths, uniform, optionalPaths };
}

// null is compatible with any type; a reference set containing 'null' accepts any incoming type.
function typeCompatible(refTypes, got) {
  if (got === 'null') return true;
  if (refTypes.has('null')) return true;
  return refTypes.has(got);
}

export function validateAgainstShape(docs, shape) {
  const missing = new Set();
  const unknown = new Set();
  const typeMismatch = new Map(); // path -> {path, expected, got}
  let failedDocCount = 0;
  const refPaths = shape?.paths || new Map();
  const list = Array.isArray(docs) ? docs : [];

  for (const doc of list) {
    let bad = false;
    const dp = (doc && typeof doc === 'object') ? collectPaths(doc, '', new Map()) : new Map();
    for (const [path] of refPaths) {
      if (!dp.has(path)) { missing.add(path); bad = true; }
    }
    for (const [path, got] of dp) {
      if (!refPaths.has(path)) { unknown.add(path); bad = true; continue; }
      if (!typeCompatible(refPaths.get(path), got)) {
        if (!typeMismatch.has(path)) typeMismatch.set(path, { path, expected: [...refPaths.get(path)], got });
        bad = true;
      }
    }
    if (bad) failedDocCount++;
  }
  return {
    ok: missing.size === 0 && unknown.size === 0 && typeMismatch.size === 0,
    missing: [...missing],
    unknown: [...unknown],
    typeMismatch: [...typeMismatch.values()],
    failedDocCount,
  };
}
