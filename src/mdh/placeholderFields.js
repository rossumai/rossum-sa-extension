import JSON5 from 'json5';
import { VAR_RE } from './placeholderSyntax.js';

const CMP_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const ARRAY_OPS = new Set(['$in', '$nin']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

// A string that is a WHOLE placeholder with NO modifier → the variable name,
// else null. Modifier placeholders (split/re) force array/string types, so
// dataset typing never applies and they are skipped here.
function wholeNoModifierName(str) {
  if (typeof str !== 'string') return null;
  const m = VAR_RE.exec(str);
  if (!m || m[2]) return null; // m[2] = modifier present → skip
  return m[1];
}

// Record name→field, marking ambiguous if the name already mapped to a DIFFERENT field.
function record(out, name, field, op) {
  const prev = out[name];
  if (prev === undefined) { out[name] = { field, op }; return; }
  if (prev.ambiguous) return;
  if (prev.field !== field) out[name] = { ambiguous: true };
}

// "$field" → "field"; anything else (incl. placeholders, which never start with $) → null.
function exprFieldPath(v) {
  return (typeof v === 'string' && v.startsWith('$')) ? v.slice(1) : null;
}

function walkExpr(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const el of node) walkExpr(el, out); return; }
  for (const [op, val] of Object.entries(node)) {
    if (CMP_OPS.has(op) && Array.isArray(val) && val.length === 2) {
      const field = exprFieldPath(val[0]) || exprFieldPath(val[1]);
      const name = wholeNoModifierName(val[0]) || wholeNoModifierName(val[1]);
      if (field && name) record(out, name, field, op);
    } else if (op === '$and' || op === '$or' || op === '$not') {
      walkExpr(val, out);
    }
  }
}

// `{ field: <val> }`: <val> may be a WHOLE placeholder, or an operator object
// like { $eq: "{v}" } / { $in: [ "{v}" ] }.
function resolveFieldValue(field, val, out) {
  const direct = wholeNoModifierName(val);
  if (direct) { record(out, direct, field, '$eq'); return; }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const [op, opVal] of Object.entries(val)) {
      if (CMP_OPS.has(op)) {
        const n = wholeNoModifierName(opVal);
        if (n) record(out, n, field, op);
      } else if (ARRAY_OPS.has(op) && Array.isArray(opVal)) {
        for (const el of opVal) {
          const n = wholeNoModifierName(el);
          if (n) record(out, n, field, op);
        }
      }
    }
  }
}

function walkQuery(node, out) {
  if (Array.isArray(node)) { for (const el of node) walkQuery(el, out); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (key === '$expr') { walkExpr(val, out); continue; }
    if (LOGICAL_OPS.has(key)) { if (Array.isArray(val)) for (const sub of val) walkQuery(sub, out); continue; }
    if (key === '$not') { walkQuery(val, out); continue; }
    if (key.startsWith('$')) continue; // other operators: ignore
    resolveFieldValue(key, val, out); // key is a field path (incl. dotted)
  }
}

// Map each WHOLE no-modifier placeholder name to the field it is compared
// against, or { ambiguous: true } when one name targets two different fields.
// Names in non-comparison positions are absent. Returns {} on parse failure.
export function mapPlaceholdersToFields(text) {
  let parsed;
  try { parsed = JSON5.parse(text); } catch { return {}; }
  if (!Array.isArray(parsed)) return {};
  const out = {};
  for (const stage of parsed) {
    if (stage && typeof stage === 'object' && stage.$match) walkQuery(stage.$match, out);
  }
  return out;
}
