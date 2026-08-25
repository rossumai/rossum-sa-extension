// @vitest-environment jsdom
//
// JsonEditor value-prop syncing. A read-only editor is a pure projection of its
// `value` prop — index / search-index card bodies are rendered read-only and the
// SAME JsonEditor instance is reused (no key) when the value changes on a
// collection switch or a Refresh click, so a mount-only seed leaves the body
// stale. Editable editors deliberately treat `value` as a seed only: edits live
// in the view and are read back via editorRef, so a parent re-render must never
// clobber them.
import { describe, it, expect, vi } from 'vitest';
import { h, render, Fragment } from 'preact';
import JsonEditor from '../src/mdh/components/JsonEditor.jsx';
import type { JsonEditorHandle } from '../src/mdh/components/JsonEditor.jsx';

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

describe('JsonEditor — value prop syncing', () => {
  it('read-only editor updates its document when the value prop changes (collection switch / refresh)', async () => {
    const root = mount();
    const ref: { current: JsonEditorHandle | null } = { current: null };

    render(<JsonEditor readOnly value={'{"a":1}'} editorRef={ref} />, root);
    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getValue()).toBe('{"a":1}');

    // Same instance reused with a new value — exactly what IndexCard / the index
    // panels do when the selected collection changes or Refresh is clicked.
    render(<JsonEditor readOnly value={'{"b":2}'} editorRef={ref} />, root);
    await vi.waitFor(() => expect(ref.current!.getValue()).toBe('{"b":2}'));
  });

  it('editable editor treats value as a seed only — a parent re-render does not clobber edits', async () => {
    const root = mount();
    const roRef: { current: JsonEditorHandle | null } = { current: null }; // read-only sibling: deterministic "effects flushed" signal
    const edRef: { current: JsonEditorHandle | null } = { current: null }; // editable editor under test

    render(
      <>
        <JsonEditor readOnly value={'{"seed":1}'} editorRef={roRef} />
        <JsonEditor value={'{"seed":1}'} editorRef={edRef} />
      </>,
      root,
    );
    await vi.waitFor(() => expect(edRef.current).not.toBeNull());

    // Simulate a user edit living inside the editable view.
    edRef.current!.setValue('{"edited":true}');
    expect(edRef.current!.getValue()).toBe('{"edited":true}');

    // Re-render both with a new value prop. The read-only one syncs (positive,
    // deterministic signal that the effect cycle ran); the editable one must not.
    render(
      <>
        <JsonEditor readOnly value={'{"next":2}'} editorRef={roRef} />
        <JsonEditor value={'{"next":2}'} editorRef={edRef} />
      </>,
      root,
    );
    await vi.waitFor(() => expect(roRef.current!.getValue()).toBe('{"next":2}'));
    expect(edRef.current!.getValue()).toBe('{"edited":true}');
  });
});
