import { useRef } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import JSON5 from 'json5';
import { skip, selectedCollection } from '../store.js';
import { VAR_RE, VAR_RE_G } from '../placeholderSyntax.js';
import { reEscape } from '../reEscape.js';
import { mapPlaceholdersToFields } from '../placeholderFields.js';
import { resolveFieldTypes, deriveResolvedType } from '../fieldTypes.js';

// Scan for variables. A variable lives inside a JSON string literal, in one of
// two forms — mirroring MDH's server-side substitution (see
// src/popup/mdh-provenance.js, the canonical model of the service):
//   • WHOLE — the string is *exactly* the placeholder, e.g. "{name}" or
//     "{name | split(',')}". Substituted as a typed JSON token: a number / bool /
//     null when the value looks like one (quotes dropped), an array for `split`,
//     otherwise a quoted string.
//   • EMBEDDED — the placeholder is *part* of a larger string, e.g.
//     "BLUE WIDGET {part_no} LARGE" or "{a}/{b}". Each occurrence is replaced
//     in-place by its (string) value, JSON-escaped to stay inside the quotes.
// A bare unquoted {name} (outside any string literal) is NOT a variable — it
// isn't valid JSON, so it never reaches substitution. Returns
// [{ whole, name, modifier, arg, start, end }] in document order; for WHOLE the
// span covers the surrounding quotes, for EMBEDDED only the `{...}` itself.
// One placeholder occurrence found in the editor text.
type Placeholder = {
  whole: boolean; name: string; modifier: string | null; arg: string | null;
  start: number; end: number;
};

function scanPlaceholders(text: string): Placeholder[] {
  const out: Placeholder[] = [];
  const n = text.length;
  let i = 0;
  let inString = false;
  let strStart = -1;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; } // skip the escaped char
      if (c === '"') {
        const inner = text.slice(strStart + 1, i);
        const exact = VAR_RE.exec(inner);
        if (exact) {
          out.push({ whole: true, name: exact[1], modifier: exact[2] || null, arg: exact[3] != null ? exact[3] : null, start: strStart, end: i + 1 });
        } else {
          // Embedded: each `{...}` within the larger string. m.index is relative
          // to `inner`, so offset by strStart + 1 to map back into `text`.
          for (const m of inner.matchAll(VAR_RE_G)) {
            const off = strStart + 1 + m.index;
            out.push({ whole: false, name: m[1], modifier: m[2] || null, arg: m[3] != null ? m[3] : null, start: off, end: off + m[0].length });
          }
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; strStart = i; }
    i += 1;
  }
  return out;
}

// JSON5's number grammar: an optional sign, then either a leading-digit form
// (`0`, or `1-9` followed by more digits) with optional fractional/exponent
// parts, or a leading-decimal form (`.5`). Rejects "007", "5,000", " 5 ",
// and other shapes that Number() would happily coerce but JSON5.parse would
// not — emitting those as bare literals breaks every downstream consumer
// (the pipeline editor, the run-query path, and PipelineDebug).
//
// Big integers that exceed Number's 53-bit precision still match this regex
// and will silently lose precision when JSON5 parses them. That's a
// pre-existing footgun, not specific to Fill-from-Annotation — surface as a
// future fix; the immediate bug to fix is the parse-time crash on padded IDs.
const JSON5_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?$|^-?\.\d+(?:[eE][+-]?\d+)?$/;

export function isJson5NumberLiteral(val: unknown): boolean {
  return typeof val === 'string' && val !== '' && JSON5_NUMBER_RE.test(val);
}

