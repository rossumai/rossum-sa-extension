// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import MarkdownEditor from '../src/fabry/architect/components/MarkdownEditor.jsx';

function mount(props) { const root = document.createElement('div'); document.body.appendChild(root); render(h(MarkdownEditor, props), root); return root; }

describe('MarkdownEditor', () => {
  it('mounts CodeMirror seeded with value and exposes getValue via ref', async () => {
    const ref = { current: null };
    mount({ value: '# Hello', editorRef: ref });
    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current.getValue()).toBe('# Hello');
    expect(document.querySelector('.cm-editor')).toBeTruthy();
  });
  it('emits onChange when the document changes', async () => {
    const ref = { current: null };
    const onChange = vi.fn();
    mount({ value: 'a', onChange, editorRef: ref });
    await vi.waitFor(() => expect(ref.current).not.toBeNull());
    ref.current.setValue('a b'); // test helper on the ref
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('a b'));
  });
});
