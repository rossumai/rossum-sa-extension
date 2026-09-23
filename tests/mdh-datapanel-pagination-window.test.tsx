// @vitest-environment jsdom
//
// Pagination owns the pipeline's TRAILING $skip/$limit run and nothing else.
// Three behaviours, all wrong before 2026-09-23 and all only visible end to end:
//   • a hand-typed trailing $skip reaches skip.value (it used to stay 0, so the
//     footer said "Showing 1–N", Prev stayed dead, and Next paged BACKWARDS);
//   • a $skip that is part of the query is never rewritten as a page offset;
//   • the step is the pipeline's own $limit, not the store's fixed 50.
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({
  text: '',
  seeded: false,
  onChange: null as any,
  onValidChange: null as any,
  listProps: null as any,
}));

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
  default: ({ editorRef, initialValue, onChange, onValidChange }: any) => {
    mock.onChange = onChange;
    mock.onValidChange = onValidChange;
    if (editorRef) {
      if (!mock.seeded) {
        mock.text = initialValue || '';
        mock.seeded = true;
      }
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v: any) => {
          if (v === mock.text) return;
          mock.text = v;
          if (onChange) onChange();
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
  default: (props: any) => {
    mock.listProps = props;
    return <div data-testid="recordlist" />;
  },
}));

import * as api from '../src/mdh/api.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records, skip, limit, loading, error } from '../src/mdh/store.js';

async function waitFor(condition: any, description: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = condition();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

// Type a pipeline into the editor. `onChange` fires ONCE, like a real edit —
// DataPanel's editor snapshot is debounced, so re-firing it every few ms would
// re-arm that timer forever and the snapshot would never land. `onValidChange`
// is not debounced and is ignored while a programmatic write is being suppressed
// (600ms after mount's syncPipeline), so that one repeats until the panel takes
// the text.
async function typePipeline(text: string, settled: () => boolean) {
  mock.text = text;
  mock.onChange?.();
  await waitFor(() => {
    mock.onValidChange?.();
    return settled();
  }, `DataPanel to adopt ${text}`);
}

// Mount and wait for the DEFAULT load to finish. Gating on "the record list
// rendered" is not enough: that happens on the first render, before the
// [collection] effect has run pipeline.reset() and written the default pipeline
// — which would then land on top of whatever the test typed.
async function mountSettled() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<DataPanel />, root);
  await waitFor(
    () => mock.listProps?.pageWindow?.limit === 50 && JSON5.parse(mock.text).length === 4,
    'the default pipeline to load and report its own pagination window',
  );
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.aggregate).mockResolvedValue({ result: [] });
  if (api.listCollections) vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  skip.value = 0;
  limit.value = 50;
  loading.value = false;
  error.value = null;
  mock.text = '';
  mock.seeded = false;
  mock.listProps = null;
});

describe('DataPanel — the pagination window is the trailing $skip/$limit run', () => {
  it('adopts a hand-typed trailing $skip and its page size', async () => {
    await mountSettled();

    await typePipeline(
      '[{ "$match": {} }, { "$skip": 120 }, { "$limit": 10 }]',
      () => mock.listProps.pageWindow?.skip === 120 && skip.value === 120,
    );

    expect(skip.value).toBe(120);
    expect(mock.listProps.pageWindow).toEqual({
      skipIndex: 1,
      limitIndex: 2,
      skip: 120,
      limit: 10,
    });
  });

  it('pages by the pipeline page size and leaves a load-bearing $skip alone', async () => {
    await mountSettled();

    const written =
      '[{ "$match": {} }, { "$skip": 3 }, { "$group": { "_id": "$k" } }, { "$skip": 120 }, { "$limit": 10 }]';
    await typePipeline(
      written,
      () => mock.listProps.pageWindow?.skip === 120 && skip.value === 120,
    );

    await act(async () => {
      mock.listProps.onPageChange('next');
    });

    expect(skip.value).toBe(130); // stepped by the pipeline's $limit, not by 50
    const parsed = JSON5.parse(mock.text);
    expect(parsed[1]).toEqual({ $skip: 3 }); // the user's offset, untouched
    expect(parsed[3]).toEqual({ $skip: 130 });
    expect(parsed[4]).toEqual({ $limit: 10 });
  });

  it('reports no window — so Prev/Next disable — when the pipeline has no trailing run', async () => {
    await mountSettled();

    await typePipeline(
      '[{ "$match": {} }, { "$skip": 3 }, { "$group": { "_id": "$k" } }]',
      () => mock.listProps.pageWindow === null,
    );

    expect(mock.listProps.pageWindow).toBeNull();
    expect(skip.value).toBe(0);
  });
});
