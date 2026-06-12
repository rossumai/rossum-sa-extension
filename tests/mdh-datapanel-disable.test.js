// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

const mock = vi.hoisted(() => ({ text: '', onChange: null, onValidChange: null, onToggleStage: null }));

globalThis.chrome = {
  storage: { local: { get: (k, cb) => { if (cb) { cb({}); return; } return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  runtime: { onMessage: { addListener: () => {} } },
};

vi.mock('../src/mdh/api.js');

vi.mock('../src/mdh/components/PipelineEditor.jsx', () => ({
  default: ({ editorRef, onChange, onValidChange, onToggleStage }) => {
    mock.onChange = onChange; mock.onValidChange = onValidChange; mock.onToggleStage = onToggleStage;
    if (editorRef) {
      editorRef.current = {
        getValue: () => mock.text,
        setValue: (v) => { mock.text = v; },
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
import DataPanel from '../src/mdh/components/DataPanel.jsx';
import { selectedCollection, records } from '../src/mdh/store.js';

async function tick() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

beforeEach(() => {
  vi.clearAllMocks();
  api.aggregate.mockResolvedValue({ result: [{ n: 0 }] });
  if (api.listCollections) api.listCollections.mockResolvedValue({ result: [] });
  selectedCollection.value = 'vendors';
  records.value = [];
  mock.text = '';
});

describe('DataPanel — disable-stage wiring', () => {
  it('toggling a stage from the gutter callback comments it out in the editor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();

    mock.text = '[\n  { "$match": {} },\n  { "$sort": { "a": -1 } },\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // disable the $sort
    await tick();

    expect(mock.text).toContain('/* @disabled-stage');
    expect(JSON5.parse(mock.text)).toEqual([{ $match: {} }, { $limit: 50 }]);
  });

  it('toggling an already-disabled stage re-enables it (uncomments)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();

    // entry 1 is the disabled $sort block.
    mock.text = '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // enable it
    await tick();

    expect(mock.text).not.toContain('@disabled-stage');
    expect(JSON5.parse(mock.text)).toEqual([{ $match: {} }, { $sort: { a: -1 } }, { $limit: 50 }]);
  });

  it('runs [{ $match: {} }] when every stage is disabled', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();
    api.aggregate.mockClear();

    mock.text = '[ /* @disabled-stage\n{ "$match": { "x": 1 } } */ ]';
    mock.onValidChange(); // simulate a valid edit -> runQuery
    await tick();

    // The query aggregation (the call whose pipeline is NOT a $count/$collStats probe)
    // must be [{ $match: {} }], never [].
    const queryCalls = api.aggregate.mock.calls.filter(([, pl]) =>
      Array.isArray(pl) && !pl.some((s) => s.$count) && !pl.some((s) => s.$collStats));
    expect(queryCalls.length).toBeGreaterThan(0);
    for (const [, pl] of queryCalls) {
      expect(pl).toEqual([{ $match: {} }]);
    }
  });

  it('preserves a freehand comment through a stage toggle (minimal-edit wiring)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h(DataPanel, null), root);
    await tick();

    mock.text = '[\n  // only active vendors\n  { "$match": { "active": true } },\n  { "$skip": 0 },\n  { "$limit": 50 }\n]';
    mock.onToggleStage(1); // disable $skip via the same minimal-edit core that sort/filter use
    await tick();

    expect(mock.text).toContain('// only active vendors'); // freehand comment survives the rewrite
  });
});
