import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import JSON5 from 'json5';
import { skip } from '../store.js';

// Scan for variables. A variable is ONLY a whole quoted value `"{name}"` — the
// syntax MDH supports. A `{...}` that is merely *part* of a larger string
// literal (e.g. a value like "GBL CS WLD FLG {A105N} CSF DC N/STK") is literal
// data, not a variable, and is left untouched. Returns [{ name, start, end }] in
// document order, where start/end span the surrounding quotes so substitution
// can replace the value-and-quotes (enabling type-aware replacement).
function scanPlaceholders(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let inString = false;
  let strStart = -1;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; } // skip the escaped char
      if (c === '"') {
        const m = /^\{(\w+)\}$/.exec(text.slice(strStart + 1, i));
        if (m) out.push({ name: m[1], start: strStart, end: i + 1 });
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

function isJson5NumberLiteral(val) {
  return typeof val === 'string' && val !== '' && JSON5_NUMBER_RE.test(val);
}

// Default sort: _id descending. Stable ordering for pagination, newest-first
// when _id is an ObjectId, and always indexed (every collection has the `_id_` index).
// Held in sortState directly so the `_id` column shows its ↓ indicator by default,
// and so any user sort key is followed by _id as a deterministic tiebreaker.
function defaultSortState() {
  return { _id: -1 };
}

export function usePipeline() {
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      sortState: signal(defaultSortState()),
      filterState: signal({}),
      placeholderValues: signal({}),
      suppressSync: signal(false),
    };
  }
  const { sortState, filterState, placeholderValues, suppressSync } = stateRef.current;

  function buildPipelineFromUI() {
    const pipeline = [];
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

  function toggleSort(field) {
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

  function toggleFilter(field, value) {
    const current = { ...filterState.value };
    if (field in current) delete current[field];
    else current[field] = value;
    filterState.value = current;
    skip.value = 0;
  }

  function isFiltered(field) {
    return field in filterState.value;
  }

  function sortIndicator(field) {
    const s = sortState.value[field];
    if (s === 1) return ' \u2191';
    if (s === -1) return ' \u2193';
    return '';
  }

  function extractPlaceholders(text) {
    const names = new Set();
    for (const m of scanPlaceholders(text)) names.add(m.name);
    return [...names];
  }

  function substitutePlaceholders(text) {
    const matches = scanPlaceholders(text);
    if (matches.length === 0) return text;
    let result = '';
    let last = 0;
    for (const m of matches) {
      result += text.slice(last, m.start);
      // An unfilled variable defaults to an empty string — a valid value, so the
      // query still runs ("even empty string is a valid variable value").
      const val = m.name in placeholderValues.value ? placeholderValues.value[m.name] : '';
      // Type-aware, mirroring MDH: a `"{name}"` becomes a JSON number / bool /
      // null when the value looks like one, otherwise a JSON string. The match
      // span includes the surrounding quotes, so a numeric value cleanly drops
      // the quotes (`"amount": "{amount}"` + 5 → `"amount": 5`).
      if (val === 'true' || val === 'false' || val === 'null') result += val;
      else if (isJson5NumberLiteral(val)) result += val;
      else result += JSON.stringify(val);
      last = m.end;
    }
    result += text.slice(last);
    return result;
  }

  function setPlaceholder(name, value) {
    placeholderValues.value = { ...placeholderValues.value, [name]: value };
  }

  // Snapshot the editor text for the UI that depends on it: the variable names
  // (Variables inputs) and the parsed pipeline (Pipeline Debug). Unfilled
  // variables substitute to an empty string, so the pipeline still parses and
  // the debug still renders before the user fills anything in.
  function computeEditorState(text) {
    const placeholders = extractPlaceholders(text);
    const substituted = substitutePlaceholders(text);
    let parsed = null;
    try {
      const p = JSON5.parse(substituted);
      if (Array.isArray(p)) parsed = p;
    } catch { /* invalid JSON5 — leave parsed null */ }
    return { placeholders, parsed };
  }

  function reset() {
    sortState.value = defaultSortState();
    filterState.value = {};
    placeholderValues.value = {};
    skip.value = 0;
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
  };
}
