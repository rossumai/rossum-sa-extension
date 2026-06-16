# Aggregate Pipeline Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the aggregate pipeline editor's flat, union autocomplete with a strict, context-aware completion system: comprehensive MongoDB operator catalogs, fuzzy matching, `$field` reference completion, and syntax-tree-driven context filtering.

**Architecture:** A new pure module `src/mdh/pipelineCompletions.js` owns the operator catalogs, a lezer-syntax-tree context classifier (`classifyContext`), and the CodeMirror completion-source factory (`makeCompletionSource`). For `mode === 'aggregate'` it returns only the operators valid at the cursor's position (stages in a pipeline array, query operators in `$match`, accumulators in `$group`, expression operators in computed values, `$field` refs in string values). All other editor modes keep today's behavior verbatim. `JsonEditor.jsx` calls the single factory and re-exports `extractFieldNames`.

**Tech Stack:** Preact, CodeMirror 6 (`@codemirror/language` `syntaxTree`/`ensureSyntaxTree`, `@codemirror/lang-javascript` JSON5/JS grammar, `@codemirror/autocomplete`), Vitest (jsdom env).

> **Commits:** Per the user's workflow, do NOT commit per-task. Each task ends with a verification checkpoint (`npm test` / `npm run build`). The user decides whether/when to commit at the end.

---

## File Structure

- **Create** `src/mdh/pipelineCompletions.js` — catalogs, `classifyContext`, source factory, `extractFieldNames`. One responsibility: everything the editor needs to produce completions.
- **Create** `tests/mdh-pipeline-completions.test.js` — catalog integrity, lezer node-name pins, classifier per-context cases, source-factory behavior.
- **Modify** `src/mdh/components/JsonEditor.jsx` — remove the inline `QUERY_OPERATORS`/`UPDATE_OPERATORS`/`AGGREGATION_STAGES`/`EXPRESSION_OPERATORS`/`mongoCompletions`/`getCompletionSets`/`extractFieldNames`/`collectKeys`; import `makeCompletionSource` + `extractFieldNames` from the new module; re-export `extractFieldNames`; wire the factory into the `autocompletion` extension by `mode`.

`src/mdh/components/PipelineEditor.jsx` imports `extractFieldNames` from `./JsonEditor.jsx` (line 4) — left untouched because JsonEditor re-exports it.

---

## Task 1: Operator catalogs + option arrays

**Files:**
- Create: `src/mdh/pipelineCompletions.js`
- Test: `tests/mdh-pipeline-completions.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-pipeline-completions.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CATALOG, optionsFor, SYSTEM_VAR_OPTIONS } from '../src/mdh/pipelineCompletions.js';

describe('operator catalog', () => {
  it('every entry has label/detail/cats and a $ label', () => {
    expect(CATALOG.length).toBeGreaterThan(120);
    for (const e of CATALOG) {
      expect(typeof e.label).toBe('string');
      expect(e.label.startsWith('$')).toBe(true);
      expect(typeof e.detail).toBe('string');
      expect(e.detail.length).toBeGreaterThan(0);
      expect(e.cats.size).toBeGreaterThan(0);
    }
  });

  it('labels are unique (merged across categories)', () => {
    const labels = CATALOG.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('category option lists contain the expected anchors', () => {
    const labelsOf = (cat) => optionsFor(cat).map((o) => o.label);
    expect(labelsOf('STAGE')).toEqual(expect.arrayContaining(['$match', '$group', '$setWindowFields', '$unionWith']));
    expect(labelsOf('QUERY')).toEqual(expect.arrayContaining(['$eq', '$in', '$regex', '$elemMatch']));
    expect(labelsOf('EXPRESSION')).toEqual(expect.arrayContaining(['$concat', '$dateToString', '$toInt', '$cond', '$mergeObjects']));
    expect(labelsOf('ACCUMULATOR')).toEqual(expect.arrayContaining(['$sum', '$push', '$stdDevPop', '$rank']));
    // GROUP_VALUE = ACCUMULATOR ∪ EXPRESSION, deduped
    const g = labelsOf('GROUP_VALUE');
    expect(g).toEqual(expect.arrayContaining(['$sum', '$concat']));
    expect(new Set(g).size).toBe(g.length);
    // dual-category operator carries both
    const sum = CATALOG.find((e) => e.label === '$sum');
    expect(sum.cats.has('ACCUMULATOR')).toBe(true);
    expect(sum.cats.has('EXPRESSION')).toBe(true);
  });

  it('options are CodeMirror completion shaped', () => {
    const o = optionsFor('STAGE')[0];
    expect(o).toHaveProperty('label');
    expect(o).toHaveProperty('type', 'keyword');
    expect(o).toHaveProperty('detail');
    expect(SYSTEM_VAR_OPTIONS.map((s) => s.label)).toContain('$$ROOT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: FAIL — `Failed to resolve import "../src/mdh/pipelineCompletions.js"`.

- [ ] **Step 3: Create the module with catalogs**

Create `src/mdh/pipelineCompletions.js`:

```js
// src/mdh/pipelineCompletions.js
//
// Autocomplete for the MDH editors. The aggregate pipeline (mode === 'aggregate')
// gets a strict, context-aware system driven by the CodeMirror/lezer syntax tree:
// only the operators valid at the cursor position are offered. All other modes
// keep their original union behavior verbatim (see makeCompletionSource).
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

// ---- Category tags ---------------------------------------------------------
export const STAGE = 'STAGE';
export const QUERY = 'QUERY';
export const EXPRESSION = 'EXPRESSION';
export const ACCUMULATOR = 'ACCUMULATOR';

