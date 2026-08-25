// src/mdh/pipelineCompletions.ts
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
  ['$count', 'Count of documents'],
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
  // accumulator-as-expression (valid in $project, $addFields, etc.)
  ['$sum', 'Sum of values (array or accumulator)'], ['$avg', 'Average (array or accumulator)'],
  ['$min', 'Minimum (array or accumulator)'], ['$max', 'Maximum (array or accumulator)'],
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
  const add = (cat: string, list: any[]) => {
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

function toOption(e: any) { return { label: e.label, type: 'keyword', detail: e.detail }; }
function dedupeByLabel(opts: any[]): any[] {
  const seen = new Set();
  const out = [];
  for (const o of opts) if (!seen.has(o.label)) { seen.add(o.label); out.push(o); }
  return out;
}

const OPTS = {
  STAGE: Object.freeze(CATALOG.filter((e) => e.cats.has(STAGE)).map(toOption)),
  QUERY: Object.freeze(CATALOG.filter((e) => e.cats.has(QUERY)).map(toOption)),
  EXPRESSION: Object.freeze(CATALOG.filter((e) => e.cats.has(EXPRESSION)).map(toOption)),
  ACCUMULATOR: Object.freeze(CATALOG.filter((e) => e.cats.has(ACCUMULATOR)).map(toOption)),
};
const OPTS_GROUP_VALUE = Object.freeze(dedupeByLabel([...OPTS.ACCUMULATOR, ...OPTS.EXPRESSION]));
const OPTS_ALL = Object.freeze(CATALOG.map(toOption));

// Exposed for the source factory and tests.
export function optionsFor(context: any): readonly any[] {
  if (context === STAGE) return OPTS.STAGE;
  if (context === QUERY) return OPTS.QUERY;
  if (context === EXPRESSION) return OPTS.EXPRESSION;
  if (context === ACCUMULATOR) return OPTS.ACCUMULATOR;
  if (context === 'GROUP_VALUE') return OPTS_GROUP_VALUE;
  return OPTS_ALL;
}

export const SYSTEM_VAR_OPTIONS = Object.freeze([
  ['$$ROOT', 'Root document'], ['$$CURRENT', 'Current document'],
  ['$$REMOVE', 'Conditionally omit a field'], ['$$NOW', 'Current datetime'],
  ['$$CLUSTER_TIME', 'Current cluster time'], ['$$DESCEND', '$redact: keep and descend'],
  ['$$PRUNE', '$redact: exclude subtree'], ['$$KEEP', '$redact: keep subtree'],
  ['$$SEARCH_META', 'Atlas Search metadata'],
].map(([label, detail]) => ({ label, type: 'variable', detail })));

// ---- Syntax-tree context classifier ---------------------------------------
// Verified lezer (@codemirror/lang-javascript) facts, 2026-06-16:
//   • unquoted object key -> PropertyDefinition; quoted key -> String that is
//     its Property's firstChild; string value -> String that is NOT firstChild.
//   • a pipeline-stage object is an element of an ArrayExpression.
//   • nearest $-prefixed ancestor Property key governs nested context.

function unquote(t: string): string {
  let s = (t || '').trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    s = s.slice(1);
    if (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1);
  }
  return s;
}

function propertyKeyText(prop: any, state: any): string | null {
  const keyNode = prop.firstChild;
  if (!keyNode) return null;
  return unquote(state.doc.sliceString(keyNode.from, keyNode.to));
}

// The ObjectExpression that contains the key node being typed.
function objectOfKey(node: any): any {
  const prop = node.parent;
  if (prop && prop.name === 'Property' && prop.parent && prop.parent.name === 'ObjectExpression') {
    return prop.parent;
  }
  return null;
}

// Logical operators are context-"transparent": they don't change
// query-vs-expression context, they inherit it from their parent ($and inside
// $match is a query; $and inside $expr/$project is an expression). The walk
// skips them so the real context-determining ancestor is found.
const TRANSPARENT_OPS = new Set(['$and', '$or', '$nor', '$not']);

// Walk up Property ancestors from startNode (inclusive). Returns the nearest
// non-transparent $-prefixed key plus the non-$ field keys passed on the way
// (nearest first). Non-Property nodes (ObjectExpression / ArrayExpression) are
// walked through, so this works whether startNode is a Property (nested value)
// or an ArrayExpression (array element).
function governingKey(startNode: any, state: any): { key: string | null; fields: string[] } {
  const fields = [];
  let n = startNode;
  while (n) {
    if (n.name === 'Property') {
      const k = propertyKeyText(n, state);
      if (k != null) {
        if (k.startsWith('$')) {
          if (!TRANSPARENT_OPS.has(k)) return { key: k, fields };
          // transparent operator: skip and keep walking up
        } else {
          fields.push(k);
        }
      }
    }
    n = n.parent;
  }
  return { key: null, fields };
}

// Map a governing $-key (+ the field keys seen below it) to a keyCategory.
function categoryForGoverning(key: string | null, fields: string[]): string | null {
  if (!key) return null;
  if (key === '$match') return QUERY;
  if (key === '$group') return fields.includes('_id') ? EXPRESSION : 'GROUP_VALUE';
  if (key === '$bucket' || key === '$bucketAuto' || key === '$setWindowFields') {
    return fields.includes('output') ? 'GROUP_VALUE' : EXPRESSION;
  }
  return EXPRESSION;
}

