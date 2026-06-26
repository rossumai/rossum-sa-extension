// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';

// Mock the heavy editor + the AI loop/context so we test only the wiring.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => null,
  extractFieldNames: () => ['a', 'b'],
}));
vi.mock('../src/mdh/aiContext.js', () => ({
  getSchemaHints: vi.fn(async () => ({ knownValues: {}, topValues: {}, ranges: {}, numericStringFields: [], searchIndexes: [], fieldTypes: {}, arrayPaths: [] })),
}));
// QueryHistory.isSaved hits chrome.storage on mount (updateSaveBtn) — stub it
// out (tests/setup.js does not provide a `chrome` global).
vi.mock('../src/mdh/components/QueryHistory.jsx', () => ({
  LibraryPanel: () => null,
  saveQuery: vi.fn(async () => {}),
  unsaveQuery: vi.fn(async () => {}),
  isSaved: vi.fn(async () => false),
}));
const runAiPipeline = vi.fn(async () => ({ pipelineText: '[{"$limit":5}]', trace: { status: 'ok', summary: 'AI-checked · 3 rows', corrected: false, rounds: [], hints: {}, calls: [] } }));
vi.mock('../src/mdh/aiPipelineLoop.js', () => ({ runAiPipeline: (...a) => runAiPipeline(...a) }));

import PipelineEditor from '../src/mdh/components/PipelineEditor.jsx';
import { selectedCollection, records, aiAvailable } from '../src/mdh/store.js';

function flush() { return new Promise((r) => setTimeout(r, 0)); }

describe('PipelineEditor AI wiring', () => {
  beforeEach(() => {
    runAiPipeline.mockClear();
    aiAvailable.value = true;
    selectedCollection.value = 'vendors';
    records.value = [{ a: 1 }];
  });

  it('renders the AI input when available and shows the trace after a run', async () => {
    const editorRef = { current: { getValue: () => '[]', setValue: vi.fn() } };
    const root = document.createElement('div');
    render(h(PipelineEditor, {
      editorRef, initialValue: '[]', onChange: () => {}, onValidChange: () => {},
      onLoadPipeline: () => {}, onReset: () => {}, onToggleStage: () => {}, onCursorStage: () => {},
    }), root);

    const input = root.querySelector('.nl-search-input');
    expect(input).toBeTruthy();
    input.value = 'top vendors';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush(); await flush();

    expect(runAiPipeline).toHaveBeenCalledTimes(1);
    expect(editorRef.current.setValue).toHaveBeenCalled();
    expect(root.querySelector('.ai-trace')).toBeTruthy();
    expect(root.textContent).toContain('AI-checked · 3 rows');
  });

  it('passes the richer hints through to runAiPipeline', async () => {
    const editorRef = { current: { getValue: () => '[]', setValue: vi.fn() } };
    const root = document.createElement('div');
    render(h(PipelineEditor, {
      editorRef, initialValue: '[]', onChange: () => {}, onValidChange: () => {},
      onLoadPipeline: () => {}, onReset: () => {}, onToggleStage: () => {}, onCursorStage: () => {},
    }), root);
    const input = root.querySelector('.nl-search-input');
    input.value = 'q';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush(); await flush();
    const arg = runAiPipeline.mock.calls[0][0];
    expect(arg).toHaveProperty('fieldTypes');
    expect(arg).toHaveProperty('arrayPaths');
    expect(arg).toHaveProperty('topValues');
    expect(arg).toHaveProperty('onPhase');
  });
});