// Placeholder modifiers, mirroring MDH's server-side substitution as modeled in
// src/popup/mdh-provenance.js. `split(sep)` turns the value into an array of
// strings; `re` regex-escapes it with Python re.escape parity (see
// reEscape.js); no/unknown modifier → the raw string value.
// Single-quoted or bare args are supported (the common convention, e.g.
// `split(',')`); since the value is read from the editor text, a double-quoted
// arg would arrive JSON-escaped — a rare shape left unhandled.
function unquoteArg(raw: string | null | undefined): string {
  if (raw == null) return '';
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

function applyModifier(val: unknown, modifier: string | null | undefined, arg: string | null | undefined): string | string[] {
  if (modifier === 'split') return String(val).split(unquoteArg(arg));
  if (modifier === 're') return reEscape(val);
  return String(val); // no modifier or unknown → raw string
}

// WHOLE `"{name}"` → a JSON token replacing the value AND its surrounding quotes:
// type-aware (number / bool / null) when there's no modifier and the value looks
// like one, an array for `split`, otherwise a quoted string. (`"amount":
// "{amount}"` + 5 → `"amount": 5`; `"{x | split(',')}"` + "a,b" → `["a","b"]`.)
// When `resolvedType` is provided it overrides the value-based detection branch.
function renderWholeToken(val: any, modifier: string | null | undefined, arg: string | null | undefined, resolvedType?: string) {
  if (!modifier) {
    switch (resolvedType) {
      case 'string':  return JSON.stringify(String(val));
      case 'number':  return isJson5NumberLiteral(val) ? val : JSON.stringify(String(val));
      case 'boolean': return (val === 'true' || val === 'false') ? val : JSON.stringify(String(val));
      case 'null':    return 'null';
      default: // undefined → today's value-based branch order, byte-identical
        if (val === 'true' || val === 'false' || val === 'null') return val;
        if (isJson5NumberLiteral(val)) return val;
        return JSON.stringify(applyModifier(val, modifier, arg));
    }
  }
  return JSON.stringify(applyModifier(val, modifier, arg));
}

// EMBEDDED `{name}` → the value spliced INSIDE an existing string literal, so it
// is JSON-escaped (quotes / backslashes / control chars) but contributes no
// quotes of its own. Always a string — `"id-{x}"` + 5 → `"id-5"`, never a number
// (only a whole `"{name}"` is type-aware). A `split` array is JSON-stringified
// into the surrounding text, mirroring src/popup/mdh-provenance.js.
function renderEmbeddedFragment(val: unknown, modifier: string | null | undefined, arg: string | null | undefined) {
  const out = applyModifier(val, modifier, arg);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  return JSON.stringify(text).slice(1, -1);
}

// Default sort: _id descending. Stable ordering for pagination, newest-first
// when _id is an ObjectId, and always indexed (every collection has the `_id_` index).
// Held in sortState directly so the `_id` column shows its ↓ indicator by default,
// and so any user sort key is followed by _id as a deterministic tiebreaker.
function defaultSortState() {
  return { _id: -1 };
}

export function usePipeline() {
  const stateRef = useRef<{
    sortState: Signal<Record<string, number>>;
    filterState: Signal<Record<string, any>>;
    placeholderValues: Signal<Record<string, any>>;
    suppressSync: Signal<boolean>;
    placeholderTypes: Signal<Record<string, string | undefined>>;
    fieldTypes: Signal<Record<string, Record<string, any>>>;
  } | null>(null);
  if (!stateRef.current) {
    stateRef.current = {
      sortState: signal(defaultSortState()),
      filterState: signal({}),
      placeholderValues: signal({}),
      suppressSync: signal(false),
      placeholderTypes: signal({}),
      fieldTypes: signal({}),
    };
  }
  const { sortState, filterState, placeholderValues, suppressSync, placeholderTypes, fieldTypes } = stateRef.current!;

  // Substitute {var} placeholders inside a bare collection-name string (not JSON).
  // Unfilled vars → '' (collection won't resolve → value-based fallback).
  function substituteCollName(raw: unknown) {
    return String(raw).replace(VAR_RE_G, (_m: string, name: string) => {
      const v = placeholderValues.value[name];
      return v == null ? '' : String(v);
    });
  }
  // Resolve a fieldMap entry's collection: null → the active collection,
  // otherwise the (var-substituted) raw collection string. '' → null.
  function resolveCollectionName(rawColl: string | null | undefined) {
    if (rawColl == null) return selectedCollection.value || null;
    const resolved = substituteCollName(rawColl);
    return resolved || null;
  }
  // Look up loaded FieldTypeInfo for a resolved (collection, field): undefined
  // if the collection/field pair hasn't been sampled yet, null if sampled with
  // no usable data, else the info object.
  function lookupFieldTypeInfo(coll: string | null, field: string | undefined) {
    if (!coll) return undefined;
    const collMap = fieldTypes.value[coll];
    return collMap ? collMap[field as string] : undefined;
  }

  function buildPipelineFromUI() {
    const pipeline: any[] = [];
    const filters = filterState.value;
    const match = Object.keys(filters).length > 0 ? { ...filters } : {};
    pipeline.push({ $match: match });
    const sorts = sortState.value;
    if (Object.keys(sorts).length > 0) {
      pipeline.push({ $sort: { ...sorts } });
    }
    pipeline.push({ $skip: skip.value });
    return pipeline;
  }

  function toggleSort(field: string) {
    const current = { ...sortState.value };
    if (!(field in current)) {
      // New sort key: insert at the front so the user's click becomes the
      // primary sort, with any existing keys (like the default _id:-1)
      // trailing as tiebreakers.
      sortState.value = { [field]: 1, ...current };
    } else if (current[field] === 1) {
      current[field] = -1;
      sortState.value = current;
    } else {
      delete current[field];
      sortState.value = current;
    }
    skip.value = 0;
  }

  function toggleFilter(field: string, value: unknown) {
    const current = { ...filterState.value };
    if (field in current) delete current[field];
    else current[field] = value;
    filterState.value = current;
    skip.value = 0;
  }

  function isFiltered(field: string) {
    return field in filterState.value;
  }

  function sortIndicator(field: string) {
    const s = sortState.value[field];
    if (s === 1) return ' \u2191';
    if (s === -1) return ' \u2193';
    return '';
  }

  function extractPlaceholders(text: string): string[] {
    const names = new Set<string>();
    for (const m of scanPlaceholders(text)) names.add(m.name);
    return [...names];
  }

  function substitutePlaceholders(text: string, resolvedTypes: Record<string, string> = {}) {
    const matches = scanPlaceholders(text);
    if (matches.length === 0) return text;
    let result = '';
    let last = 0;
    for (const m of matches) {
      result += text.slice(last, m.start);
      const val = m.name in placeholderValues.value ? placeholderValues.value[m.name] : '';
      result += m.whole ? renderWholeToken(val, m.modifier, m.arg, resolvedTypes[m.name])
        : renderEmbeddedFragment(val, m.modifier, m.arg);
      last = m.end;
    }
    result += text.slice(last);
    return result;
  }

  function setPlaceholder(name: string, value: unknown) {
    placeholderValues.value = { ...placeholderValues.value, [name]: value };
  }

  function setPlaceholderType(name: string, type: string | undefined) {
    const next = { ...placeholderTypes.value };
    if (!type || type === 'auto') delete next[name];
    else next[name] = type;
    placeholderTypes.value = next;
  }

  // Build { name → primitive type } for the current editor text from the field
  // mapping, resolved field types, and user overrides. Only `.type` is kept
  // (undefined types are omitted → value-based for those names).
  function buildResolvedTypes(text: string) {
    const fieldMap = mapPlaceholdersToFields(text);
    const pt = placeholderTypes.value;
    const out: Record<string, string> = {};
    for (const name of extractPlaceholders(text)) {
      const m = fieldMap[name];
      let fieldTypeInfo;
      if (m && !m.ambiguous) fieldTypeInfo = lookupFieldTypeInfo(resolveCollectionName(m.collection), m.field);
      const d = deriveResolvedType(name, { override: pt[name], fieldMap, fieldTypeInfo, parsedOk: true });
      if (d.type) out[name] = d.type;
    }
    return out;
  }

  function substituteWithTypes(text: string) {
    return substitutePlaceholders(text, buildResolvedTypes(text));
  }

  function computeEditorStateWithTypes(text: string) {
    return computeEditorState(text, buildResolvedTypes(text));
  }

  // Unique (collection, field) pairs referenced by the pipeline (skips
  // ambiguous names and names whose collection can't be resolved).
  function referencedFields(text: string) {
    const fm = mapPlaceholdersToFields(text);
    const pairs: { collection: string; field: string }[] = [];
    const seen = new Set<string>();
    for (const v of Object.values<any>(fm)) {
      if (!v || !v.field || v.ambiguous) continue;
      const coll = resolveCollectionName(v.collection);
      if (!coll) continue;
      const key = `${coll}::${v.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ collection: coll, field: v.field });
    }
    return pairs;
  }

  // Resolve any not-yet-known field types into the fieldTypes signal, grouped
  // per collection. `pairs` is referencedFields(...) output. Returns true if it
  // fetched something (so the caller can re-snapshot the debug view). `resolver`
  // is injectable for tests; defaults to the live resolveFieldTypes.
  async function ensureFieldTypes(
    pairs: { collection: string; field: string }[] | null | undefined,
    resolver = resolveFieldTypes,
  ) {
    if (!pairs || pairs.length === 0) return false;
    const byColl = new Map<string, string[]>();
    for (const { collection, field } of pairs) {
      const collMap = fieldTypes.value[collection] || {};
      if (field in collMap) continue;
      if (!byColl.has(collection)) byColl.set(collection, []);
      byColl.get(collection)!.push(field);
    }
    if (byColl.size === 0) return false;
    const next = { ...fieldTypes.value };
    for (const [coll, missing] of byColl) {
      const resolved = await resolver(coll, missing);
      next[coll] = { ...(next[coll] || {}), ...resolved };
    }
    fieldTypes.value = next;
    return true;
  }

  // Resolved type info for one variable's UI, given the current fieldMap and
  // whether the pipeline parsed (both come from the editor snapshot). `type` is
  // the effective type (override wins); `autoType` is what Auto WOULD resolve to
  // ignoring any manual override, so the "Auto (X)" label stays truthful.
  function resolvedTypeForName(name: string, fieldMap: any, parsedOk: boolean) {
    const override = placeholderTypes.value[name];
    const m = fieldMap[name];
    let fieldTypeInfo;
    if (m && !m.ambiguous) fieldTypeInfo = lookupFieldTypeInfo(resolveCollectionName(m.collection), m.field);
    const effective = deriveResolvedType(name, { override, fieldMap, fieldTypeInfo, parsedOk });
    const auto = override
      ? deriveResolvedType(name, { override: undefined, fieldMap, fieldTypeInfo, parsedOk })
      : effective;
    return { ...effective, autoType: auto.type };
  }

  // Snapshot the editor text for the UI that depends on it: the variable names
  // (Variables inputs) and the parsed pipeline (Pipeline Debug). Unfilled
  // variables substitute to an empty string, so the pipeline still parses and
  // the debug still renders before the user fills anything in.
  function computeEditorState(text: string, resolvedTypes: Record<string, string> = {}) {
    const placeholders = extractPlaceholders(text);
    const substituted = substitutePlaceholders(text, resolvedTypes);
    let parsed: any[] | null = null;
    try {
      const p = JSON5.parse(substituted);
      if (Array.isArray(p)) parsed = p;
    } catch { /* invalid JSON5 — leave parsed null */ }
    const fieldMap = mapPlaceholdersToFields(text);
    return { placeholders, parsed, fieldMap };
  }

  function reset() {
    sortState.value = defaultSortState();
    filterState.value = {};
    placeholderValues.value = {};
    skip.value = 0;
    placeholderTypes.value = {};
    fieldTypes.value = {};
  }

  return {
    sortState,
    filterState,
    placeholderValues,
    suppressSync,
    buildPipelineFromUI,
    toggleSort,
    toggleFilter,
    isFiltered,
    sortIndicator,
    extractPlaceholders,
    substitutePlaceholders,
    setPlaceholder,
    computeEditorState,
    reset,
    placeholderTypes,
    fieldTypes,
    setPlaceholderType,
    substituteWithTypes,
    computeEditorStateWithTypes,
    referencedFields,
    ensureFieldTypes,
    resolvedTypeForName,
  };
}
