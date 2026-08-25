// @vitest-environment jsdom
//
// Regression test for: "the Aggregate Pipeline Debug doesn't show by default".
//
// Root cause: the Pipeline Debug reads `editorState.text`, which useEditorSnapshot
// only populates when recompute() runs — and recompute() is driven by a real
// CodeMirror doc-change event. On the default load, syncPipeline() writes text
// byte-identical to the editor's initialValue, so editorDiff.computeMinimalChange
// returns null, no change is dispatched, no onChange fires, recompute() never
// runs, and the debug renders nothing.
//
// This file's editor mock is deliberately FAITHFUL to the real editor (unlike
// mdh-datapanel-variables.test.js, whose mock fires onChange on every setValue and
// therefore hid this bug):
//   • it seeds its text from `initialValue` on mount (no onChange — a doc set at
//     EditorState.create time emits no docChanged), and
//   • setValue is a no-op that fires NO onChange when the new text equals the
//     current text (mirrors computeMinimalChange returning null).
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', seeded: false, onChange: null, onValidChange: null }));

globalThis.chrome = ({
  storage: {
    local: {
      get: (keys: any, cb: any) => { if (cb) { cb({}); return; } return Promise.resolve({}); },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
  runtime: { onMessage: { addListener: () => {} } } as any,
} as any);

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, initialValue, onChange, onValidChange }: any) => {
    mock.onChange = onChange;
    mock.onValidChange = onValidChange;
    if (editorRef) {
      // Seed once from initialValue, like CodeMirror's EditorState.create({ doc }).
      // Seeding must NOT fire onChange (mount produces no docChanged event).
      if (!mock.seeded) { mock.text = initialValue || ''; mock.seeded = true; }
      editorRef.current = {
        getValue: () => mock.text,
        // Faithful to JsonEditor: a write equal to the current text is a no-op,
        // so it fires no onChange (computeMinimalChange returns null → no dispatch
        // → no docChanged). A genuinely different write does fire onChange.
        setValue: (v: any) => { if (v === mock.text) return; mock.text = v; if (onChange) onChange(); },
        isValid: () => { try { JSON5.parse(mock.text); return true; } catch { return false; } },
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

// Poll for the actual condition rather than guessing a fixed delay: the debug
// appears only after the [collection] effect (50ms) and the snapshot debounce
// (250ms) settle and Preact re-renders. A fixed sleep races those timers under
// full-suite CPU contention.
async function waitFor(condition: any, description = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
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
  mock.seeded = false;
});

describe('DataPanel — Aggregate Pipeline Debug visibility', () => {
  it('shows the debug on the default load with no user interaction', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<DataPanel />, root);

    // No typing, sorting, filtering, or variable fill — just the default load.
    await waitFor(
      () => root.querySelector('.pipeline-debug-input-row'),
      'the Aggregate Pipeline Debug to render its input row on the default load',
    );

    expect(root.querySelector('.pipeline-debug-input-row')).not.toBeNull();
    // The default pipeline ($match/$sort/$skip/$limit) should yield per-stage rows too.
    expect(
      root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row)').length,
      'the default pipeline stages should be listed in the debug',
    ).toBeGreaterThan(0);
  });

  it('the editor was seeded with the default pipeline (sanity: mock reflects a real no-op setValue)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<DataPanel />, root);
    await waitFor(() => root.querySelector('.pipeline-debug-input-row'), 'debug to render');

    // The mock editor holds the default pipeline, and DataPanel's syncPipeline wrote
    // the SAME text (a no-op). This is the precondition that made the debug vanish.
    const parsed = JSON5.parse(mock.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((s: any) => s && s.$match), 'default pipeline has a $match stage').toBe(true);
  });
});
