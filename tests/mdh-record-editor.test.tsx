// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import { EditorView } from 'codemirror';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import Modal from '../src/mdh/components/Modal.jsx';
import { modalContent, selectedCollection } from '../src/mdh/store.js';
import { openRecordEditor } from '../src/mdh/components/RecordEditor.jsx';

let mountedRoot: any = null;

function mountModal() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<Modal />, root);
  mountedRoot = root;
  return root;
}
function rerender(root: any) { render(<Modal />, root); }
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
// CodeMirror's mount runs in a useEffect that needs more than two microtasks
// to settle in jsdom — pump for ~50ms across multiple rerenders.
async function flushUntilEditorReady(root: any) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5));
    rerender(root);
    if (root.querySelector('.cm-content')?.textContent) return;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  modalContent.value = null;
  selectedCollection.value = 'vendors';
});

afterEach(() => {
  // Unmount Modal + clear modalContent synchronously so Modal's useEffect
  // cleanup (which touches document.removeEventListener) runs inside the test
  // environment, not after jsdom is torn down. Prevents stray "document is not
  // defined" errors when a test leaves the modal open.
  modalContent.value = null;
  if (mountedRoot) {
    render(null, mountedRoot);
    mountedRoot = null;
  }
});

describe('openRecordEditor — edit mode', () => {
  it('prefills the editor with $set (full record) and an empty $unset block plus hint comment', async () => {
    const record = { _id: 'r1', name: 'Acme', taxId: '123', legacy: true };

    const root = mountModal();
    openRecordEditor('edit', record, () => {}, () => []);
    rerender(root);
    await flushUntilEditorReady(root);

    const editorText = root.querySelector('.cm-content')?.textContent || '';
    expect(editorText).toContain('$set');
    expect(editorText).toContain('"name"');
    expect(editorText).toContain('Acme');
    // $unset block visible alongside $set so field removal is discoverable.
    expect(editorText).toContain('$unset');
    // Parallel hint comments inside each block teach the syntax.
    expect(editorText).toContain('Fields to update');
    expect(editorText).toContain('Fields to remove');
    expect(editorText).toContain('value is ignored');
    // _id is excluded from the prefilled $set body — the filter carries it.
    expect(editorText).not.toContain('"_id"');
  });

  it('submits unmodified default → updateOne sees $set with full record (empty $unset stripped)', async () => {
    const record = { _id: 'r1', name: 'Acme', taxId: '123' };
    vi.mocked(api.updateOne).mockResolvedValueOnce({ result: { matched_count: 1, modified_count: 0 } });
    const onSuccess = vi.fn();

    const root = mountModal();
    openRecordEditor('edit', record, onSuccess, () => []);
    rerender(root);
    await flushUntilEditorReady(root);

    const submitBtn = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Update');
    expect(submitBtn).toBeTruthy();
    submitBtn!.click();
    await flush();

    expect(api.updateOne).toHaveBeenCalledWith(
      'vendors',
      { _id: 'r1' },
      // Empty $unset stripped — the $set with the full record passes through
      // exactly as the user sees it in the editor.
      { $set: { name: 'Acme', taxId: '123' } },
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it('submits with a filled $unset → updateOne sees both $set and $unset', async () => {
    const record = { _id: 'r1', name: 'Acme', legacy: true };
    vi.mocked(api.updateOne).mockResolvedValueOnce({ result: { matched_count: 1, modified_count: 1 } });

    const root = mountModal();
    openRecordEditor('edit', record, () => {}, () => []);
    rerender(root);
    await flushUntilEditorReady(root);

    // Locate CodeMirror's EditorView so we can drive a content change without
    // depending on jsdom's contentEditable shimming.
    const cm = root.querySelector('.cm-editor');
    const view = EditorView.findFromDOM(cm as HTMLElement)!;
    expect(view).toBeTruthy();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '{ "$set": { "name": "Beta" }, "$unset": { "legacy": "" } }' },
    });
    await flush();

    const submitBtn = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Update');
    submitBtn!.click();
    await flush();

    expect(api.updateOne).toHaveBeenCalledWith(
      'vendors',
      { _id: 'r1' },
      { $set: { name: 'Beta' }, $unset: { legacy: '' } },
    );
  });
});
