// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

// Stub the heavy children so the editor mounts cheaply in jsdom.
vi.mock('../src/mdh/components/JsonEditor.jsx', () => ({
  default: () => h('div', { class: 'json-editor-stub' }),
  extractFieldNames: () => [],
}));
vi.mock('../src/mdh/components/QueryHistory.jsx', () => ({
  LibraryPanel: () => null, saveQuery: () => {}, unsaveQuery: () => {}, isSaved: async () => false,
}));
vi.mock('../src/mdh/pipelineComments.js', () => ({ beautifyText: (t) => t }));

import PipelineEditor from '../src/mdh/components/PipelineEditor.jsx';
import { aiAvailable } from '../src/mdh/store.js';

const root = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
const props = {
  editorRef: { current: { getValue: () => '[]', setValue: vi.fn() } },
  initialValue: '[]', onChange() {}, onValidChange() {}, onLoadPipeline() {}, onReset() {}, onToggleStage() {},
};

beforeEach(() => { document.body.innerHTML = ''; aiAvailable.value = false; });

describe('PipelineEditor AI input', () => {
  it('hides the NL input when aiAvailable is false', () => {
    const r = root();
    render(h(PipelineEditor, props), r);
    expect(r.querySelector('.nl-search-input')).toBeNull();
  });
  it('shows the NL input when aiAvailable is true', () => {
    aiAvailable.value = true;
    const r = root();
    render(h(PipelineEditor, props), r);
    expect(r.querySelector('.nl-search-input')).not.toBeNull();
  });
});
