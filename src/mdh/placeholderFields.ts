import JSON5 from 'json5';
import { VAR_RE } from './placeholderSyntax.js';

const CMP_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const ARRAY_OPS = new Set(['$in', '$nin']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

// A string that is a WHOLE placeholder with NO modifier → the variable name,
// else null. Modifier placeholders (split/re) force array/string types, so
// dataset typing never applies and they are skipped here.
function wholeNoModifierName(str: string): string | null {
  if (typeof str !== 'string') return null;
  const m = VAR_RE.exec(str);
  if (!m || m[2]) return null; // m[2] = modifier present → skip
  return m[1];
}

// Record name→{field, collection}, marking ambiguous if the name already mapped
// to a DIFFERENT (field, collection) pair. `collection` is null (active) or a
// non-empty raw string (possibly containing {var} placeholders).
function record(
  out: Record<string, any>,
  name: string,
  field: string,
  collection: string | null,
  op: string | null,
): void {
  const prev = out[name];
  if (prev === undefined) {
    out[name] = { field, collection, op };
    return;
  }
  if (prev.ambiguous) return;
  if (prev.field !== field || (prev.collection || null) !== (collection || null)) {
    out[name] = { ambiguous: true };
  }
}

// "$field" → "field"; anything else (incl. placeholders, which never start with $) → null.
function exprFieldPath(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('$') ? v.slice(1) : null;
}

function walkExpr(node: any, out: Record<string, any>, collection: string | null): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) walkExpr(el, out, collection);
    return;
  }
  for (const [op, val] of Object.entries(node)) {
    if (CMP_OPS.has(op) && Array.isArray(val) && val.length === 2) {
      const field = exprFieldPath(val[0]) || exprFieldPath(val[1]);
      const name = wholeNoModifierName(val[0]) || wholeNoModifierName(val[1]);
      if (field && name) record(out, name, field, collection, op);
    } else if (op === '$and' || op === '$or' || op === '$not') {
      walkExpr(val, out, collection);
    }
  }
}

function resolveFieldValue(
  field: string,
  val: any,
  out: Record<string, any>,
  collection: string | null,
): void {
  const direct = wholeNoModifierName(val);
  if (direct) {
    record(out, direct, field, collection, '$eq');
    return;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const [op, opVal] of Object.entries(val)) {
      if (CMP_OPS.has(op)) {
        const n = wholeNoModifierName(opVal as string);
        if (n) record(out, n, field, collection, op);
      } else if (ARRAY_OPS.has(op) && Array.isArray(opVal)) {
        for (const el of opVal) {
          const n = wholeNoModifierName(el);
          if (n) record(out, n, field, collection, op);
        }
      }
    }
  }
}

function walkQuery(node: any, out: Record<string, any>, collection: string | null): void {
  if (Array.isArray(node)) {
    for (const el of node) walkQuery(el, out, collection);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (key === '$expr') {
      walkExpr(val, out, collection);
      continue;
    }
    if (LOGICAL_OPS.has(key)) {
      if (Array.isArray(val)) for (const sub of val) walkQuery(sub, out, collection);
      continue;
    }
    if (key === '$not') {
      walkQuery(val, out, collection);
      continue;
    }
    if (key.startsWith('$')) continue; // other operators: ignore
    resolveFieldValue(key, val, out, collection); // key is a field path (incl. dotted)
  }
}

// Walk a pipeline's stages under a collection context. $match compares against
// `collection`; $unionWith/$lookup recurse with their target collection; $facet
// stays on the same collection. Sub-pipelines with an unknown collection are
// skipped (their fields can't be typed) rather than mis-attributed to `collection`.
function walkPipeline(stages: any[], out: Record<string, any>, collection: string | null): void {
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object') continue;
    if (stage.$match) walkQuery(stage.$match, out, collection);
    if (stage.$unionWith && typeof stage.$unionWith === 'object') {
      const uw = stage.$unionWith;
      const coll = typeof uw.coll === 'string' && uw.coll ? uw.coll : null;
      if (coll && Array.isArray(uw.pipeline)) walkPipeline(uw.pipeline, out, coll);
    }
    if (stage.$lookup && typeof stage.$lookup === 'object') {
      const from =
        typeof stage.$lookup.from === 'string' && stage.$lookup.from ? stage.$lookup.from : null;
      if (from && Array.isArray(stage.$lookup.pipeline))
        walkPipeline(stage.$lookup.pipeline, out, from);
    }
    if (stage.$facet && typeof stage.$facet === 'object') {
      for (const sub of Object.values(stage.$facet)) walkPipeline(sub as any[], out, collection);
    }
  }
}

// Map each WHOLE no-modifier placeholder name to the field + collection it is
// compared against, or { ambiguous: true } when one name targets two different
// (field, collection) pairs. Returns {} on parse failure.
// name -> the field + collection it is compared against, or { ambiguous: true } when one name
// targets two different (field, collection) pairs.
export type FieldMapping = { field?: string; collection?: string | null; ambiguous?: boolean };

export function mapPlaceholdersToFields(text: string): Record<string, FieldMapping> {
  let parsed;
  try {
    parsed = JSON5.parse(text);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, FieldMapping> = {};
  walkPipeline(parsed, out, null); // null = active collection
  return out;
}
