// Per-field diff between an update expression and a document, for the
// `{ $set, $unset }` shape (either alone or together). Returns:
//   { fieldName: { from, to } }              for $set entries
//   { fieldName: { from, removed: true } }   for $unset entries
//
// Returns null for any other update shape ($inc, $push, $rename, …) — those
// would require reimplementing chunks of the MongoDB update engine to predict
// the result, so we don't try and the caller falls back to rendering the doc
// as-is with an opaque "will apply update expression" badge.
export function trivialSetDiff(updateExpr: any, doc: any): Record<string, any> | null {
  if (!updateExpr || typeof updateExpr !== 'object' || Array.isArray(updateExpr)) return null;
  const keys = Object.keys(updateExpr);
  if (keys.length === 0) return null;
  const allowed = new Set(['$set', '$unset']);
  if (!keys.every((k) => allowed.has(k))) return null;

  const setObj = updateExpr.$set;
  const unsetObj = updateExpr.$unset;
  const isPlainObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  if (setObj !== undefined && !isPlainObj(setObj)) return null;
  if (unsetObj !== undefined && !isPlainObj(unsetObj)) return null;

  const out: Record<string, any> = {};
  if (setObj) {
    for (const k of Object.keys(setObj)) {
      out[k] = { from: doc?.[k], to: setObj[k] };
    }
  }
  if (unsetObj) {
    for (const k of Object.keys(unsetObj)) {
      out[k] = { from: doc?.[k], removed: true };
    }
  }
  return out;
}

// Drops top-level operator keys (those starting with `$`) whose value is an
// empty object literal `{}`. Used at submit time so that prefilled-but-untouched
// blocks like `$unset: {}` aren't sent to MongoDB, which rejects empty operator
// updates with `'$unset' is empty`.
//
// Only `$`-prefixed keys are stripped — non-operator fields (e.g. a replaceOne
// document with a legitimately empty object value) pass through unchanged.
export function stripEmptyOperators(expr: any): any {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return expr;
  const out: Record<string, any> = {};
  for (const key of Object.keys(expr)) {
    const val = expr[key];
    const isEmptyOperator = key.startsWith('$')
      && val
      && typeof val === 'object'
      && !Array.isArray(val)
      && Object.keys(val).length === 0;
    if (!isEmptyOperator) out[key] = val;
  }
  return out;
}