// ---- Raw [label, detail] lists, sourced from Rossum's data-storage-reference /
// mongodb-reference + standard MongoDB. An operator that belongs to several
// categories is listed in each; buildCatalog() merges them by label (cats union,
// first detail wins). Keep details short — they render in the completion tooltip.
const RAW_STAGE = [
  ['$match', 'Filter documents'],
  ['$project', 'Reshape: include/exclude/compute fields'],
  ['$addFields', 'Add or overwrite fields'],
  ['$set', 'Add or overwrite fields (alias of $addFields)'],
  ['$unset', 'Remove fields'],
  ['$group', 'Group by key with accumulators'],
  ['$sort', 'Sort documents'],
  ['$limit', 'Limit number of documents'],
  ['$skip', 'Skip documents'],
  ['$count', 'Count documents into a named field'],
  ['$unwind', 'Deconstruct an array field'],
  ['$replaceRoot', 'Promote a sub-document to root'],
  ['$replaceWith', 'Replace root with an expression'],
  ['$lookup', 'Left outer join another collection'],
  ['$unionWith', 'Union with another collection'],
  ['$graphLookup', 'Recursive graph lookup'],
  ['$facet', 'Run multiple sub-pipelines'],
  ['$bucket', 'Group into buckets by boundaries'],
  ['$bucketAuto', 'Group into auto-computed buckets'],
  ['$sortByCount', 'Group by value and sort by count'],
  ['$sample', 'Randomly select N documents'],
  ['$setWindowFields', 'Window functions over partitions'],
  ['$densify', 'Fill gaps in a numeric/date sequence'],
  ['$fill', 'Fill null/missing field values'],
  ['$documents', 'Use literal documents as input'],
  ['$merge', 'Write results, merging into a collection'],
  ['$out', 'Write results to a collection'],
  ['$redact', 'Restrict documents by content'],
  ['$geoNear', 'Order by proximity to a point'],
  ['$collStats', 'Collection statistics'],
  ['$indexStats', 'Index usage statistics'],
  ['$search', 'Atlas Search query'],
  ['$searchMeta', 'Atlas Search metadata'],
];

const RAW_QUERY = [
  ['$eq', 'Equal to'],
  ['$ne', 'Not equal to'],
  ['$gt', 'Greater than'],
  ['$gte', 'Greater than or equal'],
  ['$lt', 'Less than'],
  ['$lte', 'Less than or equal'],
  ['$in', 'Matches any value in array'],
  ['$nin', 'Matches none in array'],
  ['$and', 'Logical AND'],
  ['$or', 'Logical OR'],
  ['$not', 'Logical NOT'],
  ['$nor', 'Logical NOR'],
  ['$exists', 'Field exists check'],
  ['$type', 'BSON type check'],
  ['$regex', 'Regular expression match'],
  ['$options', 'Regex flags (with $regex)'],
  ['$expr', 'Use an aggregation expression in a match'],
  ['$mod', 'Modulo match [divisor, remainder]'],
  ['$text', 'Full-text search (text index)'],
  ['$where', 'JavaScript predicate (slow)'],
  ['$jsonSchema', 'Validate against a JSON schema'],
  ['$all', 'Array contains all elements'],
  ['$elemMatch', 'Array element matches conditions'],
  ['$size', 'Array has exact length'],
];

