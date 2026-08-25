// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null, onValidChange: null as any, onToggleStage: null as any }));

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

async function tick() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

// Poll for a condition rather than sleeping a fixed span. DataPanel loads its
// default pipeline from a setTimeout(50ms); under full-suite CPU load a fixed
// near-zero wait lets that late write land *after* the test edits the editor,
// clobbering the test's pipeline — the source of this file's intermittent
// failures. Condition-based waits remove the race.
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

// Mount DataPanel and wait until its default-pipeline load has written the editor,
// so subsequent edits aren't clobbered by that late write.
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
  // Clean cache so every test takes the same default-load path deterministically
  // (no cross-test cache state deciding whether the load runs a query).
  cache.invalidateAll();
  vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 0 }] });
  if (api.listCollections) vi.mocked(api.listCollections).mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  mock.text = '';
});

describe('DataPanel — disable-stage wiring', () => {
  it('toggling a stage from the gutter callback comments it out in the editor', async () => {
    await mountDataPanel();

    mock.text = '[\n  { "$match": {} },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // disable the $sort
    await tick();

    expect(mock.text).toContain('/* @disabled-stage');
    expect(JSON5.parse(mock.text)).toEqual([{ $match: {} }, { $limit: 50 }]);
  });

  it('toggling an already-disabled stage re-enables it (uncomments)', async () => {
    await mountDataPanel();

    // entry 1 is the disabled $sort block.
    mock.text = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // enable it
    await tick();

    expect(mock.text).not.toContain('@disabled-stage');
    expect(JSON5.parse(mock.text)).toEqual([{ $match: {} }, { $sort: { a: -1 } }, { $limit: 50 }]);
  });

  it('runs [{ $match: {} }] when every stage is disabled', async () => {
    await mountDataPanel();
    await tick();              // let the default-load query finish before clearing
    vi.mocked(api.aggregate).mockClear(); // drop the default-load aggregations

    mock.text = '[ /* @disabled-stage\n{ "$match": { "x": 1 } } */ ]';
    // onValidChange runs a query only once the default load's suppressSync window
    // has elapsed; poll until the query lands so we never race that reset.
    await waitFor(() => {
      mock.onValidChange();
      return queryAggregations().length > 0;
    }, 'the all-disabled edit to run a query');

    // The query aggregation must be [{ $match: {} }], never [].
    const calls = queryAggregations();
    expect(calls.length).toBeGreaterThan(0);
    for (const pl of calls) {
      expect(pl).toEqual([{ $match: {} }]);
    }
  });

  it('preserves a freehand comment through a stage toggle (minimal-edit wiring)', async () => {
    await mountDataPanel();

    mock.text = '[\n  // only active vendors\n  { "$match": { "active": true } },\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // disable $skip via the same minimal-edit core that sort/filter use
    await tick();

    expect(mock.text).toContain('// only active vendors'); // freehand comment survives the rewrite
  });
});
