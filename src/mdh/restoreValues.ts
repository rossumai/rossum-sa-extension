import { unflattenDoc, splitPath, encodeSegment, isEjsonWrapper } from './flatten.js';
import { inferValue } from './csv.js';

// Rebuild what a flat-format export flattened into text (spec §4.1).
//
// The ordering rule, and the reason it is not the obvious one: if a
// JSON-looking cell were parsed BEFORE consulting the target collection, a
// column the collection calls a string but which happens to hold JSON text
// would silently become an object — precisely the corruption the shape check
// exists to catch. So the collection's own sampled shape decides first,
// INCLUDING when it says "this is a string", and the heuristics only run where
// it has no opinion at all.

export type RestoreSummary = {
  nestedColumns: number; json: number; dates: number; oids: number;
  numbers: number; bools: number; arrays: number; dropped: number; nulled: number;
  warnings: string[];
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const OID_RE = /^[0-9a-fA-F]{24}$/;
const DROP = Symbol('drop');

const isPlainObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const childPath = (prefix: string, key: string) => (prefix ? `${prefix}.${encodeSegment(key)}` : encodeSegment(key));

// The collection's opinion about a path: a single non-null type, or none.
// A set with >1 real type is a genuinely mixed column — no opinion.
function soleType(types: Set<string> | undefined): string | null {
  if (!types) return null;
  const real = [...types].filter((t) => t !== 'null');
  return real.length === 1 ? (real[0] as string) : null;
}

function tryJson(s: string, kind: 'object' | 'array' | 'any'): any {
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  let v;
  try { v = JSON.parse(t); } catch { return undefined; }
  if (v === null || typeof v !== 'object') return undefined;
  if (kind === 'object' && Array.isArray(v)) return undefined;
  if (kind === 'array' && !Array.isArray(v)) return undefined;
  return v;
}

type Ctx = {
  paths: Map<string, Set<string>>;
  optional: Set<string>;
  inferTypes: boolean;
  hit: Record<string, Set<string>>;
};

function restoreNode(value: any, path: string, ctx: Ctx): any {
  // A plain sub-document is never a leaf — walk it so its own leaves get restored.
  if (isPlainObject(value) && !isEjsonWrapper(value)) {
    const out: any = {};
    for (const key of Object.keys(value)) {
      const r = restoreNode(value[key], childPath(path, key), ctx);
      if (r !== DROP) out[key] = r;
    }
    return out;
  }
  return restoreLeaf(value, path, ctx);
}

function restoreLeaf(value: any, path: string, ctx: Ctx): any {
  const types = ctx.paths.get(path);
  const want = soleType(types);

  // Empty cell. The export writes one both for an absent field and for a stored
  // null, so on an optional path dropping the key is the reading that does not
  // invent data (spec §4.3).
  if (value === '' || value === null) {
    if (types && ctx.optional.has(path)) { ctx.hit.dropped.add(path); return DROP; }
    if (types && value === '' && want && want !== 'string') { ctx.hit.nulled.add(path); return null; }
    return value;
  }

  if (want && typeof value === 'string') {
    if (want === 'string') return value;                       // the whole point
    // No `want === 'object'` branch: shape.ts#collectPaths recurses past every
    // plain sub-document and records only leaves, so no path in `shape.paths`
    // can ever carry the type 'object' — `soleType()` can never return it.
    // Object-shaped cells are already restored correctly by layer 2 below.
    // Revisit only if shape.ts is ever taught to record a leaf 'object' type.
    if (want === 'array') {
      const p = tryJson(value, 'array');
      if (p !== undefined) { ctx.hit.json.add(path); return p; }
      ctx.hit.arrays.add(path); return [value];                // XML's 1-element collapse
    }
    if (want === 'date' && ISO_RE.test(value)) { ctx.hit.dates.add(path); return { $date: value }; }
    if (want === 'objectId' && OID_RE.test(value)) { ctx.hit.oids.add(path); return { $oid: value }; }
    if (want === 'number') {
      const n = inferValue(value);
      if (typeof n === 'number') { ctx.hit.numbers.add(path); return n; }
    }
    if (want === 'bool' && (value === 'true' || value === 'false')) {
      ctx.hit.bools.add(path); return value === 'true';
    }
    return value;   // disagrees with the collection — leave it; the guard reports it
  }

  if (want === 'array' && !Array.isArray(value)) { ctx.hit.arrays.add(path); return [value]; }
  if (want) return value;

  // No opinion: structural JSON, then opted-in inference.
  if (typeof value === 'string') {
    const p = tryJson(value, 'any');
    if (p !== undefined) {
      ctx.hit.json.add(path);
      return Array.isArray(p) ? p : restoreNode(p, path, ctx);
    }
    if (ctx.inferTypes) {
      const v = inferValue(value);
      if (v !== value) {
        if (typeof v === 'number') ctx.hit.numbers.add(path); else ctx.hit.bools.add(path);
        return v;
      }
    }
  }
  return value;
}

export function restoreDocs(
  docs: any[], shape: any | null, { inferTypes = false }: { inferTypes?: boolean } = {},
): { docs: any[]; summary: RestoreSummary } {
  const ctx: Ctx = {
    paths: shape?.paths || new Map(),
    optional: new Set<string>(shape?.optionalPaths || []),
    inferTypes,
    hit: {
      nested: new Set(), json: new Set(), dates: new Set(), oids: new Set(),
      numbers: new Set(), bools: new Set(), arrays: new Set(),
      dropped: new Set(), nulled: new Set(),
    },
  };
  const conflicts = new Set<string>();
  const list = Array.isArray(docs) ? docs : [];

  const out = list.map((d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
    for (const rawKey of Object.keys(d)) {
      if (splitPath(rawKey).length > 1) ctx.hit.nested.add(rawKey);
    }
    const { doc, conflicts: c } = unflattenDoc(d);
    for (const k of c) conflicts.add(k);
    return restoreNode(doc, '', ctx);
  });

  const warnings: string[] = [];
  if (conflicts.size > 0) {
    warnings.push(`${conflicts.size} column(s) could not be nested because a conflicting field exists: ${[...conflicts].slice(0, 5).join(', ')}.`);
  }

  return {
    docs: out,
    summary: {
      nestedColumns: ctx.hit.nested.size, json: ctx.hit.json.size,
      dates: ctx.hit.dates.size, oids: ctx.hit.oids.size,
      numbers: ctx.hit.numbers.size, bools: ctx.hit.bools.size,
      arrays: ctx.hit.arrays.size, dropped: ctx.hit.dropped.size,
      nulled: ctx.hit.nulled.size, warnings,
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One sentence naming what changed, or null when nothing did — a clean import
// stays silent, the same silent-pass/loud-fail rule the shape check follows.
export function formatRestoreSummary(
  summary: RestoreSummary, { hasShape, shapeError = false }: { hasShape: boolean; shapeError?: boolean },
): string | null {
  const parts: string[] = [];
  if (summary.nestedColumns) parts.push(plural(summary.nestedColumns, 'nested column'));
  if (summary.json) parts.push(plural(summary.json, 'JSON value'));
  if (summary.arrays) parts.push(plural(summary.arrays, 'array'));
  if (summary.dates) parts.push(plural(summary.dates, 'date'));
  if (summary.oids) parts.push(plural(summary.oids, 'ObjectId'));
  if (summary.numbers) parts.push(plural(summary.numbers, 'number'));
  if (summary.bools) parts.push(plural(summary.bools, 'boolean'));
  if (summary.dropped) parts.push(`${plural(summary.dropped, 'empty field')} dropped`);
  if (summary.nulled) parts.push(`${plural(summary.nulled, 'empty field')} set to null`);
  if (parts.length === 0) return null;

  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  if (hasShape) return `Restored ${list} to match the collection.`;
  if (shapeError) return `Restored ${list} · couldn’t read the collection’s types, so values were left as text.`;
  return `Restored ${list} · collection is empty, so value types were left as text.`;
}
