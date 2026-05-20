import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { skip } from '../store.js';

const PLACEHOLDER_RE = /\{(\w+)\}/g;
// Same name set as PLACEHOLDER_RE, but separates `"{name}"` (user wants a
// string) from a bare `{name}` (user wants a literal value).
const PLACEHOLDER_RE_QUOTED = /"\{(\w+)\}"|\{(\w+)\}/g;

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
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      names.add(match[1]);
    }
    return [...names];
  }

  function substitutePlaceholders(text) {
    return text.replace(PLACEHOLDER_RE_QUOTED, (match, quotedName, bareName) => {
      const name = quotedName || bareName;
      if (!(name in placeholderValues.value)) return match;
      const val = placeholderValues.value[name];
      // `"{name}"` — user wants a string regardless of value content.
      if (quotedName) return JSON.stringify(String(val));
      // Bare `{name}` — try literal interpretation first.
      if (val === 'true' || val === 'false' || val === 'null') return val;
      if (isJson5NumberLiteral(val)) return val;
      // Otherwise it's a bare string. JSON-encode it so the result is valid
      // JSON5 — otherwise `{name: ABC}` reaches JSON5.parse, throws, and
      // useQuery silently drops the request.
      return JSON.stringify(val);
    });
  }

  function setPlaceholder(name, value) {
    placeholderValues.value = { ...placeholderValues.value, [name]: value };
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
    reset,
  };
}
