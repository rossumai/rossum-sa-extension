// Pure shape derivation + validation for the import wizard's shape guard.
// "Shape" = the set of deep (dotted) field paths in the existing records, plus
// the type(s) seen at each path. Arrays are a single leaf type ('array'); plain
// nested objects are walked; the EJSON wrappers {$oid}/{$date} are their own
// types. Validation checks for missing and extra fields, with types required to
// agree — except `null`, which is compatible in both directions (a field may
// legitimately be null on either side). A field in optionalPaths (present in
// only some existing records) is never "missing", since requiring it would
// reject a non-uniform collection against its own export (§2.4).

import { joinPath, splitPath } from './flatten.js';

export function typeOf(value: unknown): string {
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

function collectPaths(obj: any, prefix: string, out: Map<string, string>): Map<string, string> {
  for (const key of Object.keys(obj)) {
    if (!prefix && IGNORED.has(key)) continue;
    const path = prefix ? `${prefix}.${joinPath([key])}` : joinPath([key]);
    const t = typeOf(obj[key]);
    if (t === 'object') collectPaths(obj[key], path, out);
    else out.set(path, t);
  }
  return out;
}

export function deriveShape(docs: any[]): any {
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
  return { paths, optionalPaths };
}

// null is compatible with any type; a reference set containing 'null' accepts any incoming type.
function typeCompatible(refTypes: Set<string>, got: string): boolean {
  if (got === 'null') return true;
  if (refTypes.has('null')) return true;
  return refTypes.has(got);
}

// Whitespace pairing: a "missing" and an "unknown" path that are the same
// after per-segment trim differ only by leading/trailing whitespace — report
// them as one explicit finding instead of two opaque ones. trim() also strips
// NBSP/TAB/FEFF-class edge characters, not just U+0020.
function normalizePath(path: string): string {
  return joinPath(splitPath(path).map((s) => s.trim()));
}

export function validateAgainstShape(docs: any[], shape: any): any {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const unknownTypesRaw = new Map<string, string>(); // path -> last-seen file type, before whitespace pairing
  const typeMismatch = new Map(); // path -> {path, expected, got}
  let failedDocCount = 0;
  const refPaths = shape?.paths || new Map();
  const optional = new Set<string>(shape?.optionalPaths || []);
  const list = Array.isArray(docs) ? docs : [];

  for (const doc of list) {
    let bad = false;
    const dp = (doc && typeof doc === 'object') ? collectPaths(doc, '', new Map()) : new Map();
    for (const [path] of refPaths) {
      // A field only SOME existing records carry cannot be "missing" from a row —
      // requiring it made a non-uniform collection reject its own export (§2.4).
      if (!dp.has(path) && !optional.has(path)) { missing.add(path); bad = true; }
    }
    for (const [path, got] of dp) {
      if (!refPaths.has(path)) { unknown.add(path); unknownTypesRaw.set(path, got); bad = true; continue; }
      if (!typeCompatible(refPaths.get(path), got)) {
        if (!typeMismatch.has(path)) typeMismatch.set(path, { path, expected: [...refPaths.get(path)], got });
        bad = true;
      }
    }
    if (bad) failedDocCount++;
  }

  const whitespace: { expected: string; got: string }[] = [];
  const missingByNorm = new Map<string, string>();
  for (const m of missing) {
    const n = normalizePath(m);
    if (!missingByNorm.has(n)) missingByNorm.set(n, m);
  }
  for (const u of [...unknown]) {
    const m = missingByNorm.get(normalizePath(u));
    if (m !== undefined && m !== u) {
      whitespace.push({ expected: m, got: u });
      unknown.delete(u);
      missing.delete(m);
    }
  }
  // Presentation-layer types for the shape ledger (table): the collection's
  // type(s) for a missing path, the file's type for an unknown path. Computed
  // AFTER whitespace pairing so they line up 1:1 with the final missing/unknown
  // arrays. A multi-type reference set is joined with '/', matching how
  // typeMismatch.expected is already rendered.
  const missingTypes = new Map<string, string>();
  for (const m of missing) {
    const types = refPaths.get(m);
    missingTypes.set(m, types ? [...types].join('/') : '');
  }
  const unknownTypes = new Map<string, string>();
  for (const u of unknown) {
    if (unknownTypesRaw.has(u)) unknownTypes.set(u, unknownTypesRaw.get(u) as string);
  }

  return {
    ok: missing.size === 0 && unknown.size === 0 && typeMismatch.size === 0 && whitespace.length === 0,
    missing: [...missing],
    unknown: [...unknown],
    typeMismatch: [...typeMismatch.values()],
    whitespace,
    failedDocCount,
    missingTypes,
    unknownTypes,
  };
}
