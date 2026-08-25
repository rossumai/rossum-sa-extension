// @vitest-environment jsdom
//
// Regression test: a pipeline ending in $out or $merge must NOT auto-run when
// the editor changes. The query UI auto-runs on every edit; write stages must
// execute only via the explicit "Run write pipeline" button.
//
// What we test:
//   1. After the default load, replacing the pipeline with a $out pipeline and
//      triggering onValidChange does NOT call api.aggregate.
//   2. The .pipeline-write-banner element renders while the $out pipeline is active.
//   3. Restoring a read-only pipeline DOES run a query (sanity / regression guard).
//
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null, onValidChange: null as any, onToggleStage: null }));

globalThis.chrome = ({
  storage: { local: { get: (k: any, cb: any) => { if (cb) { cb({}); return; } return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } } as any,
} as any);

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onChange, onValidChange, onToggleStage }: any) => {
    mock.onChange = onChange; mock.onValidChange = onValidChange; mock.onToggleStage = onToggleStage;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v: any) => { mock.text = v; },
        isValid: () => { try { JSON5.parse(mock.text); return true; } catch { return false; } },
        getParsed: () => JSON5.parse(mock.text),
        focus: () => {}, refresh: () => {},
      };
    }
    return h('div', { 'data-testid': 'editor' });
  },
}));
vi.mock('../src/mdh/components/RecordList.jsx', () => ({ default: () => h('div', { 'data-testid': 'recordlist' }) }));
vi.mock('../src/mdh/components/PipelineDebug.jsx', () => ({ default: () => h('div', { 'data-testid': 'debug' }) }));

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records } from '../src/mdh/store.js';

async function waitFor(condition: any, description = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = condition(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function mountDataPanel() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(DataPanel, null), root);
  await waitFor(() => mock.text !== '', 'the default pipeline to load into the editor');
  return root;
}

// Real query aggregations only (exclude the $count / $collStats probes).
function queryAggregations() {
  return vi.mocked(api.aggregate).mock.calls
    .filter(([, pl]) => Array.isArray(pl) && !pl.some((s) => s && s.$count) && !pl.some((s) => s && s.$collStats))
    .map(([, pl]) => pl);
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidateAll();
  vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 0 }] });
  if (api.listCollections) vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  mock.text = '';
});

describe('DataPanel — write-stage suppression', () => {
  it('does NOT call api.aggregate when the pipeline ends in $out', async () => {
    const root = await mountDataPanel();
    // Let the default-load query finish before clearing the call log.
    await waitFor(() => queryAggregations().length > 0, 'default-load query to complete');
    vi.mocked(api.aggregate).mockClear();

    // Switch to a $out pipeline and simulate the editor firing onValidChange.
    mock.text = '[{ "$match": {} }, { "$out": "archive" }]';
    mock.onValidChange();

    // Give any async work a chance to settle; aggregate must stay silent.
    await new Promise((r) => setTimeout(r, 200));
    expect(queryAggregations().length, 'api.aggregate must not be called for a $out pipeline').toBe(0);

    document.body.removeChild(root);
  });

  it('renders .pipeline-write-banner while a $out pipeline is active', async () => {
    const root = await mountDataPanel();
    await waitFor(() => queryAggregations().length > 0, 'default-load query to complete');

    // Switch to a $out pipeline and trigger a re-render via onValidChange.
    mock.text = '[{ "$match": {} }, { "$out": "archive" }]';
    mock.onValidChange();

    await waitFor(
      () => root.querySelector('.pipeline-write-banner') !== null,
      '.pipeline-write-banner to appear',
    );
    expect(root.querySelector('.pipeline-write-banner')).not.toBeNull();

    document.body.removeChild(root);
  });

  it('resumes running queries after switching back to a read-only pipeline', async () => {
    const root = await mountDataPanel();
    await waitFor(() => queryAggregations().length > 0, 'default-load query to complete');
    vi.mocked(api.aggregate).mockClear();

    // First set a write pipeline (no query runs).
    mock.text = '[{ "$match": {} }, { "$out": "archive" }]';
    mock.onValidChange();
    await new Promise((r) => setTimeout(r, 100));
    expect(queryAggregations().length).toBe(0);

    // Then restore a read-only pipeline — should auto-run.
    mock.text = '[{ "$match": { "active": true } }, { "$limit": 50 }]';
    await waitFor(() => {
      mock.onValidChange();
      return queryAggregations().length > 0;
    }, 'the read-only pipeline to trigger a query');

    expect(queryAggregations().length).toBeGreaterThan(0);

    document.body.removeChild(root);
  });
});