const RAW_EXPRESSION = [
  // arithmetic
  ['$add', 'Add numbers or dates'], ['$subtract', 'Subtract numbers or dates'],
  ['$multiply', 'Multiply numbers'], ['$divide', 'Divide numbers'], ['$mod', 'Modulo'],
  ['$abs', 'Absolute value'], ['$ceil', 'Round up'], ['$floor', 'Round down'],
  ['$round', 'Round to decimals'], ['$trunc', 'Truncate to integer'], ['$sqrt', 'Square root'],
  ['$pow', 'Raise to power'], ['$exp', 'e raised to power'], ['$ln', 'Natural logarithm'],
  ['$log', 'Logarithm with base'], ['$log10', 'Base-10 logarithm'],
  // string
  ['$concat', 'Concatenate strings'], ['$substr', 'Substring (bytes)'],
  ['$substrBytes', 'Substring by bytes'], ['$substrCP', 'Substring by code points'],
  ['$toLower', 'To lowercase'], ['$toUpper', 'To uppercase'], ['$trim', 'Trim characters'],
  ['$ltrim', 'Trim leading characters'], ['$rtrim', 'Trim trailing characters'],
  ['$split', 'Split string into array'], ['$strLenBytes', 'Length in bytes'],
  ['$strLenCP', 'Length in code points'], ['$indexOfBytes', 'Substring index (bytes)'],
  ['$indexOfCP', 'Substring index (code points)'], ['$regexFind', 'First regex match'],
  ['$regexFindAll', 'All regex matches'], ['$regexMatch', 'Regex test (boolean)'],
  ['$replaceOne', 'Replace first occurrence'], ['$replaceAll', 'Replace all occurrences'],
  ['$toString', 'Convert to string'],
  // array
  ['$arrayElemAt', 'Element at index'], ['$arrayToObject', 'Array of pairs to object'],
  ['$concatArrays', 'Concatenate arrays'], ['$filter', 'Filter array by condition'],
  ['$first', 'First element/value'], ['$last', 'Last element/value'],
  ['$firstN', 'First N elements'], ['$lastN', 'Last N elements'],
  ['$in', 'Value is in array'], ['$indexOfArray', 'Find element index'],
  ['$isArray', 'Is value an array'], ['$map', 'Transform each element'],
  ['$objectToArray', 'Object to array of pairs'], ['$range', 'Generate integer array'],
  ['$reduce', 'Reduce array to a value'], ['$reverseArray', 'Reverse array'],
  ['$size', 'Array length'], ['$slice', 'Subset of array'], ['$zip', 'Merge arrays element-wise'],
  ['$sortArray', 'Sort array elements'], ['$maxN', 'N largest values'], ['$minN', 'N smallest values'],
  // date
  ['$dateFromString', 'Parse date string'], ['$dateToString', 'Format date as string'],
  ['$dateFromParts', 'Build date from parts'], ['$dateToParts', 'Decompose date to parts'],
  ['$year', 'Year component'], ['$month', 'Month component'], ['$dayOfMonth', 'Day-of-month'],
  ['$hour', 'Hour component'], ['$minute', 'Minute component'], ['$second', 'Second component'],
  ['$millisecond', 'Millisecond component'], ['$dayOfWeek', 'Day-of-week'], ['$dayOfYear', 'Day-of-year'],
  ['$week', 'Week of year'], ['$isoWeek', 'ISO week'], ['$isoWeekYear', 'ISO week-year'],
  ['$isoDayOfWeek', 'ISO day-of-week'], ['$dateAdd', 'Add to a date'], ['$dateSubtract', 'Subtract from a date'],
  ['$dateDiff', 'Difference between dates'], ['$dateTrunc', 'Truncate date to unit'], ['$toDate', 'Convert to date'],
  // comparison
  ['$cmp', 'Compare two values (-1/0/1)'],
  ['$eq', 'Equal to'], ['$ne', 'Not equal to'], ['$gt', 'Greater than'],
  ['$gte', 'Greater than or equal'], ['$lt', 'Less than'], ['$lte', 'Less than or equal'],
  // conditional / boolean
  ['$cond', 'If-then-else'], ['$ifNull', 'First non-null value'], ['$switch', 'Multi-branch conditional'],
  ['$and', 'Logical AND'], ['$or', 'Logical OR'], ['$not', 'Logical NOT'],
  // type
  ['$type', 'BSON type string'], ['$convert', 'Convert with onError/onNull'],
  ['$toBool', 'Convert to boolean'], ['$toInt', 'Convert to int'], ['$toLong', 'Convert to long'],
  ['$toDouble', 'Convert to double'], ['$toDecimal', 'Convert to decimal'],
  ['$toObjectId', 'Convert to ObjectId'], ['$isNumber', 'Is value numeric'],
  // set
  ['$setEquals', 'Sets are equal'], ['$setIntersection', 'Common elements'],
  ['$setUnion', 'All elements'], ['$setDifference', 'Elements in A not B'],
  ['$setIsSubset', 'A is a subset of B'], ['$anyElementTrue', 'Any element truthy'],
  ['$allElementsTrue', 'All elements truthy'],
  // object
  ['$mergeObjects', 'Merge objects'], ['$getField', 'Get field by name'], ['$setField', 'Set field by name'],
  // variable / special
  ['$let', 'Bind variables in an expression'], ['$literal', 'Return a value unparsed'],
  ['$rand', 'Random float 0..1'], ['$function', 'Custom JavaScript'], ['$meta', 'Metadata (e.g. searchScore)'],
];

const RAW_ACCUMULATOR = [
  ['$sum', 'Sum of values'], ['$avg', 'Average'], ['$min', 'Minimum'], ['$max', 'Maximum'],
  ['$first', 'First value in group'], ['$last', 'Last value in group'],
  ['$push', 'Collect values into an array'], ['$addToSet', 'Collect unique values'],
  ['$count', 'Count of documents'], ['$stdDevPop', 'Population standard deviation'],
  ['$stdDevSamp', 'Sample standard deviation'], ['$mergeObjects', 'Merge grouped objects'],
  ['$accumulator', 'Custom JavaScript accumulator'], ['$top', 'Top value by sort'],
  ['$topN', 'Top N values by sort'], ['$bottom', 'Bottom value by sort'], ['$bottomN', 'Bottom N values by sort'],
  ['$firstN', 'First N values'], ['$lastN', 'Last N values'], ['$maxN', 'N maximum values'],
  ['$minN', 'N minimum values'], ['$median', 'Approximate median'], ['$percentile', 'Approximate percentile'],
  // window-only
  ['$rank', 'Rank with gaps'], ['$denseRank', 'Rank without gaps'], ['$documentNumber', 'Position in partition'],
  ['$shift', 'Value from an offset row'], ['$derivative', 'Rate of change'], ['$integral', 'Area under the curve'],
  ['$expMovingAvg', 'Exponential moving average'], ['$covariancePop', 'Population covariance'],
  ['$covarianceSamp', 'Sample covariance'], ['$linearFill', 'Linear interpolation fill'],
  ['$locf', 'Last observation carried forward'],
];

function buildCatalog() {
  const byLabel = new Map();
  const add = (cat, list) => {
    for (const [label, detail] of list) {
      let e = byLabel.get(label);
      if (!e) { e = { label, detail, cats: new Set() }; byLabel.set(label, e); }
      e.cats.add(cat);
    }
  };
  add(STAGE, RAW_STAGE);
  add(QUERY, RAW_QUERY);
  add(EXPRESSION, RAW_EXPRESSION);
  add(ACCUMULATOR, RAW_ACCUMULATOR);
  return [...byLabel.values()];
}

export const CATALOG = buildCatalog();

function toOption(e) { return { label: e.label, type: 'keyword', detail: e.detail }; }
function dedupeByLabel(opts) {
  const seen = new Set();
  const out = [];
  for (const o of opts) if (!seen.has(o.label)) { seen.add(o.label); out.push(o); }
  return out;
}

