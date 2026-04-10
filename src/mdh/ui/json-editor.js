// JSON editor powered by CodeMirror 6.
// Provides syntax highlighting, line numbers, bracket matching,
// code folding, auto-indent, live JSON validation, and MongoDB
// operator autocompletion.

import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion } from '@codemirror/autocomplete';
import JSON5 from 'json5';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const baseTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    flex: '1',
  },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    overflow: 'auto',
  },
  '.cm-gutters': {
    border: 'none',
  },
});

// MongoDB operators for autocompletion
const QUERY_OPERATORS = [
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

const UPDATE_OPERATORS = [
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

const AGGREGATION_STAGES = [
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

const EXPRESSION_OPERATORS = [
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

function mongoCompletions(operatorSets, fieldsFn) {
  const allOps = operatorSets.flat();
  return (context) => {
    // Match "$..." inside quotes or unquoted (JSON5 allows unquoted keys)
    const quoted = context.matchBefore(/"\$[\w]*/);
    if (quoted) {
      const prefix = quoted.text.replace(/^"/, '');
      return {
        from: quoted.from + 1,
        options: allOps.filter((op) => op.label.startsWith(prefix)),
      };
    }
    const unquoted = context.matchBefore(/\$[\w]*/);
    if (unquoted) {
      return {
        from: unquoted.from,
        options: allOps.filter((op) => op.label.startsWith(unquoted.text)),
      };
    }
    // Field name completion — match word after quote (key position in JSON)
    const fieldQuoted = context.matchBefore(/"[\w.]*/);
    if (fieldQuoted && fieldsFn) {
      const prefix = fieldQuoted.text.replace(/^"/, '');
      const fields = fieldsFn();
      if (fields.length === 0) return null;
      const fieldOptions = fields
        .filter((f) => f.startsWith(prefix) && !f.startsWith('$'))
        .map((f) => ({ label: f, type: 'property', detail: 'field' }));
      if (fieldOptions.length === 0) return null;
      return {
        from: fieldQuoted.from + 1,
        options: fieldOptions,
      };
    }
    return null;
  };
}

// Extract all unique field names (including nested with dot notation) from records
export function extractFieldNames(records) {
  const fields = new Set();
  for (const record of records) {
    collectKeys(record, '', fields);
  }
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

const compactTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    flex: '1',
  },
  '.cm-scroller': {
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    overflow: 'auto',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-content': {
    padding: '4px 0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

export function createJsonEditor({ value = '', minHeight = '200px', mode = 'default', fields, compact = false, onSubmit, onValidChange, onChange } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = compact ? 'json-editor json-editor-compact' : 'json-editor';
  if (!compact) wrapper.style.minHeight = minHeight;

  const error = document.createElement('div');
  error.className = 'json-editor-error';

  // Pick completion set based on editor context
  let completionSets;
  if (mode === 'aggregate') {
    completionSets = [AGGREGATION_STAGES, EXPRESSION_OPERATORS, QUERY_OPERATORS];
  } else if (mode === 'update') {
    completionSets = [UPDATE_OPERATORS, QUERY_OPERATORS];
  } else if (mode === 'query') {
    completionSets = [QUERY_OPERATORS];
  } else if (mode === 'sort') {
    completionSets = [];
  } else {
    completionSets = [QUERY_OPERATORS, UPDATE_OPERATORS, AGGREGATION_STAGES, EXPRESSION_OPERATORS];
  }

  const keymaps = [indentWithTab];
  if (onSubmit) {
    keymaps.unshift({
      key: 'Enter',
      run: () => { onSubmit(); return true; },
    }, {
      key: 'Shift-Enter',
      run: (view) => {
        view.dispatch(view.state.replaceSelection('\n'));
        return true;
      },
    });
  }

  const extensions = [
    basicSetup,
    keymap.of(keymaps),
    json(),
    compact ? compactTheme : baseTheme,
    EditorView.lineWrapping,
    autocompletion({ override: [mongoCompletions(completionSets, typeof fields === 'function' ? fields : null)] }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        validate();
        if (onChange) onChange();
      }
    }),
  ];

  if (darkQuery.matches) {
    extensions.push(oneDark);
  }

  const state = EditorState.create({ doc: value, extensions });
  const view = new EditorView({ state, parent: wrapper });

  wrapper.appendChild(error);

  let validChangeTimer = null;
  function scheduleValidChange() {
    if (!onValidChange) return;
    clearTimeout(validChangeTimer);
    validChangeTimer = setTimeout(onValidChange, 500);
  }

  function validate() {
    const text = view.state.doc.toString().trim();
    if (!text) {
      error.textContent = '';
      wrapper.classList.remove('json-editor-invalid');
      return true;
    }
    try {
      JSON5.parse(text);
      error.textContent = '';
      wrapper.classList.remove('json-editor-invalid');
      scheduleValidChange();
      return true;
    } catch (e) {
      error.textContent = e.message;
      wrapper.classList.add('json-editor-invalid');
      return false;
    }
  }

  validate();

  return {
    el: wrapper,
    getValue: () => view.state.doc.toString(),
    setValue: (v) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
      });
    },
    isValid: () => {
      const text = view.state.doc.toString().trim();
      if (!text) return false;
      try { JSON5.parse(text); return true; } catch { return false; }
    },
    getParsed: () => JSON5.parse(view.state.doc.toString()),
    getError: () => error.textContent,
    focus: () => view.focus(),
    refresh: () => view.requestMeasure(),
  };
}
