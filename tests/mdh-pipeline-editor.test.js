// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import JSON5 from 'json5';

globalThis.chrome = {
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() } },
};
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => h('div', { 'data-testid': 'editor' }),
  extractFieldNames: () => [],
}));

import PipelineEditor from '../src/mdh/components/PipelineEditor.jsx';
import { selectedCollection } from '../src/mdh/store.js';

describe('PipelineEditor Beautify', () => {
  it('preserves a disabled stage when beautifying', async () => {
    selectedCollection.value = 'vendors';
    const root = document.createElement('div');
    document.body.appendChild(root);

    const editorRef = { current: {
      _v: '[{"$match":{}},/* @disabled-stage {"$sort":{"a":-1}} */{"$limit":5}]',
      getValue() { return this._v; },
      setValue(v) { this._v = v; },
    } };

    render(h(PipelineEditor, {
      editorRef, initialValue: '', onChange: () => {}, onValidChange: () => {},
      onLoadPipeline: () => {}, onReset: () => {},
    }), root);

    // Open the overflow menu and click Beautify.
    root.querySelector('.pipeline-overflow-btn').click();
    await vi.waitFor(() => expect([...root.querySelectorAll('.toolbar-menu-item')].some((b) => b.textContent === 'Beautify')).toBe(true));
    [...root.querySelectorAll('.toolbar-menu-item')].find((b) => b.textContent === 'Beautify').click();

    const out = editorRef.current.getValue();
    expect(JSON5.parse(out)).toEqual([{ $match: {} }, { $limit: 5 }]);
    expect(out).toContain('/* @disabled-stage');
  });
});

