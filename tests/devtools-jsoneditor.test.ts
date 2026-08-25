// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { EditorView } from 'codemirror';
import JsonCodeEditor from '../src/devtools/JsonCodeEditor.jsx';
import * as store from '../src/devtools/store.js';
import * as cache from '../src/devtools/resourceCache.js';

const RES = { type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' };

function mount(tabId: any) { const root = document.createElement('div'); render(h(JsonCodeEditor, { tabId }), root); return root; }
async function waitFor(fn: any, tries = 100) {
  for (let i = 0; i < tries; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 0)); }
  throw new Error('waitFor timed out');
}

let tab: any;
beforeEach(() => {
  store.tabs.value = [];
  store.activeId.value = null;
  tab = store.openTab(RES);
  store.patchTab(tab.id, { buffer: '{"a":1}' });
});

describe('JsonCodeEditor', () => {
  it('mounts a CodeMirror editor for the given tab', async () => {
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    expect(root.querySelector('.rawjson-cm .cm-editor')).not.toBeNull();
  });
  it('shows a parse error derived from the tab buffer', async () => {
    store.patchTab(tab.id, { buffer: '{ broken' });
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-parse-error'));
    expect(root.querySelector('.rawjson-parse-error')).not.toBeNull();
  });
  it('a real doc-changed transaction patches the tab buffer and marks it dirty', async () => {
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    expect(store.activeTab()!.dirty).toBe(false);
    const cm = root.querySelector('.cm-editor');
    const view = EditorView.findFromDOM(cm)!;
    expect(view).toBeTruthy();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"a":2}' } });
    await waitFor(() => store.activeTab()!.dirty === true);
    expect(store.activeTab()!.dirty).toBe(true);
    expect(store.activeTab()!.buffer).toBe('{"a":2}');
  });
  it('clears dirty when the edit is reverted back to the original', async () => {
    store.patchTab(tab.id, { original: { a: 1 }, buffer: '{"a":1}' });
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    const view = EditorView.findFromDOM(root.querySelector('.cm-editor'))!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"a":2}' } });
    await waitFor(() => store.activeTab()!.dirty === true);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"a":1}' } });
    await waitFor(() => store.activeTab()!.dirty === false);
    expect(store.activeTab()!.dirty).toBe(false);
  });
  it('does not re-mark the tab dirty when the buffer is synced externally (post-save)', async () => {
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    store.patchTab(tab.id, { dirty: false });
    // Simulate actions.saveResource writing the re-fetched JSON into the buffer:
    store.patchTab(tab.id, { buffer: '{"a":2,"modified_at":"t"}' });
    // Let preact re-render + the external-sync effect run.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(store.activeTab()!.dirty).toBe(false);
    expect(root.querySelector('.cm-content').textContent).toContain('modified_at');
  });
  it('renders blank when the tab does not exist (defensive)', async () => {
    const root = mount('missing');
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    expect(root.querySelector('.rawjson-cm .cm-editor')).not.toBeNull();
  });
  it('shows an inline dimmed name for a resolved reference in the buffer', async () => {
    cache.clear();
    cache.put('/api/v1/schemas/9', { name: 'Sales schema' }); // pre-warm: nameFor is a cache read, no fetch
    store.patchTab(tab.id, { buffer: '{\n  "schema": "https://acme.rossum.app/api/v1/schemas/9"\n}' });
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-name'));
    expect(root.querySelector('.rawjson-name').textContent).toBe('Sales schema');
    render(null, root);
    cache.clear();
  });
  it('registers its EditorView as store.views.active on mount and clears it on unmount', async () => {
    const root: any = mount(tab.id);
    await waitFor(() => root.querySelector('.rawjson-cm .cm-editor'));
    expect(store.views.active).toBeTruthy();
    render(null, root); // unmount
    await waitFor(() => store.views.active === null);
    expect(store.views.active).toBeNull();
  });
});