// Is this ArrayExpression a pipeline array (root, sub-pipeline, or $facet branch)?
function isPipelineArray(arrayNode: any, state: any): boolean {
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

export function classifyContext(state: any, pos: number): any {
  const tree = ensureSyntaxTree(state, pos, 100) || syntaxTree(state);
  if (!tree) return { position: 'unknown', keyCategory: null };
  const node = tree.resolveInner(pos, -1);

  // Key vs value.
  let position = 'unknown';
  if (node.name === 'PropertyDefinition' || node.name === 'PropertyName') {
    position = 'key';
  } else if (node.name === 'String') {
    // A quoted key is a String that is its Property's firstChild; a string value
    // is a String that is not. Note: a quoted key typed mid-edit in a NESTED
    // object before its colon exists (e.g. `{ amount: { "$g| } }`) can make lezer
    // reparse the surrounding object as a destructuring pattern (PatternProperty),
    // so the String is not seen as a Property key and we fall through to 'value'
    // (no completion that instant). closeBrackets auto-inserts the closing quote
    // (`"$g|"`) in practice, which parses as a Property key, so this is rarely hit.
    const prop = node.parent;
    const isKey = prop && prop.name === 'Property' && prop.firstChild
      && prop.firstChild.from === node.from && prop.firstChild.to === node.to;
    position = isKey ? 'key' : 'value';
  }

  if (position === 'value') return { position: 'value', keyCategory: null };
  if (position !== 'key') return { position: 'unknown', keyCategory: null };

  const obj = objectOfKey(node);
  if (!obj) return { position: 'key', keyCategory: null };

  // Stage position: the keyed object is a pipeline-array element (root pipeline,
  // a sub-pipeline like $lookup.pipeline, or a $facet branch).
  if (obj.parent && obj.parent.name === 'ArrayExpression' && isPipelineArray(obj.parent, state)) {
    return { position: 'key', keyCategory: STAGE };
  }

  // Everything else — a nested object value, or a non-pipeline array element
  // such as a $multiply argument or an $and/$or query clause — is classified by
  // the nearest governing $-key. governingKey walks up from obj.parent whether
  // that is a Property (nested value) or an ArrayExpression (array element), and
  // skips transparent logical operators so $and/$or inherit their parent context.
  const { key, fields } = governingKey(obj.parent, state);
  return { position: 'key', keyCategory: categoryForGoverning(key, fields) };
}

// ---- Field extraction (moved from JsonEditor.jsx, unchanged behavior) ------
export function extractFieldNames(records: any[]): string[] {
  const fields = new Set<string>();
  for (const record of records) collectKeys(record, '', fields);
  return [...fields].sort();
}
function collectKeys(obj: any, prefix: string, fields: Set<string>): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.add(path);
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const el of val) {
        if (el && typeof el === 'object' && !Array.isArray(el)) collectKeys(el, path, fields);
      }
    } else if (val && typeof val === 'object') {
      collectKeys(val, path, fields);
    }
  }
}

// ---- Completion sources ----------------------------------------------------
const TOKEN_RE = /"?\${0,2}[\w.]*/;
const VALID_FOR = /^"?\${0,2}[\w.]*$/;

function fieldNameOptions(fieldsFn: (() => string[]) | null) {
  if (!fieldsFn) return [];
  return fieldsFn().filter((f) => !f.startsWith('$')).map((f: string) => ({ label: f, type: 'property', detail: 'field' }));
}
function fieldRefOptions(fieldsFn: (() => string[]) | null) {
  if (!fieldsFn) return [];
  return fieldsFn().filter((f) => !f.startsWith('$')).map((f: string) => ({ label: '$' + f, type: 'property', detail: 'field' }));
}

function aggregateSource(fieldsFn: (() => string[]) | null) {
  return (context: any) => {
    const m = context.matchBefore(TOKEN_RE);
    if (!m) return null;
    const raw = m.text;
    const hasQuote = raw.startsWith('"'); // TOKEN_RE only captures a leading double-quote
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
function getCompletionSets(mode: string) {
  if (mode === 'update') return [LEGACY_UPDATE_OPERATORS, LEGACY_QUERY_OPERATORS];
  if (mode === 'query') return [LEGACY_QUERY_OPERATORS];
  if (mode === 'sort') return [];
  return [LEGACY_QUERY_OPERATORS, LEGACY_UPDATE_OPERATORS, LEGACY_AGGREGATION_STAGES, LEGACY_EXPRESSION_OPERATORS];
}
function legacySource(operatorSets: any[], fieldsFn: (() => string[]) | null) {
  const allOps = operatorSets.flat();
  return (context: any) => {
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
        .filter((f: string) => f.startsWith(prefix) && !f.startsWith('$'))
        .map((f: string) => ({ label: f, type: 'property', detail: 'field' }));
      if (fieldOptions.length === 0) return null;
      return { from: fieldQuoted.from + 1, options: fieldOptions };
    }
    return null;
  };
}

export function makeCompletionSource(mode: string, fieldsFn: (() => string[]) | null) {
  if (mode === 'aggregate') return aggregateSource(fieldsFn);
  return legacySource(getCompletionSets(mode), fieldsFn);
}