const OPTS = {
  STAGE: CATALOG.filter((e) => e.cats.has(STAGE)).map(toOption),
  QUERY: CATALOG.filter((e) => e.cats.has(QUERY)).map(toOption),
  EXPRESSION: CATALOG.filter((e) => e.cats.has(EXPRESSION)).map(toOption),
  ACCUMULATOR: CATALOG.filter((e) => e.cats.has(ACCUMULATOR)).map(toOption),
};
const OPTS_GROUP_VALUE = dedupeByLabel([...OPTS.ACCUMULATOR, ...OPTS.EXPRESSION]);
const OPTS_ALL = CATALOG.map(toOption);

// Exposed for the source factory and tests.
export function optionsFor(context) {
  if (context === STAGE) return OPTS.STAGE;
  if (context === QUERY) return OPTS.QUERY;
  if (context === EXPRESSION) return OPTS.EXPRESSION;
  if (context === ACCUMULATOR) return OPTS.ACCUMULATOR;
  if (context === 'GROUP_VALUE') return OPTS_GROUP_VALUE;
  return OPTS_ALL;
}

export const SYSTEM_VAR_OPTIONS = [
  ['$$ROOT', 'Root document'], ['$$CURRENT', 'Current document'],
  ['$$REMOVE', 'Conditionally omit a field'], ['$$NOW', 'Current datetime'],
  ['$$CLUSTER_TIME', 'Current cluster time'], ['$$DESCEND', '$redact: keep and descend'],
  ['$$PRUNE', '$redact: exclude subtree'], ['$$KEEP', '$redact: keep subtree'],
  ['$$SEARCH_META', 'Atlas Search metadata'],
].map(([label, detail]) => ({ label, type: 'variable', detail }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS. No commit.

---

## Task 2: Syntax-tree helpers + `classifyContext`

**Files:**
- Modify: `src/mdh/pipelineCompletions.js`
- Test: `tests/mdh-pipeline-completions.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-pipeline-completions.test.js`:

```js
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { classifyContext } from '../src/mdh/pipelineCompletions.js';

// Build a state from code containing a single '|' cursor marker.
function at(code) {
  const pos = code.indexOf('|');
  const doc = code.slice(0, pos) + code.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [javascript()] });
  ensureSyntaxTree(state, doc.length, 5000); // force a full parse for the test
  return { state, pos };
}
function ctx(code) {
  const { state, pos } = at(code);
  return classifyContext(state, pos);
}

describe('lezer node-name pins (guard against CM upgrades)', () => {
  it('object keys are PropertyDefinition (unquoted) or String (quoted, firstChild)', () => {
    const { state } = at('[{ $match: {} }|]');
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    const names = new Set();
    tree.cursor().iterate((n) => { names.add(n.name); });
    expect(names.has('ObjectExpression')).toBe(true);
    expect(names.has('ArrayExpression')).toBe(true);
    expect(names.has('Property')).toBe(true);
    expect(names.has('PropertyDefinition')).toBe(true);
  });
});

describe('classifyContext', () => {
  it('STAGE — root pipeline, unquoted and quoted keys', () => {
    expect(ctx('[{ $ma|t }]')).toEqual({ position: 'key', keyCategory: 'STAGE' });
    expect(ctx('[{ "$ma|t" }]')).toEqual({ position: 'key', keyCategory: 'STAGE' });
  });
  it('STAGE — sub-pipelines ($lookup.pipeline, $facet branch)', () => {
    expect(ctx('[{ $lookup: { from: "c", pipeline: [ { $ma| } ], as: "a" } }]'))
      .toEqual({ position: 'key', keyCategory: 'STAGE' });
    expect(ctx('[{ $facet: { branchA: [ { $ma| } ] } }]'))
      .toEqual({ position: 'key', keyCategory: 'STAGE' });
  });
  it('QUERY — operator inside $match', () => {
    expect(ctx('[{ $match: { amount: { $g| } } }]')).toEqual({ position: 'key', keyCategory: 'QUERY' });
  });
  it('EXPRESSION — $expr inside $match beats $match', () => {
    expect(ctx('[{ $match: { $expr: { $g| } } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('EXPRESSION — computed value in $project / $addFields', () => {
    expect(ctx('[{ $project: { y: { $toU| } } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
    expect(ctx('[{ $addFields: { y: { $a| } } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('EXPRESSION — expression-operator array argument ($multiply args)', () => {
    expect(ctx('[{ $project: { y: { $multiply: [ { $a| } ] } } }]'))
      .toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('GROUP_VALUE — accumulator field in $group (non-_id)', () => {
    expect(ctx('[{ $group: { _id: "$x", total: { $su| } } }]'))
      .toEqual({ position: 'key', keyCategory: 'GROUP_VALUE' });
  });
  it('EXPRESSION — $group._id is an expression, not an accumulator', () => {
    expect(ctx('[{ $group: { _id: { $toU| } } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('GROUP_VALUE — $setWindowFields output accumulator', () => {
    expect(ctx('[{ $setWindowFields: { output: { r: { $ra| } } } }]'))
      .toEqual({ position: 'key', keyCategory: 'GROUP_VALUE' });
  });
  it('FIELD_REF — string value starting with $', () => {
    expect(ctx('[{ $project: { y: "$fie|" } }]')).toEqual({ position: 'value', keyCategory: null });
    expect(ctx('[{ $match: { $expr: { $gt: ["$am|", 5] } } }]')).toEqual({ position: 'value', keyCategory: null });
  });
  it('plain field-name key position (no $)', () => {
    expect(ctx('[{ $sort: { amo| } }]')).toEqual({ position: 'key', keyCategory: 'EXPRESSION' });
  });
  it('UNKNOWN — plain string value (not $) and whitespace', () => {
    expect(ctx('[{ $match: { status: "act|" } }]')).toEqual({ position: 'value', keyCategory: null });
  });
});
```

> Note on `$sort` / plain keys: `classifyContext` reports the structural `keyCategory` (here `EXPRESSION`, since `$sort`'s governing key is a non-grouping stage). Whether the source offers operators or field names is decided in Task 3 by the token's `$` prefix, not by `keyCategory`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: FAIL — `classifyContext is not a function` / import error.

- [ ] **Step 3: Implement the helpers + classifier**

Append to `src/mdh/pipelineCompletions.js`:

```js
// ---- Syntax-tree context classifier ---------------------------------------
// Verified lezer (@codemirror/lang-javascript) facts, 2026-06-16:
//   • unquoted object key -> PropertyDefinition; quoted key -> String that is
//     its Property's firstChild; string value -> String that is NOT firstChild.
//   • a pipeline-stage object is an element of an ArrayExpression.
//   • nearest $-prefixed ancestor Property key governs nested context.
const GROUP_STAGES = new Set(['$group', '$bucket', '$bucketAuto']);

function unquote(t) {
  let s = (t || '').trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    s = s.slice(1);
    if (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1);
  }
  return s;
}

function propertyKeyText(prop, state) {
  const keyNode = prop.firstChild;
  if (!keyNode) return null;
  return unquote(state.doc.sliceString(keyNode.from, keyNode.to));
}

// The ObjectExpression that contains the key node being typed.
function objectOfKey(node) {
  const prop = node.parent;
  if (prop && prop.name === 'Property' && prop.parent && prop.parent.name === 'ObjectExpression') {
    return prop.parent;
  }
  return null;
}

// Walk up Property ancestors from startNode (inclusive). Returns the nearest
// $-prefixed key plus the non-$ field keys passed on the way (nearest first).
function governingKey(startNode, state) {
  const fields = [];
  let n = startNode;
  while (n) {
    if (n.name === 'Property') {
      const k = propertyKeyText(n, state);
      if (k != null) {
        if (k.startsWith('$')) return { key: k, fields };
        fields.push(k);
      }
    }
    n = n.parent;
  }
  return { key: null, fields };
}

// Is this ArrayExpression a pipeline array (root, sub-pipeline, or $facet branch)?
function isPipelineArray(arrayNode, state) {
  const p = arrayNode.parent;
  if (!p) return false;
  if (p.name === 'ExpressionStatement' || p.name === 'Script') return true; // root pipeline
  if (p.name === 'Property') {
    const k = propertyKeyText(p, state);
    if (k === 'pipeline') return true;                 // $lookup / $unionWith / $graphLookup
    if (k != null && !k.startsWith('$') && governingKey(p, state).key === '$facet') return true;
  }
  return false;
}

export function classifyContext(state, pos) {
  const tree = ensureSyntaxTree(state, pos, 100) || syntaxTree(state);
  if (!tree) return { position: 'unknown', keyCategory: null };
  const node = tree.resolveInner(pos, -1);

  // Key vs value.
  let position = 'unknown';
  if (node.name === 'PropertyDefinition' || node.name === 'PropertyName') {
    position = 'key';
  } else if (node.name === 'String') {
    const prop = node.parent;
    const isKey = prop && prop.name === 'Property' && prop.firstChild
      && prop.firstChild.from === node.from && prop.firstChild.to === node.to;
    position = isKey ? 'key' : 'value';
  }

  if (position === 'value') return { position: 'value', keyCategory: null };
  if (position !== 'key') return { position: 'unknown', keyCategory: null };

  const obj = objectOfKey(node);
  if (!obj) return { position: 'key', keyCategory: null };

  // Stage position: the keyed object is a pipeline-array element.
  if (obj.parent && obj.parent.name === 'ArrayExpression') {
    if (isPipelineArray(obj.parent, state)) return { position: 'key', keyCategory: STAGE };
    return { position: 'key', keyCategory: EXPRESSION }; // expression-operator array arg
  }

  // Nested: governing $-key decides.
  const { key, fields } = governingKey(obj.parent, state);
  if (!key) return { position: 'key', keyCategory: null };
  if (key === '$match') return { position: 'key', keyCategory: QUERY };
  if (key === '$group') {
    return { position: 'key', keyCategory: fields[0] !== '_id' ? 'GROUP_VALUE' : EXPRESSION };
  }
  if (key === '$bucket' || key === '$bucketAuto' || key === '$setWindowFields') {
    return { position: 'key', keyCategory: fields.includes('output') ? 'GROUP_VALUE' : EXPRESSION };
  }
  return { position: 'key', keyCategory: EXPRESSION };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS. No commit.

---

## Task 3: Completion-source factory (`makeCompletionSource`) + `extractFieldNames`

**Files:**
- Modify: `src/mdh/pipelineCompletions.js`
- Test: `tests/mdh-pipeline-completions.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mdh-pipeline-completions.test.js`:

```js
import { CompletionContext } from '@codemirror/autocomplete';
import { makeCompletionSource, extractFieldNames } from '../src/mdh/pipelineCompletions.js';

// Run the aggregate source at a '|' cursor; fields = sample field names.
function complete(code, fields = []) {
  const pos = code.indexOf('|');
  const doc = code.slice(0, pos) + code.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [javascript()] });
  ensureSyntaxTree(state, doc.length, 5000);
  const source = makeCompletionSource('aggregate', () => fields);
  const cc = new CompletionContext(state, pos, /* explicit */ true);
  return source(cc);
}
const labels = (res) => (res ? res.options.map((o) => o.label) : null);

describe('extractFieldNames', () => {
  it('collects dotted paths and sorts', () => {
    expect(extractFieldNames([{ a: 1, b: { c: 2 } }, { a: 1, d: 3 }]))
      .toEqual(['a', 'b', 'b.c', 'd']);
  });
});

describe('aggregate completion source', () => {
  it('STAGE position offers stages, not query/expression operators', () => {
    const out = labels(complete('[{ $ma| }]'));
    expect(out).toContain('$match');
    expect(out).toContain('$group');
    expect(out).not.toContain('$gt');   // query op — not a stage
    expect(out).not.toContain('$toInt'); // expression op — not a stage
  });
  it('QUERY position inside $match offers query operators only', () => {
    const out = labels(complete('[{ $match: { amount: { $| } } }]'));
    expect(out).toContain('$gt');
    expect(out).toContain('$in');
    expect(out).not.toContain('$match'); // stage — not valid here
  });
  it('GROUP_VALUE offers accumulators (and expression args)', () => {
    const out = labels(complete('[{ $group: { _id: "$x", total: { $| } } }]'));
    expect(out).toContain('$sum');
    expect(out).toContain('$push');
    expect(out).not.toContain('$match');
  });
  it('no startsWith pre-filter — fuzzy can still reach $group from "grp"', () => {
    // Source returns the whole STAGE set; CodeMirror fuzzy-filters downstream.
    const res = complete('[{ $grp| }]');
    expect(labels(res)).toContain('$group');
    expect(res.validFor).toBeInstanceOf(RegExp);
  });
  it('FIELD_REF — string value starting with $ offers $-prefixed fields + system vars', () => {
    const out = labels(complete('[{ $project: { y: "$am|" } }]', ['amount', 'amount.net', 'vendor']));
    expect(out).toContain('$amount');
    expect(out).toContain('$amount.net');
    expect(out).toContain('$$ROOT');
    expect(out).not.toContain('$match'); // operators are not field refs
  });
  it('FIELD_REF — $$ prefix offers only system vars', () => {
    const out = labels(complete('[{ $project: { y: "$$R|" } }]', ['amount']));
    expect(out).toContain('$$ROOT');
    expect(out).not.toContain('$amount');
  });
  it('plain field-name key offers field names', () => {
    const out = labels(complete('[{ $sort: { am| } }]', ['amount', 'vendor']));
    expect(out).toContain('amount');
    expect(out).toContain('vendor');
    expect(out).not.toContain('$amount');
  });
  it('returns null for a plain (non-$) string value', () => {
    expect(complete('[{ $match: { status: "ac|" } }]', ['amount'])).toBeNull();
  });
  it('the from offset sits after an opening quote', () => {
    const res = complete('[{ "$ma|" }]');
    // doc: [{ "$ma" }]  — quote at index 3, so token starts at 4
    expect(res.from).toBe(4);
  });
});

describe('non-aggregate modes keep union behavior', () => {
  it('query mode still offers query operators for $-token (no classifier)', () => {
    const pos = '{ "$g| }'.indexOf('|');
    const doc = '{ "$g }';
    const state = EditorState.create({ doc, extensions: [javascript()] });
    const source = makeCompletionSource('query', null);
    const res = source(new CompletionContext(state, 4, true));
    expect(res.options.map((o) => o.label)).toContain('$gt');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: FAIL — `makeCompletionSource is not a function` / `extractFieldNames is not a function`.

- [ ] **Step 3: Implement the source factory, field extraction, and legacy path**

Append to `src/mdh/pipelineCompletions.js`:

```js
// ---- Field extraction (moved from JsonEditor.jsx, unchanged behavior) ------
export function extractFieldNames(records) {
  const fields = new Set();
  for (const record of records) collectKeys(record, '', fields);
  return [...fields].sort();
}
function collectKeys(obj, prefix, fields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.add(path);
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      collectKeys(obj[key], path, fields);
    }
  }
}

// ---- Completion sources ----------------------------------------------------
const TOKEN_RE = /"?\${0,2}[\w.]*/;
const VALID_FOR = /^"?\${0,2}[\w.]*$/;

function fieldNameOptions(fieldsFn) {
  if (!fieldsFn) return [];
  return fieldsFn().filter((f) => !f.startsWith('$')).map((f) => ({ label: f, type: 'property', detail: 'field' }));
}
function fieldRefOptions(fieldsFn) {
  if (!fieldsFn) return [];
  return fieldsFn().filter((f) => !f.startsWith('$')).map((f) => ({ label: '$' + f, type: 'property', detail: 'field' }));
}

function aggregateSource(fieldsFn) {
  return (context) => {
    const m = context.matchBefore(TOKEN_RE);
    if (!m) return null;
    const raw = m.text;
    const hasQuote = raw.startsWith('"') || raw.startsWith("'");
    const inner = hasQuote ? raw.slice(1) : raw;
    const from = hasQuote ? m.from + 1 : m.from;
    if (inner === '' && !hasQuote && !context.explicit) return null;

    const { position, keyCategory } = classifyContext(context.state, context.pos);

    if (position === 'value') {
      if (!inner.startsWith('$')) return null;
      if (inner.startsWith('$$')) return { from, options: SYSTEM_VAR_OPTIONS, validFor: VALID_FOR };
      const refs = fieldRefOptions(fieldsFn);
      if (!refs.length) return { from, options: SYSTEM_VAR_OPTIONS, validFor: VALID_FOR };
      return { from, options: refs.concat(SYSTEM_VAR_OPTIONS), validFor: VALID_FOR };
    }

    if (position === 'key') {
      if (inner.startsWith('$')) {
        return { from, options: optionsFor(keyCategory), validFor: VALID_FOR };
      }
      const names = fieldNameOptions(fieldsFn);
      if (!names.length) return null;
      return { from, options: names, validFor: VALID_FOR };
    }

    // UNKNOWN
    if (inner.startsWith('$$')) return { from, options: SYSTEM_VAR_OPTIONS, validFor: VALID_FOR };
    if (inner.startsWith('$')) return { from, options: OPTS_ALL, validFor: VALID_FOR };
    const names = fieldNameOptions(fieldsFn);
    if (!names.length) return null;
    return { from, options: names, validFor: VALID_FOR };
  };
}

// ---- Legacy (non-aggregate) modes: original union behavior, verbatim -------
const LEGACY_QUERY_OPERATORS = [
  { label: '$eq', type: 'keyword', detail: 'Matches values equal to a value' },
  { label: '$ne', type: 'keyword', detail: 'Matches values not equal' },
  { label: '$gt', type: 'keyword', detail: 'Greater than' },
  { label: '$gte', type: 'keyword', detail: 'Greater than or equal' },
  { label: '$lt', type: 'keyword', detail: 'Less than' },
  { label: '$lte', type: 'keyword', detail: 'Less than or equal' },
  { label: '$in', type: 'keyword', detail: 'Matches any value in array' },
  { label: '$nin', type: 'keyword', detail: 'Matches none in array' },
  { label: '$and', type: 'keyword', detail: 'Logical AND' },
  { label: '$or', type: 'keyword', detail: 'Logical OR' },
  { label: '$not', type: 'keyword', detail: 'Logical NOT' },
  { label: '$nor', type: 'keyword', detail: 'Logical NOR' },
  { label: '$exists', type: 'keyword', detail: 'Field exists check' },
  { label: '$type', type: 'keyword', detail: 'BSON type check' },
  { label: '$regex', type: 'keyword', detail: 'Regular expression match' },
  { label: '$elemMatch', type: 'keyword', detail: 'Array element match' },
  { label: '$all', type: 'keyword', detail: 'All elements match' },
  { label: '$size', type: 'keyword', detail: 'Array size match' },
];
const LEGACY_UPDATE_OPERATORS = [
  { label: '$set', type: 'keyword', detail: 'Set field value' },
  { label: '$unset', type: 'keyword', detail: 'Remove field' },
  { label: '$inc', type: 'keyword', detail: 'Increment value' },
  { label: '$push', type: 'keyword', detail: 'Append to array' },
  { label: '$pull', type: 'keyword', detail: 'Remove from array' },
  { label: '$addToSet', type: 'keyword', detail: 'Add unique to array' },
  { label: '$rename', type: 'keyword', detail: 'Rename field' },
  { label: '$min', type: 'keyword', detail: 'Update if less than' },
  { label: '$max', type: 'keyword', detail: 'Update if greater than' },
  { label: '$mul', type: 'keyword', detail: 'Multiply value' },
];
const LEGACY_AGGREGATION_STAGES = [
  { label: '$match', type: 'keyword', detail: 'Filter documents' },
  { label: '$group', type: 'keyword', detail: 'Group by expression' },
  { label: '$project', type: 'keyword', detail: 'Reshape documents' },
  { label: '$sort', type: 'keyword', detail: 'Sort documents' },
  { label: '$limit', type: 'keyword', detail: 'Limit results' },
  { label: '$skip', type: 'keyword', detail: 'Skip documents' },
  { label: '$unwind', type: 'keyword', detail: 'Deconstruct array' },
  { label: '$lookup', type: 'keyword', detail: 'Left outer join' },
  { label: '$addFields', type: 'keyword', detail: 'Add new fields' },
  { label: '$replaceRoot', type: 'keyword', detail: 'Replace root document' },
  { label: '$count', type: 'keyword', detail: 'Count documents' },
  { label: '$out', type: 'keyword', detail: 'Write to collection' },
  { label: '$merge', type: 'keyword', detail: 'Merge into collection' },
  { label: '$facet', type: 'keyword', detail: 'Multi-pipeline processing' },
  { label: '$bucket', type: 'keyword', detail: 'Categorize into buckets' },
  { label: '$search', type: 'keyword', detail: 'Atlas Search query' },
];
const LEGACY_EXPRESSION_OPERATORS = [
  { label: '$sum', type: 'keyword', detail: 'Sum values' },
  { label: '$avg', type: 'keyword', detail: 'Average value' },
  { label: '$first', type: 'keyword', detail: 'First value in group' },
  { label: '$last', type: 'keyword', detail: 'Last value in group' },
  { label: '$min', type: 'keyword', detail: 'Minimum value' },
  { label: '$max', type: 'keyword', detail: 'Maximum value' },
  { label: '$concat', type: 'keyword', detail: 'Concatenate strings' },
  { label: '$substr', type: 'keyword', detail: 'Substring' },
  { label: '$toLower', type: 'keyword', detail: 'To lowercase' },
  { label: '$toUpper', type: 'keyword', detail: 'To uppercase' },
  { label: '$cond', type: 'keyword', detail: 'Conditional expression' },
  { label: '$ifNull', type: 'keyword', detail: 'Null coalesce' },
  { label: '$arrayElemAt', type: 'keyword', detail: 'Array element at index' },
  { label: '$filter', type: 'keyword', detail: 'Filter array elements' },
  { label: '$map', type: 'keyword', detail: 'Map over array' },
  { label: '$reduce', type: 'keyword', detail: 'Reduce array' },
];
function getCompletionSets(mode) {
  if (mode === 'update') return [LEGACY_UPDATE_OPERATORS, LEGACY_QUERY_OPERATORS];
  if (mode === 'query') return [LEGACY_QUERY_OPERATORS];
  if (mode === 'sort') return [];
  // 'default' and any other non-aggregate mode
  return [LEGACY_QUERY_OPERATORS, LEGACY_UPDATE_OPERATORS, LEGACY_AGGREGATION_STAGES, LEGACY_EXPRESSION_OPERATORS];
}
function legacySource(operatorSets, fieldsFn) {
  const allOps = operatorSets.flat();
  return (context) => {
    const quoted = context.matchBefore(/"\$[\w]*/);
    if (quoted) {
      const prefix = quoted.text.replace(/^"/, '');
      return { from: quoted.from + 1, options: allOps.filter((op) => op.label.startsWith(prefix)) };
    }
    const unquoted = context.matchBefore(/\$[\w]*/);
    if (unquoted) {
      return { from: unquoted.from, options: allOps.filter((op) => op.label.startsWith(unquoted.text)) };
    }
    const fieldQuoted = context.matchBefore(/"[\w.]*/);
    if (fieldQuoted && fieldsFn) {
      const prefix = fieldQuoted.text.replace(/^"/, '');
      const fields = fieldsFn();
      if (fields.length === 0) return null;
      const fieldOptions = fields
        .filter((f) => f.startsWith(prefix) && !f.startsWith('$'))
        .map((f) => ({ label: f, type: 'property', detail: 'field' }));
      if (fieldOptions.length === 0) return null;
      return { from: fieldQuoted.from + 1, options: fieldOptions };
    }
    return null;
  };
}

export function makeCompletionSource(mode, fieldsFn) {
  if (mode === 'aggregate') return aggregateSource(fieldsFn);
  return legacySource(getCompletionSets(mode), fieldsFn);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS (all Task 1–3 tests).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run tests/mdh-pipeline-completions.test.js`
Expected: PASS. No commit.

---

## Task 4: Wire the module into `JsonEditor.jsx`

**Files:**
- Modify: `src/mdh/components/JsonEditor.jsx`
- Test: `tests/mdh-json-editor.test.js` (existing — must still pass), full suite, build.

- [ ] **Step 1: Replace imports + remove the moved code**

In `src/mdh/components/JsonEditor.jsx`:

Replace the autocomplete import line (currently `import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';`) — keep it, and **add** below the other imports:

```js
import { makeCompletionSource, extractFieldNames } from '../pipelineCompletions.js';
```

Then **delete** these now-moved blocks from `JsonEditor.jsx`:
- `const QUERY_OPERATORS = [...]` (lines ~89–108)
- `const UPDATE_OPERATORS = [...]` (lines ~110–121)
- `const AGGREGATION_STAGES = [...]` (lines ~123–140)
- `const EXPRESSION_OPERATORS = [...]` (lines ~142–159)
- `function mongoCompletions(...) {...}` (lines ~161–186)
- `export function extractFieldNames(records) {...}` (lines ~188–194)
- `function collectKeys(...) {...}` (lines ~196–205)
- `function getCompletionSets(mode) {...}` (lines ~207–213)

Add a re-export so `PipelineEditor.jsx`'s `import { extractFieldNames } from './JsonEditor.jsx'` keeps working — place near the top after imports:

```js
export { extractFieldNames };
```

- [ ] **Step 2: Rewire the completion extension**

In the `useEffect` mount block, **delete**:

```js
    const completionSets = getCompletionSets(mode);
    const fieldsFn = typeof fields === 'function' ? fields : null;
```

and replace with:

```js
    const fieldsFn = typeof fields === 'function' ? fields : null;
```

Then change the autocompletion extension line (currently
`autocompletion({ override: [mongoCompletions(completionSets, fieldsFn)] }),`) to:

```js
      autocompletion({ override: [makeCompletionSource(mode, fieldsFn)] }),
```

- [ ] **Step 3: Run the existing editor test + new test**

Run: `npx vitest run tests/mdh-json-editor.test.js tests/mdh-pipeline-completions.test.js`
Expected: PASS — value-prop syncing unaffected; completions module green.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — entire suite (no regressions in pipeline/editor/types/state tests).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean build into `dist/`, no errors. (Confirms the new module bundles and `JsonEditor`'s imports resolve.)

- [ ] **Step 6: Checkpoint**

Run: `npm test && npm run build`
Expected: both PASS. No commit — report status to the user.

---

## Self-Review

**1. Spec coverage**
- G1 field refs → Task 3 FIELD_REF branch + `fieldRefOptions` + system vars. ✓
- G2 comprehensive operators → Task 1 catalogs (CATALOG > 120). ✓
- G3 fuzzy → Task 3 drops `startsWith`, returns full context set + `validFor` (test: `$grp`→`$group`). ✓
- G4 strict context → Task 2 `classifyContext` + Task 3 routing; STAGE/QUERY/EXPRESSION/GROUP_VALUE/FIELD_REF/UNKNOWN all covered. ✓
- Scoping (aggregate only; other modes verbatim) → Task 3 `legacySource`/`getCompletionSets`, Task 4 wiring; test asserts query mode still works. ✓
- lezer node-name pin → Task 2 test. ✓
- No snippet insertion → not implemented. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✓

**3. Type consistency:** `classifyContext` returns `{ position, keyCategory }` everywhere; `keyCategory` values (`'STAGE'|'QUERY'|'EXPRESSION'|'GROUP_VALUE'|null`) match `optionsFor`'s accepted strings; `makeCompletionSource(mode, fieldsFn)` signature consistent across module + JsonEditor call site; `extractFieldNames` defined in Task 3, imported/re-exported in Task 4. ✓

**Known limitation (documented, accepted):** structural stage-option interiors (`$lookup`'s `from`/`localField`, `$unwind` object form, etc.) classify as EXPRESSION — their fixed option-key names aren't modeled in the catalog. Field refs in their values still complete. This matches the strict-filtering trade-off the user accepted.
