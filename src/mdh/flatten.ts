import { getEjsonType } from './displayValue.js';

// The ONE home for MDH's dotted-path grammar (CLAUDE.md: "One home per
// grammar"). Export flattens a document to dotted columns, import rebuilds it,
// and shape.ts derives its reference paths — all three must agree byte for
// byte or a column silently loses its data, so they all come from here.
//
// Escaping: a MongoDB field may literally be named "a.b", which would be
// indistinguishable from a nested {a:{b:…}} in a bare dotted header. So a
// segment is encoded '\' -> '\\' then '.' -> '\.', and split on UNESCAPED dots
// only. For a key with neither character — every ordinary key — encoding is a
// no-op and headers are unchanged.

export function encodeSegment(key: string): string {
  return String(key).split('\\').join('\\\\').split('.').join('\\.');
}

export function decodeSegment(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '\\' && i + 1 < seg.length) {
      out += seg[i + 1];
      i += 1;
      continue;
    }
    out += seg[i];
  }
  return out;
}

export function joinPath(segments: string[]): string {
  return segments.map(encodeSegment).join('.');
}

export function splitPath(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  const s = String(path);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i += 1;
      continue;
    }
    if (c === '.') {
      out.push(decodeSegment(cur));
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(decodeSegment(cur));
  return out;
}

// A key the discovery aggregation can never descend into, so the flattener must
// not either — the two must produce the same header set.
//   '.'  — Mongo's "$a.b" addresses a NESTED b, not a key named "a.b".
//   '$'  — a field path for "$foo" is "$$foo", which Mongo reads as a VARIABLE.
export function isOpaqueKey(key: string): boolean {
  return key.includes('.') || key.startsWith('$');
}

// A value the wire represents as an EJSON wrapper ({$oid}, {$date}, {$binary}, …)
// is a LEAF: descending into it would invent paths like `field.$binary.base64`.
// Membership is decided by the repo's own EJSON table, NOT by the value's shape —
// $binary, $regex and $timestamp all carry OBJECT values and must still be leaves.
export function isEjsonWrapper(v: any): boolean {
  return getEjsonType(v) !== null;
}

const MAX_DEPTH = 5;

function isLeafValue(v: any, depth: number, maxDepth: number): boolean {
  return (
    v === null ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    isEjsonWrapper(v) ||
    Object.keys(v).length === 0 ||
    depth >= maxDepth
  );
}

// Document -> { encodedPath: leafValue }. Anything past the depth cap, plus any
// value under an opaque key, stays whole and is JSON-encoded by the caller's
// cell writer; the import's structural layer restores it, so the cap costs
// columns, never fidelity.
export function flattenDoc(
  doc: any,
  { maxDepth = MAX_DEPTH }: { maxDepth?: number } = {},
): Record<string, any> {
  const out: Record<string, any> = {};
  const walk = (obj: any, prefix: string[], depth: number) => {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      const path = [...prefix, key];
      if (!isOpaqueKey(key) && !isLeafValue(v, depth, maxDepth)) walk(v, path, depth + 1);
      else out[joinPath(path)] = v;
    }
  };
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) walk(doc, [], 1);
  return out;
}

const own = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The export's marker for "no value at this path on this row" — an absent
// occupant is indistinguishable from one that was never a real value. An
// empty cell must never CREATE structure, never DISPLACE a real value, and
// never be reported as a CONFLICT — it is not in conflict with anything, it
// is the absence of a value.
//
// Handling this as a special case inline, in the same pass as everything
// else, made the result depend on column order: an empty child processed
// BEFORE its filled parent would still build a spurious intermediate object
// to hold it, and the real scalar that followed then collided with that
// object and got reported (and dropped) as a genuine conflict — the exact
// false positive this whole handling exists to remove, just triggered by the
// opposite column order. So empty-valued keys run in a separate, LATER pass
// that only ever fills gaps nothing else has claimed; the result is the same
// regardless of which order the columns appear in.
const isEmptyCell = (v: any) => v === '' || v === null;

// { encodedPath: value } -> nested document, in two passes over the same key
// list so the outcome cannot depend on column order:
//
//   1. Every key whose value is NOT empty. Unchanged from the original
//      algorithm: creates intermediate objects as needed, and a collision
//      with an existing non-object is a genuine conflict (kept literal
//      instead of overwriting, and reported).
//   2. Every key whose value IS empty. Placed ONLY where entirely free —
//      never creates an intermediate object, never displaces an occupant.
//      Any segment already occupied by something incompatible (whether that
//      something was put there by pass 1 or is just plain absent, since an
//      empty value creates nothing to descend into) means the key is
//      skipped silently: not a conflict, not a literal key, just absent.
export function unflattenDoc(row: any): { doc: any; conflicts: string[] } {
  const doc: any = {};
  const conflicts: string[] = [];
  const keys = Object.keys(row || {});

  // Pass 1 — real values.
  for (const rawKey of keys) {
    const rawValue = row[rawKey];
    if (isEmptyCell(rawValue)) continue;
    const segs = splitPath(rawKey);
    let cur = doc;
    let blocked = false;
    let blockReasonIsNestedStructure = false;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i] as string;
      if (!own(cur, s)) {
        cur[s] = {};
      } else if (!isPlainObject(cur[s])) {
        blocked = true;
        break;
      }
      cur = cur[s];
    }
    const last = segs[segs.length - 1] as string;
    if (!blocked && own(cur, last) && isPlainObject(cur[last])) {
      blocked = true;
      blockReasonIsNestedStructure = true;
    }
    if (blocked) {
      conflicts.push(rawKey);
      // Only store as literal key if not overwriting a nested structure
      if (!blockReasonIsNestedStructure) {
        doc[rawKey] = rawValue;
      }
      continue;
    }
    cur[last] = rawValue;
  }

  // Pass 2 — empty cells. Fill gaps only; never create, never displace, never conflict.
  for (const rawKey of keys) {
    const rawValue = row[rawKey];
    if (!isEmptyCell(rawValue)) continue;
    const segs = splitPath(rawKey);
    let cur = doc;
    let free = true;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i] as string;
      if (!own(cur, s) || !isPlainObject(cur[s])) {
        free = false;
        break;
      }
      cur = cur[s];
    }
    const last = segs[segs.length - 1] as string;
    if (free && !own(cur, last)) cur[last] = rawValue;
  }

  return { doc, conflicts };
}

export function getByPath(doc: any, path: string): any {
  let cur = doc;
  for (const seg of splitPath(path)) {
    if (!isPlainObject(cur) || !own(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function hasByPath(doc: any, path: string): boolean {
  let cur = doc;
  for (const seg of splitPath(path)) {
    if (!isPlainObject(cur) || !own(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}
