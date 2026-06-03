// @vitest-environment jsdom
//
// Reproduces the user's exact flow: create a variable in the pipeline, then fill
// its value. Expected: the Variables input appears, and once filled the debug
// returns and the query runs. Uses a controllable mock editor (no CodeMirror).
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null, onValidChange: null }));

globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => { if (cb) { cb({}); return; } return Promise.resolve({}); },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onChange, onValidChange }) => {
    mock.onChange = onChange;
    mock.onValidChange = onValidChange;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v) => { mock.text = v; onChange && onChange(); },
        isValid: () => { try { JSON5.parse(mock.text); return true; } catch { return false; } },
        getParsed: () => JSON5.parse(mock.text),
        focus: () => {},
        refresh: () => {},
      };
    }
    return h('div', { 'data-testid': 'editor' });
  },
}));

vi.mock('../src/mdh/components/RecordList.jsx', () => ({
  default: () => h('div', { 'data-testid': 'recordlist' }),
}));

import * as api from '../src/mdh/api.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records, skip, limit, loading, error } from '../src/mdh/store.js';

let validTimer = null;
// Mimic JsonEditor's updateListener: always fire onChange; if the text parses,
// schedule onValidChange (debounced), otherwise don't.
function typeInEditor(text) {
  mock.text = text;
  if (mock.onChange) mock.onChange();
  clearTimeout(validTimer);
  try {
    JSON5.parse(text);
    validTimer = setTimeout(() => { if (mock.onValidChange) mock.onValidChange(); }, 500);
  } catch { /* invalid — no onValidChange, matches the real editor */ }
}

async function tick(ms) {
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.aggregate.mockResolvedValue({ result: [{ n: 3 }] });
  if (api.listCollections) api.listCollections.mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  skip.value = 0;
  limit.value = 50;
  loading.value = false;
  error.value = null;
  mock.text = '';
});

describe('DataPanel variables → debug + query', () => {
  it('shows the input, runs immediately with an empty value, then re-runs when filled', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);

    await tick(150); // let the [collection] effect seed the default pipeline

    typeInEditor('[{"$match":{"amount":"{amount}"}}]');
    await tick(700); // recompute (250) + onValidChange (500)

    const input = root.querySelector('.placeholder-input');
    expect(input, 'Variables input should appear').not.toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no hint is ever shown').toBeNull();
    expect(root.querySelector('.pipeline-debug-input-row'), 'debug shows immediately').not.toBeNull();
    // Ran right away with the unfilled variable defaulting to an empty string.
    expect(api.aggregate.mock.calls.some(
      ([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes('"amount":""'),
    ), 'the query runs with an empty value before filling').toBe(true);

    // fill the value → re-runs with the typed value
    input.value = '5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(550);

    expect(api.aggregate.mock.calls.some(
      ([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes('"amount":5'),
    ), 'the filled query should have run').toBe(true);
  });

  it('quoted string variable: debug shows, runs with empty, then with the value', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);

    await tick(150);

    typeInEditor('[{"$match":{"vendor":"{vendor}"}}]');
    await tick(700);

    const input = root.querySelector('.placeholder-input');
    expect(input, 'Variables input should appear').not.toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no hint is ever shown').toBeNull();
    expect(root.querySelector('.pipeline-debug-input-row'), 'debug shows immediately').not.toBeNull();
    expect(api.aggregate.mock.calls.some(
      ([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes('"vendor":""'),
    ), 'runs with empty before filling').toBe(true);

    input.value = 'ACME';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(550);

    expect(api.aggregate.mock.calls.some(
      ([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes('"vendor":"ACME"'),
    ), 'the filled query should have run').toBe(true);
  });

  it("a string value containing {braces} is literal: no variable input, debug shows, query runs", async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);

    await tick(150);

    // The user's real query: {A105N} is part of a literal string, not a variable.
    typeInEditor('[{"$match":{"LINE DESC":"GBL CS WLD FLG {A105N} CSF DC N/STK"}},{"$sort":{"_id":-1}},{"$skip":0},{"$limit":50}]');
    await tick(700); // recompute (250) + onValidChange (500)

    expect(root.querySelector('.placeholder-input'), 'no spurious variable input').toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no unresolved hint').toBeNull();
    expect(root.querySelector('.pipeline-debug-input-row'), 'debug should render').not.toBeNull();

    const ranLiteral = api.aggregate.mock.calls.some(
      ([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes('GBL CS WLD FLG {A105N}'),
    );
    expect(ranLiteral, 'the literal-match query should have run').toBe(true);
  });
});
