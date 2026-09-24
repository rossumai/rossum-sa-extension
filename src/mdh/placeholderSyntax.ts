// Placeholder variable grammar, shared by the substituter (hooks/usePipeline.js)
// and the field-mapping analysis (placeholderFields.js). A variable is a quoted
// "{name}" or "{name | modifier(arg)}". VAR_RE matches a WHOLE string; VAR_RE_G
// finds EMBEDDED occurrences inside a larger string. Kept in one module so the
// two consumers can't drift.
export const VAR_RE =
  /^\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}$/;
export const VAR_RE_G =
  /\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}/g;

// The lookup-field grammar: "$$name", the syntax of a schema field whose
// ui_configuration.type is "lookup" (matching.configuration.variables). The name
// pattern is the Rossum dashboard's own. Live-probed against the lookup engine
// (internal/schemas/evaluate_formulas, 2026-09-24): only a string that is EXACTLY
// "$$name" is substituted, as a typed token, in $match, $expr and $search alike —
// "R$$v" and "zzzz $$v" are left literal. So there is no embedded form, and no
// modifiers.
export const LOOKUP_VAR_RE = /^\$\$([a-zA-Z_][a-zA-Z0-9_]*)$/;

// MongoDB's own system variables. "$$ROOT" is not a lookup variable, and the
// lookup engine leaves it alone.
const SYSTEM_VARS = new Set([
  'ROOT',
  'CURRENT',
  'REMOVE',
  'DESCEND',
  'PRUNE',
  'KEEP',
  'NOW',
  'CLUSTER_TIME',
  'SEARCH_META',
  'USER_ROLES',
]);

// A string that is exactly "$$name" for a non-system name → the name, else null.
export function lookupVarName(str: unknown): string | null {
  if (typeof str !== 'string') return null;
  const m = LOOKUP_VAR_RE.exec(str);
  return m && !SYSTEM_VARS.has(m[1]) ? m[1] : null;
}

// Names a pipeline binds for itself, so "$$this" inside a $filter is not a
// variable to fill in: $lookup.let and $let.vars keys, $map/$filter `as`
// (default `this`), and $reduce's implicit `this` and `value`.
export function boundVarNames(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const el of node) boundVarNames(el, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, any>;
  if (n.$lookup && n.$lookup.let && typeof n.$lookup.let === 'object')
    for (const k of Object.keys(n.$lookup.let)) out.add(k);
  if (n.$let && n.$let.vars && typeof n.$let.vars === 'object')
    for (const k of Object.keys(n.$let.vars)) out.add(k);
  for (const op of ['$map', '$filter']) {
    if (n[op] && typeof n[op] === 'object')
      out.add(typeof n[op].as === 'string' ? n[op].as : 'this');
  }
  if (n.$reduce) {
    out.add('this');
    out.add('value');
  }
  for (const v of Object.values(n)) boundVarNames(v, out);
  return out;
}
