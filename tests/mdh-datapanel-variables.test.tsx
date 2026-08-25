// @vitest-environment jsdom
//
// Reproduces the user's exact flow: create a variable in the pipeline, then fill
// its value. Expected: the Variables input appears, and once filled the debug
// returns and the query runs. Uses a controllable mock editor (no CodeMirror).
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null as any, onValidChange: null as any }));

globalThis.chrome = {
  storage: {
    local: {
      get: (keys: any, cb: any) => {
        if (cb) {
          cb({});
          return;
        }
        return Promise.resolve({});
      },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
  runtime: { onMessage: { addListener: () => {} } } as any,
} as any;

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onChange, onValidChange }: any) => {
    mock.onChange = onChange;
    mock.onValidChange = onValidChange;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v: any) => {
          mock.text = v;
          onChange && onChange();
        },
        isValid: () => {
          try {
            JSON5.parse(mock.text);
            return true;
          } catch {
            return false;
          }
        },
        getParsed: () => JSON5.parse(mock.text),
        focus: () => {},
        refresh: () => {},
      };
    }
    return <div data-testid="editor" />;
  },
}));

vi.mock('../src/mdh/components/RecordList.jsx', () => ({
  default: () => <div data-testid="recordlist" />,
}));

import * as api from '../src/mdh/api.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records, skip, limit, loading, error } from '../src/mdh/store.js';

let validTimer: any = null;
// Mimic JsonEditor's updateListener: always fire onChange; if the text parses,
// schedule onValidChange (debounced), otherwise don't.
function typeInEditor(text: any) {
  mock.text = text;
  if (mock.onChange) mock.onChange();
  clearTimeout(validTimer);
  try {
    JSON5.parse(text);
    validTimer = setTimeout(() => {
      if (mock.onValidChange) mock.onValidChange();
    }, 500);
  } catch {
    /* invalid — no onValidChange, matches the real editor */
  }
}

// Condition-based, never a fixed sleep: the mock editor's onValidChange lands at
// +500ms on top of a 250ms recompute, and under full-suite load those timers fire
// late — a fixed "long enough" wait flakes.
async function waitFor(cond: any, desc = 'condition', timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Did a query run against the collection whose serialized pipeline contains frag?
function ranWith(frag: any) {
  return vi
    .mocked(api.aggregate)
    .mock.calls.some(([col, pl]) => col === 'vendors' && JSON.stringify(pl).includes(frag));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 3 }] });
  if (api.listCollections) vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
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
    render(<DataPanel />, root);

    await waitFor(() => mock.text !== '', 'the [collection] effect to seed the default pipeline');

    typeInEditor('[{"$match":{"amount":"{amount}"}}]');
    await waitFor(() => root.querySelector('.placeholder-input'), 'the Variables input to appear');
    // Ran right away with the unfilled variable defaulting to an empty string.
    await waitFor(() => ranWith('"amount":""'), 'the query to run with an empty value');

    const input = root.querySelector<HTMLInputElement>('.placeholder-input')!;
    expect(input, 'Variables input should appear').not.toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no hint is ever shown').toBeNull();
    expect(
      root.querySelector('.pipeline-debug-input-row'),
      'debug shows immediately',
    ).not.toBeNull();

    // fill the value → re-runs with the typed value
    input.value = '5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => ranWith('"amount":5'), 'the filled query to run');

    expect(ranWith('"amount":5'), 'the filled query should have run').toBe(true);
  });

  it('quoted string variable: debug shows, runs with empty, then with the value', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<DataPanel />, root);

    await waitFor(() => mock.text !== '', 'the [collection] effect to seed the default pipeline');

    typeInEditor('[{"$match":{"vendor":"{vendor}"}}]');
    await waitFor(() => root.querySelector('.placeholder-input'), 'the Variables input to appear');
    await waitFor(() => ranWith('"vendor":""'), 'the query to run with an empty value');

    const input = root.querySelector<HTMLInputElement>('.placeholder-input')!;
    expect(input, 'Variables input should appear').not.toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no hint is ever shown').toBeNull();
    expect(
      root.querySelector('.pipeline-debug-input-row'),
      'debug shows immediately',
    ).not.toBeNull();

    input.value = 'ACME';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => ranWith('"vendor":"ACME"'), 'the filled query to run');

    expect(ranWith('"vendor":"ACME"'), 'the filled query should have run').toBe(true);
  });

  it('an embedded {var} inside a larger string shows an input and substitutes into the text', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<DataPanel />, root);

    await waitFor(() => mock.text !== '', 'the [collection] effect to seed the default pipeline');

    // {part_no} is embedded in a larger string — a valid variable, substituted into the text.
    typeInEditor(
      '[{"$match":{"LINE DESC":"BLUE WIDGET {part_no} LARGE"}},{"$sort":{"_id":-1}},{"$skip":0},{"$limit":50}]',
    );
    await waitFor(() => root.querySelector('.placeholder-input'), 'a variable input to appear');
    // Runs immediately with the unfilled var → emptied substitution (two spaces).
    await waitFor(
      () => ranWith('BLUE WIDGET  LARGE'),
      'the query to run with the empty embedded value',
    );

    expect(
      root.querySelector('.placeholder-input'),
      'a variable input should appear',
    ).not.toBeNull();
    expect(root.querySelector('.pipeline-debug-hint'), 'no unresolved hint').toBeNull();
    expect(root.querySelector('.pipeline-debug-input-row'), 'debug should render').not.toBeNull();

    const input = root.querySelector<HTMLInputElement>('.placeholder-input')!;
    input.value = 'XYZ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => ranWith('BLUE WIDGET XYZ LARGE'), 'the filled embedded query to run');

    expect(ranWith('BLUE WIDGET XYZ LARGE'), 'the filled embedded query should have run').toBe(
      true,
    );
  });

  it('split modifier: the variable stays as-is, the input is raw, the query runs with the array', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<DataPanel />, root);

    await waitFor(() => mock.text !== '', 'the [collection] effect to seed the default pipeline');

    typeInEditor('[{"$match":{"tags":"{categories | split(\',\')}"}}]');
    await waitFor(
      () => root.querySelector('.placeholder-input'),
      'a variable input to appear for the split placeholder',
    );

    const input = root.querySelector<HTMLInputElement>('.placeholder-input')!;
    expect(input, 'a variable input should appear for the split placeholder').not.toBeNull();
    expect(root.querySelector('.pipeline-debug-input-row'), 'debug shows').not.toBeNull();

    // The user types the raw, comma-joined value — exactly what the field holds.
    input.value = 'food,drink';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(
      () => ranWith('"tags":["food","drink"]'),
      'the query to run with the split array value',
    );

    expect(
      ranWith('"tags":["food","drink"]'),
      'the query should run with the split array value',
    ).toBe(true);
  });
});
